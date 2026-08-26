---
title: "データを「コピーする対象」ではなく「どこに何があるかの記述子」として持ち回る"
description: "ngx_buf_t はバッファではなく、メモリの範囲かファイルの範囲かを表す記述子。だから静的ファイルの配信は 1 バイトも読まずに応答を組み立てられる。データを持たない「終端だけの buf」でストリームの終わりを表し、chain のリンクだけを複製することで実体をコピーせずに枝分かれさせ、隣り合う buf は writev の 1 要素にまとめる。"
sidebar:
  order: 10
---

## 何を学んだか

### どんな状況の話か

リバースプロキシは、上流から来たバイト列を下流に流す。途中で gzip したり、SSI を展開したり、chunked にしたり、範囲を切り出したりする。素朴に書くと、モジュールを通るたびにバッファをコピーすることになる。

静的ファイルの配信はもっと極端で、**理想的にはユーザー空間にデータを持ってきたくない**。`sendfile()` を使えばカーネル内でファイルからソケットへ流せる。ということは、応答を表現するデータ構造が「メモリ上のバイト列」に固定されていると、その最適化ができない。

さらに、`write()` は部分書き込みをする。10MB を渡して 2MB しか書けなかったら、残り 8MB の位置を覚えておいて、次に書けるようになったら続きから送る。[ステートマシン](../state-machine/) なので、この「途中まで送った」という状態も構造体に持たなければならない。

### Nginx の答え

1. **`ngx_buf_t` は「バッファ」ではなく「記述子」。** メモリ上の範囲 (`pos`〜`last`) か、ファイル上の範囲 (`file_pos`〜`file_last`) か、あるいは両方を指す。データを持っているとは限らない。
2. **確保した領域と、有効なデータの範囲を分ける。** `start`〜`end` が確保した領域、`pos`〜`last` が今有効なデータ。送信が進むと `pos` だけが動く。
3. **データを 1 バイトも持たない buf がある。** `last_buf` / `flush` / `sync` だけが立った buf は、「ここでストリームが終わる」「ここまでを吐き出せ」という制御を運ぶ。
4. **`ngx_chain_t` は `{ buf へのポインタ, next }` だけ。** buf の実体は共有できる。リンクだけを作り直せば、実体をコピーせずに別のリストを作れる。
5. **リンクは使い回す。** プールは個別解放できないのに、chain link だけはプールにフリーリストが用意されている。
6. **buf に「誰が作ったか」のタグを付ける。** ポインタ 1 個をタグとして使い、「この buf は自分のものだから再利用してよい」を判定する。
7. **書き出す直前に、隣り合う buf を `iovec` の 1 要素にまとめる。** 別々の buf でも、アドレスが連続していれば 1 つにできる。
8. **「そのまま流せるか」を毎回判定する。** ファイルの buf を `sendfile()` で流せるか、それともメモリに読んでこないといけないかを、その場の条件で決める。

## ソースコードのどこか

### 記述子としての buf

[`src/core/ngx_buf.h#L20-L56`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_buf.h#L20-L56)。

```c title="src/core/ngx_buf.h"
struct ngx_buf_s {
    u_char          *pos;
    u_char          *last;
    off_t            file_pos;
    off_t            file_last;

    u_char          *start;         /* start of buffer */
    u_char          *end;           /* end of buffer */
    ngx_buf_tag_t    tag;
    ngx_file_t      *file;
    ngx_buf_t       *shadow;


    /* the buf's content could be changed */
    unsigned         temporary:1;

    /*
     * the buf's content is in a memory cache or in a read only memory
     * and must not be changed
     */
    unsigned         memory:1;

    /* the buf's content is mmap()ed and must not be changed */
    unsigned         mmap:1;

    unsigned         recycled:1;
    unsigned         in_file:1;
    unsigned         flush:1;
    unsigned         sync:1;
    unsigned         last_buf:1;
    unsigned         last_in_chain:1;

    unsigned         last_shadow:1;
    unsigned         temp_file:1;

    /* STUB */ int   num;
};
```

ポインタが 2 対ある。`pos`/`last` が **今有効なデータの範囲**、`start`/`end` が **確保した領域の範囲**。読むときは `last` を進め、送るときは `pos` を進める。`end - last` が「あと何バイト書き込めるか」、`last - pos` が「あと何バイト送るべきか」になる。

`file_pos`/`file_last` はファイル上のオフセットで、`in_file` が立っていればそちらが有効。**同じ buf がメモリとファイルの両方を指すこともある** (`ngx_buf_in_memory(b) && b->in_file`)。ファイルにも書いたし、メモリにもまだ残っている、という状態を表す。

フラグ 3 つの区別が細かい。

- `temporary`: 自分で確保して自分で書き込んだメモリ。**書き換えてよい**。
- `memory`: 読み取り専用のメモリ (設定から来た文字列、静的なリテラル)。**書き換えてはいけない**。
- `mmap`: `mmap()` した領域。やはり書き換えてはいけないし、解放の仕方も違う。

3 つとも「メモリ上にある」という点では同じなので、判定はマクロにまとまっている ([`#L125-L138`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_buf.h#L125-L138))。

```c title="src/core/ngx_buf.h"
#define ngx_buf_in_memory(b)       ((b)->temporary || (b)->memory || (b)->mmap)
#define ngx_buf_in_memory_only(b)  (ngx_buf_in_memory(b) && !(b)->in_file)

#define ngx_buf_special(b)                                                   \
    (((b)->flush || (b)->last_buf || (b)->sync)                              \
     && !ngx_buf_in_memory(b) && !(b)->in_file)

#define ngx_buf_sync_only(b)                                                 \
    ((b)->sync && !ngx_buf_in_memory(b)                                      \
     && !(b)->in_file && !(b)->flush && !(b)->last_buf)

#define ngx_buf_size(b)                                                      \
    (ngx_buf_in_memory(b) ? (off_t) ((b)->last - (b)->pos):                  \
                            ((b)->file_last - (b)->file_pos))
```

`ngx_buf_size(b)` が象徴的で、**サイズの求め方がメモリかファイルかで変わる**。呼び出し側はどちらかを気にせず「この buf のサイズ」を得られる。

`ngx_buf_special(b)` は「データを持たず、制御だけを運ぶ buf」の判定。これがあるおかげで、`last_buf` を運ぶために 1 バイトのダミーデータを用意する必要がない。

### ファイルを読まずに応答を作る

`ngx_http_static_module` が、記述子としての buf の使い方をそのまま見せてくれる ([`src/http/modules/ngx_http_static_module.c#L243-L277`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/modules/ngx_http_static_module.c#L243-L277))。

```c title="src/http/modules/ngx_http_static_module.c"
    /* we need to allocate all before the header would be sent */

    b = ngx_calloc_buf(r->pool);
    if (b == NULL) {
        return NGX_HTTP_INTERNAL_SERVER_ERROR;
    }

    b->file = ngx_pcalloc(r->pool, sizeof(ngx_file_t));
    if (b->file == NULL) {
        return NGX_HTTP_INTERNAL_SERVER_ERROR;
    }

    rc = ngx_http_send_header(r);

    if (rc == NGX_ERROR || rc > NGX_OK || r->header_only) {
        return rc;
    }

    b->file_pos = 0;
    b->file_last = of.size;

    b->in_file = b->file_last ? 1 : 0;
    b->last_buf = (r == r->main) ? 1 : 0;
    b->last_in_chain = 1;
    b->sync = (b->last_buf || b->in_file) ? 0 : 1;

    b->file->fd = of.fd;
    b->file->name = path;
    b->file->log = log;
    b->file->directio = of.is_directio;

    out.buf = b;
    out.next = NULL;

    return ngx_http_output_filter(r, &out);
```

**ファイルの中身を 1 バイトも読んでいない。** `open()` して `stat()` した結果 (`of`) から fd とサイズだけを取り、「このファイルの 0 バイト目から size バイト目まで」という記述子を作って流す。実際に読むかどうかは、下流の [出力フィルタチェーン](../output-filter-chain/) と最終的な書き出し関数が決める。`sendfile on` なら読まずにカーネルで転送される。

コメントの「we need to allocate all before the header would be sent」も実務的で、**ヘッダを送った後に確保に失敗すると、もう 500 を返せない**。確保を先に済ませてから送る。

`b->sync` の設定も面白い。ファイルが空 (`of.size == 0`) で、かつサブリクエストなら `last_buf` も `in_file` も立たないので、この buf は完全に空になる。空の buf をチェーンから消してしまうと「サブリクエストがここまで出力した」という位置情報が失われるので、`sync` を立てて **「意味は無いが場所を取る buf」** として残している。

### チェーンはリンクだけを複製する

[`src/core/ngx_buf.h#L59-L62`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_buf.h#L59-L62)。

```c title="src/core/ngx_buf.h"
struct ngx_chain_s {
    ngx_buf_t    *buf;
    ngx_chain_t  *next;
};
```

2 ワード。buf を値で持たずポインタで持っているのが効いていて、`ngx_chain_add_copy()` は **リンクだけを新しく作って、buf は共有する** ([`src/core/ngx_buf.c#L126-L153`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_buf.c#L126-L153))。

```c title="src/core/ngx_buf.c"
ngx_int_t
ngx_chain_add_copy(ngx_pool_t *pool, ngx_chain_t **chain, ngx_chain_t *in)
{
    ngx_chain_t  *cl, **ll;

    ll = chain;

    for (cl = *chain; cl; cl = cl->next) {
        ll = &cl->next;
    }

    while (in) {
        cl = ngx_alloc_chain_link(pool);
        if (cl == NULL) {
            *ll = NULL;
            return NGX_ERROR;
        }

        cl->buf = in->buf;
        *ll = cl;
        ll = &cl->next;
        in = in->next;
    }

    *ll = NULL;

    return NGX_OK;
}
```

`cl->buf = in->buf` — **ポインタの代入だけ**。関数名が "add copy" なのに、コピーされるのはリンクであって中身ではない。

`ll` の使い方も定石で、`ngx_chain_t **` を「末尾の next へのポインタ」として持ち回る。これで末尾追加が、リストが空かどうかで分岐せずに書ける。エラー時に `*ll = NULL` を入れてリストを閉じているのも忘れられていない。

### リンクは使い回す

[メモリプールのページ](../memory-pool/) のとおり、プールから取ったメモリは個別に解放できない。ところが chain link だけは例外扱いされている ([`src/core/ngx_buf.h#L147-L150`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_buf.h#L147-L150))。

```c title="src/core/ngx_buf.h"
ngx_chain_t *ngx_alloc_chain_link(ngx_pool_t *pool);
#define ngx_free_chain(pool, cl)                                             \
    (cl)->next = (pool)->chain;                                              \
    (pool)->chain = (cl)
```

`ngx_pool_t` の `chain` フィールドが、解放済みリンクのフリーリストになっている。`ngx_free_chain` はリンクをそこに繋ぐだけ。取るほうは、あればそこから取る ([`src/core/ngx_buf.c#L47-L65`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_buf.c#L47-L65))。

```c title="src/core/ngx_buf.c"
ngx_chain_t *
ngx_alloc_chain_link(ngx_pool_t *pool)
{
    ngx_chain_t  *cl;

    cl = pool->chain;

    if (cl) {
        pool->chain = cl->next;
        return cl;
    }

    cl = ngx_palloc(pool, sizeof(ngx_chain_t));
    if (cl == NULL) {
        return NULL;
    }

    return cl;
}
```

**サイズが固定で、生成と破棄が極端に多いオブジェクトにだけ、専用のフリーリストを用意する。** 汎用のアロケータに個別解放を持ち込むのではなく、特定の型に対してだけ例外を作っている。フリーリストの実装が 2 行で済むのは、サイズが固定だからだ。

### 送信済みの追跡

`write()` が部分書き込みしたときの処理 ([`src/core/ngx_buf.c#L271-L314`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_buf.c#L271-L314))。

```c title="src/core/ngx_buf.c"
ngx_chain_t *
ngx_chain_update_sent(ngx_chain_t *in, off_t sent)
{
    off_t  size;

    for ( /* void */ ; in; in = in->next) {

        if (ngx_buf_special(in->buf)) {
            continue;
        }

        if (sent == 0) {
            break;
        }

        size = ngx_buf_size(in->buf);

        if (sent >= size) {
            sent -= size;

            if (ngx_buf_in_memory(in->buf)) {
                in->buf->pos = in->buf->last;
            }

            if (in->buf->in_file) {
                in->buf->file_pos = in->buf->file_last;
            }

            continue;
        }

        if (ngx_buf_in_memory(in->buf)) {
            in->buf->pos += (size_t) sent;
        }

        if (in->buf->in_file) {
            in->buf->file_pos += sent;
        }

        break;
    }

    return in;
}
```

送れたバイト数を先頭から食わせていき、**丸ごと送れた buf は `pos = last` にして空にし、途中まで送れた buf は `pos` を進める**。返り値は「次に送るべきリンク」。

`ngx_buf_special()` の buf を飛ばしているのが要る処理で、これらはサイズ 0 なのでカウントに関わらないが、位置としてはチェーンに残っている。

`in_file` と in-memory の両方を持つ buf では、両方のオフセットを同時に進めている。**同じデータの 2 つの表現が、常に同じ位置を指し続ける**ように維持されている。

### 隣り合う buf をまとめる

書き出す直前に `iovec` に変換する ([`src/os/unix/ngx_writev_chain.c#L108-L178`](https://github.com/nginx/nginx/blob/release-1.31.4/src/os/unix/ngx_writev_chain.c#L108-L178))。

```c title="src/os/unix/ngx_writev_chain.c"
    for ( /* void */ ; in && total < limit; in = in->next) {

        if (ngx_buf_special(in->buf)) {
            continue;
        }

        if (in->buf->in_file) {
            break;
        }

        if (!ngx_buf_in_memory(in->buf)) {
            ngx_log_error(NGX_LOG_ALERT, log, 0,
                          "bad buf in output chain "
                          "t:%d r:%d f:%d %p %p-%p %p %O-%O",
                          /* ... 全フラグとポインタ ... */);

            ngx_debug_point();

            return NGX_CHAIN_ERROR;
        }

        size = in->buf->last - in->buf->pos;

        if (size > limit - total) {
            size = limit - total;
        }

        if (prev == in->buf->pos) {
            iov->iov_len += size;

        } else {
            if (n == vec->nalloc) {
                break;
            }

            iov = &vec->iovs[n++];

            iov->iov_base = (void *) in->buf->pos;
            iov->iov_len = size;
        }

        prev = in->buf->pos + size;
        total += size;
    }
```

`prev == in->buf->pos` の判定が肝で、**前の buf の終端と次の buf の開始が同じアドレスなら、`iovec` を増やさずに長さを伸ばす**。[メモリプール](../memory-pool/) から連続して取られた buf は、実際にアドレスが隣接することが多い。1024 個の buf が全部隣接していれば `iovec` 1 個で済む。

`in_file` の buf に当たったら `break` するのも重要で、**メモリの buf とファイルの buf が混ざったチェーンでは、メモリのぶんだけを `writev()` で送り、ファイルのぶんは `sendfile()` に回す**。連続した種類ごとに区切って、それぞれ最適な syscall を選ぶ。

`!ngx_buf_in_memory(buf)` に落ちたときの処理も特徴的で、全フラグをログに出して `ngx_debug_point()` する。ここに来るのは「メモリでもファイルでも special でもない buf」で、モジュールのバグでしかありえない。**ありえない状態に対して、黙って進まずに全情報を吐いて止まる**。

### 「そのまま流せるか」の判定

`ngx_output_chain_as_is()` ([`src/core/ngx_output_chain.c#L249-L306`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_output_chain.c#L249-L306))。

```c title="src/core/ngx_output_chain.c"
static ngx_inline ngx_int_t
ngx_output_chain_as_is(ngx_output_chain_ctx_t *ctx, ngx_buf_t *buf)
{
    ngx_uint_t  sendfile;

    if (ngx_buf_special(buf)) {
        return 1;
    }
    /* ... */
    sendfile = ctx->sendfile;
    /* ... */
#if !(NGX_HAVE_SENDFILE_NODISKIO)

    /*
     * With DIRECTIO, disable sendfile() unless sendfile(SF_NOCACHE)
     * is available.
     */

    if (buf->in_file && buf->file->directio) {
        sendfile = 0;
    }

#endif

    if (!sendfile) {

        if (!ngx_buf_in_memory(buf)) {
            return 0;
        }

        buf->in_file = 0;
    }

    if (ctx->need_in_memory && !ngx_buf_in_memory(buf)) {
        return 0;
    }

    if (ctx->need_in_temp && (buf->memory || buf->mmap)) {
        return 0;
    }

    return 1;
}
```

3 種類の「ダメな理由」がある。**`sendfile` が使えないのにファイルの buf である**、**下流がメモリ上のデータを必要としている** (gzip や SSI のように中身を読む必要がある)、**下流が書き換え可能なメモリを必要としている** (`sub_filter` のように書き換える)。

`ctx->need_in_memory` と `ctx->need_in_temp` は、下流のフィルタが何を要求しているかを表す。**「データがどこにあるか」と「どこにあるべきか」を突き合わせて、必要なときだけコピーする。**

`if (!sendfile) { ... buf->in_file = 0; }` の行が象徴的で、メモリにもファイルにも同じデータがあるとき、`sendfile` が使えないなら **ファイル側を「無かったこと」にする**。フラグを落とすだけで、以降のコードはメモリ上のデータだけを見るようになる。

### 送信中のバッファを再利用する

上流からデータを受けて下流に流す構成では、buf を使い回す必要がある。`free` と `busy` の 2 本のリストを持つのが定石になっている ([`src/core/ngx_buf.c#L184-L223`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_buf.c#L184-L223))。

```c title="src/core/ngx_buf.c"
void
ngx_chain_update_chains(ngx_pool_t *p, ngx_chain_t **free, ngx_chain_t **busy,
    ngx_chain_t **out, ngx_buf_tag_t tag)
{
    ngx_chain_t  *cl;

    if (*out) {
        if (*busy == NULL) {
            *busy = *out;

        } else {
            for (cl = *busy; cl->next; cl = cl->next) { /* void */ }

            cl->next = *out;
        }

        *out = NULL;
    }

    while (*busy) {
        cl = *busy;

        if (cl->buf->tag != tag) {
            *busy = cl->next;
            ngx_free_chain(p, cl);
            continue;
        }

        if (ngx_buf_size(cl->buf) != 0) {
            break;
        }

        cl->buf->pos = cl->buf->start;
        cl->buf->last = cl->buf->start;

        *busy = cl->next;
        cl->next = *free;
        *free = cl;
    }
}
```

`out` (今回書き出したもの) を `busy` の末尾に繋ぎ、`busy` の先頭から見て **サイズが 0 になった (= 送信完了した) buf を `free` に移す**。

`tag` の判定が入っているのがポイントで、`ngx_buf_tag_t` は `void *` の別名 ([`ngx_buf.h#L16`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_buf.h#L16))、実際にはモジュール構造体のアドレスが入る。

```c title="src/core/ngx_buf.h"
typedef void *            ngx_buf_tag_t;
```

自分のタグでない buf は、自分が確保したものではないので `free` リストに入れてはいけない。リンクだけをプールに返して先に進む。**「このオブジェクトは誰のものか」を、ポインタの同一性だけで表現している。** 文字列の比較も、モジュール ID の採番も要らない。

サイズが 0 でない buf に当たったら `break` するので、**送信は順番に完了する** という前提が入っている。実際、TCP の送信はチェーンの先頭から順に進むので、途中だけ完了することはない。

再利用側 ([`#L156-L181`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_buf.c#L156-L181))。

```c title="src/core/ngx_buf.c"
ngx_chain_t *
ngx_chain_get_free_buf(ngx_pool_t *p, ngx_chain_t **free)
{
    ngx_chain_t  *cl;

    if (*free) {
        cl = *free;
        *free = cl->next;
        cl->next = NULL;
        return cl;
    }

    cl = ngx_alloc_chain_link(p);
    /* ... */
    cl->buf = ngx_calloc_buf(p);
    /* ... */
    cl->next = NULL;

    return cl;
}
```

`free` にあればそれを、無ければプールから新しく取る。**`free` リストは上限を持たない**ので、同時に必要になった最大数まで自然に増えて、そこで止まる。

### 同じ実体を指す 2 つの buf

`shadow` は、1 つの実体に対して 2 つの記述子を持つための仕掛けだ。上流からの応答を一時ファイルに退避する場面 ([`src/event/ngx_event_pipe.c#L923-L949`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/ngx_event_pipe.c#L923-L949)) で使われる。

```c title="src/event/ngx_event_pipe.c"
    for (cl = out; cl; cl = next) {
        next = cl->next;

        cl->next = p->free;
        p->free = cl;

        b = cl->buf;

        if (b->last_shadow) {

            tl = ngx_alloc_chain_link(p->pool);
            if (tl == NULL) {
                return NGX_ABORT;
            }

            tl->buf = b->shadow;
            tl->next = NULL;

            *last_free = tl;
            last_free = &tl->next;

            b->shadow->pos = b->shadow->start;
            b->shadow->last = b->shadow->start;

            ngx_event_pipe_remove_shadow_links(b->shadow);
        }
    }
```

上流から読むための生バッファが 1 つあり、そこから切り出された「下流に出す buf」が複数ある。切り出された側は `shadow` で元のバッファを指し、最後の 1 つに `last_shadow` が立つ。

**最後の切り出しが処理し終わったときに初めて、元の生バッファが解放可能になる。** `last_shadow` は参照カウントの代わりで、「順番に処理される」という前提があるので、カウンタではなく「最後かどうか」の 1 ビットで足りている。

## なぜそうなっているか

### 「バッファ」という名前が実態と合っていない

`ngx_buf_t` を初めて読むと、名前からメモリの塊を想像する。実際には **メモリを持たない buf のほうが重要**だ。ファイルの範囲を指す buf、`last_buf` だけを運ぶ buf、`mmap` した領域を指す buf。共通しているのは「出力ストリームの一区間を表す」ことだけ。

この抽象があるから、`ngx_http_output_filter()` を通るデータが「メモリ上のバイト列」に固定されない。静的ファイルは `sendfile()` に、キャッシュヒットはページキャッシュに、gzip の結果は新しく確保したメモリに、それぞれ落ちるが、**フィルタチェーンから見ればどれも同じ `ngx_chain_t *`** になる。

もし buf が実データを持つ設計だったら、`sendfile()` を後から入れることはできなかった。**「データそのもの」ではなく「データの在り処」を型にした**ことが、20 年ぶんの拡張を吸収している。

### `last_buf` を buf で表す

ストリームの終わりを表す方法はいくつかある。関数の引数に `is_last` を足す、専用の終了関数を呼ぶ、`NULL` を流す。Nginx は **データと同じ型の中に終端を埋め込んだ**。

これが効くのは、フィルタチェーンを通るからだ。10 個のフィルタが連なっているとき、「終わりだ」という情報も 10 個のフィルタを順に通っていく必要がある。データと同じ経路に乗せておけば、**各フィルタは終端を特別扱いせずに転送できる**。gzip フィルタのように「終端を見たら最後のブロックを吐く」必要があるものだけが `last_buf` を見る。

`ngx_buf_special()` というマクロが用意されていることが、この設計を支えている。データを扱う処理は先頭で `if (ngx_buf_special(b)) continue;` と書けば、制御用の buf を素通しできる。

### タグがポインタである理由

`ngx_buf_tag_t` が `void *` で、実際にはモジュール構造体のアドレスが入る。

```c
    b->tag = (ngx_buf_tag_t) &ngx_http_proxy_module;
```

グローバル変数のアドレスは、プロセス内で一意で、リンク時に決まり、比較が 1 命令で済む。**ID を採番する仕組みも、文字列も、レジストリも要らない。** モジュールが増えても衝突しない。

C でモジュール性を出すときの定石で、Nginx では他にも「関数ポインタの値そのものを識別子として使う」場面がある ([メモリプールのページ](../memory-pool/) の `c->handler == ngx_pool_cleanup_file` がそれ)。

### コピーは「必要になったときだけ」

`ngx_output_chain_as_is()` は、**コピーしない理由を探す**関数になっている。デフォルトは「そのまま流す」で、`sendfile` が使えない、下流がメモリを要求している、下流が書き換えを要求している、のどれかに当たったときだけコピーに落ちる。

この向きが重要で、逆 (デフォルトはコピー、条件を満たしたら最適化) にすると、新しいモジュールが増えたときにコピーが残りやすい。**最適化のほうを既定にして、必要な場合だけ諦める**と、諦める理由がコードに明示される。

### `free`/`busy` の 2 本立てが、非同期の必然

buf を再利用したいが、**書き出しを依頼した buf をすぐには再利用できない**。`writev()` が部分書き込みで返れば、まだ送っていないデータがそこにある。だから「渡したがまだ完了していない」状態を表すリストが要る。

これは非同期 I/O を持つシステムに普遍的に出てくる形で、in-flight のバッファを追跡する仕組みが必ず要る。Nginx の場合、**完了判定が `ngx_buf_size(cl->buf) != 0` という「中身が空になったか」で行われている** のが特徴的だ。専用の完了フラグを持たず、`ngx_chain_update_sent()` が `pos` を進めた副作用として完了が分かる。状態を 2 箇所に持たない。

## どう活かすか

### そのまま真似できるところ

**「データ」ではなく「データの在り処」を型にする。** ストリームを扱う API を設計するとき、`byte[]` を渡す代わりに「メモリの範囲か、ファイルの範囲か、他のストリームか」を表せる型にしておくと、後からゼロコピーを入れられる。Java の `ByteBuffer` + `FileRegion`、Rust の `Bytes` + `File range`、Go の `io.ReaderFrom` / `sendfile` 経路がこれに当たる。

**確保領域と有効範囲を別のポインタで持つ。** `start`/`end` と `pos`/`last` の 2 対。リングバッファでもスライスでも、「どこに書けるか」と「どこを読むべきか」を別に持つと、部分読み・部分書きの追跡が素直になる。

**終端をストリーム内の値として表す。** 「最後のチャンク」を、データと同じ型で流す。フィルタやミドルウェアを通す設計では、制御情報も同じ経路を通す必要がある。別のチャネルにすると、順序の保証が別途必要になる。

**所有者の識別に、グローバルなオブジェクトのアドレスを使う。** ID の採番もレジストリも要らず、リンク時に一意性が保証される。C 以外でも、シングルトンのインスタンスやシンボルを同じように使える。

**コピーしない理由ではなく、コピーする理由を書く。** デフォルトをゼロコピーにして、必要な条件でだけコピーに落とす。判定関数 1 つにまとめておくと、「なぜここでコピーが起きるか」を 1 箇所で読める。

**サイズ固定・生成頻度が極端に高いオブジェクトにだけ、専用のフリーリストを用意する。** 汎用アロケータに手を入れるより安全で、実装も数行で済む。

**ありえない状態には、全情報を吐いて止まる。** `ngx_output_chain_to_iovec` の "bad buf in output chain" は、全フラグと全ポインタをログに出してから `ngx_debug_point()` する。サードパーティが拡張するシステムでは、不変条件が破れた場所と破った内容を記録しておかないと原因が追えない。

### 取り込むべきでない条件

**フラグが多い構造体は、不変条件がコードに散らばる。** `temporary` と `memory` と `mmap` と `in_file` の組み合わせのうち、意味のあるものは一部だけ。どの組み合わせが正当かは型では表現されておらず、`ngx_buf_in_memory()` のようなマクロと各所の `if` に散っている。実際、サードパーティモジュールがフラグを間違えて設定するのは典型的なバグだ。代数的データ型が使える言語なら、`enum { InMemory{..}, InFile{..}, Special{..} }` と書くほうが安全になる。

**`shadow` は、参照カウントの代わりとしては脆い。** 「順番に処理される」という前提が崩れると壊れる。実際、`ngx_event_pipe.c` の shadow まわりは Nginx のコードの中でも読みにくい部類で、バグの報告も出ている。素直に参照カウントを持たせられるなら、そのほうがいい。

**`prev == in->buf->pos` によるマージは、アロケータの実装に依存している。** プールが連続してメモリを切り出すから隣接する。別のアロケータに変えたら効かなくなる最適化なので、効果を測ってから入れる。

## 関連

- buf を確保しているプールの話は [メモリプールのページ](../memory-pool/)。
- チェーンがモジュールを順に通っていく仕組みは [出力フィルタチェーンのページ](../output-filter-chain/)。
- `shadow` と `free`/`busy` が実際に使われている場所は [upstream と event_pipe のページ](../upstream-event-pipe/)。

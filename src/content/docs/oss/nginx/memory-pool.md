---
title: "解放を個別に書かず、寿命が同じものをまとめて捨てるアリーナにする"
description: "確保はポインタを進めるだけ、解放はリクエストが終わるときに丸ごと 1 回。ソース全体で確保が 979 箇所あるのに個別解放は 22 箇所しかない。プールは設定・接続・リクエストの 3 段に入れ子になっていて、リクエスト構造体自身も自分のプールから取られている。メモリ以外の資源は cleanup チェーンでプールの寿命に相乗りさせる。"
group: "設計の掘り下げ"
sidebar:
  order: 33
---

## 何を学んだか

### どんな状況の話か

HTTP リクエスト 1 本を処理する間に、細かい確保が大量に起きる。ヘッダの配列、正規化した URI、パースした Cookie、変数の値、上流に送るリクエストの組み立て、ログの 1 行。1 個 1 個は数十バイトで、寿命は全部同じ — **リクエストが終わったら全部不要になる**。

これを `malloc`/`free` で書くと 2 つ問題が出る。1 つは速度で、小さい確保と解放が数十回起きればアロケータのロックと bin 探索が積み上がる。もう 1 つはもっと深刻で、**エラーパスで解放を書き忘れる**。C にはデストラクタが無いので、ヘッダのパース中に不正な文字を見つけて `return NGX_ERROR` するとき、そこまでに確保した全部を手で解放しなければならない。

しかも Nginx は [ステートマシン](../state-machine/) なので、確保した場所と解放すべき場所が別の関数、別のイベント、別のループの回になる。`goto cleanup` すら書けない。

### Nginx の答え

1. **確保はポインタを進めるだけ、解放は寿命の終わりに丸ごと 1 回。** `ngx_pool_t` は連続したメモリブロックと「次に使える位置」を持ち、`ngx_palloc()` はその位置を size ぶん進めて返す。
2. **プールを寿命の階層に対応させる。** 設定プール (プロセスが生きている間)、接続プール (TCP 接続の間)、リクエストプール (リクエストの間)。長さの違う寿命ごとに別のプールがある。
3. **プールのサイズを超える確保は、素の `malloc` に落として台帳に記録する。** その台帳もプールから取る。破棄のときに台帳を辿って `free()` する。
4. **リクエスト構造体そのものを、自分のプールから確保する。** プールを破棄すると、構造体の実体も一緒に消える。
5. **メモリ以外の資源は、cleanup チェーンでプールの寿命に相乗りさせる。** 開いたファイル、作った一時ファイル、確保した外部ライブラリのオブジェクト。関数ポインタとデータの組をプールに登録しておくと、破棄時に LIFO で呼ばれる。
6. **個別解放は「大きいブロック」に対してだけ、例外的に提供する。** `ngx_pfree()` は台帳を線形探索して、見つかれば `free()`、無ければ `NGX_DECLINED` を返す。
7. **アライメントするかしないかを、呼ぶ関数で選ばせる。** 構造体には `ngx_palloc()`、文字列には `ngx_pnalloc()`。

結果として、**ソース全体で `ngx_palloc` 系の呼び出しが 979 箇所あるのに対し、`ngx_pfree` は 22 箇所しかない**。`ngx_destroy_pool()` は 126 箇所で呼ばれているが、そのほとんどは接続やリクエストの終了処理という決まった場所にある。

## ソースコードのどこか

### プールの形

[`src/core/ngx_palloc.h#L49-L65`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_palloc.h#L49-L65)。

```c title="src/core/ngx_palloc.h"
typedef struct {
    u_char               *last;
    u_char               *end;
    ngx_pool_t           *next;
    ngx_uint_t            failed;
} ngx_pool_data_t;


struct ngx_pool_s {
    ngx_pool_data_t       d;
    size_t                max;
    ngx_pool_t           *current;
    ngx_chain_t          *chain;
    ngx_pool_large_t     *large;
    ngx_pool_cleanup_t   *cleanup;
    ngx_log_t            *log;
};
```

`d.last` が「次に使える位置」、`d.end` がブロックの終端。`d.next` で次のブロックに繋がる。**構造体そのものがブロックの先頭に置かれている**ので、プールのメタデータのために別の確保をしない。

2 段構造になっているのが効いていて、2 個目以降のブロックは `ngx_pool_data_t` の部分しか使わない。`max` や `cleanup` は先頭ブロックだけが持つ ([`src/core/ngx_palloc.c#L18-L43`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_palloc.c#L18-L43))。

```c title="src/core/ngx_palloc.c"
ngx_pool_t *
ngx_create_pool(size_t size, ngx_log_t *log)
{
    ngx_pool_t  *p;

    p = ngx_memalign(NGX_POOL_ALIGNMENT, size, log);
    if (p == NULL) {
        return NULL;
    }

    p->d.last = (u_char *) p + sizeof(ngx_pool_t);
    p->d.end = (u_char *) p + size;
    p->d.next = NULL;
    p->d.failed = 0;

    size = size - sizeof(ngx_pool_t);
    p->max = (size < NGX_MAX_ALLOC_FROM_POOL) ? size : NGX_MAX_ALLOC_FROM_POOL;

    p->current = p;
    p->chain = NULL;
    p->large = NULL;
    p->cleanup = NULL;
    p->log = log;

    return p;
}
```

`max` は「このプールから直接取れる最大サイズ」で、`NGX_MAX_ALLOC_FROM_POOL` = `ngx_pagesize - 1` で頭打ちになる ([`ngx_palloc.h#L16-L20`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_palloc.h#L16-L20))。

```c title="src/core/ngx_palloc.h"
/*
 * NGX_MAX_ALLOC_FROM_POOL should be (ngx_pagesize - 1), i.e. 4095 on x86.
 * On Windows NT it decreases a number of locked pages in a kernel.
 */
#define NGX_MAX_ALLOC_FROM_POOL  (ngx_pagesize - 1)
```

1 ページ以上の確保をプールから取らないのは、**プールのブロックが 1 ページを跨ぐと、その全体が使われるまで解放できない**からだ。大きいものは素の `malloc` に落として個別に管理したほうが、メモリの居座りが減る。

### 確保はポインタを進めるだけ

[`src/core/ngx_palloc.c#L148-L174`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_palloc.c#L148-L174)。

```c title="src/core/ngx_palloc.c"
static ngx_inline void *
ngx_palloc_small(ngx_pool_t *pool, size_t size, ngx_uint_t align)
{
    u_char      *m;
    ngx_pool_t  *p;

    p = pool->current;

    do {
        m = p->d.last;

        if (align) {
            m = ngx_align_ptr(m, NGX_ALIGNMENT);
        }

        if ((size_t) (p->d.end - m) >= size) {
            p->d.last = m + size;

            return m;
        }

        p = p->d.next;

    } while (p);

    return ngx_palloc_block(pool, size);
}
```

本体は 3 行しかない。ポインタを合わせて、入るかを見て、進める。ロックも、フリーリストの探索も、サイズクラスの計算も無い。

`align` 引数が入口で分かれている ([`#L122-L145`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_palloc.c#L122-L145))。

```c title="src/core/ngx_palloc.c"
void *
ngx_palloc(ngx_pool_t *pool, size_t size)
{
#if !(NGX_DEBUG_PALLOC)
    if (size <= pool->max) {
        return ngx_palloc_small(pool, size, 1);
    }
#endif

    return ngx_palloc_large(pool, size);
}


void *
ngx_pnalloc(ngx_pool_t *pool, size_t size)
{
#if !(NGX_DEBUG_PALLOC)
    if (size <= pool->max) {
        return ngx_palloc_small(pool, size, 0);
    }
#endif

    return ngx_palloc_large(pool, size);
}
```

`ngx_palloc` はアライメントする (構造体を置く用)、`ngx_pnalloc` はしない (バイト列を置く用)。呼び分けるのは呼び出し側の責任で、`ngx_str_t` の中身は必ず `ngx_pnalloc`。

これは細かいようでいて効く。3 バイトの文字列を 100 個確保するとき、8 バイト境界に揃えると 500 バイト無駄になる。Nginx は URI やヘッダ値のコピーを大量に作るので、**「これはアライメントが要らないバイト列だ」を型ではなく呼ぶ関数で表現する** ことに意味がある。

`NGX_DEBUG_PALLOC` を定義してビルドすると、`if` ごと消えて全部が `ngx_palloc_large` に行く。つまり **全部の確保が個別の `malloc` になる** ので、Valgrind や ASan が境界越えを検出できる。プールは境界チェックを潰してしまうアロケータなので、デバッグ時に「潰さないモード」を用意してある。

### 空きが無いときのヒューリスティック

ブロックが埋まったら新しいブロックを繋ぐ ([`#L177-L210`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_palloc.c#L177-L210))。

```c title="src/core/ngx_palloc.c"
static void *
ngx_palloc_block(ngx_pool_t *pool, size_t size)
{
    u_char      *m;
    size_t       psize;
    ngx_pool_t  *p, *new;

    psize = (size_t) (pool->d.end - (u_char *) pool);

    m = ngx_memalign(NGX_POOL_ALIGNMENT, psize, pool->log);
    if (m == NULL) {
        return NULL;
    }

    new = (ngx_pool_t *) m;

    new->d.end = m + psize;
    new->d.next = NULL;
    new->d.failed = 0;

    m += sizeof(ngx_pool_data_t);
    m = ngx_align_ptr(m, NGX_ALIGNMENT);
    new->d.last = m + size;

    for (p = pool->current; p->d.next; p = p->d.next) {
        if (p->d.failed++ > 4) {
            pool->current = p->d.next;
        }
    }

    p->d.next = new;

    return m;
}
```

新しいブロックは **先頭ブロックと同じサイズ**になる (`psize` を先頭から計算している)。そして `sizeof(ngx_pool_t)` ではなく `sizeof(ngx_pool_data_t)` だけを予約する。2 個目以降はメタデータが小さくて済む。

最後の `for` ループが面白い。**確保に失敗したブロックのカウンタを増やし、5 回失敗したら `current` を次に進める**。`current` は `ngx_palloc_small()` の探索開始点なので、これは「もう埋まりきっているブロックを、毎回の線形探索から外す」ことをやっている。

厳密ではない。ブロックが 5 回失敗したというだけで、まだ小さい確保なら入るかもしれない。それでも、**プールが長く生きて何十ブロックにもなったときに、確保が O(ブロック数) から O(1) に近づく**。閾値の 4 に根拠はなく、経験的な値だろう。「たいてい速ければいい」という割り切りが入っている。

### 大きいものは台帳で管理

[`#L213-L249`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_palloc.c#L213-L249)。

```c title="src/core/ngx_palloc.c"
static void *
ngx_palloc_large(ngx_pool_t *pool, size_t size)
{
    void              *p;
    ngx_uint_t         n;
    ngx_pool_large_t  *large;

    p = ngx_alloc(size, pool->log);
    if (p == NULL) {
        return NULL;
    }

    n = 0;

    for (large = pool->large; large; large = large->next) {
        if (large->alloc == NULL) {
            large->alloc = p;
            return p;
        }

        if (n++ > 3) {
            break;
        }
    }

    large = ngx_palloc_small(pool, sizeof(ngx_pool_large_t), 1);
    if (large == NULL) {
        ngx_free(p);
        return NULL;
    }

    large->alloc = p;
    large->next = pool->large;
    pool->large = large;

    return p;
}
```

`ngx_pool_large_t` は `{ next, alloc }` の 2 ワードだけ ([`ngx_palloc.h#L43-L46`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_palloc.h#L43-L46))。台帳のエントリ自身は `ngx_palloc_small()` でプールから取るので、**台帳のために `malloc` が増えることはない**。

ここにもヒューリスティックがある。既存のエントリで `alloc == NULL` (= `ngx_pfree` で解放済み) のものを再利用するが、**先頭から 4 個までしか探さない**。それ以上探すと線形探索のコストのほうが高くつく。見つからなければ新しいエントリを積む。

`ngx_pfree()` はその逆で、台帳を全部辿る ([`#L277-L294`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_palloc.c#L277-L294))。

```c title="src/core/ngx_palloc.c"
ngx_int_t
ngx_pfree(ngx_pool_t *pool, void *p)
{
    ngx_pool_large_t  *l;

    for (l = pool->large; l; l = l->next) {
        if (p == l->alloc) {
            ngx_free(l->alloc);
            l->alloc = NULL;

            return NGX_OK;
        }
    }

    return NGX_DECLINED;
}
```

**プール本体から取ったメモリは解放できない**。`ngx_pfree` に渡しても `NGX_DECLINED` が返るだけで、何も起きない。呼び出し側はそれを知った上で使う。[ワーカーの 1 周のページ](../state-machine/) で見た `ngx_http_wait_request_handler` がこう書いていたのがそれだ。

```c title="src/http/ngx_http_request.c"
        if (b->pos == b->last) {

            /*
             * We are trying to not hold c->buffer's memory for an
             * idle connection.
             */

            if (ngx_pfree(c->pool, b->start) == NGX_OK) {
                b->start = NULL;
            }
        }
```

**`NGX_OK` が返ったときだけポインタを NULL にする**。`client_header_buffer_size` が既定の 1k なら 1 ページ未満なのでプールから取られていて、`ngx_pfree` は `NGX_DECLINED` を返し、バッファは保持されたまま。設定で大きくしてあれば `malloc` 側なので解放される。**同じコードが、設定値によって「解放する / しない」を自動的に切り替える**形になっている。

### 破棄は 1 箇所

[`#L46-L96`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_palloc.c#L46-L96)。

```c title="src/core/ngx_palloc.c"
void
ngx_destroy_pool(ngx_pool_t *pool)
{
    ngx_pool_t          *p, *n;
    ngx_pool_large_t    *l;
    ngx_pool_cleanup_t  *c;

    for (c = pool->cleanup; c; c = c->next) {
        if (c->handler) {
            c->handler(c->data);
        }
    }

    /* ... NGX_DEBUG のログ出力 ... */

    for (l = pool->large; l; l = l->next) {
        if (l->alloc) {
            ngx_free(l->alloc);
        }
    }

    for (p = pool, n = pool->d.next; /* void */; p = n, n = n->d.next) {
        ngx_free(p);

        if (n == NULL) {
            break;
        }
    }
}
```

順序が決まっている。**cleanup ハンドラ → 大きい確保 → ブロック本体**。cleanup ハンドラはプールの中のデータを触るので、メモリが生きているうちに走らせる。

ブロックを解放するループが独特で、`ngx_free(p)` した後に `n` を見ている。`p` を解放した後に `p->d.next` を読むと解放済みメモリの参照になるので、**先に次を控えてから解放する**。

`#if (NGX_DEBUG)` のブロックにあるコメントも実務的だ。

```c title="src/core/ngx_palloc.c"
    /*
     * we could allocate the pool->log from this pool
     * so we cannot use this log while free()ing the pool
     */
```

ログオブジェクト自体がこのプールから取られている可能性があるので、解放しながらログを書けない。だからデバッグログを先にまとめて出してから解放に入る。**自分自身をホストしているデータ構造を壊すときの順序**を意識している。

### リクエストは自分のプールから取られる

`ngx_http_free_request()` の最後 ([`src/http/ngx_http_request.c#L4003-L4011`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_request.c#L4003-L4011))。

```c title="src/http/ngx_http_request.c"
    /*
     * Setting r->pool to NULL will increase probability to catch double close
     * of request since the request object is allocated from its own pool.
     */

    pool = r->pool;
    r->pool = NULL;

    ngx_destroy_pool(pool);
```

`ngx_http_request_t` は `r->pool` から確保されている。だから `ngx_destroy_pool(r->pool)` を呼ぶと **`r` 自身が解放される**。ローカル変数に退避してから破棄しているのはそのためだ。

`r->pool = NULL` を先に入れているのは、二重解放の検出を助けるため。解放済みメモリはすぐには再利用されないことが多いので、二度目に来たときに `r->pool` が NULL のまま残っていて、`ngx_destroy_pool(NULL)` でクラッシュする。**確実に落ちるほうが、静かに壊れるより良い**という判断になっている。

### メモリ以外の資源

cleanup チェーンの登録は [`src/core/ngx_palloc.c#L311-L339`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_palloc.c#L311-L339)。

```c title="src/core/ngx_palloc.c"
ngx_pool_cleanup_t *
ngx_pool_cleanup_add(ngx_pool_t *p, size_t size)
{
    ngx_pool_cleanup_t  *c;

    c = ngx_palloc(p, sizeof(ngx_pool_cleanup_t));
    if (c == NULL) {
        return NULL;
    }

    if (size) {
        c->data = ngx_palloc(p, size);
        if (c->data == NULL) {
            return NULL;
        }

    } else {
        c->data = NULL;
    }

    c->handler = NULL;
    c->next = p->cleanup;

    p->cleanup = c;

    return c;
}
```

**エントリと、ハンドラに渡すデータの両方をプールから取る。** 呼び出し側は `size` にデータのサイズを渡し、返ってきた `c->data` に書き込んで、`c->handler` に関数を入れる。cleanup 用のメモリ管理が要らない。

`c->handler = NULL` で初期化されているので、**登録した後で「やっぱり実行しない」に変えられる**。`ngx_pool_run_cleanup_file()` がそれを使っている ([`#L342-L360`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_palloc.c#L342-L360))。

```c title="src/core/ngx_palloc.c"
void
ngx_pool_run_cleanup_file(ngx_pool_t *p, ngx_fd_t fd)
{
    ngx_pool_cleanup_t       *c;
    ngx_pool_cleanup_file_t  *cf;

    for (c = p->cleanup; c; c = c->next) {
        if (c->handler == ngx_pool_cleanup_file) {

            cf = c->data;

            if (cf->fd == fd) {
                c->handler(cf);
                c->handler = NULL;
                return;
            }
        }
    }
}
```

「予定より早く閉じたい」ときに、今すぐ実行してハンドラを無効化する。**登録の取り消しをリストからの削除ではなく、関数ポインタの NULL 化で表している。** 単方向リストなので削除は面倒だが、この方法なら O(1) で済む。

チェーンは先頭に足していく (`c->next = p->cleanup; p->cleanup = c;`) ので、破棄時は **最後に登録したものから実行される**。C++ のデストラクタや Go の `defer` と同じ LIFO で、依存関係のあるリソースを正しい順序で片付けられる。

標準のハンドラが 2 つ用意されている ([`#L363-L401`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_palloc.c#L363-L401))。`ngx_pool_cleanup_file` は fd を閉じるだけ、`ngx_pool_delete_file` はファイルを消してから閉じる。後者は一時ファイル用で、**「リクエストが終わったら消える一時ファイル」がプールへの登録 1 行で実現する**。

### プールの階層

寿命ごとにプールがある。

- **設定プール** (`cycle->pool`): 起動時に作られ、次の設定リロードまで生きる。設定の構造体、コンパイル済み正規表現、リスニングソケットの記述などが入る。
- **接続プール** (`c->pool`): `accept()` で作られ、接続が閉じるときに破棄される。既定サイズは `64 * sizeof(void *)` = 64 ビットで 512 バイト ([`ngx_http_core_module.c#L3572-L3573`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_core_module.c#L3572-L3573))。
- **リクエストプール** (`r->pool`): リクエストごと。既定 4096 バイト ([`#L3574-L3575`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_core_module.c#L3574-L3575))。

```c title="src/http/ngx_http_core_module.c"
    ngx_conf_merge_size_value(conf->connection_pool_size,
                              prev->connection_pool_size, 64 * sizeof(void *));
    ngx_conf_merge_size_value(conf->request_pool_size,
                              prev->request_pool_size, 4096);
```

初期サイズが小さいのがポイントで、**足りなければブロックを繋げばいい**ので、大きく取る理由がない。keepalive で 100 リクエストを受ける接続でも、接続プールは 512 バイトのまま (リクエストごとの確保はリクエストプールに行く)。

この階層のおかげで、**確保するときに「どのプールから取るか」を選ぶことが、そのまま寿命の宣言になる**。リクエストをまたいで生き残るべきものは `c->pool` から、リクエスト内で完結するものは `r->pool` から取る。型では表現されていないが、コードを読むときの手掛かりになる。

### 再利用

`ngx_reset_pool()` ([`#L99-L119`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_palloc.c#L99-L119)) は、破棄せずに中身だけ空にする。

```c title="src/core/ngx_palloc.c"
void
ngx_reset_pool(ngx_pool_t *pool)
{
    ngx_pool_t        *p;
    ngx_pool_large_t  *l;

    for (l = pool->large; l; l = l->next) {
        if (l->alloc) {
            ngx_free(l->alloc);
        }
    }

    for (p = pool; p; p = p->d.next) {
        p->d.last = (u_char *) p + sizeof(ngx_pool_t);
        p->d.failed = 0;
    }

    pool->current = pool;
    pool->chain = NULL;
    pool->large = NULL;
}
```

ブロックは繋がったまま、`d.last` だけを戻す。**次の周では、既に確保済みのブロックを最初から使える**ので `malloc` が減る。設定ファイルを 1 ファイルずつ読むときの一時プールなど、同じ形の作業を繰り返す場面で使われる。

cleanup チェーンは触られていない。リセットは「メモリを空にする」だけで、リソースの解放は伴わない。

なお、2 個目以降のブロックにも `sizeof(ngx_pool_t)` ぶんを飛ばして `d.last` を戻している。実際には `sizeof(ngx_pool_data_t)` で足りるので、ブロックあたり数十バイトが使われないまま残る。プールをリセットして使い回す場面が限られているので、実害は出ていない。

## なぜそうなっているか

### 「解放を書かない」ことが、エラー処理の形を決めている

`ngx_http_wait_request_handler()` のエラーパスを見返すと、全部これだ。

```c title="src/http/ngx_http_request.c"
    if (n == NGX_ERROR) {
        ngx_http_close_connection(c);
        return;
    }
```

そこまでに `c->pool` から確保したバッファ、`ngx_http_connection_t`、ログのコンテキスト — 全部プールの中にあるので、書くのは「接続を閉じる」だけ。`ngx_http_close_connection()` が `ngx_destroy_pool(c->pool)` を呼ぶ。

これが C で書かれた 25 万行のコードベースを維持可能にしている一番の要素だと思う。エラーパスは **正常系より数が多く、テストされにくく、それでいてリークの温床になる**。そこから解放を消せるなら、コストを払う価値がある。

裏返すと、**プールが無かったら Nginx のステートマシン構造は破綻していた**はずだ。確保した関数と解放すべき関数が別々のイベントで動くのだから、対応関係を手で追うのは無理がある。「非同期にする」と「アリーナにする」は独立した選択に見えて、実は片方がもう片方を要求している。

### 断片化と居座り

アリーナの弱点は、**プール内の 1 バイトが生きている限りブロック全体が解放されない**ことだ。Nginx はそれを、寿命の階層をきっちり分けることで抑えている。リクエストプールはリクエストと同時に死ぬので、居座りようがない。

危ないのは設定プールで、これはリロードまで生きる。だからサードパーティモジュールが「リクエストごとのデータを設定プールから取る」バグを書くと、メモリが単調増加する。プールを選ぶことが寿命の宣言になっている以上、**間違ったプールを選ぶことが即リークになる**。

`NGX_MAX_ALLOC_FROM_POOL` で 1 ページ以上をプールから取らせないのも、この居座り対策になっている。大きいものほど居座ったときの被害が大きいので、個別管理に落とす。

### `ngx_pfree` が `NGX_DECLINED` を返すという設計

「解放できないなら関数を用意しなければいい」とも言える。実際には用意されていて、**成功したかどうかを呼び出し側が判断できる**ようになっている。

これがあるおかげで、`ngx_http_wait_request_handler` は「解放できるなら解放する、できないなら諦める」を素直に書ける。設定値によってプール内かプール外かが変わるので、呼び出し側が事前に判断することはできない。**最善努力の操作として API を切っている**。

`NGX_DECLINED` という戻り値の存在も効いていて、これは「エラーではないが、実行しなかった」を意味する。`NGX_ERROR` を返していたら、呼び出し側がエラー処理を書くことになってしまう。

### cleanup チェーンは、C にデストラクタを持ち込む最小の道具

`{ handler, data, next }` の 3 ワードだけで、RAII に近いものが得られている。しかも **プールの実装は resource が何かを知らない**。ファイルでも、外部ライブラリのハンドルでも、共有メモリの参照カウントでも、関数ポインタ 1 本で表現できる。

Nginx で cleanup を使っている代表例が、上流への接続の後始末、キャッシュファイルの参照カウント減算、正規表現の実行コンテキストの解放、一時ファイルの削除。どれも「メモリと同じ寿命だが、`free()` では片付かないもの」だ。

### 統計が示していること

確保 979 箇所に対して `ngx_pfree` が 22 箇所、`ngx_free` が 134 箇所。`ngx_free` の 134 のうち相当数は `ngx_palloc.c` 自身や、プールを使わない起動時のコードにある。

**確保と解放の比が 40 倍以上ある**というのは、普通の C コードでは起こりえない。この非対称性が、プールという選択の効果をそのまま表している。

## どう活かすか

### そのまま真似できるところ

**寿命が同じものを 1 つのアリーナにまとめる。** GC のある言語でも効く場面がある。リクエストごとに大量の短命オブジェクトを作るなら、`sync.Pool` やアリーナ、あるいは「リクエストスコープの構造体に全部ぶら下げる」形にすると、GC の圧力が下がる。Rust なら `bumpalo` や typed-arena がそのままこれだ。

**「どこから確保するか」を寿命の宣言として使う。** 引数にアロケータやアリーナを渡す設計にすると、呼び出し側が寿命を明示することになる。Zig の `allocator` 引数はこれを言語レベルでやっている。

**リソースの後始末を、所有者の寿命に相乗りさせる。** cleanup チェーンは 3 ワードの構造体と関数ポインタ 1 本。Go の `defer`、C# の `using`、Python の `contextlib.ExitStack` に相当するものを、無い言語でも 30 行で作れる。LIFO で実行するところまで含めて真似する価値がある。

**取り消しを、削除ではなく無効化で表す。** `c->handler = NULL` で「実行しない」にする。単方向リストからの削除より安く、参照が残っていても安全。

**デバッグ用に「最適化を無効にするモード」を用意する。** `NGX_DEBUG_PALLOC` を立てると全確保が個別の `malloc` になり、境界チェックツールが効くようになる。性能のために安全性チェックを潰す仕組みを入れるなら、潰さないビルドも一緒に用意する。

**壊れたポインタは NULL にして、確実に落とす。** `r->pool = NULL` は二重解放を「たぶん動く」から「必ず落ちる」に変える。バグを早く見つけるためにわざと壊れやすくする、という態度。

### 取り込むべきでない条件

**寿命がばらばらなら、アリーナは向かない。** アリーナが効くのは「まとめて捨てられる」からで、一部だけ長生きするものが混ざると、そこを別管理にする手間が増えるか、ブロック全体が居座る。リクエスト/接続/セッションのように寿命が明確に階層化されているワークロードで初めて成立する。

**プールを間違えると即リークになる。** 型で守られていないので、レビューと規律に頼ることになる。実際 Nginx のサードパーティモジュールでよくあるバグがこれだ。Rust のライフタイムのように、コンパイラが検査できる仕組みがあるならそちらを使う。

**`d.failed > 4` や「large を 4 個まで探す」のような魔法の数字は、そのまま持ち込まない。** Nginx のワークロードで経験的に決まった値で、根拠は測定にしかない。自分のコードで同じヒューリスティックを入れるなら、自分のワークロードで測り直す。

**個別解放できないアロケータは、長寿命のプールでは危険。** 設定プールのような長生きするプールに、実行時のデータを入れてはいけない。「このプールに入れていいのは何か」を、コードの慣習ではなく型か API で区別できるなら、そのほうがいい。

## 関連

- プールから取ったメモリを「どう持ち回るか」は [ngx_buf_t と ngx_chain_t のページ](../buf-chain/)。
- プロセス間で共有するメモリは、プールでは扱えないので別のアロケータになる。[スラブアロケータのページ](../slab-shared-memory/)。
- 確保と解放の対応がコードから消えることが、[ステートマシン](../state-machine/) を書けるようにしている。

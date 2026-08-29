---
title: "リクエストボディは「読む」「捨てる」「上流へ流す」の 3 通りで扱われる"
description: "ngx_http_read_client_request_body() はコールバックを渡す非同期 API で、呼んだ側は戻り値がエラーでなければ何もせず帰らなければならない。そのために入口で r->main->count が 1 つ増やされている。1387 行の ngx_http_request_body.c から、ヘッダバッファに入っている先読み分の扱い、client_body_buffer_size を超えたときの一時ファイル、13 状態の chunked パーサ、リクエストボディフィルタチェーン、そして「捨てるだけなのになぜコードが要るのか」を読む。"
group: "骨格: リクエストの一生"
sidebar:
  order: 22
---

## この層の責務

[リクエスト行とヘッダのパース](../request-parse/) が終わり、[server と location が決まった](../virtual-server-location/) 時点で、ボディはまだ 1 バイトも読まれていないことがある。あるいは、ヘッダを読むために確保したバッファの中に既に一部が入っていることもある。

ここから先、リクエストボディに対して起きることは 3 通りしかない。

1. **読む** — `POST` を受けて `proxy_pass` する、`client_body_in_file_only` でファイルに落とす、`auth_request` に渡す
2. **捨てる** — `GET` に body が付いてきた、`return 403` で処理を打ち切った、`client_max_body_size` を超えた
3. **上流へ流す** — `proxy_request_buffering off` で、受け取った端から上流に転送する

3 番目は 1 番目の変種で、同じ関数から入る。実装は `src/http/ngx_http_request_body.c` の 1387 行に収まっている。

この層が難しいのは、**どれもイベント駆動で、途中で中断して後から再開する**からだ。ボディが 10 MB あるなら `recv()` は数百回に分かれる。その間ワーカーは他の接続を処理する。

そして「捨てる」にもコードが要る。捨てるのに読まなければならないからだ。

## 主要な型とその関係

### `ngx_http_request_body_t`

[`src/http/ngx_http_request.h#L303-L316`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_request.h#L303-L316)。フィールドは 11 個しかない。

```c title="src/http/ngx_http_request.h"
typedef struct {
    ngx_temp_file_t                  *temp_file;
    ngx_chain_t                      *bufs;
    ngx_buf_t                        *buf;
    off_t                             rest;
    off_t                             received;
    ngx_chain_t                      *free;
    ngx_chain_t                      *busy;
    ngx_http_chunked_t               *chunked;
    ngx_http_client_body_handler_pt   post_handler;
    unsigned                          filter_need_buffering:1;
    unsigned                          last_sent:1;
    unsigned                          last_saved:1;
} ngx_http_request_body_t;
```

| 分類         | フィールド                                     | 役割                                                                                                  |
| ------------ | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 受信バッファ | `buf`                                          | `recv()` の書き込み先。1 枚だけ。`client_body_buffer_size` (既定 `2 * ngx_pagesize`) で大きさが決まる |
| 保存先       | `bufs` / `temp_file`                           | 読み終えたボディの置き場。メモリに残すか、一時ファイルに落とすか                                      |
| 再利用       | `free` / `busy`                                | 下流に渡した buf と、戻ってきて再利用できる buf                                                       |
| 進行状態     | `rest` / `received` / `chunked` / `last_saved` | あと何バイト読むか、chunked の途中状態、終端を見たか                                                  |
| 完了通知     | `post_handler`                                 | 型は `void (*)(ngx_http_request_t *r)`。戻り値も追加引数もない                                        |

`rest` は「あと読むべきバイト数」だが、chunked のときは「次に見たいデータ量の目安」に意味が変わる。初期値は `-1` で、「まだフィルタが初期化されていない」を表す第 3 の状態として使われる。

`buf` が 1 枚しかないところがポイントで、**受信バッファは使い回される**。埋まったら中身を `bufs` か一時ファイルに移して、`pos` と `last` を `start` に戻す。だからボディが 100 MB でもメモリ使用量は `client_body_buffer_size` で頭打ちになる。

chunked の解析状態は 3 ワードに収まっている ([`src/http/ngx_http.h#L64-L68`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http.h#L64-L68))。`state` が状態機械の現在位置、`size` が今のチャンクの残りバイト数、`length` が「次に最低これだけ読めば前に進める」というヒントだ。

### リクエストボディフィルタチェーン

出力側と同じ形のチェーンが入力側にもある。入口は `ngx_http_top_request_body_filter` で、終端は core モジュールが `postconfiguration` で登録する ([`src/http/ngx_http_core_module.c#L3458-L3466`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_core_module.c#L3458-L3466))。

```c title="src/http/ngx_http_core_module.c"
static ngx_int_t
ngx_http_core_postconfiguration(ngx_conf_t *cf)
{
    ngx_http_top_request_body_filter = ngx_http_request_body_save_filter;

    return NGX_OK;
}
```

既定ビルドではこのチェーンは 1 段しかない。割り込むのはサードパーティモジュール (WAF、ボディ書き換え) を想定した拡張点で、[出力フィルタチェーン](../output-filter-chain/) と違って標準モジュールが誰も使っていない。

チェーンの前段に、フィルタとは呼ばれていない振り分けがある ([`src/http/ngx_http_request_body.c#L990-L999`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_request_body.c#L990-L999))。`r->headers_in.chunked` を見て `ngx_http_request_body_chunked_filter` か `ngx_http_request_body_length_filter` を呼ぶ。どちらも生の受信バッファを「ボディのバイト列だけ」に切り出して `ngx_http_top_request_body_filter` に渡す。[HTTP/1.1 のワイヤ形式](../http1-wire/) にある 2 つの長さ表現が、そのまま 2 つの関数になっている。

## 処理の流れ

### 読む: 入口の 1 行

[`src/http/ngx_http_request_body.c#L31-L228`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_request_body.c#L31-L228)。この関数の最初の実行文が、この層で最も重要な行だ。

```c title="src/http/ngx_http_request_body.c"
ngx_int_t
ngx_http_read_client_request_body(ngx_http_request_t *r,
    ngx_http_client_body_handler_pt post_handler)
{
    /* ... 宣言 ... */

    r->main->count++;

    if (r != r->main || r->request_body || r->discard_body) {
        r->request_body_no_buffering = 0;
        post_handler(r);
        return NGX_OK;
    }
```

**`r->main->count++` が関数の入口にある。** 参照カウンタを 1 つ上げてから、非同期の読み込みを始める。この 1 は、読み込みが終わって `post_handler` を経由し、最終的に `ngx_http_finalize_request()` が呼ばれるまで下がらない。

なぜ入口かというと、**この関数を呼んだ側が「何もせず帰る」ことを許すため**だ。proxy モジュールの実際のコードはこうなっている ([`src/http/modules/ngx_http_proxy_module.c#L970-L976`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/modules/ngx_http_proxy_module.c#L970-L976))。

```c title="src/http/modules/ngx_http_proxy_module.c"
    rc = ngx_http_read_client_request_body(r, ngx_http_upstream_init);

    if (rc >= NGX_HTTP_SPECIAL_RESPONSE) {
        return rc;
    }

    return NGX_DONE;
```

`NGX_DONE` は「このリクエストの面倒は誰か別の主体が見る」の意味で、[コンテンツフェーズ](../phase-engine/) は `finalize` を呼ばずに終わる。

カウントが戻るのはエラーのときだけだ ([`#L223-L225`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_request_body.c#L223-L225))。

```c title="src/http/ngx_http_request_body.c"
    if (rc >= NGX_HTTP_SPECIAL_RESPONSE) {
        r->main->count--;
    }

    return rc;
```

**この非対称が、API を間違えやすくしている。** 呼び出し側は「エラーなら自分でエラー応答を返す」「エラーでなければ何もしない」の 2 通りだけを書く。中間の判断をすると、カウンタが合わなくなってリクエストが解放されないか、二重に解放される。

### 先読み分は `r->header_in` にある

ヘッダを読むために `recv()` を呼んだとき、カーネルはボディの先頭も一緒に返している。TCP に境界が無いからだ。だから最初にやることは、そのバッファを使うことになる ([`#L102-L147`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_request_body.c#L102-L147))。

```c title="src/http/ngx_http_request_body.c"
    preread = r->header_in->last - r->header_in->pos;

    if (preread) {

        /* there is the pre-read part of the request body */

        out.buf = r->header_in;
        out.next = NULL;

        rc = ngx_http_request_body_filter(r, &out);
        /* ... */
        r->request_length += preread - (r->header_in->last - r->header_in->pos);

        if (!r->headers_in.chunked
            && rb->rest > 0
            && rb->rest <= (off_t) (r->header_in->end - r->header_in->last))
        {
            /* the whole request body may be placed in r->header_in */

            b = ngx_calloc_buf(r->pool);
            /* ... */
            b->temporary = 1;
            b->start = r->header_in->pos;
            b->pos = r->header_in->pos;
            b->last = r->header_in->last;
            b->end = r->header_in->end;

            rb->buf = b;
            /* ... */
        }
```

2 段構えになっている。まず先読み分をフィルタチェーンに通す。そのうえで、**残りも `r->header_in` の空き領域に収まるなら、受信バッファを新たに確保せず `r->header_in` をそのまま使う。** 小さい `POST` — フォーム送信や JSON API の大半 — は、この経路でバッファ確保が 1 回も起きない。`client_header_buffer_size` (既定 1 KB) の空きに収まるサイズなら、ボディ用のメモリは 0 バイトで済む。

### 読み込みループ

`ngx_http_do_read_client_request_body()` が本体だ ([`#L294-L462`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_request_body.c#L294-L462))。

```c title="src/http/ngx_http_request_body.c (骨格)"
    for ( ;; ) {
        for ( ;; ) {
            if (rb->rest == 0) { break; }

            if (rb->buf->last == rb->buf->end) {
                /* バッファが満杯: フィルタチェーンを叩いて空けてもらう */
                rc = ngx_http_request_body_filter(r, NULL);
                /* ... */
                if (rb->busy != NULL) {
                    /* まだ空かない: 下流が詰まっている */
                    return NGX_AGAIN;
                }

                rb->buf->pos = rb->buf->start;
                rb->buf->last = rb->buf->start;
            }

            size = rb->buf->end - rb->buf->last;
            rest = rb->rest - (rb->buf->last - rb->buf->pos);

            if ((off_t) size > rest) {
                size = (size_t) rest;
            }

            n = c->recv(c, rb->buf->last, size);

            if (n == NGX_AGAIN) { break; }
            /* ... n == 0 / NGX_ERROR の処理 ... */

            rb->buf->last += n;
            r->request_length += n;

            /* pass buffer to request body filter chain */

            out.buf = rb->buf;
            out.next = NULL;

            rc = ngx_http_request_body_filter(r, &out);
            /* ... */
        }

        if (rb->rest == 0 && rb->last_saved) { break; }

        if (!c->read->ready || rb->rest == 0) {
            ngx_add_timer(c->read, clcf->client_body_timeout);
            /* ... ngx_handle_read_event ... */
            return NGX_AGAIN;
        }
    }
```

`size` の計算に `rest` が効いている。**`Content-Length` を超えて読まない。** 超えて読むと、パイプラインされた次のリクエストの先頭を食ってしまう。

読み終わったら 3 つのことをする ([`#L448-L461`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_request_body.c#L448-L461))。`ngx_http_copy_pipelined_header()` でボディの後ろに紛れ込んだ次のリクエストのバイトを `r->header_in` に移し、読み込みタイマを落とし、`rb->post_handler(r)` を呼ぶ。`rest` で読む量を絞っていても chunked のときは境界が事前に分からないので、はみ出しは起きる。入りきらなければ `large_client_header_buffers` から 1 枚借りてくる ([`#L490-L536`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_request_body.c#L490-L536))。

**同期的に読み切れた場合、`post_handler` はこの関数から直接呼ばれる。** 呼び出し側から見ると、`ngx_http_read_client_request_body()` の中でコールバックが走ったのか、数十ミリ秒後のイベントで走ったのかは区別できない。だから「呼んだら何もせず帰る」という契約が要る。

### 一時ファイルへの退避

保存を担当するのは `ngx_http_request_body_save_filter` だ ([`#L1273-L1387`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_request_body.c#L1273-L1387))。

```c title="src/http/ngx_http_request_body.c"
    if (rb->rest > 0) {

        if (rb->bufs && rb->buf && rb->buf->last == rb->buf->end
            && ngx_http_write_request_body(r) != NGX_OK)
        {
            return NGX_HTTP_INTERNAL_SERVER_ERROR;
        }

        return NGX_OK;
    }

    if (!rb->last_saved) {
        return NGX_OK;
    }

    if (rb->temp_file || r->request_body_in_file_only) {
        /* ... */
        if (ngx_http_write_request_body(r) != NGX_OK) {
            return NGX_HTTP_INTERNAL_SERVER_ERROR;
        }
        /* ... rb->bufs をファイル buf 1 枚に置き換える ... */
    }
```

条件は「まだ読む残りがあり、受信バッファが満杯」。つまり **`client_body_buffer_size` を 1 回でも使い切ったら、そこから先はファイルに落ちる。** ディレクティブの名前は「バッファサイズ」だが、実質は「メモリに収める上限」として働く。

`ngx_http_write_request_body()` が実際に書く ([`#L547-L628`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_request_body.c#L547-L628))。書いた後に `cl->buf->pos = cl->buf->last` でサイズ 0 にするのが要点で、これが `ngx_chain_update_chains()` の「送り終わった」判定と噛み合って buf が `busy` から `free` に戻る。[出力側と同じ規約](../output-filter-chain/) が入力側でも使われている。

読み終わった時点で `rb->bufs` はファイル buf 1 枚に置き換わる。上流に送るとき `ngx_output_chain` がそのファイルを `sendfile()` で流せる。ディスクに書いたものが、カーネル内で上流ソケットへ直行する。

### `client_max_body_size` の検査は 2 箇所ある

`Content-Length` があるときの検査は、ボディを読む前に済んでいる。[location が決まった](../virtual-server-location/) 直後の `ngx_http_core_find_config_phase()` だ ([`src/http/ngx_http_core_module.c#L1009-L1022`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_core_module.c#L1009-L1022))。

```c title="src/http/ngx_http_core_module.c"
    if (r->headers_in.content_length_n != -1
        && !r->discard_body
        && clcf->client_max_body_size
        && clcf->client_max_body_size < r->headers_in.content_length_n)
    {
        ngx_log_error(NGX_LOG_ERR, r->connection->log, 0,
                      "client intended to send too large body: %O bytes",
                      r->headers_in.content_length_n);

        r->expect_tested = 1;
        (void) ngx_http_discard_request_body(r);
        ngx_http_finalize_request(r, NGX_HTTP_REQUEST_ENTITY_TOO_LARGE);
        return NGX_OK;
    }
```

**1 バイトも受け取らずに 413 を返す。** `r->expect_tested = 1` を先に立てているのが要点で、これで `100 Continue` が送られなくなる。クライアントに「送ってよい」と言わないまま拒否する。

chunked では `Content-Length` が無いので、この検査ができない。代わりにチャンクを 1 つ解析するたびに累積を検査する ([`#L1144-L1156`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_request_body.c#L1144-L1156))。

```c title="src/http/ngx_http_request_body.c"
                if (clcf->client_max_body_size
                    && clcf->client_max_body_size
                       - r->headers_in.content_length_n < rb->chunked->size)
                {
                    /* ... ログ ... */
                    r->lingering_close = 1;

                    return NGX_HTTP_REQUEST_ENTITY_TOO_LARGE;
                }
```

引き算の向きが `max - received < size` になっている。`received + size > max` と書くとオーバーフローしうるので、こちらの形にしている。chunked では `r->headers_in.content_length_n` が「これまでに受け取ったボディの累積バイト数」として使われていて、ヘッダに書かれていた値ではない。

`r->lingering_close = 1` が立つのは、**既に受け取ってしまったバイトがあるので、切る前に読み捨てないと RST になる**からだ。この事情は後で扱う。

### chunked の解析は再開可能な状態機械

`ngx_http_parse_chunked()` は 13 状態を持つ ([`src/http/ngx_http_parse.c#L2216-L2238`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_parse.c#L2216-L2238))。`state = ctx->state;` で状態を取り出し、ローカル変数で 1 バイトずつ回し、抜けるときに書き戻す。形は [リクエスト行のパーサ](../request-parse/) とまったく同じで、TCP セグメントがチャンクサイズの途中で切れても続きから再開できる。

特徴的なのは抜け際だ ([`#L2418-L2470`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_parse.c#L2418-L2470))。

```c title="src/http/ngx_http_parse.c"
data:

    ctx->state = state;
    b->pos = pos;

    if (ctx->size > NGX_MAX_OFF_T_VALUE - 9) {
        goto invalid;
    }

    switch (state) {

    case sw_chunk_start:
        ctx->length = 5 /* "0" CRLF CRLF */;
        break;
    case sw_chunk_size:
        ctx->length = 2 /* CRLF */
                      + (ctx->size ? ctx->size + 7 /* CRLF "0" CRLF CRLF */
                                   : 2 /* CRLF */);
        break;
    /* ... 13 状態それぞれの残り最小バイト数 ... */
    }

    return rc;
```

**状態ごとに「ここから最短で終わるには何バイト必要か」を計算して `ctx->length` に置く。** 呼び出し側はこれを `rb->rest` に使い、次に読むバッファサイズを決める ([`ngx_http_request_body.c#L1249-L1250`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_request_body.c#L1249-L1250))。パーサと I/O が、1 つの数値だけで会話している。

chunked filter はもう 1 つ最適化を持っている ([`#L1159-L1180`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_request_body.c#L1159-L1180))。128 バイト以下の小さいチャンクは、新しい buf を作らずに直前の buf に詰め込む。`ngx_chain_t` のリンク 1 個は 16 バイトあるので、10 バイトのチャンクを 1000 個受け取るとリンクだけで 16 KB になる。**小さいチャンクを大量に送るクライアントに対する防御でもある。**

### 捨てる: `ngx_http_discard_request_body()`

捨てるのに 78 行必要な理由は `Connection: keep-alive` にある ([`#L631-L708`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_request_body.c#L631-L708))。構造は「読む」とほぼ同じで、同期的に読み切れれば `NGX_OK` を返し、途中なら状態を残して帰る。

```c title="src/http/ngx_http_request_body.c"
    rc = ngx_http_read_discarded_request_body(r);

    if (rc == NGX_OK) {
        r->lingering_close = 0;
        return NGX_OK;
    }

    if (rc >= NGX_HTTP_SPECIAL_RESPONSE) {
        return rc;
    }

    /* rc == NGX_AGAIN */

    r->read_event_handler = ngx_http_discarded_request_body_handler;

    if (ngx_handle_read_event(rev, 0) != NGX_OK) {
        return NGX_HTTP_INTERNAL_SERVER_ERROR;
    }

    r->count++;
    r->discard_body = 1;

    return NGX_OK;
```

**ここでも参照カウンタが 1 つ上がり、読み捨てが終わるまでリクエストは解放されない。** 読み切れた場合に `r->lingering_close = 0` を落としているのは、「読み切ったならもう lingering は不要」という判断だ。

読み捨て本体は、スタック上の 4096 バイトのバッファに向かって `recv()` するだけだ ([`#L783-L843`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_request_body.c#L783-L843))。

```c title="src/http/ngx_http_request_body.c"
static ngx_int_t
ngx_http_read_discarded_request_body(ngx_http_request_t *r)
{
    size_t     size;
    ssize_t    n;
    ngx_int_t  rc;
    ngx_buf_t  b;
    u_char     buffer[NGX_HTTP_DISCARD_BUFFER_SIZE];

    ngx_memzero(&b, sizeof(ngx_buf_t));

    b.temporary = 1;

    for ( ;; ) {
        if (r->headers_in.content_length_n == 0) { break; }

        if (!r->connection->read->ready) { return NGX_AGAIN; }

        size = (size_t) ngx_min(r->headers_in.content_length_n,
                                NGX_HTTP_DISCARD_BUFFER_SIZE);

        n = r->connection->recv(r->connection, buffer, size);
        /* ... エラー処理 ... */

        b.pos = buffer;
        b.last = buffer + n;

        rc = ngx_http_discard_request_body_filter(r, &b);

        if (rc != NGX_OK) { return rc; }
    }
    /* ... ngx_http_copy_pipelined_header ... */

    r->read_event_handler = ngx_http_block_reading;

    return NGX_OK;
}
```

`ngx_buf_t b` も `buffer[4096]` もスタック上にある。**捨てるだけなので、プールからメモリを取らない。** この関数はイベントごとに何度も呼ばれるので、プールから取っていたらリクエストのプールが際限なく膨らむ。[プールが個別解放を持たない](../memory-pool/) ことの裏返しだ。同じ理由で `ngx_http_discard_request_body_filter()` は buf を確保せず、`b->pos` を進めるだけの小さな chunked パーサを回す ([`#L846-L936`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_request_body.c#L846-L936))。

タイマは `ngx_http_discarded_request_body_handler()` にある ([`#L730-L742`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_request_body.c#L730-L742))。`lingering_time` (既定 30 秒) を過ぎたら読み捨てを諦めて `ngx_http_finalize_request(r, NGX_ERROR)` に落ちる。**捨てるのに永久には付き合わない。** 100 MB のボディを送りながら遅延させてくる相手に、ワーカーのスロットを占有され続けないための上限だ。

`ngx_http_finalize_connection()` の側にも同じタイマを張る経路があり、応答を返し終わったのに読み捨てがまだ終わっていない、という状態がそこで作られる ([リクエストの終了のページ](../finalize-request/))。

### 上流へ流す

`proxy_request_buffering off` のとき、proxy モジュールがフラグを立ててから同じ関数を呼ぶ ([`src/http/modules/ngx_http_proxy_module.c#L962-L968`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/modules/ngx_http_proxy_module.c#L962-L968))。

```c title="src/http/modules/ngx_http_proxy_module.c"
    if (!plcf->upstream.request_buffering
        && plcf->body_values == NULL && plcf->upstream.pass_request_body
        && (!r->headers_in.chunked
            || plcf->http_version == NGX_HTTP_VERSION_11))
    {
        r->request_body_no_buffering = 1;
    }
```

条件が 4 つ付いている。`proxy_set_body` を使っていない、`proxy_pass_request_body on`、そして **クライアントが chunked なら上流も HTTP/1.1 でなければならない**。chunked を再エンコードせず素通しするので、上流が HTTP/1.0 だと長さを伝える手段が無くなる。

`r->request_body_no_buffering` が立つと、`ngx_http_read_client_request_body()` は `done:` ラベルで `NGX_AGAIN` のまま `post_handler` を呼ぶ ([`#L208-L221`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_request_body.c#L208-L221))。つまり **ボディを読み終わる前に `ngx_http_upstream_init` が走る**。以後は upstream 側が `ngx_http_read_unbuffered_request_body()` を呼び、`rb->bufs` から取り出して即座に NULL にする ([`src/http/ngx_http_upstream.c#L2365-L2376`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_upstream.c#L2365-L2376))。溜めないので、ディスクにも落ちない。制御の全体像は [upstream のページ](../upstream/) を参照。

`b->flush = r->request_body_no_buffering` という 1 行が length・chunked 両方のフィルタに入っている ([`#L1061`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_request_body.c#L1061) と [`#L1197`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_request_body.c#L1197))。素通しモードでは全 buf に `flush` が立ち、上流への送信で溜め込みが起きない。

### 100-continue

`Expect: 100-continue` への応答は、`ngx_http_read_client_request_body()` と `ngx_http_discard_request_body()` の入口で 1 回だけ送られる ([`#L939-L987`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_request_body.c#L939-L987))。

```c title="src/http/ngx_http_request_body.c"
    r->expect_tested = 1;
    /* ... "100-continue" との照合 ... */

    n = r->connection->send(r->connection,
                            (u_char *) "HTTP/1.1 100 Continue" CRLF CRLF,
                            sizeof("HTTP/1.1 100 Continue" CRLF CRLF) - 1);

    if (n == sizeof("HTTP/1.1 100 Continue" CRLF CRLF) - 1) {
        return NGX_OK;
    }

    /* we assume that such small packet should be send successfully */

    r->connection->error = 1;

    return NGX_ERROR;
```

**`c->send()` を直接呼んでいる。** [出力フィルタチェーン](../output-filter-chain/) を通らないし、部分送信の再試行もしない。25 バイトなので送信バッファが空いていれば必ず全部入る、という前提で書かれていて、コメントがそれを明示している。`r->expect_tested` が二重送信を防ぐ。この同じフラグを先に立てておくと `100 Continue` が送られなくなる、という性質が 413 の経路で使われていた。

## 守られている不変条件

**`ngx_http_read_client_request_body()` を呼んだ側は、エラー以外では何もせず帰る。** 入口で `r->main->count++` されているので、`ngx_http_finalize_request()` を追加で呼ぶとカウンタが早く 0 に落ちる。逆に `NGX_DONE` を返し忘れると、コンテンツフェーズが勝手に finalize を呼んで、まだ読んでいる最中のリクエストが解放される。

**`post_handler` は必ず 1 回だけ呼ばれる。** 同期的に読み切れたときは `ngx_http_read_client_request_body()` の中から、そうでなければ読み込みイベントの中から。呼び出し側は「どちらで呼ばれたか」を区別できないし、区別してはいけない。

**`rest` を超えて読まない。** パイプラインされた次のリクエストの先頭を食わないため。それでも境界を越えてしまう chunked のために `ngx_http_copy_pipelined_header()` がある。

**`r->discard_body` が立っている間は読み捨てが動いている。** 応答を返した後でも、この間はリクエストを解放できない。`r->count` が 1 つ余分に上がっているので、[終了処理](../finalize-request/) が自動的にそれを守る。

**`Expect: 100-continue` への応答は高々 1 回。** `r->expect_tested` が守る。413 のように「送らせない」ことを選ぶ経路では、フラグを先に立てておく。

**受信バッファは 1 枚しか持たない。** `rb->buf` を使い回し、埋まったら退避してから巻き戻す。ボディのサイズに比例したメモリを取らない、というのがこの層の設計そのものだ。

## つまずきどころ

### 戻り値の意味が 3 通りある

| 戻り値                         | 状況                                          | 呼び出し側              |
| ------------------------------ | --------------------------------------------- | ----------------------- |
| `NGX_OK`                       | 全部読めた。`post_handler` は既に呼ばれた     | `NGX_DONE` を返して帰る |
| `NGX_AGAIN`                    | まだ読んでいる。`post_handler` は後で呼ばれる | `NGX_DONE` を返して帰る |
| `>= NGX_HTTP_SPECIAL_RESPONSE` | エラー。カウンタは戻されている                | その値をそのまま返す    |

`NGX_OK` と `NGX_AGAIN` で振る舞いを変えてはいけない。どちらも「帰る」だ。しかも `request_body_no_buffering` が立っていると `NGX_AGAIN` でも `post_handler` が呼ばれるので、「`NGX_OK` なら呼ばれた、`NGX_AGAIN` ならまだ」という読み方も成立しない。正しい読み方は 1 つで、**エラーかどうか**だけを見る。

### `rest == -1` は「未初期化」

`rb->rest` の初期値は `-1` で、`ngx_pcalloc` の 0 とは別に明示的に代入されている ([`#L77`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_request_body.c#L77))。`length` フィルタと `chunked` フィルタは、どちらも `rb->rest == -1` を見て初期化する。0 だと「もう読み終わった」と区別が付かない。`Content-Length: 0` のリクエストは実在するので、この 2 つを混同できない。同じ「未設定を第 3 の状態で表す」やり方が [設定マージ](../conf-merge/) にもある。

### `filter_need_buffering` は既定では立たない

`rb->filter_need_buffering` は、リクエストボディフィルタチェーンに割り込んだモジュールが「まだ下流に流せない」ときに立てるフラグだ。読み込みループはこれを見て `NGX_AGAIN` を返す ([`#L343-L358`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_request_body.c#L343-L358))。

```c title="src/http/ngx_http_request_body.c"
                    if (rb->filter_need_buffering) {
                        /* ... タイマを張って ... */
                        return NGX_AGAIN;
                    }

                    ngx_log_error(NGX_LOG_ALERT, c->log, 0,
                                  "busy buffers after request body flush");

                    return NGX_HTTP_INTERNAL_SERVER_ERROR;
```

このフラグが無いのに `rb->busy` が残っていると alert が出て 500 になる。既定ビルドではチェーンが `save_filter` 1 段しかなく、`save_filter` は必ず buf を消費するので、この分岐には入らない。**標準モジュールでは到達しない防御コードが、拡張点の契約を明文化している。**

### 捨てるコードを消すと keepalive が壊れる

`ngx_http_discard_request_body()` を呼ばずに応答を返して接続を再利用しようとすると、次のリクエストのパースが前のリクエストのボディから始まる。読み捨てはプロトコルの要請であって、最適化ではない。

もっと悪いのは、読み捨てずに `close()` した場合だ。カーネルの受信キューにデータが残った状態で `close()` すると、TCP は FIN ではなく RST を送る。RST を受けたクライアント側は、**自分の受信バッファに入っている未読データを破棄する**。つまり、送り終わったはずの応答がクライアントに届かない。

だから終了処理は、切る前に読み捨てる経路を持っている。それが lingering close で、[リクエストの終了のページ](../finalize-request/) の主題の 1 つになる。

### HTTP/2・HTTP/3 は別実装

`ngx_http_read_client_request_body()` は先頭で分岐して、HTTP/2 なら `ngx_http_v2_read_request_body()`、HTTP/3 なら `ngx_http_v3_read_request_body()` に投げる ([`#L88-L100`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_request_body.c#L88-L100))。`ngx_http_discard_request_body()` に至っては、HTTP/2 は `r->stream->skip_data = 1` を立てるだけ、HTTP/3 は何もせず `NGX_OK` を返す。

多重化されたストリームではフレーム境界がプロトコルに入っているので、chunked パーサも「読み捨て」も要らない。この層の複雑さのかなりの部分が **HTTP/1.1 のワイヤ形式に起因している**ことが、分岐の短さから読める。

## 関連

- ボディの長さを表す 2 通りの方式は [HTTP/1.1 のワイヤ形式のページ](../http1-wire/)
- 同じ形の状態機械でヘッダを刻む話は [リクエストのパースのページ](../request-parse/)
- `r->main->count` の全体像と読み捨ての終わらせ方は [リクエストの終了のページ](../finalize-request/)
- 素通しモードで上流に流す側は [upstream のページ](../upstream/)
- buf の `busy` / `free` を回す規約は [出力フィルタチェーンのページ](../output-filter-chain/) と [buf と chain のページ](../buf-chain/)
- スタック上のバッファを使う理由は [メモリプールのページ](../memory-pool/)

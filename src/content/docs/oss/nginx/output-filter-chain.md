---
title: "出力の加工を、モジュールが互いを知らないまま連なる片方向リストにする"
description: "gzip も SSI も chunked も、応答を加工するモジュールは全部同じ形をしている。起動時に「今の先頭」を自分の next に控えて、自分を先頭にする。だからチェーンは登録の逆順に組まれ、ビルド時のモジュール順が実行順になる。各フィルタは次が誰かを知らず、リクエストごとの状態は r->ctx に置く。"
sidebar:
  order: 14
---

## 何を学んだか

### どんな状況の話か

応答を返す前にやりたいことがいくつもある。gzip で圧縮する、`Content-Length` が決まらないなら chunked にする、SSI を展開する、文字セットを変換する、`Range` 要求なら一部だけ切り出す、画像をリサイズする、`Set-Cookie` を足す。

これらは組み合わせて使われる。しかも **順序に意味がある**。gzip した後で Range を切り出したらおかしい。chunked にした後で gzip したら二重にエンコードされる。SSI は圧縮前でなければ効かない。

そして、モジュールは互いを知らない。`ngx_http_gzip_filter_module` は SSI モジュールが存在するかどうかを知らないし、知る必要もない。

[フェーズエンジン](../phase-engine/) は「配列に登録して起動時に畳む」形だった。出力側は違う形を採っている。

### Nginx の答え

1. **グローバルな関数ポインタを 2 本用意する。** `ngx_http_top_header_filter` と `ngx_http_top_body_filter`。これがチェーンの入口。
2. **各フィルタは、起動時に「今の先頭」を自分の static 変数に控えてから、自分を先頭にする。** 2 行。
3. **チェーンは片方向リストで、リンクは static 変数。** リクエストごとの状態を持たないので、確保も解放も要らない。
4. **登録の逆順に実行される。** 最初に登録したものが一番奥 (最後に実行される) になる。
5. **順序は `auto/modules` の `ngx_module_order` で決まる。** ビルド時に固定された文字列の並びが、そのまま実行順になる。
6. **各フィルタは「自分に関係あるか」を判定して、無ければ即座に次を呼ぶ。** 関係あるときだけ加工して次に渡す。
7. **リクエストごとの状態は `r->ctx[module.ctx_index]` に置く。** フィルタ自身は状態を持たない。
8. **チェーンの末端は「ソケットに書く」フィルタ。** これだけが `next` を持たない。

## ソースコードのどこか

### 登録は 2 行

`ngx_http_gzip_filter_module` の場合 ([`src/http/modules/ngx_http_gzip_filter_module.c#L1127-L1137`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/modules/ngx_http_gzip_filter_module.c#L1127-L1137))。

```c title="src/http/modules/ngx_http_gzip_filter_module.c"
static ngx_int_t
ngx_http_gzip_filter_init(ngx_conf_t *cf)
{
    ngx_http_next_header_filter = ngx_http_top_header_filter;
    ngx_http_top_header_filter = ngx_http_gzip_header_filter;

    ngx_http_next_body_filter = ngx_http_top_body_filter;
    ngx_http_top_body_filter = ngx_http_gzip_body_filter;

    return NGX_OK;
}
```

これが `postconfiguration` として呼ばれる。`ngx_http_next_header_filter` はこのファイルの static 変数。

**「今の先頭を控えて、自分を先頭にする」だけ。** 単方向リストの先頭挿入そのもので、`next` ポインタの置き場所が static 変数になっているところだけが違う。

全部のフィルタモジュールが、一字一句この形をしている。ヘッダだけ加工するモジュールは前半 2 行だけ、ボディだけなら後半 2 行だけ書く。

チェーンの末端は `ngx_http_write_filter_module` ([`src/http/ngx_http_write_filter_module.c#L365-L371`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_write_filter_module.c#L365-L371))。

```c title="src/http/ngx_http_write_filter_module.c"
static ngx_int_t
ngx_http_write_filter_init(ngx_conf_t *cf)
{
    ngx_http_top_body_filter = ngx_http_write_filter;

    return NGX_OK;
}
```

**`next` を控えていない。** このモジュールは一番最初に初期化されるので、控えるべき先頭がまだ無い。そして実際にチェーンの一番奥にいるので、次を呼ぶこともない。**「終端であること」が、`next` 変数を持たないことで表現されている。**

### 入口

[`src/http/ngx_http_core_module.c#L1874-L1946`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_core_module.c#L1874-L1946)。

```c title="src/http/ngx_http_core_module.c"
ngx_int_t
ngx_http_send_header(ngx_http_request_t *r)
{
    if (r->post_action) {
        return NGX_OK;
    }

    if (r->header_sent) {
        ngx_log_error(NGX_LOG_ALERT, r->connection->log, 0,
                      "header already sent");
        return NGX_ERROR;
    }

    if (r->err_status) {
        r->headers_out.status = r->err_status;
        r->headers_out.status_line.len = 0;
    }

    return ngx_http_top_header_filter(r);
}


ngx_int_t
ngx_http_output_filter(ngx_http_request_t *r, ngx_chain_t *in)
{
    ngx_int_t          rc;
    ngx_connection_t  *c;

    c = r->connection;

    ngx_log_debug2(NGX_LOG_DEBUG_HTTP, c->log, 0,
                   "http output filter \"%V?%V\"", &r->uri, &r->args);

    rc = ngx_http_top_body_filter(r, in);

    if (rc == NGX_ERROR) {
        /* NGX_ERROR may be returned by any filter */
        c->error = 1;
    }

    return rc;
}
```

コンテンツを生成するモジュール ([静的ファイルの例](../buf-chain/) や `proxy_pass`) は `ngx_http_send_header()` と `ngx_http_output_filter()` を呼ぶだけで、その先に何個のフィルタがいるかを知らない。

`r->header_sent` の判定が入口にあるのも意図的で、**二重送信という不変条件の違反を、チェーンに入る前に検出する**。ここを通らずに `ngx_http_top_header_filter` を直接呼ぶモジュールがあると、この検査が効かない。

### フィルタの形

`ngx_http_not_modified_filter_module` が一番短い ([`src/http/modules/ngx_http_not_modified_filter_module.c#L55-L109`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/modules/ngx_http_not_modified_filter_module.c#L55-L109))。

```c title="src/http/modules/ngx_http_not_modified_filter_module.c"
ngx_http_not_modified_header_filter(ngx_http_request_t *r)
{
    if (r->headers_out.status != NGX_HTTP_OK
        || r != r->main
        || r->disable_not_modified)
    {
        return ngx_http_next_header_filter(r);
    }

    if (r->headers_in.if_unmodified_since
        && !ngx_http_test_if_unmodified(r))
    {
        return ngx_http_filter_finalize_request(r, NULL,
                                                NGX_HTTP_PRECONDITION_FAILED);
    }
    /* ... */
    if (r->headers_in.if_modified_since || r->headers_in.if_none_match) {

        if (r->headers_in.if_modified_since
            && ngx_http_test_if_modified(r))
        {
            return ngx_http_next_header_filter(r);
        }
        /* ... */
        /* not modified */

        r->headers_out.status = NGX_HTTP_NOT_MODIFIED;
        r->headers_out.status_line.len = 0;
        r->headers_out.content_type.len = 0;
        ngx_http_clear_content_length(r);
        ngx_http_clear_accept_ranges(r);

        if (r->headers_out.content_encoding) {
            r->headers_out.content_encoding->hash = 0;
            r->headers_out.content_encoding = NULL;
        }

        return ngx_http_next_header_filter(r);
    }

    return ngx_http_next_header_filter(r);
}
```

**関数の出口が全部 `return ngx_http_next_header_filter(r);` になっている。** 早期に判定して抜けるパスも、実際に加工したパスも、最後は次を呼ぶ。加工は `r->headers_out` を書き換えることでやる。

`r != r->main` の判定は「サブリクエストなら何もしない」の意味で、[フェーズエンジン](../phase-engine/) の `ACCESS` checker と同じ形の分岐が出てくる。

このフィルタは 304 を返すときに **既に `ngx_http_send_header()` が呼ばれた後で、ステータスを 200 から 304 に書き換えている**。コンテンツを作るモジュールは 200 のつもりで応答を組み立てているが、フィルタがそれを覆せる。フィルタがヘッダを「加工する」というのは、そこまで含む。

### 加工するフィルタは状態を持つ

gzip や SSI のように、ボディを変換するフィルタには状態が要る。zlib のストリーム、SSI のパース状態、読みかけのバッファ。これらは **リクエストごと** に必要なので、static 変数には置けない。

置き場所が `r->ctx` で、[設定マージのページ](../conf-merge/) の `ctx_index` と同じ添字が使われる。

```c
    ctx = ngx_http_get_module_ctx(r, ngx_http_gzip_filter_module);
```

`r->ctx` は `void *` の配列で、`ngx_http_max_module` 個ある。フィルタは自分の枠に自分の構造体を入れておく。**フィルタ関数自身は完全にステートレスで、状態は全部リクエストにぶら下がっている。**

これが効くのは、[ステートマシン](../state-machine/) だからだ。gzip のボディフィルタは 1 回の呼び出しで全部を圧縮しきれない。下流の書き込みが `NGX_AGAIN` を返せば、途中まで圧縮した状態のまま帰る。次に呼ばれたときに続きから再開する。**状態がリクエストにあるから、それができる。**

### 順序はビルド時に決まる

チェーンの順序は登録の逆順で、登録の順序は `ngx_modules[]` の並び順。それを決めているのが `auto/modules` の `ngx_module_order` だ ([`auto/modules#L148-L176`](https://github.com/nginx/nginx/blob/release-1.31.4/auto/modules#L148-L176))。

```sh title="auto/modules"
    ngx_module_order="ngx_http_static_module \
                      ngx_http_gzip_static_module \
                      ngx_http_dav_module \
                      ngx_http_autoindex_module \
                      ngx_http_index_module \
                      ngx_http_random_index_module \
                      ngx_http_access_module \
                      ngx_http_realip_module \
                      ngx_http_write_filter_module \
                      ngx_http_header_filter_module \
                      ngx_http_chunked_filter_module \
                      ngx_http_v2_filter_module \
                      ngx_http_v3_filter_module \
                      ngx_http_range_header_filter_module \
                      ngx_http_gzip_filter_module \
                      ngx_http_postpone_filter_module \
                      ngx_http_ssi_filter_module \
                      ngx_http_charset_filter_module \
                      ngx_http_xslt_filter_module \
                      ngx_http_image_filter_module \
                      ngx_http_sub_filter_module \
                      ngx_http_addition_filter_module \
                      ngx_http_gunzip_filter_module \
                      ngx_http_userid_filter_module \
                      ngx_http_headers_filter_module \
                      ngx_http_copy_filter_module \
                      ngx_http_range_body_filter_module \
                      ngx_http_not_modified_filter_module \
                      ngx_http_slice_filter_module"
```

**この並びが登録順で、実行順はその逆。** つまり実行順は下から読む。`slice` → `not_modified` → `range_body` → `copy` → `headers` → `userid` → `gunzip` → `addition` → `sub` → `image` → `xslt` → `charset` → `ssi` → `postpone` → `gzip` → `range_header` → `v3` → `v2` → `chunked` → `header` → `write`。

この順序に意味が読み取れる。

- **`not_modified` が最初のほう** = 304 なら以降の加工を全部飛ばせる。
- **`sub` / `ssi` / `charset` が `gzip` より先** = テキストの加工は圧縮前にやる。
- **`gzip` が `chunked` より先** = 圧縮してから chunked に包む。
- **`write` が最後** = 実際にソケットに書くのは一番奥。
- **`postpone` が `gzip` の直前** = [サブリクエスト](../subrequest-postpone/) の出力順序を整えてから圧縮する。

順序を宣言する仕組み (`before:` / `after:`) は無い。**この文字列 1 つが全順序を決めている。** サードパーティモジュールは `--add-module` の順に並ぶが、`config` ファイルに `ngx_module_order` を書けば位置を指定できる。

### 終端フィルタ

`ngx_http_write_filter` ([`src/http/ngx_http_write_filter_module.c#L47-L362`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_write_filter_module.c#L47-L362)) は、チェーンの中で唯一「次を呼ばない」フィルタで、やることも他と違う。

```c title="src/http/ngx_http_write_filter_module.c"
    size = 0;
    flush = 0;
    sync = 0;
    last = 0;
    ll = &r->out;

    /* find the size, the flush point and the last link of the saved chain */

    for (cl = r->out; cl; cl = cl->next) {
        ll = &cl->next;
        /* ... デバッグログと検証 ... */
        size += ngx_buf_size(cl->buf);

        if (cl->buf->flush || cl->buf->recycled) {
            flush = 1;
        }

        if (cl->buf->sync) {
            sync = 1;
        }

        if (cl->buf->last_buf) {
            last = 1;
        }
    }

    /* add the new chain to the existent one */

    for (ln = in; ln; ln = ln->next) {
        cl = ngx_alloc_chain_link(r->pool);
        /* ... */
        cl->buf = ln->buf;
        *ll = cl;
        ll = &cl->next;
        /* ... 同じ集計を新しいぶんにも ... */
    }
```

**`r->out` に前回送り残したチェーンが残っていて、そこに新しいぶんを繋ぐ。** [buf のページ](../buf-chain/) の `ngx_chain_add_copy` と同じ形で、リンクだけを新しく作って buf は共有する。

集計しているのは 4 つ。合計サイズ、`flush` 点があるか、`sync` があるか、`last_buf` があるか。この 4 つで、送るか送らないかが決まる ([`#L213-L221`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_write_filter_module.c#L213-L221))。

```c title="src/http/ngx_http_write_filter_module.c"
    /*
     * avoid the output if there are no last buf, no flush point,
     * there are the incoming bufs and the size of all bufs
     * is smaller than "postpone_output" directive
     */

    if (!last && !flush && in && size < (off_t) clcf->postpone_output) {
        return NGX_OK;
    }
```

**溜まりが `postpone_output` (既定 1460 バイト = 1 MSS) 未満で、終わりでもフラッシュ点でもなければ、書かずに `NGX_OK` を返す。** 小さい write を繰り返してパケットを細切れにしないための、ユーザー空間の Nagle アルゴリズムになっている。

`last_buf` や `flush` があれば無視して送る。**「まだ来る」と「これで終わり」を buf のフラグで伝える** 仕組みが、ここで効いている。

送信は `c->send_chain()` ([`#L299`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_write_filter_module.c#L299))。

```c title="src/http/ngx_http_write_filter_module.c"
    chain = c->send_chain(c, r->out, limit);
    /* ... */
    if (chain == NGX_CHAIN_ERROR) {
        c->error = 1;
        return NGX_ERROR;
    }
    /* ... */
    for (cl = r->out; cl && cl != chain; /* void */) {
        ln = cl;
        cl = cl->next;
        ngx_free_chain(r->pool, ln);
    }

    r->out = chain;

    if (chain) {
        c->buffered |= NGX_HTTP_WRITE_BUFFERED;
        return NGX_AGAIN;
    }

    c->buffered &= ~NGX_HTTP_WRITE_BUFFERED;
```

`send_chain` は「送りきれなかった残り」を返す。**送れたぶんのリンクをプールに返して、残りを `r->out` に置き直す。** 残りがあれば `NGX_AGAIN` で、`c->buffered` にビットを立てる。このビットが「まだ書くものが残っている」を上位に伝える。

`limit_rate` の実装もここにある ([`#L263-L292`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_write_filter_module.c#L263-L292))。

```c title="src/http/ngx_http_write_filter_module.c"
        limit = (off_t) r->limit_rate * (ngx_time() - r->start_sec + 1)
                - (c->sent - r->limit_rate_after);

        if (limit <= 0) {
            c->write->delayed = 1;
            delay = (ngx_msec_t) (- limit * 1000 / r->limit_rate + 1);
            ngx_add_timer(c->write, delay);

            c->buffered |= NGX_HTTP_WRITE_BUFFERED;

            return NGX_AGAIN;
        }
```

**「今までに送ってよかった量」から「実際に送った量」を引いて、余裕があればそのぶんだけ送る。** マイナスならタイマを張って `NGX_AGAIN`。[タイマのページ](../timer-rbtree/) の仕組みがそのまま使われている。

帯域制限が終端フィルタにあるのは自然で、**加工後の実際のバイト数を制限したい**からだ。gzip の前で制限しても意味がない。

書き残しがあるときの再開の仕掛けも面白い ([`#L334-L336`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_write_filter_module.c#L334-L336))。

```c title="src/http/ngx_http_write_filter_module.c"
    if (chain && c->write->ready && !c->write->delayed) {
        ngx_post_event(c->write, &ngx_posted_next_events);
    }
```

**残りがあって、しかもまだ書ける状態なら、次のループで自分をもう一度起こす。** `sendfile_max_chunk` や `limit` で途中で切り上げた場合がこれに当たる。[ステートマシンのページ](../state-machine/) の `ngx_posted_next_events` が「1 周譲る」ために使われている実例だ。

### フィルタの中でエラーが起きたら

ヘッダを送った後にフィルタがエラーを見つけると厄介なことになる。`ngx_http_finalize_request(r, 500)` を呼ぶと、既に送ったヘッダの後ろにエラーページの HTML が付く。

専用の関数がある ([`src/http/ngx_http_special_response.c#L536-L572`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_special_response.c#L536-L572))。

```c title="src/http/ngx_http_special_response.c"
ngx_http_filter_finalize_request(ngx_http_request_t *r, ngx_module_t *m,
    ngx_int_t error)
{
    void       *ctx;
    ngx_int_t   rc;

    ngx_http_clean_header(r);

    ctx = NULL;

    if (m) {
        ctx = r->ctx[m->ctx_index];
    }

    /* clear the modules contexts */
    ngx_memzero(r->ctx, sizeof(void *) * ngx_http_max_module);

    if (m) {
        r->ctx[m->ctx_index] = ctx;
    }

    r->filter_finalize = 1;

    rc = ngx_http_special_response_handler(r, error);

    /* NGX_ERROR resets any pending data */

    switch (rc) {

    case NGX_OK:
    case NGX_DONE:
        return NGX_ERROR;

    default:
        return rc;
    }
}
```

**全モジュールの `r->ctx` をゼロクリアして、呼び出し元のモジュールのぶんだけ復元する。** チェーンの途中まで進んだ状態を捨てて、エラー応答を最初から組み立て直すためだ。呼び出し元だけ残すのは、その関数から戻った後にまだ自分の ctx を触るから。

`r->filter_finalize = 1` が立つと、[`ngx_http_finalize_request`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_request.c#L2683) が `r->out` に溜まった送信待ちを捨てる。コメントの "NGX_ERROR resets any pending data" がそれを指している。

**ヘッダ送信済みの状態からエラーに転ぶという、チェーン構造に固有の問題**に対する専用の出口が用意されている。フィルタチェーンを持つシステムには必ず出てくる問題で、それを認めて名前を付けている点が実務的だ。

## なぜそうなっているか

### なぜ配列ではなくリンクリストか

[フェーズエンジン](../phase-engine/) は配列で、フィルタはリンクリスト。同じ拡張機構なのに形が違う。

違いは **「次を呼ぶかどうかをフィルタが決める」** ところにある。フェーズは checker が `r->phase_handler` を進めるので、コアが制御を握っている。フィルタは各自が `return ngx_http_next_header_filter(r);` を書くので、**制御を握っているのはフィルタ自身**だ。

これで何ができるかというと、**次を呼ぶ前と後の両方で処理を書ける**。

```c
    /* 次を呼ぶ前: リクエストの加工 */
    rc = ngx_http_next_body_filter(r, out);
    /* 次を呼んだ後: 結果を見ての後処理 */
    return rc;
```

gzip のボディフィルタは、圧縮したチェーンを次に渡し、返ってきた `NGX_AGAIN` を見て「下流が詰まっている」と判断して圧縮を止める。配列を舐める形だと、この「戻ってくる」が表現できない。

コールスタックが深くなる代償を払っている。フィルタが 20 個あればスタックが 20 段積まれる。それでも、**下流の状態を見て自分の振る舞いを変えられる**ことのほうが重要だった。

### 「今の先頭を控えて自分を先頭にする」の副作用

この登録方法は、**登録順と実行順が逆になる**。`auto/modules` の並びを読むときに毎回逆から読まないといけない。

なぜ逆順で登録するのか。順方向にするには「末尾を探して繋ぐ」か「末尾へのポインタを別に持つ」必要があって、どちらも 2 行では書けない。**登録が 2 行で済むことを優先している。**

そして実際、慣れると `auto/modules` の並びは「上ほど奥」と読める。`ngx_http_write_filter_module` が上のほうにあるのは一番奥だからで、それは自然でもある。

### 状態を `r->ctx` に置くことの意味

フィルタ関数が static 変数を持てないので、状態はリクエストに置くしかない。これは制約から来ているが、結果として **フィルタ関数が完全にリエントラントになる**。

同じ接続の上で複数のリクエストが走る HTTP/2 でも、同じフィルタ関数が問題なく動く。リクエストが違えば `r->ctx` が違うからだ。もし static 変数に状態を置いていたら、[HTTP/2 のページ](../http2-multiplexing/) の「既存のコードに触らずに多重化を載せる」は成立しなかった。

`r->ctx` が `ngx_http_max_module` 個の配列であることも効いている。**フィルタが自分の状態を確保するのは、初めて必要になったときでいい。** 使わないモジュールのぶんは `NULL` のまま。

### `postpone_output` はユーザー空間の Nagle

`TCP_NODELAY` を立てると、カーネルは小さいパケットもすぐ送る。レイテンシは下がるが、ヘッダだけ 200 バイト送って、次にボディの 100 バイトを送る、という形になるとパケットが無駄に増える。

`postpone_output` は **アプリケーション層で溜める** ことでこれを避ける。カーネルの Nagle と違うのは、**「これで終わり」を知っているから、待つべきでないときは待たない** ところだ。`last_buf` が立っていれば即座に送る。カーネルは終わりを知らないので、タイマが切れるまで待つしかない。

**アプリケーションだけが持っている情報 (ストリームの終わり) を使うと、汎用の仕組みより良い判断ができる。** これは buf に `last_buf` フラグがあるからできることで、[buf のページ](../buf-chain/) の「終端をストリーム内の値として表す」が効いている。

### 順序をビルド時に固定することの代償

`ngx_module_order` の文字列 1 つが全順序を決めている。実行時に変えられない。設定で「このロケーションでは gzip を SSI の前に」とは書けない。

これは制約だが、**順序が固定だからこそ、各フィルタが他のフィルタを前提にできる**。`gzip` フィルタは、自分より上流に `chunked` がいることを前提に、`Content-Length` を消して構わない。順序が動的だと、この前提が置けなくなる。

サードパーティモジュールの順序問題は実際に起きる。`--add-module` の順を変えると挙動が変わるのは、[フェーズエンジンのページ](../phase-engine/) で書いたのと同じ弱点だ。`config` ファイルで `ngx_module_order` を指定できるようになってはいるが、書くのは難しい。

## どう活かすか

### そのまま真似できるところ

**加工の連鎖は、「次を呼ぶ」形にする。** 配列を舐める形と違って、次の呼び出しの前後に処理を書ける。下流の結果を見て自分の振る舞いを変えられる。ミドルウェアが `next()` を呼ぶ形 (Express、Rack、ASP.NET Core) は全部これで、Nginx のフィルタチェーンはその C 版になっている。

**登録は「先頭に挿す」1 パターンに絞る。** 2 行で済むので、書き間違えようがない。逆順になる副作用は、ドキュメントに書けば済む。

**加工する側を完全にステートレスにして、状態はコンテキストに持たせる。** 同じ関数が複数のリクエストを同時に処理できるようになる。後から多重化や並行実行を入れるときに効く。

**チェーンの終端を、「次を持たない」ことで表現する。** 終端フラグも、`if (next == NULL)` も要らない。

**「まだ来る」と「これで終わり」を、データと同じ経路で流す。** `last_buf` / `flush` があるから、終端フィルタが「今送るべきか」を正しく判断できる。バッファリングの判断は、ストリームの終わりを知っているかどうかで質が変わる。

**チェーンの途中でエラーになったときの出口を、専用に用意する。** 「すでに一部を下流に渡した後で失敗した」は、パイプライン構造に固有の問題で、通常のエラー処理では扱えない。名前を付けて、状態のリセット範囲を明示する。

**入口に不変条件の検査を置く。** `r->header_sent` の判定が `ngx_http_send_header()` にある。チェーンの各要素に置くのではなく、入口に 1 つ置けば済む。

### 取り込むべきでない条件

**深いチェーンはスタックを消費する。** フィルタ 20 個 + サブリクエストの入れ子で、C のスタックはそれなりに積まれる。フィルタの中で大きなローカル変数を取ると危ない。再帰の深さが読めない構造なので、各段を薄く保つ規律が要る。

**ビルド時に順序を固定するのは、モジュールが少ないうちだけ現実的。** サードパーティが増えると、`ngx_module_order` を正しく書ける人がいなくなる。実行時に順序を決められる仕組みを入れるなら、依存の宣言と検証まで含めて設計する。

**グローバルな関数ポインタは、テストしにくい。** `ngx_http_top_body_filter` はプロセスに 1 つしかないので、チェーンを差し替えた状態でユニットテストを書く、ということができない。実際 Nginx にはフィルタ単体のテストが無く、`nginx-tests` の結合テストで担保している。同じ構造を作るなら、チェーンをオブジェクトにしてテストで差し替えられるようにしたい。

**「次を呼ぶ」の書き忘れは静かに壊れる。** 早期 return のパスで `return ngx_http_next_header_filter(r);` を書き忘れると、下流のフィルタが全部飛ばされる。コンパイラは何も言わない。Nginx のフィルタが「全部の出口が next 呼び出し」という形に揃っているのは、レビューで気づけるようにするためでもある。

## 関連

- チェーンを流れる `ngx_chain_t` と `ngx_buf_t` は [buf と chain のページ](../buf-chain/)。
- 入力側の拡張点は配列になっている。[フェーズエンジンのページ](../phase-engine/)。
- `postpone_filter` がなぜこの位置にいるかは [サブリクエストのページ](../subrequest-postpone/)。
- `c->send_chain` の実体と、そこで行われる `iovec` へのまとめ方は [buf と chain のページ](../buf-chain/)。

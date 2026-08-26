---
title: "上流からの応答を全部受け取ってから返すのをやめ、埋まった端から下流へ流す"
description: "リバースプロキシは 2 本のソケットを同時に扱う。上流が速くて下流が遅ければ、どこかに溜める必要がある。Nginx は上流への通信を「意図を組み立てる関数ポインタ 6 本」に抽象化し、応答の中継を event_pipe という双方向のループに任せる。バッファが尽きたときの逃げ道が 4 通り用意されていて、最後は一時ファイルに落ちる。"
sidebar:
  order: 16
---

## 何を学んだか

### どんな状況の話か

リバースプロキシは、クライアントと上流サーバの間に立つ。ソケットが 2 本あり、**両方が独立に読めたり書けたりする**。しかも速度が違う。上流は同じデータセンターにいて 10Gbps、クライアントはモバイル回線で 1Mbps、ということが普通にある。

素朴に書くと「上流から全部読んで、それからクライアントに書く」になる。これだと 100MB の応答で 100MB のメモリを使う。逆に「1 バイト読んだら 1 バイト書く」にすると、上流のコネクションを遅いクライアントに合わせて長時間占有することになる。上流が PHP-FPM のようなプロセスプールなら、それは致命的だ。

そして [ステートマシン](../state-machine/) なので、どちらのソケットも `NGX_AGAIN` を返しうる。「上流から読んでいる途中で、下流が書けるようになった」という状態を扱えなければならない。

さらに Nginx は、proxy / FastCGI / uwsgi / SCGI / gRPC / memcached を同じ枠組みで扱う。プロトコルが全部違う。

### Nginx の答え

1. **プロトコル依存の部分を、関数ポインタ 6 本に切り出す。** `create_request` / `reinit_request` / `process_header` / `input_filter` / `abort_request` / `finalize_request`。`ngx_http_upstream_t` の残りは全プロトコル共通。
2. **上流との通信も、リクエストと同じ二段のハンドラで表す。** `c->read->handler` は `ngx_http_upstream_handler` 固定、`u->read_event_handler` が状態に応じて差し替わる。
3. **応答の中継に 2 つのモードを持つ。** バッファリングあり (`ngx_event_pipe`) と、なし (`ngx_http_upstream_process_non_buffered_request`)。
4. **`ngx_event_pipe` は「書く → 読む」を交互に回すループ。** どちらかが進まなくなるまで回して、進まなくなったらイベントを再登録して帰る。
5. **バッファが尽きたときの逃げ道が 4 段。** 空きバッファを使う → 新しく確保する → 下流が書けるならそちらに流す → 一時ファイルに落とす。それも無理なら読むのをやめる。
6. **`busy_size` で「下流に渡したまま返ってこないバッファ」の量を制限する。** これを超えたら、上流から読まずに下流への書き出しを優先する。
7. **バッファリングなしのモードは、1 枚のバッファを read と write で共有する。** 溜めないのでメモリは固定。

## ソースコードのどこか

### プロトコル依存部分の切り出し

[`src/http/ngx_http_upstream.h#L342-L400`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_upstream.h#L342-L400)。

```c title="src/http/ngx_http_upstream.h"
struct ngx_http_upstream_s {
    ngx_http_upstream_handler_pt     read_event_handler;
    ngx_http_upstream_handler_pt     write_event_handler;

    ngx_peer_connection_t            peer;

    ngx_event_pipe_t                *pipe;

    ngx_chain_t                     *request_bufs;

    ngx_output_chain_ctx_t           output;
    ngx_chain_writer_ctx_t           writer;
    /* ... */
    ngx_buf_t                        buffer;
    off_t                            length;
    /* ... */
    ngx_chain_t                     *out_bufs;
    ngx_chain_t                     *busy_bufs;
    ngx_chain_t                     *free_bufs;

    ngx_int_t                      (*input_filter_init)(void *data);
    ngx_int_t                      (*input_filter)(void *data, ssize_t bytes);
    void                            *input_filter_ctx;
    /* ... */
    ngx_int_t                      (*create_request)(ngx_http_request_t *r);
    ngx_int_t                      (*reinit_request)(ngx_http_request_t *r);
    ngx_int_t                      (*process_header)(ngx_http_request_t *r);
    void                           (*abort_request)(ngx_http_request_t *r);
    void                           (*finalize_request)(ngx_http_request_t *r,
                                         ngx_int_t rc);
    ngx_int_t                      (*rewrite_redirect)(ngx_http_request_t *r,
                                         ngx_table_elt_t *h, size_t prefix);
    ngx_int_t                      (*rewrite_cookie)(ngx_http_request_t *r,
                                         ngx_table_elt_t *h);
```

**プロトコルごとに違うのは、この関数ポインタ群だけ。** `ngx_http_proxy_module` は `create_request` で HTTP のリクエスト行とヘッダを組み立て、`ngx_http_fastcgi_module` は FastCGI のレコードを組み立てる。それ以外 (接続、再試行、タイムアウト、キャッシュ、負荷分散、バッファ管理) は共通のコードが担当する。

`create_request` の返り値は `ngx_chain_t` ではなく、`u->request_bufs` に置く。**[buf のページ](../buf-chain/) のチェーンをそのまま組み立てて置いておく**ので、送信は `ngx_output_chain()` + `ngx_chain_writer()` の共通コードに任せられる。

`reinit_request` が別にあるのは、**再試行のため**。上流 A がエラーを返したら B に繋ぎ直すが、そのとき `request_bufs` を先頭から送り直さなければならない。プロトコルによって「巻き戻す」対象が違うので、専用のフックになっている。

### 上流の状態遷移

[`src/http/ngx_http_upstream.c#L1316-L1346`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_upstream.c#L1316-L1346)。

```c title="src/http/ngx_http_upstream.c"
ngx_http_upstream_handler(ngx_event_t *ev)
{
    ngx_connection_t     *c;
    ngx_http_request_t   *r;
    ngx_http_upstream_t  *u;

    c = ev->data;
    r = c->data;

    u = r->upstream;
    c = r->connection;

    ngx_http_set_log_request(c->log, r);
    /* ... */
    if (ev->write) {
        u->write_event_handler(r, u);

    } else {
        u->read_event_handler(r, u);
    }

    ngx_http_run_posted_requests(c);
}
```

[ステートマシンのページ](../state-machine/) の `ngx_http_request_handler` と同じ形をしている。**接続レベルの handler は固定で、その中で状態に応じた handler に振り分ける。**

面白いのは `c` の付け替えだ。入ってきた `ev->data` は **上流への接続**で、そこから `r` を取り出したら、`c = r->connection` で **下流の接続**に上書きしている。以降のログや `ngx_http_run_posted_requests()` は下流の接続を基準にする。**「リクエストの本体はクライアント側の接続であって、上流はその付属物」** という位置づけが、この 2 行に表れている。

接続直後に handler が設定される ([`#L1644-L1657`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_upstream.c#L1644-L1657))。

```c title="src/http/ngx_http_upstream.c"
    c = u->peer.connection;

    c->requests++;

    c->data = r;

    c->write->handler = ngx_http_upstream_handler;
    c->read->handler = ngx_http_upstream_handler;

    u->write_event_handler = ngx_http_upstream_send_request_handler;
    u->read_event_handler = ngx_http_upstream_process_header;

    c->sendfile &= r->connection->sendfile;
    u->output.sendfile = c->sendfile;
```

`c->sendfile &= r->connection->sendfile` が地味に効いていて、**上流と下流の両方が `sendfile` を使えるときだけ有効にする**。片方が SSL なら落ちる。

`ngx_event_connect_peer()` の返り値の扱いも語彙が豊富だ ([`#L1598-L1642`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_upstream.c#L1598-L1642))。

```c title="src/http/ngx_http_upstream.c"
    rc = ngx_event_connect_peer(&u->peer);
    /* ... */
    if (rc == NGX_ERROR) {
        ngx_http_upstream_finalize_request(r, u,
                                           NGX_HTTP_INTERNAL_SERVER_ERROR);
        return;
    }
    /* ... */
    if (rc == NGX_BUSY) {
        ngx_log_error(NGX_LOG_ERR, r->connection->log, 0, "no live upstreams");
        ngx_http_upstream_next(r, u, NGX_HTTP_UPSTREAM_FT_NOLIVE);
        return;
    }

    if (rc == NGX_DECLINED) {
        ngx_http_upstream_next(r, u, NGX_HTTP_UPSTREAM_FT_ERROR);
        return;
    }

    /* rc == NGX_OK || rc == NGX_AGAIN || rc == NGX_DONE */
```

5 種類の返り値が全部違う意味を持つ。`NGX_ERROR` は諦める、`NGX_BUSY` は「生きているピアが無い」、`NGX_DECLINED` は「このピアがダメだったので次へ」、`NGX_OK` は即座に接続完了、`NGX_AGAIN` は接続中、`NGX_DONE` はキープアライブの再利用 ([接続の再利用のページ](../connection-reuse/))。

**`NGX_BUSY` と `NGX_DECLINED` を分けている**のが実務的で、前者はログに `"no live upstreams"` を出す。運用でこのメッセージを見たことがある人は多いはずで、その出どころがここになる。

上流の接続には専用のプールが作られる ([`#L1663-L1673`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_upstream.c#L1663-L1673))。

```c title="src/http/ngx_http_upstream.c"
    if (c->pool == NULL) {

        /* we need separate pool here to be able to cache SSL connections */

        c->pool = ngx_create_pool(128, r->connection->log);
```

**上流の接続はリクエストより長生きしうる** (keepalive で使い回す) ので、`r->pool` から取るわけにいかない。[メモリプールのページ](../memory-pool/) の「プールを選ぶことが寿命の宣言」がここに出ている。128 バイトという小ささも、「ほとんど何も入らない」ことを示している。

### バッファリングありの中継

ヘッダを読み終わると `ngx_http_upstream_send_response()` が呼ばれる。ここでモードが分岐する ([`#L3284-L3394`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_upstream.c#L3284-L3394))。

```c title="src/http/ngx_http_upstream.c"
    rc = ngx_http_send_header(r);

    if (rc == NGX_ERROR || rc > NGX_OK || r->post_action) {
        ngx_http_upstream_finalize_request(r, u, rc);
        return;
    }

    u->header_sent = 1;
```

**まず下流にヘッダを送ってしまう。** ボディが 1 バイトも来ていなくても送る。`proxy_buffering on` でもここは同じで、ヘッダは常に即座に転送される。

バッファリングありなら `ngx_event_pipe_t` を組み立てる ([`#L3490-L3602`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_upstream.c#L3490-L3602))。

```c title="src/http/ngx_http_upstream.c"
    p = u->pipe;

    p->output_filter = ngx_http_upstream_output_filter;
    p->output_ctx = r;
    p->tag = u->output.tag;
    p->bufs = u->conf->bufs;
    p->busy_size = u->conf->busy_buffers_size;
    p->upstream = u->peer.connection;
    p->downstream = c;
    p->pool = r->pool;
    p->log = c->log;
    p->limit_rate = ngx_http_complex_value_size(r, u->conf->limit_rate, 0);
    p->start_sec = ngx_time();

    p->cacheable = u->cacheable || u->store;

    p->temp_file = ngx_pcalloc(r->pool, sizeof(ngx_temp_file_t));
    /* ... */
    } else {
        p->temp_file->log_level = NGX_LOG_WARN;
        p->temp_file->warn = "an upstream response is buffered "
                             "to a temporary file";
    }

    p->max_temp_file_size = u->conf->max_temp_file_size;
    p->temp_file_write_size = u->conf->temp_file_write_size;
```

`"an upstream response is buffered to a temporary file"` は運用でよく見る警告で、**一時ファイルの構造体に警告文字列を持たせておいて、実際にファイルを作るときに出す**という作りになっている。

そして、ヘッダと一緒に読んでしまったボディの先頭部分を pipe に渡す ([`#L3543-L3581`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_upstream.c#L3543-L3581))。

```c title="src/http/ngx_http_upstream.c"
    p->preread_bufs = ngx_alloc_chain_link(r->pool);
    /* ... */
    p->preread_bufs->buf = &u->buffer;
    p->preread_bufs->next = NULL;
    u->buffer.recycled = 1;

    p->preread_size = u->buffer.last - u->buffer.pos;
    /* ... */
    /*
     * event_pipe would do u->buffer.last += p->preread_size
     * as though these bytes were read
     */
    u->buffer.last = u->buffer.pos;
```

**「もう読んであるバイト列」を「これから読むもの」の形に偽装している。** `u->buffer.last` を巻き戻しておいて、pipe 側が普通に読んだかのように進める。特別扱いの分岐を入れる代わりに、データの形を揃えている。

### 双方向のループ

`ngx_event_pipe()` ([`src/event/ngx_event_pipe.c#L29-L58`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/ngx_event_pipe.c#L29-L58))。

```c title="src/event/ngx_event_pipe.c"
    for ( ;; ) {
        if (do_write) {
            p->log->action = "sending to client";

            rc = ngx_event_pipe_write_to_downstream(p);

            if (rc == NGX_ABORT) {
                return NGX_ABORT;
            }

            if (rc == NGX_BUSY) {
                return NGX_OK;
            }
        }

        p->read = 0;
        p->upstream_blocked = 0;

        p->log->action = "reading upstream";

        if (ngx_event_pipe_read_upstream(p) == NGX_ABORT) {
            return NGX_ABORT;
        }

        if (!p->read && !p->upstream_blocked) {
            break;
        }

        do_write = 1;
    }
```

**「書く → 読む」を、進まなくなるまで交互に回す。** 終了条件は「何も読めず、上流もブロックしていない」。

`p->read` と `p->upstream_blocked` の 2 つで判定しているのが要点で、`upstream_blocked` は「バッファが尽きたので下流に流す必要がある」を意味する。読めていなくても、下流に流せば空きが作れるならもう 1 周する。

`p->log->action` の付け替えも実務的で、この文字列はエラーログの `while ...` の部分に出る。**タイムアウトしたときに「クライアントに送信中」だったのか「上流から読み取り中」だったのかが、ログから分かる。**

ループを抜けたら、イベントを再登録してタイマを張り直す ([`#L60-L100`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/ngx_event_pipe.c#L60-L100))。

```c title="src/event/ngx_event_pipe.c"
    if (p->upstream
        && p->upstream->fd != (ngx_socket_t) -1)
    {
        rev = p->upstream->read;

        flags = (rev->eof || rev->error) ? NGX_CLOSE_EVENT : 0;

        if (ngx_handle_read_event(rev, flags) != NGX_OK) {
            return NGX_ABORT;
        }

        if (!rev->delayed) {
            if (rev->active && !rev->ready) {
                ngx_add_timer(rev, p->read_timeout);

            } else if (rev->timer_set) {
                ngx_del_timer(rev);
            }
        }
    }
```

**「登録済みでまだ読めない」ときだけタイマを張り、「読める」ならタイマを消す。** 待っている時間だけタイムアウトを数えるという、正しい形になっている。同じことを下流の write に対してもやる。

### バッファが尽きたときの 4 段の逃げ道

`ngx_event_pipe_read_upstream()` の中心 ([`#L224-L310`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/ngx_event_pipe.c#L224-L310))。

```c title="src/event/ngx_event_pipe.c"
            if (p->free_raw_bufs) {

                /* use the free bufs if they exist */

                chain = p->free_raw_bufs;
                if (p->single_buf) {
                    p->free_raw_bufs = p->free_raw_bufs->next;
                    chain->next = NULL;
                } else {
                    p->free_raw_bufs = NULL;
                }

            } else if (p->allocated < p->bufs.num) {

                /* allocate a new buf if it's still allowed */

                b = ngx_create_temp_buf(p->pool, p->bufs.size);
                if (b == NULL) {
                    return NGX_ABORT;
                }

                p->allocated++;
                /* ... chain を作る ... */

            } else if (!p->cacheable
                       && p->downstream->data == p->output_ctx
                       && p->downstream->write->ready
                       && !p->downstream->write->delayed)
            {
                /*
                 * if the bufs are not needed to be saved in a cache and
                 * a downstream is ready then write the bufs to a downstream
                 */

                p->upstream_blocked = 1;

                ngx_log_debug0(NGX_LOG_DEBUG_EVENT, p->log, 0,
                               "pipe downstream ready");

                break;

            } else if (p->cacheable
                       || p->temp_file->offset < p->max_temp_file_size)
            {

                /*
                 * if it is allowed, then save some bufs from p->in
                 * to a temporary file, and add them to a p->out chain
                 */

                rc = ngx_event_pipe_write_chain_to_temp_file(p);
                /* ... */
            } else {

                /* there are no bufs to read in */

                ngx_log_debug0(NGX_LOG_DEBUG_EVENT, p->log, 0,
                               "no pipe bufs to read in");

                break;
            }

            n = p->upstream->recv_chain(p->upstream, chain, limit);
```

**4 段の if-else が、そのままメモリ圧の逃げ方の優先順位になっている。**

1. **空きバッファがあれば使う。** 下流に送り終わって返ってきたもの。
2. **まだ確保していいなら確保する。** `proxy_buffers 8 4k;` の 8 個まで。
3. **下流が今すぐ書けるなら、書きに行く。** `upstream_blocked = 1` を立てて `break` すると、外側のループが `do_write = 1` で書き出しに回る。
4. **一時ファイルに落とす。** `proxy_max_temp_file_size` (既定 1GB) まで。

どれもダメなら「読まない」。上流の TCP 受信バッファが埋まり、ウィンドウが閉じ、上流が送るのをやめる。**フロー制御をカーネルに押し返している。**

3 番目の条件に `p->downstream->data == p->output_ctx` があるのが重要で、これは「この接続で今出力してよいのは自分か」を確認している。[サブリクエストのページ](../subrequest-postpone/) の話につながる。

`recv_chain` を使っているので、**複数のバッファを 1 回の `readv()` で埋められる**。[buf のページ](../buf-chain/) の `iovec` へのまとめが読み側にもある。

### 送信中のバッファ量を制限する

`ngx_event_pipe_write_to_downstream()` ([`#L603-L679`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/ngx_event_pipe.c#L603-L679))。

```c title="src/event/ngx_event_pipe.c"
        /* bsize is the size of the busy recycled bufs */

        prev = NULL;
        bsize = 0;

        for (cl = p->busy; cl; cl = cl->next) {

            if (cl->buf->recycled) {
                if (prev == cl->buf->start) {
                    continue;
                }

                bsize += cl->buf->end - cl->buf->start;
                prev = cl->buf->start;
            }
        }
        /* ... */
        if (bsize >= (size_t) p->busy_size) {
            flush = 1;
            goto flush;
        }
```

`p->busy` は「下流に渡したがまだ送り終わっていない」チェーン。その合計サイズが `busy_size` (`proxy_busy_buffers_size`、既定でバッファ 2 個ぶん) を超えたら、**新しいバッファを渡すのをやめて、今あるものを吐き出すことに専念する**。

`prev == cl->buf->start` で同じ実体を数え重ねないようにしているのが、[buf のページ](../buf-chain/) の `shadow` の話につながる。1 枚の生バッファから切り出された複数の buf が `busy` に並ぶので、**実体のサイズは 1 回だけ数える**。

`recycled` フラグが「これは使い回すバッファだ」の印になっている。一時ファイルから読んだ buf は `recycled` ではないので、この計算に入らない。

上流が終わったときの処理が対照的だ ([`#L539-L556`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/ngx_event_pipe.c#L539-L556))。

```c title="src/event/ngx_event_pipe.c"
        if (p->upstream_eof || p->upstream_error || p->upstream_done) {

            /* pass the p->out and p->in chains to the output filter */

            for (cl = p->busy; cl; cl = cl->next) {
                cl->buf->recycled = 0;
            }

            if (p->out) {
                /* ... */
                for (cl = p->out; cl; cl = cl->next) {
                    cl->buf->recycled = 0;
                }

                rc = p->output_filter(p->output_ctx, p->out);
```

**上流が終わったら `recycled` を全部落とす。** もう読むことがないので、バッファを使い回す必要がない。`busy_size` の制限も無意味になる。残っているものを一気に下流へ渡す。

フラグを落とすことで制限が自動的に無効になる、という書き方になっていて、「終了モードかどうか」の分岐をあちこちに書かずに済んでいる。

### バッファリングなしのモード

`proxy_buffering off;` のときは pipe を使わない ([`src/http/ngx_http_upstream.c#L3968-L4039`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_upstream.c#L3968-L4039))。

```c title="src/http/ngx_http_upstream.c"
    b = &u->buffer;

    do_write = do_write || u->length == 0;

    for ( ;; ) {

        if (do_write) {

            if (u->out_bufs || u->busy_bufs || downstream->buffered) {
                rc = ngx_http_output_filter(r, u->out_bufs);

                if (rc == NGX_ERROR) {
                    ngx_http_upstream_finalize_request(r, u, NGX_ERROR);
                    return;
                }

                ngx_chain_update_chains(r->pool, &u->free_bufs, &u->busy_bufs,
                                        &u->out_bufs, u->output.tag);
            }

            if (u->busy_bufs == NULL) {

                if (u->length == 0
                    || (upstream->read->eof && u->length == -1))
                {
                    ngx_http_upstream_finalize_request(r, u, 0);
                    return;
                }
                /* ... エラー判定 ... */
                b->pos = b->start;
                b->last = b->start;
            }
        }

        size = b->end - b->last;

        if (size && upstream->read->ready) {

            n = upstream->recv(upstream, b->last, size);

            if (n == NGX_AGAIN) {
                break;
            }

            if (n > 0) {
                u->state->bytes_received += n;
                u->state->response_length += n;

                if (u->input_filter(u->input_filter_ctx, n) == NGX_ERROR) {
                    ngx_http_upstream_finalize_request(r, u, NGX_ERROR);
                    return;
                }
            }

            do_write = 1;

            continue;
        }

        break;
    }
```

**バッファは `u->buffer` の 1 枚だけ。** 読んで、`input_filter` でチェーンに切り出して、下流に流して、全部送り終わったら (`u->busy_bufs == NULL`) バッファを先頭に巻き戻して再利用する。

`ngx_event_pipe` と同じ「書く → 読む」の交互ループだが、**バッファの管理がまるごと無い**。溜められないので、下流が遅ければ上流を待たせるしかない。

構造としてはこちらのほうが単純で、pipe の複雑さがそのまま「溜める」ことのコストになっている。

`u->length` が「あと何バイト来るはずか」で、`-1` は「分からない」(chunked や `Connection: close` の場合)。`length == 0` で正常終了、`read->eof && length == -1` でも正常終了、`read->eof && length > 0` なら `"upstream prematurely closed connection"`。**3 つの終了条件が明示的に書き分けられている。**

## なぜそうなっているか

### 6 本の関数ポインタが「プロトコルの違い」を全部吸収する

proxy / FastCGI / uwsgi / SCGI / gRPC / memcached の 6 モジュールが、`ngx_http_upstream_t` の同じ枠組みに乗っている。共通コードが担当するのは、接続、SSL、再試行、負荷分散、タイムアウト、キャッシュ、バッファ管理、一時ファイル、レート制限。**プロトコルごとに書くのは「バイト列の組み立て」と「バイト列の解釈」だけ。**

これが成立するのは、**リバースプロキシの仕事のうち、プロトコル固有の部分が実は少ない**からだ。切り口の見つけ方として学ぶところがある。「HTTP プロキシ」「FastCGI プロキシ」と縦に切ると共通部分が重複するが、「バイト列の変換」と「中継の制御」で横に切ると、後者が全部共通になる。

`input_filter` の契約も巧妙で、「今 `u->buffer` に `bytes` バイト増えたので、`u->out_bufs` に下流へ出すぶんを積め」という形になっている。HTTP なら素通し、chunked なら chunk ヘッダを除去、gRPC なら HTTP/2 フレームを剥がす。**「何バイト読んだか」だけを渡して、解釈は各自に任せる。**

### バッファリングありとなしを両方持つ理由

`proxy_buffering on` (既定) は **上流を早く解放する**。100MB の応答なら、上流からは全速力で受け取って一時ファイルに落とし、クライアントには時間をかけて送る。上流のワーカーは早く次のリクエストに移れる。

`proxy_buffering off` は **レイテンシと逐次性を優先する**。SSE や長いストリーミング応答では、溜められると意味がない。

両方を実装するコストは大きい (`ngx_event_pipe.c` が 1000 行、非バッファ版が 200 行)。それでも両方あるのは、**この 2 つが本質的に違う要求だから**だ。片方をもう片方のパラメータ (バッファサイズ 0) として表現しようとすると、どちらも中途半端になる。

### 4 段の逃げ道は、優先順位の宣言になっている

「メモリが足りない」に対する対処を、コストの安い順に並べてある。

1. 空きの再利用 (コスト 0)
2. 新規確保 (メモリを消費)
3. 下流へ流す (syscall、ただしメモリが空く)
4. ディスクへ落とす (syscall + ディスク I/O)
5. 読むのをやめる (上流を待たせる)

**この順序が `if-else` の並びとしてそのまま読める**のが、この関数の一番良いところだ。どの条件で何が起きるかが、設定値 (`proxy_buffers` / `proxy_max_temp_file_size`) と 1 対 1 に対応する。

そして最後の逃げ道が「何もしない」であることに意味がある。**フロー制御を TCP に押し返す**という選択肢を最後に置いておけば、どんな場合でも破綻しない。無理にメモリを確保しに行かない。

### `busy_size` は「渡したまま返ってこない」を測る

下流への `ngx_http_output_filter()` は、[出力フィルタチェーン](../output-filter-chain/) を通って `ngx_http_write_filter` に行き着く。そこで送り切れなければ `r->out` に溜まる。溜まったぶんのバッファは、pipe から見ると「渡したまま返ってこない」状態になる。

これを放置すると、`proxy_buffers` で確保したバッファが全部下流側に滞留して、上流から読むぶんが無くなる。`busy_size` はその上限を決めている。

既定値がバッファ 2 個ぶんなのは、**「1 個を送信中、1 個を次に送る準備」で十分**という判断だろう。多くしても下流の送信速度は上がらず、上流から読むためのバッファが減るだけになる。

### `recycled` フラグを落とすことで制限を解除する

上流が終わったときに `recycled = 0` を一括で立てる (落とす) のは、**「もう使い回さないバッファ」を宣言する**ことで `busy_size` の計算から除外する仕掛けだ。

「終了モードなら制限しない」という `if` をあちこちに書く代わりに、**制限の計算対象を決めるフラグを 1 箇所で落とす**。フラグの意味 (「使い回す予定のバッファ」) が、そのまま「制限の対象」の定義になっているので、この操作が自然に読める。

### `preread_bufs` はデータの形を揃えるための偽装

ヘッダを読むときに、ボディの先頭も一緒に受信バッファに入ってしまう。これを pipe に渡す方法は 2 つある。特別なフィールドとして持って `read_upstream` に分岐を足すか、「これから読むバッファ」の形にして普通に処理させるか。

Nginx は後者で、`u->buffer.last` を巻き戻して「まだ読んでいないことにする」。`p->preread_size` を渡しておくので、pipe 側は `recv()` を呼ぶ代わりにその値を使う。

**新しいケースを追加するのではなく、既存のケースに合流させる。** 分岐が増えない代わりに、少し嘘をついている (`u->buffer.last` が実際のデータ量と一致しない期間がある)。コメントで明示してあるのがせめてもの誠実さだ。

## どう活かすか

### そのまま真似できるところ

**プロトコル依存の部分を「バイト列の組み立て」と「バイト列の解釈」に絞り込む。** 中継・再試行・タイムアウト・負荷分散は、プロトコルに依存しない。この切り方ができると、対応プロトコルを増やすコストが劇的に下がる。

**メモリ圧への対処を、コストの安い順に並べた `if-else` として書く。** 再利用 → 確保 → 押し出す → 退避 → 諦める。この並び自体がドキュメントになる。

**最後の逃げ道を「何もしない」にする。** 読むのをやめれば TCP のウィンドウが閉じ、送信側が止まる。バックプレッシャーを下位層に押し返す設計は、どんな負荷でも破綻しない。gRPC や HTTP/2 のフロー制御、リアクティブストリームの `request(n)` も同じ思想になっている。

**in-flight のデータ量に上限を設ける。** 「渡したがまだ完了していない」を測って制限する。非同期の中継では、これが無いとメモリが片側に偏る。

**制限の解除を、フラグを落とすことで表す。** 「終了モードなら制限しない」を各所の `if` に書くのではなく、制限の計算対象を決めるフラグを 1 箇所で操作する。

**待っている間だけタイムアウトを数える。** 「イベント登録済みでまだ準備できていない」ときだけタイマを張り、準備できたら消す。素朴に「処理開始からの経過時間」でタイムアウトすると、正常に進んでいる転送を切ってしまう。

**エラーログに「何をしていたか」を残す。** `p->log->action` を "sending to client" と "reading upstream" で切り替える。タイムアウトの原因切り分けが、ログ 1 行でできるようになる。

**再試行のための「巻き戻し」を、最初から契約に入れる。** `reinit_request` が独立したフックとして存在するのは、後付けでは入れにくい。上流を切り替える可能性があるなら、「送信内容を再生成できる」を最初から前提にする。

### 取り込むべきでない条件

**`ngx_event_pipe.c` の複雑さは、そのまま「溜める」ことのコスト。** 1000 行のうち大半が、バッファの状態遷移と一時ファイルへの退避に費やされている。溜める必要が本当にあるかを先に問う。非バッファ版が 200 行で済んでいることが、その差を示している。

**`shadow` と `recycled` と `busy` の絡み合いは、追いにくい。** 1 枚の生バッファから切り出された複数の buf が、`in` / `out` / `busy` / `free` / `free_raw_bufs` の 5 本のリストを行き来する。Nginx のコードで最も読みにくい部分の 1 つで、実際バグの報告も出ている。同じことをするなら、参照カウントを持たせるほうが素直になる。

**`u->buffer.last` を巻き戻す種類の「偽装」は、コメントが無いと事故になる。** 短期的には分岐が減って綺麗に見えるが、その構造体を触る他のコードが前提を壊しうる。

**一時ファイルへの退避は、ディスクを圧迫する。** `proxy_max_temp_file_size` の既定が 1GB で、同時接続が多いと合計が跳ね上がる。「メモリが足りなければディスク」は無条件に安全な逃げ道ではない。

## 関連

- pipe が扱う buf のフラグ (`recycled` / `shadow` / `last_shadow`) は [buf と chain のページ](../buf-chain/)。
- `p->output_filter` から先は [出力フィルタチェーンのページ](../output-filter-chain/)。
- `p->downstream->data == p->output_ctx` の判定の意味は [サブリクエストのページ](../subrequest-postpone/)。
- `ngx_event_connect_peer()` が `NGX_DONE` を返す経路は [接続の再利用のページ](../connection-reuse/)。

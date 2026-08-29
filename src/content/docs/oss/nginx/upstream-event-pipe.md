---
title: "上流からの応答を全部受け取ってから返すのをやめ、埋まった端から下流へ流す"
description: "`ngx_event_pipe_t` は 2 本のソケットの間に立ち、`read_upstream` と `write_to_downstream` を交互に回す。バッファが尽きたときの逃げ道が 4 段あり、最後は一時ファイルに落ちる。1 枚の生バッファを複数の出力 buf が参照するので、解放は `shadow` のリンクをたどって行われる。`in` / `out` / `busy` / `free` / `free_raw_bufs` の 5 本のチェーンと 12 個のフラグが、この 1146 行を動かしている。"
group: "骨格: プロキシとして"
sidebar:
  order: 25
---

## この層の責務

リバースプロキシは 2 本のソケットを同時に扱う。上流は同じデータセンターにいて 10Gbps、クライアントはモバイル回線で 1Mbps、ということが普通にある。速度差をどこかで吸収しなければならない。

素朴に「上流から全部読んでからクライアントに書く」と、100MB の応答で 100MB のメモリを使う。逆に「1 バイト読んだら 1 バイト書く」にすると、上流の接続を遅いクライアントに合わせて長時間占有する。上流が PHP-FPM のようなプロセスプールなら、それは致命的だ。

`src/event/ngx_event_pipe.c` の 1146 行が、この 2 つの間を埋める。責務は 3 つに絞られている。

- **上流から読めるだけ読み、下流へ書けるだけ書く。** どちらも `NGX_AGAIN` を返しうるので、進まなくなるまで交互に回す。
- **溜める場所を段階的に用意する。** 空きバッファ、新規確保、一時ファイル。どれも尽きたら読むのをやめる。
- **バッファの寿命を管理する。** 下流に渡したバッファはすぐには再利用できない。

やらないことも明確で、**プロトコルを知らない**。HTTP のチャンクを剥がすのも FastCGI のレコードを剥がすのも `p->input_filter` の仕事で、pipe 自身は「埋まった生バッファ」を渡すだけになっている。下流への書き出しも `p->output_filter` に委ねられていて、それが [出力フィルタチェーン](../output-filter-chain/) の入口を叩く。

`ngx_http_upstream_t` からどう呼ばれるかは [upstream](../upstream/) を参照。ここでは pipe の内側だけを見る。

## 主要な型とその関係

### `ngx_event_pipe_t`

[`src/event/ngx_event_pipe.h#L25-L99`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/ngx_event_pipe.h#L25-L99)。74 行、フィールドは 40 個ある。役割ごとに全部並べるとこうなる。

| 分類         | フィールド                                                  | 意味                                                                    |
| ------------ | ----------------------------------------------------------- | ----------------------------------------------------------------------- |
| ソケット     | `upstream` / `downstream`                                   | 2 本の `ngx_connection_t`                                               |
| チェーン     | `free_raw_bufs`                                             | 受信に使える生バッファ                                                  |
|              | `in` / `last_in`                                            | `input_filter` が積んだ、下流へ出すべき buf                             |
|              | `out`                                                       | 一時ファイルに書き出した領域を指す buf                                  |
|              | `busy`                                                      | 下流に渡したが送り終わっていない buf                                    |
|              | `free`                                                      | 再利用できる chain link と buf の殻                                     |
|              | `writing`                                                   | スレッドで一時ファイルに書き込み中の buf                                |
| フィルタ     | `input_filter` / `input_ctx`                                | 生バッファ 1 枚を `in` に変換する                                       |
|              | `output_filter` / `output_ctx`                              | `in` や `out` を下流へ渡す                                              |
|              | `thread_handler` / `thread_ctx` / `thread_task`             | 一時ファイル書き込みをスレッドに逃がす                                  |
| フラグ       | `read`                                                      | この周回で 1 バイトでも読めたか                                         |
|              | `cacheable`                                                 | 応答をキャッシュまたは保存するか                                        |
|              | `single_buf` / `free_bufs`                                  | 1 回の `recv_chain` で 1 枚だけ使う / 生バッファを `ngx_pfree` してよい |
|              | `upstream_done` / `upstream_error` / `upstream_eof`         | 上流側の終了理由 3 種                                                   |
|              | `upstream_blocked`                                          | バッファが尽きたので下流に流す必要がある                                |
|              | `downstream_done` / `downstream_error`                      | 下流側の終了                                                            |
|              | `cyclic_temp_file` / `aio`                                  | 一時ファイルを巻き戻して使い回す / 非同期 I/O が飛んでいる最中          |
| バッファ量   | `allocated` / `bufs` / `tag`                                | 確保済み枚数、`proxy_buffers` の値、どのモジュールの buf か             |
|              | `busy_size`                                                 | `busy` にあってよい総バイト数の上限                                     |
| 進捗         | `read_length` / `length`                                    | 読んだ総バイト数と、あと何バイト要るか                                  |
| 一時ファイル | `max_temp_file_size` / `temp_file_write_size` / `temp_file` | 上限、1 回の書き込み量、実体                                            |
| タイムアウト | `read_timeout` / `send_timeout` / `send_lowat`              | 上流の読み、下流の書き                                                  |
| 先読み       | `preread_bufs` / `preread_size`                             | ヘッダと一緒に読んでしまったボディ                                      |
| キャッシュ   | `buf_to_file`                                               | キャッシュファイルの先頭に書くヘッダ部分                                |
| レート制限   | `limit_rate` / `start_sec`                                  | `proxy_limit_rate`                                                      |
| その他       | `pool` / `log` / `num`                                      |                                                                         |

### 5 本のチェーンを行き来する

チェーンが 5 本あるのは、**1 枚の生バッファが 3 つの状態を同時に持ちうる**からだ。「受信に使える」「下流に出したい中身が入っている」「下流に渡して返事待ち」は、同じメモリ領域に対する別の見方になる。

```mermaid
flowchart LR
    FR["free_raw_bufs 受信に使える生バッファ"] -->|recv_chain| RAW["生バッファが埋まる"]
    RAW -->|input_filter| IN["p.in 出力用 buf を shadow で紐付け"]
    IN -->|output_filter| BUSY["p.busy 下流へ渡して送信待ち"]
    IN -->|溢れたら| TMP["一時ファイルへ書き出し"]
    TMP --> OUT["p.out ファイル参照の buf"]
    OUT -->|output_filter| BUSY
    BUSY -->|送信完了| FREE["p.free 再利用プール"]
    FREE -->|last_shadow なら| FR
```

一時ファイル経由の枝があるので、**`out` と `in` の両方が「下流へ出すもの」を持ちうる**。`out` のほうが先に読み出されるので、順序は保たれる。

### shadow buffer

`p->input_filter` は生バッファを**コピーしない**。`ngx_buf_t` の殻だけを新しく取り、中身を丸ごと写して、双方向のリンクを張る。

```c title="src/event/ngx_event_pipe.c#L983-L995 (ngx_event_pipe_copy_input_filter)"
    cl = ngx_chain_get_free_buf(p->pool, &p->free);
    if (cl == NULL) {
        return NGX_ERROR;
    }

    b = cl->buf;

    ngx_memcpy(b, buf, sizeof(ngx_buf_t));
    b->shadow = buf;
    b->tag = p->tag;
    b->last_shadow = 1;
    b->recycled = 1;
    buf->shadow = b;
```

`b` が出力用の buf、`buf` が生バッファ。`b->shadow` が生バッファを指し、`buf->shadow` が `b` を指す。**`b->pos` と `b->last` は生バッファのメモリを直接指しているので、`b` を下流に渡している間はその生バッファを再利用できない。** `last_shadow` が「このリンクの終端」を意味し、`recycled` が「使い回すバッファだ」の印になる。

chunked のときはもっと入り組む。1 枚の生バッファから複数のチャンクが切り出され、それが `b->shadow` で数珠つなぎになる。

```c title="src/http/modules/ngx_http_proxy_module.c#L2271-L2299 (ngx_http_proxy_chunked_filter)"
    prev = &buf->shadow;

    for ( ;; ) {

        rc = ngx_http_parse_chunked(r, buf, &ctx->chunked,
                                    plcf->upstream.pass_trailers);

        if (rc == NGX_OK) {

            /* a chunk has been parsed successfully */

            cl = ngx_chain_get_free_buf(p->pool, &p->free);
            /* ... */
            b->pos = buf->pos;
            b->start = buf->start;
            b->end = buf->end;
            b->tag = p->tag;
            b->temporary = 1;
            b->recycled = 1;

            *prev = b;
            prev = &b->shadow;
```

そして最後の 1 枚だけが `b->shadow = buf` と `b->last_shadow = 1` を持つ ([`#L2381-L2384`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/modules/ngx_http_proxy_module.c#L2381-L2384))。できあがる形は `buf->shadow -> b1 -> b2 -> ... -> bn`、そして `bn->shadow == buf`。**片方向リストの終端が起点に戻る**。解放はこのリストをたどる。

```c title="src/event/ngx_event_pipe.c#L1028-L1056"
    b = buf->shadow;

    if (b == NULL) {
        return;
    }

    while (!b->last_shadow) {
        next = b->shadow;

        b->temporary = 0;
        b->recycled = 0;

        b->shadow = NULL;
        b = next;
    }

    b->temporary = 0;
    b->recycled = 0;
    b->last_shadow = 0;

    b->shadow = NULL;
    buf->shadow = NULL;
```

**参照カウントを持たず、リストの終端まで到達したことで「全部解放された」とみなす。** `last_shadow` が 1 枚だけに立っているという不変条件に、まるごと寄りかかっている。

生バッファを再利用リストに戻すのは `ngx_event_pipe_add_free_buf`。

```c title="src/event/ngx_event_pipe.c#L1082-L1104"
    if (p->free_raw_bufs == NULL) {
        p->free_raw_bufs = cl;
        cl->next = NULL;
        return NGX_OK;
    }

    if (p->free_raw_bufs->buf->pos == p->free_raw_bufs->buf->last) {

        /* add the free buf to the list start */

        cl->next = p->free_raw_bufs;
        p->free_raw_bufs = cl;
        return NGX_OK;
    }

    /* the first free buf is partially filled, thus add the free buf after it */

    cl->next = p->free_raw_bufs->next;
    p->free_raw_bufs->next = cl;
```

**先頭が部分的に埋まっているバッファなら、その次に入れる。** `free_raw_bufs` の先頭は「まだ書き足せる場所」でなければならないという約束があり、それを崩さないための 3 分岐になっている。

## 処理の流れ

### `ngx_event_pipe()` — 書くと読むを交互に回す

[`src/event/ngx_event_pipe.c#L22-L100`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/ngx_event_pipe.c#L22-L100)。関数の骨格はループ 1 つだけだ。

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

**終了条件は「何も読めず、上流もブロックしていない」。** `p->read` は「この周回で 1 バイトでも読めたか」、`p->upstream_blocked` は「バッファが尽きたので下流に流したい」を意味する。読めていなくても、下流に流せば空きが作れるならもう 1 周する。

`do_write` の初期値は呼び出し側が決める。上流の読みイベントから来たときは 0、下流の書きイベントから来たときは 1 になる。

```c title="src/http/ngx_http_upstream.c#L4340 と #L4386"
        if (ngx_event_pipe(p, 1) == NGX_ABORT) {   /* process_downstream */
        if (ngx_event_pipe(p, 0) == NGX_ABORT) {   /* process_upstream */
```

`p->log->action` の付け替えも効いていて、この文字列はエラーログの `while ...` の部分に出る。**タイムアウトしたときに「クライアントに送信中」だったのか「上流から読み取り中」だったのかが、ログ 1 行で分かる。**

ループを抜けたら、イベントを登録し直してタイマを張る。

```c title="src/event/ngx_event_pipe.c#L60-L79"
    if (p->upstream && p->upstream->fd != (ngx_socket_t) -1) {
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

**「登録済みでまだ読めない」ときだけタイマを張り、「読める」ならタイマを消す。** 待っている時間だけをタイムアウトとして数える形になっている。同じことを下流の write に対しても行う ([`#L81-L97`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/ngx_event_pipe.c#L81-L97))。ただし下流側には `p->downstream->data == p->output_ctx` という条件が付いていて、これは [サブリクエスト](../subrequest-postpone/) が絡む。

### `ngx_event_pipe_read_upstream()` — バッファをどこから取るか

[`src/event/ngx_event_pipe.c#L103-L502`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/ngx_event_pipe.c#L103-L502)。400 行あるが、中心は「受信先のバッファを決める」分岐にある。

まず先読みぶんの特別扱い。

```c title="src/event/ngx_event_pipe.c#L149-L166"
        if (p->preread_bufs == NULL && !p->upstream->read->ready) {
            break;
        }

        if (p->preread_bufs) {

            /* use the pre-read bufs if they exist */

            chain = p->preread_bufs;
            p->preread_bufs = NULL;
            n = p->preread_size;
            /* ... */
            if (n) {
                p->read = 1;
            }

        } else {
```

`preread_bufs` があるときは `recv_chain` を呼ばず、`n = p->preread_size` としてそのまま先に進む。**「もう読んであるバイト列」を「たった今読んだバイト列」に化けさせている。** 仕込みは呼び出し側にある。

```c title="src/http/ngx_http_upstream.c#L3543-L3581"
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

`u->buffer.last` を巻き戻して「まだ読んでいないことにする」。特別扱いの分岐を `read_upstream` の中に増やす代わりに、データの形を揃えている。

`preread_bufs` が無いときに、受信先を決める 4 段の分岐が走る。

```c title="src/event/ngx_event_pipe.c#L224-L312"
            if (p->free_raw_bufs) {

                /* use the free bufs if they exist */

                chain = p->free_raw_bufs;
                /* ... single_buf なら 1 枚だけ切り出す ... */

            } else if (p->allocated < p->bufs.num) {

                /* allocate a new buf if it's still allowed */

                b = ngx_create_temp_buf(p->pool, p->bufs.size);
                /* ... */
                p->allocated++;

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
                chain = p->free_raw_bufs;

            } else {

                /* there are no bufs to read in */
                break;
            }

            n = p->upstream->recv_chain(p->upstream, chain, limit);
```

**この if-else の並びが、そのままメモリ圧の逃げ方の優先順位になっている。**

1. **空きバッファを使う。** 下流に送り終わって返ってきたもの。コストは 0。
2. **まだ確保していいなら確保する。** `proxy_buffers 8 4k;` の 8 枚まで。
3. **下流が今すぐ書けるなら、書きに行く。** `upstream_blocked = 1` を立てて `break` すると、外側のループが `do_write = 1` で書き出しに回る。
4. **一時ファイルに落とす。** `proxy_max_temp_file_size` (既定 1GB) まで。落としたぶんの生バッファが `free_raw_bufs` に戻ってくるので、それを使う。

どれもダメなら読まない。上流の TCP 受信バッファが埋まり、ウィンドウが閉じ、上流が送るのをやめる。**フロー制御をカーネルに押し返している。**

3 番目に `p->cacheable` の否定が入っているのが重要で、**キャッシュするときは下流へ逃がす手が使えない**。キャッシュファイルは連続したバイト列として完成させる必要があるので、下流に流して捨てるわけにいかない。だから `cacheable` のときは 4 番目に落ちる。

`recv_chain` を使っているので、複数のバッファを 1 回の `readv()` で埋められる ([buf-chain](../buf-chain/))。

### `input_filter` はいつ呼ばれるか

読んだあとの後処理に、見落としやすい仕掛けがある。

```c title="src/event/ngx_event_pipe.c#L349-L373"
        while (cl && n > 0) {

            ngx_event_pipe_remove_shadow_links(cl->buf);

            size = cl->buf->end - cl->buf->last;

            if (n >= size) {
                cl->buf->last = cl->buf->end;

                /* STUB */ cl->buf->num = p->num++;

                if (p->input_filter(p, cl->buf) == NGX_ERROR) {
                    return NGX_ABORT;
                }

                n -= size;
                ln = cl;
                cl = cl->next;
                ngx_free_chain(p->pool, ln);

            } else {
                cl->buf->last += n;
                n = 0;
            }
        }
```

**`input_filter` が呼ばれるのは、バッファが端まで埋まったときだけ。** 途中までしか埋まらなかったバッファは `free_raw_bufs` に戻され、次の受信で書き足される。

だから、部分的にしか埋まっていないデータを下流へ出す経路が別に要る。それが 2 つある。

```c title="src/event/ngx_event_pipe.c#L448-L487"
    if (p->free_raw_bufs && p->length != -1) {
        cl = p->free_raw_bufs;

        if (cl->buf->last - cl->buf->pos >= p->length) {

            p->free_raw_bufs = cl->next;
            p->input_filter(p, cl->buf);
            ngx_free_chain(p->pool, cl);
        }
    }

    if (p->length == 0) {
        p->upstream_done = 1;
        p->read = 1;
    }

    if ((p->upstream_eof || p->upstream_error) && p->free_raw_bufs) {
        p->input_filter(p, p->free_raw_bufs->buf);
        p->free_raw_bufs = p->free_raw_bufs->next;
        /* ... free_bufs なら未使用の生バッファを ngx_pfree ... */
    }
```

「残り `p->length` バイトが揃った」ときと、「上流が終わった」ときだ。**`proxy_buffering on` で応答が下流に出るタイミングは、バッファが 1 枚埋まるか、応答が終わるか、のどちらかになる。** 中途半端に溜まっている状態では出ない。これがバッファリングの実体で、SSE のようなストリーミングが `proxy_buffering on` で止まって見える理由になる。

最後にキャッシュ用の書き出しが入る。

```c title="src/event/ngx_event_pipe.c#L489-L499"
    if (p->cacheable && (p->in || p->buf_to_file)) {

        ngx_log_debug0(NGX_LOG_DEBUG_EVENT, p->log, 0,
                       "pipe write chain");

        rc = ngx_event_pipe_write_chain_to_temp_file(p);

        if (rc != NGX_OK) {
            return rc;
        }
    }
```

**キャッシュするときは、読むたびに毎回一時ファイルへ書く。** メモリが逼迫していなくても書く。同じパイプの中でキャッシュファイルが組み立てられていくので、完成したら `ngx_ext_rename_file` で所定の場所に移すだけでよい ([file-cache](../file-cache/))。

### `ngx_event_pipe_write_to_downstream()` — 送信中の量を測る

[`src/event/ngx_event_pipe.c#L505-L738`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/ngx_event_pipe.c#L505-L738)。まず `busy` にあるバッファの合計サイズを数える。

```c title="src/event/ngx_event_pipe.c#L603-L628"
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

`p->busy` は「下流に渡したがまだ送り終わっていない」チェーン。合計が `busy_size` (`proxy_busy_buffers_size`、既定でバッファ 2 枚ぶん) を超えたら、**新しいバッファを渡すのをやめて、今あるものを吐き出すことに専念する**。

`prev == cl->buf->start` の判定が shadow の話に直結している。1 枚の生バッファから切り出された複数の buf が `busy` に並ぶので、**実体のサイズを 1 回だけ数える**。`recycled` が立っていない buf は数えない。一時ファイルから読んだ buf は `recycled` ではないので、この計算に入らない。

上流が終わったときの処理が対照的だ。

```c title="src/event/ngx_event_pipe.c#L539-L556"
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

**上流が終わったら `recycled` を全部落とす。** もう読むことがないのでバッファを使い回す必要がなく、`busy_size` の制限も無意味になる。フラグを落とすことで制限が自動的に無効になるので、「終了モードかどうか」の分岐をあちこちに書かずに済んでいる。

書き出したあとの後始末で、生バッファが `free_raw_bufs` に戻る。

```c title="src/event/ngx_event_pipe.c#L698-L734"
        rc = p->output_filter(p->output_ctx, out);

        ngx_chain_update_chains(p->pool, &p->free, &p->busy, &out, p->tag);
        /* ... */
        for (cl = p->free; cl; cl = cl->next) {

            if (cl->buf->temp_file) {
                if (p->cacheable || !p->cyclic_temp_file) {
                    continue;
                }

                /* reset p->temp_offset if all bufs had been sent */

                if (cl->buf->file_last == p->temp_file->offset) {
                    p->temp_file->offset = 0;
                }
            }

            /* add the free shadow raw buf to p->free_raw_bufs */

            if (cl->buf->last_shadow) {
                if (ngx_event_pipe_add_free_buf(p, cl->buf->shadow) != NGX_OK) {
                    return NGX_ABORT;
                }

                cl->buf->last_shadow = 0;
            }

            cl->buf->shadow = NULL;
        }
```

`ngx_chain_update_chains` が「送り終わった buf」を `busy` から `free` に移す。そのうえで **`last_shadow` が立っているものだけ**、対応する生バッファを `free_raw_bufs` に返す。1 枚の生バッファから 5 個の buf を切り出したなら、返すのは 5 個目を送り終わったときの 1 回だけになる。

`cyclic_temp_file` が立っているときは、一時ファイルの中身を全部送り終わったら `offset` を 0 に戻して先頭から書き直す。ディスク使用量を抑えるための仕掛けだが、代償として `sendfile` が切られる。

```c title="src/http/ngx_http_upstream.c#L3583-L3596"
    if (u->conf->cyclic_temp_file) {

        /*
         * we need to disable the use of sendfile() if we use cyclic temp file
         * because the writing a new data may interfere with sendfile()
         * that uses the same kernel file pages (at least on FreeBSD)
         */

        p->cyclic_temp_file = 1;
        c->sendfile = 0;

    } else {
        p->cyclic_temp_file = 0;
    }
```

**同じカーネルのページを `sendfile()` が読んでいる最中に上書きする**という危険を、機能を切ることで避けている。

### 一時ファイルへの書き出し

[`src/event/ngx_event_pipe.c#L741-L952`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/ngx_event_pipe.c#L741-L952)。`p->cacheable` かどうかで振る舞いが分かれる。

```c title="src/event/ngx_event_pipe.c#L784-L816"
    if (!p->cacheable) {

        size = 0;
        cl = out;
        prev_last_shadow = 1;
        /* ... */
        do {
            bsize = cl->buf->last - cl->buf->pos;
            /* ... */
            if (prev_last_shadow
                && ((size + bsize > p->temp_file_write_size)
                    || (p->temp_file->offset + size + bsize
                        > p->max_temp_file_size)))
            {
                break;
            }

            prev_last_shadow = cl->buf->last_shadow;

            size += bsize;
            ll = &cl->next;
            cl = cl->next;

        } while (cl);
```

非キャッシュのときは `temp_file_write_size` ぶんずつ区切って書く。**区切ってよいのは `prev_last_shadow` が立っている位置だけ**で、同じ生バッファから切り出された buf 群の途中では切らない。切ると、片方だけ書き出されて生バッファが返せなくなる。キャッシュのときは区切らず `p->in` を丸ごと書く。ファイルを完成させるのが目的なので、書き惜しむ理由がない。

書き終わったら、ファイル上の領域を指す buf を `p->out` に足す ([`#L872-L912`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/ngx_event_pipe.c#L872-L912))。ここで `p->out` の末尾の `file_last` が今の `offset` と一致していれば、新しい buf を作らずに `file_last` を伸ばす。**連続していれば既存の buf を伸ばす**ので、追記し続ける限り `p->out` は 1 要素で済む。

最後に生バッファが解放される ([`#L923-L949`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/ngx_event_pipe.c#L923-L949))。判定はここでも `b->last_shadow` 1 本で、立っているものだけ `b->shadow` を `pos = last = start` に巻き戻して `free_raw_bufs` の末尾に繋ぐ。

### 非バッファ経路

`proxy_buffering off;` のときは pipe を使わない。`ngx_http_upstream_send_response` が別のハンドラを差す。

```c title="src/http/ngx_http_upstream.c#L3344-L3352"
        if (u->input_filter == NULL) {
            u->input_filter_init = ngx_http_upstream_non_buffered_filter_init;
            u->input_filter = ngx_http_upstream_non_buffered_filter;
            u->input_filter_ctx = r;
        }

        u->read_event_handler = ngx_http_upstream_process_non_buffered_upstream;
        r->write_event_handler =
                             ngx_http_upstream_process_non_buffered_downstream;
```

本体は `ngx_http_upstream_process_non_buffered_request` ([`src/http/ngx_http_upstream.c#L3947-L4077`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_upstream.c#L3947-L4077))。

```c title="src/http/ngx_http_upstream.c"
    b = &u->buffer;

    do_write = do_write || u->length == 0;

    for ( ;; ) {

        if (do_write) {

            if (u->out_bufs || u->busy_bufs || downstream->buffered) {
                rc = ngx_http_output_filter(r, u->out_bufs);
                /* ... */
                ngx_chain_update_chains(r->pool, &u->free_bufs, &u->busy_bufs,
                                        &u->out_bufs, u->output.tag);
            }

            if (u->busy_bufs == NULL) {
                /* ... length == 0 や eof なら finalize ... */

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
                u->input_filter(u->input_filter_ctx, n);
            }

            do_write = 1;
            continue;
        }

        break;
    }
```

**バッファは `u->buffer` の 1 枚だけ。** 読んで、`input_filter` でチェーンに切り出して、下流に流して、全部送り終わったら (`u->busy_bufs == NULL`) 先頭に巻き戻して再利用する。省略した `busy_bufs == NULL` の中では終了条件が 3 通りに書き分けられていて、`u->length == 0` または `eof && length == -1` なら正常終了、`eof && length > 0` なら `"upstream prematurely closed connection"` の 502、`read->error || u->error` なら無言の 502 になる。

`ngx_event_pipe` と同じ「書く → 読む」の交互ループだが、**バッファ管理がまるごと無い**。`free_raw_bufs` も `shadow` も `busy_size` も一時ファイルも出てこない。`ngx_event_pipe.c` の 1146 行に対して、こちらは 130 行で済んでいる。

`proxy_buffering off` にすると変わるのはこの 4 点になる。

- 溜められないので、下流が遅ければ上流を待たせる。上流の接続が長く占有される。
- `input_filter` が受信のたびに必ず呼ばれるので、1 バイトでも来れば下流へ流れる。
- キャッシュが効かない。`send_response` の先頭で `ngx_http_file_cache_free` が呼ばれる。
- `r->limit_rate = 0` が明示的に設定される ([`#L3354-L3355`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_upstream.c#L3354))。速度制限は溜めることを前提にしているので、非バッファでは無効になる。

## 守られている不変条件

**`last_shadow` は shadow のリンク 1 本につき 1 枚だけに立つ。** これが破れると `ngx_event_pipe_remove_shadow_links` の `while (!b->last_shadow)` が止まらず、生バッファが二重に `free_raw_bufs` に入る。参照カウントを持たない設計は、全部この 1 つの条件に乗っている。

**`free_raw_bufs` の先頭は、部分的に埋まっているバッファかもしれない。それ以外は空でなければならない。** `ngx_event_pipe_add_free_buf` の 3 分岐がこれを維持する。受信側は先頭から順に `recv_chain` に渡すので、この順序が崩れると書き込み位置がずれる。

**`p->busy` に入っている `recycled` な buf の合計は `busy_size` を超えない。** 超えそうなときは新しい buf を渡さず、`flush` に飛ぶ。この上限があるので、`proxy_buffers` で確保したバッファが全部下流側に滞留して読むぶんが無くなる、ということが起きない。

**上流の終了理由は `upstream_done` / `upstream_eof` / `upstream_error` の 3 つで、意味が違う。** `done` は「期待したバイト数を受け取った」、`eof` は「相手が閉じた」、`error` は「エラーが起きた」。呼び出し側はこれを見分けて結果を変える。

```c title="src/http/ngx_http_upstream.c#L4477-L4490"
            if (p->upstream_done
                || (p->upstream_eof && p->length == -1))
            {
                ngx_http_upstream_finalize_request(r, u, 0);
                return;
            }

            if (p->upstream_eof) {
                ngx_log_error(NGX_LOG_ERR, r->connection->log, 0,
                              "upstream prematurely closed connection");
            }

            ngx_http_upstream_finalize_request(r, u, NGX_HTTP_BAD_GATEWAY);
```

`eof` でも `p->length == -1` (長さが不明) なら正常終了とみなす。`Connection: close` で終わりを示す応答がこれに当たる。長さが分かっているのに `eof` が来たら `"upstream prematurely closed connection"` になる。

**`downstream_error` が立ったら、チェーンは全部 `p->free` に回収される。** `ngx_event_pipe_drain_chains` ([`#L1108-L1146`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/ngx_event_pipe.c#L1108-L1146)) が `busy` / `out` / `in` を順に空にし、`last_shadow` の生バッファを返す。下流が死んでも、キャッシュのためにパイプが回り続けることがあるので、その回収経路が要る。

## つまずきどころ

### `proxy_buffering on` はバッファが埋まるまで下流に出さない

`input_filter` が呼ばれるのは「バッファが端まで埋まった」「残り `p->length` バイトが揃った」「上流が終わった」の 3 つだけだ。それ以外のとき、受信済みのバイト列は `free_raw_bufs` の先頭に居座る。

`proxy_buffer_size 4k;` の下で 100 バイトずつゆっくり送ってくる上流に繋ぐと、40 回ぶん溜まるまで下流に何も出ない。ストリーミングが必要なら `proxy_buffering off` を選ぶしかなく、これはチューニングではなく**別の経路に切り替える**操作になる。

### `cacheable` のとき、逃げ道が 1 つ消える

受信バッファを取る 4 段の分岐のうち、3 番目 (下流へ流す) には `!p->cacheable` が付いている。キャッシュ有効時は「バッファが尽きたら必ず一時ファイル」になる。

つまり `proxy_cache` を有効にすると、**メモリに余裕があってもディスク I/O が増える**。読むたびに `write_chain_to_temp_file` が走る `p->cacheable` 分岐 ([`#L489-L499`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/ngx_event_pipe.c#L489)) と合わせて、キャッシュのコストは「保存 1 回ぶん」では済まない。

### `shadow` は追いにくく、参照カウントのほうが素直

1 枚の生バッファから切り出された複数の buf が、`in` / `out` / `busy` / `free` / `free_raw_bufs` の 5 本を行き来する。所有権を表すのは `last_shadow` の 1 ビットだけで、リストの終端まで歩かないと状態が分からない。

`busy_size` の計算で `prev == cl->buf->start` と比較しているのも、`temp_file_write_size` で区切る位置に `prev_last_shadow` を見ているのも、全部この構造の後始末になっている。**同じことをするなら、生バッファに参照カウントを持たせるほうが読みやすい。** メモリプールを使う設計 ([memory-pool](../memory-pool/)) では個別解放をしないので、カウンタを置く場所が自然に無かった、という事情はある。

### `p->length` はバイト数とは限らない

`ngx_event_pipe_copy_input_filter` は `p->length` をバイト数として減算する。だが chunked のときの proxy は `p->length = 5` を「`"0" CRLF CRLF` を見たい」の意味で使い、`ngx_http_parse_chunked` の途中経過で書き換える。

```c title="src/http/modules/ngx_http_proxy_module.c#L2358-L2364"
        if (rc == NGX_AGAIN) {

            /* set p->length, minimal amount of data we want to see */

            p->length = ctx->chunked.length;

            break;
        }
```

`read_upstream` の `cl->buf->last - cl->buf->pos >= p->length` という判定は、この両方の意味で正しく動くように書かれている。「あと何バイトあれば前に進めるか」という共通の解釈に落ちている。

### `flushed++ > 10` は AIO のための回避策

```c title="src/event/ngx_event_pipe.c#L686-L696"
        if (out == NULL) {

            if (!flush) {
                break;
            }

            /* a workaround for AIO */
            if (flushed++ > 10) {
                return NGX_BUSY;
            }
        }
```

`busy_size` を超えていて `flush = 1` なのに送るものが無い、という状態が 11 回続いたら `NGX_BUSY` で抜ける。`ngx_event_pipe()` はこれを見て `NGX_OK` を返して帰る。非同期 I/O が完了していないと `busy` がいつまでも減らないので、無限ループを避けるための上限になっている ([blocking-io](../blocking-io/))。

コメントに `workaround` と書いてあるとおり、構造的な解決ではない。11 という数字にも根拠はない。

### 一時ファイルは黙って作られない

```c title="src/http/ngx_http_upstream.c#L3527-L3531"
    } else {
        p->temp_file->log_level = NGX_LOG_WARN;
        p->temp_file->warn = "an upstream response is buffered "
                             "to a temporary file";
    }
```

キャッシュ目的でない一時ファイルが作られると警告が出る。**警告文字列を構造体に持たせておいて、実際にファイルを作るときに出す**という作りになっている。このメッセージが出ているなら、`proxy_buffers` が応答サイズに足りていない。

`proxy_max_temp_file_size` の既定は 1GB で、同時接続が多いと合計が跳ね上がる。「メモリが足りなければディスク」は無条件に安全な逃げ道ではない。

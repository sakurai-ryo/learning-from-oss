---
title: "非同期にできない I/O だけを外に出し、戻り口をいつもの「イベント」に揃える"
description: "O_NONBLOCK は通常ファイルに効かない。ディスクを待つ read は 1 スレッドのループを確実に止める。Nginx は AIO とスレッドプールの 2 経路を用意し、どちらも NGX_AGAIN を返して eventfd 経由でループに戻す。使えなければ素のブロックする read に落ちる。open() と stat() は非同期化されておらず、そこはキャッシュで殴っている。"
group: "設計の掘り下げ"
sidebar:
  order: 39
---

## 何を学んだか

### どんな状況の話か

[ワーカーの 1 周のページ](../state-machine/) の前提は「どこもブロックしない」だった。ソケットは `O_NONBLOCK` にすれば `EAGAIN` を返すので、`NGX_AGAIN` に翻訳して帰ればいい。

**通常ファイルにはそれが効かない。** `open(path, O_NONBLOCK)` としても、`read()` はページキャッシュに載っていなければディスクを待つ。回転ディスクなら数ミリ秒から数十ミリ秒。その間、そのワーカーが抱えている数万接続は全部止まる。

`sendfile()` も同じで、ファイルの中身がページキャッシュに無ければ、カーネルの中で待つ。`open()` も `stat()` も、ディレクトリのメタデータが載っていなければ待つ。

つまり **静的ファイルを配るという一番基本的な仕事が、イベントループを壊しうる**。

### Nginx の答え

1. **手段を 3 つ用意して、設定で選ばせる。** 何もしない (素の `read()`)、Linux AIO、スレッドプール。
2. **3 つとも、呼び出し側から見た形を「`NGX_AGAIN` を返して、後でイベントとして完了が来る」に揃える。** [ワーカーの 1 周のページ](../state-machine/) の中断・再開の形そのままになる。
3. **完了通知は必ずイベントループ経由にする。** AIO は `eventfd` に、スレッドプールは `ngx_notify()` に。ワーカースレッドは Nginx のデータ構造を一切触らない。
4. **どの経路も、失敗したら素のブロックする `read()` に落ちる。** `io_submit` が `EAGAIN` を返しても、`ENOSYS` でも、そのまま同期で読む。
5. **「非同期処理が走っている」を 2 つのフラグで表す。** `r->aio` (このリクエストが待っている) と `r->main->blocked` (解放してはいけない)。
6. **戻ってこない場合に備えて 60 秒のタイマを張る。** 発火したら `"aio operation took too long"` と記録する。
7. **ページキャッシュを汚したくない場合は `directio`。** そのときはアライメントを合わせた専用バッファを作り、`sendfile` を諦める。
8. **`open()` と `stat()` は非同期化していない。** `open_file_cache` でキャッシュして回数を減らす、という別の解き方をしている。

## ソースコードのどこか

### 3 つの経路が 1 箇所で分岐する

`ngx_output_chain_copy_buf()` ([`src/core/ngx_output_chain.c#L562-L610`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_output_chain.c#L562-L610))。ファイルの buf をメモリに読み込む必要があるとき、ここを通る。

```c title="src/core/ngx_output_chain.c"
#if (NGX_HAVE_FILE_AIO)
        if (ctx->aio_handler) {
            n = ngx_file_aio_read(src->file, dst->pos, (size_t) size,
                                  src->file_pos, ctx->pool);
            if (n == NGX_AGAIN) {
                ctx->aio_handler(ctx, src->file);
                return NGX_AGAIN;
            }

        } else
#endif
#if (NGX_THREADS)
        if (ctx->thread_handler) {
            src->file->thread_task = ctx->thread_task;
            src->file->thread_handler = ctx->thread_handler;
            src->file->thread_ctx = ctx->filter_ctx;

            n = ngx_thread_read(src->file, dst->pos, (size_t) size,
                                src->file_pos, ctx->pool);
            if (n == NGX_AGAIN) {
                ctx->thread_task = src->file->thread_task;
                return NGX_AGAIN;
            }

        } else
#endif
        {
            n = ngx_read_file(src->file, dst->pos, (size_t) size,
                              src->file_pos);
        }
```

**3 つの `if-else` で、しかも 3 つとも `n` に結果を入れて合流する。** `NGX_AGAIN` が返れば中断、そうでなければ読めたバイト数として同じ処理に進む。

`ctx->aio_handler` と `ctx->thread_handler` が `NULL` かどうかだけで経路が決まる。設定するのは copy フィルタ ([`src/http/ngx_http_copy_filter_module.c#L124-L134`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_copy_filter_module.c#L124-L134))。

```c title="src/http/ngx_http_copy_filter_module.c"
#if (NGX_HAVE_FILE_AIO)
        if (ngx_file_aio && clcf->aio == NGX_HTTP_AIO_ON) {
            ctx->aio_handler = ngx_http_copy_aio_handler;
        }
#endif

#if (NGX_THREADS)
        if (clcf->aio == NGX_HTTP_AIO_THREADS) {
            ctx->thread_handler = ngx_http_copy_thread_handler;
        }
#endif
```

`ngx_file_aio` は **実行時に AIO が使えると分かっているか**を表すグローバル変数で、[イベントメソッドのページ](../event-methods/) の `ngx_use_epoll_rdhup` と同じ形をしている。`aio on;` と設定されていても、AIO の初期化に失敗していれば `ctx->aio_handler` は設定されず、素の `read()` になる。

### AIO の経路

[`src/os/unix/ngx_linux_aio_read.c#L49-L134`](https://github.com/nginx/nginx/blob/release-1.31.4/src/os/unix/ngx_linux_aio_read.c#L49-L134)。この関数は **同じ引数で 2 回呼ばれる**。1 回目は投入、2 回目は結果の取り出し。

```c title="src/os/unix/ngx_linux_aio_read.c"
ssize_t
ngx_file_aio_read(ngx_file_t *file, u_char *buf, size_t size, off_t offset,
    ngx_pool_t *pool)
{
    /* ... */
    if (!ngx_file_aio) {
        return ngx_read_file(file, buf, size, offset);
    }

    if (file->aio == NULL && ngx_file_aio_init(file, pool) != NGX_OK) {
        return NGX_ERROR;
    }

    aio = file->aio;
    ev = &aio->event;

    if (!ev->ready) {
        ngx_log_error(NGX_LOG_ALERT, file->log, 0,
                      "second aio post for \"%V\"", &file->name);
        return NGX_AGAIN;
    }
    /* ... */
    if (ev->complete) {
        ev->active = 0;
        ev->complete = 0;

        if (aio->res >= 0) {
            ngx_set_errno(0);
            return aio->res;
        }

        ngx_set_errno(-aio->res);

        ngx_log_error(NGX_LOG_CRIT, file->log, ngx_errno,
                      "aio read \"%s\" failed", file->name.data);

        return NGX_ERROR;
    }
```

**`ev->complete` が立っていれば「2 回目の呼び出し」**なので、保存してある結果を返して終わり。立っていなければ投入する。

```c title="src/os/unix/ngx_linux_aio_read.c"
    ngx_memzero(&aio->aiocb, sizeof(struct iocb));

    aio->aiocb.aio_data = (uint64_t) (uintptr_t) ev;
    aio->aiocb.aio_lio_opcode = IOCB_CMD_PREAD;
    aio->aiocb.aio_fildes = file->fd;
    aio->aiocb.aio_buf = (uint64_t) (uintptr_t) buf;
    aio->aiocb.aio_nbytes = size;
    aio->aiocb.aio_offset = offset;
    aio->aiocb.aio_flags = IOCB_FLAG_RESFD;
    aio->aiocb.aio_resfd = ngx_eventfd;

    ev->handler = ngx_file_aio_event_handler;

    piocb[0] = &aio->aiocb;

    if (io_submit(ngx_aio_ctx, 1, piocb) == 1) {
        ev->active = 1;
        ev->ready = 0;
        ev->complete = 0;

        return NGX_AGAIN;
    }
```

**`aio_data` に `ngx_event_t *` をそのまま入れる。** 完了通知が返ってきたときに、このポインタから handler を呼べる。`aio_resfd = ngx_eventfd` で、**完了したら `eventfd` に書け**とカーネルに指示している。

その `eventfd` は epoll モジュールが `epoll` に登録している ([イベントメソッドのページ](../event-methods/) の `ngx_notify` 用とは別の fd)。だから **AIO の完了は、ソケットが読めるようになったのと同じ経路で `epoll_wait` から返ってくる。**

失敗パスが全部フォールバックになっている。

```c title="src/os/unix/ngx_linux_aio_read.c"
    err = ngx_errno;

    if (err == NGX_EAGAIN) {
        return ngx_read_file(file, buf, size, offset);
    }

    ngx_log_error(NGX_LOG_CRIT, file->log, err,
                  "io_submit(\"%V\") failed", &file->name);

    if (err == NGX_ENOSYS) {
        ngx_file_aio = 0;
        return ngx_read_file(file, buf, size, offset);
    }

    return NGX_ERROR;
```

`EAGAIN` (AIO のキューが一杯) なら **その場で同期に読む**。`ENOSYS` (カーネルが対応していない) なら **`ngx_file_aio = 0` にして以後ずっと同期**にする。

[イベントメソッドのページ](../event-methods/) の `epoll_create()` の試行と同じで、**エラーの種類で「一時的」と「恒久的」を区別している**。一時的なら次回また試す、恒久的なら二度と試さない。

### スレッドプールの経路

`ngx_thread_read()` ([`src/os/unix/ngx_files.c#L95-L152`](https://github.com/nginx/nginx/blob/release-1.31.4/src/os/unix/ngx_files.c#L95-L152)) も **同じ「2 回呼ばれる」形**をしている。

```c title="src/os/unix/ngx_files.c"
    task = file->thread_task;

    if (task == NULL) {
        task = ngx_thread_task_alloc(pool, sizeof(ngx_thread_file_ctx_t));
        /* ... */
        file->thread_task = task;
    }

    ctx = task->ctx;

    if (task->event.complete) {
        task->event.complete = 0;

        if (ctx->write) {
            ngx_log_error(NGX_LOG_ALERT, file->log, 0,
                          "invalid thread call, read instead of write");
            return NGX_ERROR;
        }

        if (ctx->err) {
            ngx_log_error(NGX_LOG_CRIT, file->log, ctx->err,
                          "pread() \"%s\" failed", file->name.data);
            return NGX_ERROR;
        }

        return ctx->nbytes;
    }

    task->handler = ngx_thread_read_handler;

    ctx->write = 0;

    ctx->fd = file->fd;
    ctx->buf = buf;
    ctx->size = size;
    ctx->offset = offset;

    if (file->thread_handler(task, file) != NGX_OK) {
        return NGX_ERROR;
    }

    return NGX_AGAIN;
```

**AIO 版と同じシグネチャ、同じ `NGX_AGAIN`、同じ `complete` フラグ。** 呼び出し側 (`ngx_output_chain_copy_buf`) から見て、2 つの経路は本当に同じ形をしている。

`ctx->write` の検査が入っているのが面白い。同じ `task` が読みと書きで使い回されるので、**「書きを投げたのに読みとして結果を取りに来た」を検出する**。ありえない状態なので `NGX_LOG_ALERT` で記録する。

ワーカースレッドが実行するのは 20 行 ([`#L157-L183`](https://github.com/nginx/nginx/blob/release-1.31.4/src/os/unix/ngx_files.c#L157-L183))。

```c title="src/os/unix/ngx_files.c"
static void
ngx_thread_read_handler(void *data, ngx_log_t *log)
{
    ngx_thread_file_ctx_t *ctx = data;

    ssize_t  n;

    ngx_log_debug0(NGX_LOG_DEBUG_CORE, log, 0, "thread read handler");

    n = pread(ctx->fd, ctx->buf, ctx->size, ctx->offset);

    if (n == -1) {
        ctx->err = ngx_errno;

    } else {
        ctx->nbytes = n;
        ctx->err = 0;
    }
    /* ... */
}
```

**`pread()` を 1 回呼んで、結果を `ctx` に書くだけ。** Nginx のリクエスト構造体もプールもチェーンも触らない。`pread` (オフセット指定) を使うのは、fd のファイルオフセットが共有されているためで、`lseek` + `read` だと他のスレッドと競合する。ヘッダには `#error pread() is required!` があり、**この仕組みが `pread` の存在を前提にしている**ことが明示されている。

ワーカースレッドの立ち上がりで、シグナルをほぼ全部ブロックする ([`src/core/ngx_thread_pool.c#L293-L304`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_thread_pool.c#L293-L304))。

```c title="src/core/ngx_thread_pool.c"
    sigfillset(&set);

    sigdelset(&set, SIGILL);
    sigdelset(&set, SIGFPE);
    sigdelset(&set, SIGSEGV);
    sigdelset(&set, SIGBUS);

    err = pthread_sigmask(SIG_BLOCK, &set, NULL);
```

**外さないのは、そのスレッド自身のバグで起きる 4 つだけ。** [master/worker のページ](../master-worker/) の `SIGHUP` や `SIGTERM` は、必ずメインスレッドが受ける。シグナルハンドラがどのスレッドで走るかは指定できないので、ワーカースレッド側でブロックして排除する。

`SIGSEGV` などを外しているのは、これらが「そのスレッドの実行が原因」で発生するもので、ブロックしても意味がない (かつ、ブロックすると挙動が未定義になる) ため。

キューには上限がある ([`#L243-L250`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_thread_pool.c#L243-L250))。

```c title="src/core/ngx_thread_pool.c"
    if (tp->waiting >= tp->max_queue) {
        (void) ngx_thread_mutex_unlock(&tp->mtx, tp->log);

        ngx_log_error(NGX_LOG_ERR, tp->log, 0,
                      "thread pool \"%V\" queue overflow: %i tasks waiting",
                      &tp->name, tp->waiting);
        return NGX_ERROR;
    }
```

既定 65536。**溢れたらエラーを返す**ので、`ngx_thread_read()` が `NGX_ERROR` を返し、リクエストが 500 になる。ここだけは同期にフォールバックしない。ディスクが詰まっているのに同期で読み始めたら、イベントループが止まるからだ。

### 「待っている」を 2 つのフラグで表す

copy フィルタの AIO handler ([`src/http/ngx_http_copy_filter_module.c#L163-L178`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_copy_filter_module.c#L163-L178))。

```c title="src/http/ngx_http_copy_filter_module.c"
static void
ngx_http_copy_aio_handler(ngx_output_chain_ctx_t *ctx, ngx_file_t *file)
{
    ngx_http_request_t *r;

    r = ctx->filter_ctx;

    file->aio->data = r;
    file->aio->handler = ngx_http_copy_aio_event_handler;

    ngx_add_timer(&file->aio->event, 60000);

    r->main->blocked++;
    r->aio = 1;
    ctx->aio = 1;
}
```

3 つのフラグが立つ。

- **`r->main->blocked++`**: [リクエストの終了のページ](../finalize-request/) で見た `ngx_http_close_request()` が `if (r->count || r->blocked) return;` で参照する。**AIO が走っている間はリクエストを解放してはいけない。** バッファに書き込み中のカーネルが、解放済みメモリを踏む。
- **`r->aio = 1`**: このリクエストが非同期処理を待っている。
- **`ctx->aio = 1`**: フィルタのコンテキストにも。

`ngx_add_timer(&file->aio->event, 60000)` が保険で、**60 秒で返ってこなければ発火する**。

完了 handler ([`#L181-L223`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_copy_filter_module.c#L181-L223))。

```c title="src/http/ngx_http_copy_filter_module.c"
    if (ev->timedout) {
        ngx_log_error(NGX_LOG_ALERT, c->log, 0,
                      "aio operation took too long");
        ev->timedout = 0;
        return;
    }

    if (ev->timer_set) {
        ngx_del_timer(ev);
    }

    r->main->blocked--;
    r->aio = 0;

    if (r->main->terminated) {
        /*
         * trigger connection event handler if the request was
         * terminated
         */

        c->write->handler(c->write);

    } else {
        r->write_event_handler(r);
        ngx_http_run_posted_requests(c);
    }
```

タイマで起こされた場合は、**記録するだけで何もしない**。`blocked` も減らさない。AIO はまだ走っているので、解放したら壊れる。`"aio operation took too long"` は「異常だが、こちらから打てる手は無い」を意味している。

正常に完了した場合は `r->write_event_handler(r)` を呼ぶ。[ワーカーの 1 周のページ](../state-machine/) のとおり、これは「書けるようになった」ときと同じ経路だ。**AIO の完了が、いつもの再開に翻訳されている。**

`r->main->terminated` の分岐は、待っている間にリクエストが終了させられた場合。`blocked` のせいで解放が保留されていたので、ここで接続側の handler を呼んで片付けさせる。

スレッドプール版の handler もほぼ同じ形で、こちらは `NGX_HTTP_V2` の追加処理がある ([`#L329-L340`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_copy_filter_module.c#L329-L340))。

```c title="src/http/ngx_http_copy_filter_module.c"
    if (r->stream) {
        /*
         * for HTTP/2, update write event to make sure processing will
         * reach the main connection to handle sendfile() in threads
         */

        c->write->ready = 1;
        c->write->active = 0;
    }
```

[HTTP/2 のページ](../http2-multiplexing/) の偽の接続の書きイベントを、ここでも「書けるようになった」に設定している。

### 同時に 1 つしか走らせない

スレッド handler の冒頭に、独特な検査がある ([`#L242-L261`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_copy_filter_module.c#L242-L261))。

```c title="src/http/ngx_http_copy_filter_module.c"
    if (r->aio) {
        /*
         * tolerate sendfile() calls if another operation is already
         * running; this can happen due to subrequests, multiple calls
         * of the next body filter from a filter, or in HTTP/2 due to
         * a write event on the main connection
         */

        c = r->connection;

#if (NGX_HTTP_V2)
        if (r->stream) {
            c = r->stream->connection->connection;
        }
#endif

        if (task == c->sendfile_task) {
            return NGX_OK;
        }
    }
```

**「既に非同期処理が走っているのに、もう 1 つ投げようとした」を検出する。** コメントが原因を 3 つ列挙している。[サブリクエスト](../subrequest-postpone/)、フィルタからの多重呼び出し、[HTTP/2](../http2-multiplexing/) のメイン接続の書きイベント。

そのうち `sendfile` のタスクだけは許容して `NGX_OK` を返す。**バグ報告の積み重ねが、この 20 行のコメント付き例外として残っている**形になっている。

### ページキャッシュを避ける

大きなファイルを配ると、ページキャッシュが押し出されて他のファイルのヒット率が落ちる。`directio 4m;` と書くと、4MB 以上のファイルは `O_DIRECT` で開かれる ([`src/core/ngx_open_file_cache.c#L920-L929`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_open_file_cache.c#L920-L929))。

```c title="src/core/ngx_open_file_cache.c"
        if (of->directio <= ngx_file_size(&fi)) {
            if (ngx_directio_on(fd) == NGX_FILE_ERROR) {
                ngx_log_error(NGX_LOG_ALERT, pool->log, ngx_errno,
                              ngx_directio_on_n " \"%V\" failed", name);

            } else {
                of->is_directio = 1;
            }
        }
```

`O_DIRECT` はオフセットとバッファをブロック境界に揃えることを要求する。そのための特別なバッファを作る ([`src/core/ngx_output_chain.c#L378-L425`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_output_chain.c#L378-L425))。

```c title="src/core/ngx_output_chain.c"
static ngx_int_t
ngx_output_chain_align_file_buf(ngx_output_chain_ctx_t *ctx, off_t bsize)
{
    size_t      size;
    ngx_buf_t  *in;

    in = ctx->in->buf;

    if (in->file == NULL || !in->file->directio) {
        return NGX_DECLINED;
    }

    ctx->directio = 1;

    size = (size_t) (in->file_pos - (in->file_pos & ~(ctx->alignment - 1)));

    if (size == 0) {

        if (bsize >= (off_t) ctx->bufs.size) {
            return NGX_DECLINED;
        }

        size = (size_t) bsize;

    } else {
        size = (size_t) ctx->alignment - size;

        if ((off_t) size > bsize) {
            size = (size_t) bsize;
        }
    }

    ctx->buf = ngx_create_temp_buf(ctx->pool, size);
    /* ... */

    /*
     * we do not set ctx->buf->tag, because we do not want
     * to reuse the buf via ctx->free list
     */
```

**現在のファイル位置から次のアライメント境界までのぶんだけ、専用のバッファを作る。** これで境界を跨げば、以降は普通の (アライメント済みの) バッファで読める。

コメントの「`tag` を設定しないので `free` リストで再利用されない」が [buf のページ](../buf-chain/) の話とつながっていて、**このバッファは 1 回きりで捨てる**。半端なサイズなので使い回す意味がない。

そして `directio` が有効なときは `sendfile` を使わない。[buf のページ](../buf-chain/) で見た `ngx_output_chain_as_is()` にその判定がある。

```c title="src/core/ngx_output_chain.c"
#if !(NGX_HAVE_SENDFILE_NODISKIO)

    /*
     * With DIRECTIO, disable sendfile() unless sendfile(SF_NOCACHE)
     * is available.
     */

    if (buf->in_file && buf->file->directio) {
        sendfile = 0;
    }

#endif
```

**`sendfile()` はページキャッシュを経由するので、`O_DIRECT` の意図と矛盾する。** FreeBSD の `SF_NOCACHE` があれば両立できるので、その場合だけ許す。

### sendfile もスレッドに逃がす

`sendfile()` 自体がディスクを待つ問題は、`aio threads; sendfile on;` の組み合わせで解かれる ([`src/os/unix/ngx_linux_sendfile_chain.c#L244-L245`](https://github.com/nginx/nginx/blob/release-1.31.4/src/os/unix/ngx_linux_sendfile_chain.c#L244-L245))。

```c title="src/os/unix/ngx_linux_sendfile_chain.c"
    if (file->file->thread_handler) {
        return ngx_linux_sendfile_thread(c, file, size);
    }
```

タスクは接続に紐づく (`c->sendfile_task`)。`read` のタスクがリクエストに紐づくのと対照的で、**`sendfile()` は接続に対する操作**だからだ。前述の「既に走っているとき `sendfile` だけは許す」例外は、この非対称性から来ている。

### 非同期化していないもの

`open()` と `stat()` はブロックしうるが、Nginx はこれらを非同期化していない。代わりに `open_file_cache` がある。

```nginx
open_file_cache max=1000 inactive=20s;
```

fd とメタデータをキャッシュして、**`open()` と `stat()` の回数そのものを減らす**。キャッシュミスのときは同期でブロックする。

これは正直に「解いていない」と言える部分で、`open()` を非同期化する移植性のある方法が無い (Linux の `io_uring` なら可能だが、それは 2019 年以降の話) 以上、回数を減らすしかない。**すべてを非同期にするのではなく、頻度と影響を見て諦める線を引いている。**

## なぜそうなっているか

### 3 つの経路を同じ形にすることの価値

`ngx_file_aio_read()` と `ngx_thread_read()` は、まったく別の仕組みなのに、**シグネチャも、`NGX_AGAIN` の意味も、`complete` フラグの使い方も同じ**になっている。だから呼び出し側の `ngx_output_chain_copy_buf()` は、3 つの分岐を並べるだけで済む。

もし片方が「コールバックを登録する」形で、もう片方が「future を返す」形だったら、呼び出し側に 2 種類の待ち方が要る。**新しい仕組みを足すときに、既存の仕組みの形に合わせる**という規律が効いている。

さらに言えば、その「形」は既に [ワーカーの 1 周のページ](../state-machine/) で確立していた `NGX_AGAIN` + イベント再開の形だ。**新しい非同期の仕組みを、既存の非同期の語彙に翻訳している。**

### 完了通知を必ずイベントループに戻す

AIO は `eventfd` に、スレッドプールは `ngx_notify()` (これも `eventfd`) に。どちらも `epoll` に登録された fd が読めるようになる形で、`epoll_wait` から返ってくる。

これで守られているのは、**「Nginx のデータ構造を触るのは常に 1 スレッド」**という不変条件だ。ワーカースレッドが触るのは `ngx_thread_file_ctx_t` (fd、バッファ、サイズ、オフセット、結果) だけで、リクエストもプールもチェーンも見ない。

結果として、**リクエスト処理のコードにロックが 1 つも増えていない**。[ワーカーの 1 周のページ](../state-machine/) の「完了は再び『イベントが来て handler が呼ばれる』形に揃えて戻す」が、ここで具体的に効いている。

スレッドプールで唯一ロックが要るのは、`ngx_thread_pool_done` のスピンロックとキューのミューテックス。**境界 2 箇所に閉じ込められている。**

### フォールバックを全経路に置く

`io_submit` が `EAGAIN` なら同期で読む。`ENOSYS` なら以後ずっと同期。`ngx_file_aio` が 0 なら最初から同期。`aio` が設定されていなければ同期。

**「非同期にできなかった」を、失敗ではなく劣化として扱っている。** 静的ファイルを配るという機能は、AIO が使えなくても動かなければならない。

例外がスレッドプールのキュー溢れで、そこだけは `NGX_ERROR` を返す。**溢れているということはディスクが詰まっているということ**で、そこで同期に落ちたらイベントループが止まる。「劣化して動く」より「そのリクエストを諦める」ほうがマシ、という判断になっている。

この使い分けが、フォールバックを設計するときの考え方として学べる。**フォールバック先が本当に安全かを、状況ごとに確かめる必要がある。**

### `blocked` と `count` を分ける理由

[リクエストの終了のページ](../finalize-request/) で見た `ngx_http_close_request()` は `if (r->count || r->blocked) return;` と書いている。2 つとも「解放するな」を意味するのに、なぜ分かれているか。

`count` は **「このリクエストを気にしている論理的な参照の数」**で、[サブリクエスト](../subrequest-postpone/) や [upstream](../upstream/) が増やす。減らせば、いずれ 0 になって解放される。

`blocked` は **「カーネルか別スレッドが、このリクエストのメモリに書き込み中」**を意味する。これは論理的な参照ではなく、物理的な危険だ。しかも `"aio operation took too long"` のケースでは **減らせないまま残る**。

分けているおかげで、「参照はもう無いが、AIO が返ってこないので解放できない」という状態が表現できる。1 つのカウンタに混ぜると、この状態が「まだ誰かが使っている」と区別できなくなる。

### 60 秒のタイマは、直せないものを記録する

タイマが発火しても、Nginx は何もできない。AIO をキャンセルする移植性のある方法は無い。バッファを解放したらカーネルが踏む。

それでもタイマを張るのは、**運用者が原因にたどり着けるようにするため**だ。`"aio operation took too long"` がログに出れば、ディスクかストレージ層を疑える。これが無いと、「接続が増え続けてワーカーが終了しない」という症状だけが見える。

**打つ手が無い異常でも、検出して記録する価値はある。** 特に、症状が原因から遠いところに出る種類の異常では。

### 「解かない」という選択

`open()` の非同期化は、`open_file_cache` で回数を減らすという別解になっている。

判断の根拠は頻度だろう。`read()` は 1 リクエストで何十回も呼ばれるが、`open()` は 1 回。しかもディレクトリのメタデータはキャッシュに載りやすい。**投資対効果が違う。**

これは「イベントループを絶対にブロックさせない」という原則の例外で、原則を掲げつつ現実的な線を引いている。原則を守るコストが利益を上回るところで止める、という判断が明示されずにコードの不在として存在している。

## どう活かすか

### そのまま真似できるところ

**非同期にできない処理を外に出すとき、戻り口を既存の非同期の形に合わせる。** 新しい待ち方 (Future、コールバック、チャネル) を増やさず、既に呼び出し側が知っている形に翻訳する。`NGX_AGAIN` + イベント再開という語彙が既にあるなら、そこに乗せる。

**複数の実装 (AIO / スレッド / 同期) を、同じシグネチャに揃える。** 呼び出し側の分岐が `if (handler)` の並びだけになる。実装を足すときも、既存の呼び出し側を触らない。

**ワーカースレッドには、自己完結したコンテキストだけを渡す。** `{ fd, buf, size, offset, 結果, errno }` の構造体。アプリケーションのデータ構造を触らせないことで、ロックが境界 2 箇所に閉じる。

**同じ関数が「投入」と「回収」の両方を担う形にする。** `complete` フラグで分岐すれば、呼び出し側は同じ引数で 2 回呼ぶだけ。状態を持つ変数が増えない。

**「一時的な失敗」と「恒久的な非対応」をエラー番号で区別する。** `EAGAIN` なら今回だけ同期に落ちる、`ENOSYS` なら以後ずっと。起動時の 1 回の失敗で永久に劣化させない。

**フォールバック先が安全かを、状況ごとに確かめる。** AIO のキュー溢れは同期に落ちてよいが、スレッドプールのキュー溢れは落ちてはいけない。「とりあえず同期にする」を機械的に適用しない。

**「物理的に触られている」と「論理的に参照されている」を別のカウンタにする。** 前者は減らせないことがある。混ぜると、異常状態が正常状態と区別できなくなる。

**打つ手が無い異常にも、検出と記録を入れる。** タイムアウトしても何もできないが、ログに残れば運用者が原因にたどり着ける。症状が原因から遠い異常ほど、これが効く。

**すべてを非同期にしようとしない。** 頻度と影響で線を引き、割に合わないところはキャッシュや回数削減で殴る。原則の例外を認めることも設計判断になる。

**回避策の理由をコメントに残す。** `"tolerate sendfile() calls if another operation is already running"` の 6 行は、3 つの原因を列挙している。これが無かったら、次の人がこの `if` を「不要な防御」として消す。

### 取り込むべきでない条件

**Linux AIO (libaio) は、今なら選ばない。** バッファード I/O では実質同期になることがあり、`O_DIRECT` と組み合わせないと効果が出にくい。`io_uring` があるなら、そちらのほうが素直になる。Nginx が libaio を持っているのは 2010 年前後の選択肢の結果だ。

**`directio` は、ページキャッシュを捨てるという強い判断。** ヒット率が高いワークロードでは逆効果になる。「大きいファイルだけ」という閾値で切っているが、その閾値は測って決めるものだ。

**60 秒のタイマは、リークの検出であって解決ではない。** 発火した時点でそのリクエストは永久に解放されない。キャンセル可能な非同期 API を選べるなら、そちらのほうがいい。

**スレッドプールは、ディスクが遅いときにだけ効く。** ページキャッシュに載っているファイルを配るだけなら、スレッドへの投入とコンテキストスイッチのぶん遅くなる。既定が `aio off` なのはそのためで、**測ってから入れるもの**になっている。

## 関連

- `NGX_AGAIN` と中断・再開の基本形は [ワーカーの 1 周のページ](../state-machine/)。
- `ngx_notify()` の実装と `eventfd` の使い方は [イベントメソッドのページ](../event-methods/)。
- `r->main->blocked` を参照する `ngx_http_close_request()` は [リクエストの終了のページ](../finalize-request/)。
- `sendfile` と `directio` の切り替え判定 (`ngx_output_chain_as_is`) は [buf と chain のページ](../buf-chain/)。

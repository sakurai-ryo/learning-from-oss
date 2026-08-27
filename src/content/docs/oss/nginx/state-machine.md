---
title: "1 スレッドをブロックさせないために、処理をコールバックの付け替えによるステートマシンにする"
description: "ワーカーのループは epoll で待って、返ってきたイベントの handler を呼ぶだけ。関数はいつでも NGX_AGAIN を返して途中で帰れなければならないので、状態はスタックではなくリクエスト構造体に置かれ、次に何をするかは関数ポインタの差し替えで表される。パーサは r->state を覚えていて 1 バイト単位で中断でき、非同期にできない処理だけがスレッドプールに逃がされる。"
group: "プロセスとイベント"
sidebar:
  order: 2
---

## 何を学んだか

### どんな状況の話か

ワーカーは 1 スレッドで数万の接続を持つ。ということは、どこか 1 箇所で 100ms 止まったら、その 100ms のあいだ数万の接続全部が止まる。「クライアントがリクエストヘッダを途中まで送って黙る」ようなことは日常的に起きるので、`read()` を「全部読めるまで待つ」形で書いた瞬間に破綻する。

普通の書き方はこうなる。

```c
read_request_line(c);      /* 全部読めるまでブロック */
read_headers(c);
handle(c);
write_response(c);
```

これはスレッドかコルーチンがあって初めて成立する。C89 相当のポータブルな C で、スレッドもコルーチンも使わずに同じ流れを書くには、**関数が途中で帰って、後で続きから再開できる** ようにするしかない。

### Nginx の答え

1. **1 接続に読みイベントと書きイベントを 1 つずつ持たせ、それぞれに関数ポインタを 1 本持たせる。** `ngx_event_t` の `handler` が「この接続が次に読めるようになったら何をするか」を表す。処理が進んだら handler を差し替える。これが状態遷移になる。
2. **ワーカーのループは、待って、handler を呼ぶだけ。** `ngx_process_events_and_timers()` は「次のタイマまでの時間を計算 → `epoll_wait` → 溜まったイベントの handler を呼ぶ → 期限切れタイマの handler を呼ぶ」しかしない。
3. **中断できるように、状態はスタックではなく構造体に置く。** HTTP パーサは `r->state` に enum を保存していて、1 バイトの途中でも中断・再開できる。ローカル変数の `state` は関数の入口で `r->state` から復元し、出口で書き戻す。
4. **やり残しは `NGX_AGAIN` で返し、イベントを再登録して帰る。** 呼び出し側は `NGX_AGAIN` を見たら何もせず `return` する。次に読めるようになったら、また同じ handler が呼ばれて同じところから続く。
5. **今すぐは呼びたくない handler は「ポストキュー」に積む。** 再帰の深さとロック保持時間を抑えるために、`ngx_posted_accept_events` / `ngx_posted_events` / `ngx_posted_next_events` の 3 本のキューがある。
6. **HTTP 層は、イベント handler をもう一段包む。** `c->read->handler` は `ngx_http_request_handler` に固定され、その中で `r->read_event_handler` / `r->write_event_handler` に振り分ける。イベントの状態と、リクエストの状態が別の変数になっている。
7. **どうしても非同期にできないものだけスレッドプールに逃がす。** ディスク読みなどをワーカースレッドで実行し、完了は `ngx_notify()` でイベントループに戻す。イベントループの外に出るのはここだけ。
8. **オブジェクトの寿命は参照カウントで守る。** 中断・再開だらけなので「今このリクエストを解放していいか」がスタックから分からない。`r->main->count` を数える。

## ソースコードのどこか

### イベント 1 つの正体

[`src/event/ngx_event.h#L30-L138`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/ngx_event.h#L30-L138)。

```c title="src/event/ngx_event.h"
struct ngx_event_s {
    void            *data;

    unsigned         write:1;
    unsigned         accept:1;

    /* used to detect the stale events in kqueue and epoll */
    unsigned         instance:1;

    /*
     * the event was passed or would be passed to a kernel;
     * in aio mode - operation was posted.
     */
    unsigned         active:1;
    unsigned         disabled:1;

    /* the ready event; in aio mode 0 means that no operation can be posted */
    unsigned         ready:1;
    unsigned         oneshot:1;
    unsigned         complete:1;
    unsigned         eof:1;
    unsigned         error:1;
    unsigned         timedout:1;
    unsigned         timer_set:1;
    unsigned         delayed:1;
    /* ... */
    unsigned         posted:1;
    unsigned         closed:1;
    /* ... */
    int              available;

    ngx_event_handler_pt  handler;
    /* ... */
    ngx_uint_t       index;
    ngx_log_t       *log;
    ngx_rbtree_node_t   timer;

    /* the posted queue */
    ngx_queue_t      queue;
};
```

構造体 1 つに、フラグが 20 個弱と、handler が 1 本、赤黒木のノードが 1 つ、キューのリンクが 1 つ入っている。**この 1 個の構造体が、タイマにも入れるし、ポストキューにも入れるし、epoll にも登録できる**。侵入型のデータ構造 (`ngx_rbtree_node_t` と `ngx_queue_t` を struct の中に埋め込む) を使っているので、イベントを別のコンテナに入れるのに追加の確保が要らない。

`ready` は「読める/書ける状態にある」、`active` は「カーネルに登録済み」、`timedout` は「タイマが先に切れた」。これらは組み合わせで意味を持つ。たとえば `ready && !active` は「edge-triggered で通知を受け取ったが、まだデータを読み切っていない」を表す。1 ビットずつに分けてあるので、状態の数は組み合わせ爆発するが、判定は `if (rev->ready)` のように読める。

### ワーカーのループ

[`src/event/ngx_event.c#L195-L264`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/ngx_event.c#L195-L264)。ワーカーの本体はこれだけしかない。

```c title="src/event/ngx_event.c"
ngx_process_events_and_timers(ngx_cycle_t *cycle)
{
    ngx_uint_t  flags;
    ngx_msec_t  timer, delta;

    if (ngx_timer_resolution) {
        timer = NGX_TIMER_INFINITE;
        flags = 0;

    } else {
        timer = ngx_event_find_timer();
        flags = NGX_UPDATE_TIME;
        /* ... */
    }

    if (ngx_use_accept_mutex) { /* → accept の分配のページ */ }

    if (!ngx_queue_empty(&ngx_posted_next_events)) {
        ngx_event_move_posted_next(cycle);
        timer = 0;
    }

    delta = ngx_current_msec;

    (void) ngx_process_events(cycle, timer, flags);

    delta = ngx_current_msec - delta;

    ngx_event_process_posted(cycle, &ngx_posted_accept_events);

    if (ngx_accept_mutex_held) {
        ngx_shmtx_unlock(&ngx_accept_mutex);
    }

    ngx_event_expire_timers();

    ngx_event_process_posted(cycle, &ngx_posted_events);
}
```

`ngx_process_events` はマクロで、実体は `ngx_event_actions.process_events`。`epoll` / `kqueue` / `eventport` / `select` のどれかに解決される。イベントメソッドは [`ngx_event_actions_t`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/ngx_event.h#L166-L186) という関数ポインタの表で抽象化されていて、`add` / `del` / `add_conn` / `del_conn` / `notify` / `process_events` / `init` / `done` の 8 本しかない。

順序が意味を持っている。**accept のポストキューを最初に処理する** ことで、新しい接続を受け取る仕事を、既存接続の処理より前に、かつ accept ロックを持ったまま短時間で終わらせる。ロックを離した後で、タイマ、通常のポストイベントと続く。

### ポストキュー

[`src/event/ngx_event_posted.c`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/ngx_event_posted.c) は全部で 60 行しかない。

```c title="src/event/ngx_event_posted.c"
void
ngx_event_process_posted(ngx_cycle_t *cycle, ngx_queue_t *posted)
{
    ngx_queue_t  *q;
    ngx_event_t  *ev;

    while (!ngx_queue_empty(posted)) {

        q = ngx_queue_head(posted);
        ev = ngx_queue_data(q, ngx_event_t, queue);

        ngx_delete_posted_event(ev);

        ev->handler(ev);
    }
}
```

`while` で回しているので、handler の中でさらに別のイベントをポストしても、この同じループが拾う。**再帰の代わりに、ループにイベントを積む** という形になっている。C にはスタックの深さを増やす余裕がないので、これは実用上も重要になる。

`ngx_posted_next_events` は「次のループまで待たせる」ためのキューで、`ngx_event_move_posted_next()` が `ready = 1` と `available = -1` を立ててから通常キューに合流させる。同じイベントを同じループの中で無限に処理し続けてしまうのを防ぐ仕掛けで、たとえば「バッファに残ったデータがまだ処理できる」ような状況で 1 周譲るために使う。

### 状態はスタックに置けない

`ngx_http_parse_request_line()` ([`src/http/ngx_http_parse.c#L108-L143`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_parse.c#L108-L143)) は 26 状態のステートマシンだ。

```c title="src/http/ngx_http_parse.c"
ngx_http_parse_request_line(ngx_http_request_t *r, ngx_buf_t *b)
{
    u_char  c, ch, *p, *m;
    enum {
        sw_start = 0,
        sw_method,
        sw_spaces_before_uri,
        sw_schema,
        /* ... 26 個 ... */
        sw_almost_done
    } state;

    state = r->state;

    for (p = b->pos; p < b->last; p++) {
        ch = *p;

        switch (state) {

        /* HTTP methods: GET, HEAD, POST */
        case sw_start:
            r->request_start = p;
            /* ... */
            state = sw_method;
            break;
```

入口で `state = r->state`、バッファが尽きたら [`#L846-L849`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_parse.c#L846-L849) で書き戻す。

```c title="src/http/ngx_http_parse.c"
    b->pos = p;
    r->state = state;

    return NGX_AGAIN;

done:
```

つまり **`GET / HTT` まで届いて残りが来ないという状況でも、`sw_http_HTT` の状態を覚えたまま帰れる**。1 バイトずつ TCP セグメントが分かれて届いても正しく動く。TCP はメッセージ境界を保存しないので、これは正しさの要件であって最適化ではない。

そして、この「状態を構造体に持つ」がステートマシン化の本質になっている。ローカル変数に持てる状態は関数が返ると消えるので、**中断可能にしたい関数のローカル変数は、全部どこかの構造体のフィールドにしなければならない**。`ngx_http_request_t` が 500 行近い巨大な構造体になっているのは、その帰結だ。

### handler の付け替えが状態遷移

接続が確立した直後、読みイベントの handler は `ngx_http_wait_request_handler` になっている ([`src/http/ngx_http_request.c#L376-L462`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_request.c#L376-L462))。

```c title="src/http/ngx_http_request.c"
    size = b->end - b->last;

    n = c->recv(c, b->last, size);

    if (n == NGX_AGAIN) {

        if (!rev->timer_set) {
            ngx_add_timer(rev, cscf->client_header_timeout);
            ngx_reusable_connection(c, 1);
        }

        if (ngx_handle_read_event(rev, 0) != NGX_OK) {
            ngx_http_close_connection(c);
            return;
        }

        if (b->pos == b->last) {

            /*
             * We are trying to not hold c->buffer's memory for an
             * idle connection.
             */

            if (ngx_pfree(c->pool, b->start) == NGX_OK) {
                b->start = NULL;
            }
        }

        return;
    }
```

`NGX_AGAIN` のときにやることが 3 つある。**タイマを張る** (いつまでも待たない)、**イベントを再登録する** (`ngx_handle_read_event`)、**バッファを返す** (何も来ていないなら持っていても無駄)。そして `return` する。次に読めるようになったら、同じ `ngx_http_wait_request_handler` がもう一度呼ばれる。

リクエストラインが読めたら、handler は次の状態に移る。`ngx_http_process_request_line` ([`#L1114-L1275`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_request.c#L1114-L1275)) はこういう形をしている。

```c title="src/http/ngx_http_request.c"
    rc = NGX_AGAIN;

    for ( ;; ) {

        if (rc == NGX_AGAIN) {
            n = ngx_http_read_request_header(r);

            if (n == NGX_AGAIN || n == NGX_ERROR) {
                break;
            }
        }

        rc = ngx_http_parse_request_line(r, r->header_in);

        if (rc == NGX_OK) {
            /* ... パースできた。次の状態へ ... */
        }

        if (rc != NGX_AGAIN) {
            /* エラー */
            break;
        }

        /* NGX_AGAIN: a request line parsing is still incomplete */

        if (r->header_in->pos == r->header_in->end) {
            rv = ngx_http_alloc_large_header_buffer(r, 1);
            /* ... */
        }
    }

    ngx_http_run_posted_requests(c);
```

「読む → パースする → 足りなければまた読む」を `for(;;)` で回し、**本当に読めるものが無くなったら `break` して帰る**。この `for(;;)` は、ソケットのバッファに複数回ぶんのデータが溜まっているときに、1 回のイベントで全部処理しきるためにある。ループを抜けるのは、パースが完成したか、エラーか、`NGX_AGAIN` (= 読むものが無い) のどれかだ。

`ngx_http_read_request_header()` ([`#L1599-L1652`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_request.c#L1599-L1652)) が、この 3 種類の返り値を作る。

```c title="src/http/ngx_http_request.c"
    n = r->header_in->last - r->header_in->pos;

    if (n > 0) {
        return n;                     /* バッファに残りがある */
    }

    if (rev->ready) {
        n = c->recv(c, r->header_in->last,
                    r->header_in->end - r->header_in->last);
    } else {
        n = NGX_AGAIN;                /* 読めないと分かっている */
    }

    if (n == NGX_AGAIN) {
        if (!rev->timer_set) {
            cscf = ngx_http_get_module_srv_conf(r, ngx_http_core_module);
            ngx_add_timer(rev, cscf->client_header_timeout);
        }

        if (ngx_handle_read_event(rev, 0) != NGX_OK) {
            ngx_http_close_request(r, NGX_HTTP_INTERNAL_SERVER_ERROR);
            return NGX_ERROR;
        }

        return NGX_AGAIN;
    }
```

`rev->ready` を見て `recv()` を呼ぶかどうかを決めているのが効いていて、edge-triggered の epoll では「まだ読めるはず」というフラグを Nginx 側が持っている。読み切って `EAGAIN` が返ったら `ready` を落とす。こうすると、確実に読めないと分かっている場面で syscall を 1 回省ける。

### イベントの状態とリクエストの状態を分ける

ヘッダを読み終わって処理段に入るとき、handler がもう一段の間接に置き換わる ([`#L2208-L2212`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_request.c#L2208-L2212))。

```c title="src/http/ngx_http_request.c"
    c->read->handler = ngx_http_request_handler;
    c->write->handler = ngx_http_request_handler;
    r->read_event_handler = ngx_http_block_reading;

    ngx_http_handler(r);
```

以降、`c->read->handler` は二度と変わらない。変わるのは `r->read_event_handler` と `r->write_event_handler` のほうだ。`ngx_http_request_handler` は振り分けるだけになっている ([`#L2584-L2617`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_request.c#L2584-L2617))。

```c title="src/http/ngx_http_request.c"
    if (c->close) {
        r->main->count++;
        ngx_http_terminate_request(r, 0);
        ngx_http_run_posted_requests(c);
        return;
    }

    if (ev->delayed && ev->timedout) {
        ev->delayed = 0;
        ev->timedout = 0;
    }

    if (ev->write) {
        r->write_event_handler(r);

    } else {
        r->read_event_handler(r);
    }

    ngx_http_run_posted_requests(c);
```

層が 1 つ増えているのには理由がある。1 本の接続の上には、HTTP/1.1 では 1 つ、HTTP/2 では複数のリクエストが乗る。**接続レベルの「読めるようになった」と、リクエストレベルの「次に何をするか」は別の概念**なので、変数を分けてある。実際、HTTP/2 のストリームは `c` が偽物の接続で、`r->read_event_handler` だけが本物の意味を持つ。

`r->read_event_handler = ngx_http_block_reading` の意味も面白い ([`#L3135-L3149`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_request.c#L3135-L3149))。

```c title="src/http/ngx_http_request.c"
static void
ngx_http_block_reading(ngx_http_request_t *r)
{
    ngx_log_debug0(NGX_LOG_DEBUG_HTTP, r->connection->log, 0,
                   "http reading blocked");

    /* aio does not call this handler */

    if ((ngx_event_flags & NGX_USE_LEVEL_EVENT)
        && r->connection->read->active)
    {
        if (ngx_del_event(r->connection->read, NGX_READ_EVENT, 0) != NGX_OK) {
            ngx_http_close_request(r, 0);
        }
    }
}
```

「今は読みたくない」という状態が、**イベントを外すのではなく、何もしない handler を置く** ことで表されている。level-triggered のときだけは、何もしないと同じイベントが延々と返ってくるので `ngx_del_event()` する。edge-triggered なら放っておけばいい。**「無視する」を明示的な状態として持つ** ことで、`if (読みたい状態か)` の分岐が handler の中から消えている。

### ポストされたリクエスト

`ngx_http_run_posted_requests()` が至るところで呼ばれる ([`#L2620-L2650`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_request.c#L2620-L2650))。

```c title="src/http/ngx_http_request.c"
    for ( ;; ) {

        if (c->destroyed) {
            return;
        }

        r = c->data;
        pr = r->main->posted_requests;

        if (pr == NULL) {
            return;
        }

        r->main->posted_requests = pr->next;

        r = pr->request;
        /* ... */
        r->write_event_handler(r);
    }
```

イベント側のポストキューと同じ発想で、こちらはリクエスト単位になっている。**毎回ループの先頭で `c->destroyed` を見ている**のが肝で、handler の中でコネクションごと壊れる可能性があるからだ。中断・再開のあるコードでは「自分が呼んだ関数の中で、自分が触っている構造体が解放されているかもしれない」が常につきまとう。

その一般解が参照カウントになる ([`#L3888-L3917`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_request.c#L3888-L3917))。

```c title="src/http/ngx_http_request.c"
ngx_http_close_request(ngx_http_request_t *r, ngx_int_t rc)
{
    ngx_connection_t  *c;

    r = r->main;
    c = r->connection;

    ngx_log_debug2(NGX_LOG_DEBUG_HTTP, c->log, 0,
                   "http request count:%d blk:%d", r->count, r->blocked);

    if (r->count == 0) {
        ngx_log_error(NGX_LOG_ALERT, c->log, 0, "http request count is zero");
    }

    r->count--;

    if (r->count || r->blocked) {
        return;
    }
    /* ... */
    ngx_http_free_request(r, rc);
    ngx_http_close_connection(c);
}
```

`count` は「このリクエストを気にしている場所の数」、`blocked` は「今 AIO などが走っているので触るな」。`count == 0` になったところで初めて解放する。`r = r->main` で必ずメインリクエストに正規化しているので、サブリクエストがいくつ走っていてもカウンタは 1 つだ。

### 非同期にできないものは、スレッドに逃がす

`open()` や `read()` は、ページキャッシュに載っていなければブロックする。`O_NONBLOCK` は通常ファイルには効かない。ここだけはイベントループでは解けないので、スレッドプールがある ([`src/core/ngx_thread_pool.c#L342-L394`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_thread_pool.c#L342-L394))。

```c title="src/core/ngx_thread_pool.c"
        task->handler(task->ctx, tp->log);      /* ← ワーカースレッドで実行 */
        /* ... */
        task->next = NULL;

        ngx_spinlock(&ngx_thread_pool_done_lock, 1, 2048);

        *ngx_thread_pool_done.last = task;
        ngx_thread_pool_done.last = &task->next;

        ngx_memory_barrier();

        ngx_unlock(&ngx_thread_pool_done_lock);

        (void) ngx_notify(ngx_thread_pool_handler);
```

完了したタスクは共有のリストに積まれ、`ngx_notify()` でイベントループを起こす (Linux では `eventfd` に書く)。イベントループ側で `ngx_thread_pool_handler` が走り、そこで初めてタスクの完了 handler が呼ばれる。

```c title="src/core/ngx_thread_pool.c"
    while (task) {
        event = &task->event;
        task = task->next;

        event->complete = 1;
        event->active = 0;

        event->handler(event);
    }
```

`event->handler(event)` で、いつもの handler 呼び出しに戻っている。**別スレッドで動く仕組みを足しても、リクエスト処理のコードから見える形は「イベントが来て handler が呼ばれる」のまま**になっている。スレッドプールを使うかどうかは設定 (`aio threads`) で切り替わるが、リクエスト処理側のコードは同じだ。

## なぜそうなっているか

### `NGX_AGAIN` はエラーではなく「まだ」

`NGX_OK` / `NGX_ERROR` / `NGX_AGAIN` / `NGX_DONE` / `NGX_DECLINED` / `NGX_BUSY` / `NGX_ABORT` という戻り値の語彙が、コードベース全体で共有されている。特に `NGX_AGAIN` が「異常ではなく、続きがある」を意味するものとして最初から用意されていることが大きい。

エラーと「まだ」を同じ枠で表す設計 (`-1` と `errno == EAGAIN` を見る) だと、呼び出し側が毎回 `errno` を検査する羽目になる。Nginx は戻り値の時点で分けてあるので、**「まだ」の処理を書き忘れる場所が構文的に目立つ**。`if (rc == NGX_AGAIN)` を書いていない関数は、大抵バグになる。

### 巨大な構造体は、目的ではなく結果

`ngx_http_request_t` は 300 行以上あり、ビットフィールドが 100 個近く並ぶ。初めて見ると「なんでも入れる袋」に見えるが、そうではない。**中断可能にしたい処理のローカル変数は、全部ここに来るしかない**という制約の帰結だ。

コルーチンのある言語ならこれはスタックに置ける。Go の goroutine で書けば `ngx_http_request_t` の半分は消える。逆に言えば、Nginx のこの構造体を見て「設計が悪い」と言うのは、コルーチンを前提にした批判になる。C89 の範囲でこの性能特性を出すという条件では、これ以外の形はほぼ無い。

### handler の付け替えを、状態変数の switch にしなかった理由

「状態を enum で持って、1 つの関数で `switch (r->state)` する」という書き方もありうる。実際、`ngx_http_parse_request_line()` はそう書かれている。しかし接続レベルでは関数ポインタが使われている。

違いは、**拡張の主体**にある。パーサの状態は Nginx 本体が全部知っているので enum で足りる。一方、接続の状態は、SSL ハンドシェイク中かもしれないし、HTTP/2 のフレーム処理中かもしれないし、サードパーティモジュールが持ち込んだ独自プロトコルかもしれない。enum にすると **中央の enum 定義を書き換えないと状態を増やせない**。関数ポインタなら、モジュールが自分の handler を置くだけで済む。

`c->recv` が関数ポインタなのも同じ理由で、これを差し替えることで、平文・SSL・HTTP/2 のストリーム・QUIC のストリームが、上位のコードから見て同じ「読む」になる。

### ポストキューが 3 本ある理由

- `ngx_posted_accept_events`: accept ロックを持っている間に、accept だけを短時間で片付けるため。ロックの保持時間を最小にする。
- `ngx_posted_events`: 通常。ロックを離した後にゆっくり処理する。
- `ngx_posted_next_events`: 「このループでは処理しない」を明示するため。処理し続けると他の接続が飢える場面で、意図的に 1 周譲る。

3 本目が一番面白くて、これは **公平性のための仕組み**になっている。ready なイベントを見つけたら即座に処理する、を貫くと、活発な 1 接続がループを占有してしまう。次のループに回すという選択肢を持たせることで、イベントループの中に簡易的なスケジューリングが入っている。

### スレッドプールを「イベント 1 個」に見せる

スレッドを導入すると、普通はコードベース全体に「これはどのスレッドから呼ばれるのか」という問いが染み出す。Nginx はそれを、**完了通知を必ずイベントループ経由にする** ことで防いでいる。ワーカースレッドがやるのは `task->handler(task->ctx, tp->log)` の呼び出しだけで、そこから Nginx のデータ構造は触らない。触るのは、`ngx_notify()` 後にイベントループ上で走る完了 handler だ。

結果として、**ロックが要る場所が `ngx_thread_pool_done` のスピンロック 1 箇所に閉じている**。リクエスト処理のコードは、依然として「1 スレッドしか触らない」前提で書ける。

## どう活かすか

### そのまま真似できるところ

**「まだ」を返り値の第一級の値にする。** 成功・失敗の 2 値ではなく、「未完了」を別の値として持つ。Rust の `Poll::Pending`、Go の `io.ErrShortBuffer` とは違う `ErrNotReady` のような形。呼び出し側にとって、未完了の扱いを書き忘れるとコンパイルか lint で気づける形にできるとなおよい。

**中断したい処理のローカル変数を、明示的に「状態」として外に出す。** コルーチンのある言語なら不要だが、状態機械を書かざるを得ない場面 (プロトコルパーサ、ストリーム処理、再開可能なジョブ) では効く。「入口で復元、出口で保存」という定型にすると、どこまで進んだかが 1 つの変数に集まる。

**「何もしない」を明示的な状態として持つ。** `ngx_http_block_reading` のように、無視する状態を no-op の handler で表すと、呼び出し側から条件分岐が消える。null チェックや `if (enabled)` が散らばるより読みやすい。

**再帰の代わりにキューに積む。** ハンドラの中から別のハンドラを直接呼ぶと、スタックの深さが読めなくなり、途中で解放されたオブジェクトを触る事故も増える。キューに積んでトップレベルのループで処理すると、スタックが常に浅く保たれ、「今どこから呼ばれているか」が 1 通りになる。

**寿命の判断をスタックに頼れないなら、参照カウントを入れる。** 非同期化した瞬間、「この関数から戻ったらオブジェクトはまだ生きているか」がローカルには分からなくなる。`count++` / `count--` を早めに入れておくほうが、後から入れるより安い。`count == 0` でのログ (`"http request count is zero"`) のように、不変条件が破れたことを検出するコードを一緒に入れておくのも真似したい。

**スレッドを足すときは、完了通知を必ず既存のループに戻す。** 「どのスレッドから呼ばれるか」がコードベース全体に染み出すのを、境界 1 箇所で止められる。

### 取り込むべきでない条件

**コルーチンや async/await があるなら、素直にそちらを使う。** handler の付け替えでステートマシンを書くのは、言語に中断の仕組みが無いときの回避策だ。Go・Rust・Kotlin・最近の C++ なら、同じ実行モデルをはるかに読みやすく書ける。Nginx のコードの読みにくさの大部分は、この回避策のコストとして払われている。

**巨大な状態構造体は、中断可能性が本当に必要なときだけ。** `ngx_http_request_t` のような構造体は、フィールド間の不変条件がコードに散らばるので、変更のたびに「このフラグを立てたらあのフラグはどうなるか」を追う羽目になる。同期的に書ける処理まで同じ形にすると、コストだけ払うことになる。

**`rev->ready` のような「カーネルの状態のミラー」は、慎重に。** syscall を 1 回省くために、カーネル側の状態をユーザー空間で追跡している。ずれるとハングする。Nginx はこれを 20 年かけて詰めてきたから成立しているのであって、新しく書くコードで最初からやる最適化ではない。

## 関連

- `ngx_add_event` / `ngx_handle_read_event` が epoll と kqueue の差をどう吸収しているかは [イベントメソッドのページ](../event-methods/)。
- `ready` フラグの維持と `instance` ビットによる stale event の検出も、同じページで扱う。
- ディスク I/O のように「非同期にできないもの」をどう外に出すかは [ブロックする I/O のページ](../blocking-io/)。名前解決は [DNS リゾルバのページ](../resolver/)。
- 1 周を短く保つために、どこにどんな上限が置かれているかは [1 周の長さのページ](../loop-latency/)。
- `ngx_event_t` がタイマの赤黒木に入る仕組みは [タイマのページ](../timer-rbtree/)。

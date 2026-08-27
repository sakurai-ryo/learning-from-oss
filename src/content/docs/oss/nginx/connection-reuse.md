---
title: "接続を張り直さないために、キャッシュと「足りなくなったら古いものから切る」を組み合わせる"
description: "worker_connections は固定長の配列で、確保はフリーリストの先頭を取るだけ。枯渇したときは「切ってもいい接続」の LRU から古い順に閉じる。上流への接続は keepalive モジュールがキューにしまい、取り出すときは NGX_DONE を返して「接続済み」を伝える。しまわれた接続は読みイベントを張ったまま、相手の切断を検出する。"
group: "上流とデータの流れ"
sidebar:
  order: 18
---

## 何を学んだか

### どんな状況の話か

接続を張るのは高い。TCP の 3-way ハンドシェイクで 1 RTT、TLS ならさらに 1〜2 RTT。上流が同じデータセンターにいても、毎リクエスト張り直すと無視できないコストになる。クライアント側も同じで、HTTP/1.1 の keepalive が効くかどうかで体感が変わる。

一方で、接続を保持することはリソースを食う。ワーカーあたりの `worker_connections` は有限で、fd も有限。**「使い回したいが、抱え込みすぎたくない」** という相反する要求がある。

そして [ステートマシン](../state-machine/) なので、「今は誰も使っていない接続」も `epoll` に登録されたままにしておく必要がある。相手が切ってきたのを検出しないと、次に使おうとしたときに失敗する。

### Nginx の答え

1. **`ngx_connection_t` は起動時に `worker_connections` 個ぶんの配列として確保する。** 実行時の確保は無い。
2. **未使用の接続は、`c->data` を next ポインタとして使った単方向リストで繋ぐ。** 取るのも返すのも O(1)。
3. **接続を取るたびに `instance` ビットを反転する。** `epoll` に残っていた古いイベントを、この 1 ビットで検出して捨てる。
4. **「今切ってもいい」接続を LRU キューに入れておく。** アイドルな keepalive 接続、リクエストを待っている接続など。
5. **接続が足りなくなったら、その LRU の古い側から閉じる。** 一度に閉じるのは最大 32 個、または全体の 1/8。
6. **上流への接続は、`upstream keepalive` モジュールが固定数のキューにしまう。** 取り出すときは `NGX_DONE` を返して「もう繋がっている」と伝える。
7. **しまった接続には読みイベントを張ったままにして、切断を検出する。** `MSG_PEEK` で 1 バイト覗いて判定する。
8. **アイドルな接続からはバッファを返す。** 空の接続がメモリを持ち続けないようにする。

## ソースコードのどこか

### 固定長の接続配列とフリーリスト

[`src/core/ngx_connection.c#L1207-L1269`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_connection.c#L1207-L1269)。

```c title="src/core/ngx_connection.c"
ngx_get_connection(ngx_socket_t s, ngx_log_t *log)
{
    ngx_uint_t         instance;
    ngx_event_t       *rev, *wev;
    ngx_connection_t  *c;

    /* ... fd 番号の範囲チェック ... */

    ngx_drain_connections((ngx_cycle_t *) ngx_cycle);

    c = ngx_cycle->free_connections;

    if (c == NULL) {
        ngx_log_error(NGX_LOG_ALERT, log, 0,
                      "%ui worker_connections are not enough",
                      ngx_cycle->connection_n);

        return NULL;
    }

    ngx_cycle->free_connections = c->data;
    ngx_cycle->free_connection_n--;
    /* ... */
    rev = c->read;
    wev = c->write;

    ngx_memzero(c, sizeof(ngx_connection_t));

    c->read = rev;
    c->write = wev;
    c->fd = s;
    c->log = log;

    instance = rev->instance;

    ngx_memzero(rev, sizeof(ngx_event_t));
    ngx_memzero(wev, sizeof(ngx_event_t));

    rev->instance = !instance;
    wev->instance = !instance;

    rev->index = NGX_INVALID_INDEX;
    wev->index = NGX_INVALID_INDEX;

    rev->data = c;
    wev->data = c;

    wev->write = 1;

    return c;
}
```

**`c->data` をフリーリストの next として流用している。** 使用中は「この接続に紐づくデータ」を指し、未使用なら次の空き接続を指す。フィールドを兼用することで、リストのためのメモリが 0 になる。

返すほうは 4 行 ([`#L1272-L1282`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_connection.c#L1272-L1282))。

```c title="src/core/ngx_connection.c"
ngx_free_connection(ngx_connection_t *c)
{
    c->data = ngx_cycle->free_connections;
    ngx_cycle->free_connections = c;
    ngx_cycle->free_connection_n++;
    /* ... */
}
```

`ngx_memzero(c, ...)` の前後で `rev`/`wev` を退避・復元しているのが重要で、**`ngx_event_t` の実体は別の配列にあり、`ngx_connection_t` はそこへのポインタを持つだけ**。接続を初期化しても、イベント構造体との対応は変わらない。

### `instance` ビットで古いイベントを弾く

```c title="src/core/ngx_connection.c"
    instance = rev->instance;

    ngx_memzero(rev, sizeof(ngx_event_t));
    ngx_memzero(wev, sizeof(ngx_event_t));

    rev->instance = !instance;
    wev->instance = !instance;
```

**接続を取るたびに 1 ビットを反転させる。** これが解いている問題はこうだ。

1. 接続 A のイベントが `epoll_wait` の返り値に入っている (まだ処理していない)。
2. 同じバッチの前のイベントの処理中に、A が閉じられて `free_connections` に戻る。
3. さらに同じ処理中に、新しい接続 B が A と同じ `ngx_connection_t` を取る。
4. ループが進んで、A のイベントを処理しようとする。**でもそこには B がいる。**

`epoll` に登録するとき、[epoll モジュール](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/modules/ngx_epoll_module.c#L621) は `ee.data.ptr` に **接続のポインタと `instance` ビットを OR したもの** を入れる。

```c title="src/event/modules/ngx_epoll_module.c"
    ee.data.ptr = (void *) ((uintptr_t) c | ev->instance);
```

`ngx_connection_t` は 4 バイト以上でアライメントされているので、下位 1 ビットは常に 0。そこに `instance` を載せる ([スラブアロケータのページ](../slab-shared-memory/) のタグ付きポインタと同じ手法)。

処理側では、取り出した `instance` と現在の `ev->instance` を比べて、違えば「古いイベント」として捨てる。**1 ビットで use-after-free を防いでいる。**

### 「切ってもいい接続」の LRU

[`#L1374-L1401`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_connection.c#L1374-L1401)。

```c title="src/core/ngx_connection.c"
ngx_reusable_connection(ngx_connection_t *c, ngx_uint_t reusable)
{
    ngx_log_debug1(NGX_LOG_DEBUG_CORE, c->log, 0,
                   "reusable connection: %ui", reusable);

    if (c->reusable) {
        ngx_queue_remove(&c->queue);
        ngx_cycle->reusable_connections_n--;
        /* ... */
    }

    c->reusable = reusable;

    if (reusable) {
        /* need cast as ngx_cycle is volatile */

        ngx_queue_insert_head(
            (ngx_queue_t *) &ngx_cycle->reusable_connections_queue, &c->queue);
        ngx_cycle->reusable_connections_n++;
        /* ... */
    }
}
```

**呼ぶたびに先頭へ移動する。** `reusable = 1` で再度呼べば、いったん外して先頭に入れ直すので、それが LRU の更新になる。キューのリンクは `ngx_connection_t` の中の `queue` メンバなので、追加の確保が要らない ([タイマのページ](../timer-rbtree/) の侵入型と同じ)。

呼ばれる場所が意味を持っている。[ステートマシンのページ](../state-machine/) で見た `ngx_http_wait_request_handler` では、

```c title="src/http/ngx_http_request.c"
    if (n == NGX_AGAIN) {

        if (!rev->timer_set) {
            ngx_add_timer(rev, cscf->client_header_timeout);
            ngx_reusable_connection(c, 1);
        }
```

**「接続はできたがリクエストがまだ来ない」状態は、切ってもいい。** クライアントは再接続すればいい。逆に、リクエストの処理が始まったら `ngx_reusable_connection(c, 0)` で外れる。処理中の接続を切るとエラーになるからだ。

### 足りなくなったら閉じる

[`#L1404-L1458`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_connection.c#L1404-L1458)。

```c title="src/core/ngx_connection.c"
static void
ngx_drain_connections(ngx_cycle_t *cycle)
{
    ngx_uint_t         i, n;
    ngx_queue_t       *q;
    ngx_connection_t  *c;

    if (cycle->free_connection_n > cycle->connection_n / 16
        || cycle->reusable_connections_n == 0)
    {
        return;
    }

    if (cycle->connections_reuse_time != ngx_time()) {
        cycle->connections_reuse_time = ngx_time();

        ngx_log_error(NGX_LOG_WARN, cycle->log, 0,
                      "%ui worker_connections are not enough, "
                      "reusing connections",
                      cycle->connection_n);
    }

    c = NULL;
    n = ngx_max(ngx_min(32, cycle->reusable_connections_n / 8), 1);

    for (i = 0; i < n; i++) {
        if (ngx_queue_empty(&cycle->reusable_connections_queue)) {
            break;
        }

        q = ngx_queue_last(&cycle->reusable_connections_queue);
        c = ngx_queue_data(q, ngx_connection_t, queue);

        ngx_log_debug0(NGX_LOG_DEBUG_CORE, c->log, 0,
                       "reusing connection");

        c->close = 1;
        c->read->handler(c->read);
    }

    if (cycle->free_connection_n == 0 && c && c->reusable) {

        /*
         * if no connections were freed, try to reuse the last
         * connection again: this should free it as long as
         * previous reuse moved it to lingering close
         */

        ngx_log_debug0(NGX_LOG_DEBUG_CORE, c->log, 0,
                       "reusing connection again");

        c->close = 1;
        c->read->handler(c->read);
    }
}
```

**空きが全体の 1/16 を切ったら発動する。** 閉じる数は `min(32, reusable/8)` で、最低 1 個。一度に全部閉じないのは、[ステートマシンのページ](../state-machine/) の「1 周を長くしない」という規律と、**閉じすぎて無駄にしないため**だ。

閉じ方が独特で、**`c->close = 1` を立てて読み handler を直接呼ぶ**。「閉じてくれ」というフラグを立てて、その接続自身の状態機械に片付けさせる。keepalive 待ちなら `ngx_http_keepalive_handler` が、リクエスト待ちなら `ngx_http_wait_request_handler` が、`c->close` を見て自分で終了処理をする。

**コアは「HTTP の接続をどう閉じるか」を知らなくていい。** `mail` や `stream` の接続も同じキューに入っていて、それぞれの handler が片付ける。

最後の「もう一度試す」が実務的で、コメントのとおり **1 回目の呼び出しが lingering close に移行しただけで、まだ解放されていない**場合がある。その状態でもう一度 `close = 1` で呼ぶと、今度は解放される。「1 回で片付くとは限らない」を認めた上でのリトライになっている。

ログが 1 秒に 1 回に絞られている (`connections_reuse_time != ngx_time()`) のも実務的だ。**枯渇時は毎接続でこの関数が呼ばれる**ので、素直に書くと秒間数万行のログが出る。

### 上流への接続をしまう

`ngx_http_upstream_keepalive_module` は、[upstream のページ](../upstream-event-pipe/) の負荷分散の層に割り込む形で実装されている ([`src/http/modules/ngx_http_upstream_keepalive_module.c#L29-L60`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/modules/ngx_http_upstream_keepalive_module.c#L29-L60))。

```c title="src/http/modules/ngx_http_upstream_keepalive_module.c"
typedef struct {
    ngx_http_upstream_keepalive_srv_conf_t  *conf;

    ngx_queue_t                        queue;
    ngx_connection_t                  *connection;

    socklen_t                          socklen;
    ngx_sockaddr_t                     sockaddr;

    ngx_http_upstream_conf_t          *tag;

} ngx_http_upstream_keepalive_cache_t;


typedef struct {
    ngx_http_upstream_keepalive_srv_conf_t  *conf;

    ngx_http_upstream_t               *upstream;

    void                              *data;

    ngx_event_get_peer_pt              original_get_peer;
    ngx_event_free_peer_pt             original_free_peer;
    /* ... */
} ngx_http_upstream_keepalive_peer_data_t;
```

**`original_get_peer` / `original_free_peer` を保持して、自分を間に挟む。** `round_robin` や `least_conn` の上に透過的に乗る、デコレータになっている。

取り出す側 ([`#L228-L274`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/modules/ngx_http_upstream_keepalive_module.c#L228-L274))。

```c title="src/http/modules/ngx_http_upstream_keepalive_module.c"
        item = ngx_queue_data(q, ngx_http_upstream_keepalive_cache_t, queue);
        c = item->connection;

        if (kp->conf->local && item->tag != kp->upstream->conf) {
            continue;
        }

        if (ngx_memn2cmp((u_char *) &item->sockaddr, (u_char *) pc->sockaddr,
                         item->socklen, pc->socklen)
            == 0)
        {
            ngx_queue_remove(q);
            ngx_queue_insert_head(&kp->conf->free, q);

            goto found;
        }
    }

    return NGX_OK;

found:
    /* ... */
    c->idle = 0;
    c->sent = 0;
    c->data = NULL;
    /* ... */
    if (c->read->timer_set) {
        ngx_del_timer(c->read);
    }

    pc->connection = c;
    pc->cached = 1;

    return NGX_DONE;
```

**キャッシュを線形探索して、アドレスが一致するものを探す。** 見つからなければ `NGX_OK` で、[upstream のページ](../upstream-event-pipe/) の `ngx_event_connect_peer()` が普通に `connect()` する。見つかれば `NGX_DONE`。

`NGX_DONE` が **「接続処理は完了している、`connect()` を呼ぶな」** を意味する。[upstream のページ](../upstream-event-pipe/) で見た 5 種類の返り値のうちの 1 つがここで生まれる。`NGX_OK` (即座に接続完了) と `NGX_DONE` (既に接続済み) を分けているのは、後者では `connect()` 由来の初期化を全部飛ばす必要があるからだ。

`kp->conf->local` は `keepalive` を `proxy_bind` と組み合わせたときのためで、**送信元アドレスが違う接続を再利用してはいけない**。`tag` にモジュールの設定へのポインタを入れて識別している ([buf のページ](../buf-chain/) と同じタグの手法)。

### しまう側の 8 つの条件

[`#L296-L330`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/modules/ngx_http_upstream_keepalive_module.c#L296-L330)。

```c title="src/http/modules/ngx_http_upstream_keepalive_module.c"
    if (state & NGX_PEER_FAILED
        || c == NULL
        || c->read->eof
        || c->read->error
        || c->read->timedout
        || c->write->error
        || c->write->timedout)
    {
        goto invalid;
    }

    if (c->requests >= kp->conf->requests) {
        goto invalid;
    }

    if (ngx_current_msec - c->start_time > kp->conf->time) {
        goto invalid;
    }

    if (!u->keepalive) {
        goto invalid;
    }

    if (!u->request_body_sent) {
        goto invalid;
    }

    if (ngx_terminate || ngx_exiting) {
        goto invalid;
    }

    if (ngx_handle_read_event(c->read, 0) != NGX_OK) {
        goto invalid;
    }
```

**再利用できない条件を列挙して、1 つでも当たれば捨てる。** ホワイトリストではなくブラックリストで、しかも `goto invalid` に集約されている。

`!u->request_body_sent` が入っているのが面白い。**リクエストボディを送り切っていない接続は再利用できない。** 上流が応答を返した後もクライアントからボディが届き続ける可能性があり、その残りを次のリクエストのデータとして送ってしまうと壊れる。

`ngx_terminate || ngx_exiting` は [master/worker のページ](../master-worker/) の graceful shutdown で、**終了中のワーカーは接続をしまわない**。しまうと、その接続が生きている間ワーカーが終了できなくなる。

しまう処理 ([`#L334-L379`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/modules/ngx_http_upstream_keepalive_module.c#L334-L379))。

```c title="src/http/modules/ngx_http_upstream_keepalive_module.c"
    if (ngx_queue_empty(&kp->conf->free)) {

        q = ngx_queue_last(&kp->conf->cache);
        ngx_queue_remove(q);

        item = ngx_queue_data(q, ngx_http_upstream_keepalive_cache_t, queue);

        ngx_http_upstream_keepalive_close(item->connection);

    } else {
        q = ngx_queue_head(&kp->conf->free);
        ngx_queue_remove(q);

        item = ngx_queue_data(q, ngx_http_upstream_keepalive_cache_t, queue);
    }

    ngx_queue_insert_head(&kp->conf->cache, q);

    item->connection = c;
    item->tag = u->conf;

    pc->connection = NULL;

    c->read->delayed = 0;
    ngx_add_timer(c->read, kp->conf->timeout);

    if (c->write->timer_set) {
        ngx_del_timer(c->write);
    }

    c->write->handler = ngx_http_upstream_keepalive_dummy_handler;
    c->read->handler = ngx_http_upstream_keepalive_close_handler;

    c->data = item;
    c->idle = 1;
    c->log = ngx_cycle->log;
    /* ... */
    if (c->read->ready) {
        ngx_http_upstream_keepalive_close_handler(c->read);
    }
```

**`free` と `cache` の 2 本のキューを、固定数の `item` が行き来する。** `keepalive 32;` なら `item` が 32 個作られ、それ以上は増えない。空きが無ければ **`cache` の末尾 (最も古い) を閉じて、その枠を使う**。LRU の追い出しが 4 行で書かれている。

handler の付け替えが要点で、**`c->log` をリクエストのログからサイクルのログに切り替えている**。しまった接続はもうリクエストに属していないので、リクエストのログコンテキスト (と、それが指す `r->pool` のメモリ) を参照してはいけない。

最後の `if (c->read->ready)` が丁寧で、**しまう瞬間に既に読めるデータがあれば、その場で切断判定をする**。上流が応答直後に切ってきた場合がこれに当たる。

### しまった接続の切断検出

[`#L395-L430`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/modules/ngx_http_upstream_keepalive_module.c#L395-L430)。

```c title="src/http/modules/ngx_http_upstream_keepalive_module.c"
static void
ngx_http_upstream_keepalive_close_handler(ngx_event_t *ev)
{
    /* ... */
    c = ev->data;

    if (c->close || c->read->timedout) {
        goto close;
    }

    n = recv(c->fd, buf, 1, MSG_PEEK);

    if (n == -1 && ngx_socket_errno == NGX_EAGAIN) {
        ev->ready = 0;

        if (ngx_handle_read_event(c->read, 0) != NGX_OK) {
            goto close;
        }

        return;
    }

close:
    /* ... 閉じる ... */
```

**`MSG_PEEK` で 1 バイト覗く。** `EAGAIN` なら「まだ何も来ていない」= 接続は生きている。0 が返れば FIN、正の値が返れば **上流が勝手にデータを送ってきた** ということで、どちらも異常なので閉じる。

`MSG_PEEK` なのでデータは消費されない。ただし正の値が返る時点で、その接続はもう使えない。

`c->close` の判定が先頭にあるのは、`ngx_drain_connections()` や `ngx_close_idle_connections()` から呼ばれるため。**「コアが閉じてくれと言っている」と「上流が切ってきた」が、同じ handler に合流している。**

書き側は `ngx_http_upstream_keepalive_dummy_handler` で、ログを出す以外何もしない。[ステートマシンのページ](../state-machine/) の `ngx_http_block_reading` と同じ、**「何もしない」を明示的な状態として持つ**形になっている。

### アイドル接続からメモリを返す

クライアント側の keepalive では、バッファを積極的に返す ([`src/http/ngx_http_request.c#L3403-L3453`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_request.c#L3403-L3453))。

```c title="src/http/ngx_http_request.c"
    /*
     * To keep a memory footprint as small as possible for an idle keepalive
     * connection we try to free c->buffer's memory if it was allocated outside
     * the c->pool.  The large header buffers are always allocated outside the
     * c->pool and are freed too.
     */

    b = c->buffer;

    if (ngx_pfree(c->pool, b->start) == NGX_OK) {

        /*
         * the special note for ngx_http_keepalive_handler() that
         * c->buffer's memory was freed
         */

        b->pos = NULL;

    } else {
        b->pos = b->start;
        b->last = b->start;
    }
    /* ... */
    if (hc->free) {
        for (cl = hc->free; cl; /* void */) {
            ln = cl;
            cl = cl->next;
            ngx_pfree(c->pool, ln->buf->start);
            ngx_free_chain(c->pool, ln);
        }

        hc->free = NULL;
    }
```

[メモリプールのページ](../memory-pool/) の `ngx_pfree` が `NGX_DECLINED` を返しうる話がここでも出ている。**プールの中から取られた小さいバッファは解放できないので、`b->pos = b->start` にして中身だけ空にする。** 個別に `malloc` された大きいバッファは解放される。

`b->pos = NULL` を「解放済み」の印にしているのが独特で、コメントに "the special note for ngx_http_keepalive_handler()" と明記されている。**フィールドの値を、別の関数への合図として使う。** 型としては表れないので、コメントが唯一の仕様になっている。

最後に LRU に入れる ([`#L3496-L3499`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_request.c#L3496-L3499))。

```c title="src/http/ngx_http_request.c"
    if (clcf->keepalive_min_timeout == 0) {
        c->idle = 1;
        ngx_reusable_connection(c, 1);
    }
```

`c->idle = 1` は [master/worker のページ](../master-worker/) の graceful shutdown で使われる印で、`ngx_close_idle_connections()` がこれを見る。`ngx_reusable_connection(c, 1)` は接続枯渇時の切り捨て対象にする印。**2 つの「切ってもいい」が別のフラグになっている**のは、条件が違うからだ。終了時は全部切るが、枯渇時は古い順に必要な数だけ切る。

## なぜそうなっているか

### 固定長にすることで、上限が明示的になる

`worker_connections` は設定値で、起動時にその数の配列が確保される。実行時に増えない。

これで得られるのは、**メモリ使用量の予測可能性**だ。ワーカーが使う接続関連のメモリは起動時に決まる。負荷が上がってもここは増えない。

代償は、上限に達したときに新しい接続を受けられないこと。だから `ngx_drain_connections()` という「古いものを切って空ける」仕組みが必要になる。**上限を固定する代わりに、上限に達したときの振る舞いを定義する** という設計になっている。

`"%ui worker_connections are not enough"` というログは、この設計から必然的に出てくるメッセージだ。動的に増える設計ならこのログは無いが、代わりにメモリが尽きるまで増える。

### `instance` ビットが解く問題は、バッチ処理の宿命

`epoll_wait` は複数のイベントをまとめて返す。処理は 1 つずつなので、**先に処理したイベントの副作用で、後のイベントの対象が消えている**ことがありうる。

これはバッチでイベントを取得するすべてのシステムに出てくる問題で、解き方は 2 つある。世代番号を持つか、削除済みのイベントをバッチから探して無効化するか。後者は O(n) になる。

Nginx は 1 ビットの世代番号を選んだ。**1 ビットで足りるのは、「1 回の `epoll_wait` バッチの中で、同じスロットが 2 回以上再利用されることはない」と言えるから**だ。厳密には保証ではないが、実用上は成立する。ポインタの下位ビットに載せられるので、追加のメモリが 0 になる。

### `c->close = 1` + handler 呼び出しという「閉じ方」

コアが接続を閉じたいとき、`ngx_close_connection()` を直接呼べば済みそうに見える。実際にはそうしない。

理由は、**その接続がどんな状態にあるかをコアが知らない**からだ。HTTP のリクエストを処理中かもしれない、SSL のハンドシェイク中かもしれない、`stream` モジュールの TCP プロキシかもしれない。それぞれ片付けるべきものが違う。

`c->close = 1` を立てて handler を呼ぶと、**その接続の状態機械が、自分の文脈で片付ける**。handler は既に「今どの状態か」を表しているので、余計な情報が要らない。

[ステートマシンのページ](../state-machine/) の「次にやることを関数ポインタで表す」が、そのまま「片付け方を関数ポインタで表す」になっている。

### keepalive のキャッシュを線形探索にした理由

`ngx_http_upstream_get_keepalive_peer()` はキューを線形に舐める。`keepalive 32;` なら最大 32 回のアドレス比較。

ハッシュにすれば O(1) になるが、**32 個程度なら線形のほうが速い**。キャッシュラインに乗る、分岐予測が効く、ハッシュ計算が要らない。しかも `keepalive` の値を極端に大きくする設定は現実的でない (上流のプロセス数を超えても意味がない)。

「小さい N なら線形」というのは Nginx の各所に出てくる判断で、[メモリプールのページ](../memory-pool/) の large 台帳を 4 個までしか探さない話も同じ系統になる。

### 「再利用しない条件」を列挙する形

再利用の可否を「条件を満たせば再利用する」ではなく「1 つでも当たれば捨てる」で書いている。

これは **安全側に倒す**ための書き方だ。新しい理由 (たとえば `!u->request_body_sent` は後から追加された) を足すときに、`goto invalid` を 1 つ増やすだけで済む。ホワイトリスト形式だと、条件を足すときに既存の条件との関係を考える必要がある。

接続の再利用は「間違えると次のリクエストが壊れる」種類の最適化なので、**追加のコストを払ってでも保守的に**という判断が読める。

### しまうときに `c->log` を差し替える

しまった接続はリクエストに属さない。リクエストのログコンテキストは `r->pool` の中にあり、リクエストが終われば消える。

`c->log = ngx_cycle->log` に差し替えるのは、**寿命の違うオブジェクトへの参照を切る**ためだ。[メモリプールのページ](../memory-pool/) の「プールを選ぶことが寿命の宣言」の裏返しで、**プールをまたぐ参照は、寿命が切れる前に外さなければならない**。

`c->pool->log` まで差し替えているのが徹底していて、上流接続のプール自身が持つログも切り替わる。

### `b->pos = NULL` という合図

「バッファのメモリを解放した」を、`pos` を `NULL` にすることで表している。専用のフラグを足す代わりに、既存のフィールドの「ありえない値」を使う。

[設定マージのページ](../conf-merge/) の `NGX_CONF_UNSET` と同じ発想だが、こちらは **フィールドの本来の意味 (バッファ内の位置) とは無関係な意味**を持たせている。読む側 (`ngx_http_keepalive_handler`) がその約束を知っていないと動かない。

コメントで明示してあるのが救いだが、**型で表現されない契約**なので、真似するときは慎重にしたい。

## どう活かすか

### そのまま真似できるところ

**リソースを固定長のプールにして、上限に達したときの振る舞いを定義する。** 動的に増やす設計は上限が見えないが、固定長なら「足りないときどうするか」を必ず考えることになる。その答えが「古いものを切る」なら、切ってよい候補の集合を別に持つ。

**「切ってよい」を明示的な状態として持ち、LRU で管理する。** 全部の接続から選ぶのではなく、「今切っても被害が小さいもの」だけを候補にする。候補への出入りを 1 つの関数 (`ngx_reusable_connection`) に集約すると、条件が散らばらない。

**未使用要素のフィールドを、フリーリストのリンクに流用する。** 固定長プールの定番で、追加のメモリがゼロになる。

**再利用するスロットに世代番号を持たせる。** バッチでイベントを取得するシステムでは、処理中に対象が消える問題が必ず出る。1 ビットでも十分なことが多い。

**片付けを「フラグを立てて、その対象の状態機械に呼び戻す」形にする。** 呼ぶ側が「どう片付けるか」を知らなくて済む。プラグインが接続やセッションの種類を増やせるシステムで効く。

**再利用の可否は「捨てる理由の列挙」で書く。** 安全側に倒れ、条件の追加が容易になる。

**しまうときに、寿命の違うオブジェクトへの参照を切る。** ログコンテキスト、リクエストへのポインタ、リクエストプールから取ったバッファ。コネクションプールを実装するとき、ここを忘れると解放済みメモリを参照する。

**アイドルなオブジェクトからは、持っているバッファを返す。** 「使っていないのにメモリを抱えている」を減らせる。接続数が多いほど効く。

**枯渇時の警告ログは、レート制限する。** 枯渇しているということは、その関数が高頻度で呼ばれているということ。1 秒に 1 回に絞る 3 行を入れておく。

**デコレータとして既存のインターフェースに割り込む。** `original_get_peer` を保持して自分を挟む形は、負荷分散アルゴリズムを問わず keepalive を効かせるための最小の実装になっている。

### 取り込むべきでない条件

**`instance` ビットは、そのままでは検証しにくい。** 「1 バッチ内で同じスロットが 2 回再利用されない」という前提が崩れると、静かに壊れる。世代番号を 8 ビット以上取れるなら、そのほうが安全になる。

**`b->pos = NULL` のような「フィールドの値を合図に使う」は、契約が型に現れない。** コメントを消されたら終わりで、実際 Nginx のコードでこの種の暗黙の契約を追うのは大変になっている。フラグを 1 ビット足せるなら足す。

**線形探索は N が小さいうちだけ。** `keepalive` の値を数百にする設定は想定されていない。設定値に応じてデータ構造を変える仕組みは無いので、**設定の想定範囲を超えると性能が落ちる**。ドキュメントに書かれていない前提になっている。

**接続を切って空きを作るのは、クライアントから見ると突然の切断になる。** `ngx_drain_connections()` が発動している時点で設定が実態に合っていないので、本来は `worker_connections` を増やすべきだ。この仕組みは「最後の砦」であって、常用するものではない。警告ログが `NGX_LOG_WARN` で出るのはそのためだ。

## 関連

- 接続を取ったときに `epoll` に登録する仕組みと `instance` の照合は [ステートマシンのページ](../state-machine/)。
- `ngx_event_connect_peer()` が `NGX_DONE` を返す先の処理は [upstream と event_pipe のページ](../upstream-event-pipe/)。
- `ngx_close_idle_connections()` を呼ぶ graceful shutdown は [master/worker のページ](../master-worker/)。
- `ngx_pfree` が `NGX_DECLINED` を返す理由は [メモリプールのページ](../memory-pool/)。

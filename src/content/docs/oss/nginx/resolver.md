---
title: "getaddrinfo が使えないので、DNS クライアントを 4700 行かけて自分で書く"
description: "名前解決はイベントループを止める代表格。Nginx は設定を読む間だけ getaddrinfo を使い、実行時は自前の DNS クライアントに切り替える。同じ名前を待つ複数のリクエストは 1 本のクエリに合流し、再送は期限順のキューを 1 本のタイマで回す。応答が切り詰められたら TCP で問い合わせ直す。/etc/resolv.conf は読まない。"
group: "プロセスとイベント"
sidebar:
  order: 7
---

## 何を学んだか

### どんな状況の話か

`getaddrinfo()` はブロックする。しかも **どれだけブロックするか分からない**。DNS サーバが応答しなければ数秒待つし、`/etc/nsswitch.conf` の設定次第では LDAP や NIS に問い合わせに行く。`O_NONBLOCK` に相当するものが無い。

[ブロックする I/O のページ](../blocking-io/) のディスク読みと違って、こちらは **スレッドプールに逃がしても解決しない**。DNS が詰まっているときは、全部のスレッドが `getaddrinfo()` で埋まる。しかも名前解決は 1 リクエストにつき 1 回起きうるので、頻度が高い。

一方で、実行時に名前解決が必要な場面は避けられない。

```nginx
resolver 10.0.0.2;
location / {
    set $backend "api.internal.example.com";
    proxy_pass http://$backend;
}
```

`proxy_pass` に変数を使うと、宛先はリクエストごとに決まる。上流をコンテナのサービス名で指定する構成も同じで、**IP が動くから毎回引き直したい**。

### Nginx の答え

1. **DNS クライアントを自分で書く。** `ngx_resolver.c` は 4700 行。クエリの組み立て、応答のパース、圧縮ポインタの展開、CNAME の追跡、SRV レコード、逆引きまで自前。
2. **設定を読む間だけ `getaddrinfo()` を使う。** 起動時のブロックは許容する。
3. **キャッシュは赤黒木、寿命の管理は LRU キュー。** 名前用・SRV 用・逆引き用に 3 組 (IPv6 を入れると 4 組) 持つ。
4. **同じ名前を待っている複数のリクエストを、1 本のクエリに合流させる。** ノードに待ち手の連結リストをぶら下げる。
5. **再送は「期限順のキュー」を 1 本のタイマで回す。** [タイマのページ](../timer-rbtree/) の赤黒木ではなく、`resend_timeout` が固定なのでキューで足りる。
6. **UDP で問い合わせ、応答が切り詰められていたら TCP で引き直す。**
7. **クエリ ID はランダムにして、応答と照合する。** 一致しなければ捨ててログに残す。
8. **リゾルバのタイマは `cancelable`。** [タイマのページ](../timer-rbtree/) の graceful shutdown を妨げない。

## ソースコードのどこか

### 起動時と実行時で別の仕組みを使う

`getaddrinfo()` は `src/core/ngx_inet.c` の 1 箇所にしか出てこない ([`src/core/ngx_inet.c#L1121-L1145`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_inet.c#L1121-L1145))。

```c title="src/core/ngx_inet.c"
ngx_inet_resolve_host(ngx_pool_t *pool, ngx_url_t *u)
{
    /* ... */
    ngx_memzero(&hints, sizeof(struct addrinfo));
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
#ifdef AI_ADDRCONFIG
    hints.ai_flags = AI_ADDRCONFIG;
#endif

    if (getaddrinfo((char *) host, NULL, &hints, &res) != 0) {
        u->err = "host not found";
        ngx_free(host);
        return NGX_ERROR;
    }
```

呼び出し元を全部見ると、`upstream` の `server`、`listen`、`set_real_ip_from` — **どれも `cf->pool` を渡している**。つまり設定を読んでいる最中で、ワーカーはまだ立っていない。

**「起動時はブロックしてよい、実行時はダメ」という線を、引数の型 (`ngx_pool_t *pool` に何を渡すか) が暗黙に示している**形になっている。

実行時に名前を引くコードは、全部 `ngx_resolve_name()` を通る。`ngx_http_upstream` が `proxy_pass` の変数を解決するとき ([upstream のページ](../upstream-event-pipe/) の `u->resolved`)、`ngx_http_referer_module` や `ngx_stream_proxy_module` も同じ。

### キャッシュのノード

[`src/core/ngx_resolver.h#L92-L145`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_resolver.h#L92-L145)。

```c title="src/core/ngx_resolver.h"
typedef struct {
    ngx_rbtree_node_t         node;
    ngx_queue_t               queue;

    /* PTR: resolved name, A: name to resolve */
    u_char                   *name;
    /* ... */
    u_char                   *query;
    /* ... */
    union {
        in_addr_t             addr;
        in_addr_t            *addrs;
        u_char               *cname;
        ngx_resolver_srv_t   *srvs;
    } u;

    u_char                    code;
    u_short                   naddrs;
    /* ... */
    time_t                    expire;
    time_t                    valid;
    uint32_t                  ttl;

    unsigned                  tcp:1;
    /* ... */
    ngx_uint_t                last_connection;

    ngx_resolver_ctx_t       *waiting;
} ngx_resolver_node_t;
```

`node` (赤黒木) と `queue` (双方向リスト) の両方を埋め込んでいる。[タイマのページ](../timer-rbtree/) の侵入型と同じで、**1 つのノードが「キーで引ける木」と「順序で辿れるキュー」の両方に同時に入る**。

`expire` と `valid` が別々にあるのが要点だ。

- **`valid`**: DNS の TTL に基づく「この結果を信じてよい時刻」。過ぎたら引き直す。
- **`expire`**: 「このノードをキャッシュから捨てる時刻」。既定 30 秒。

`valid` が切れても `expire` までノードは残るので、**再問い合わせの間、待ち手のリストを保持できる**。

`u` が union になっていて、A レコードのアドレス、CNAME の名前、SRV のレコード列を同じ場所に置く。どれが有効かは `naddrs` / `cnlen` / `nsrvs` で判別する。**1 レコード分のメモリを最小にする**ための選択で、キャッシュのエントリ数が数万になりうることを考えると効いてくる。

`waiting` が、この名前の解決を待っている `ngx_resolver_ctx_t` の連結リストになる。

リゾルバ本体は、これを 4 組持つ ([`#L148-L194`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_resolver.h#L148-L194))。

```c title="src/core/ngx_resolver.h"
    ngx_rbtree_t              name_rbtree;
    ngx_rbtree_node_t         name_sentinel;

    ngx_rbtree_t              srv_rbtree;
    ngx_rbtree_node_t         srv_sentinel;

    ngx_rbtree_t              addr_rbtree;
    ngx_rbtree_node_t         addr_sentinel;

    ngx_queue_t               name_resend_queue;
    ngx_queue_t               srv_resend_queue;
    ngx_queue_t               addr_resend_queue;

    ngx_queue_t               name_expire_queue;
    ngx_queue_t               srv_expire_queue;
    ngx_queue_t               addr_expire_queue;
```

**木 1 本につきキューが 2 本。** `resend_queue` は「応答待ちで、再送の期限順」、`expire_queue` は「解決済みで、キャッシュから捨てる順」。**同じノードが、状態によってどちらか一方のキューに入る。** 待っている間は `resend_queue`、解決したら `expire_queue`。

### キャッシュヒットのとき

`ngx_resolve_name_locked()` ([`src/core/ngx_resolver.c#L606-L768`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_resolver.c#L606-L768))。

```c title="src/core/ngx_resolver.c"
    ngx_strlow(name->data, name->data, name->len);

    hash = ngx_crc32_short(name->data, name->len);

    if (ctx->service.len) {
        rn = ngx_resolver_lookup_srv(r, name, hash);

        tree = &r->srv_rbtree;
        resend_queue = &r->srv_resend_queue;
        expire_queue = &r->srv_expire_queue;

    } else {
        rn = ngx_resolver_lookup_name(r, name, hash);

        tree = &r->name_rbtree;
        resend_queue = &r->name_resend_queue;
        expire_queue = &r->name_expire_queue;
    }
```

**名前を小文字化してから CRC32 でハッシュする。** DNS の名前は大文字小文字を区別しないので、正規化してからキーにする。[タイマのページ](../timer-rbtree/) の赤黒木と同じ実装を、キーの比較関数だけ差し替えて使っている。

`tree` / `resend_queue` / `expire_queue` の 3 つを最初に選んでおいて、以降のコードは種類 (名前か SRV か) を意識しない。**分岐を最初の 1 箇所に寄せている。**

ヒットしたら ([`#L643-L705`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_resolver.c#L643-L705))。

```c title="src/core/ngx_resolver.c"
        if (rn->valid >= ngx_time()) {

            ngx_log_debug0(NGX_LOG_DEBUG_CORE, r->log, 0, "resolve cached");

            ngx_queue_remove(&rn->queue);

            rn->expire = ngx_time() + r->expire;

            ngx_queue_insert_head(expire_queue, &rn->queue);
            /* ... */
            if (naddrs) {
                /* ... アドレスを ctx に詰める ... */
                last->next = rn->waiting;
                rn->waiting = NULL;

                /* unlock name mutex */

                do {
                    ctx->state = NGX_OK;
                    ctx->valid = rn->valid;
                    ctx->naddrs = naddrs;
                    /* ... */
                    next = ctx->next;

                    ctx->handler(ctx);

                    ctx = next;
                } while (ctx);
```

**キューから外して先頭に入れ直す = LRU の更新。** [接続の再利用のページ](../connection-reuse/) の `ngx_reusable_connection()` と同じ形をしている。

`last->next = rn->waiting; rn->waiting = NULL;` で、**今回の呼び出し側と、既に待っていた全員を 1 本のリストにしてから、順に handler を呼ぶ**。ループの中で `next = ctx->next` を先に取っているのは、`ctx->handler(ctx)` の中で `ctx` が解放されうるからだ。

`ctx->handler(ctx)` が同期的に呼ばれることに注意が要る。**キャッシュヒットなら、`ngx_resolve_name()` から戻る前に handler が走る。** だから呼び出し側は `ctx->state` を見て「もう終わったか」を判断する必要がある。

CNAME の追跡も、ここで再帰する ([`#L724-L732`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_resolver.c#L724-L732))。

```c title="src/core/ngx_resolver.c"
            /* NGX_RESOLVE_CNAME */

            if (ctx->recursion++ < NGX_RESOLVER_MAX_RECURSION) {

                cname.len = rn->cnlen;
                cname.data = rn->u.cname;

                return ngx_resolve_name_locked(r, ctx, &cname);
            }
```

**CNAME の連鎖を辿るのに、同じ関数を再帰で呼ぶ。** 深さは `ctx->recursion` で制限する ([サブリクエストのページ](../subrequest-postpone/) の `r->subrequests` と同じ発想)。

### 待ち手を合流させる

キャッシュに未解決のノードがあった場合 ([`#L752-L768`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_resolver.c#L752-L768))。

```c title="src/core/ngx_resolver.c"
        if (rn->waiting) {
            if (ngx_resolver_set_timeout(r, ctx) != NGX_OK) {
                return NGX_ERROR;
            }

            last->next = rn->waiting;
            rn->waiting = ctx;
            ctx->state = NGX_AGAIN;
            ctx->async = 1;

            do {
                ctx->node = rn;
                ctx = ctx->next;
            } while (ctx);

            return NGX_AGAIN;
        }
```

**既に誰かが同じ名前を問い合わせ中なら、クエリを送らずにリストに並ぶだけ。** 1000 リクエストが同時に同じホスト名を要求しても、DNS に飛ぶパケットは 1 発になる。

これは thundering herd の DNS 版で、[accept の分配のページ](../accept-distribution/) と同じ種類の問題を、こちらは「待ち行列に合流させる」ことで解いている。

`ngx_resolver_set_timeout(r, ctx)` で **待ち手ごとに別のタイマ**を張る。`resolver_timeout` (既定 30 秒) がこれで、**問い合わせ側の都合**を表す。DNS への再送タイマ (`resend_timeout`、5 秒) とは別のものになっている。

### 再送を 1 本のタイマで回す

`ngx_resolver_resend_handler()` ([`#L1446-L1513`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_resolver.c#L1446-L1513))。

```c title="src/core/ngx_resolver.c"
    ntimer = ngx_resolver_resend(r, &r->name_rbtree, &r->name_resend_queue);

    stimer = ngx_resolver_resend(r, &r->srv_rbtree, &r->srv_resend_queue);

    atimer = ngx_resolver_resend(r, &r->addr_rbtree, &r->addr_resend_queue);
    /* ... IPv6 も ... */

    timer = ntimer;

    if (timer == 0) {
        timer = atimer;

    } else if (atimer) {
        timer = ngx_min(timer, atimer);
    }
    /* ... 残りも同じ形で最小を取る ... */

    if (timer) {
        ngx_add_timer(r->event, (ngx_msec_t) (timer * 1000));
    }
```

**4 本のキューをそれぞれ処理して、次に起きるべき時刻の最小値でタイマを張り直す。** [タイマのページ](../timer-rbtree/) の「最小値を取って待ち時間にする」と同じ構造が、リゾルバの中でもう一度実装されている。

`ngx_resolver_resend()` ([`#L1516-L1570`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_resolver.c#L1516-L1570))。

```c title="src/core/ngx_resolver.c"
    for ( ;; ) {
        if (ngx_queue_empty(queue)) {
            return 0;
        }

        q = ngx_queue_last(queue);

        rn = ngx_queue_data(q, ngx_resolver_node_t, queue);

        if (now < rn->expire) {
            return rn->expire - now;
        }
        /* ... */
        ngx_queue_remove(q);

        if (rn->waiting) {

            if (++rn->last_connection == r->connections.nelts) {
                rn->last_connection = 0;
            }

            (void) ngx_resolver_send_query(r, rn);

            rn->expire = now + r->resend_timeout;

            ngx_queue_insert_head(queue, q);

            continue;
        }

        ngx_rbtree_delete(tree, &rn->node);
```

**キューの末尾 (最も古い) から見て、期限が来ていなければそこで終わり。** 赤黒木を使わずキューで済むのは、`resend_timeout` が全ノードで同じ固定値だから。**追加は常に先頭、期限は常に単調増加**なので、キューがそのままソート済みになる。

[タイマのページ](../timer-rbtree/) で「タイムアウトの値が 1ms から 1 時間まで幅があるので赤黒木」と書いたが、ここは幅が無いのでキューで足りている。**同じ問題でも、値の分布が違えばデータ構造が変わる。**

再送のたびに `rn->last_connection` を進めているのが効いていて、**`resolver 10.0.0.2 10.0.0.3;` と複数書いてあれば、再送は別のサーバに飛ぶ**。1 台目が落ちていても 2 台目で拾える。

待ち手がいなくなっていたら (`rn->waiting == NULL`)、そのノードは捨てる。**問い合わせ中に全員が諦めた場合**で、応答が来ても行き先が無い。

### キャッシュの掃除

`ngx_resolver_expire()` ([`#L1241-L1274`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_resolver.c#L1241-L1274))。

```c title="src/core/ngx_resolver.c"
    for (i = 0; i < 2; i++) {
        if (ngx_queue_empty(queue)) {
            return;
        }

        q = ngx_queue_last(queue);

        rn = ngx_queue_data(q, ngx_resolver_node_t, queue);

        if (now <= rn->expire) {
            return;
        }
        /* ... */
        ngx_queue_remove(q);

        ngx_rbtree_delete(tree, &rn->node);

        ngx_resolver_free_node(r, rn);
    }
```

**1 回の呼び出しで最大 2 個しか捨てない。** [スラブアロケータのページ](../slab-shared-memory/) の `limit_req` が「1 回の確保で最大 3 個」だったのと同じ発想で、**掃除を少しずつに分けてレイテンシの尖りを避ける**。

呼ばれるのは新しい名前を解決しようとするときで、[接続の再利用のページ](../connection-reuse/) の `ngx_drain_connections()` と同じ「使うときに少し掃除する」形になっている。

### UDP で送って、切り詰められたら TCP

`ngx_resolver_send_query()` ([`#L1278-L1317`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_resolver.c#L1278-L1317))。

```c title="src/core/ngx_resolver.c"
    if (rn->query && rn->naddrs == (u_short) -1) {
        rc = rn->tcp ? ngx_resolver_send_tcp_query(r, rec, rn->query, rn->qlen)
                     : ngx_resolver_send_udp_query(r, rec, rn->query, rn->qlen);

        if (rc != NGX_OK) {
            return rc;
        }
    }
```

`rn->naddrs == (u_short) -1` が「まだ解決していない」の印。**A と AAAA を両方問い合わせるとき、片方だけ返ってきた状態**を表現するために、`naddrs` と `naddrs6` をそれぞれ `-1` で初期化してある。[設定マージのページ](../conf-merge/) の `NGX_CONF_UNSET` と同じ、「ありえない値で未設定を表す」形になっている。

UDP は接続してから送る ([`#L1320-L1355`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_resolver.c#L1320-L1355))。

```c title="src/core/ngx_resolver.c"
    if (rec->udp == NULL) {
        if (ngx_udp_connect(rec) != NGX_OK) {
            return NGX_ERROR;
        }

        rec->udp->data = rec;
        rec->udp->read->handler = ngx_resolver_udp_read;
        rec->udp->read->resolver = 1;
    }

    n = ngx_send(rec->udp, query, qlen);
```

**UDP ソケットを `connect()` してから使う。** これで送信先が固定され、`recv()` が他のホストからのパケットを受け取らなくなる。DNS のスプーフィング対策としての基本になっている。

`rec->udp->read->resolver = 1` は、[master/worker のページ](../master-worker/) で見た `ngx_worker_process_exit()` の判定で使われる。

```c title="src/os/unix/ngx_process_cycle.c"
            if (c[i].fd != -1
                && c[i].read
                && !c[i].read->accept
                && !c[i].read->channel
                && !c[i].read->resolver)
            {
                ngx_log_error(NGX_LOG_ALERT, cycle->log, 0,
```

**終了時に「まだ開いている接続がある」と警告する対象から、リゾルバの UDP ソケットを除外する。** リゾルバのソケットは常時開いているので、これが無いと終了のたびに警告が出る。

応答を受け取る側 ([`#L1579-L1614`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_resolver.c#L1579-L1614))。

```c title="src/core/ngx_resolver.c"
        if (n == NGX_ERROR) {
            goto failed;
        }

        ngx_resolver_process_response(rec->resolver, buf, n, 0);

    } while (rev->ready);

    if (ngx_handle_read_event(rev, 0) != NGX_OK) {
        goto failed;
    }
```

[イベントメソッドのページ](../event-methods/) と同じ `while (rev->ready)` + `ngx_handle_read_event()` の定型になっている。**リゾルバも普通のイベント駆動のコードとして書かれている。**

### 応答の照合

`ngx_resolver_process_response()` ([`#L1748-L1790`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_resolver.c#L1748-L1790))。

```c title="src/core/ngx_resolver.c"
    ident = (response->ident_hi << 8) + response->ident_lo;
    /* ... */
    trunc = flags & 0x0200;
    /* ... */
    if ((flags & 0xf870) != 0x8000 || (trunc && tcp)) {
        ngx_log_error(r->log_level, r->log, 0,
                      "invalid %s DNS response %ui fl:%04Xi",
                      tcp ? "TCP" : "UDP", ident, flags);
        return;
    }
```

**TCP で問い合わせたのに切り詰められた応答が返ってきたら、それは異常。** UDP なら普通に起きるので、TCP に切り替える。

ident の照合 ([`#L2012-L2021`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_resolver.c#L2012-L2021))。

```c title="src/core/ngx_resolver.c"
        qident = (rn->query[0] << 8) + rn->query[1];
    }

    if (ident != qident) {
        ngx_log_error(r->log_level, r->log, 0,
                      "wrong ident %ui in DNS response for %V, expect %ui",
                      ident, &name, qident);
        ngx_resolver_free(r, name.data);
        goto failed;
    }
```

**送ったクエリのバイト列の先頭 2 バイトから ident を取り出して比較する。** 別に保存せず、クエリそのものを保持している (`rn->query`) ので、そこから読む。**同じ情報を 2 箇所に持たない。**

ident は送信時にランダムで決める ([`#L3697-L3705`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_resolver.c#L3697-L3705))。

```c title="src/core/ngx_resolver.c"
    if (r->ipv4) {
        ident = ngx_random();

        ngx_log_debug2(NGX_LOG_DEBUG_CORE, r->log, 0,
                       "resolve: \"%V\" A %i", name, ident & 0xffff);

        query->ident_hi = (u_char) ((ident >> 8) & 0xff);
        query->ident_lo = (u_char) (ident & 0xff);
    }
```

`ngx_random()` の種は [master/worker のページ](../master-worker/) で見た `srandom(((unsigned) ngx_pid << 16) ^ tp->sec ^ tp->msec)` で、**ワーカーごとに違う系列**になる。

切り詰められていたら TCP で引き直す ([`#L2025-L2040`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_resolver.c#L2025-L2040))。

```c title="src/core/ngx_resolver.c"
    if (trunc) {

        ngx_queue_remove(&rn->queue);

        if (rn->waiting == NULL) {
            ngx_rbtree_delete(&r->name_rbtree, &rn->node);
            ngx_resolver_free_node(r, rn);
            goto next;
        }

        rec = r->connections.elts;
        rec = &rec[rn->last_connection];
```

**待ち手がいなければ捨てて終わり。** いるなら `rn->tcp = 1` にして TCP で送り直す。DNS の TCP フォールバックは RFC の要求で、SRV レコードや大量の A レコードで実際に必要になる。

### タイマは cancelable

リゾルバの再送タイマは、[タイマのページ](../timer-rbtree/) の `cancelable` が立っている ([`#L190-L194`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_resolver.c#L190-L194))。

```c title="src/core/ngx_resolver.c"
    r->event->handler = ngx_resolver_resend_handler;
    r->event->data = r;
    r->event->log = &cf->cycle->new_log;
    r->event->cancelable = 1;
    r->ident = -1;
```

**このタイマが残っているだけでは、ワーカーの終了を妨げない。** 再送タイマは常に張られているので、これが無かったら `nginx -s quit` が永久に完了しなくなる。

`r->ident = -1` の意味は、その上のコメントが説明している。

```c title="src/core/ngx_resolver.h"
struct ngx_resolver_s {
    /* has to be pointer because of "incomplete type" */
    ngx_event_t              *event;
    void                     *dummy;
    ngx_log_t                *log;

    /* event ident must be after 3 pointers as in ngx_connection_t */
    ngx_int_t                 ident;
```

**`ngx_resolver_t` の先頭 4 フィールドを、`ngx_connection_t` と同じレイアウトに揃えている。** デバッグログの `ngx_event_ident()` が「イベントの `data` を `ngx_connection_t *` とみなして `fd` を読む」ので、そこに `-1` が入っていれば「接続ではない」と表示される。

**構造体のレイアウトを合わせることで、型の違うものを同じ関数に渡している。** C でしか書けない類のハックで、コメントが無ければ絶対に分からない。

## なぜそうなっているか

### 4700 行を書く価値があった理由

DNS クライアントを自分で書くのは、普通は割に合わない。パーサのバグはセキュリティ問題になるし、RFC の細部は多い。それでも書いたのは、**代替案が全部ダメだったから**だ。

- `getaddrinfo()` を同期で呼ぶ → イベントループが止まる。論外。
- スレッドプールに逃がす → DNS が詰まると全スレッドが埋まる。しかも `getaddrinfo()` はスレッドあたりのコストが高い。
- 外部の非同期 DNS ライブラリ (c-ares など) を使う → Nginx は外部依存を OpenSSL / zlib / PCRE の 3 つに絞っている。

そして **必要な機能が限られている**ことも大きい。Nginx が引くのは A / AAAA / SRV / PTR だけで、`/etc/nsswitch.conf` の機構も、`/etc/hosts` も、mDNS も要らない。**DNS のサブセットに絞れば、4700 行に収まる。**

### `/etc/resolv.conf` を読まないことの意味

`resolver` ディレクティブを書かないと、変数を使った `proxy_pass` は動かない。`"no resolver defined to resolve ..."` というエラーになる。これは Nginx を使う人が一度は踏む落とし穴になっている。

読まない理由は、`resolv.conf` が **起動後に変わりうる**ことと、その中身が `getaddrinfo()` の挙動全体 (検索ドメイン、`ndots`、`options`) を規定していて、**一部だけ真似すると挙動が食い違う**からだろう。中途半端に対応するより、明示的に書かせるほうが予測可能になる。

**自前実装を選ぶと、OS の設定機構から切り離される。** これは自前実装の一般的なコストで、Nginx はそれを「設定に書け」という形でユーザーに転嫁している。設定ファイルに書いてある以上、`nginx -T` で確認できるという利点はある。

### 待ち手の合流が、キャッシュより効く場面

キャッシュがあれば十分に見えるが、**キャッシュが埋まる前の瞬間**が問題になる。ワーカーが起動した直後や、TTL が切れた直後に 1000 リクエストが同時に来ると、キャッシュだけでは 1000 発の DNS クエリが飛ぶ。

`rn->waiting` のリストがあると、**2 番目以降のリクエストは「問い合わせ中のノード」を見つけて並ぶだけ**になる。DNS に飛ぶのは 1 発。

これは cache stampede に対する標準的な対策 (単一フライト) で、Go の `singleflight` や Ruby の `Concurrent::Promise` と同じことをしている。**キャッシュを作るときは、「ミス時の同時アクセス」を必ず考える**という教訓になる。

### キューと赤黒木の使い分け

再送は期限順のキュー、キャッシュはキーで引く赤黒木、寿命は LRU キュー。同じノードが 2 つのコンテナに同時に入る。

`resend_queue` がキューで済むのは、**`resend_timeout` が全ノードで同じ固定値**だからだ。追加は常に「今 + 5 秒」なので、追加順 = 期限順になる。挿入は先頭に O(1)、最小値の取得は末尾を見るだけで O(1)。

[タイマのページ](../timer-rbtree/) の一般のタイマは、値が 1ms から 1 時間まで幅があるので赤黒木が要る。**同じ「期限順に処理する」でも、値の分布によって最適なデータ構造が変わる**という例になっている。

### `ctx->handler` が同期的に呼ばれること

キャッシュヒットのとき、`ngx_resolve_name()` は handler を呼んでから戻る。呼び出し側は `NGX_OK` と `ctx->state` を見て判断することになる。

これは非同期 API の設計として **危うい**部類で、「コールバックが呼ばれるのは関数から戻った後」という前提を置けない。実際、`ngx_http_upstream_resolve_handler()` は「まだ `ngx_resolve_name()` から戻っていない状態」で呼ばれることを想定して書かれている。

Node.js の `process.nextTick` や、Rust の `Poll::Ready` のように、**「即座に完了した場合」を明示的に扱う仕組みがある言語なら避けられる**問題だ。C では、この種の「同期にも非同期にもなる関数」が自然に生まれてしまう。

### `ident` を保存せずクエリから読む

送ったクエリのバイト列 (`rn->query`) を保持しているので、ident はそこから読める。専用のフィールドを持たない。

理由は 2 つあって、1 つは **再送のためにクエリのバイト列自体が必要**なこと。もう 1 つは **同じ情報を 2 箇所に持つと、ずれる可能性が生まれる**こと。再送時に ident を変えるなら両方を更新しなければならない (実際には変えない) が、1 箇所しか無ければその心配が消える。

## どう活かすか

### そのまま真似できるところ

**「起動時はブロックしてよい、実行時はダメ」という線を引く。** 全部を非同期にするのではなく、頻度と影響で分ける。Nginx は同じ「名前解決」という機能に対して、起動時と実行時で別の実装を使っている。

**キャッシュを作るなら、ミス時の同時アクセスを必ず設計に入れる。** 「問い合わせ中」のエントリを作って、2 番目以降の要求をそこに合流させる。キャッシュだけだと、TTL 切れの瞬間に下流が殺到する。

**「有効期限」と「破棄期限」を分ける。** `valid` (結果を信じてよい時刻) と `expire` (エントリを捨てる時刻)。分けておくと、再問い合わせの間もエントリを保持でき、待ち手のリストを維持できる。

**掃除を「使うたびに少しずつ」にする。** 1 回の呼び出しで 2 個。まとめて掃除するとレイテンシが尖る。

**期限が固定なら、キューで足りる。** 追加順 = 期限順になるので、ソート済みのリストとして扱える。値に幅があるときだけ木を使う。

**複数のバックエンドを、再試行のたびにローテーションする。** `rn->last_connection` を進めるだけ。1 台目が落ちていても 2 台目で拾える。

**同じ情報を 2 箇所に持たない。** ident をクエリのバイト列から読む。保持しているデータから導出できるなら、フィールドを増やさない。

**タイムアウトを「送る側の都合」と「待つ側の都合」で分ける。** `resend_timeout` (DNS に再送する間隔) と `resolver_timeout` (リクエストが諦める時刻) は別物。混ぜると、片方を変えたときにもう片方が壊れる。

**常駐タイマには「終了を妨げない」印を付ける。** [タイマのページ](../timer-rbtree/) の `cancelable`。これが無いと graceful shutdown が完了しない。

**UDP ソケットは `connect()` してから使う。** 送信先が固定され、他のホストからのパケットを受け取らなくなる。

### 取り込むべきでない条件

**プロトコルクライアントの自前実装は、最後の手段。** 4700 行のパーサはセキュリティ的な攻撃面になる。実際、Nginx の resolver には過去に脆弱性が報告されている。既存の非同期 DNS ライブラリを使えるなら、そちらのほうがいい。Nginx が自前なのは、外部依存を極限まで絞る方針と、必要な機能が DNS のサブセットで済むことの両方が成立したからだ。

**OS の設定機構から切り離される。** `/etc/resolv.conf` も `/etc/hosts` も効かない。コンテナ環境では特に驚かれる挙動になっている。自前実装を選ぶなら、このコストをドキュメントに明記する必要がある。

**同期にも非同期にもなる関数は、呼び出し側を難しくする。** キャッシュヒット時に handler が同期的に呼ばれる設計は、「戻ってから呼ばれる」という前提を壊す。「必ず次のイベントループで呼ぶ」に統一できるなら、そのほうが安全になる。

**構造体のレイアウトを合わせて型を偽装するのは、C だから書けるだけ。** `ngx_resolver_t` の先頭を `ngx_connection_t` に揃えるハックは、コメントが 1 行消えたら誰にも分からなくなる。フィールドを 1 つ足すか、関数を分けるほうがいい。

## 関連

- ディスク I/O を外に出す話は [ブロックする I/O のページ](../blocking-io/)。同じ「ループを止めない」という動機で、まったく違う解き方になっている。
- `cancelable` タイマと「最小値でタイマを張る」構造は [タイマのページ](../timer-rbtree/)。
- 侵入型の赤黒木 + LRU キューという組み合わせは [スラブアロケータのページ](../slab-shared-memory/) の `limit_req` にも出てくる。
- 解決結果を使う側は [upstream と event_pipe のページ](../upstream-event-pipe/)。

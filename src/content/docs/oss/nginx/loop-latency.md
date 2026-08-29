---
title: "1 周が長くなる操作を全部見つけて、それぞれに上限を置く"
description: "1 スレッドのイベントループでは、1 周の長さが全接続のレイテンシの下限になる。Nginx は「1 回にどれだけやるか」を至るところで区切っている。sendfile は 2MB ごと、accept は 1 回に 1 本、キャッシュの掃除は 2〜3 個、iovec は IOV_MAX。区切ったあとの残りは次の周に譲り、待たせたい相手にはタイマを張る。"
group: "設計の掘り下げ"
sidebar:
  order: 41
---

## 何を学んだか

### どんな状況の話か

[ワーカーの 1 周のページ](../state-machine/) のとおり、ワーカーは 1 スレッドで数万接続を回す。ループ 1 周は「`epoll_wait` で起きて、返ってきたイベントの handler を順に呼んで、タイマを処理して、また寝る」。

このとき、**1 周にかかる時間が、全接続の応答レイテンシの下限になる**。1 周が 50ms かかるなら、その 50ms の間に届いたデータは最大 50ms 待たされる。1 接続の処理を速くすることより、**「1 周を短く保つ」ことのほうが全体の品質を決める**。

ところが、1 周を長くする操作はいくらでもある。

- 10GB のファイルを `sendfile()` で送ろうとする
- accept キューに 5000 本溜まっているのを全部受ける
- キャッシュが満杯になって、期限切れを全部掃除する
- 100MB のレスポンスを一気に gzip する
- 数万個の buf を 1 回の `writev()` で送ろうとする

どれも「1 回でやりきる」ほうが効率がよく見える。だが 1 周が伸びる。

### Nginx の答え

**「1 回にどれだけやるか」を、思いつく限りの場所で区切っている。** そして区切り方が 5 種類に分類できる。

1. **1 回の処理量に上限を置く。** `sendfile_max_chunk` は 2MB、`writev` の `iovec` は `IOV_MAX`、accept は 1 回の通知につき 1 本。
2. **掃除・回収を分割する。** `limit_req` のキャッシュ掃除は 1 回に最大 3 個、リゾルバは 2 個、接続の追い出しは 32 個。
3. **残りを次の周に譲る。** `ngx_posted_next_events` に自分を積み直して `return` する。
4. **小さすぎる出力を溜めてから出す。** `postpone_output` は 1460 バイト、`postpone_gzipping` はバッファが埋まるまで圧縮しない。
5. **待たせたい相手には、タイマを張って中断する。** `limit_rate` も `limit_req` の `delay` も、CPU を回さずに時間で待つ。

そして **「1 周が伸びたことを検出する手段」** が副産物として存在する。時刻キャッシュのずれと、エラーログの `while ...` がそれだ。

## ソースコードのどこか

### 1 回の送信量に上限を置く

[出力フィルタチェーンのページ](../output-filter-chain/) で見た `ngx_http_write_filter` の `limit` の計算 ([`src/http/ngx_http_write_filter_module.c#L263-L299`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_write_filter_module.c#L263-L299))。

```c title="src/http/ngx_http_write_filter_module.c"
    if (r->limit_rate) {
        /* ... limit_rate から limit を計算 ... */
        if (clcf->sendfile_max_chunk
            && (off_t) clcf->sendfile_max_chunk < limit)
        {
            limit = clcf->sendfile_max_chunk;
        }

    } else {
        limit = clcf->sendfile_max_chunk;
    }

    sent = c->sent;
    /* ... */
    chain = c->send_chain(c, r->out, limit);
```

`sendfile_max_chunk` の既定は 2MB ([`src/http/ngx_http_core_module.c#L3903-L3904`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_core_module.c#L3903-L3904))。

```c title="src/http/ngx_http_core_module.c"
    ngx_conf_merge_size_value(conf->sendfile_max_chunk,
                              prev->sendfile_max_chunk, 2 * 1024 * 1024);
```

**`sendfile()` は途中で戻ってこない。** 10GB のファイルを 1 回の syscall で渡したら、送り終わるかソケットバッファが埋まるまでカーネルの中にいる。ページキャッシュに載っていなければディスクも待つ ([ブロックする I/O のページ](../blocking-io/))。

2MB で区切ると、1 回の `sendfile()` が返ってくる時間の上限が読める。残りは次の呼び出しで送る。

この値は長い間 0 (無制限) が既定だったが、1.21.4 で 2MB になった。**「大きなファイルを配ると他の接続のレイテンシが跳ねる」という現象が、既定値を変えるに足るほど広く踏まれた**ということになる。

### 残りを次の周に譲る

区切ったら、残りをいつ送るか。`ngx_http_write_filter` の末尾 ([`#L334-L336`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_write_filter_module.c#L334-L336))。

```c title="src/http/ngx_http_write_filter_module.c"
    if (chain && c->write->ready && !c->write->delayed) {
        ngx_post_event(c->write, &ngx_posted_next_events);
    }
```

**「まだ送るものがあり、しかもソケットはまだ書ける」= 自分の都合で区切った**ということなので、次の周に自分を起こす予約を入れる。

`epoll` は「書ける」と言い続けているわけではない ([イベントメソッドのページ](../event-methods/) の edge-triggered)。書き切っていないのに通知を待つと、二度と起きない。かといってその場でループするとまた 1 周が伸びる。**`ngx_posted_next_events` が、この 2 つの間の第 3 の選択肢になっている。**

キューの実体は [ワーカーの 1 周のページ](../state-machine/) で見た 60 行だ ([`src/event/ngx_event_posted.c#L39-L60`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/ngx_event_posted.c#L39-L60))。

```c title="src/event/ngx_event_posted.c"
void
ngx_event_move_posted_next(ngx_cycle_t *cycle)
{
    ngx_queue_t  *q;
    ngx_event_t  *ev;

    for (q = ngx_queue_head(&ngx_posted_next_events);
         q != ngx_queue_sentinel(&ngx_posted_next_events);
         q = ngx_queue_next(q))
    {
        ev = ngx_queue_data(q, ngx_event_t, queue);
        /* ... */
        ev->ready = 1;
        ev->available = -1;
    }

    ngx_queue_add(&ngx_posted_events, &ngx_posted_next_events);
    ngx_queue_init(&ngx_posted_next_events);
}
```

**次の周の頭で `ready = 1` と `available = -1` を立ててから、通常のポストキューに合流させる。** `available = -1` は「あと何バイト読めるか分からない」で、[イベントメソッドのページ](../event-methods/) の `ngx_unix_recv()` の追跡をリセットしている。

そして、このキューが空でなければ `epoll_wait` のタイムアウトを 0 にする ([`src/event/ngx_event.c#L241-L244`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/ngx_event.c#L241-L244))。

```c title="src/event/ngx_event.c"
    if (!ngx_queue_empty(&ngx_posted_next_events)) {
        ngx_event_move_posted_next(cycle);
        timer = 0;
    }
```

**「次の周に譲る」は「待たない」を意味する。** `epoll_wait(ep, list, n, 0)` は即座に返るので、新しく届いたイベントを拾ってから、譲られた処理を再開する。**1 周を挟むことで、他の接続に順番が回る。**

### accept を 1 回に 1 本にする

[accept の分配のページ](../accept-distribution/) で見た `multi_accept` ([`src/event/ngx_event_accept.c#L47-L58`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/ngx_event_accept.c#L47-L58))。

```c title="src/event/ngx_event_accept.c"
    if (!(ngx_event_flags & NGX_USE_KQUEUE_EVENT)) {
        ev->available = ecf->multi_accept;
    }

    lc = ev->data;
    ls = lc->listening;
    ev->ready = 0;

    do {
        socklen = sizeof(ngx_sockaddr_t);
        /* ... accept4() ... */
    } while (ev->available);
```

既定 `multi_accept off` なので `ev->available = 0`、**1 回の通知につき 1 本だけ accept する。**

accept キューに 5000 本溜まっている状況で `multi_accept on` にすると、1 周のうちに 5000 本の `accept4()` + `ngx_get_connection()` + プール作成が走る。その間、既存の接続は 1 バイトも処理されない。

`accept` の分配 (他ワーカーに順番を回す) の観点で説明したが、**1 周の長さの観点でも同じ既定値が正しい**ことになる。1 つの設定が 2 つの理由で同じ方向を向いている。

### 掃除を分割する

3 箇所で同じ形が出てくる。

[スラブアロケータのページ](../slab-shared-memory/) の `limit_req` ([`src/http/modules/ngx_http_limit_req_module.c#L644-L650`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/modules/ngx_http_limit_req_module.c#L644-L650))。

```c title="src/http/modules/ngx_http_limit_req_module.c"
    /*
     * n == 1 deletes one or two zero rate entries
     * n == 0 deletes oldest entry by force
     *        and one or two zero rate entries
     */

    while (n < 3) {
```

[DNS リゾルバのページ](../resolver/) のキャッシュ掃除 ([`src/core/ngx_resolver.c#L1252`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_resolver.c#L1252))。

```c title="src/core/ngx_resolver.c"
    for (i = 0; i < 2; i++) {
```

[接続の再利用のページ](../connection-reuse/) の追い出し ([`src/core/ngx_connection.c#L1427`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_connection.c#L1427))。

```c title="src/core/ngx_connection.c"
    n = ngx_max(ngx_min(32, cycle->reusable_connections_n / 8), 1);
```

**どれも「使うときに、少しだけ掃除する」**という同じ形をしている。GC でいうインクリメンタル回収で、**まとめて掃除する日を作らない**。

数字が 2 / 3 / 32 とばらばらなのは、1 個あたりのコストが違うからだ。リゾルバのノード解放は文字列とアドレス配列の解放を伴う。接続の追い出しは `c->read->handler(c->read)` を呼ぶので、その中で SSL のシャットダウンまで走りうる。**コストに応じて回数を決めている**が、根拠は測定にしかない。

### 小さすぎる出力を溜める

[出力フィルタチェーンのページ](../output-filter-chain/) の `postpone_output` ([`src/http/ngx_http_write_filter_module.c#L213-L221`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_write_filter_module.c#L213-L221))。

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

既定 1460 バイト = イーサネットの 1 MSS。**1 周あたりの `writev()` の回数を減らす**方向の最適化で、これまでの 4 つとは向きが逆に見える。

実際には同じ目的を向いている。`writev()` は syscall で、1 回あたり数マイクロ秒。100 バイトずつ 20 回書くのと 2000 バイトを 1 回書くのでは、**後者のほうが 1 周が短い**。「1 回の量を減らす」のは、**1 回が長すぎるとき**の話であって、短すぎるものは逆にまとめる。

gzip も同じ形を持っている ([`src/http/modules/ngx_http_gzip_filter_module.c#L274`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/modules/ngx_http_gzip_filter_module.c#L274))。

```c title="src/http/modules/ngx_http_gzip_filter_module.c"
    ctx->buffering = (conf->postpone_gzipping != 0);
```

`postpone_gzipping` が 0 でなければ、その量が溜まるまで `deflate()` を呼ばない。**zlib の呼び出しあたりのオーバーヘッドを、まとめることで償却する。**

[upstream と event_pipe のページ](../upstream-event-pipe/) の `busy_size` も、向きは違うが同じ族になる。**「下流に渡したまま返ってこない量」に上限を置く**ことで、1 周で扱うバッファの数が発散しないようにしている。

### `iovec` の数に上限がある

[buf と chain のページ](../buf-chain/) で見た `ngx_output_chain_to_iovec()` ([`src/os/unix/ngx_writev_chain.c#L160-L162`](https://github.com/nginx/nginx/blob/release-1.31.4/src/os/unix/ngx_writev_chain.c#L160-L162))。

```c title="src/os/unix/ngx_writev_chain.c"
            if (n == vec->nalloc) {
                break;
            }
```

`nalloc` は `NGX_IOVS_PREALLOCATE` で、`IOV_MAX` (Linux では 1024) か、それが取れなければ 64 ([`src/os/unix/ngx_os.h#L56-L61`](https://github.com/nginx/nginx/blob/release-1.31.4/src/os/unix/ngx_os.h#L56-L61))。

```c title="src/os/unix/ngx_os.h"
#define NGX_IOVS_PREALLOCATE  64
/* ... */
#define NGX_IOVS_PREALLOCATE  IOV_MAX
```

これは **カーネルが課した上限**であって Nginx の判断ではないが、結果として同じ効果を持つ。チェーンに 10 万個の buf があっても、1 回の `writev()` は 1024 個まで。残りは次の呼び出しになる。

**カーネルの API が既に「1 回の量」を区切っている**という例で、そこに合わせて「途中で `break` して残りを返す」形にしておけば、上位の再開ロジックがそのまま使える。

### 待たせたい相手はタイマで待たせる

`limit_rate` を超えたときの処理 ([`src/http/ngx_http_write_filter_module.c#L271-L282`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_write_filter_module.c#L271-L282))。

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

**`delayed = 1` を立てて、タイマを張って帰る。** CPU を 1 サイクルも使わずに待つ。

`delayed` フラグは [ワーカーの 1 周のページ](../state-machine/) の `ngx_http_request_handler` で解除される。

```c title="src/http/ngx_http_request.c"
    if (ev->delayed && ev->timedout) {
        ev->delayed = 0;
        ev->timedout = 0;
    }
```

**「タイマで起こされた」と「本当にタイムアウトした」を、`delayed` の有無で区別する。** [タイマのページ](../timer-rbtree/) のタイマは 1 種類しかないので、意味は使う側が付ける。

同じ形が `limit_req` の `delay` にも、[accept の分配のページ](../accept-distribution/) の `ngx_event_accept` の `EMFILE` バックオフにもある。**「今はできない」を、ビジーループではなく時間で表現する**という共通の形になっている。

### 1 周が伸びたことを検出する

[タイマのページ](../timer-rbtree/) で見たとおり、現在時刻は 1 周に 1 回しか更新されない。

```c title="src/event/modules/ngx_epoll_module.c"
    events = epoll_wait(ep, event_list, (int) nevents, timer);

    err = (events == -1) ? ngx_errno : 0;

    if (flags & NGX_UPDATE_TIME || ngx_event_timer_alarm) {
        ngx_time_update();
    }
```

**これは制約であると同時に、指標でもある。** アクセスログの `$request_time` や `$msec` が実際の時刻からずれていれば、1 周が長い。デバッグログの `"timer delta: %M"` ([`src/event/ngx_event.c#L252-L253`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/ngx_event.c#L252-L253)) はまさに 1 周の長さを出している。

```c title="src/event/ngx_event.c"
    ngx_log_debug1(NGX_LOG_DEBUG_EVENT, cycle->log, 0,
                   "timer delta: %M", delta);
```

もう 1 つが `log->action` で、[upstream と event_pipe のページ](../upstream-event-pipe/) で見たとおり `ngx_event_pipe` は "sending to client" と "reading upstream" を切り替えている。

```c title="src/event/ngx_event_pipe.c"
        if (do_write) {
            p->log->action = "sending to client";
            /* ... */
        }
        /* ... */
        p->log->action = "reading upstream";
```

エラーログの `while sending to client` の部分がこれで、**タイムアウトしたときに「何をしていたか」が残る。**

### 諦めるための上限

`worker_shutdown_timeout` は、区切りの最終形になる ([`src/core/ngx_cycle.c#L1436-L1451`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_cycle.c#L1436-L1451))。

```c title="src/core/ngx_cycle.c"
void
ngx_set_shutdown_timer(ngx_cycle_t *cycle)
{
    ngx_core_conf_t  *ccf;

    ccf = (ngx_core_conf_t *) ngx_get_conf(cycle->conf_ctx, ngx_core_module);

    if (ccf->shutdown_timeout) {
        ngx_shutdown_event.handler = ngx_shutdown_timer_handler;
        ngx_shutdown_event.data = cycle;
        ngx_shutdown_event.log = cycle->log;
        ngx_shutdown_event.cancelable = 1;

        ngx_add_timer(&ngx_shutdown_event, ccf->shutdown_timeout);
    }
}
```

[ワーカーの 1 周のページ](../state-machine/) の graceful shutdown は、全接続が終わるまで待つ。WebSocket や長いダウンロードが 1 本残っていれば、ワーカーは終わらない。

`worker_shutdown_timeout` を設定すると、その時刻で **残っている接続を全部切る**。`cancelable = 1` なので、[タイマのページ](../timer-rbtree/) の「このタイマだけなら終わってよい」判定を妨げない。

**「いつか終わる」を「必ずこの時刻までに終わる」に変える。** 既定は 0 (無制限) で、設定した人だけが上限を持つ。

## なぜそうなっているか

### 「1 回にどれだけ」が設計の単位になっている

Nginx のコードを横断して見ると、**「ループを回す」書き方がほとんど無い**ことに気づく。あるのは「上限まで回して、残りを返す」か「上限まで回して、次の周に譲る」のどちらかだ。

`ngx_event_pipe` の 4 段の逃げ道 ([upstream と event_pipe のページ](../upstream-event-pipe/))、`ngx_http_write_filter` の `limit`、`ngx_drain_connections` の 32、`ngx_resolver_expire` の 2。**全部が「途中でやめて、後で続きをやる」形になっている。**

これは [ワーカーの 1 周のページ](../state-machine/) の中断・再開の仕組みがあるから書ける。`NGX_AGAIN` を返して状態を構造体に残せるので、**どこで区切っても再開できる**。逆に言えば、ステートマシン化の投資が、レイテンシ制御の自由度として回収されている。

### 定数の根拠が測定にしかない

2MB、1460 バイト、32 個、3 個、2 個、`d->failed > 4` ([メモリプールのページ](../memory-pool/))、`large` の探索 4 個。**どれもコメントに根拠が書かれていない。**

これらは「Nginx のワークロードで測ったらこのあたりだった」という値で、理屈で導出されたものではない。1460 だけは MSS という根拠があるが、それも「イーサネットの MTU 1500 から IP と TCP のヘッダを引いた値」という環境依存の数字だ。

**魔法の数字が多いことは、このコードベースの弱点でもある。** ワークロードが違えば最適値も違うのに、変えられるのは設定になっているものだけ (`sendfile_max_chunk`、`postpone_output`、`multi_accept`) で、`ngx_drain_connections` の 32 も `ngx_resolver_expire` の 2 も動かせない。

### 「まとめる」と「区切る」が同居する理由

`postpone_output` は溜めてから出す、`sendfile_max_chunk` は区切って出す。逆向きに見えるが、**どちらも「syscall あたりの効率」と「1 周の長さ」のバランスを取っている**。

- 1 回が小さすぎる → syscall の回数が増える → 1 周が伸びる → **まとめる**
- 1 回が大きすぎる → 1 回の syscall が長い → 1 周が伸びる → **区切る**

**最適な 1 回のサイズには下限と上限がある**ということで、`postpone_output` (1460) と `sendfile_max_chunk` (2MB) が、その下限と上限を表している。3 桁の開きがあるので、その間ならどこでもよい。

### 時刻キャッシュが指標になるのは偶然ではない

[タイマのページ](../timer-rbtree/) では「1 周に 1 回しか時刻を更新しないので、長い処理をすると時刻が止まる」を制約として書いた。裏返すと、**ログのタイムスタンプの粒度が、そのまま 1 周の長さになる**。

これは設計として意図されたものではなく、**「時刻を毎回取らない」という最適化の副作用**だ。それでも、運用でアクセスログを見たときに同じミリ秒のエントリが並んでいれば、その周で何本処理したかが分かる。

**制約と観測手段が同じものから出てくる**というのは、シンプルな設計にたまに起きる副産物になっている。

### `log->action` は 1 周の中身を残す唯一の手段

タイムアウトしたときのエラーログに `while reading upstream` が出るのは、`p->log->action` を切り替えているからだ。

1 スレッドのイベントループでは、**スタックトレースが役に立たない**。問題が起きた時点のスタックは `epoll_wait` から数段しかなく、「どのリクエストが遅かったか」も「何をしていたか」も残らない。

`log->action` は、その穴を埋める最小限の仕組みになっている。文字列リテラルへのポインタを 1 つ書き換えるだけなので、コストはほぼゼロ。**ホットパスに置ける観測手段として、この粒度が上限**ということでもある。

## どう活かすか

### そのまま真似できるところ

**イベントループを持つなら、「1 周の長さ」を明示的な設計目標にする。** 個々の処理を速くするより、1 周に上限を置くほうが、全体のレイテンシ分布が良くなる。

**「1 回にどれだけやるか」を、ループを書くたびに決める。** `while (残りがある)` と書きそうになったら、`for (i = 0; i < N && 残りがある; i++)` にできないかを考える。残りは次の機会に回す。

**区切ったあとの再開手段を先に用意する。** 「次の周に自分を起こす」キューが 1 本あると、「途中でやめる」が安全な選択肢になる。無いと、途中でやめた処理が二度と再開されない。

**最適な 1 回のサイズには下限と上限がある。** 小さすぎれば syscall の回数で損し、大きすぎれば 1 回の長さで損する。両方の閾値を持つ。

**掃除・回収は「使うたびに少しずつ」。** 「満杯になったらまとめて」はレイテンシが尖る。1 回の上限を定数で決めておくと、最悪ケースが読める。

**待たせたい相手は、ビジーループではなくタイマで待たせる。** レート制限も、リソース枯渇時のバックオフも、`delayed = 1` + タイマ。CPU を使わずに待てる。

**「タイマで起こされた」と「タイムアウトした」を区別できるフラグを持つ。** タイマが 1 種類しかないなら、意味は使う側が付ける必要がある。

**1 周の長さを観測する手段を、ホットパスに置ける粒度で 1 つ持つ。** 文字列リテラルへのポインタを書き換えるだけの `log->action` は、コストがほぼゼロで、タイムアウト時の原因切り分けに直結する。イベントループではスタックトレースが役に立たないので、これが唯一の手掛かりになる。

**「いつか終わる」に上限を付ける手段を用意する。** graceful shutdown が完了しないのは運用でよく踏む。既定は無制限でも、設定で上限を付けられるようにしておく。

### 取り込むべきでない条件

**魔法の数字を、そのまま持ち込まない。** 2MB も 32 も 3 も、Nginx のワークロードで測った値だ。自分のワークロードで測り直すか、少なくとも「なぜその値か」を説明できるようにする。Nginx 自身、`sendfile_max_chunk` の既定を 0 から 2MB に変えるのに 15 年かけている。

**設定にしていない上限は、後から変えられない。** `ngx_drain_connections()` の 32 も `ngx_resolver_expire()` の 2 も定数で、ユーザーは動かせない。どの上限を設定可能にするかは、それ自体が設計判断になる。

**「1 周を短く」は、スループットとトレードオフになる。** `multi_accept off` は accept のスループットを落とすし、`sendfile_max_chunk 2m` は大きなファイルの転送効率を少し落とす。レイテンシが重要でないワークロード (バッチ配信、内部向けのファイルサーバ) では、逆の設定が正しい。

**ワーカーが 1 スレッドでない環境では、前提が変わる。** マルチスレッドのランタイムなら、1 つのタスクが長くても他のスレッドが進む。「1 周の長さ」がレイテンシを決めるのは、シングルスレッドのイベントループに固有の性質だ。

## 関連

- 中断・再開の基本形と `ngx_posted_next_events` は [ワーカーの 1 周のページ](../state-machine/)。
- `sendfile_max_chunk` と `postpone_output` を使う側は [出力フィルタチェーンのページ](../output-filter-chain/)。
- 掃除の分割は [スラブアロケータ](../slab-shared-memory/) / [接続の再利用](../connection-reuse/) / [DNS リゾルバ](../resolver/) の 3 ページに出てくる。
- 時刻キャッシュの粒度が指標になる話は [タイマのページ](../timer-rbtree/)。
- `sendfile()` がディスクを待つ問題そのものは [ブロックする I/O のページ](../blocking-io/)。

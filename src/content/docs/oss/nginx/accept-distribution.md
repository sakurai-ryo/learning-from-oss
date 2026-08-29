---
title: "「起こしたワーカー全員が空振りする」問題を、ロックからカーネルの分配に移していった経緯"
description: "全ワーカーが同じ listen ソケットを持つと、1 本の接続で全員が起きて 1 人しか成功しない。Nginx はこれを共有メモリのミューテックスで解き、次に EPOLLEXCLUSIVE に移し、最終的に SO_REUSEPORT でソケットごと分けた。3 つの解法がコードに同居していて、優先順位が if の並びとして読める。ワーカーが自分の混み具合を見て accept を控える ngx_accept_disabled も入っている。"
group: "設計の掘り下げ"
sidebar:
  order: 38
---

## 何を学んだか

### どんな状況の話か

[master/worker のページ](../master-worker/) のとおり、リスニングソケットは fork の前に開かれる。つまり **全ワーカーが同じ fd を持っている**。これは意図した設計で、どのワーカーでも `accept()` できるから負荷が分散する。

ところが、素直に全員が `epoll` にその fd を登録すると、接続が 1 本来たときに全員が起こされる。実際に `accept()` に成功するのは 1 人で、残りは `EAGAIN` を食って寝直す。ワーカーが 32 個いれば 31 回ぶんの起床が無駄になる。thundering herd と呼ばれるやつだ。

さらに厄介なのは公平性で、素朴にやると特定のワーカーばかりが接続を取る。ワーカーごとに `worker_connections` の上限があるので、偏ると片方だけが先に枯れる。

### Nginx の答え

**3 世代ぶんの解法がコードに同居している。** 環境と設定に応じてどれか 1 つが選ばれ、選択のロジックは `ngx_event_process_init()` の `if` の並びとして読める。

1. **`accept_mutex` (第 1 世代)。** 共有メモリ上のミューテックスを `trylock` できたワーカーだけが、リスニングソケットを `epoll` に登録する。取れなかったワーカーは登録を外す。起きるのは常に 1 人になる。Nginx 1.11.3 で既定が off になった。
2. **`EPOLLEXCLUSIVE` (第 2 世代、Linux 4.5+)。** 全員が登録したまま、カーネルに「1 人だけ起こせ」と頼む。ロックが要らない。ただしカーネルは登録順で最初のプロセスばかり起こす傾向があるので、Nginx 側で **16 接続ごとに登録し直して順番を回す**。
3. **`SO_REUSEPORT` (第 3 世代)。** リスニングソケットをワーカーの数だけ **別々に開く**。同じポートに複数のソケットが bind でき、カーネルが接続を 4-tuple のハッシュで振り分ける。ワーカー間の調整が完全に不要になる。
4. **どれでもない場合は全員登録。** ワーカーが 1 個なら、そもそも競合しない。

加えて、**ワーカーが自分の混み具合を見て accept を辞退する** 仕組みがある。`ngx_accept_disabled` が正のあいだは accept ロックを取りに行かず、1 ループごとに 1 ずつ減る。

## ソースコードのどこか

### どれを使うかの判断

[`src/event/ngx_event.c#L894-L940`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/ngx_event.c#L894-L940)。ワーカーの起動時、リスニングソケットごとに走る。

```c title="src/event/ngx_event.c"
        if (c->type == SOCK_STREAM) {
            rev->handler = ngx_event_accept;

#if (NGX_QUIC)
        } else if (ls[i].quic) {
            rev->handler = ngx_quic_recvmsg;
#endif
        } else {
            rev->handler = ngx_event_recvmsg;
        }

#if (NGX_HAVE_REUSEPORT)

        if (ls[i].reuseport) {
            if (ngx_add_event(rev, NGX_READ_EVENT, 0) == NGX_ERROR) {
                return NGX_ERROR;
            }

            continue;                        /* ← 第 3 世代。ここで終わり */
        }

#endif

        if (ngx_use_accept_mutex) {
            continue;                        /* ← 第 1 世代。今は登録しない */
        }

#if (NGX_HAVE_EPOLLEXCLUSIVE)

        if ((ngx_event_flags & NGX_USE_EPOLL_EVENT)
            && ccf->worker_processes > 1)
        {
            ngx_use_exclusive_accept = 1;    /* ← 第 2 世代 */

            if (ngx_add_event(rev, NGX_READ_EVENT, NGX_EXCLUSIVE_EVENT)
                == NGX_ERROR)
            {
                return NGX_ERROR;
            }

            continue;
        }
#endif
        /* ← どれでもない。素直に登録 */
```

優先順位が `reuseport` → `accept_mutex` → `EPOLLEXCLUSIVE` → 素朴、と読める。`accept_mutex` が `EPOLLEXCLUSIVE` より先に来ているのは、明示的に `accept_mutex on;` と書かれたときにそれを尊重するため。既定値は off なので ([`#L1369`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/ngx_event.c#L1369))、Linux では通常 `EPOLLEXCLUSIVE` が選ばれる。

```c title="src/event/ngx_event.c"
    ngx_conf_init_value(ecf->accept_mutex, 0);
```

`ngx_use_accept_mutex` が立つ条件も限定的だ ([`#L649-L656`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/ngx_event.c#L649-L656))。

```c title="src/event/ngx_event.c"
    if (ccf->master && ccf->worker_processes > 1 && ecf->accept_mutex) {
        ngx_use_accept_mutex = 1;
        ngx_accept_mutex_held = 0;
        ngx_accept_mutex_delay = ecf->accept_mutex_delay;

    } else {
        ngx_use_accept_mutex = 0;
    }
```

ワーカーが 1 個なら競合しないので使わない。同じ判定が `EPOLLEXCLUSIVE` 側にもある (`ccf->worker_processes > 1`)。**競合が起きない状況では調整機構を丸ごと消す** という形になっている。

### 第 1 世代: accept_mutex

イベントループの先頭で毎回ロックを試す ([`src/event/ngx_event.c#L219-L239`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/ngx_event.c#L219-L239))。

```c title="src/event/ngx_event.c"
    if (ngx_use_accept_mutex) {
        if (ngx_accept_disabled > 0) {
            ngx_accept_disabled--;

        } else {
            if (ngx_trylock_accept_mutex(cycle) == NGX_ERROR) {
                return;
            }

            if (ngx_accept_mutex_held) {
                flags |= NGX_POST_EVENTS;

            } else {
                if (timer == NGX_TIMER_INFINITE
                    || timer > ngx_accept_mutex_delay)
                {
                    timer = ngx_accept_mutex_delay;
                }
            }
        }
    }
```

3 つのことが起きている。

- **ロックを取れたら `NGX_POST_EVENTS` を立てる。** これは「イベントを即座に処理せず、ポストキューに積め」というフラグ。accept を全部キューに積んで、ロックを離してから処理する。ロックの保持時間を短くするためで、[ワーカーの 1 周のページ](../state-machine/) で見た `ngx_posted_accept_events` がこれに使われる。
- **取れなかったら、`epoll_wait` のタイムアウトを `accept_mutex_delay` (既定 500ms) で頭打ちにする。** ロックを持っている側が寝込んでいる場合に、いつまでも待たないため。
- **`ngx_accept_disabled` が正なら、そもそも取りに行かない。**

ロックを取る側 ([`src/event/ngx_event_accept.c#L344-L379`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/ngx_event_accept.c#L344-L379))。

```c title="src/event/ngx_event_accept.c"
ngx_trylock_accept_mutex(ngx_cycle_t *cycle)
{
    if (ngx_shmtx_trylock(&ngx_accept_mutex)) {

        if (ngx_accept_mutex_held && ngx_accept_events == 0) {
            return NGX_OK;
        }

        if (ngx_enable_accept_events(cycle) == NGX_ERROR) {
            ngx_shmtx_unlock(&ngx_accept_mutex);
            return NGX_ERROR;
        }

        ngx_accept_events = 0;
        ngx_accept_mutex_held = 1;

        return NGX_OK;
    }

    if (ngx_accept_mutex_held) {
        if (ngx_disable_accept_events(cycle, 0) == NGX_ERROR) {
            return NGX_ERROR;
        }

        ngx_accept_mutex_held = 0;
    }

    return NGX_OK;
}
```

**ロックの取得と `epoll` への登録が 1 対 1 に結びついている**。ロックを取ったら登録、離すときに登録解除。`ngx_accept_mutex_held` が「前回自分が持っていたか」を覚えていて、状態が変わったときだけ `epoll_ctl` を呼ぶ。連続してロックを取り続けている間は syscall が発生しない。

失敗パスの扱いが丁寧で、`ngx_enable_accept_events()` が失敗したら **ロックを離してから** エラーを返している。ここで離し忘れると全ワーカーが永久に accept できなくなる。

`ngx_disable_accept_events()` の第 2 引数が効いている ([`#L407-L444`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/ngx_event_accept.c#L407-L444))。

```c title="src/event/ngx_event_accept.c"
#if (NGX_HAVE_REUSEPORT)

        /*
         * do not disable accept on worker's own sockets
         * when disabling accept events due to accept mutex
         */

        if (ls[i].reuseport && !all) {
            continue;
        }

#endif
```

`reuseport` のソケットは自分専用なので、accept ロックの都合で外してはいけない。`all = 1` で呼ばれるのは fd 枯渇のときだけで、そのときは自分専用のものも含めて全部外す。**第 3 世代と第 1 世代が同じ設定ファイルの中に共存しうる** (`listen 80 reuseport;` と `listen 8080;` を両方書く) ので、この区別が要る。

### 混んでいるワーカーは辞退する

`ngx_accept_disabled` は 1 行で決まる ([`src/event/ngx_event_accept.c#L139-L140`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/ngx_event_accept.c#L139-L140))。

```c title="src/event/ngx_event_accept.c"
        ngx_accept_disabled = ngx_cycle->connection_n / 8
                              - ngx_cycle->free_connection_n;
```

空き接続が全体の 1/8 を上回っているうちは負、下回ると正になる。正のあいだは accept ロックを取りに行かず、ループごとに 1 ずつ減る。

つまり **「残り接続数が 1/8 を切ったら、切った量に比例したループ数だけ accept を休む」**。空きが 1/8 のちょうど半分 (= 1/16) しか無ければ、`connection_n / 16` 回ぶん休む。混み具合に比例した長さの自主的なバックオフになっている。

この 1 行が `accept()` に成功するたびに評価されるので、値は常に最新の混み具合を反映する。ワーカー間の通信は一切なく、**各ワーカーが自分の状態だけを見て辞退する**ことで、結果的に負荷が均される。

fd が枯れたときは、もっと強い手を打つ ([`#L112-L132`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/ngx_event_accept.c#L112-L132))。

```c title="src/event/ngx_event_accept.c"
            if (err == NGX_EMFILE || err == NGX_ENFILE) {
                if (ngx_disable_accept_events((ngx_cycle_t *) ngx_cycle, 1)
                    != NGX_OK)
                {
                    return;
                }

                if (ngx_use_accept_mutex) {
                    if (ngx_accept_mutex_held) {
                        ngx_shmtx_unlock(&ngx_accept_mutex);
                        ngx_accept_mutex_held = 0;
                    }

                    ngx_accept_disabled = 1;

                } else {
                    ngx_add_timer(ev, ecf->accept_mutex_delay);
                }
            }
```

`EMFILE` (プロセスの fd 上限) や `ENFILE` (システム全体の上限) は、リトライしても即座には直らない。accept イベントを全部外し、**accept ロックを使っているなら手放し、使っていないならタイマで再開を予約する**。ロックを持ったまま「accept できません」を続けるのが最悪なので、まず手放す。

タイマで起きたときの再開は `ngx_event_accept()` の冒頭にある ([`#L37-L43`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/ngx_event_accept.c#L37-L43))。

```c title="src/event/ngx_event_accept.c"
    if (ev->timedout) {
        if (ngx_enable_accept_events((ngx_cycle_t *) ngx_cycle) != NGX_OK) {
            return;
        }

        ev->timedout = 0;
    }
```

イベント handler が「タイムアウトで呼ばれた」と「読めるようになって呼ばれた」の両方を受けるので、冒頭で区別する。これは Nginx の handler に共通する形になっている。

### 第 2 世代: EPOLLEXCLUSIVE と、その偏りへの対処

`epoll_ctl` に渡すフラグを 1 つ足すだけ ([`src/event/modules/ngx_epoll_module.c#L614-L620`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/modules/ngx_epoll_module.c#L614-L620))。

```c title="src/event/modules/ngx_epoll_module.c"
#if (NGX_HAVE_EPOLLEXCLUSIVE && NGX_HAVE_EPOLLRDHUP)
    if (flags & NGX_EXCLUSIVE_EVENT) {
        events &= ~EPOLLRDHUP;
    }
#endif

    ee.events = events | (uint32_t) flags;
```

`NGX_EXCLUSIVE_EVENT` は `EPOLLEXCLUSIVE` そのものの値として定義されていて、`flags` をそのまま `ee.events` に OR している。`EPOLLRDHUP` を落としているのは、カーネルが `EPOLLEXCLUSIVE` との組み合わせを拒否するため。

問題は、これだけでは公平にならないことだ。Nginx はそれをコメントに書いている ([`src/event/ngx_event_accept.c#L449-L493`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/ngx_event_accept.c#L449-L493))。

```c title="src/event/ngx_event_accept.c"
static void
ngx_reorder_accept_events(ngx_listening_t *ls)
{
    ngx_connection_t  *c;

    /*
     * Linux with EPOLLEXCLUSIVE usually notifies only the process which
     * was first to add the listening socket to the epoll instance.  As
     * a result most of the connections are handled by the first worker
     * process.  To fix this, we re-add the socket periodically, so other
     * workers will get a chance to accept connections.
     */

    if (!ngx_use_exclusive_accept) {
        return;
    }

#if (NGX_HAVE_REUSEPORT)

    if (ls->reuseport) {
        return;
    }

#endif

    c = ls->connection;

    if (c->requests++ % 16 != 0
        && ngx_accept_disabled <= 0)
    {
        return;
    }

    if (ngx_del_event(c->read, NGX_READ_EVENT, NGX_DISABLE_EVENT)
        == NGX_ERROR)
    {
        return;
    }

    if (ngx_add_event(c->read, NGX_READ_EVENT, NGX_EXCLUSIVE_EVENT)
        == NGX_ERROR)
    {
        return;
    }
}
```

カーネルの待ち行列は登録順なので、最初に登録したプロセスばかりが起こされる。Nginx は **16 接続に 1 回、自分を削除して末尾に付け直す** ことで、自分の順番を後ろに送る。全ワーカーがこれをやると、順番がぐるぐる回る。

`ngx_accept_disabled > 0` (自分が混んでいる) のときは 16 を待たずに毎回付け直すのも効いている。混んでいるワーカーが積極的に順番を譲る形になる。

カーネルの実装上の性質を、ユーザー空間の周期的な操作で打ち消している。行儀のいい解ではないが、コメントに理由が書いてあるので何をしているかは分かる。

### 第 3 世代: ソケットを分ける

`reuseport` が指定されると、設定を読む段階で **リスニングソケットの定義がワーカー数ぶんに複製される** ([`src/core/ngx_connection.c#L98-L131`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_connection.c#L98-L131))。

```c title="src/core/ngx_connection.c"
ngx_clone_listening(ngx_cycle_t *cycle, ngx_listening_t *ls)
{
#if (NGX_HAVE_REUSEPORT)

    ngx_int_t         n;
    ngx_core_conf_t  *ccf;
    ngx_listening_t   ols;

    if (!ls->reuseport || ls->worker != 0) {
        return NGX_OK;
    }

    ols = *ls;

    ccf = (ngx_core_conf_t *) ngx_get_conf(cycle->conf_ctx, ngx_core_module);

    for (n = 1; n < ccf->worker_processes; n++) {

        /* create a socket for each worker process */

        ls = ngx_array_push(&cycle->listening);
        if (ls == NULL) {
            return NGX_ERROR;
        }

        *ls = ols;
        ls->worker = n;
    }

#endif

    return NGX_OK;
}
```

`listen 80 reuseport;` が 1 行なのに、`cycle->listening` には `worker_processes` 個のエントリが並ぶ。それぞれ `ls->worker` に自分の番号を持つ。master がこれを全部開いてから fork するので、各ワーカーは全部の fd を持つことになる。

ワーカー側で自分のぶんだけを拾う ([`src/event/ngx_event.c#L807-L811`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/ngx_event.c#L807-L811))。

```c title="src/event/ngx_event.c"
#if (NGX_HAVE_REUSEPORT)
        if (ls[i].reuseport && ls[i].worker != ngx_worker) {
            continue;
        }
#endif
```

自分の番号と一致しないリスニングソケットは、`ngx_connection_t` すら割り当てずに飛ばす。fd は開いたまま持っているが、`epoll` に入れないので通知は来ない。

この形の効きどころは、**ワーカー間の調整コードが完全に消える** ところだ。ロックも、順番の付け替えも、`ngx_accept_disabled` による辞退も、reuseport のソケットには適用されない (前述の 2 箇所の `if (ls->reuseport) return;`)。分配はカーネルの 4-tuple ハッシュに任せきる。

### まとめて accept するかどうか

`ngx_event_accept()` は `do-while` で回る ([`src/event/ngx_event_accept.c#L47-L58`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/ngx_event_accept.c#L47-L58))。

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

`multi_accept` は既定 off で、そのとき `ev->available = 0` なので **1 回の通知につき 1 接続しか accept しない**。溜まっていても次の通知で取る。

一見無駄に見えるが、これは公平性のための選択になっている。1 回のループで取れるだけ取ると、そのワーカーだけが接続を抱え込む。1 個ずつにしておけば、他のワーカーにも順番が回る。`kqueue` を除外しているのは、kqueue が「今いくつ溜まっているか」を `ev->available` に教えてくれるので、その数だけ取るのが正確だからだ。

## なぜそうなっているか

### 3 世代が「置き換え」ではなく「同居」になっている

古い解法を消していないのは、動く環境が違うからだ。`EPOLLEXCLUSIVE` は Linux 4.5 以降、`SO_REUSEPORT` は Linux 3.9 / FreeBSD 12 以降 (FreeBSD は `SO_REUSEPORT_LB`)。Nginx は Solaris や AIX でもビルドできる。`accept_mutex` は移植性のある最後の砦として残っている。

そして、どれを使うかの判断が **`#if` (ビルド時) と `if` (実行時) の組み合わせ**で書かれている。ビルド時に存在しない機能は `#if` で消え、存在しても条件を満たさなければ実行時の `if` で飛ばされる。この 2 層構造は、`auto/` ディレクトリの configure スクリプトが `NGX_HAVE_EPOLLEXCLUSIVE` などのマクロを立てるところと対になっている。

### なぜ `accept_mutex` の既定が off になったのか

`accept_mutex` は thundering herd を確実に消すが、代償がある。**同時に accept できるのが 1 ワーカーだけになる**ので、接続が殺到したときの受け入れスループットが 1 ワーカーぶんに制限される。加えて、ロックを取れなかったワーカーは `accept_mutex_delay` (500ms) 以内に再挑戦するだけなので、最悪 500ms のレイテンシが乗る。

`EPOLLEXCLUSIVE` は、thundering herd を消しつつ複数ワーカーが並行して accept できる。既定を off にする変更は、Linux での `EPOLLEXCLUSIVE` 対応と同時に入っている。**カーネルが解けるようになった問題を、ユーザー空間から降ろした**という素直な話だ。

### `ngx_accept_disabled` が「ワーカー間で調整しない」ことの意味

各ワーカーは自分の空き接続数しか見ていない。他のワーカーがどれくらい混んでいるかは知らないし、知ろうともしない。それでも全体として均される。

これは分散システムでよくある形で、**中央のコーディネータを置かず、各ノードがローカルな観測だけでバックオフする**。調整のための通信が要らないので、ワーカーが増えてもコストが増えない。代わりに厳密な公平性は保証されない。Nginx にとってはそれで十分で、「1 つのワーカーだけが枯れる」を避けられればいい。

閾値が 1/8 なのも、厳密さを求めていない証拠だ。7/8 まで埋まってから初めて辞退を始める。早すぎるバックオフはスループットを落とすので、「本当にまずくなってから」に寄せてある。

### `NGX_POST_EVENTS` は、ロックの粒度を下げるための仕掛け

accept ロックを持っている間に、accept したコネクションのリクエスト処理まで走らせてしまうと、ロックの保持時間が予測できなくなる。`NGX_POST_EVENTS` を立てて `epoll` の結果をキューに積むだけにすると、ロックを持っている区間が「`epoll_wait` + キューへの追加」だけになる。

ここで面白いのは、**ポストキューという仕組みが、元々はロックのために作られている** ことだ。同じ仕組みが今では再帰の抑制や公平性の調整にも使われている。汎用的な「後で処理する」を 1 つ持っておくと、後から別の問題にも使える。

## どう活かすか

### そのまま真似できるところ

**「競合が起きない構成では、調整機構を丸ごと消す」を条件に書く。** `worker_processes > 1` の判定が 2 箇所に入っていて、ワーカーが 1 個ならロックも順番の付け替えも動かない。ロックを「常に取るが、たいてい競合しない」ではなく「そもそも取らない」にできると、シングルスレッド時の性能特性が読みやすくなる。

**リソース枯渇には、リトライではなくバックオフで応える。** `EMFILE` を受けたら、accept イベントを外して待つ。ループでリトライすると、CPU を焼きながらエラーログを毎秒数万行出すことになる。「今は受けられない」を状態として持ち、時間かタイマで復帰する。

**ローカルな観測だけでバックオフする。** `ngx_accept_disabled` は他のワーカーを一切見ない。分散した書き手が同じリソースを取り合う場面で、中央の調整役を置く前に「各自が自分の混み具合で辞退する」で足りないかを考える価値がある。

**プラットフォームの機能を、実行時とビルド時の 2 段で判定する。** `#if (NGX_HAVE_X)` でコードの存在を、`if (使える条件か)` で実行を分ける。前者だけだと、ビルドしたカーネルと動かすカーネルが違うときに壊れる。

**回避策には理由をコメントに書く。** `ngx_reorder_accept_events()` の 6 行のコメントが無かったら、「16 接続ごとに epoll から削除して追加し直す」コードは意味不明で、次の人が最適化と称して消す。カーネルの挙動に依存した回避策は、依存している挙動を明記しないと維持できない。

### 取り込むべきでない条件

**`accept_mutex` 相当を新しく実装する必要は、もう無い。** Linux なら `SO_REUSEPORT` か `EPOLLEXCLUSIVE`、Go や Node の標準的なサーバなら、そもそもランタイムが解いている。この 3 世代は「カーネルが解いてくれなかった時代に、ユーザー空間で何をしたか」の記録として読むものだ。

**`SO_REUSEPORT` は万能ではない。** カーネルが 4-tuple のハッシュで振り分けるので、**接続の長さや重さは考慮されない**。長時間の WebSocket 接続が偏ると、そのままワーカーの負荷の偏りになる。さらに、ワーカーが死ぬとそのソケットの accept キューに溜まっていた接続が失われる。設定リロードでワーカーを入れ替えるときも同じで、`accept_mutex` や `EPOLLEXCLUSIVE` なら他のワーカーが拾える接続が、`reuseport` では落ちる。均一で短い接続が大量に来るワークロード向けの機能だ。

**`multi_accept off` の判断は、ワークロード次第。** 1 回の通知で 1 接続しか取らないのは、ワーカーが複数いる前提の公平性のためだ。ワーカーが 1 個なら、まとめて取るほうが syscall が減って速い。

## 関連

- リスニングソケットが fork より前に開かれる経緯は [master/worker のページ](../master-worker/)。
- 分配のあとで `ngx_event_accept()` が fd を `ngx_connection_t` に組み立てるところは [accept から接続までのページ](../accept-to-connection/)。
- `NGX_POST_EVENTS` とポストキューの仕組みは [ワーカーの 1 周のページ](../state-machine/)。
- `accept_mutex` が使う共有メモリ上のミューテックスは [スラブアロケータのページ](../slab-shared-memory/) と同じ共有メモリの上に載っている。
- `EPOLLEXCLUSIVE` を渡す `ngx_add_event` の抽象そのものは [イベントメソッドのページ](../event-methods/)。
- `multi_accept off` が既定である理由のもう半分は [1 周の長さのページ](../loop-latency/)。

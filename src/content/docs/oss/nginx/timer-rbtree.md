---
title: "タイマは赤黒木の最小値だけを見て、イベント待ちのタイムアウト引数に畳む"
description: "数万接続ぶんのタイムアウトを、専用スレッドもタイマ fd も使わずに管理する。赤黒木に全部入れて最小値を取り、それを epoll_wait のタイムアウトにする。ノードはイベント構造体に埋め込んであるので確保が要らず、キーの比較は差の符号で行うので 49 日ごとのオーバーフローを跨げる。300ms 未満のタイマ更新は無視して木を触らない、という割り切りも入っている。"
sidebar:
  order: 5
---

## 何を学んだか

### どんな状況の話か

HTTP サーバはあらゆるところにタイムアウトを持つ。ヘッダを読み終わるまで、ボディを読み終わるまで、上流に接続するまで、上流が応答するまで、レスポンスを書き終わるまで、keepalive で次のリクエストが来るまで。接続 1 本につき、時期によって 1〜2 個のタイマが同時に生きている。

接続が 5 万本あれば、タイマも同じオーダーになる。しかも **タイマの張り直しがとにかく頻繁に起きる**。データが 1 バイト届くたびに「あと 60 秒」と延長するからだ。

そして [ステートマシンのページ](../state-machine/) のとおり、ワーカーは 1 スレッドで、`epoll_wait` で寝ている。タイマ用のスレッドを立てるわけにはいかない。`timerfd` を接続ごとに作れば fd が倍要る。

### Nginx の答え

1. **全部のタイマを 1 本の赤黒木に入れ、最小値を `epoll_wait` のタイムアウト引数にする。** タイマのための待ち機構を別に持たない。「次に期限が来るのは 340ms 後」と分かれば、`epoll_wait(ep, list, n, 340)` と書けばいい。
2. **木のノードは `ngx_event_t` の中に埋め込む。** タイマを張るのに追加の確保が要らない。ノードのアドレスからイベントのアドレスを `offsetof` で逆算する。
3. **重複キーを許す。** 同じミリ秒に期限が来るタイマが何個あっても構わない。最小値しか使わないので、木を「削除可能な優先度キュー」として使っている。
4. **キーの比較を、大小ではなく差の符号でやる。** 32 ビットのミリ秒は 49 日で一周する。`a < b` ではなく `(signed)(a - b) < 0` と書けば、一周を跨いだ比較が正しくなる。
5. **300ms 未満のタイマ更新は無視する。** 既にタイマが張ってあって、新しい期限との差が 300ms 未満なら、木を触らずに帰る。タイムアウトが最大 300ms ずれるのは許容する。
6. **「これだけ残っていても終了してよい」タイマに印を付ける。** `cancelable` が立っているタイマは、graceful shutdown のときに待たない。
7. **現在時刻はイベントループが 1 周につき 1 回だけ更新し、あとは全員がキャッシュを読む。** `gettimeofday()` はリクエスト処理の中から呼ばれない。

## ソースコードのどこか

### 全体像

`ngx_event_timer.c` は 126 行しかない ([`src/event/ngx_event_timer.c`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/ngx_event_timer.c))。タイマ機構の全体がこれで、あとは汎用の赤黒木を使い回している。

```c title="src/event/ngx_event_timer.c"
ngx_rbtree_t              ngx_event_timer_rbtree;
static ngx_rbtree_node_t  ngx_event_timer_sentinel;

/*
 * the event timer rbtree may contain the duplicate keys, however,
 * it should not be a problem, because we use the rbtree to find
 * a minimum timer value only
 */

ngx_int_t
ngx_event_timer_init(ngx_log_t *log)
{
    ngx_rbtree_init(&ngx_event_timer_rbtree, &ngx_event_timer_sentinel,
                    ngx_rbtree_insert_timer_value);

    return NGX_OK;
}
```

木はワーカーごとにグローバル変数 1 個。冒頭のコメントが設計を要約している。**「最小値を求めるためだけに使うので、キーが重複しても問題ない」**。厳密な順序集合ではなく、削除のできる優先度キューとして扱っている。

### 最小値を待ち時間に変える

[`#L32-L50`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/ngx_event_timer.c#L32-L50)。

```c title="src/event/ngx_event_timer.c"
ngx_msec_t
ngx_event_find_timer(void)
{
    ngx_msec_int_t      timer;
    ngx_rbtree_node_t  *node, *root, *sentinel;

    if (ngx_event_timer_rbtree.root == &ngx_event_timer_sentinel) {
        return NGX_TIMER_INFINITE;
    }

    root = ngx_event_timer_rbtree.root;
    sentinel = ngx_event_timer_rbtree.sentinel;

    node = ngx_rbtree_min(root, sentinel);

    timer = (ngx_msec_int_t) (node->key - ngx_current_msec);

    return (ngx_msec_t) (timer > 0 ? timer : 0);
}
```

`ngx_rbtree_min()` は左の子を辿るだけ ([`src/core/ngx_rbtree.h#L76-L84`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_rbtree.h#L76-L84))。

```c title="src/core/ngx_rbtree.h"
static ngx_inline ngx_rbtree_node_t *
ngx_rbtree_min(ngx_rbtree_node_t *node, ngx_rbtree_node_t *sentinel)
{
    while (node->left != sentinel) {
        node = node->left;
    }

    return node;
}
```

赤黒木は高さが O(log n) に抑えられているので、5 万個のタイマがあっても 20 回程度のポインタ追跡で最小値に着く。

タイマが 1 つも無ければ `NGX_TIMER_INFINITE` (= `(ngx_msec_t) -1`) を返す。これは `epoll_wait` に `-1` として渡って「無限に待つ」になる。**「タイマが無い」を、待ち時間の型の中の 1 つの値として表現している** ので、呼び出し側に分岐が要らない。ヘッダにその意図がコメントされている ([`src/event/modules/ngx_epoll_module.c#L795`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/modules/ngx_epoll_module.c#L795))。

```c title="src/event/modules/ngx_epoll_module.c"
    /* NGX_TIMER_INFINITE == INFTIM */

    ngx_log_debug1(NGX_LOG_DEBUG_EVENT, cycle->log, 0,
                   "epoll timer: %M", timer);

    events = epoll_wait(ep, event_list, (int) nevents, timer);
```

`timer > 0 ? timer : 0` で負を潰しているのも要る処理で、既に期限が過ぎているタイマがあれば `0` (= 即座に返れ) になる。

### 期限切れを刈る

[`#L53-L96`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/ngx_event_timer.c#L53-L96)。

```c title="src/event/ngx_event_timer.c"
    for ( ;; ) {
        root = ngx_event_timer_rbtree.root;

        if (root == sentinel) {
            return;
        }

        node = ngx_rbtree_min(root, sentinel);

        /* node->key > ngx_current_msec */

        if ((ngx_msec_int_t) (node->key - ngx_current_msec) > 0) {
            return;
        }

        ev = ngx_rbtree_data(node, ngx_event_t, timer);

        ngx_rbtree_delete(&ngx_event_timer_rbtree, &ev->timer);
        /* ... */
        ev->timer_set = 0;

        ev->timedout = 1;

        ev->handler(ev);
    }
```

**最小値を見て、期限が来ていなければそこで終わり。** 木を全部走査しない。期限が来ていたら木から外し、`timedout = 1` を立てて handler を呼ぶ。

毎回 `root` を取り直しているのが肝で、`ev->handler(ev)` の中で別のタイマが追加・削除されうるからだ。ループの先頭でルートから読み直すことで、handler が木を変更しても壊れない。**イテレータを持ち回らず、毎回最小値を取り直す**という素朴な形が、再入への耐性を生んでいる。

`timedout = 1` を立てるだけで、handler は普通のイベント handler と同じものが呼ばれる。だから Nginx の handler はどれも冒頭で `if (ev->timedout)` を見る。「読めるようになった」と「時間切れになった」が、同じ 1 本の関数ポインタに来る。

### ノードは構造体に埋め込む

[ステートマシンのページ](../state-machine/) で見たとおり、`ngx_event_t` の中に `ngx_rbtree_node_t timer` がそのまま入っている。木に入れるのは、そのメンバのアドレスだ。

逆方向は `ngx_rbtree_data` で計算する ([`src/core/ngx_rbtree.h#L50-L51`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_rbtree.h#L50-L51))。

```c title="src/core/ngx_rbtree.h"
#define ngx_rbtree_data(node, type, link)                                     \
    (type *) ((u_char *) (node) - offsetof(type, link))
```

`node` から `offsetof(ngx_event_t, timer)` を引けば `ngx_event_t *` になる。Linux カーネルの `container_of` と同じ発想で、**コンテナがデータへのポインタを持つのではなく、データがコンテナのノードを持つ**。

これで得られるものが 3 つある。タイマを張るときに `malloc` が要らない (ノードは既にそこにある)。タイマを消すときも解放が要らない。そして、`ngx_event_t` 1 個が赤黒木のノードでもありポストキューのノードでもあるので、**同じオブジェクトを複数のコンテナに同時に入れられる**。

`ngx_rbtree_t` 自体も、比較関数を差し替えられるようになっている ([`src/core/ngx_rbtree.h#L37-L41`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_rbtree.h#L37-L41))。

```c title="src/core/ngx_rbtree.h"
struct ngx_rbtree_s {
    ngx_rbtree_node_t     *root;
    ngx_rbtree_node_t     *sentinel;
    ngx_rbtree_insert_pt   insert;
};
```

`insert` が挿入位置を決める関数ポインタで、タイマ用は `ngx_rbtree_insert_timer_value`、通常のキー比較用は `ngx_rbtree_insert_value`。**回転とバランス調整 (難しくて共通なところ) は共有し、比較 (簡単で用途ごとに違うところ) だけを差し替える** という切り方になっている。

### 49 日ごとに一周する時刻を扱う

タイマ用の挿入関数がこれ ([`src/core/ngx_rbtree.c#L121-L153`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_rbtree.c#L121-L153))。

```c title="src/core/ngx_rbtree.c"
ngx_rbtree_insert_timer_value(ngx_rbtree_node_t *temp, ngx_rbtree_node_t *node,
    ngx_rbtree_node_t *sentinel)
{
    ngx_rbtree_node_t  **p;

    for ( ;; ) {

        /*
         * Timer values
         * 1) are spread in small range, usually several minutes,
         * 2) and overflow each 49 days, if milliseconds are stored in 32 bits.
         * The comparison takes into account that overflow.
         */

        /*  node->key < temp->key */

        p = ((ngx_rbtree_key_int_t) (node->key - temp->key) < 0)
            ? &temp->left : &temp->right;

        if (*p == sentinel) {
            break;
        }

        temp = *p;
    }
```

キーは符号なし (`ngx_rbtree_key_t` = `ngx_uint_t`) だが、比較は **引き算の結果を符号付きにキャストして符号を見る**。

なぜこれで正しいか。32 ビットで `ngx_current_msec` が `0xFFFFFF00` のとき、500ms 後のタイマのキーは `0x000000F4` に折り返す。素直に `a < b` で比べると、折り返したタイマが「一番小さい = 一番早い」と判定されて、全部のタイマが即座に期限切れ扱いになる。

差を取ってから符号を見ると、`0x000000F4 - 0xFFFFFF00 = 0x1F4` (= 500)、符号付きで正なので「後」と正しく判定される。この方法が成立する条件がコメントの 1) で、**タイマの値が狭い範囲 (数分) に収まっている限り、差は 2^31 を超えない**。Linux カーネルの `time_after()` マクロと同じ手法だ。

同じ比較が `ngx_event_find_timer()` にも `ngx_event_expire_timers()` にも出てくる。**符号なしの値を「時刻」として扱う場所すべてで、一貫して差の符号を使う** という規律になっている。

### タイマを張り直しすぎない

`ngx_event_add_timer()` はインライン関数で、意外なことが書いてある ([`src/event/ngx_event_timer.h#L50-L87`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/ngx_event_timer.h#L50-L87))。

```c title="src/event/ngx_event_timer.h"
static ngx_inline void
ngx_event_add_timer(ngx_event_t *ev, ngx_msec_t timer)
{
    ngx_msec_t      key;
    ngx_msec_int_t  diff;

    key = ngx_current_msec + timer;

    if (ev->timer_set) {

        /*
         * Use a previous timer value if difference between it and a new
         * value is less than NGX_TIMER_LAZY_DELAY milliseconds: this allows
         * to minimize the rbtree operations for fast connections.
         */

        diff = (ngx_msec_int_t) (key - ev->timer.key);

        if (ngx_abs(diff) < NGX_TIMER_LAZY_DELAY) {
            /* ... ログだけ出して ... */
            return;
        }

        ngx_del_timer(ev);
    }

    ev->timer.key = key;
    /* ... */
    ngx_rbtree_insert(&ngx_event_timer_rbtree, &ev->timer);

    ev->timer_set = 1;
}
```

`NGX_TIMER_LAZY_DELAY` は 300 ([`#L19`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/ngx_event_timer.h#L19))。**新しい期限と今の期限の差が 300ms 未満なら、何もせずに帰る。**

これが効く場面がコメントの "fast connections" だ。上流から 10MB の応答を 64KB ずつ受け取っていると、`ngx_add_timer(rev, read_timeout)` が 160 回呼ばれる。素直に実装すると赤黒木の削除と挿入が 160 回起きる。実際にはそのうち何回かは同じミリ秒に起きているので、木を触る意味がない。

代償は、**タイムアウトが最大 300ms 早く発火しうる**こと。`read_timeout 60s` と書いてあっても、実際には 59.7 秒で切れることがある。これを許容できると判断したから、この最適化がある。

### 終了してよいタイマ

`ngx_event_no_timers_left()` ([`src/event/ngx_event_timer.c#L99-L126`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/ngx_event_timer.c#L99-L126))。

```c title="src/event/ngx_event_timer.c"
    for (node = ngx_rbtree_min(root, sentinel);
         node;
         node = ngx_rbtree_next(&ngx_event_timer_rbtree, node))
    {
        ev = ngx_rbtree_data(node, ngx_event_t, timer);

        if (!ev->cancelable) {
            return NGX_AGAIN;
        }
    }

    /* only cancelable timers left */

    return NGX_OK;
```

これだけが木を全走査する。呼ばれるのは graceful shutdown のときだけで、[master/worker のページ](../master-worker/) で見たワーカーのループが「もう終わっていいか」を問い合わせる場所だ。

`cancelable` が立っているのは、**サービスの継続とは関係ない周期タイマ**。ログのバッファを定期的にフラッシュするタイマ ([`ngx_http_log_module.c#L1636`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/modules/ngx_http_log_module.c#L1636))、DNS の再解決タイマ ([`ngx_resolver.c#L193`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_resolver.c#L193))、upstream ゾーンの再解決 ([`ngx_http_upstream_zone_module.c#L703`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/modules/ngx_http_upstream_zone_module.c#L703))、shutdown 自体のタイマ ([`ngx_cycle.c#L1447`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_cycle.c#L1447)) など。

これらが無かったら、**周期タイマを 1 個持っているだけでワーカーが永久に終了できなくなる**。「このタイマは待つに値するか」をフラグ 1 ビットで表し、終了判定をそれで駆動している。

### 現在時刻はキャッシュ

`ngx_current_msec` はグローバル変数で、更新するのは `ngx_time_update()` だけ。イベントループの中では `epoll_wait` から戻った直後に 1 回呼ばれる ([`src/event/modules/ngx_epoll_module.c#L800-L806`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/modules/ngx_epoll_module.c#L800-L806))。

```c title="src/event/modules/ngx_epoll_module.c"
    events = epoll_wait(ep, event_list, (int) nevents, timer);

    err = (events == -1) ? ngx_errno : 0;

    if (flags & NGX_UPDATE_TIME || ngx_event_timer_alarm) {
        ngx_time_update();
    }
```

つまり **1 周のあいだ、全リクエストが同じ「現在時刻」を見る**。数万接続を処理する 1 周のあいだ時刻が止まっているわけだが、ミリ秒精度のタイムアウト判定にはそれで足りる。`gettimeofday()` の呼び出し回数が、接続数ではなくループ回数に比例するようになる。

キャッシュの実体は 64 個のリングになっている ([`src/core/ngx_times.c#L15-L24`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_times.c#L15-L24))。

```c title="src/core/ngx_times.c"
/*
 * The time may be updated by signal handler or by several threads.
 * The time update operations are rare and require to hold the ngx_time_lock.
 * The time read operations are frequent, so they are lock-free and get time
 * values and strings from the current slot.  Thus thread may get the corrupted
 * values only if it is preempted while copying and then it is not scheduled
 * to run more than NGX_TIME_SLOTS seconds.
 */

#define NGX_TIME_SLOTS   64
```

更新側は次のスロットに書いてから、ポインタを差し替える ([`#L182-L189`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_times.c#L182-L189))。

```c title="src/core/ngx_times.c"
    ngx_memory_barrier();

    ngx_cached_time = tp;
    ngx_cached_http_time.data = p0;
    ngx_cached_err_log_time.data = p1;
    ngx_cached_http_log_time.data = p2;
    ngx_cached_http_log_iso8601.data = p3;
    ngx_cached_syslog_time.data = p4;
```

読み手はロックを取らずにポインタを読むだけ。**書き換え中のバッファを読む事故は、読み手が 64 秒以上プリエンプトされたときにしか起きない**。厳密なロックフリー構造ではなく、「スロットを 64 個用意して一周に十分な時間を作る」という現実的な割り切りだ。

なお、更新側の `ngx_time_update()` は `ngx_trylock()` で、取れなかったら何もせずに帰る ([`#L90-L92`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_times.c#L90-L92))。

```c title="src/core/ngx_times.c"
    if (!ngx_trylock(&ngx_time_lock)) {
        return;
    }
```

**時刻の更新は失敗してよい。** 誰かが今まさに更新中なら、自分がやらなくても新しい時刻になる。シグナルハンドラから呼ばれる可能性があるので、ここでブロックしたらデッドロックする。

`ngx_current_msec` の元は、可能なら `CLOCK_MONOTONIC` から取る ([`#L195-L209`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_times.c#L195-L209))。

```c title="src/core/ngx_times.c"
static ngx_msec_t
ngx_monotonic_time(time_t sec, ngx_uint_t msec)
{
#if (NGX_HAVE_CLOCK_MONOTONIC)
    struct timespec  ts;

    clock_gettime(CLOCK_MONOTONIC, &ts);

    sec = ts.tv_sec;
    msec = ts.tv_nsec / 1000000;

#endif

    return (ngx_msec_t) sec * 1000 + msec;
}
```

タイムアウトの計算に壁時計を使うと、NTP の補正や手動の時刻変更で全タイマが狂う。**「表示する時刻」と「経過を測る時刻」を別の時計から取る**という分離になっている。

### 時刻更新の頻度を明示的に制御する

`timer_resolution` を設定すると、話が逆転する ([`src/event/ngx_event.c#L698-L723`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/ngx_event.c#L698-L723))。

```c title="src/event/ngx_event.c"
    if (ngx_timer_resolution && !(ngx_event_flags & NGX_USE_TIMER_EVENT)) {
        struct sigaction  sa;
        struct itimerval  itv;

        ngx_memzero(&sa, sizeof(struct sigaction));
        sa.sa_handler = ngx_timer_signal_handler;
        sigemptyset(&sa.sa_mask);

        if (sigaction(SIGALRM, &sa, NULL) == -1) { /* ... */ }

        itv.it_interval.tv_sec = ngx_timer_resolution / 1000;
        itv.it_interval.tv_usec = (ngx_timer_resolution % 1000) * 1000;
        /* ... */
        if (setitimer(ITIMER_REAL, &itv, NULL) == -1) { /* ... */ }
    }
```

`setitimer` で周期的な `SIGALRM` を仕込み、それが `epoll_wait` を `EINTR` で叩き起こす。そのときだけ時刻を更新する。イベントループ側は `timer = NGX_TIMER_INFINITE` にして、タイマによる起床をやめる ([`src/event/ngx_event.c#L200-L203`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/ngx_event.c#L200-L203))。

```c title="src/event/ngx_event.c"
    if (ngx_timer_resolution) {
        timer = NGX_TIMER_INFINITE;
        flags = 0;
```

`EINTR` の扱いも用意されている ([`src/event/modules/ngx_epoll_module.c#L808-L814`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/modules/ngx_epoll_module.c#L808-L814))。

```c title="src/event/modules/ngx_epoll_module.c"
    if (err) {
        if (err == NGX_EINTR) {

            if (ngx_event_timer_alarm) {
                ngx_event_timer_alarm = 0;
                return NGX_OK;
            }

            level = NGX_LOG_INFO;
```

**タイマ精度を捨てて、時刻更新の回数を固定にする**トレードオフになっている。既定は off で、そのときは「次のタイマの期限まで正確に寝る」ほうが選ばれる。

## なぜそうなっているか

### なぜ赤黒木か

タイマの操作は「最小値を見る」「任意の位置を消す」「挿入する」の 3 つ。

- **二分ヒープ** は最小値の取得が O(1) で速いが、任意位置の削除に要素の位置を追跡する必要がある。タイマは張り直しのたびに削除されるので、削除が主役の操作になる。
- **ソート済みリスト** は挿入が O(n)。
- **タイマホイール** (Linux カーネルの方式) は O(1) だが、レンジが決まってしまう。Nginx のタイムアウトは 1ms から 1 時間まで幅がある。
- **赤黒木** は全部 O(log n)。最小値の取得は O(log n) だが、それも「左に降りるだけ」の 20 回程度のポインタ追跡でしかない。

そして決定的なのは、**赤黒木がコードベースの他の場所でも使われている**ことだ。`limit_req` のキー、`ngx_open_file_cache`、`ngx_resolver` のノード、HTTP/2 のストリーム。1 つの実装を全部で使い回せるなら、タイマ専用に最適なデータ構造を持ち込むより安い。

`ngx_rbtree_t` に `insert` の関数ポインタを持たせて比較だけ差し替えられるようにしてあるのが、この使い回しを可能にしている。

### `NGX_TIMER_LAZY_DELAY` が示す、タイムアウトの性質

タイムアウトは「これ以上待たない」の目安であって、正確な時刻に発火する必要がない。60 秒のタイムアウトが 59.7 秒で切れても、誰も困らない。

この性質に気づくと、300ms の粒度で丸めていいことになり、木の操作が劇的に減る。**要件の精度を問い直して、そこから最適化を引き出す**という形になっている。定数の値も、根拠がコメントに書かれている点も含めて誠実だ。

逆に、この最適化が入っていることは「Nginx のタイムアウトは 300ms 単位でしか信用できない」という契約でもある。ミリ秒精度のスケジューリングにこの機構を使ってはいけない。

### `cancelable` は「終了条件」をタイマ側に持たせる

graceful shutdown の判定は、素朴には「処理中のリクエストが 0 になったら終わる」だ。ところが Nginx にはリクエストと無関係の周期タイマが常駐している。これを考慮しないと、`ngx_event_no_timers_left()` が永遠に `NGX_AGAIN` を返す。

解き方は 2 つあった。終了時にそういうタイマを列挙して止めるか、タイマ自身に「自分は待つ必要がない」と表明させるか。Nginx は後者を選んだ。**中央に「止めるべきタイマの一覧」を持たなくていい**ので、モジュールが周期タイマを足すときに shutdown のコードを変えなくて済む。

拡張可能なシステムで終了条件を書くときの一般的な形として、これは効く。中央が全部を知っている前提を捨てて、各要素に自己申告させる。

### 時刻をキャッシュすることの副作用

`ngx_current_msec` が 1 周に 1 回しか更新されないので、**1 周の中で長い処理をすると、その間の経過時間がタイマから見えない**。gzip で大きなレスポンスを圧縮している最中に 500ms 経っても、`ngx_current_msec` は動かない。

これはバグではなく設計で、そもそも 1 周を長くしてはいけないという制約が先にある。[ステートマシンのページ](../state-machine/) の「ブロックしない」が守られていれば、1 周は短い。**時刻キャッシュの正確さが、イベントループの規律を守っているかどうかの指標になっている**とも言える。

アクセスログの `$msec` も同じキャッシュから来るので、ログのタイムスタンプもループ 1 周ぶんの粒度になる。Nginx のログで同じミリ秒のエントリが並ぶことがあるのは、これが理由だ。

## どう活かすか

### そのまま真似できるところ

**タイマを、既存の待ち機構のタイムアウト引数に畳む。** イベントループ・`select`・チャネルの `select` 文・`poll` — 待つ仕組みには大抵タイムアウト引数がある。タイマを別のスレッドやタイマ fd で管理する前に、「次の期限までの時間を計算して、それを渡す」で足りないかを考える。要素が 1 つ減る。

**「無し」を、値の型の中の特別な値で表す。** `NGX_TIMER_INFINITE == (ngx_msec_t) -1 == INFTIM` で、`Optional` に相当するものが不要になっている。呼び出し側に `if (タイマがあるか)` が要らない。既存の API が同じ規約を持っているときに特に効く。

**時刻の比較は、大小ではなく差の符号で。** 単調増加するカウンタ (シーケンス番号、世代番号、ミリ秒時刻) を固定幅で持つなら、折り返しは必ず来る。`(int32_t)(a - b) < 0` と書く習慣にしておくと、49 日後や 2^32 パケット後に起きる再現困難なバグを最初から避けられる。ただし「差が範囲の半分を超えない」という前提が要るので、その根拠をコメントに書くところまで真似したい。

**要件の精度を問い直して最適化する。** 「タイムアウトは 300ms ずれてよい」に気づくと、データ構造の操作が桁で減る。厳密さが要らない場所を見つけるのは、速いアルゴリズムを探すより効くことが多い。

**終了条件を、中央の一覧ではなく各要素の自己申告にする。** `cancelable` の 1 ビット。プラグインやモジュールが増えるシステムで、shutdown のコードを変えずに済む。

**現在時刻を 1 箇所で更新して、他は読むだけにする。** ホットパスから `gettimeofday()` / `time.Now()` を消せる。経過時間の測定には単調増加時計を、表示には壁時計を使い分けるところも一緒に。

**侵入型のデータ構造で、コンテナへの登録に確保を要らなくする。** 同じオブジェクトを複数のコンテナに同時に入れられるようになるのが、地味だが大きい。C 以外でも、Rust の intrusive collections や、要素にノードを持たせる自作リストで同じことができる。

### 取り込むべきでない条件

**赤黒木を自分で書く必要はない。** 標準ライブラリの順序付きマップ、優先度キュー、あるいは言語ランタイムのタイマがあるなら、それを使う。Nginx が自前なのは、依存を持たない方針と、削除可能な優先度キューが必要だったからだ。

**時刻キャッシュは、長い処理があると嘘をつく。** イベントループの 1 周が短いという前提が壊れると、タイムアウトが効かなくなる。CPU バウンドな処理が混ざるシステムで同じことをやると、ハングの原因が読めなくなる。

**64 スロットのリングによるロックフリー読み出しは、真似しないほうがいい。** 「64 秒以上プリエンプトされなければ安全」は保証ではなく確率的な議論だ。今なら `seqlock` や、言語ランタイムの atomic を使うほうが正しい。Nginx がこう書いたのは、移植性のある atomic が無かった時代の産物だ。

**`timer_resolution` 相当の仕組みは、まず要らない。** `setitimer` + `SIGALRM` で `epoll_wait` を叩き起こす設計は、シグナルの取りこぼしと `EINTR` の扱いを全体に持ち込む。既定が off なのが答えになっている。

## 関連

- タイマを畳み込む先の `epoll_wait` と、そのメソッド抽象は [イベントメソッドのページ](../event-methods/)。
- `delayed` フラグと組み合わせて「時間で待たせる」形は [1 周の長さのページ](../loop-latency/)。
- `cancelable` が実際に必要になる常駐タイマの例は [DNS リゾルバのページ](../resolver/)。
- AIO やスレッドプールの完了を待つ 60 秒のタイマは [ブロックする I/O のページ](../blocking-io/)。

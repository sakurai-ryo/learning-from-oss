---
title: "epoll と kqueue の差を、関数ポインタ 10 本と「能力のフラグ」で吸収する"
description: "イベント待ちの API は OS ごとに違う。Nginx は add/del/process_events など 10 本の関数ポインタで実装を差し替え、実装ごとの性質の違いは NGX_USE_* のフラグで表す。定数はそれぞれの OS のネイティブな値に define されるので変換が要らず、上位のコードは ngx_handle_read_event() を呼ぶだけで、level と edge の違いを知らずに済む。"
group: "設計の掘り下げ"
sidebar:
  order: 36
---

## 何を学んだか

### どんな状況の話か

「たくさんの fd を待つ」ための API は、OS ごとに別物になっている。Linux は `epoll`、FreeBSD と macOS は `kqueue`、Solaris は event ports、古い Solaris は `/dev/poll`、どこにでもあるのは `select` と `poll`、Windows は IOCP。

問題は、**呼び出し方が違うだけではない**ことだ。性質が違う。

- `select` は「今読める fd」を毎回全部返す (level-triggered)。
- `epoll` は既定では level だが、`EPOLLET` を付けると「変化したとき 1 回だけ」になる (edge-triggered)。
- `kqueue` は変化を通知するが、**何バイト読めるか** (`kev.data`) と **相手が閉じたか** (`EV_EOF`) と **エラー番号** (`fflags`) まで教えてくれる。
- event ports は通知するたびに登録が消える。
- `poll` と `/dev/poll` は「イベントに任意のポインタを紐づける」ができないので、fd から構造体を引く表が要る。

[ワーカーの 1 周のページ](../state-machine/) で見たとおり、Nginx のコードは至るところで「読めなかったのでイベントを再登録して帰る」を書く。その 1 行が、7 種類の API それぞれで正しく動かなければならない。

### Nginx の答え

1. **イベントメソッドを、関数ポインタ 10 本の表にする。** `add` / `del` / `enable` / `disable` / `add_conn` / `del_conn` / `notify` / `process_events` と、`init` / `done`。
2. **イベントメソッドも普通のモジュールにする。** `ngx_event_module_t` は自分の設定を持てる。`epoll_events` のようなディレクティブがそこから生える。
3. **性質の違いを `NGX_USE_*` のフラグで表す。** 「level か」「edge か」「EAGAIN まで読む必要があるか」「fd の表が要るか」を、実装が `ngx_event_flags` に立てる。
4. **`NGX_READ_EVENT` などの定数を、その OS のネイティブな値に `#define` する。** `kqueue` では `EVFILT_READ`、`epoll` では `EPOLLIN|EPOLLRDHUP`、`select` では 0。変換のコードが要らない。
5. **`ngx_handle_read_event()` / `ngx_handle_write_event()` が、フラグを見て味を揃える。** 上位のコードはこの 1 本を呼ぶだけ。
6. **`instance` の 1 ビットで、処理中に閉じられた fd の古いイベントを弾く。**
7. **`ready` フラグを、`recv()` の結果から自分で維持する。** カーネルの通知だけに頼らず、「あと何バイト読めるか」を追跡して syscall を減らす。
8. **使える機能は、起動時に実際に試して確かめる。** `EPOLLRDHUP` が本当に動くかを socketpair で検証してから使う。

## ソースコードのどこか

### 10 本の関数ポインタ

[`src/event/ngx_event.h#L166-L183`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/ngx_event.h#L166-L183)。

```c title="src/event/ngx_event.h"
typedef struct {
    ngx_int_t  (*add)(ngx_event_t *ev, ngx_int_t event, ngx_uint_t flags);
    ngx_int_t  (*del)(ngx_event_t *ev, ngx_int_t event, ngx_uint_t flags);

    ngx_int_t  (*enable)(ngx_event_t *ev, ngx_int_t event, ngx_uint_t flags);
    ngx_int_t  (*disable)(ngx_event_t *ev, ngx_int_t event, ngx_uint_t flags);

    ngx_int_t  (*add_conn)(ngx_connection_t *c);
    ngx_int_t  (*del_conn)(ngx_connection_t *c, ngx_uint_t flags);

    ngx_int_t  (*notify)(ngx_event_handler_pt handler);

    ngx_int_t  (*process_events)(ngx_cycle_t *cycle, ngx_msec_t timer,
                                 ngx_uint_t flags);

    ngx_int_t  (*init)(ngx_cycle_t *cycle, ngx_msec_t timer);
    void       (*done)(ngx_cycle_t *cycle);
} ngx_event_actions_t;
```

**イベント駆動の I/O 全体が、この 10 本で表現できている。** 7 種類の OS API がこの型に収まっているというのは、抽象の切り方としてかなり成功している部類だ。

`enable` / `disable` が `add` / `del` と別にあるのは kqueue のためで、`EV_DISABLE` は「登録は残したまま無効化する」を意味する。カーネルの `malloc`/`free` を避けられるので、頻繁に付け外しする場面で速い。他の実装では `add` / `del` と同じ関数が入る ([`src/event/modules/ngx_epoll_module.c#L184-L199`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/modules/ngx_epoll_module.c#L184-L199))。

```c title="src/event/modules/ngx_epoll_module.c"
static ngx_event_module_t  ngx_epoll_module_ctx = {
    &epoll_name,
    ngx_epoll_create_conf,               /* create configuration */
    ngx_epoll_init_conf,                 /* init configuration */

    {
        ngx_epoll_add_event,             /* add an event */
        ngx_epoll_del_event,             /* delete an event */
        ngx_epoll_add_event,             /* enable an event */
        ngx_epoll_del_event,             /* disable an event */
        ngx_epoll_add_connection,        /* add an connection */
        ngx_epoll_del_connection,        /* delete an connection */
#if (NGX_HAVE_EVENTFD)
        ngx_epoll_notify,                /* trigger a notify */
#else
        NULL,                            /* trigger a notify */
#endif
        ngx_epoll_process_events,        /* process the events */
        ngx_epoll_init,                  /* init the events */
        ngx_epoll_done,                  /* done the events */
    }
};
```

**「この実装には無い機能」は `NULL` で表す。** `eventfd` が無い環境では `notify` が `NULL` になり、[ブロックする I/O のページ](../blocking-io/) のスレッドプールは `ngx_notify == NULL` を見て自分を無効化する。

`add_conn` / `del_conn` は「読みと書きを一度に登録する」ためのもので、これも実装によっては無い。`ngx_add_conn` が `NULL` かどうかで呼び分けるコードが各所にある。

### イベントメソッドも「モジュール」

[`src/event/ngx_event.h#L446-L453`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/ngx_event.h#L446-L453)。

```c title="src/event/ngx_event.h"
typedef struct {
    ngx_str_t              *name;

    void                 *(*create_conf)(ngx_cycle_t *cycle);
    char                 *(*init_conf)(ngx_cycle_t *cycle, void *conf);

    ngx_event_actions_t     actions;
} ngx_event_module_t;
```

[モジュールシステムのページ](../module-system/) の `ngx_http_module_t` と同じ形で、**イベントメソッドが自分の設定を持てる**。`epoll` なら `epoll_events` と `worker_aio_requests`、`kqueue` なら `kqueue_changes` と `kqueue_events`。

```c title="src/event/modules/ngx_epoll_module.c"
static ngx_command_t  ngx_epoll_commands[] = {

    { ngx_string("epoll_events"),
      NGX_EVENT_CONF|NGX_CONF_TAKE1,
      ngx_conf_set_num_slot,
      0,
      offsetof(ngx_epoll_conf_t, events),
      NULL },
    /* ... */
```

**実装ごとのチューニングパラメータが、その実装のファイルに閉じている。** `ngx_event.c` に「epoll のときはこの設定を読む」という分岐が要らない。[設定パースのページ](../conf-parse/) の `ngx_command_t` の仕組みがそのまま使われている。

### 能力をフラグで宣言する

[`src/event/ngx_event.h#L192-L268`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/ngx_event.h#L192-L268)。コメントに「どの実装が該当するか」が全部書いてある。

```c title="src/event/ngx_event.h"
/*
 * The event filter requires to read/write the whole data:
 * select, poll, /dev/poll, kqueue, epoll.
 */
#define NGX_USE_LEVEL_EVENT      0x00000001

/*
 * The event filter is deleted after a notification without an additional
 * syscall: kqueue, epoll.
 */
#define NGX_USE_ONESHOT_EVENT    0x00000002

/*
 * The event filter notifies only the changes and an initial level:
 * kqueue, epoll.
 */
#define NGX_USE_CLEAR_EVENT      0x00000004

/*
 * The event filter has kqueue features: the eof flag, errno,
 * available data, etc.
 */
#define NGX_USE_KQUEUE_EVENT     0x00000008
/* ... */
/*
 * The event filter requires to do i/o operation until EAGAIN: epoll.
 */
#define NGX_USE_GREEDY_EVENT     0x00000020
/* ... */
/*
 * The event filter has no opaque data and requires file descriptors table:
 * poll, /dev/poll.
 */
#define NGX_USE_FD_EVENT         0x00000400
```

**「どの API を使っているか」ではなく「どういう性質を持っているか」でフラグを切っている。** これが効くのは、上位のコードが `if (epoll なら)` ではなく `if (edge-triggered なら)` と書けることだ。新しいイベントメソッドを足しても、性質が既存のどれかと同じなら上位は 1 行も変わらない。

例外が `NGX_USE_KQUEUE_EVENT` と `NGX_USE_EPOLL_EVENT` で、こちらは実装そのものを名指ししている。kqueue が返す `available` / `pending_eof` / `kq_errno` のような **他に類のない情報**を使うためで、抽象化しきれなかった部分になっている。

立てるのは各実装の `init` ([`src/event/modules/ngx_epoll_module.c#L367-L379`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/modules/ngx_epoll_module.c#L367-L379))。

```c title="src/event/modules/ngx_epoll_module.c"
    ngx_io = ngx_os_io;

    ngx_event_actions = ngx_epoll_module_ctx.actions;

#if (NGX_HAVE_CLEAR_EVENT)
    ngx_event_flags = NGX_USE_CLEAR_EVENT
#else
    ngx_event_flags = NGX_USE_LEVEL_EVENT
#endif
                      |NGX_USE_GREEDY_EVENT
                      |NGX_USE_EPOLL_EVENT;
```

kqueue 側 ([`src/event/modules/ngx_kqueue_module.c#L191-L193`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/modules/ngx_kqueue_module.c#L191-L193))。

```c title="src/event/modules/ngx_kqueue_module.c"
    ngx_event_flags = NGX_USE_ONESHOT_EVENT
                      |NGX_USE_KQUEUE_EVENT
                      |NGX_USE_VNODE_EVENT;
```

`ngx_event_flags` はワーカーに 1 つのグローバル変数。**イベントメソッドは実行中に切り替わらない**ので、これで足りる。

### 定数をネイティブ値に定義する

[`src/event/ngx_event.h#L305-L380`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/ngx_event.h#L305-L380)。ここが一番大胆なところだ。

```c title="src/event/ngx_event.h"
#if (NGX_HAVE_KQUEUE)

#define NGX_READ_EVENT     EVFILT_READ
#define NGX_WRITE_EVENT    EVFILT_WRITE
/* ... */
#define NGX_LEVEL_EVENT    0
#define NGX_ONESHOT_EVENT  EV_ONESHOT
#define NGX_CLEAR_EVENT    EV_CLEAR

#elif (NGX_HAVE_EPOLL) && !(NGX_TEST_BUILD_EPOLL)

#define NGX_READ_EVENT     (EPOLLIN|EPOLLRDHUP)
#define NGX_WRITE_EVENT    EPOLLOUT

#define NGX_LEVEL_EVENT    0
#define NGX_CLEAR_EVENT    EPOLLET
#define NGX_ONESHOT_EVENT  0x70000000

#elif (NGX_HAVE_POLL)

#define NGX_READ_EVENT     POLLIN
#define NGX_WRITE_EVENT    POLLOUT
/* ... */
#else /* select */

#define NGX_READ_EVENT     0
#define NGX_WRITE_EVENT    1

#endif
```

**`ngx_add_event(rev, NGX_READ_EVENT, NGX_CLEAR_EVENT)` の第 2・第 3 引数が、そのままカーネルに渡る値になっている。** epoll なら `EPOLLIN|EPOLLRDHUP|EPOLLET` に OR されて `epoll_ctl` へ、kqueue なら `EVFILT_READ` と `EV_CLEAR` として `kevent` へ。実装の中で「Nginx の定数 → OS の定数」を変換する `switch` が 1 つも無い。

`select` では `NGX_READ_EVENT` が 0、`NGX_WRITE_EVENT` が 1 で、**`fd_set` の配列の添字**として使われる。同じ引数が、実装によってビットマスクにも添字にもフィルタ番号にもなる。

kqueue のところにあるコメントが、この手法の危うさと対処を説明している ([`#L313-L327`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/ngx_event.h#L313-L327))。

```c title="src/event/ngx_event.h"
/*
 * NGX_CLOSE_EVENT, NGX_LOWAT_EVENT, and NGX_FLUSH_EVENT are the module flags
 * and they must not go into a kernel so we need to choose the value
 * that must not interfere with any existent and future kqueue flags.
 * kqueue has such values - EV_FLAG1, EV_EOF, and EV_ERROR:
 * they are reserved and cleared on a kernel entrance.
 */
#undef  NGX_CLOSE_EVENT
#define NGX_CLOSE_EVENT    EV_EOF
```

**Nginx 独自のフラグ (カーネルに渡してはいけないもの) を、同じ `flags` 引数に載せる必要がある。** kqueue には「カーネルに入るときにクリアされる」と規定された値が 3 つあるので、そこに重ねる。ハックだが、理由が明記されていて、依存している仕様も書かれている。

### 味を揃える 1 本の関数

[`src/event/ngx_event.c#L267-L344`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/ngx_event.c#L267-L344)。

```c title="src/event/ngx_event.c"
ngx_int_t
ngx_handle_read_event(ngx_event_t *rev, ngx_uint_t flags)
{
    /* ... QUIC は何もしない ... */

    if (ngx_event_flags & NGX_USE_CLEAR_EVENT) {

        /* kqueue, epoll */

        if (!rev->active && !rev->ready) {
            if (ngx_add_event(rev, NGX_READ_EVENT, NGX_CLEAR_EVENT)
                == NGX_ERROR)
            {
                return NGX_ERROR;
            }
        }

        return NGX_OK;

    } else if (ngx_event_flags & NGX_USE_LEVEL_EVENT) {

        /* select, poll, /dev/poll */

        if (!rev->active && !rev->ready) {
            if (ngx_add_event(rev, NGX_READ_EVENT, NGX_LEVEL_EVENT)
                == NGX_ERROR)
            {
                return NGX_ERROR;
            }

            return NGX_OK;
        }

        if (rev->active && (rev->ready || (flags & NGX_CLOSE_EVENT))) {
            if (ngx_del_event(rev, NGX_READ_EVENT, NGX_LEVEL_EVENT | flags)
                == NGX_ERROR)
            {
                return NGX_ERROR;
            }

            return NGX_OK;
        }

    } else if (ngx_event_flags & NGX_USE_EVENTPORT_EVENT) {

        /* event ports */

        if (!rev->active && !rev->ready) {
            if (ngx_add_event(rev, NGX_READ_EVENT, 0) == NGX_ERROR) {
                return NGX_ERROR;
            }

            return NGX_OK;
        }

        if (rev->oneshot && rev->ready) {
            if (ngx_del_event(rev, NGX_READ_EVENT, 0) == NGX_ERROR) {
                return NGX_ERROR;
            }

            return NGX_OK;
        }
    }

    /* iocp */

    return NGX_OK;
}
```

**リクエスト処理のコードが書くのは `ngx_handle_read_event(rev, 0)` の 1 行だけ**で、その意味は「読みを続けたいので、必要なら再登録してくれ」になる。実際に何が起きるかは 3 通りに分かれる。

- **edge-triggered (epoll ET / kqueue)**: 登録済みなら何もしない。edge は登録しっぱなしでよい。
- **level-triggered (select / poll)**: 登録済みで、しかも `ready` なら **外す**。level だと同じイベントが延々と返ってくるので、読みたくない間は外さないとループが焼ける。
- **event ports**: 通知のたびに登録が消えるので、`ready` になったら明示的に消す (整合を取る) か、消えているなら足す。

**`if` が 3 つ並んでいるだけで、深い抽象化はしていない。** それでも、この 80 行のおかげで、呼び出す側の 100 箇所以上が 1 行で済んでいる。

`rev->active` (カーネルに登録済み) と `rev->ready` (読める状態) の 2 ビットで、必要な判断が全部できているのが効いている。[ワーカーの 1 周のページ](../state-machine/) で見た `ngx_event_t` のフラグ設計が、ここで回収されている。

### `ready` を自分で維持する

edge-triggered では、カーネルは「変化したとき」しか教えてくれない。だから Nginx は **「まだ読めるはずか」を自分で追跡する**。

`ngx_unix_recv()` ([`src/os/unix/ngx_recv.c#L14-L170`](https://github.com/nginx/nginx/blob/release-1.31.4/src/os/unix/ngx_recv.c#L14-L170)) が、その追跡の中心になる。

```c title="src/os/unix/ngx_recv.c"
#if (NGX_HAVE_KQUEUE)

    if (ngx_event_flags & NGX_USE_KQUEUE_EVENT) {
        /* ... */
        if (rev->available == 0) {
            if (rev->pending_eof) {
                rev->ready = 0;
                rev->eof = 1;

                if (rev->kq_errno) {
                    rev->error = 1;
                    ngx_set_socket_errno(rev->kq_errno);

                    return ngx_connection_error(c, rev->kq_errno,
                               "kevent() reported about an closed connection");
                }

                return 0;

            } else {
                rev->ready = 0;
                return NGX_AGAIN;
            }
        }
    }

#endif
```

**kqueue では `recv()` を呼ばずに `NGX_AGAIN` を返せる。** `kev.data` で「あと何バイトあるか」が分かっているので、0 なら syscall が無駄だと確定している。しかも `EV_EOF` と `fflags` から、「相手が正常に閉じた」と「エラーで切れた」を **1 回も `recv()` を呼ばずに区別できる**。

epoll 側は情報が少ないので、`FIONREAD` で補う ([`#L121-L151`](https://github.com/nginx/nginx/blob/release-1.31.4/src/os/unix/ngx_recv.c#L121-L151))。

```c title="src/os/unix/ngx_recv.c"
            if (rev->available >= 0) {
                rev->available -= n;

                /*
                 * negative rev->available means some additional bytes
                 * were received between kernel notification and recv(),
                 * and therefore ev->ready can be safely reset even for
                 * edge-triggered event methods
                 */

                if (rev->available < 0) {
                    rev->available = 0;
                    rev->ready = 0;
                }
                /* ... */
            } else if ((size_t) n == size) {

                if (ngx_socket_nread(c->fd, &rev->available) == -1) {
                    /* ... */
                }
```

**バッファを埋めきったときだけ `FIONREAD` で残量を聞く。** 埋めきっていなければ、それ以上は無いと分かるので聞かない。聞いた残量から読んだぶんを引いていき、負になったら「通知と `recv()` の間に追加で届いた」ということなので、`ready` を落として安全側に倒す。

コメントが「なぜ edge-triggered でも `ready` を落として安全か」を説明していて、**この種の最適化に必ず要る「なぜ壊れないか」の議論**が残されている。

`EPOLLRDHUP` が使えるなら、もっと簡単になる ([`#L53-L68`](https://github.com/nginx/nginx/blob/release-1.31.4/src/os/unix/ngx_recv.c#L53-L68))。

```c title="src/os/unix/ngx_recv.c"
    if ((ngx_event_flags & NGX_USE_EPOLL_EVENT)
        && ngx_use_epoll_rdhup)
    {
        /* ... */
        if (rev->available == 0 && !rev->pending_eof) {
            rev->ready = 0;
            return NGX_AGAIN;
        }
    }
```

**残量 0 で、しかも相手が閉じていないと分かっているなら、`recv()` を呼ばない。** kqueue と同じことを、epoll でも `EPOLLRDHUP` と `FIONREAD` の組み合わせで実現している。

### 使える機能を実際に試す

`ngx_use_epoll_rdhup` は、`#ifdef` ではなく **実行時の実験**で決まる ([`src/event/modules/ngx_epoll_module.c#L464-L524`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/modules/ngx_epoll_module.c#L464-L524))。

```c title="src/event/modules/ngx_epoll_module.c"
static void
ngx_epoll_test_rdhup(ngx_cycle_t *cycle)
{
    int                 s[2], events;
    struct epoll_event  ee;

    if (socketpair(AF_UNIX, SOCK_STREAM, 0, s) == -1) {
        /* ... */
    }

    ee.events = EPOLLET|EPOLLIN|EPOLLRDHUP;

    if (epoll_ctl(ep, EPOLL_CTL_ADD, s[0], &ee) == -1) {
        /* ... */
    }

    if (close(s[1]) == -1) {
        /* ... */
    }

    s[1] = -1;

    events = epoll_wait(ep, &ee, 1, 5000);
    /* ... */
    if (events) {
        ngx_use_epoll_rdhup = ee.events & EPOLLRDHUP;

    } else {
        ngx_log_error(NGX_LOG_ALERT, cycle->log, NGX_ETIMEDOUT,
                      "epoll_wait() timed out");
    }

    ngx_log_debug1(NGX_LOG_DEBUG_EVENT, cycle->log, 0,
                   "testing the EPOLLRDHUP flag: %s",
                   ngx_use_epoll_rdhup ? "success" : "fail");
```

**socketpair を作り、片方を閉じ、`EPOLLRDHUP` が本当に報告されるかを見る。** ヘッダに `EPOLLRDHUP` が定義されていても、動くとは限らないからだ。コンテナのエミュレーション層や、古いカーネルの上で新しいヘッダを使ってビルドした場合がありうる。

これは起動時に 1 回だけ、ワーカーが立つ前に走る。5 秒のタイムアウト付きで、失敗しても致命的にはしない (機能を使わないだけ)。

**ビルド時の `#ifdef` は「このコードがコンパイルできるか」しか教えてくれない。** 実際に動くかは、動かしてみるしかない。この 60 行は、その差を埋めるために書かれている。

### 処理中に閉じられた fd

`epoll_wait` は複数のイベントをまとめて返す。i 番目のイベントを処理している間に、j 番目 (j > i) の対象が閉じられることがある。しかも [接続の再利用のページ](../connection-reuse/) のとおり、`ngx_connection_t` は使い回されるので、**同じアドレスに別の接続が入る**。

epoll モジュールの照合 ([`src/event/modules/ngx_epoll_module.c#L836-L854`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/modules/ngx_epoll_module.c#L836-L854))。

```c title="src/event/modules/ngx_epoll_module.c"
    for (i = 0; i < events; i++) {
        c = event_list[i].data.ptr;

        instance = (uintptr_t) c & 1;
        c = (ngx_connection_t *) ((uintptr_t) c & (uintptr_t) ~1);

        rev = c->read;

        if (c->fd == -1 || rev->instance != instance) {

            /*
             * the stale event from a file descriptor
             * that was just closed in this iteration
             */

            ngx_log_debug1(NGX_LOG_DEBUG_EVENT, cycle->log, 0,
                           "epoll: stale event %p", c);
            continue;
        }
```

**登録時にポインタの下位ビットに載せた `instance` を、取り出して照合する。** `c->fd == -1` (閉じられた) か、`instance` が反転している (再利用された) なら捨てる。

kqueue も同じ手を使う ([`src/event/modules/ngx_kqueue_module.c#L612-L625`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/modules/ngx_kqueue_module.c#L612-L625))。

```c title="src/event/modules/ngx_kqueue_module.c"
            instance = (uintptr_t) ev & 1;
            ev = (ngx_event_t *) ((uintptr_t) ev & (uintptr_t) ~1);

            if (ev->closed || ev->instance != instance) {

                /*
                 * the stale event from a file descriptor
                 * that was just closed in this iteration
                 */

                ngx_log_debug1(NGX_LOG_DEBUG_EVENT, cycle->log, 0,
                               "kevent: stale event %p", ev);
                continue;
            }
```

違いは、epoll が `ngx_connection_t *` を、kqueue が `ngx_event_t *` を登録していること。kqueue はフィルタごとに別エントリなので、イベント単位で紐づけられる。**どちらも下位 1 ビットが空いている**ので、同じ手法が使える。

書きイベントの側でも同じ判定をもう一度やっているのが丁寧で ([`#L907-L919`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/modules/ngx_epoll_module.c#L907-L919))、**読み handler の中で接続が閉じられた場合**を捉える。同じイテレーションの、同じ `event_list[i]` の中で状態が変わりうる。

### エラーを「読める・書ける」に翻訳する

epoll の処理でもう 1 つ ([`#L862-L873`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/modules/ngx_epoll_module.c#L862-L873))。

```c title="src/event/modules/ngx_epoll_module.c"
        if (revents & (EPOLLERR|EPOLLHUP)) {
            /* ... */

            /*
             * if the error events were returned, add EPOLLIN and EPOLLOUT
             * to handle the events at least in one active handler
             */

            revents |= EPOLLIN|EPOLLOUT;
        }
```

**エラーが起きたら、読みと書きの両方が起きたことにする。** そうしないと、`EPOLLERR` だけが返ってきたときに handler が 1 つも呼ばれず、エラーに気づかないまま接続が残る。

上位の handler は `recv()` や `send()` を呼び、そこでエラーを受け取って正しく処理する。**「エラー」という第 3 の通知経路を作らず、既存の 2 経路に合流させている。** [HTTP/2 のページ](../http2-multiplexing/) でフロー制御を `write->ready` に翻訳したのと同じ発想になっている。

### ループの外から起こす

`notify` は、イベントループの外にいる誰かがループを起こすための口だ。epoll では `eventfd` で実装される ([`#L385-L457`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/modules/ngx_epoll_module.c#L385-L457))。

```c title="src/event/modules/ngx_epoll_module.c"
    notify_event.log = log;
    notify_event.active = 1;

    notify_conn.fd = notify_fd;
    notify_conn.read = &notify_event;
    notify_conn.log = log;

    ee.events = EPOLLIN|EPOLLET;
    ee.data.ptr = &notify_conn;

    if (epoll_ctl(ep, EPOLL_CTL_ADD, notify_fd, &ee) == -1) {
```

**`eventfd` のために、偽の `ngx_connection_t` と偽の `ngx_event_t` を static 変数として 1 組だけ用意する。** [HTTP/2 のページ](../http2-multiplexing/) の偽の接続と同じ発想で、「イベントループが扱えるもの」の形に揃えることで、専用の経路を作らずに済ませている。

handler の中身が面白い ([`#L431-L457`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/modules/ngx_epoll_module.c#L431-L457))。

```c title="src/event/modules/ngx_epoll_module.c"
static void
ngx_epoll_notify_handler(ngx_event_t *ev)
{
    ssize_t               n;
    uint64_t              count;
    ngx_err_t             err;
    ngx_event_handler_pt  handler;

    if (++ev->index == NGX_MAX_UINT32_VALUE) {
        ev->index = 0;

        n = read(notify_fd, &count, sizeof(uint64_t));
        /* ... */
    }

    handler = ev->data;
    handler(ev);
}
```

**`eventfd` を毎回読まない。** 42 億回に 1 回だけ読んでカウンタをリセットする。`eventfd` のカウンタは 64 ビットで、溢れるまで書き続けても実用上問題ないので、**`read()` の syscall を省いている**。

`ev->index` (本来はイベントメソッドの内部添字) をカウンタに流用しているのは、[接続の再利用のページ](../connection-reuse/) の `c->data` をフリーリストに流用するのと同じ手口だ。

### 既定のイベントメソッドを選ぶ

[`src/event/ngx_event.c#L1300-L1363`](https://github.com/nginx/nginx/blob/release-1.31.4/src/event/ngx_event.c#L1300-L1363)。

```c title="src/event/ngx_event.c"
    module = NULL;

#if (NGX_HAVE_EPOLL) && !(NGX_TEST_BUILD_EPOLL)

    fd = epoll_create(100);

    if (fd != -1) {
        (void) close(fd);
        module = &ngx_epoll_module;

    } else if (ngx_errno != NGX_ENOSYS) {
        module = &ngx_epoll_module;
    }

#endif

#if (NGX_HAVE_DEVPOLL) && !(NGX_TEST_BUILD_DEVPOLL)

    module = &ngx_devpoll_module;

#endif

#if (NGX_HAVE_KQUEUE)

    module = &ngx_kqueue_module;

#endif

#if (NGX_HAVE_SELECT)

    if (module == NULL) {
        module = &ngx_select_module;
    }

#endif
```

ここでも **実際に `epoll_create()` を呼んでみる**。成功すれば当然使う。失敗しても `ENOSYS` (システムコールが無い) 以外なら使う — fd の枯渇や権限の問題かもしれないので、「機能が無い」とは判断しない。

**エラーの種類で「機能が無い」と「今たまたま失敗した」を区別している。** 起動時の 1 回の失敗で、以後ずっと遅い `select` に落ちるのは避けたい。

`#if` の並びが優先順位で、`kqueue` が最後に上書きするので最優先になる。どれも無ければ `select`。それでも無ければ、リンクされているイベントモジュールを 1 つ拾う。

### I/O 関数も別の表

`ngx_event_actions` の隣に、もう 1 つ表がある ([`src/os/unix/ngx_os.h#L26-L35`](https://github.com/nginx/nginx/blob/release-1.31.4/src/os/unix/ngx_os.h#L26-L35))。

```c title="src/os/unix/ngx_os.h"
typedef struct {
    ngx_recv_pt        recv;
    ngx_recv_chain_pt  recv_chain;
    ngx_recv_pt        udp_recv;
    ngx_send_pt        send;
    ngx_send_pt        udp_send;
    ngx_send_chain_pt  udp_send_chain;
    ngx_send_chain_pt  send_chain;
    ngx_uint_t         flags;
} ngx_os_io_t;
```

**「待つ方法」と「読み書きする方法」が別の表になっている。** Linux では `send_chain` が `ngx_linux_sendfile_chain` (sendfile 対応)、FreeBSD では `ngx_freebsd_sendfile_chain`、sendfile が無ければ `ngx_writev_chain`。

これは `ngx_os_init()` で決まり、イベントメソッドの `init` が `ngx_io = ngx_os_io;` でコピーする。接続ごとに `c->recv` / `c->send_chain` にさらにコピーされ、そこから SSL や [HTTP/2](../http2-multiplexing/) が差し替える。

**3 段のコピー (OS → イベントメソッド → 接続) を経ることで、各段が上書きする余地を持っている。**

## なぜそうなっているか

### 「どの API か」ではなく「どういう性質か」

`NGX_USE_CLEAR_EVENT` は「edge-triggered である」であって「epoll である」ではない。kqueue も epoll も、この 1 つのフラグで同じ扱いを受ける。

この切り方の価値は、**上位のコードが実装の名前を知らない**ことだ。`ngx_handle_read_event()` の中身は 3 つの分岐だが、それは「edge / level / oneshot」という **性質の分類**であって、実装の数 (7 つ) ではない。実装が増えても、既存のどれかの性質を持っていれば分岐は増えない。

例外が `NGX_USE_KQUEUE_EVENT` で、これは実装を名指ししている。kqueue が返す情報が他に類を見ないからで、**抽象化しきれなかったところに正直に穴を開けている**。無理に一般化して `NGX_USE_AVAILABLE_EVENT` のようなフラグを作ると、kqueue しか立てないフラグができるだけになる。

### 定数をネイティブ値にする代償と見返り

`NGX_READ_EVENT` が `EVFILT_READ` だったり `EPOLLIN|EPOLLRDHUP` だったり `0` だったりするのは、**型としては最悪**だ。同じ名前が、ビットマスクにも列挙値にも配列添字にもなる。デバッガで値を見ても意味が分からない。

見返りは、変換が消えることだ。`ngx_epoll_add_event()` は渡された `event` をそのまま `ee.events` に OR できる。`switch (event) { case NGX_READ_EVENT: ... }` を 7 つの実装それぞれに書く必要がない。

これは **抽象のコストをどこで払うか**の選択になっている。呼び出し側で払う (Nginx 独自の値を使い、実装が変換する) か、ビルド時に払う (`#define` で実装ごとに値を変える) か。Nginx は後者を選んだ。「イベントメソッドは実行中に切り替わらない」という前提があるから成立する。

### `ready` の追跡は最適化ではなく必要

edge-triggered では、`EAGAIN` が返るまで読まないと通知を取りこぼす。`NGX_USE_GREEDY_EVENT` がそれを表している。

一方で、毎回 `EAGAIN` が返るまで読むと **確実に 1 回は無駄な `recv()` が入る**。1KB のレスポンスを読むのに `recv()` が 2 回になる。接続が数万あれば、この 1 回が効いてくる。

`rev->available` を追跡すると、この 1 回を省ける。kqueue は最初から教えてくれるので簡単で、epoll では `FIONREAD` を使う。ただし **カーネルの状態をユーザー空間でミラーする**ことになるので、ずれるとハングする。だから `available < 0` になったら安全側に倒す、というコメント付きの防御が入っている。

後の「取り込むべきでない条件」に書くとおり、これは 20 年かけて詰めてきたから成立している最適化で、新しく書くコードで最初からやるものではない。

### `#ifdef` と実行時テストの使い分け

`NGX_HAVE_EPOLLRDHUP` はビルド時のマクロで、「ヘッダに定義があるか」を表す。`ngx_use_epoll_rdhup` は実行時の変数で、「実際に動くか」を表す。両方が要る。

同じ構造が `epoll_create()` の試行にもある。ビルドできることと、実行環境で使えることは別だ。**バイナリを配布するソフトウェアでは、この 2 段が必須**になる。ディストリビューションがビルドした nginx が、古いカーネルのコンテナで動くことは普通にある。

実行時テストのコストは起動時の数ミリ秒 (最悪 5 秒のタイムアウト) で、ワーカーが立つ前に 1 回だけ。**払う場所を選べば、コストは無視できる。**

### `instance` の 1 ビットが 2 つの実装で共有されている

epoll と kqueue が、まったく同じ手法で stale event を弾いている。しかも登録するポインタの型が違う (`ngx_connection_t *` と `ngx_event_t *`) のに、**「下位 1 ビットが空いている」という性質だけが共通**していれば成立する。

抽象化はされていない。両方のファイルに同じ 10 行が書いてある。共通化しようとすると「ポインタと 1 ビットを詰める / 取り出す」マクロになるが、それは 2 行の関数を隠すだけで、読みやすさは上がらない。**重複を許すほうが読みやすい場面**の例になっている。

## どう活かすか

### そのまま真似できるところ

**プラットフォームの差を、「実装の名前」ではなく「性質のフラグ」で表す。** `if (linux)` ではなく `if (edge_triggered)` と書けると、上位のコードが実装の数から解放される。新しい実装を足すときに、既存の性質の組み合わせで表せるかを先に考える。

**抽象化しきれない部分には、正直に穴を開ける。** `NGX_USE_KQUEUE_EVENT` のように実装を名指しするフラグを 1 つ置く。無理に一般化した名前を付けると、意味が伝わらないまま同じことをする。

**「この実装には無い機能」を `NULL` の関数ポインタで表す。** 呼ぶ側が `if (fn)` で分岐でき、機能の有無が表の 1 行として読める。

**プラットフォーム固有の設定を、その実装のファイルに閉じる。** イベントメソッドがモジュールとして自分の設定を持てる形にしておくと、コアに `if (epoll なら)` が生えない。

**ビルド時の `#ifdef` と、実行時の機能テストを両方持つ。** ヘッダにあることと、動くことは別。バイナリを配るなら実行時テストが要る。起動時に 1 回だけ払えばコストは無視できる。

**「機能が無い」と「今たまたま失敗した」を、エラーの種類で区別する。** `ENOSYS` なら諦める、それ以外なら再挑戦する。起動時の 1 回の失敗で恒久的に劣化させない。

**エラー通知を、既存の成功経路に合流させる。** `EPOLLERR` を `EPOLLIN|EPOLLOUT` に翻訳することで、エラー専用の handler が要らなくなる。既存の `recv()` / `send()` がエラーを受け取って処理する。

**「再利用されるオブジェクトの世代」を、ポインタの空きビットに載せる。** アライメントが保証されている型なら、下位 1〜3 ビットが使える。バッチでイベントを取得する仕組みには、ほぼ必ずこの問題が出る。

**共通化しないという判断も、選択肢に入れる。** epoll と kqueue の stale event 判定は 10 行がほぼ同じだが、共通化していない。抽出しても読みやすくならないなら、そのままにしておく。

### 取り込むべきでない条件

**同じ名前の定数が実装によって違う型になるのは、今なら避けたい。** `NGX_READ_EVENT` がビットマスクにも配列添字にもなるのは、C のマクロだから書けてしまう。型のある言語なら、変換を 1 箇所に置くほうがいい。

**カーネルの状態をユーザー空間でミラーする最適化は、慎重に。** `rev->available` の追跡は syscall を 1 回省くが、ずれるとハングする。効果を測ってから、しかも「ずれたら安全側に倒す」を必ず入れる。

**`ev->index` をカウンタに流用するような節約は、読み手を混乱させる。** `notify_handler` の 42 億回に 1 回の `read()` は、確かに syscall を省くが、そのために `index` の意味が場所によって変わる。フィールドを 1 つ足すコストと比べる価値がある。

**7 種類のイベントメソッドを維持するコストは、今なら払わなくていい。** `/dev/poll` も event ports も、実質的に使われていない。移植性のために抽象を作るなら、実際に動かす環境の数を見積もってからにする。Nginx がこれを維持しているのは、2000 年代前半に「どの API が生き残るか分からなかった」からだ。

## 関連

- `ngx_event_t` のフラグと handler の設計は [ワーカーの 1 周のページ](../state-machine/)。
- `instance` ビットが必要になる理由 (接続の使い回し) は [接続の再利用のページ](../connection-reuse/)。
- `NGX_POST_EVENTS` を立てる側の事情は [accept の分配のページ](../accept-distribution/)。
- `ngx_notify()` を使う側は [ブロックする I/O のページ](../blocking-io/)。

---
title: "特権を要る仕事だけを親に残し、fork の前にソケットを開いてしまう"
description: "master は root のまま残り、worker は setuid して非特権になる。80 番ポートの listen は fork より前に済ませてあるので、非特権のワーカーが特権ポートを持ったまま動ける。master はイベントループを持たず sigsuspend で寝るだけで、シグナルハンドラはフラグを立てるだけ。指示は情報の乗らないシグナルではなく socketpair のチャネルで送り、後から生まれた兄弟の fd は SCM_RIGHTS で配る。"
group: "プロセスとイベント"
sidebar:
  order: 1
---

## 何を学んだか

### どんな状況の話か

HTTP サーバは 80 番と 443 番を listen したい。Unix では 1024 番未満のポートを bind するのに root が要る。一方で、外から来たバイトを解釈する処理を root で走らせたくはない。

さらに、Nginx は「1 プロセス 1 スレッドで数万接続」を CPU コアの数だけ並べて性能を出す。つまり複数のプロセスが同じポートに来た接続を受けなければならない。設定を再読み込みしたり、ログを開き直したり、死んだワーカーを蘇らせたりする役も要る。

この 3 つを、C で、追加のスレッドも IPC ライブラリも使わずにどう組むか。

### Nginx の答え

1. **特権が要る操作を、fork より前・setuid より前に全部済ませる。** `main()` は root のまま `ngx_init_cycle()` を呼び、その中でリスニングソケットを開く。ワーカーはその後 `fork()` で作られ、`setuid()` で非特権に落ちる。すでに開いた fd に権限チェックはかからないので、非特権のワーカーが 80 番の listen ソケットを持ったまま `accept()` できる。
2. **master はイベントループを持たない。** `sigsuspend()` で寝て、シグナルで起きて、フラグを見て、また寝る。接続も設定も触らないので、master が忙しくなる余地がない。
3. **シグナルハンドラは `ngx_quit = 1` のような代入しかしない。** 実際の処理はループの先頭で行う。async-signal-safe でない関数を一切呼ばないために、ハンドラから使う時刻更新まで `ngx_time_sigsafe_update()` という別関数になっている。
4. **master → worker の指示は、シグナルではなく socketpair 上のチャネルで送る。** `ngx_spawn_process()` は fork の前に `socketpair(AF_UNIX)` を作り、片端を親、片端を子が持つ。チャネル書き込みに失敗したときだけ `kill()` にフォールバックする。
5. **後から生まれたワーカーの fd は、既存のワーカーに `SCM_RIGHTS` で配る。** fork 済みのワーカーは「自分より後に生まれた兄弟」の socketpair を知らない。master は 1 つワーカーを起こすたびに `ngx_pass_open_channel()` を呼び、全員に新しい fd を送りつける。
6. **ワーカーは状態を持たないので、死んだら作り直せばいい。** `SIGCHLD` で `ngx_reap = 1` が立ち、master は `ngx_reap_children()` で回収して `ngx_spawn_process()` を撃ち直す。
7. **graceful shutdown は「入口を閉じてから待つ」。** listening ソケットを閉じ、idle 接続を閉じ、残りのタイマが尽きたら終了する。

## ソースコードのどこか

### 特権が要ることは全部 root のうちに

[`src/core/nginx.c#L250-L388`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/nginx.c#L250-L388)。`main()` の後半はほぼ 1 本道で、途中に fork も setuid も出てこない。

```c title="src/core/nginx.c"
    if (ngx_add_inherited_sockets(&init_cycle) != NGX_OK) {
        return 1;
    }

    if (ngx_preinit_modules() != NGX_OK) {
        return 1;
    }

    cycle = ngx_init_cycle(&init_cycle);   /* ← ここで listen まで済む */
    if (cycle == NULL) {
        /* ... */
    }
    /* ... */
    if (ngx_process == NGX_PROCESS_SINGLE) {
        ngx_single_process_cycle(cycle);

    } else {
        ngx_master_process_cycle(cycle);
    }
```

listen は `ngx_init_cycle()` の中、[`src/core/ngx_cycle.c#L632-L637`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_cycle.c#L632-L637) にある。

```c title="src/core/ngx_cycle.c"
    if (ngx_open_listening_sockets(cycle) != NGX_OK) {
        goto failed;
    }

    if (!ngx_test_config) {
        ngx_configure_listening_sockets(cycle);
    }
```

順序が肝で、`ngx_init_cycle()` → `ngx_master_process_cycle()` → `ngx_start_worker_processes()` → `ngx_spawn_process()` → `fork()` → `ngx_worker_process_init()` → `setuid()` という並びになっている。特権が必要な操作 (特権ポートの bind、ログファイルの open、pid ファイルの作成) は全部、この列の前半に集めてある。

`setuid()` は [`src/os/unix/ngx_process_cycle.c#L799-L851`](https://github.com/nginx/nginx/blob/release-1.31.4/src/os/unix/ngx_process_cycle.c#L799-L851)。

```c title="src/os/unix/ngx_process_cycle.c"
    if (geteuid() == 0) {
        if (setgid(ccf->group) == -1) {
            /* fatal */
            exit(2);
        }

        if (initgroups(ccf->username, ccf->group) == -1) {
            /* ... */
        }
        /* ... */
        if (setuid(ccf->user) == -1) {
            /* fatal */
            exit(2);
        }

#if (NGX_HAVE_CAPABILITIES)
        if (ccf->transparent && ccf->user) {
            /* CAP_NET_RAW だけを残す */
            data.effective = CAP_TO_MASK(CAP_NET_RAW);
            data.permitted = data.effective;

            if (syscall(SYS_capset, &header, &data) == -1) {
                /* fatal */
                exit(2);
            }
        }
#endif
    }
```

`setgid` が `setuid` より先なのは定石で、逆にすると非特権ユーザーになった後にグループを変える権限がもう無い。`transparent` (上流への接続元 IP を偽装するモード) を使うときだけは `CAP_NET_RAW` を残すため、`setuid()` の前に `PR_SET_KEEPCAPS` を立て、後で `capset()` で 1 個だけ拾い直す。「非特権にするが、1 つだけ例外を作る」を、丸ごと root で走らせる代わりに capability 1 個の粒度で表現している。

### master のループ

[`src/os/unix/ngx_process_cycle.c#L73-L139`](https://github.com/nginx/nginx/blob/release-1.31.4/src/os/unix/ngx_process_cycle.c#L73-L139) で、まず自分が扱うシグナルを全部ブロックする。

```c title="src/os/unix/ngx_process_cycle.c"
    sigemptyset(&set);
    sigaddset(&set, SIGCHLD);
    sigaddset(&set, SIGALRM);
    sigaddset(&set, SIGIO);
    sigaddset(&set, SIGINT);
    sigaddset(&set, ngx_signal_value(NGX_RECONFIGURE_SIGNAL));
    /* ... */
    if (sigprocmask(SIG_BLOCK, &set, NULL) == -1) {
        /* ... */
    }
```

ブロックしておいて、[`#L139-L260`](https://github.com/nginx/nginx/blob/release-1.31.4/src/os/unix/ngx_process_cycle.c#L139-L260) のループでは `sigsuspend()` の間だけ解除する。

```c title="src/os/unix/ngx_process_cycle.c"
    for ( ;; ) {
        /* ... */
        sigsuspend(&set);

        ngx_time_update();

        if (ngx_reap) {
            ngx_reap = 0;
            live = ngx_reap_children(cycle);
        }

        if (!live && (ngx_terminate || ngx_quit)) {
            ngx_master_process_exit(cycle);
        }

        if (ngx_terminate) { /* ... */ }

        if (ngx_quit) {
            ngx_signal_worker_processes(cycle,
                                        ngx_signal_value(NGX_SHUTDOWN_SIGNAL));
            ngx_close_listening_sockets(cycle);

            continue;
        }

        if (ngx_reconfigure) { /* ... */ }
        if (ngx_restart) { /* ... */ }
        /* ngx_reopen, ngx_change_binary, ngx_noaccept も同じ形 */
    }
```

`sigprocmask` でブロックしてから `sigsuspend(&set)` で「解除して寝る」のは、フラグを見てから寝るまでの隙間にシグナルが来て取りこぼす競合を防ぐため。ループは全体が「フラグを 1 つ見て、処理して、フラグを落とす」の羅列で、状態遷移が `if` の並びとして読める。

master が `epoll` を回さないことも重要で、master には接続もタイマも無い。`ngx_process_events_and_timers()` を呼ぶのはワーカーだけ ([`#L710-L748`](https://github.com/nginx/nginx/blob/release-1.31.4/src/os/unix/ngx_process_cycle.c#L710-L748))。

```c title="src/os/unix/ngx_process_cycle.c"
    for ( ;; ) {

        if (ngx_exiting) {
            if (ngx_event_no_timers_left() == NGX_OK) {
                ngx_worker_process_exit(cycle);
            }
        }

        ngx_process_events_and_timers(cycle);

        if (ngx_terminate) {
            ngx_worker_process_exit(cycle);
        }

        if (ngx_quit) {
            ngx_quit = 0;
            ngx_setproctitle("worker process is shutting down");

            if (!ngx_exiting) {
                ngx_exiting = 1;
                ngx_set_shutdown_timer(cycle);
                ngx_close_listening_sockets(cycle);
                ngx_close_idle_connections(cycle);
                ngx_event_process_posted(cycle, &ngx_posted_events);
            }
        }

        if (ngx_reopen) { /* ... */ }
    }
```

master と worker でループの形が揃っている。どちらも「フラグを見る」ループで、違いは寝る手段が `sigsuspend()` か `epoll_wait()` かだけになっている。

### シグナルハンドラは代入だけ

[`src/os/unix/ngx_process.c#L318-L404`](https://github.com/nginx/nginx/blob/release-1.31.4/src/os/unix/ngx_process.c#L318-L404)。

```c title="src/os/unix/ngx_process.c"
static void
ngx_signal_handler(int signo, siginfo_t *siginfo, void *ucontext)
{
    /* ... */
    err = ngx_errno;
    /* ... */
    ngx_time_sigsafe_update();
    /* ... */
    switch (ngx_process) {

    case NGX_PROCESS_MASTER:
    case NGX_PROCESS_SINGLE:
        switch (signo) {

        case ngx_signal_value(NGX_SHUTDOWN_SIGNAL):
            ngx_quit = 1;
            action = ", shutting down";
            break;
        /* ... */
        case SIGCHLD:
            ngx_reap = 1;
            break;
        }
```

同じシグナル番号でも `ngx_process` (master か worker か) で意味が変わる。`SIGWINCH` は master では「accept を止めろ」、worker では「終われ」になる。ハンドラの中でやるのは、`errno` の退避、シグナル安全な時刻更新、フラグの代入、ログ 1 行だけ。処理の本体はループが起きてからやる。

`ngx_time_sigsafe_update()` がわざわざ別関数なのは、通常の `ngx_time_update()` がログ用の各種フォーマット済み文字列を書き換えるため。ハンドラの中で書き換え途中の文字列を作ると、割り込まれた側がそれを読んでしまう。シグナル安全版は、ログの行頭に使う `ngx_cached_err_log_time` だけを更新する。

### 指示はシグナルではなくチャネルで

`ngx_spawn_process()` は fork の前に socketpair を作る ([`src/os/unix/ngx_process.c#L113-L186`](https://github.com/nginx/nginx/blob/release-1.31.4/src/os/unix/ngx_process.c#L113-L186))。

```c title="src/os/unix/ngx_process.c"
    if (respawn != NGX_PROCESS_DETACHED) {

        /* Solaris 9 still has no AF_LOCAL */

        if (socketpair(AF_UNIX, SOCK_STREAM, 0, ngx_processes[s].channel) == -1)
        {
            /* ... */
        }

        if (ngx_nonblocking(ngx_processes[s].channel[0]) == -1) { /* ... */ }
        if (ngx_nonblocking(ngx_processes[s].channel[1]) == -1) { /* ... */ }

        on = 1;
        if (ioctl(ngx_processes[s].channel[0], FIOASYNC, &on) == -1) { /* ... */ }
        if (fcntl(ngx_processes[s].channel[0], F_SETOWN, ngx_pid) == -1) { /* ... */ }
        if (fcntl(ngx_processes[s].channel[0], F_SETFD, FD_CLOEXEC) == -1) { /* ... */ }
        if (fcntl(ngx_processes[s].channel[1], F_SETFD, FD_CLOEXEC) == -1) { /* ... */ }

        ngx_channel = ngx_processes[s].channel[1];
    }

    ngx_process_slot = s;

    pid = fork();
```

`FIOASYNC` + `F_SETOWN` で、親側の端に読めるデータが来たら親に `SIGIO` が飛ぶようにしてある。master は `epoll` を回さないので、チャネルの読みを待つ手段がこれしかない。`FD_CLOEXEC` は、バイナリアップグレードで `execve()` したときにチャネルを引き継がないため。

master がワーカーを止めるときは、まずチャネルにコマンドを書き、失敗したら `kill()` する ([`#L469-L529`](https://github.com/nginx/nginx/blob/release-1.31.4/src/os/unix/ngx_process_cycle.c#L469-L529))。

```c title="src/os/unix/ngx_process_cycle.c"
        if (ch.command) {
            if (ngx_write_channel(ngx_processes[i].channel[0],
                                  &ch, sizeof(ngx_channel_t), cycle->log)
                == NGX_OK)
            {
                if (signo != ngx_signal_value(NGX_REOPEN_SIGNAL)) {
                    ngx_processes[i].exiting = 1;
                }

                continue;
            }
        }

        ngx_log_debug2(NGX_LOG_DEBUG_CORE, cycle->log, 0,
                       "kill (%P, %d)", ngx_processes[i].pid, signo);

        if (kill(ngx_processes[i].pid, signo) == -1) {
            err = ngx_errno;
            /* ... */
            if (err == NGX_ESRCH) {
                ngx_processes[i].exited = 1;
                ngx_processes[i].exiting = 0;
                ngx_reap = 1;
            }

            continue;
        }
```

`kill()` が `ESRCH` を返したら、そのワーカーはもう居ないということなので、その場で `exited` を立てて `ngx_reap` を立てる。シグナルが来るのを待たずに自分で回収要求を出している。

ワーカー側はチャネルを普通の読みイベントとして登録する ([`#L929-L935`](https://github.com/nginx/nginx/blob/release-1.31.4/src/os/unix/ngx_process_cycle.c#L929-L935))。

```c title="src/os/unix/ngx_process_cycle.c"
    if (ngx_add_channel_event(cycle, ngx_channel, NGX_READ_EVENT,
                              ngx_channel_handler)
        == NGX_ERROR)
    {
        /* fatal */
        exit(2);
    }
```

`ngx_channel_handler()` ([`#L1000-L1090`](https://github.com/nginx/nginx/blob/release-1.31.4/src/os/unix/ngx_process_cycle.c#L1000-L1090)) がやることも、結局はフラグの代入だ。

```c title="src/os/unix/ngx_process_cycle.c"
        switch (ch.command) {

        case NGX_CMD_QUIT:
            ngx_quit = 1;
            break;

        case NGX_CMD_TERMINATE:
            ngx_terminate = 1;
            break;

        case NGX_CMD_REOPEN:
            ngx_reopen = 1;
            break;

        case NGX_CMD_OPEN_CHANNEL:
            ngx_processes[ch.slot].pid = ch.pid;
            ngx_processes[ch.slot].channel[0] = ch.fd;
            break;
```

シグナル経路とチャネル経路が同じフラグに合流している。だから受け手のループはどちらから来たかを気にしなくていい。

### fd を配る

fork の順序には問題がある。1 番目のワーカーが生まれた時点で 2 番目の socketpair はまだ存在しないので、1 番目は 2 番目と話す手段を持たない。`ngx_pass_open_channel()` がこれを埋める ([`#L395-L428`](https://github.com/nginx/nginx/blob/release-1.31.4/src/os/unix/ngx_process_cycle.c#L395-L428))。

```c title="src/os/unix/ngx_process_cycle.c"
    ch.command = NGX_CMD_OPEN_CHANNEL;
    ch.pid = ngx_processes[ngx_process_slot].pid;
    ch.slot = ngx_process_slot;
    ch.fd = ngx_processes[ngx_process_slot].channel[0];

    for (i = 0; i < ngx_last_process; i++) {

        if (i == ngx_process_slot
            || ngx_processes[i].pid == -1
            || ngx_processes[i].channel[0] == -1)
        {
            continue;
        }
        /* ... */
        /* TODO: NGX_AGAIN */

        ngx_write_channel(ngx_processes[i].channel[0],
                          &ch, sizeof(ngx_channel_t), cycle->log);
    }
```

`ngx_start_worker_processes()` が `ngx_spawn_process()` の直後に毎回これを呼ぶので、n 番目を起こすたびに 1..n-1 番へ n の fd が配られる。

fd そのものは `SCM_RIGHTS` に載せて送る ([`src/os/unix/ngx_channel.c#L13-L54`](https://github.com/nginx/nginx/blob/release-1.31.4/src/os/unix/ngx_channel.c#L13-L54))。

```c title="src/os/unix/ngx_channel.c"
    if (ch->fd == -1) {
        msg.msg_control = NULL;
        msg.msg_controllen = 0;

    } else {
        msg.msg_control = (caddr_t) &cmsg;
        msg.msg_controllen = sizeof(cmsg);

        ngx_memzero(&cmsg, sizeof(cmsg));

        cmsg.cm.cmsg_len = CMSG_LEN(sizeof(int));
        cmsg.cm.cmsg_level = SOL_SOCKET;
        cmsg.cm.cmsg_type = SCM_RIGHTS;

        /*
         * We have to use ngx_memcpy() instead of simple
         *   *(int *) CMSG_DATA(&cmsg.cm) = ch->fd;
         * because some gcc 4.4 with -O2/3/s optimization issues the warning:
         *   dereferencing type-punned pointer will break strict-aliasing rules
         */

        ngx_memcpy(CMSG_DATA(&cmsg.cm), &ch->fd, sizeof(int));
    }
```

`ch->fd == -1` を「fd は付いていない」の意味に使い、同じ関数で「コマンドだけ」と「コマンド + fd」の両方を送れるようにしている。

ワーカー側は `ngx_processes[]` という固定長 1024 個の配列 ([`src/os/unix/ngx_process.h#L47`](https://github.com/nginx/nginx/blob/release-1.31.4/src/os/unix/ngx_process.h#L47)) を持ち、スロット番号で相手を指す。pid ではなくスロット番号なのは、配列の添字としてそのまま使えるから。

## なぜそうなっているか

### 「特権を落とす」ではなく「特権が要る仕事を前に寄せる」

権限降格を「後からやること」として設計すると、降格後に特権が要る操作が出てきたときに詰む。よくある回避策は、root のヘルパープロセスを常駐させて RPC で頼む形になる。Nginx はそれを避けて、**特権が要る操作が起動シーケンスの前半にしか出てこないように、機能のほうを設計している**。

これが効いているのが設定リロードで、`ngx_init_cycle()` を master (root のまま) がもう一度呼ぶ。新しい設定で新しいポートを開く必要があってもそこは root なので開ける。ワーカーは常に「もう開いたソケット」を受け取る側でいられる。ログファイルの reopen も同じで、非特権のワーカーが自分で `open()` するのではなく、権限のある文脈で開いた fd を持ち回る形にしてある。

### master に仕事をさせないと、master のバグでサービスが止まらない

master は接続を持たず、リクエストを解釈せず、`epoll` すら回さない。やることはフラグを見て `fork` と `kill` を呼ぶことだけ。行数にして数百行で、そこには攻撃者由来のバイトが 1 バイトも流れてこない。

裏返すと、**リクエスト処理のバグでワーカーが `SIGSEGV` しても、master は無傷で生き残って作り直せる**。ワーカーが状態を共有メモリと fd 以外に持たないので、作り直しは fork し直すだけで済む。監督者と実行者を分けることの価値は、監督者を徹底的に暇にして初めて出てくる。

### シグナルは通知にしか使わず、指示はチャネルで送る

シグナルには 2 つ困ったところがある。ペイロードを載せられないことと、同じシグナルが連続して届いてもまとめられてしまうことだ。加えてハンドラの中では async-signal-safe な関数しか呼べないので、実質フラグを立てる以上のことはできない。

Nginx はシグナルを「起こすため」だけに使い、意味のある指示は socketpair のチャネルに載せている。チャネルなら `ngx_channel_t` の構造体を送れるので、`NGX_CMD_OPEN_CHANNEL` のように fd とスロット番号を添えられる。そして受け手側はチャネルもシグナルも同じグローバルフラグに合流させるので、ループは経路の違いを知らずに済む。

外から `nginx -s reload` するときはシグナルしか使えない (master の pid しか公開されていない) が、内部の master → worker はチャネルが本線でシグナルはフォールバック、という非対称になっている。**外部インターフェースは枯れた仕組みに合わせ、内部は情報量の多い仕組みに乗り換える** という切り分けになっている。

### `ngx_pass_open_channel()` は「後から来た者を既存の全員に知らせる」問題

fork ベースのプロセス群では、子は fork 時点のスナップショットしか持てない。後から増えたメンバーを知る手段が要る。中央のブローカーを置くか、fd を配るかで、Nginx は後者を選んだ。

これで得られるのは、**ワーカー同士が master を介さずに直接話せる経路**だ。実際には現在の Nginx がワーカー間の直接通信をほとんど使っていない (チャネルのコマンドは master 発のものばかり) のだが、経路は張られている。

### 固定長 1024 の配列

`NGX_MAX_PROCESSES` は 1024 の定数で、`ngx_processes[]` は静的配列。動的に伸ばさないのは、この配列がシグナルハンドラの近くで触られる (`ngx_reap_children` から `ngx_last_process` を減らす) からで、確保・解放が絡むと厄介になる。上限を割り切って固定長にすることで、扱いが `pid == -1` かどうかのチェックだけになっている。

## どう活かすか

### そのまま真似できるところ

**特権が要る初期化を、起動シーケンスの先頭に集める。** ポートの bind、証明書の読み込み、ファイルの open、デバイスへのアクセス。これらを「起動時に 1 回だけやる」と決め、以降のコードが特権を前提にしないようにすると、権限降格が数行で済む。コンテナで動かすときも、`CAP_NET_BIND_SERVICE` を初期化フェーズにだけ与えれば済むようになる。

**監督者を徹底的に暇にする。** スーパーバイザ・プロセスマネージャ・オーケストレータを書くとき、そこに機能を足したくなる。ヘルスチェックのために HTTP を喋る、メトリクスを集める、設定を配る。足すたびに、監督者が落ちる確率と、監督者が攻撃対象になる面積が増える。Nginx の master は「フラグを見て fork と kill を呼ぶ」以上のことをしない。

**シグナルハンドラは代入だけにする。** これは C に限らず、Go の `signal.Notify` でチャネルに投げてループで受けるのも、Node の `process.on('SIGTERM')` でフラグを立ててイベントループに戻すのも、同じ形になる。「割り込み文脈では意思決定をしない、記録だけする」という原則として持ち帰れる。

**複数の入力経路を、1 つの状態に合流させる。** シグナルとチャネルという別々の経路が `ngx_quit` という 1 つのフラグに合流していて、メインループは経路を知らない。API から来た停止要求と SIGTERM から来た停止要求を別々に処理し始めると、片方だけ通るバグが必ず出る。入口で正規化して、以降は 1 本にする。

### 取り込むべきでない条件

**ワーカーが状態を持つなら、この形は成立しない。** 「死んだら fork し直す」が安いのは、ワーカーが再構築できるものしか持っていないからだ。ワーカー内にセッションやキャッシュを持たせた瞬間、再起動のコストが跳ね上がり、master に状態の引き継ぎロジックが要るようになる。そうなったらもう master は暇でいられない。

**プロセスモデル自体は、今のランタイムでは選びにくい。** Go や Rust の非同期ランタイムなら、同じ効果 (コア数ぶんの並列 + ブロックしない) をスレッドで得られる。Nginx が fork を選んだのは、2000 年代前半に移植性のあるスレッド API が無く、かつ「1 つのバグが全体を落とさない」隔離をタダで得られたからだ。今から書くなら、隔離が本当に必要かを先に問うほうがいい。

**`FIOASYNC` + `SIGIO` は使わないほうがいい。** master にイベントループが無いという制約から来た仕組みで、`SIGIO` は取りこぼしやすく移植性も低い。監督プロセスにイベントループを 1 本持たせるほうが、現代の環境では素直になる。

## 関連

- 次のページ [1 スレッドをブロックさせないために、処理をステートマシンにする](../state-machine/) で、ワーカーの中の `ngx_process_events_and_timers()` を開く。
- 全ワーカーが同じ listening ソケットを持つことから生まれる問題は [accept の分配](../accept-distribution/) で扱う。
- ワーカーが選ぶイベントメソッドの決まり方は [イベントメソッドのページ](../event-methods/)。
- `worker_shutdown_timeout` で graceful shutdown に上限を付ける話は [1 周の長さのページ](../loop-latency/)。

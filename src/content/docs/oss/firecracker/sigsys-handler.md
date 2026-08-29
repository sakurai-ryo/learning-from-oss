---
title: "拒否された syscall の番号を、死ぬ前にログへ残す"
description: "seccomp 違反で飛んでくる SIGSYS を捕まえ、si_code が SYS_SECCOMP かを確認し、siginfo から違反した syscall 番号を手計算のオフセットで取り出してログとメトリクスに残してから _exit する実装を読む。generate_handler! マクロによる致命的シグナルの共通化と、非同期シグナルセーフの制約も扱う。"
group: "隔離とセキュリティ"
sidebar:
  order: 56
---

## 何を学んだか

seccomp フィルタの `default_action` は `trap`、つまり `SECCOMP_RET_TRAP` である。許可されていないシステムコールを呼ぶと、カーネルはそのスレッドに `SIGSYS` を投げる。既定の動作はプロセスの異常終了だが、それだけだと運用者には何も分からない。「Firecracker がシグナル 31 で死んだ」しか残らず、どのシステムコールが原因だったのかを知る手立てがない。

Firecracker は `SIGSYS` にハンドラを登録し、死ぬ前に次の 3 つを残す。

1. `METRICS.seccomp.num_faults` に 1 を立てる
2. `"Shutting down VM after intercepting a bad syscall (<番号>)."` をログに書く
3. メトリクスをフラッシュしてから、専用の終了コード `148`（`FcExitCode::BadSyscall`）で `_exit`

```
許可されていない syscall
      │  seccomp-BPF: SECCOMP_RET_TRAP
      ▼
カーネルが SIGSYS を当該スレッドへ配送
      │  siginfo.si_code = SYS_SECCOMP (1) / si_syscall = 呼ばれた番号
      ▼
sigsys_handler()
      ├ si_signo == num == SIGSYS を確認
      ├ METRICS.seccomp.num_faults.store(1)
      ├ error_unrestricted!("Shutting down VM after intercepting signal ...")
      ├ log_sigsys_err(si_code, info)
      │    ├ si_code != SYS_SECCOMP なら UnexpectedError で終了
      │    └ *(info as *const i32).offset(6) から syscall 番号を読んでログ
      └ exit_with_code(BadSyscall)
           ├ METRICS.write()
           └ libc::_exit(148)
```

### syscall 番号はオフセットを手で計算して取り出す

`siginfo_t` は共用体を含む構造体で、シグナルの種類によって意味が変わる。`SIGSYS` の場合は `si_call_addr` / `si_syscall` / `si_arch` の 3 フィールドが入る。ところが Rust の `libc` クレートの `siginfo_t` にはこれらのフィールドが存在しない。そこで、構造体の先頭を `*const i32` として扱い、決め打ちのオフセットで読んでいる。

```rust title="src/vmm/src/signal_handler.rs"
// The offset of `si_syscall` (offending syscall identifier) within the siginfo structure
// expressed as an `(u)int*`.
// Offset `6` for an `i32` field means that the needed information is located at `6 * sizeof(i32)`.
// See /usr/include/linux/signal.h for the C struct definition.
// See https://github.com/rust-lang/libc/issues/716 for why the offset is different in Rust.
const SI_OFF_SYSCALL: isize = 6;
...
    let syscall = unsafe { *(info as *const i32).offset(SI_OFF_SYSCALL) };
```

`6 * 4 = 24` バイト目。x86_64 の `siginfo_t` は `si_signo`(4) + `si_errno`(4) + `si_code`(4) + パディング(4) = 16 バイトのヘッダに続いて共用体が始まり、`_sigsys` の中は `si_call_addr`(8) + `si_syscall`(4) + `si_arch`(4) なので、`si_syscall` は 16 + 8 = 24 バイト目になる。計算は合っている。

移植性のない書き方だが、コメントが「なぜこうなっているか」と「どこを見れば検証できるか」を両方書いている。値そのものより、値の根拠が追える形になっているほうが重要である。

### まず si_code を確認する

`SIGSYS` は seccomp 以外の理由でも飛びうる（`SIGSYS` 自体は「不正なシステムコール」を表す汎用のシグナルである）。だから最初に `si_code` を見る。

```rust title="src/vmm/src/signal_handler.rs"
fn log_sigsys_err(si_code: c_int, info: *mut siginfo_t) {
    if si_code != SYS_SECCOMP_CODE {
        // We received a SIGSYS for a reason other than `bad syscall`.
        exit_with_code(FcExitCode::UnexpectedError);
    }
```

`SYS_SECCOMP_CODE` は 1 で、カーネルの `SYS_SECCOMP` に対応する。これが違うなら `si_syscall` のオフセットを読む前提が崩れているので、番号を読まずに `UnexpectedError`（終了コード 2）で落ちる。前提が成り立たないなら読まない、という判断である。

### 他の致命的シグナルはマクロで量産する

`SIGSYS` だけでなく、`SIGBUS` / `SIGSEGV` / `SIGXFSZ` / `SIGXCPU` / `SIGHUP` / `SIGILL` にも同じ形のハンドラを付ける。共通部分がマクロになっている。

```rust title="src/vmm/src/signal_handler.rs"
macro_rules! generate_handler {
    ($fn_name:ident ,$signal_name:ident, $exit_code:ident, $signal_metric:expr, $body:ident) => {
        #[inline(always)]
        extern "C" fn $fn_name(num: c_int, info: *mut siginfo_t, _unused: *mut c_void) {
            let si_signo = unsafe { (*info).si_signo };
            let si_code = unsafe { (*info).si_code };

            if num != si_signo || num != $signal_name {
                exit_with_code(FcExitCode::UnexpectedError);
            }
            $signal_metric.store(1);

            error_unrestricted!(
                "Shutting down VM after intercepting signal {}, code {}.",
                si_signo, si_code
            );

            $body(si_code, info);

            match si_signo {
                $signal_name => exit_with_code(crate::FcExitCode::$exit_code),
                _ => exit_with_code(FcExitCode::UnexpectedError),
            };
        }
    };
}
```

呼び出し側は `generate_handler!(sigsys_handler, SIGSYS, BadSyscall, METRICS.seccomp.num_faults, log_sigsys_err)` のように 5 引数を渡すだけになる。シグナル固有の処理は最後の引数（`$body`）に切り出され、`SIGSYS` だけが `log_sigsys_err` を、残りは `empty_fn`（何もしない）を渡す。

マクロが強制している共通の型は次のとおり。

- **引数の一貫性チェック**: `num != si_signo || num != $signal_name` を確認する。第 1 引数のシグナル番号と `siginfo` の中の番号がずれていたら、その場で `UnexpectedError` で落ちる。
- **メトリクスを立てる**: `$signal_metric.store(1)`。`SharedStoreMetric` を使うのは、これらの値が 0 か 1 にしかならないためである。カウンタ型（インクリメント）だと、メトリクスのシリアライズ中に加算が入ったときのレースが問題になる、とメトリクス側のコメントに書かれている。
- **ログを残す**: 受け取ったシグナル番号と `si_code`。
- **終了コードを分ける**: `SIGBUS` は 149、`SIGSEGV` は 150、`SIGXFSZ` は 151、`SIGXCPU` は 154、`SIGPIPE` は 155、`SIGHUP` は 156、`SIGILL` は 157、そして seccomp 違反は 148。プロセスの終了コードだけで死因が分かる。

`exit_with_code` の中身は「`METRICS.write()` してから `libc::_exit(exit_code)`」の 2 行だけである。`exit()` ではなく `_exit()` を使う。`exit()` は atexit ハンドラを走らせ、stdio をフラッシュし、デストラクタを動かす。シグナルハンドラの中でそれをやると、割り込まれた地点の状態と衝突しうる。`_exit()` はカーネルに直行する。

### 非同期シグナルセーフの制約と、その破り方

シグナルハンドラの中で呼んでよい関数は、POSIX が「非同期シグナルセーフ」と定めたものに限られる。`malloc` も `printf` も入っていない。ロックを取る関数も入っていない。割り込まれたスレッドがすでにそのロックを持っていたら、ハンドラは自分自身を待ってデッドロックする。

Firecracker のハンドラは、この規則を意図的に破っている。ログを書き、メトリクスをフラッシュする。どちらも内部でロックを取る。`docs/prod-host-setup.md` がそれを正面から認めている。

> The custom signal handlers used by Firecracker are not async-signal-safe, since they write logs and flush the metrics, which use locks for synchronization. While very unlikely, it is possible that the handler will intercept a signal on a thread which is already holding a lock to the log or metrics buffer. This can result in a deadlock, where the specific Firecracker thread becomes unresponsive.
>
> While there is no security impact caused by the deadlock, we recommend that customers have an overwatcher process on the host, that periodically looks for Firecracker processes that are unresponsive, and kills them, by SIGKILL.

「セキュリティ上の影響はない」「デッドロックしたプロセスを見つけて SIGKILL する監視プロセスをホストに置け」。トレードオフを隠さず、残ったリスクの扱いを運用者に渡している。

リスクを減らす手当ても入っている。`log_sigsys_err` の `SAFETY` コメントが根拠を書いている。

> Other signals which might do async unsafe things incompatible with the rest of this function are blocked due to the sa_mask used when registering the signal handler.

ハンドラ登録時の `sa_mask` で他のシグナルをブロックしてあるので、ハンドラ実行中に別のハンドラが割り込んで同じロックを触ることはない。防げないのは「割り込まれた通常コードがすでにロックを持っていた」ケースだけになる。ログに `error!` ではなく `error_unrestricted!` を使っているのも意図的で、レートリミッタの静的な状態に触らずに済む。

### SIGPIPE だけは死なない

登録される 8 つのシグナルのうち、`SIGPIPE` だけが `generate_handler!` を使わず、専用のハンドラを持ち、プロセスを終了させない。

```rust title="src/vmm/src/signal_handler.rs"
extern "C" fn sigpipe_handler(num: c_int, info: *mut siginfo_t, _unused: *mut c_void) {
    // Just record the metric and allow the process to continue, the EPIPE error needs
    // to be handled at caller level.
    ...
    // Do not log here: the write that raised SIGPIPE is usually a log write, so
    // logging would re-enter the logger mid-write on this same thread.
    METRICS.signals.sigpipe.inc();
}
```

書き込み先のパイプが閉じていることは、プロセスを殺す理由にならない。`EPIPE` として呼び出し側が処理すればよい。そして「ここでログを書かない」理由が明示されている。`SIGPIPE` を起こした `write` はたいていログの書き込みそのものなので、ここでログを書くとロガーに再入する。この再入の問題は[ロガーの再入性](../logger-reentrancy/)で、シグナル全般の扱いは[シグナルハンドリング](../signal-handling/)で扱う。

## ソースコードのどこか

ファイル全体で 171 行しかない。[`src/vmm/src/signal_handler.rs`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/signal_handler.rs)。定数とオフセットの根拠は [`#L12-L19`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/signal_handler.rs#L12-L19)、`exit_with_code` は [`#L21-L29`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/signal_handler.rs#L21-L29)、マクロは [`#L31-L59`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/signal_handler.rs#L31-L59)、`SIGSYS` 固有の処理は [`#L61-L74`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/signal_handler.rs#L61-L74)。

7 つのハンドラの生成は [`#L78-L131`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/signal_handler.rs#L78-L131)、`SIGPIPE` の例外は [`#L133-L151`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/signal_handler.rs#L133-L151)、登録は [`#L153-L171`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/signal_handler.rs#L153-L171)。`register_signal_handlers` のコメントは「登録されたハンドラは現在のスレッドで呼ばれて作業を中断させるので、非同期シグナルセーフな操作だけをしなければならない」と書いている。

登録は `main` の中で、seccomp フィルタを組み立てるより先に行われる（[`src/firecracker/src/main.rs#L341`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/firecracker/src/main.rs#L341)、フィルタの構築は [`#L380-L384`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/firecracker/src/main.rs#L380-L384)）。シグナルの処理方法（disposition）はプロセス全体で共有されるので、メインスレッドで一度登録すれば、あとから生成される API スレッドや vCPU スレッドにも効く。

終了コードは [`src/vmm/src/lib.rs#L178-L192`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/lib.rs#L178-L192)。

```rust title="src/vmm/src/lib.rs"
    /// Firecracker was shut down after intercepting a restricted system call.
    BadSyscall = 148,
    /// Firecracker was shut down after intercepting `SIGBUS`.
    SIGBUS = 149,
```

メトリクスは [`src/vmm/src/logger/metrics.rs#L698-L711`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/logger/metrics.rs#L698-L711) の `SeccompMetrics`。`SharedStoreMetric` を選んだ理由は隣接する `SignalMetrics` のコメント [`#L713-L716`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/logger/metrics.rs#L713-L716) にある（`Deadly signals must be of SharedStoreMetric type, since they can ever be either 0 or 1. This avoids a tricky race condition caused by the unatomic serialize method`）。

非同期シグナルセーフでないことの明言は [`docs/prod-host-setup.md#L69-L83`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/docs/prod-host-setup.md#L69-L83)。

## なぜそうなっているか

**防御機構が発動したことを、運用者が知る必要がある。** seccomp フィルタが `SIGSYS` を投げてプロセスが死ぬのは、防御が正しく働いた結果である。しかし運用の側から見れば「microVM が突然消えた」という事象でしかない。原因が (a) 新しいコードパスが未許可の syscall を呼んだ実装バグなのか、(b) ライブラリの更新で内部実装が変わったのか、(c) 実際の攻撃なのかは、syscall 番号が分からないと切り分けられない。番号さえ残れば `ausyscall <番号>` で名前が引け、`resources/seccomp/*.json` にルールを足すかその呼び出しをやめるかの判断になる。1 個の整数が原因調査の入り口を作る。

**終了コードで死因を分けるのは、ログが取れないケースへの備えでもある。** ログの出力先（名前付きパイプ、ファイル）が詰まっている、あるいはログ設定が済む前に死んだ、といった場合でも、プロセスの終了コードは親プロセスに必ず届く。148 が返れば seccomp 違反、150 なら SEGV。監視側が終了コードでアラートを分けられる。

**マクロで量産するのは、抜けを作らないためである。** 7 つのハンドラは「メトリクスを立てる」「ログを書く」「メトリクスをフラッシュしてから `_exit`」という共通の型を持つ。手書きで 7 個並べれば、どれか 1 つでメトリクスの `store` を忘れる。マクロなら共通部分は 1 箇所しかなく、個別の違いは `$exit_code` / `$signal_metric` / `$body` の 3 つに限定される。

**非同期シグナルセーフを破る判断は、トレードオフとして書かれている。** 厳密に安全なハンドラにするなら、書けるのは「フラグを立てる」程度である。それでは syscall 番号を残せない。Firecracker が選んだのは「ごく低い確率のデッドロックを受け入れ、代わりに死因を記録する」という側で、しかも残ったリスクを `docs/prod-host-setup.md` に書いて運用者に渡している。セキュリティ影響がないこと（デッドロックしても隔離は破れない）を確認したうえでの判断である。

**`si_code` の確認を先にやるのは、メモリの読み方に前提があるからである。** `SI_OFF_SYSCALL` は「`SIGSYS` が seccomp 由来であること」を前提にしたオフセットである。前提が崩れているなら、その位置に何が入っているか分からない。読まずに終了する。ハードコードされたオフセットを扱うコードとして、正しい順序になっている。

## どう活かすか

**防御が発動したときのシグナルを設計する。** アクセス制御で拒否した、レートリミットで落とした、バリデーションで弾いた。どれも「守れた」という良い出来事だが、記録がなければ「サービスが動かない」という悪い出来事としてしか観測されない。拒否のたびに (1) 何を拒否したかの識別子、(2) カウンタ、(3) 呼び出し元が区別できる終了コードやエラーコード、を残す。Firecracker が残しているのはこの 3 つである。とくに終了コードは、ログが失われても残る最後の情報になる。汎用の 1 に丸めず、原因ごとに番号を振り、ドキュメント化しておく。

**ハードコードされたオフセットには、検証手順をコメントに書く。** `SI_OFF_SYSCALL = 6` は、値だけ見れば何の根拠もないマジックナンバーである。`/usr/include/linux/signal.h` を見ろ、Rust でオフセットが違う理由はこの issue だ、と書いてあるから、あとから確認も更新もできる。「コードから復元できない情報」の典型例である。

**規約を破るなら、破ったことを書き残す。** 「このハンドラは非同期シグナルセーフではない」「その結果デッドロックしうる」「対策は外部の監視プロセス」。この 3 点を明記していれば運用側は対処できる。黙って破ると、稀にハングするという再現しない障害だけが残る。

**適用条件と限界。** この設計が効くのは、(1) 防御機構の発動が「異常」であって日常茶飯事ではない、(2) 発動時にプロセスを落としてよい（可用性より隔離を優先する）、(3) 死因の記録に多少のリスクを払える、という前提のときである。停止が許されない系では、`SECCOMP_RET_TRAP` ではなく `SECCOMP_RET_ERRNO` で `EPERM` を返して呼び出し側に処理させる選択もありうる。Firecracker が `trap` を選べるのは、「1 プロセス = 1 microVM で、落ちても影響が 1 テナントに閉じる」という[アーキテクチャ](../architecture/)のおかげである。

---
title: "walredo — ページ再構成を Postgres そのものに委譲する"
description: "WAL レコードを解釈するのは Postgres のコードにやらせる。ただしそのコードは、悪意ある WAL に対して安全ではない。だから seccomp で檻に入れた別プロセスとして起動し、パイプ越しにページを渡す。"
group: "pageserver — 実行時"
sidebar:
  order: 40
---

## 何を学んだか

pageserver がページを再構成するとき、WAL レコードを実際に適用するのは Postgres のバイナリだ。

```rust title="pageserver/src/walredo.rs"
//! WAL redo. This service runs PostgreSQL in a special wal_redo mode
//! to apply given WAL records over an old page image and return new
//! page image.
//!
//! We rely on Postgres to perform WAL redo for us. We launch a
//! postgres process in special "wal redo" mode that's similar to
//! single-user mode. We then pass the previous page image, if any,
//! and all the WAL records we want to apply, to the postgres
//! process. Then we get the page image back. Communication with the
//! postgres process happens via stdin/stdout
```

([pageserver/src/walredo.rs L1](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pageserver/src/walredo.rs#L1))

判断の根拠は [redo](../redo-and-recovery/) で見た通りだ。redo 関数を Rust で書き直すと、Postgres の 4 バージョン分を追随し続けることになる。

**「書き直さない」を選んだ結果、プロセス境界とパイプ越しの通信が発生した。**

## 問題 — redo は信頼できない入力を想定していない

`docs/pageserver-walredo.md` が、この設計の核心を説明している。

> If you have direct access to the WAL directory, or if you have superuser access to a running PostgreSQL server, it's easy to construct a malicious or corrupt WAL record that causes the WAL redo functions to crash, or to execute arbitrary code. That is not a security problem for PostgreSQL; if you have superuser access, you have full access to the system anyway.
>
> The Neon pageserver, however, is multi-tenant.

**Postgres にとって WAL は信頼できる入力だ。** superuser しか書けないし、superuser は既に全権を持っている。だから redo 関数に入力検証はほとんどない。

Neon では違う。**pageserver は複数テナントの WAL を同じプロセス群で処理する。** テナント A のユーザーが細工した WAL でコード実行を取れたら、テナント B のデータが見える。

これは「マルチテナント化すると、信頼境界が引き直される」という一般的な話の、かなり厳しい実例になっている。**単一テナント前提のコードは、入力を信頼している。**

## 対処 — テナントごとにプロセスを分け、seccomp で閉じる

```markdown title="docs/pageserver-walredo.md"
A separate WAL redo process is launched for each tenant, and the process uses the seccomp(2) system call to restrict its access to the bare minimum needed to replay WAL records. The process does not have access to the filesystem or network. It can only communicate with the parent pageserver process through a pipe.
```

**2 層の防御になっている。**

1. **テナントごとにプロセスを分ける** — 乗っ取られても、同じテナントのデータしか見えない
2. **seccomp で syscall を絞る** — ファイルもネットワークも触れない

そして結論が明快だ。

> the hijacked WAL redo process can only see WAL and data belonging to the same tenant, which the attacker would have access to anyway.

**「攻撃者がどのみちアクセスできるものしか見えない」。** 攻撃を防げないことを認めたうえで、成功しても何も得られない状態にしている。

許可される syscall は 10 個ほどしかない。

```c title="pgxn/neon_walredo/walredoproc.c"
	PG_SCMP_ALLOW(exit_group),
	PG_SCMP_ALLOW(pselect6),
	PG_SCMP_ALLOW(read),
	PG_SCMP_ALLOW(select),
	PG_SCMP_ALLOW(write),
	/* ... */
	PG_SCMP_ALLOW(brk),
	PG_SCMP_ALLOW(mmap),
	PG_SCMP_ALLOW(munmap),
	PG_SCMP_ALLOW(getpid),
	PG_SCMP_ALLOW(futex), /* needed for errbacktrace */
```

([pgxn/neon_walredo/walredoproc.c L177](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pgxn/neon_walredo/walredoproc.c#L177))

**`open` も `socket` も `execve` もない。** 読み書きは既に開いているパイプに対してだけ。メモリ確保 (`brk`, `mmap`) と、終了 (`exit_group`) だけが残る。

`futex` に「errbacktrace のために必要」というコメントが付いているのが、この作業の性質を表している。**必要な syscall は理屈で導出できず、動かして落ちたところを 1 つずつ足していく。**

## 正直な設計ノート

`seccomp.c` の冒頭コメントは 90 行あり、この章で最も率直な文章になっている。

```c title="pgxn/neon_walredo/seccomp.c"
 *  - We have to carefully handpick and maintain the set of syscalls
 *    required for the WAL redo process. Core dumps help with that.
 *    The method of trial and error seems to work reasonably well,
 *    but it would be nice to find a proper way to "prove" that
 *    the set in question is both necessary and sufficient.
```

([pgxn/neon_walredo/seccomp.c L20](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pgxn/neon_walredo/seccomp.c#L20))

**「試行錯誤でやっている。必要十分であることを『証明』する方法があるといいのだが」。**

そして「起動時に seccomp が本当に効いているかテストしたい」という要求に対して、3 つの案を検討して全部却下している。

```c title="pgxn/neon_walredo/seccomp.c"
 *      * Catch the denied syscalls with a signal handler using SCMP_ACT_TRAP.
 *        Provide a common signal handler with a static switch to override
 *        its behavior for the test case. This would undermine the whole
 *        purpose of such protection, so we'd have to go further and remap
 *        the memory backing the switch as readonly, then ban mprotect().
 *        Ugly and fragile, to say the least.
```

**「テストのための抜け道を作ると、それ自体が攻撃対象になる」。** スイッチを読み取り専用にして `mprotect` を禁止すれば守れるが、「控えめに言っても醜くて脆い」。

3 案目 (`SECCOMP_RET_ERRNO` で偽装する) の却下理由も鋭い。**「それだと `SCMP_ACT_KILL_PROCESS` が実際に効くかを確かめられない」。** テストが本番と違う経路を通るなら、テストになっていない。

最後は読者への呼びかけで終わる。

```c
 *    Maybe I (@funbringer) am missing something, though; I encourage
 *    any reader to get familiar with it and scrutinize my conclusions.
```

**「自分が見落としているかもしれない。読んだ人は精査してほしい」。** セキュリティ機構の設計判断を、こういう形で残しておくのは価値がある。

シャットダウンの扱いも制約から来ている。

```c title="pgxn/neon_walredo/seccomp.c"
 *  - Once we enter the seccomp bpf mode, it's impossible to lift those
 *    restrictions (otherwise, what kind of "protection" would that be?).
 *    Thus, we have to either enable extra syscalls for the clean shutdown,
 *    or exit the process immediately via _exit() instead of proc_exit().
```

**きれいに終了するには syscall が要るが、それを許すと穴になる。** だから `_exit()` で即死させる。Heikki の提案として「単に `_exit()` でいい」と TODO に書かれている。

## プロセスの寿命管理

Rust 側の管理も込み入っている。

```rust title="pageserver/src/walredo.rs"
    /// Gate that is entered when launching a walredo process and held open
    /// until the process has been `kill()`ed and `wait()`ed upon.
    ///
    /// This type of usage is a bit unusual because gates usually keep track of
    /// concurrent operations, e.g., every [`Self::request_redo`] that is inflight.
    /// But we use it here to keep track of the _processes_ that we have launched,
    /// which may outlive any individual redo request because
    /// - we keep walredo process around until its quiesced to amortize spawn cost and
    /// - the Arc may be held by multiple concurrent redo requests, so, just because
    ///   you replace the [`Self::redo_process`] cell's content doesn't mean the
    ///   process gets killed immediately.
    launched_processes: utils::sync::gate::Gate,
```

([pageserver/src/walredo.rs L85](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pageserver/src/walredo.rs#L85))

**プロセスは個々の要求より長生きする。** 起動コストを償却するため、しばらく使われなくなるまで生かしておく。

だから「全部のプロセスが死んだ」を待つ仕組みが要る。Gate を「実行中の操作」ではなく「起動したプロセス」の追跡に使っている、という異例の使い方が明記されている。

そして構造体のフィールド順にも意味がある。

```rust title="pageserver/src/walredo.rs"
struct Process {
    process: process::WalRedoProcess,
    /// This field is last in this struct so the guard gets dropped _after_ [`Self::process`].
    /// (Reminder: dropping [`Self::process`] synchronously sends SIGKILL and then `wait()`s for it to exit).
    _launched_processes_guard: utils::sync::gate::GateGuard,
}
```

**Rust の drop 順序 (宣言順) に依存している。** プロセスを殺してから gate を抜ける。逆だと、まだ生きているプロセスがあるのに「全部終わった」ことになる。

**コメントがないと絶対に気付けない依存**で、フィールドを並べ替えただけで壊れる。

## 用途によって失敗の扱いを変える

```rust title="pageserver/src/walredo.rs"
    /// Used for the read path. Will fire critical errors and retry twice if failure.
    ReadPage,
    // Used for legacy compaction (only used in image compaction). Will fire critical errors and retry once if failure.
    LegacyCompaction,
    // Used for gc compaction. Will not fire critical errors and not retry.
    GcCompaction,
```

([pageserver/src/walredo.rs L142](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pageserver/src/walredo.rs#L142))

**同じ redo でも、誰が呼んだかでリトライ回数とアラートの有無が変わる。**

読み取りパスはユーザーを待たせているので、2 回まで再試行する。gc compaction は背景処理なので、失敗したら次の周回に任せる。

リトライが意味を持つのは、**プロセスを作り直せば直るかもしれない**からだ。プロセスが壊れた状態 (パイプが詰まった、seccomp で殺された) なら、新しいプロセスで成功する可能性がある。

## Rust 側で処理するレコード

全部を Postgres に送るわけではない。

```markdown title="docs/pageserver-walredo.md"
Some WAL record types are handled directly in the pageserver, by bespoken Rust code, and are not sent over to the WAL redo process. This includes SLRU-related WAL records, like commit records. SLRUs don't use the standard Postgres buffer manager, so dealing with them in the Neon WAL redo mode would require quite a few changes to Postgres code and special handling in the protocol anyway.
```

**SLRU はバッファマネージャを通らないので、redo プロセスの枠組みに乗らない。** [MVCC・xid・SLRU](../mvcc-and-xid/) で見た `NeonWalRecord::ClogSetCommitted` などが、`apply_neon.rs` で直接処理される。

**「委譲する」という方針を採っても、委譲できない部分は残る。** そしてその部分は自前で書くことになる。境界がどこに引かれるかは、委譲先の構造 (Postgres のバッファマネージャ) で決まっている。

## 複数ページを触るレコード

```markdown title="docs/pageserver-walredo.md"
Some Postgres WAL records modify multiple pages. Such WAL records are duplicated, so that a copy is stored for each affected page. This is somewhat wasteful, but because most WAL records only affect one page, the overhead is acceptable.
```

**1 つのレコードを、触ったページの数だけ複製して保存する。** レコード全体が各キーの値になる。

そして redo するときは、対象ページ以外の変更を捨てる。それが [redo](../redo-and-recovery/) で見た `redo_read_buffer_filter` フックだ。

**「無駄だが、大半のレコードは 1 ページしか触らないので許容できる」**という、測定に基づいた割り切りになっている。

## この先に効いてくること

- **マルチテナント化は信頼境界を引き直す。** 単一テナント前提のコードは入力を信頼している。
- **攻撃を防げないなら、成功しても得るものがない状態にする。**
- **テストのための抜け道は、それ自体が攻撃対象になる。**
- **drop 順序への依存はコメントでしか守れない。**
- **委譲できない部分は必ず残る。** 境界は委譲先の構造が決める。

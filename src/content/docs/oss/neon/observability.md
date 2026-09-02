---
title: "observability — 分解したシステムをどう見るか"
description: "5 つのプロセスに分かれると、1 つの症状が誰のせいか分からなくなる。ログレベルの定義を文書化し、それをテストで強制し、リクエストの文脈を型で持ち回り、プロファイルを HTTP から取れるようにする。"
group: "検証と運用"
sidebar:
  order: 59
---

## 何を学んだか

分散したシステムでは、**「遅い」「エラーが出た」という症状から原因に辿り着くのが難しい。** Neon はここに、いくつかの層で手を入れている。

## エラーは処理する場所で記録する

```markdown title="docs/error-handling.md"
The principle is that errors are logged when they are handled. If you
just propagate an error to the caller in a function, you don't need to
log it; the caller will. But if you consume an error in a function,
you _must_ log it (if it needs to be logged at all).
```

([docs/error-handling.md](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/docs/error-handling.md))

**伝播するなら記録しない、消費するなら記録する。** これがないと、1 つのエラーが階層の数だけログに出る。

そして「記録するかどうか」の判断は、呼び出し側の文脈による。例として挙げられているのが `/etc/motd` の読み取りだ。

```rust title="docs/error-handling.md"
            // It's normal that /etc/motd doesn't exist, but if we fail to
            // read it for some other reason, that's unexpected. The message
            // of the day isn't very important though, so we just WARN and
            // continue with the default in any case.
            if err.kind() != std::io::ErrorKind::NotFound {
                 tracing::warn!("could not read \"/etc/motd\": {err:?}");
            }
```

**同じエラー型でも、種類によって記録するかどうかが変わる。** 「ファイルがない」は正常、それ以外は異常。

## ログレベルの定義を文書化する

```markdown title="docs/error-handling.md"
`tracing::Level` doesn't provide very clear guidelines on what the
different levels mean, or when to use which level. Here is how we use
them:
```

**「ライブラリは定義してくれないので、我々が定義する」。**

**ERROR の定義が明快だ。**

```markdown title="docs/error-handling.md"
**Errors are monitored, and always need human investigation to determine
the cause.**
```

**「監視されており、必ず人間の調査を要する」。** これがログレベルの定義になっている。「深刻さ」ではなく「対応が要るか」で決める。

そして境界例が具体的に挙げられている。

```markdown title="docs/error-handling.md"
However, if a TCP connection to a compute node is
lost, that is not considered an Error, because it doesn't affect the
pageserver's or safekeeper's operation in any way, and happens fairly
frequently when compute nodes are shut down
```

**compute への接続が切れるのは、サーバーレスでは正常。** 通常の Postgres なら異常だが、Neon では日常茶飯事になる。

さらに、レベルは呼び出し側で変わりうると認めている。

```markdown title="docs/error-handling.md"
If a message is logged as an ERROR,
but it in fact happens frequently in production and never requires any
action, it should probably be demoted to an INFO level message.
```

**「本番で頻発して何もしなくていいなら、それは ERROR ではない」。** ログレベルは固定ではなく、運用の実態に合わせて調整するもの、という立場になっている。

WARN と ERROR の区別も明確だ。

```markdown title="docs/error-handling.md"
The difference between Error and
Warning is that an Error means that the operation failed, whereas Warning
means that something unexpected happened, but the operation continued anyway.
```

**「失敗した」か「続行した」か。** 深刻さの度合いではなく、結果で分ける。

## テストがログレベルを強制する

```markdown title="docs/error-handling.md"
> **Note:** The python regression tests, under `test_regress`, check the
> pageserver log after each test for any ERROR and WARN lines. If there are
> any ERRORs or WARNs that have not been explicitly listed in the test as
> allowed, the test is marked a failed. This is to catch unexpected errors
> e.g. in background operations, that don't cause immediate misbehaviour in
> the tested functionality.
```

**すべての統合テストが、ログに ERROR と WARN が出ていないことを検査する。** 出るなら、テスト側で明示的に許可しなければならない ([test_runner](../test-runner/))。

これで 2 つのことが起きる。

1. **ログレベルの規約が守られる。** 誤って ERROR を出すと、テストが落ちる
2. **背景処理のエラーが検出される。** テスト対象の機能は正常に見えても、裏で何か失敗していれば分かる

**ドキュメントの規約を、テストで実行可能にしている。** 規約を書くだけでは守られない。

## panic の扱い

```markdown title="docs/error-handling.md"
Depending on where a panic happens, it can cause the whole pageserver
or safekeeper to restart, or just a single tenant. In either case,
that is pretty bad and causes an outage. Avoid panics. Never use
`unwrap()` or other calls that might panic, to verify inputs from the
network or from disk.
```

**「ネットワークやディスクからの入力の検証に `unwrap()` を使うな」。** マルチテナントなので、1 つの panic が他の tenant にも影響する。

そのうえで、使ってよい場合も定義されている。

```markdown title="docs/error-handling.md"
It is acceptable to use functions that might panic, like `unwrap()`, if
it is obvious that it cannot panic. (中略) but it is still preferable to use `expect("reason")` instead to explain
why the function cannot fail.
```

**`unwrap()` より `expect("理由")`。** 「なぜ失敗しないか」をコードに残す。この章で何度か見た `expect("should always have at least one item")` のような記述がそれだ ([disk_btree](../disk-btree/))。

```markdown title="docs/error-handling.md"
`assert!` and `panic!` are reserved for checking clear invariants and
very obvious "can't happen" cases. When in doubt, use anyhow `ensure!`
or `bail!` instead.
```

**「迷ったらエラーにしろ」。** [term と epoch](../safekeeper-consensus/) で見た `bail!` と `assert!` の使い分けが、この規約に沿っている。

## エラー型を作る基準

```markdown title="docs/error-handling.md"
A downside of `anyhow::Error` is that the caller cannot distinguish
between different error cases. Most errors are propagated all the way
to the mgmt API handler function (中略) and they are all handled the same way
```

```markdown title="docs/error-handling.md"
But in some cases, we need to distinguish between errors and handle
them differently. (中略) It is important that the pagserver
responds with the HTTP 403 Already Exists error in that case, rather
than a generic HTTP 500 Internal Server Error.
```

**呼び出し側が分岐する必要があるときだけ、独自のエラー型を作る。**

例が具体的だ。「attach したが、応答が返る前にネットワークが切れた。console がリトライすると、既に attach 済み」。**これは 500 ではなく 403 であるべき**で、そうでないと console がリトライを繰り返す。

**エラー型の粒度は、受け手が何を判断するかで決まる。** [compute_hook](../compute-hook/) の 8 つのバリアントも、[コネクションプールとキャンセル](../pool-and-cancel/) の `ErrorKind` も、同じ基準で作られている。

## 文脈を型で持ち回る

```rust title="pageserver/src/context.rs"
//! Defines [`RequestContext`].
//!
//! It is a structure that we use throughout the pageserver to propagate
//! high-level context from places that _originate_ activity down to the
//! shared code paths at the heart of the pageserver. It's inspired by
//! Golang's `context.Context`.
//!
//! For example, in `Timeline::get(page_nr, lsn)` we need to answer the following questions:
//! 1. What high-level activity ([`TaskKind`]) needs this page?
//!    We need that information as a categorical dimension for page access
//!    statistics, which we, in turn, need to guide layer eviction policy design.
//! 2. How should we behave if, to produce the page image, we need to
//!    on-demand download a layer file ([`DownloadBehavior`]).
```

([pageserver/src/context.rs L1](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pageserver/src/context.rs#L1))

**「このページを誰が必要としているか」を、最下層まで伝える。**

理由が 2 つある。**統計の次元**と、**振る舞いの制御**。

前者は eviction の判断に使う。ユーザーの読み取りで触られたレイヤと、compaction が舐めただけのレイヤを、同じ「アクセス」として数えたら、eviction の判断が狂う ([ディスクが足りなくなったとき](../eviction-and-secondary/))。

後者はもっと直接的だ。**`DownloadBehavior`** — レイヤがローカルになかったとき、S3 からダウンロードしてよいか。ユーザーの読み取りなら待たせてでも取る。背景処理なら諦める。

**同じコードパスが、呼び出し元によって違う振る舞いをする必要がある。** その情報を引数で伝えると、全関数のシグネチャに載る。文脈オブジェクトにまとめる。

そして将来の用途が列挙されている。

```rust title="pageserver/src/context.rs"
//! Other future uses of `RequestContext`:
//! - Communicate compute & IO priorities (user-initiated request vs. background-loop)
//! - Request IDs for distributed tracing
//! - Request/Timeline/Tenant-scoped log levels
//!
//! RequestContext might look quite different once it supports those features.
//! Likely, it will have a shape similar to Golang's `context.Context`.
```

**「最終的には Go の `context.Context` に似た形になるだろう」。** 到達点を先に宣言している。

キャンセルについても正直だ。

```rust title="pageserver/src/context.rs"
//! We do not yet have a systematic cancellation story in pageserver, and it is
//! pretty clear that [`RequestContext`] will be responsible for that.
```

**「体系的なキャンセルの仕組みはまだない」。** `task_mgr`、`TaskHandle`、`CancellationToken` が場所ごとに使われている状態を認めている。

## span で文脈を付ける

```markdown title="docs/error-handling.md"
We use logging "spans" to hold context information about the current
operation. Almost every operation happens on a particular tenant and
timeline, so we enter a span with the "tenant_id" and "timeline_id"
very early when processing an incoming API request
```

**すべてのログに tenant_id と timeline_id が付く。** 数千テナントが同居するプロセスで、これがないとログが読めない。

そして span の付け忘れを防ぐアサートまである。

```rust
use crate::span::{
    debug_assert_current_span_has_tenant_and_timeline_id,
    debug_assert_current_span_has_tenant_and_timeline_id_no_shard_id,
};
```

**「今の span に tenant_id と timeline_id が入っているか」をデバッグビルドで検査する。** 規約を実行時に確かめている。

TODO も残っている。

```markdown title="docs/error-handling.md"
TODO: Spans are not captured in the Error when it is created, but when
the error is logged. It would be more useful to capture them at Error
creation. We should consider using `tracing_error::SpanTrace` to do that.
```

**エラーが作られた場所ではなく、記録された場所の文脈が付く。** 伝播の途中で span を抜けていると、情報が失われる。

## プロファイルを HTTP から取る

```markdown title="docs/rfcs/040-profiling.md"
Go has [first-class support](https://pkg.go.dev/net/http/pprof) for profiling included in its
standard library, using the [pprof](https://github.com/google/pprof) profile format and associated
tooling.

This is not the case for Rust and C, where obtaining profiles can be rather cumbersome. It requires
installing and running additional tools like `perf` as root on production nodes, with analysis tools
that can be hard to use and often don't give good results. This is not only annoying, but can also
significantly affect the resolution time of production incidents.
```

([docs/rfcs/040-profiling.md](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/docs/rfcs/040-profiling.md))

**「本番ノードに root で `perf` を入れて走らせる」のは、障害対応中にやりたくない。**

目標が具体的だ。

```markdown title="docs/rfcs/040-profiling.md"
- Provide CPU and heap profiles in pprof format via HTTP API.
- Record continuous profiles in Grafana for aggregate historical analysis.
- Make it easy for anyone to see a flamegraph in less than one minute.
- Be reasonably consistent across teams and services (Rust, Go, C).
```

**「誰でも 1 分以内にフレームグラフを見られるようにする」。** 技術的な目標ではなく、人間の作業時間で書かれている。

コストも測ってある。

```markdown title="docs/rfcs/040-profiling.md"
Continuous profiling incurs an overhead of about 0.1% CPU usage and 3% slower heap allocations.
```

**常時プロファイリングのオーバーヘッドが 0.1% CPU と 3% のアロケーション低下。** 数字があるので、有効にするかどうかを判断できる。

そして非目標も列挙されている。ミューテックスのプロファイル、トレースとの統合、PGO。**「今はやらないこと」を書くことで、スコープが締まる。**

## この先に効いてくること

- **ログレベルは「対応が要るか」で定義する。** 深刻さではなく。
- **ドキュメントの規約を、テストで実行可能にする。** ERROR/WARN が出たらテストが落ちる。
- **エラー型の粒度は、受け手が何を判断するかで決まる。**
- **文脈オブジェクトは、統計の次元と振る舞いの制御を同時に運ぶ。**
- **観測の目標を人間の作業時間で書く。** 「1 分以内にフレームグラフ」。

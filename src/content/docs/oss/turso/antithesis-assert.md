---
title: "アサーションを、そのままテストのプロパティ定義として兼ねさせる"
description: "turso_assert! は通常ビルドでは std の assert! と同じだが、--cfg antithesis を付けると Antithesis の自律テストに報告する形にコンパイルされる。失敗時は panic ではなく exit(0) で、テスト基盤が違反として処理できるようにする。「一度は成り立ってほしい」だけを表す観測用のアサーションや、到達すべきコード・してはいけないコードを表す種別もある。437 箇所のアサーションが、そのまま検査対象のプロパティ一覧になっている。"
sidebar:
  order: 36
---

## 何を学んだか

コードの中の `assert!` は、普通は「開発者が自分のためのチェックを置いたもの」だ。

Turso ではそれが **テスト基盤に報告するプロパティ定義**を兼ねている。

```rust title="macros/src/lib.rs"
//! =============================================================================
//! Antithesis Assertion Macros
//! =============================================================================
//!
//! These macros define correctness properties for [Antithesis](https://antithesis.com/)
//! autonomous testing. They wrap the [Antithesis SDK](https://docs.rs/antithesis_sdk)
//! assertion macros and double as standard Rust assertions, giving us a single assertion
//! layer that works both in normal builds and under Antithesis fuzzing.
```

[`macros/src/lib.rs#L1-L9`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/macros/src/lib.rs#L1-L9)。

**「1 つのアサーション層が、通常ビルドと Antithesis のファジングの両方で動く」。**

Antithesis は決定的シミュレーションを商用サービスにしたもので、**プログラム全体を決定的な仮想環境で走らせ、状態空間を自動探索する。** [シミュレータ](../deterministic-simulator/) や [Whopper](../whopper-elle/) と目的は同じで、探索を自動化する規模が違う。

`core/` には `turso_assert!` が 437 箇所ある。**「アサーションを 1 個書くたびに、探索対象のプロパティが 1 個増える」** という関係になっている。

## ソースコードのどこか

### 機能フラグで、同じマクロが 2 通りにコンパイルされる

```rust title="macros/src/lib.rs"
//! ## The `antithesis` feature flag
//!
//! All macros compile to different code depending on whether `--features antithesis`
//! is enabled:
//!
//! - **Without** the feature: macros behave like their `std` counterparts (`assert!`,
//!   `debug_assert!`, `unreachable!`, etc.), or are no-ops for observational macros.
//! - **With** the feature: macros additionally report to the Antithesis SDK. On failure,
//!   "always" assertions print an error to stderr and call `std::process::exit(0)` instead
//!   of panicking. This clean exit lets Antithesis properly process the property violation.
```

[`macros/src/lib.rs#L10-L20`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/macros/src/lib.rs#L10-L20)。

**失敗時に `panic!` ではなく `std::process::exit(0)` を呼ぶ。**

理由が書いてある。**「この綺麗な終了によって、Antithesis がプロパティ違反を適切に処理できる」。**

panic するとスタック巻き戻しが走り、`Drop` が呼ばれ、場合によっては別の panic が起きる。**アサーションが失敗した瞬間の状態を、テスト基盤に見せたい。** 即座に抜けるのが正しい。

**終了コードが 0 なのも意図的**で、異常終了として扱われると別の経路に入ってしまう。**「プロセスは正常に終わった。違反は SDK 経由で報告済み」** という分業になる。

### 5 種類のアサーション

```rust title="macros/src/lib.rs"
//! ## Five categories of assertions
//!
//! 1. **Condition assertions** ([`turso_assert!`], [`turso_debug_assert!`])
//!    Drop-in replacements for `assert!`/`debug_assert!` that also report to Antithesis.
//!
//! 2. **Sometimes assertions** ([`turso_assert_sometimes!`], ...)
//!    Observational only — never panic. Tell Antithesis "this condition should be true at
//!    least once across all test runs." Useful for verifying the fuzzer explores both sides
//!    of a branch.
//!
//! 3. **Boolean guidance** ([`turso_assert_some!`], [`turso_assert_all!`])
//!    Multi-condition assertions that provide better guidance to the Antithesis fuzzer.
//!
//! 4. **Reachability assertions** ([`turso_assert_reachable!`],
//!    [`turso_assert_unreachable!`], [`turso_soft_unreachable!`])
//!    Verify whether code paths are or aren't hit during testing.
//!
//! 5. **Comparison assertions** ([`turso_assert_eq!`], ...)
//!    Typed comparison assertions that provide richer information to Antithesis than a
//!    plain `turso_assert!(a > b)`.
```

[`macros/src/lib.rs#L21-L47`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/macros/src/lib.rs#L21-L47)。

2 番目が、通常のアサーションにはない発想になる。

**`turso_assert_sometimes!` は絶対に panic しない。** 「この条件が、全テスト実行の中で少なくとも一度は真になってほしい」を表す。

用途が明快だ。**「ファジングが分岐の両側を探索していることを確かめる」。**

普通のアサーションは「悪いことが起きていない」を検査する。これは **「良いことが起きている」を検査する。** 全実行で一度も真にならなかったら、**テストがその経路に届いていない**ことが分かる。

**カバレッジの測定を、条件式として書ける形にしている。** 「この行が実行されたか」ではなく「この状況が発生したか」を測れる。

5 番目も実務的で、`turso_assert!(a > b)` ではなく `turso_assert_greater_than!(a, b)` と書く。**ファジングの誘導に、数値そのものが渡る。** 「もう少しで違反しそう」を検出できる。

### 到達性の 3 段階

```rust title="macros/src/lib.rs"
//! | `turso_assert_reachable!` | *(no-op)* | Never | Pending better SQL generation |
//! | `turso_assert_unreachable!` | `assert_unreachable!` | Yes (exit(0) w/ feature) | Hard unreachable |
//! | `turso_soft_unreachable!` | `assert_unreachable!` | Never | Soft signal, no-op w/o feature |
```

[`macros/src/lib.rs#L67-L69`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/macros/src/lib.rs#L67-L69)。

**`turso_soft_unreachable!` — 「ここには来ないはずだが、来ても落とさない」。**

実際の使われ方を見ると意図が分かる。

```rust title="core/storage/pager.rs"
            turso_soft_unreachable!("wal_state() called on database without WAL");
```

```rust title="core/storage/pager.rs"
            turso_soft_unreachable!("checkpoint() called on database without WAL");
```

[`core/storage/pager.rs#L3517`, `#L4663`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/pager.rs#L3517)。

**「WAL のないデータベースでチェックポイントを呼ぶ」は、呼び出し側のバグだ。** だが、そこで落とすのは重すぎる。

- **通常ビルドでは何もしない** — エラーを返して続行する
- **Antithesis の下では違反として報告される** — 開発中には気付ける

**「あってはならないが、致命的ではない」を表す段階**がある。`unreachable!()` にすると本番で落ち、コメントにすると誰も気付かない。その中間になる。

`turso_assert_reachable!` が現在 no-op なのも正直に書いてある。**「より良い SQL 生成を待っている」。** 到達性を主張しても、[生成器](../deterministic-simulator/) がその経路に届く SQL を作れなければ、意味のある報告にならない。

### 詳細情報を構造化して渡す

```rust title="core/storage/page_cache.rs"
            turso_assert!(
                !self.clock_hand.is_null(),
                "page_cache: clock hand is null during eviction",
                { "entries": self.len() }
            );
```

[`core/storage/page_cache.rs#L652-L656`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/page_cache.rs#L652-L656)。

**3 番目の引数が JSON のオブジェクトになっている。** マクロがこう展開する。

```rust title="macros/src/assert.rs"
pub fn details_json(details: &Option<DetailsList>) -> TokenStream2 {
    match details {
        Some(list) if !list.pairs.is_empty() => {
            let keys: Vec<_> = list.pairs.iter().map(|p| &p.key).collect();
            let vals: Vec<_> = list.pairs.iter().map(|p| &p.value).collect();
            quote! { &serde_json::json!({ #( #keys: format!("{:?}", &#vals) ),* }) }
        }
        _ => quote! { &serde_json::json!({}) },
    }
}
```

[`macros/src/assert.rs#L220-L229`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/macros/src/assert.rs#L220-L229)。

**Antithesis には構造化された JSON として渡り、通常ビルドでは panic メッセージに埋め込まれる。**

```rust title="macros/src/assert.rs"
/// Generate format arguments that include details in the panic message.
///
/// With details:    `"{} | key1={:?}, key2={:?}", msg, val1, val2`
/// Without details: `"{}", msg`
///
/// Uses `{:?}` (Debug) rather than `{}` (Display) because detail values may be
/// types like `&[u8]` that implement Debug but not Display.
```

[`macros/src/assert.rs#L246-L252`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/macros/src/assert.rs#L246-L252)。

**`Display` ではなく `Debug` を使う理由まで書いてある。** `&[u8]` は `Display` を実装していない。詳細に渡したい値は、たいていそういう型になる。

そして、詳細の値が本当に表示できるかをコンパイル時に確かめている。

```rust title="macros/src/assert.rs"
/// Generate a compile-time `Debug` check for detail values.
pub fn details_debug_check(details: &Option<DetailsList>) -> TokenStream2 {
    match details {
        Some(list) if !list.pairs.is_empty() => {
            let vals: Vec<_> = list.pairs.iter().map(|p| &p.value).collect();
            quote! {
                if false {
                    #( let _ = format!("{:?}", &#vals); )*
                }
            }
        }
```

[`macros/src/assert.rs#L231-L241`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/macros/src/assert.rs#L231-L241)。

**`if false { ... }` の中でフォーマットする。** 実行はされないが、型検査は通る。

**アサーションが失敗するときにだけ評価されるコードは、普段は型が合っているかすら分からない。** 「本番で assert が失敗した瞬間に、詳細のフォーマットでコンパイルエラー」ということはないが、**「詳細に `Debug` のない型を渡すと、コンパイルが通ってしまう」を防ぐ**必要がある。この 1 行がそれをやる。

### 環境の確認を実行時に埋め込む

```rust title="macros/src/lib.rs"
/// Generate a runtime check that panics if `ANTITHESIS_OUTPUT_DIR` is not set.
/// Uses `std::sync::Once` so the actual env var lookup only happens once per call site.
fn antithesis_env_check() -> proc_macro2::TokenStream {
    quote! {
        {
            static __TURSO_ANTITHESIS_ENV_CHECK: std::sync::Once = std::sync::Once::new();
            __TURSO_ANTITHESIS_ENV_CHECK.call_once(|| {
                if std::env::var_os("ANTITHESIS_OUTPUT_DIR").is_none() {
                    panic!("Do not use --cfg antithesis unless running on Antithesis.");
                }
            });
        }
    }
}
```

[`macros/src/lib.rs#L104-L118`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/macros/src/lib.rs#L104-L118)。

**「Antithesis 上で動いていないなら `--cfg antithesis` を使うな」と、実行時に落とす。**

このフラグを付けてビルドしたバイナリを普通に動かすと、**アサーションが失敗しても exit(0) して静かに終わる。** 落ちたことに気付けない。

**危険な設定は、使う環境でしか動かないようにする。** `std::sync::Once` で 1 回だけ確認するので、コストはほぼゼロになる。

### ビルド設定そのものが特殊

```dockerfile title="Dockerfile.antithesis"
        export RUSTFLAGS="--cfg=tokio_unstable --cfg=antithesis -Ccodegen-units=1 -Cpasses=sancov-module -Cllvm-args=-sanitizer-coverage-level=3 -Cllvm-args=-sanitizer-coverage-trace-pc-guard -Clink-args=-Wl,--build-id -L/usr/lib/ -lvoidstar" && \
```

[`Dockerfile.antithesis`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/Dockerfile.antithesis)。

**LLVM の SanitizerCoverage を有効にして、`libvoidstar` をリンクする。** Antithesis はカバレッジの情報を使って、**未探索の分岐に向かうように状態空間を誘導する。**

`-Ccodegen-units=1` は、最適化の単位を 1 つにしてカバレッジ計測を正確にするため。

**「アサーションを書く」だけでは足りず、専用のビルドが要る。** そのビルド設定が Dockerfile として置いてある。

### 失敗した実行から、手元での再現へ

```text title="testing/antithesis/README.md"
Sometimes it's enough to feed the SQL to Turso to reproduce the issue. Remove the few lines at the start that are just
numbers, add semicolonsto lines that don't already have one, and redirect the file to `cargo run`, using the same VFS as
the test. Here's a Vim command for to add semicolons to lines that don't already have one:
```

```text title="testing/antithesis/README.md"
If that doesn't do it, then it's going to take more work. You can try observing the state of the B-trees
using [sqlite-viz](https://github.com/LeMikaelF/sqlite-viz). SQLite (and possibly Turso) can mask corruption. sqlite-viz
can also dump information about certain pages in a human-readable form
```

[`testing/antithesis/README.md`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/testing/antithesis/README.md)。

**「ログを SQL に整形する Vim のコマンド」まで書いてある。**

これは些細に見えて、そうではない。**外部のテストサービスが見つけたバグを、手元で再現できなければ直せない。** その手順が具体的であるほど、修正までの時間が短くなる。

**「SQLite も (おそらく Turso も) 破損を隠すことがある」** という注意も実務的だ。`PRAGMA integrity_check` が通っても、B-tree が壊れていることがある。だからページを直接見る道具を紹介している。

## なぜそうなっているか

- **アサーションをプロパティ定義と兼ねさせたのは、二重に書きたくないから。** 「検査したい性質」を通常のアサーションと別に書くと、片方だけ更新される。
- **通常ビルドで `std` のマクロと同じ挙動にしたのは、開発者に負担をかけないため。** 「Antithesis 用に特別なことを書く」必要があると、書かれなくなる。
- **失敗時に panic ではなく `exit(0)` するのは、状態を保存させるため。** 巻き戻しが走ると `Drop` が状態を変え、別の panic が起きることもある。
- **終了コードを 0 にしたのは、異常終了とは別に扱わせるため。** 違反の報告は SDK 経由で済んでいる。
- **「一度は真になってほしい」というアサーションがあるのは、探索の網羅度を測るため。** 一度も真にならなかったなら、テストがその経路に届いていない。
- **比較を専用のマクロにしたのは、ファジングに数値を渡すため。** 「もう少しで違反」を検出できると、探索の誘導が効く。
- **「落とさない unreachable」があるのは、致命的でない契約違反があるから。** 落とすと本番が止まり、無視すると気付けない。
- **詳細を構造化して渡すのは、テスト基盤が解析するから。** メッセージ文字列を後からパースするより、最初から構造を持たせる。
- **`Debug` を使うのは、詳細に渡す型が `Display` を持たないことが多いから。** バイト列、内部の列挙、状態機械の状態。
- **`if false` で型検査だけ通すのは、失敗経路のコードが普段評価されないから。** 動かないコードは、書いた瞬間の型しか保証されない。
- **環境変数を実行時に確認するのは、この設定で本番を動かすと危険だから。** アサーションが静かに無効化されたのと同じ状態になる。
- **再現手順を具体的に書いたのは、外部サービスの発見が手元に届かないと意味がないから。**

## どう活かすか

- **検査したい性質を、テストコードではなく本体のアサーションとして書く。** 実装の隣にあれば、実装を変えるときに一緒に見直される。
- **同じアサーションが、通常ビルドとテスト基盤の両方で意味を持つようにする。** 二重管理をやめられる。書く側の負担が増えないなら、数が増える。
- **アサーション失敗時の終了の仕方を、検査基盤の都合に合わせる。** 巻き戻しが状態を壊すなら、即座に抜ける方がよい。
- **「一度は起きてほしい」を表すアサーションを用意する。** テストが特定の状況に到達しているかを、条件式として書ける。カバレッジより意味に近い。
- **比較を専用の形で表す。** 「条件が真か」だけでなく「どれくらい差があるか」が伝わると、自動探索の誘導が効く。
- **「あってはならないが落とすほどではない」の段階を用意する。** 全部を `unreachable!()` にすると本番が止まり、全部を無視すると気付けない。
- **診断情報は、文字列に埋める前に構造として持つ。** 解析する側がパースしなくて済む。人間向けの整形は最後にやる。
- **失敗時にしか評価されないコードは、型検査だけ通す仕掛けを入れる。** `if false` のブロックで十分に効く。
- **危険なビルド設定は、想定した環境でしか動かないようにする。** 環境変数の確認 1 つで、事故が防げる。
- **外部の検査基盤を使うなら、そこから手元の再現までの手順を書く。** 「見つかったが再現できない」は、見つからなかったのとほぼ同じになる。

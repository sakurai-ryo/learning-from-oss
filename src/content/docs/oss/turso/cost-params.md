---
title: "コストモデルの定数を JSON で外から差し替えられるようにする"
description: "オプティマイザのコスト定数は 25 個ある。等値述語の選択率、ページあたりの行数、CPU コストの重み、ハッシュ結合の閾値。これらを 1 つの構造体にまとめ、環境変数で指し示した JSON ファイルから読めるようにしてある。TPC-H のようなワークロードに合わせて調整するためだ。既定値は const fn で作る静的変数なので、機能を無効にすればコストはゼロになる。読み込んだ値には検証がかかり、不正なら黙って既定値に戻る。"
group: "クエリコンパイル"
sidebar:
  order: 22
---

## 何を学んだか

[前のページ](../join-order-dp/) のコスト計算には、たくさんの魔法の定数が要る。「等値述語は結果を 1/10 に絞る」「1 ページに 50 行入る」「1 行の CPU コストはページ I/O の 0.003 倍」。

MySQL もこれを持っていて、`mysql.server_cost` と `mysql.engine_cost` という **テーブル**に入っている。DBA が `UPDATE` して `FLUSH OPTIMIZER_COSTS` すれば変えられる。

Turso はサーバがないので、システムテーブルに置いても更新する人がいない。**代わりに環境変数で指した JSON ファイルから読む。**

```rust title="core/translate/optimizer/cost_params.rs"
/// Cost model parameters for query optimization.
///
/// These parameters control the heuristics used by the query optimizer for
/// cost estimation. They can be tuned to improve plan selection for specific
/// workloads (e.g., TPC-H).
///
/// # JSON Loading (requires `optimizer_params` feature)
///
/// When the `optimizer_params` feature is enabled, parameters can be loaded
/// from a JSON file via the `TURSO_OPTIMIZER_PARAMS` environment variable.
/// The JSON file does not need to specify all fields, and unspecified fields will use the default values.
```

[`core/translate/optimizer/cost_params.rs#L1-L11`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/translate/optimizer/cost_params.rs#L1-L11)。

**目的が「TPC-H のような特定のワークロードに合わせる」と明記されている。** 本番運用のためのつまみではなく、**開発時にコストモデルを調整するための道具**として作られている。

## ソースコードのどこか

### 定数を全部 1 つの構造体に

```rust title="core/translate/optimizer/cost_params.rs"
        Self {
            // Cardinality fallbacks
            rows_per_table_fallback: 1_000_000.0,
            rows_per_table_page: 50.0,

            // Selectivity fallbacks
            sel_eq_unindexed: 0.1,
            sel_eq_indexed: 0.001,
            sel_range: 0.4,
            sel_is_null: 0.1,
            sel_is_not_null: 0.9,
            sel_like: 0.2,
            sel_not_like: 0.2,
            sel_other: 0.9,
            in_subquery_rows: 25.0,

            // Scan/Seek costs
            cache_reuse_factor: 0.2,
            cpu_cost_per_row: 0.003,
            cpu_cost_per_where_step: 0.003,
            cpu_cost_per_seek: 0.01,
            index_bonus: 0.5,

            // Sort costs
            sort_cpu_per_row: 0.002,

            // Hash join specific costs and thresholds
            hash_cpu_cost: 0.001,
            hash_insert_cost: 0.002,
            hash_lookup_cost: 0.003,
            hash_bytes_per_row: 100.0,
            hash_materialize_selectivity_threshold: 0.5,
            hash_nested_probe_selectivity_threshold: 0.15,

            // Join optimization
            closed_range_selectivity_factor: 0.2,
        }
```

[`core/translate/optimizer/cost_params.rs#L104-L140`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/translate/optimizer/cost_params.rs#L104-L140)。

**25 個の定数が、1 箇所に並んでいる。**

これがコードの中に散らばっていたら、どうなるか。`0.1` という数字が `constraints.rs` の奥に埋まっていて、`0.001` が `cost.rs` の別の場所にある。**「今のコストモデルの前提は何か」を知るには、全ファイルを grep するしかない。**

集めることで、いくつも副産物が出てくる。

- **一覧として読める。** `sel_eq_indexed: 0.001` と `sel_eq_unindexed: 0.1` が隣にあれば、「索引つき等値は 100 倍絞る想定」と一目で分かる
- **相互の整合性を検査できる** (後述)
- **まとめて差し替えられる**
- **単位が揃っているか確かめられる。** コメントに「ページ I/O = 1.0 に対する相対値」と書いてある

`index_bonus: 0.5` に付いたコメントが率直だ。

```rust title="core/translate/optimizer/cost_params.rs"
    /// Bonus subtracted from cost when using an index (encourages index usage).
    pub index_bonus: f64,
```

[`core/translate/optimizer/cost_params.rs#L67-L68`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/translate/optimizer/cost_params.rs#L67-L68)。

**「索引の利用を促すために、コストから引く下駄」。** モデルから導かれた値ではなく、意図的な偏りだと書いてある。**「これは補正である」と明記されていれば、モデルの精度を上げたときに真っ先に見直せる。**

SQLite への参照もある。

```rust title="core/translate/optimizer/cost_params.rs"
    /// Estimated rows from IN subquery when actual count unknown.
    /// Matches SQLite's estimate (where.c line 3230).
    pub in_subquery_rows: f64,
```

[`core/translate/optimizer/cost_params.rs#L50-L52`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/translate/optimizer/cost_params.rs#L50-L52)。

**「SQLite の見積もりに合わせている (where.c の 3230 行目)」。** [ここでも参照実装を指している](../sqlite-compat/)。

### 読み込んだ値は検証する

```rust title="core/translate/optimizer/cost_params.rs"
        for (name, val) in selectivity_params {
            if val <= 0.0 || val > 1.0 {
                return Err(format!("{name} must be in (0, 1], got {val}"));
            }
        }

        // Indexed selectivity should be <= unindexed (indexes are more selective)
        if self.sel_eq_indexed > self.sel_eq_unindexed {
            return Err(format!(
                "sel_eq_indexed ({}) should be <= sel_eq_unindexed ({})",
                self.sel_eq_indexed, self.sel_eq_unindexed
            ));
        }
```

[`core/translate/optimizer/cost_params.rs#L208-L233`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/translate/optimizer/cost_params.rs#L208-L233)。

検査が 2 種類ある。

1. **個別の値域** — 選択率は (0, 1]、キャッシュ再利用係数は [0, 1)、コストの重みは非負
2. **値の間の関係** — 索引つき等値の選択率は、索引なしより小さくなければならない

2 番目が、定数を 1 箇所に集めたからできることになる。**「索引がある方が絞りが甘い」という設定は、意味的にありえない。** 個別に見れば両方とも合法な値なので、並べて初めて検出できる。

選択率の下限が `0.0` ではなく **`> 0.0`** なのも効いている。0 を許すと「この述語は 1 行も返さない」という見積もりになり、コストの掛け算が全部 0 に潰れる。

### 不正なら、黙って既定値に戻る

```rust title="core/translate/optimizer/cost_params.rs"
    /// Load parameters from a JSON file.
    ///
    /// Returns default parameters if the file cannot be read, parsed, or validated.
    pub fn load_from_file(path: &std::path::Path) -> Self {
        match std::fs::read_to_string(path) {
            Ok(contents) => match serde_json::from_str::<Self>(&contents) {
                Ok(params) => {
                    if let Err(e) = params.validate() {
                        tracing::warn!(?path, error = %e, "Invalid cost params, using defaults");
                        return Self::default();
                    }
                    tracing::info!(?path, "Loaded optimizer cost parameters from file");
                    params
                }
                Err(e) => {
                    tracing::warn!(?path, error = %e, "Failed to parse cost params JSON, using defaults");
                    Self::default()
                }
            },
            Err(e) => {
                tracing::warn!(?path, error = %e, "Failed to read cost params file, using defaults");
                Self::default()
            }
        }
    }
```

[`core/translate/optimizer/cost_params.rs#L157-L181`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/translate/optimizer/cost_params.rs#L157-L181)。

**3 つの失敗経路すべてで、警告を出して既定値を返す。** エラーを返して起動を止めない。

判断として妥当なのは、**コスト定数が壊れていても、クエリの結果は正しいから**だ。悪くなるのは計画の質だけになる。「調整用のファイルが読めないのでデータベースが開かない」は、被害の方が大きい。

その代わり `tracing::warn!` を出す。**黙って無視するのではなく、記録は残す。**

成功時に `tracing::info!` を出しているのも大事で、**「意図せず調整ファイルが効いている」を検知できる。** 性能が説明できないとき、ログを見れば分かる。

未指定のフィールドが既定値になるのも、`#[serde(default)]` で実現されている。

```rust title="core/translate/optimizer/cost_params.rs"
#[cfg_attr(feature = "serde", serde(default))]
pub struct CostModelParams {
```

[`core/translate/optimizer/cost_params.rs#L13-L15`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/translate/optimizer/cost_params.rs#L13-L15)。

**1 個だけ調整したいときに、25 個全部を書かなくていい。**

### 機能を切れば、コストがゼロになる

```rust title="core/translate/optimizer/cost_params.rs"
/// Compile-time static default parameters (zero runtime overhead).
pub static DEFAULT_PARAMS: CostModelParams = CostModelParams::new();
```

```rust title="core/translate/optimizer/cost_params.rs"
/// Lazily-loaded parameters from `TURSO_OPTIMIZER_PARAMS` env var (cached process-wide).
/// Falls back to defaults if env var not set or loading fails.
pub static LOADED_PARAMS: std::sync::LazyLock<CostModelParams> =
    std::sync::LazyLock::new(CostModelParams::from_env_or_default);
```

[`core/translate/optimizer/cost_params.rs#L142-L196`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/translate/optimizer/cost_params.rs#L142-L196)。

使う側はこうなる。

```rust title="core/translate/optimizer/mod.rs"
    #[cfg(feature = "optimizer_params")]
    let params: &cost_params::CostModelParams = &cost_params::LOADED_PARAMS;
    #[cfg(not(feature = "optimizer_params"))]
    let params: &cost_params::CostModelParams = &cost_params::DEFAULT_PARAMS;
```

[`core/translate/optimizer/mod.rs#L972-L976`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/translate/optimizer/mod.rs#L972-L976)。

**機能を無効にすると `const fn` で作った静的変数への参照になる。** `LazyLock` の初期化チェックも、`serde_json` への依存も消える。

そして `CostModelParams::new()` が `const fn` であることが、これを可能にしている。**既定値を「実行時に構築するもの」ではなく「コンパイル時に決まるもの」にしておくと、動的読み込みを後から足しても既定経路が重くならない。**

さらに、**参照の型が両方とも `&CostModelParams` で同じ**になっている。この 2 行より下のコードは、機能フラグを一切知らない。

## なぜそうなっているか

- **定数を 1 箇所に集めたのは、モデルの前提を一覧にするため。** 散らばった魔法の数字は、変えるどころか把握もできない。
- **単位を揃えてコメントに書いたのは、比較できるようにするため。** 「ページ I/O = 1.0 に対する相対値」と書いてあれば、`0.003` が何を意味するか分かる。
- **意図的な偏りに名前を付けたのは、後で見直せるようにするため。** `index_bonus` は「索引を使わせたいから引く下駄」で、モデルから導かれた値ではない。名前と説明があれば、モデルを改善したときに真っ先に疑える。
- **値の間の関係も検証するのは、集めたからできるようになったから。** 個別に見れば合法な値の組み合わせが、意味的にありえないことがある。
- **選択率の下限を 0 より大きくしたのは、0 がコストを潰すから。** 「1 行も返らない」という見積もりは、掛け算の連鎖を全部 0 にする。
- **不正な設定で起動を止めないのは、結果の正しさに影響しないから。** 計画の質が落ちるだけなら、既定値に戻して動く方がよい。
- **成功時にもログを出すのは、意図しない適用を検知するため。** 「性能が説明できない」ときに、まず疑うべき情報になる。
- **未指定を既定値にしたのは、1 個だけ調整したいから。** 全項目を書かせると、既定値が変わったときに追随できない。
- **既定値を `const fn` にしたのは、動的読み込みのコストを既定経路に払わせないため。** 動的な機能を足すとき、既定の経路が重くならない形を最初に確保しておく。

## どう活かすか

- **見積もりや重みづけの定数は、1 つの構造体に集める。** 散らばっていると、変更どころか「今どんな仮定を置いているか」を把握できない。集めるだけで、一覧・検証・差し替えが同時に手に入る。
- **各定数に単位と基準を書く。** 「相対値」「秒」「バイト」。基準がないと、隣の定数と比べられない。
- **モデルから導かれない補正には、そう分かる名前を付ける。** 「ボーナス」「ペナルティ」「係数」。理論値と混ざると、後でどちらを直すべきか分からなくなる。
- **検証は、個別の値域と値の間の関係の両方でやる。** 集めたことの一番の利益は 2 番目にある。
- **設定の読み込み失敗で、機能全体を止めるかどうかを意識的に決める。** 結果の正しさに影響しない設定なら、既定値に戻して警告を出す方がよい。影響するなら止める。
- **設定が適用されたことも、ログに出す。** 適用の失敗だけを記録すると、「効いているはずのものが効いていない」は分かるが「効かないはずのものが効いている」は分からない。
- **部分指定を許す。** 全項目の指定を要求すると、既定値の変更が利用者に届かなくなる。
- **既定値はコンパイル時に決まる形にしておく。** そうすれば、動的な読み込みを後から足しても、使わない人のコストがゼロのままになる。
- **機能フラグの分岐は、1 箇所に閉じ込めて同じ型を返す。** 下流のコードがフラグを知らずに済む。

---
title: "main_loop が、命令を吐く順番そのものを表す"
description: "エミッタが吐くのは 1 本の入れ子ループと、その前後の初期化・後処理だ。SELECT の命令列は Init → Open → Body → Close の 4 段と、ループを抜けた後の集約・ソートで決まる。プログラムの最初に `Init` を置いて末尾へ飛ばし、末尾に `Transaction` を置いて本体へ戻す — この折り返しは SQLite と同じ形で、`EXPLAIN` の突き合わせが成立する前提になっている。"
group: "SQL からバイトコードへ"
sidebar:
  order: 11
---

## この層の責務

オプティマイザが決めたのは「どのテーブルをどの順にどう読むか」までだ。それを命令列にするのがエミッタの仕事になる。

出力の形は決まっている。**1 本の入れ子ループと、その前後**だ。

```text
Init  ─────────────────────────► (末尾へジャンプ)
start: ┌ 初期化 (カーソル、ソータ、集約レジスタ、LIMIT)
       ├ ループ開始 (join_order の順に Rewind/Seek を積む)
       │  └ ループ本体 (条件評価、結果列の計算、出力)
       ├ ループ終了 (join_order の逆順に Next を積む)
       ├ 後処理 (GROUP BY、集約、ウィンドウ、ORDER BY)
       └ Halt
       Transaction ─────────────► (start へ戻る)
```

演算子ツリーを木構造で走査してコードを生成するのではなく、**このテンプレートの各所を埋めていく**という形になっている。プランが平らな構造体だった ([該当ページ](../logical-plan/)) のと表裏一体だ。

## 主要な型とその関係

### 4 段は 4 つの型の `emit` に対応する

```console
$ wc -l core/translate/main_loop/*.rs
 576 body.rs
 588 close.rs
 194 conditions.rs
1488 hash.rs
  83 in_seek.rs
 617 init.rs
 122 mod.rs
 496 multi_index.rs
 701 open.rs
 466 seek.rs
```

| 型                | ファイル   | 何を吐くか                                           |
| ----------------- | ---------- | ---------------------------------------------------- |
| `InitLoop`        | `init.rs`  | カーソルを開く、ソータを作る、集約レジスタを確保する |
| `OpenLoop`        | `open.rs`  | `join_order` の順に `Rewind` / `SeekGE` などを積む   |
| `LoopBodyEmitter` | `body.rs`  | 条件評価と結果列の計算                               |
| `CloseLoop`       | `close.rs` | 逆順に `Next` / `Prev` を積み、ループ先頭へ戻す      |

`hash.rs` が 1,488 行と大きいのは、ハッシュ結合のビルド側が「別のループ」を丸ごと吐くからだ ([該当ページ](../hash-join-spill/))。

### `TranslateCtx` — 生成中の状態を持ち回る

`emit_query` の各段は `&mut TranslateCtx` を共有する。ラベル、レジスタ番号、メタデータがここに溜まる。

```rust title="core/translate/emitter/select.rs:59-66 (抜粋)"
let result_cols_start = program.with_scoped_result_cols_start(|program| {
    // Boxed to keep ~960 B off the prepare-path stack; see TranslateCtx size.
    let mut t_ctx = Box::new(TranslateCtx::new(
        program,
        resolver.fork_with_expr_cache(),
        plan.table_references.joined_tables().len(),
        false,
    ));
```

**`TranslateCtx` も `Box` に載る。** `ProgramBuilder` が 800 バイトで `Box` 化されていた ([パースのページ](../parse-to-ast/)) のと同じ理由で、こちらは約 960 バイト。サブクエリごとに `emit_query` が再帰するので、1 段あたり 1.7 KB を積まない設計にしている。

`resolver.fork_with_expr_cache()` にも注意がいる。**`Resolver` はスコープごとに fork される。** 式 → レジスタのキャッシュはスコープをまたいで有効でないので、子スコープには新しいキャッシュを渡す。

## 処理の流れ (コードを追う)

### `emit_query` の順序には全部理由がある

[`core/translate/emitter/select.rs:78`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/translate/emitter/select.rs#L78) の `emit_query` を順に追う。

**1. ループ終端のラベルを最初に確保する。**

```rust title="core/translate/emitter/select.rs:83-84"
let after_main_loop_label = program.allocate_label();
t_ctx.label_main_loop_end = Some(after_main_loop_label);
```

まだどの命令に対応するか分からないラベルを先に取る。以降のあらゆる早期脱出 (`LIMIT` の打ち切り、定数偽条件、`Rewind` で空だったとき) がこのラベルを目標にする。**前方参照をラベルで表し、最後に解決する。**

**2. 非相関サブクエリを最初に評価する。**

```rust title="core/translate/emitter/select.rs:93-94 (抜粋)"
// Evaluate uncorrelated subqueries as early as possible, because even LIMIT can reference a subquery.
// This must happen before VALUES emission since VALUES expressions may contain scalar subqueries.
```

**`LIMIT (SELECT ...)` があり得る。** だから `LIMIT` の初期化より前にサブクエリを評価しておく必要がある。

**3. `VALUES` はここで打ち切る。**

```rust title="core/translate/emitter/select.rs:106-112"
if !plan.values.is_empty() {
    init_limit(program, t_ctx, &plan.limit, &plan.offset)?;
    let reg_result_cols_start = emit_values(program, plan, t_ctx)?;
    program.preassign_label_to_next_insn(after_main_loop_label);
    return Ok(reg_result_cols_start);
}
```

`VALUES (1,2),(3,4)` にはループがない。**早期 return するが、その前に `after_main_loop_label` を必ず解決している。** ラベルを未解決のまま返すと、組み立て時にエラーになる。

**4. FROM 句のサブクエリを先に吐く。**

```rust title="core/translate/emitter/select.rs:114"
emit_from_clause_subqueries(program, t_ctx, &mut plan.table_references, &plan.join_order)?;
```

メインループが読む対象なので、ループより前に用意する。

**5. GROUP BY / 集約 / ウィンドウの初期化。** 3 つは排他で、`if / else if / else if` になっている。

**6. `DISTINCT` のハッシュ表を初期化。**

**7. `LIMIT` の初期化。**

**8. 定数偽条件なら、ここでループを飛ばす。**

```rust title="core/translate/emitter/select.rs:211-219"
// No rows will be read from source table loops if there is a constant false condition eg. WHERE 0
// however an aggregation might still happen,
// e.g. SELECT COUNT(*) WHERE 0 returns a row with 0, not an empty result set.
// This Goto must be placed AFTER all initialization (cursors, sorters, etc.) so that
// resources like the GROUP BY sorter are properly opened before we skip to the aggregation phase.
if plan.contains_constant_false_condition {
    program.emit_insn(Insn::Goto {
        target_pc: after_main_loop_label,
    });
}
```

**`SELECT COUNT(*) FROM t WHERE 0` は空集合ではなく `0` を返す。** だからループは飛ばすが集約は走らせる。そして飛ばす `Goto` は、初期化を全部終えた後に置かなければならない — 飛んだ先で GROUP BY のソータを使うからだ。

「初期化と本体の境界がどこか」という問いに、この 1 個の `Goto` の位置が答えている。

**9〜12. 4 段のループ。**

```rust title="core/translate/emitter/select.rs:221-267 (抜粋)"
InitLoop::emit(program, t_ctx, &plan.table_references, &mut plan.aggregates,
               &OperationMode::SELECT, &plan.where_clause, &plan.join_order,
               &mut plan.non_from_clause_subqueries)?;

// ... simple_count の近道 ...

OpenLoop::emit(program, t_ctx, &plan.table_references, &plan.join_order,
               &plan.where_clause, None, OperationMode::SELECT,
               &mut plan.non_from_clause_subqueries)?;

LoopBodyEmitter::emit(program, t_ctx, plan)?;

CloseLoop::emit(program, t_ctx, &plan.table_references, &plan.join_order,
                OperationMode::SELECT, Some(plan))?;

program.preassign_label_to_next_insn(after_main_loop_label);
```

**4 段のうち 3 段が `join_order` を受け取る。** テーブルの並びが、そのまま `Rewind` の積み方と `Next` の積み方を決める。`OperationMode::SELECT` を渡しているのは、同じ 4 段を `DELETE` と `UPDATE` も使うからだ。

**13. ループを抜けた後の後処理。** GROUP BY → 集約 → ウィンドウ → `ORDER BY` の順。

```rust title="core/translate/emitter/select.rs:275-294 (抜粋)"
if has_group_by_exprs {
    // ... group_by_agg_phase / group_by_emit_row_phase ...
} else if !plan.aggregates.is_empty() {
    emit_ungrouped_aggregation(program, t_ctx, plan, &mut grouped_output_subqueries)?;
} else if plan.window.is_some() {
    emit_window_flush(program, t_ctx, plan)?;
}

if has_order_by && order_by_necessary {
    EmitOrderBy::emit(program, t_ctx, plan)?;
}
```

`ORDER BY` が最後なのは、ソータに詰めるのがループ本体で、取り出すのがここだからだ。

### `epilogue` が `Init` の飛び先を作る

`prologue` が最初に `Insn::Init { target_pc: init_label }` を吐いた ([パースのページ](../parse-to-ast/))。その飛び先が `epilogue` で確定する。

```rust title="core/vdbe/builder.rs:2011-2013"
// "rollback" flag is used to determine if halt should rollback the transaction.
self.emit_halt(self.flags.rollback());
self.preassign_label_to_next_insn(self.init_label);
```

**`Halt` の直後が `init_label` の位置になる。** つまりプログラムは「先頭 → 末尾 → 本体 → `Halt`」という順に実行される。

末尾に置かれるのが `Transaction` 命令だ。

```rust title="core/vdbe/builder.rs:2016-2032 (抜粋)"
if !matches!(self.txn_mode, TransactionMode::None) {
    let write_dbs = self.write_databases.clone();
    for db_id in &write_dbs {
        let schema_cookie = if db_id == crate::MAIN_DB_ID {
            schema.schema_version
        } else {
            self.write_database_cookies.get(&db_id).copied().unwrap_or(0)
        };
        self.emit_insn(Insn::Transaction {
            db: db_id,
            tx_mode: self.txn_mode,
            schema_cookie,
        });
    }
```

**`Transaction` 命令に schema cookie が埋め込まれる。** 実行時にこれとディスクの cookie を比べて、食い違えば `SchemaUpdated` を返す ([スキーマ解決のページ](../schema-resolution/))。プログラムが「自分がどのスキーマ前提でコンパイルされたか」を命令として持ち歩いている。

`ATTACH` した各データベースについても、書き込むものと読むだけのものに分けて `Transaction` を吐く。

そして最後に本体へ戻る。

```rust title="core/vdbe/builder.rs:2049-2054"
if !self.constant_spans.is_empty() {
    self.emit_constant_insns();
}
self.emit_insn(Insn::Goto {
    target_pc: self.start_offset,
});
```

**定数命令の巻き上げも、ここで末尾に移される。** ループ内で毎回評価する必要のない式 (定数、パラメータのバインド) を、`Transaction` の後・本体へ戻る前という「1 回だけ通る場所」に置く。`constant_spans` が指しているのは元の位置で、`emit_constant_insns` がそれを移動する。

**命令の並べ替えが起きるので、ラベルは「位置」ではなく「アンカー」として持つ**必要がある。

```rust title="core/vdbe/builder.rs:236-241 (抜粋)"
/// A vector where index=label number, value=resolved offset. Resolved in build().
/// For each allocated label, the offset of the instruction emitted *just
/// before* the label's logical "next-insn" anchor. The label resolves to
/// `anchor_offset + 1` so it tracks whichever instruction ends up at that
/// position, even after `emit_constant_insns` reorders the program.
label_to_resolved_offset: Vec<Option<InsnReference>>,
```

「この命令の次」として覚えておけば、並べ替えの後も正しい位置を指す。

### サブプログラムだけ形が違う

トリガと外部キーアクションのサブプログラムは、`prologue` も `epilogue` も別経路を通る。

```rust title="core/vdbe/builder.rs:1995-2008 (抜粋)"
if self.flags.is_subprogram() {
    // Subprograms (triggers, FK actions) just emit Halt without Transaction
    let description = if self.trigger.is_some() { "trigger" } else { "fk action" };
    self.emit_insn(Insn::Halt { err_code: 0, description: description.to_string(), on_error: None, description_reg: None });
    return;
}
```

**`Transaction` を吐かない。** 親のトランザクションの中で走るからだ。[クエリの一生のページ](../query-lifecycle/) で見た `step_subprogram()` が 5 つの関門を飛ばすのと対になっている — サブプログラムは、生成時も実行時も「親が面倒を見る」前提で作られる。

## 守られている不変条件

**確保したラベルは全部解決する。** 早期 return する経路でも `preassign_label_to_next_insn` を呼ぶ。未解決のまま `build()` に入るとエラーになる。

**初期化を全部終えてから、ループを飛ばす `Goto` を置く。** 飛んだ先が使う資源が開いていなければならない。

**ループを開く順と閉じる順は逆。** `OpenLoop` が `join_order` の順、`CloseLoop` が逆順。

**`Transaction` 命令は末尾に 1 回だけ。** `Init` からの折り返しで必ず通る。

**サブプログラムは `Transaction` を吐かない。**

## つまずきどころ / 設計の含み

### 近道を足すたびにラベル解決を忘れる罠

`simple_count` の近道にコメントが付いている。

```rust title="core/translate/emitter/select.rs:232-240 (抜粋)"
if matches!(plan.simple_aggregate, Some(SimpleAggregate::Count))
    && emit_simple_count(program, t_ctx, plan)?
{
    // Keep LIMIT's early-exit jump target valid even on the simple_count fast path.
    // init_limit may emit an IfNot to after_main_loop_label (e.g. scalar subquery injects LIMIT 1).
    // Without resolving this label before the early return, bytecode assembly fails
    // with an unresolved IfNot target.
    program.preassign_label_to_next_insn(after_main_loop_label);
    return Ok(t_ctx.reg_result_cols_start.unwrap());
}
```

`COUNT(*)` を B-tree のカウント命令 1 個で済ませる近道だが、**その前に `init_limit` がラベルへのジャンプを吐いている可能性がある**。

`VALUES` の早期 return も同じ処理をしていた。**早期 return の経路が増えるたびに、同じ 1 行を書く必要がある。** ラベルの確保と解決が別の場所にある設計の代償で、型では守れない。

### 4 段が `OperationMode` で共有されている

`InitLoop::emit(..., &OperationMode::SELECT, ...)` のように、4 段は `SELECT` / `DELETE` / `UPDATE` で共有されている。

利点は明らかだ。`DELETE FROM t WHERE ...` の走査部分は `SELECT * FROM t WHERE ...` と同じでよく、索引の使い方も結合順序も共通の実装が使える。

代償は、**4 段の各関数が「今どのモードか」で分岐を持つ**ことだ。`open.rs` が 701 行、`close.rs` が 588 行あるうちの一定量が、この分岐に使われている。演算子ツリーなら `Scan` ノードは 1 種類で済むところを、モードの数だけ条件分岐が要る。

### `emit_query` は `plan` を `&mut` で受ける

```rust title="core/translate/emitter/select.rs:78-82 (抜粋)"
pub fn emit_query<'a>(
    program: &mut ProgramBuilder,
    plan: &'a mut SelectPlan,
    t_ctx: &mut TranslateCtx<'a>,
) -> Result<usize> {
```

コード生成の途中でプランを書き換えている。`Distinctness::Distinct { ctx }` に生成したハッシュ表の情報を書き戻し、`non_from_clause_subqueries` の状態を「評価済み」に変える。

```rust title="core/translate/emitter/select.rs:199-201 (抜粋)"
if let Distinctness::Distinct { ctx } = &mut plan.distinctness {
    *ctx = distinct_ctx
}
```

**プランはコード生成の入力であると同時に、生成中の作業領域でもある。** [前のページ](../logical-plan/) で見た「プランがレジスタ番号を持っている」の続きで、`QueryDestination::Unset` のようなバリアントが必要になる理由でもある。

読む側への含みは、**`SelectPlan` を見るときに「最適化後」と「生成後」で中身が違う**ことだ。`tracing::debug!(plan_sql = plan.to_string())` で出力されるのは最適化直後の姿で、生成が終わった後の `plan` はさらに書き換わっている。

### `emit_program` の `after` クロージャ

```rust title="core/translate/emitter/mod.rs:1132-1138 (抜粋)"
pub fn emit_program(
    connection: &Arc<Connection>,
    resolver: &Resolver,
    program: &mut ProgramBuilder,
    plan: Plan,
    after: impl FnOnce(&mut ProgramBuilder),
) -> Result<()> {
```

`after` を受け取るのは `Plan::Update` だけだ。他のバリアントは受け取ったまま捨てる。

`UPDATE` は「行を集めてから書く」経路 (`DmlSafetyReason`) を持つことがあり、**書き終わった後に追加の命令を吐く必要がある**。それを呼び出し元から注入する形になっている。5 バリアントのうち 1 つのためだけに、入口のシグネチャに引数が 1 本増えている。

こういう「1 ケースのために全体の形が決まる」箇所は、`Plan` を平らに扱う設計では避けにくい。演算子ツリーなら `Update` ノードの子として表現できたものが、ここではクロージャ引数になっている。

---
title: "Binder — AST ノード自身が自分を登録する"
description: "「この宣言をどのスコープにどんな種類で登録するか」を、SemanticBuilder の巨大な match ではなく、AST ノード側の trait 実装に置いた。VariableDeclarator::bind、Function::bind、CatchParameter::bind と 18 個並ぶ。var の巻き上げの厄介さも、TS の型/値の 2 空間も、この単位に閉じ込められている。"
group: "意味をつける — Semantic"
sidebar:
  order: 42
---

## 何を学んだか

宣言をシンボルとして登録する処理は、宣言の種類ごとに全く違う。`const x` はそのブロックのスコープに、`var x` は関数スコープまで巻き上げて、`catch (e)` の `e` は catch 節専用のスコープに、`type T` は型空間に登録される。

oxc はこれを `SemanticBuilder` の中の `match kind { ... }` にせず、**トレイトの実装として AST ノード側に置いた。**

```rust title="crates/oxc_semantic/src/binder.rs"
pub trait Binder<'a> {
    fn bind(&self, builder: &mut SemanticBuilder<'a>);
}
```

メソッド 1 本のトレイトで、実装は 18 個ある。

```rust title="crates/oxc_semantic/src/binder.rs"
impl<'a> Binder<'a> for VariableDeclarator<'a> { ... }
impl<'a> Binder<'a> for Class<'a> { ... }
impl<'a> Binder<'a> for Function<'a> { ... }
impl<'a> Binder<'a> for BindingRestElement<'a> { ... }
impl<'a> Binder<'a> for FormalParameter<'a> { ... }
impl<'a> Binder<'a> for FormalParameterRest<'a> { ... }
impl<'a> Binder<'a> for CatchParameter<'a> { ... }
impl<'a> Binder<'a> for ImportSpecifier<'a> { ... }
impl<'a> Binder<'a> for ImportDefaultSpecifier<'a> { ... }
impl<'a> Binder<'a> for ImportNamespaceSpecifier<'a> { ... }
impl<'a> Binder<'a> for TSImportEqualsDeclaration<'a> { ... }
impl<'a> Binder<'a> for TSTypeAliasDeclaration<'a> { ... }
impl<'a> Binder<'a> for TSInterfaceDeclaration<'a> { ... }
impl<'a> Binder<'a> for TSEnumDeclaration<'a> { ... }
impl<'a> Binder<'a> for TSEnumMember<'a> { ... }
impl<'a> Binder<'a> for TSNamespaceDeclaration<'a> { ... }
impl<'a> Binder<'a> for TSTypeParameter<'a> { ... }
impl<'a> Binder<'a> for TSMappedType<'a> { ... }
```

呼び出し側は `visit_*` の中で `decl.bind(self)` と書くだけになる。**「どのノードが宣言を作るか」は呼び出し箇所を見れば分かり、「どう作るか」は `impl Binder` を見れば分かる。**

## なぜそうなっているか

### 分割の単位が「ノード型」でよい理由

宣言の登録に必要な判断は、ほぼ全部そのノードの中で完結する。

- 種類 (`SymbolFlags` の `includes`) — ノードの種類と修飾子から決まる
- 共存できないもの (`excludes`) — 同上
- 登録先のスコープ — 現在のスコープか、その祖先のどれか

外部から要るのは `SemanticBuilder`(現在のスコープ、スコープ木、シンボルテーブル、エラー出力) だけで、それを `&mut` で受け取れば足りる。**依存が 1 方向なので、トレイトに切り出す条件が揃っている。**

もし `SemanticBuilder` 側の 1 つの `match` に全部書いたら、1000 行を超える関数になる。しかも `VariableDeclarator` の `var` 巻き上げのように、1 ケースだけで 100 行近いものがある。

### `Class::bind` は 15 行

いちばん単純な例がこれになる。

```rust title="crates/oxc_semantic/src/binder.rs"
impl<'a> Binder<'a> for Class<'a> {
    fn bind(&self, builder: &mut SemanticBuilder<'a>) {
        let includes = if self.declare {
            SymbolFlags::Class | SymbolFlags::Ambient
        } else {
            SymbolFlags::Class
        };
        let Some(ident) = &self.id else { return };
        let symbol_id =
            builder.declare_symbol(ident.span, ident.name, includes, SymbolFlags::ClassExcludes);
        ident.symbol_id.set(Some(symbol_id));
    }
}
```

やることは 3 つ。`includes` / `excludes` を決めて、`declare_symbol` を呼び、返ってきた `SymbolId` を AST ノードの `Cell` に書き戻す。

**最後の書き戻しが semantic と AST を繋いでいる。** `BindingIdentifier` は `symbol_id: Cell<Option<SymbolId>>` を持っていて、semantic を通した後は「AST ノードから直接シンボルを引ける」ようになる。`Cell` なのは、`Visit` (不変参照) の中から書き込むためだ。

### 再宣言エラーの正体は 1 行

`declare_symbol` の先で、`excludes` との突き合わせが行われる。

```rust title="crates/oxc_semantic/src/builder.rs"
        if flags.intersects(excludes) {
            let symbol_span = self.scoping.symbol_span(symbol_id);
            self.error(redeclaration(&name, symbol_span, span));
        }
```

既存シンボルの flags と、今から宣言するものの `excludes` の積を取る。0 でなければ再宣言エラー。**「let x を 2 回宣言できない」「var x と function x は共存できる」といった規則は、全部 [`SymbolFlags` の定義](./scope-and-symbol/)側に書いてあり、ここには判定しか残っていない。**

その手前には例外が 1 つある。

```rust title="crates/oxc_semantic/src/builder.rs"
        // A named function expression binds its own name in the function's scope, so a same-named
        // parameter is not a redeclaration: `(function n(n) {})` - param `n` is fine.
        if flags.contains(SymbolFlags::FunctionExpression) {
            return None;
        }
```

`(function n(n) {})` が合法だという JS の細部が、`SymbolFlags::FunctionExpression` というビットと 3 行で表現されている。

### `var` の巻き上げが厄介な理由

`VariableDeclarator::bind` は 100 行あり、そのほとんどが `var` のためのものだ。

```rust title="crates/oxc_semantic/src/binder.rs"
        if kind.is_lexical() {
            self.id.bound_names(&mut |ident| {
                let symbol_id = builder.declare_symbol(ident.span, ident.name, includes, excludes);
                ident.symbol_id.set(Some(symbol_id));
            });
        } else {
            // ------------------ var hosting ------------------
            let mut target_scope_id = builder.current_scope_id;
            // Stack-allocated: nesting depth from a `var`/`let`/`const` to the
            // enclosing function (or program) scope is small in practice — 8
            // covers almost all real-world cases without heap allocation.
            let mut var_scope_ids: SmallVec<[ScopeId; 8]> = SmallVec::new();

            // Collect all scopes where variable hoisting can occur
            for scope_id in builder.scoping.scope_ancestors(target_scope_id) {
                let flags = builder.scoping.scope_flags(scope_id);
                if flags.is_var() {
                    target_scope_id = scope_id;
                    break;
                }
                var_scope_ids.push(scope_id);
            }
```

`let` / `const` は 4 行。`var` は「関数スコープに当たるまで上り、通り過ぎたスコープを全部覚えておく」から始まる。

覚えておく理由が次のブロックにある。

```rust title="crates/oxc_semantic/src/binder.rs"
                for &scope_id in &var_scope_ids {
                    if let Some(symbol_id) =
                        builder.check_redeclaration(scope_id, span, name, excludes)
                    {
                        builder.add_redeclare_variable(symbol_id, includes, span);
                        declared_symbol_id = Some(symbol_id);

                        // Hoist current symbol to target scope when it is not already declared
                        // in the target scope.
                        if !builder.scoping.scope_has_binding(target_scope_id, name) {
                            // remove current scope binding and add to target scope
                            // avoid same symbols appear in multi-scopes
                            builder.scoping.remove_binding(scope_id, name);
                            builder.scoping.add_binding(target_scope_id, name, symbol_id);
                            builder.scoping.set_symbol_scope_id(symbol_id, target_scope_id);
                        }
                        break;
                    }
                }
```

`{ var x; } { var x; }` のような場合、先に見た `var x` が中間スコープに仮登録されていることがある。それを見つけたら、**中間スコープから削除して関数スコープに移し替える。** 同じ名前のシンボルが複数のスコープに現れないようにするためだ。

さらに最後にもう 1 手ある。

```rust title="crates/oxc_semantic/src/binder.rs"
                // Finally, add the variable to all hoisted scopes
                // to support redeclaration checks when declaring variables with the same name later.
                for &scope_id in &var_scope_ids {
                    builder.hoisting_variables.insert((scope_id, name), symbol_id);
                }
```

通過した中間スコープ全部に「この名前は巻き上げられている」という印を残す。後から `{ var x; let x; }` のようなコードが来たときに、再宣言エラーを出すのに要る。

**JS の `var` 巻き上げは、実装すると「上る」「移し替える」「印を残す」の 3 手になる。** `let` の 4 行と比べると、この構文がどれだけ後付けの整合性を要求しているかが見える。

`SmallVec<[ScopeId; 8]>` を使っているのも実際的な判断で、コメントに理由がある。ネストの深さは実際には 8 を超えないので、ヒープ確保が起きない。

### 通し例では

```ts title="example.ts"
export async function collect(path: string): Promise<Entry[]> {
  const raw = await readFile(path, "utf8");
  const unused = 1;
  return raw.split("\n").map((name) => ({ name, size: name.length }));
}
```

呼ばれる `bind` はこうなる。

| ノード                | `bind` の実装            | includes                               | 登録先                 |
| --------------------- | ------------------------ | -------------------------------------- | ---------------------- |
| `import { readFile }` | `ImportSpecifier`        | `Import`                               | トップレベル           |
| `type Entry = ...`    | `TSTypeAliasDeclaration` | `TypeAlias`                            | トップレベル           |
| `function collect`    | `Function`               | `Function`                             | トップレベル           |
| `path: string`        | `FormalParameter`        | `FunctionScopedVariable`               | collect の関数スコープ |
| `const raw`           | `VariableDeclarator`     | `BlockScopedVariable \| ConstVariable` | collect の関数スコープ |
| `const unused`        | `VariableDeclarator`     | 同上                                   | 同上                   |
| `(name) =>` の `name` | `FormalParameter`        | `FunctionScopedVariable`               | アロー関数のスコープ   |

`const` なので `is_lexical()` が真になり、`VariableDeclarator::bind` は 4 行の枝を通る。**このコードには `var` が 1 つもないので、100 行のうち 96 行は実行されない。**

## ソースコードのどこか

- [`crates/oxc_semantic/src/binder.rs`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/crates/oxc_semantic/src/binder.rs) — `Binder` トレイトと 18 実装 (32KB)
- [`crates/oxc_semantic/src/builder.rs`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/crates/oxc_semantic/src/builder.rs) — `declare_symbol` / `check_redeclaration` / `bind` の呼び出し箇所
- [`crates/oxc_syntax/src/symbol.rs`](https://github.com/oxc-project/oxc/blob/apps_v1.81.0/crates/oxc_syntax/src/symbol.rs) — `SymbolFlags` と `*Excludes`

呼び出し側は `visit_*` の中に散っている。

```rust title="crates/oxc_semantic/src/builder.rs"
            class.bind(self);
            // ...
            func.bind(self);
            // ...
            param.bind(self);
            // ...
            specifier.bind(self);
```

20 か所ほどある。**`bind` を呼ぶ場所が「宣言が生まれる場所」の一覧になっている**ので、`grep '.bind(self)'` すると JS/TS で宣言を作る構文が全部出てくる。

## どう活かすか

**「種類ごとに違う処理」をトレイト実装に散らすか 1 つの `match` に集めるかは、依存の向きで決まる。** 各ケースが必要とするものが 1 つのコンテキストオブジェクトだけなら、トレイトに切り出せる。ケース同士が相互に呼び合ったり、全体を見渡す必要があるなら `match` のほうがいい。oxc の `Binder` は前者で、`SemanticBuilder` を `&mut` で受け取る以外の依存がない。

**判定ロジックと規則の定義を分ける。** 再宣言の判定は `flags.intersects(excludes)` の 1 行で、規則は `SymbolFlags` の定数定義に全部ある。仕様が変わったときに触るのは定数側だけになる。逆に、判定の中に `if kind == Let && existing == Var` のような条件を書き始めると、規則が判定に溶けて追えなくなる。

**「ここは深くならない」と分かっている再帰には `SmallVec` を使う。** スコープのネスト深さのように、理論上は無限でも実際には小さい量。`SmallVec<[T; 8]>` は 8 個までヒープを触らない。ただし**その根拠をコメントに書く**のが条件で、書いていないと後から「なぜ 8?」に答えられなくなる。

**「呼び出し箇所が一覧になる」設計は grep しやすさとして効く。** `bind(self)` を検索すれば宣言を作る全構文が出る。トレイトメソッドの名前を 1 つに絞ることで、コードベースが自己文書化されている。

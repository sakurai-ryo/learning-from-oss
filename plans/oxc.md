# oxc 章の執筆計画

2026-09-06 時点の章立て。ページはまだ 1 枚も書いていない。出力先は `src/content/docs/oss/oxc/`。ページの形式・frontmatter・リンク規約は `CLAUDE.md` の Content 節に従う。全ページ学び型 (何を学んだか / なぜそうなっているか / ソースコードのどこか / どう活かすか)。

## 参照リポジトリ

| 役割 | リポジトリ        | ref                 | ローカル                           |
| ---- | ----------------- | ------------------- | ---------------------------------- |
| 本体 | `oxc-project/oxc` | タグ `apps_v1.81.0` | `~/ghq/github.com/oxc-project/oxc` |

ソースリンクは `https://github.com/oxc-project/oxc/blob/apps_v1.81.0/<path>` の形にする。

frontmatter の `oss` は `repo: https://github.com/oxc-project/oxc`、`language: Rust`、`ref: apps_v1.81.0`。

バージョンは二系統ある。crate は `0.148.0`、アプリ (oxlint / oxfmt) は `1.81.0`。タグ `apps_v1.81.0` はアプリ側の採番。

## 軸

**JS ツールの一生。ソース文字列がトークンになり、木になり、意味を与えられ、検査され、また文字列に戻るまでを 1 本の縦線で辿る。**

読者は Rust は読めるがコンパイラフロントエンドは未経験、という層に置く。Rust の所有権やライフタイムは説明しないが、「なぜこのコードがこう書かれているか」を理解するのに必要なコンパイラ側の語彙 (トークン、再帰下降、スコープ解決、early error) は前提群で与える。

oxc の「なぜ速いか」は独立した群にせず、**群 4「木の設計」に集約**する。アリーナ、AST のメモリレイアウト、ast_tools によるコード生成の 3 つがそこに集まり、他の群からはこの群を参照するだけで済む形にする。

全ページを通して同じ 10 行程度の TS スニペット (通し例) を使い、トークン列 → AST → スコープ木 → lint 診断 → 出力文字列と変化させていく。

## 対象外

- `oxc_type_checker` (「まだ何も型検査しない足場」と自称する段階。概要の対象外リストで触れるだけ)
- `oxc_react_compiler` (React Compiler の Rust 移植。17MB あり、それ自体で 1 章になる規模)
- `oxc_regular_expression`
- `oxc_formatter_css` / `_yaml` / `_json` / `_graphql` (oxfmt は JS 専用ではないが、本章は JS/TS の線だけ辿る)
- `oxc_isolated_declarations`
- `napi/` の JS バインディング自体。ただし raw transfer は群 4 の 16・20 で AST 設計の帰結として触れる
- TypeScript は「パーサと AST がどう扱うか」まで。型の意味論には踏み込まない

## 構成 (概要 + 39 ページ / 8 群)

`group` の文字列は index.md の 読む順番 の見出しと一致させる。`sidebar.order` は下の番号をそのまま使う。

### 群 1: 前提 (order 1-4)

| order | slug                 | タイトル                    | 中身 / 主な参照                                                                                                                                                                                                                                           |
| ----- | -------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `js-toolchain-map`   | JS ツールチェインの地図     | Babel / ESLint / Prettier / tsc / SWC / esbuild がそれぞれ何をしているか、oxc のどの crate が対応するか。oxlint と oxfmt という 2 つのアプリと、その下の crate 群という二層構造。`ARCHITECTURE.md` (ただし現状とずれている点は「つまずきどころ」で触れる) |
| 2     | `lexing-and-parsing` | 字句解析と構文解析とは      | トークン、再帰下降、演算子優先順位、エラー回復という語彙。JS の文法が文脈依存である例 (`for (a in b)`、`yield`、`/` が除算か正規表現か) を先に見せ、群 3 の Context フラグの伏線にする                                                                    |
| 3     | `ast-and-estree`     | AST と ESTree               | ESTree が JS エコシステムの事実上の標準であること、oxc がそれにどこまで合わせ、どこで外しているか (enum による型階層、TS/JSX ノード)。`crates/oxc_ast/src/ast/`                                                                                           |
| 4     | `running-example`    | 通し例: 10 行の TS が辿る道 | 本章で使い続けるスニペットを提示し、各段でどう変わるかの全体像を 1 枚にまとめる (mermaid flowchart)。以降のページはここに戻ってくる                                                                                                                       |

### 群 2: 文字列を読む — Lexer (order 10-13)

**注意**: oxc にはレキサが 2 つある。パーサを駆動しているのは `crates/oxc_parser/src/lexer/` (19 ファイル・約 8,100 行) で、`crates/oxc_lexer` は `publish = false` のインキュベーティング実装。両者は独立していて `oxc_parser` は `oxc_lexer` に依存していない。群 2 は前者を主役にし、後者を 13 で扱う。

| order | slug                  | タイトル                                     | 中身 / 主な参照                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----- | --------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10    | `byte-handlers`       | 256 本の byte handler — 先頭バイトで飛ぶ     | `crates/oxc_parser/src/lexer/byte_handlers.rs` の `ByteHandlers<C> = [ByteHandler<C>; 256]`。`match` ではなく関数ポインタのジャンプテーブルにした理由。`handle_byte()`                                                                                                                                                                                                                                                                                                     |
| 11    | `on-demand-tokens`    | オンデマンドにトークンを 1 つずつ            | `cursor.rs:106` の `self.token = self.lexer.next_token()` が唯一の駆動点。トークン列をバッファしない設計。`Kind` と `Token` の表現。再字句化 (`re_lex_right_angle`) が必要になる場面                                                                                                                                                                                                                                                                                       |
| 12    | `escapes-and-unicode` | 文字列・数値・Unicode をどう読むか           | `lexer/string.rs`、`unicode.rs::read_string_escape_sequence`、`number.rs`。エスケープを含む文字列だけアリーナに cook する話                                                                                                                                                                                                                                                                                                                                                |
| 13    | `the-other-lexer`     | もう一つのレキサ — SIMD 一括レキサと差分検証 | `crates/oxc_lexer`。AVX2/BMI2 intrinsics 直書き (`_mm256_shuffle_epi8` / `_mm256_movemask_epi8`)、64 バイト/イテレーション、`pipeline/` の `classify → carve → coalesce → compress` 段構成、`lanes.rs` の SoA 出力 (lane は SIMD レーンではなく出力チャネル)。RUSTFLAGS で切り替わり `IS_SIMD` が公開する。まだ本番経路に載っておらず、`tasks/coverage/src/lexer_diff.rs` が既存レキサを oracle にして差分検証している。「新しい実装をどう安全に育てるか」の実例として読む |

### 群 3: 木を作る — Parser (order 20-25)

| order | slug                    | タイトル                                   | 中身 / 主な参照                                                                                                                                                                                                                                                                                                                                                                           |
| ----- | ----------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 20    | `recursive-descent`     | 再帰下降の骨格と cursor                    | `crates/oxc_parser/src/cursor.rs`。`cur_kind/at/eat/bump/expect`、ASI、`ParserCheckpoint` による `checkpoint()/rewind()/lookahead()`、リスト解析ヘルパ                                                                                                                                                                                                                                    |
| 21    | `context-flags`         | Context フラグ — 文法が文脈で変わる        | `context.rs` の `bitflags! pub struct Context: u16`。`In` / `Yield` / `Await` / `Return` / `Ambient` / `TopLevel`。既定は `Context::In`。`state.rs` の `ParserState` (45 行) との役割分担                                                                                                                                                                                                 |
| 22    | `expression-precedence` | 式のパースと優先順位                       | `js/expression.rs`。優先順位登り、カバーグラマー (`cover_initialized_name`)、アロー関数の再解釈                                                                                                                                                                                                                                                                                           |
| 23    | `ts-and-jsx`            | TS と JSX を 1 つのパーサで                | `ts/`、`jsx/`。`modifiers.rs` の `#[repr(C)] struct Modifiers { kinds: ModifierKinds(u16), offsets: [MaybeUninit<u32>; 15] }` — `Vec<Modifier>` を避けたビットフィールド + 固定長配列。`<` の曖昧さ (型引数か JSX か)                                                                                                                                                                     |
| 24    | `error-recovery`        | エラー回復 — fatal と非 fatal を分ける     | `error_handler.rs`。非致命は `errors` に push して続行、致命は `set_fatal_error()` → `lexer.advance_to_end()` で EOF へ飛ぶ。トークンスキップでも panic でもなく `Dummy::dummy(allocator)` を返して型を成立させ、リストループが `has_fatal_error()` で break する。`lib.rs` の `errors.truncate(fatal_error.errors_len)` と `panicked` フラグ。`ParserReturn` の doc が契約を明記している |
| 25    | `module-record`         | module_record — import/export を先に集める | `module_record.rs` の `ModuleRecordBuilder`、実体は `crates/oxc_syntax/src/module_record.rs`。パース中に集めるので linter が再走査しなくて済む。消費者は linter (`import/no_cycle`、`import/named`、`oxc/no_barrel_file`) と napi                                                                                                                                                         |

### 群 4: 木の設計 — Allocator・AST・コード生成 (order 30-35)

| order | slug                   | タイトル                                     | 中身 / 主な参照                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----- | ---------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 30    | `bump-allocator`       | Bump アリーナと `Box<'a, T>` / `Vec<'a, T>`  | `crates/oxc_allocator/src/arena/`。bumpalo を依存せず fork してベンダリングしている (冒頭に派生元 commit が明記)。`vec2/` の `RawVec { ptr, len: u32, cap: u32 }` — len/cap が usize ではなく u32 である理由                                                                                                                                                                                                                                                                    |
| 31    | `allocator-reuse`      | アロケータを使い回す                         | `pool/` の `AllocatorPool` (`Mutex<Stack<Allocator>>`、`AllocatorGuard::Drop` で返却)。`fixed_size.rs` の `BLOCK_SIZE = 2GiB-16` / `BLOCK_ALIGN = 4GiB` — 全ポインタの上位 32bit を揃えて JS 側が下位 32bit をオフセットとして読めるようにする raw transfer 用。`tracking.rs`                                                                                                                                                                                                   |
| 32    | `ast-memory-layout`    | AST のメモリレイアウトと Span                | `crates/oxc_span/src/span.rs` の `struct Span { start: u32, end: u32, _align: PointerAlign }` — サイズ 8 のまま align だけ上げる ZST フィールド。`#[ast]` マクロ (`oxc_ast_macros/src/ast.rs`) が付ける `#[repr(C)]` / `#[repr(u8)]` / `#[repr(C, u8)]`。enum 継承 (`Expression` ⊃ `MemberExpression`) のゼロコスト transmute。`size_of::<Expression>() == 16`                                                                                                                  |
| 33    | `ast-tools`            | ast_tools — AST 定義が唯一の真実             | `tasks/ast_tools/`。`main.rs` の `GENERATORS` 一覧、`schema/` と `generators/`、出力は `<krate>/src/generated/`。`just ast` で再生成し、生成物は git にコミットされ CI が `git diff --exit-code` で検証する。出力は Rust に留まらず `npm/oxc-types/types.d.ts`、`apps/oxlint/src-js/generated/`、`.github/generated/ast_changes_watch_list.yml` (CI の paths-filter そのもの) まで及ぶ。`assert_layouts.rs` (158KB) が 64bit/32bit 別に `size_of`/`offset_of` を const 検証する |
| 34    | `astkind-and-visit`    | 生成される走査 — AstKind と Visit / VisitMut | `oxc_ast/src/generated/ast_kind.rs` (100KB)。`AstKind` は `NodeId` を持つ構造体にのみ生成されるので全 AST 型が入っているわけではない。`AstType` (タグのみ、`AST_TYPE_MAX = 191`)。**`Visit::enter_node` は `AstKind<'a>` を受けるのに `VisitMut::enter_node` は `AstType` しか受けない**非対称 — `&mut` 中に別経路の参照を渡せないため、`VisitMut` では親を辿れない。これが群 6 の `Traverse` が存在する理由になる                                                              |
| 35    | `estree-serialization` | ESTree シリアライズと raw transfer           | `crates/oxc_estree`。serde を経由せず `trait ESTree` + `Serializer` + `CodeBuffer` で直接 JSON を書く。`derive_estree.rs` は生成物、例外は `oxc_ast/src/serialize/`。`Program::to_estree_json` 系がバイナリ膨張回避のため 4 本に分割されている。JSON を通さない raw transfer 経路 (`napi/parser/src/raw_transfer.rs`) と 31 の `fixed_size.rs` が繋がる                                                                                                                         |

### 群 5: 意味をつける — Semantic (order 40-45)

| order | slug                    | タイトル                                | 中身 / 主な参照                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----- | ----------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 40    | `scope-and-symbol`      | スコープとシンボル解決とは              | 宣言と参照の紐づけ、スコープチェーン、巻き上げ、TDZ。JS 固有の面倒 (`var` の関数スコープ、`catch` 引数、クラス名の内側束縛)。ここだけコンパイラ入門の続き                                                                                                                                                                                                                                                                                                                                                                                                      |
| 41    | `semantic-builder`      | SemanticBuilder — 数えてから作る        | `builder.rs:297` の `build`。既定は 2 パスで、先に `Stats::count(program)` (`stats.rs` の `Counter: Visit`) がノード/スコープ/シンボル/参照数を数えて `reserve` し、それから `visit_program`。数える 1 パスを足す方がベンチで最大 30% 速いという逆説。`with_stats(Stats)` を渡せば事前パスを飛ばせる                                                                                                                                                                                                                                                           |
| 42    | `binder`                | Binder — AST ノード自身が自分を登録する | `binder.rs:14` の `trait Binder<'a> { fn bind(&self, builder: &mut SemanticBuilder<'a>); }`。18 実装。`SymbolFlags` の `includes` / `excludes` の組が再宣言エラーの定義そのものになっている。`VariableDeclarator::bind` の `var` ホイスティング (`SmallVec<[ScopeId; 8]>` に中間スコープを積んで `is_var()` まで遡り `remove_binding` → `add_binding`)                                                                                                                                                                                                         |
| 43    | `data-oriented-scoping` | データ指向のスコープ表現                | `scoping.rs` と `multi_index_vec.rs`。`multi_index_vec!` マクロが 1 アロケーションに全フィールド配列を詰める独自コンテナを生成する (doc に Zig の `MultiArrayList` を手本にしたと明記)。`ScopeTable` = `parent_ids / node_ids / flags`、`SymbolTable` = `symbol_spans / flags / scope_ids / declarations`。N 個の `IndexVec` の ptr+len+cap 冗長性と bounds check を削る。2 次元構造は `self_cell!` の `ScopingCell` でアリーナに逃がす。ID は `u32` ではなく `NonMaxU32` (`oxc_index` の `define_nonmax_u32_index_type!`) で `Option<Id>` が 4 バイトに収まる |
| 44    | `reference-resolution`  | 参照解決 — 集めてから 1 周する          | `unresolved_stack.rs` (66 行)。名前に反してスタックではなくフラット `Vec`。doc が「スコープ毎 hashmap を離脱時にマージする bubble-up をやめ、走査後 1 パスの walk-up にした。離脱時の hashmap drain+insert が全部消える」と明記。`resolve_all_references()` は AST 再走査ではなく参照リスト 1 周。関数/アロー/catch の 3 箇所だけ早期解決が走る回避策とその理由 (仮引数と本体が同一スコープを共有している)                                                                                                                                                     |
| 45    | `early-errors`          | Semantic が担う early error 検査        | `checker/` (`javascript.rs` 1349 行 / `typescript.rs` 343 行)。doc コメントが仕様文言そのまま。`check_identifier` (`await`/`yield`/予約語の文脈)、`check_duplicate_class_elements`、`check_with_statement`、`check_number_literal` (legacy octal)、`__proto__` 重複。`with_check_syntax_error` で任意 (`new()` は false、`new_linter()` は true)。副作用として有効化すると class table も強制構築される。診断生成関数が全部 `#[cold]` である理由                                                                                                               |

### 群 6: 木を歩く — traverse (order 50-51)

| order | slug                   | タイトル                          | 中身 / 主な参照                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----- | ---------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 50    | `traverse-vs-visitmut` | Traverse — 書き換えながら親を見る | 34 の非対称性を受けて、`Traverse` の `enter_*`/`exit_*` が `(&mut Node, &mut TraverseCtx)` を取れる仕組み。下降中は参照を作らず生ポインタだけ持つ。親の**全体**ではなく自分が来た枝を除いた**他の枝だけ**を見せるので、`Ancestor` は `BinaryExpressionLeft` / `BinaryExpressionRight` のように来た子まで判別子に埋めた巨大 enum (`generated/ancestor.rs` は 592KB)。`Ancestor::BinaryExpressionRight(r)` から `r.right()` はコンパイルエラーになる                                                   |
| 51    | `traverse-ctx`         | TraverseCtx — 祖先・スコープ・UID | `NonEmptyStack<Ancestor<'a,'static>>` (初期容量 64) と `parent()` の `transmute` によるライフタイム縮小。スコープ操作 (`create_child_scope_of_current`、`insert_scope_below_statement`、`remove_scope_for_expression`)。`generate_uid` / `generate_binding` (Babel の `scope.generateUid` 準拠で `_foo`, `_foo2`…)。参照操作 (`create_bound_reference`, `delete_reference`)。`Traverse` は ast_tools 生成物で、`oxc_traverse` と `oxc_minifier/src/generated/` に**同じ生成器から 2 組**吐かれている |

### 群 7: 木を検査する — Linter (order 60-66)

| order | slug                     | タイトル                                       | 中身 / 主な参照                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----- | ------------------------ | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 60    | `rule-trait`             | Rule トレイト — 必須メソッドがゼロ             | `rule.rs:19-76`。境界は `Sized + Default + Debug`、全メソッドがデフォルト実装付き。`from_configuration` / `to_configuration` / `run` / `run_once` / `run_on_jest_node` / `should_run`。`declare_oxc_lint!` (`oxc_macros/src/declare_oxc_lint.rs`) は doc コメントとメタ情報から `impl RuleMeta` だけを生成し、ロジックには触らない                                                                                                                                                                                                                                                                                                  |
| 61    | `rule-dispatch`          | ルールの登録とディスパッチ表の生成             | `rules.rs` は `mod` 宣言だけの手書き。`tasks/linter_codegen` (`cargo lintgen`) が `generated/rules_enum.rs` (1.5MB / 23,244 行、870 ルール) と `rule_runner_impls.rs` を生成する。圧巻なのは生成方法で、`match_detector.rs` / `if_else_detector.rs` / `let_else_detector.rs` / `early_diverge_detector.rs` が**各ルールの `run` を `syn` で静的解析して触る `AstType` を推論**し `NODE_TYPES: AstTypesBitset` を作る。`lib.rs` の `execute_rules` がこれで AST 型ごとにバケツ分けして 1 パス dispatch する。推論が外れる保険として debug build では最適化あり/なし両方でルールを走らせ、診断が食い違ったら再生成を促して panic する |
| 62    | `reading-no-unused-vars` | ルールを読む — no-unused-vars                  | `rules/eslint/no_unused_vars/` (テスト込み 10,131 行、単一ルール最大級)。`mod.rs` / `usage.rs` / `options.rs` / `ignored.rs` / `allowed.rs` / `symbol.rs` / `fixers/`。実装しているのは `from_configuration` / `run_once` / `should_run` だけで、`run_once` が `ctx.scoping().symbol_ids()` を全走査する。使っている Semantic API を列挙 (`symbol_is_unused`, `get_resolved_references`, `symbol_redeclarations`, `scope_ancestors`, `symbol_declaration`) して、群 5 が何のためにあったかを回収する。`ctx.module_record()` による export 判定                                                                                      |
| 63    | `diagnostics`            | 診断の設計                                     | `oxc_diagnostics`。`OxcDiagnostic` のラベルと help、`#[cold]` な生成関数、miette 互換の出力。パーサ・semantic・linter が同じ型を共有していること                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 64    | `auto-fix`               | auto fix — 重なったら諦める                    | `fixer/`。`Fix { content: Cow<str>, span: Span }` (挿入は空 span、削除は空文字列)、`RuleFix { kind: FixKind, message, fix: CompositeFix }`、`CompositeFix::merge_fixes` は span 昇順にソートし重なれば `MergeFixesError`。`Fixer::fix()` は `last_pos >= start` を衝突とみなしてスキップし、スキップ分は診断として残す (境界接触も ESLint 同様に衝突扱い)。**マルチパスはない** — 呼び出しは `service/runtime.rs` と `tsgolint.rs` の 2 箇所だけで、ファイルごとに 1 回。debug build では fix 後を再パースして `debug_assert!`                                                                                                      |
| 65    | `disable-and-suppress`   | 無視の 2 段構え — ディレクティブと抑制ファイル | `disable_directives.rs` (約 2,100 行) はソース中の `eslint-disable` / `oxlint-disable` 系を `rust_lapper` のインターバル木で保持し `contains(rule_name, span)` で判定、未使用ディレクティブの回収と削除 fix まで行う。`suppression/` は `oxlint-suppressions.json` にルール別カウントのベースラインを持ち、`DiffManager` が増えた分だけ報告する (`--suppress-all` / `--prune-suppressions`)。「個別無視」と「既存コードベースへの段階導入」という別の問題を別の道具で解く                                                                                                                                                           |
| 66    | `parallel-lint`          | 並列実行 — rayon とモジュールグラフ            | `service/runtime.rs`。`ThreadPoolBuilder::build_global()` でスレッド数を固定し `rayon::current_num_threads()` 分の `AllocatorPool` (31 と接続)。`rayon::scope` で各ファイルのパース/semantic を `spawn` し、結果を `mpsc::channel` でグラフスレッド 1 本に集約する — モジュールグラフを触るのが 1 本だけなのでロックが要らない。そのグラフスレッドは `try_recv()` が空なら `rayon::yield_now()` して自分も lint を手伝う。共有状態は `papaya` のロックフリー並行ハッシュマップ。`lint_runner.rs` の `DirectivesStore` は並列化ではなく 2 エンジン間で disable ディレクティブを共有する役                                            |

### 群 8: 同じ AST を誰がどう使うか (order 70-73)

| order | slug                   | タイトル                                | 中身 / 主な参照                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----- | ---------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 70    | `transformer`          | Transformer — AST を書き換える          | `oxc_transformer`。Semantic 必須、Traverse で破壊的に mutate し、`build_with_scoping(scoping, program)` が更新済み `Scoping` を返す。書き換えながらスコープ情報を保守する難しさと、その防衛線 `tasks/transform_checker` (transform 後の AST から semantic を再構築して差分を取る)                                                                                                                                                                 |
| 71    | `codegen`              | Codegen — AST を文字列に戻す            | `oxc_codegen`。**AST を読むだけ** (`&Program`)。`oxc_semantic` 依存は `with_scoping(Option<Scoping>)` で mangle 済み名を引くためだけで、Scoping なしでも動く。source map、コメント保存                                                                                                                                                                                                                                                            |
| 72    | `minifier-and-mangler` | Minifier と Mangler — 小さくする        | `oxc_minifier` は Semantic + Traverse + Mangler を内部で回し、`MinifierReturn.iterations` があるとおり**収束まで多パス**。対する `oxc_mangler` は Semantic 必須だが **AST を一切変更せず** `Scoping` の名前だけ書き換え、codegen が読んで初めて短縮名が出力に現れる。この分業が 71 の設計と噛み合っている                                                                                                                                         |
| 73    | `formatter-and-lsp`    | Formatter と language_server — 別の要求 | `oxc_formatter` は CST ではなく通常の AST + `program.comments` + 原文で動き、Traverse を使わず独自の親リンク付き `AstNode<'a, T>` で辿る。防衛線は `detect_code_removal` feature (整形後を再パースしてノード数を diff)。`oxc_language_server` は *_oxc__ クレートへの依存がゼロ**の汎用 LSP シェル (`tower-lsp-server` + `tokio` + `papaya`) で、実装は `Tool` / `ToolBuilder` trait 越しに `apps/oxlint/src/lsp/server_linter.rs` から注入される |

## 確認済みの要点 (名前から想像がつかないもの)

1. **レキサは 2 つあり、新しい方はまだ本番経路に載っていない。** `oxc_lexer` (`publish = false`) はパーサから呼ばれず、`oxc_parser` の Cargo.toml に依存もない。`tasks/coverage/src/lexer_diff.rs` が既存レキサを oracle にした差分検証をしているだけ。`Kind` (parser) と `TokenKind` (oxc_lexer) は別の型。「oxc のレキサ」と書くときはどちらの話か必ず明示する
2. **リンタのディスパッチ表はルールのソースを `syn` で静的解析して作られる。** 推論が外れても debug build の二重実行で捕まる (61)
3. **JS プラグインと型情報ルールはどちらも Rust の外に出ている。** JS プラグインは raw transfer で AST バッファを共有し、`apps/oxlint/src-js/generated/` の JS 側デシリアライザ + walker (計 10,326 行、これも ast_tools 生成物) が JSON なしで走査する。`oxlint-plugin-eslint` という npm パッケージを生成・公開して ESLint 本体の JS ルールをそのまま動かせる。型を見るルールは `tsgolint.rs` (64KB) が **Go 製の外部 `tsgolint` 実行ファイルをプロセス起動**して stdin/stdout でやり取りする
4. **メモリ挙動が CI のスナップショットテストになっている。** `tasks/track_memory_allocations/` が段階別に「システムアロケーション回数・バイト数・ピーク・アリーナ割り当て回数」を YAML に固定。TypeScript の 2.92MB `checker.ts` をパースするシステムアロケーションは 19 回、semantic は arena allocs 0 / sys allocs 46 (シンボルテーブルはアリーナではなくシステムヒープで、`Stats` により事前に正確なサイズを確保済み)
5. **コード生成がクレート境界も言語境界も越えている。** ast_tools の出力先には `npm/oxc-types/types.d.ts` や CI の paths-filter YAML まで含まれ、`Traverse` は `oxc_traverse` と `oxc_minifier` に同じ生成器から 2 組吐かれる。「生成物 = `oxc_ast/src/generated/`」という前提で書くと外れる
6. **`ARCHITECTURE.md` は現状とずれている。** 「Future Considerations」に挙がっている Formatter / Type Checker / Plugin System はいずれも実装済み。MSRV 表記も本文 (1.86.0) と `Cargo.toml` (1.96.0) で食い違う。1 で ARCHITECTURE.md を紹介する際は注記する

## 存在しないもの (書き間違えやすい)

- `crates/oxc_lexer/src/js/` — ない。数値は `pipeline/find.rs::scan_number` + `lanes.rs::parse_number`
- `SemanticBuilder::build_with_jsdoc` — 現 HEAD にはない (CHANGELOG のみ)
- `Rule::run_on_symbol` — ない。シンボル走査は `run_once` の中で自前に回す
- fixer のマルチパス適用 — ない。ESLint の「収束まで最大 10 回」に相当するループは存在しない
- transformer による `ModuleRecord` の利用 — 見つからず

## 未決事項

1. **ref の扱い。** ローカルの HEAD (`457ed57ff2`) はタグ `apps_v1.81.0` の 88 commits 後で、上記の事実確認はすべて HEAD に対して行った。ページを書くときはタグに合わせて読み直すか、ref を HEAD に変更するかを決める必要がある。タグとの間に上記の事実を覆す変更がないかは未確認
2. 群 7 に JS プラグイン + tsgolint の 1 ページを足すか。今は 3 の内容を 65・66 に分散して触れる想定だが、「Rust の外に出す」という判断自体が 1 ページに値する可能性がある。足すなら 40 ページ
3. 群 2 の 13 (SIMD レキサ) の分量。本番経路に載っていないものに 1 ページ割く判断。「使われていないコードから学べることがある」という立て方で書くなら価値がある
4. 群 1 の 4 (通し例) を独立ページにするか、概要に畳むか。畳むと 38 ページ

## 作業手順の目安

1. `src/content/docs/oss/sample/` を複製して `index.md` を書く (対象外・読む順番・「この OSS について」)。通し例のスニペットをここで確定させる
2. 群 4 (木の設計) を先に書く。他の群のほぼ全ページがアリーナと生成物を前提にする
3. 群 5 (Semantic) → 群 7 (Linter)。62 まで書いて初めて群 5 の各ページに何が必要だったか分かるので、群 5 は 62 を書いた後に見直す
4. 群 2 → 群 3。群 1 は最後に、群 2-7 で実際に必要だった前提だけを残す形で書く (先に書くと薄くなる)
5. 群 6 → 群 8
6. mermaid は 4 (全体像: flowchart)、10 (byte handler dispatch: flowchart)、24 (エラー回復の分岐: flowchart)、33 (ast_tools の生成関係: flowchart)、41 (2 パスの流れ: sequenceDiagram)、44 (bubble-up と walk-up の対比: flowchart)、50 (Ancestor が見せる範囲: flowchart)、61 (ルール dispatch の生成: flowchart)、66 (rayon + mpsc: sequenceDiagram) に入れる

## 執筆結果 (2026-09-06)

**概要 + 40 ページ 8 群を執筆完了。** mermaid 28 枚、全ページ学び型。

### 未決事項の決定

1. **ref はタグ `apps_v1.81.0` に固定した。** ソースは HEAD ではなくタグ時点を `git show apps_v1.81.0:<path>` で読み直して書いた。タグ〜HEAD の 277 ファイルの差分は大半が対象外の formatter 群 (`oxc_formatter_css` 56、`oxfmt` 40、`oxlint` 35) で、`oxc_allocator` / `oxc_semantic` / `oxc_span` / `oxc_traverse` は無変更
2. **群 7 に order 67 `outside-rust` を追加した** (JS プラグイン + tsgolint)。「Rust の外に出す」という判断自体を 1 ページにする価値があったため。結果 40 ページ
3. **群 2 の 13 (SIMD レキサ) は書いた。** 「新しい実装を既存実装を oracle にどう育てるか」を軸にすると、本番経路に載っていないことがむしろ主題になる
4. **群 1 の 4 (通し例) は独立ページのまま。** 概要にはスニペットと 1 段落だけ置き、段ごとの詳細は独立ページに寄せた

### 計画と実物の食い違い

タグ時点で確認した結果、計画の記述と違っていた点。

- **`Token` は構造体ではなく `u128` 1 本のビットパック。** `start`/`end`/`kind` + 4 つの bool がシフト量で配置され、各フィールドが自然なアライメントに乗ることを `const` assert で検証している。24 ビットが未使用
- **`AllocatorPool` は 3 ファイルに分割済み。** `pool/mod.rs` (enum ラッパ) / `pool/standard.rs` (`Mutex<Stack<Allocator>>`) / `pool/fixed_size.rs`。後者は Windows だけ `Condvar` を持ち `new` の実装自体が分かれる
- **`oxc_lexer` に `IS_SIMD` という公開定数はない。** SIMD 核は `#[cfg(all(target_arch = "x86_64", target_feature = "avx2", target_feature = "bmi2"))]` で切り替わり、それ以外では空のスタブになる。差分検証は `tasks/coverage` の `lexer` feature (オプショナル依存) で有効化する。`oxc_lexer` のバージョンは `0.139.0` で他の crate (`0.148.0`) とも違う
- **`rules_enum.rs` は 23,241 行 / 866 ルール** (計画は 23,244 行 / 870 ルール)
- **`Fixer::new(...).fix()` の呼び出しは 3 箇所。** `service/runtime.rs` / `tsgolint.rs` / `apps/oxlint/src/js_plugins/fix.rs` (計画は 2 箇所)
- **`#[cold]` が全部に付いているのは `oxc_semantic/src/diagnostics.rs` の 53 関数。** `checker/javascript.rs` の中の `#[cold]` は 4 個だけ
- **`checker/javascript.rs` は 1338 行** (計画は 1349 行)
- **`ancestor.rs` は 607KB、`ast_kind.rs` は 102KB** (計画は 592KB / 100KB)
- **`ARCHITECTURE.md` のずれは計画どおり。** Formatter / Type Checker / Plugin System が「Future Considerations」に残り、MSRV は本文 1.86.0 / `Cargo.toml` 1.96.0

### 検証

- `pnpm exec astro build` が通ることを確認
- 内部リンクは Python スクリプトで全解決を確認 (リンク切れ 0、孤立ページ 0)
- mermaid 28 枚を jsdom + `mermaid.parse` で検証 (失敗 0)。手順は memory の `mermaid-syntax-check` に従った

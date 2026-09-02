---
title: "test_runner — 何をどこでテストするか"
description: "Rust の単体テスト、決定的シミュレーション、Python の統合テスト、Postgres の pg_regress。4 層のテストがあり、それぞれ守備範囲が違う。統合テストは「箱の中の小さなクラウド」を毎回立ち上げる。"
group: "検証と運用"
sidebar:
  order: 58
---

## 何を学んだか

Neon のテストは 4 つの層に分かれている。

| 層                     | 場所                       | 何を確かめるか                              |
| ---------------------- | -------------------------- | ------------------------------------------- |
| Rust の単体テスト      | 各 crate の `#[cfg(test)]` | データ構造、アルゴリズム                    |
| 決定的シミュレーション | `safekeeper/tests/`        | 合意プロトコルの安全性 ([desim](../desim/)) |
| Python の統合テスト    | `test_runner/regress/`     | コンポーネント間の振る舞い                  |
| `pg_regress`           | `test_runner/sql_regress/` | Postgres としての互換性                     |

**最後のものが特徴的だ。** Postgres 本体の回帰テストスイートを、Neon の compute に対して走らせる。**「普通の Postgres として振る舞う」ことを、本家のテストで確かめる。**

## 箱の中の小さなクラウド

```markdown title="test_runner/README.md"
Every test needs a Neon Environment, or NeonEnv to operate in. A Neon Environment
is like a little cloud-in-a-box, and consists of a Pageserver, 0-N Safekeepers, and
compute Postgres nodes. The connections between them can be configured to use JWT
authentication tokens, and some other configuration options can be tweaked too.
```

([test_runner/README.md](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/test_runner/README.md))

**テストごとに全コンポーネントを起動する。** pageserver、safekeeper、compute、storage_controller。

```python
def test_foobar(neon_env_builder: NeonEnvBuilder):
    # Prescribe the environment.
    # We want to have 3 safekeeper nodes, and use JWT authentication in the
    # connections to the page server
    neon_env_builder.num_safekeepers = 3
    neon_env_builder.set_pageserver_auth(True)

    # Now create the environment. This initializes the repository, and starts
    # up the page server and the safekeepers
    env = neon_env_builder.init_start()
```

**builder で構成を宣言してから起動する。** safekeeper の台数、認証の有無、リモートストレージの種類。

これができるのは `control_plane/` (ローカル用の制御プレーン) があるからだ。本番の control plane は OSS ではないが、**テスト用の代替実装が本流のコードとして存在する** ([compute_hook](../compute-hook/))。

`neon_simple_env` という簡易版もある。**大半のテストは既定構成でいい**ので、そちらを使う。

## 後始末を仕組みで保証する

```markdown title="test_runner/README.md"
At the end of a test, all the nodes in the environment are automatically stopped, so you
don't need to worry about cleaning up. Logs and test data are preserved for the analysis,
in a directory under `../test_output/<testname>`
```

**プロセスは自動で止まり、ログとデータは残る。** pytest のフィクスチャが teardown を持っている。

**「止める」は自動、「消す」はしない。** 失敗したテストの調査には、そのときの状態が全部要る。ディスク容量と引き換えに、再現不能な失敗を減らしている。

## バージョンの組み合わせをテストする

```markdown title="test_runner/README.md"
All the test which rely on NeonEnvBuilder, can check the various version combinations of the components.
To do this yuo may want to add the parametrize decorator with the function fixtures.utils.allpairs_versions()
```

```python
@pytest.mark.parametrize(**fixtures.utils.allpairs_versions())
def test_something(
```

**コンポーネントのバージョンを混ぜてテストする。**

デプロイは全部同時には行われない。pageserver が新しく safekeeper が古い期間、その逆の期間がある。**「新旧が混在した状態」が正常系**として扱われている。

`allpairs` は組み合わせテストの手法で、**全組み合わせ (指数的) ではなく、任意の 2 つのペアが少なくとも 1 回現れる組み合わせ**を選ぶ。**バグの大半は 2 つの要因の相互作用で出る**という経験則に基づいている。

## failpoint — 特定の瞬間にエラーを起こす

コード中に、テストからしか発火しない注入点が埋め込まれている。

```rust title="pageserver/src/tenant.rs"
        fail::fail_point!("attach-before-activate", |_| {
```

```rust title="pageserver/src/tenant.rs"
                pausable_failpoint!("before-timeline-auto-offload");
```

```rust title="pageserver/src/tenant.rs"
                pausable_failpoint!("timeline-creation-after-uninit");
```

([pageserver/src/tenant.rs L1929](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pageserver/src/tenant.rs#L1929))

**名前が付いていて、HTTP API から有効化できる。** テストは「timeline を作る途中でクラッシュさせる」といったシナリオを、正確な位置で起こせる。

2 種類ある。

- `fail_point!` — その場でエラーを返す、または panic する
- `pausable_failpoint!` — **そこで止まる。** テストが別の操作を挟んでから解放する

後者が競合状態のテストに要る。「A の処理が B の途中で走ったら」を再現するには、B を止めておく必要がある。

[reconciler](../reconciler/) のライブマイグレーションにも、段階ごとに failpoint が置かれていた。

```rust
        pausable_failpoint!("reconciler-live-migrate-pre-generation-inc");
        pausable_failpoint!("reconciler-live-migrate-post-generation-inc");
        pausable_failpoint!("reconciler-live-migrate-pre-await-lsn");
        pausable_failpoint!("reconciler-live-migrate-post-notify");
        pausable_failpoint!("reconciler-live-migrate-post-detach");
```

**7 段の手順の各段の間で止められる。** 「どの段で落ちても安全」を、実際に落として確かめられる。

これらは `--features testing` でのみ有効になる。

```markdown title="test_runner/README.md"
      To run tests you need to add `--features testing` to Rust code build commands.
      For convenience, repository cargo config contains `build_testing` alias
```

**本番バイナリには入らない。** ただしテストは本番と違うバイナリを走らせることになる、というトレードオフを受け入れている。

## テストの分類

```markdown title="test_runner/README.md"
Regression tests are in the 'regress' directory. They can be run in
parallel to minimize total runtime.

'pg_clients' contains tests for connecting with various client
libraries. Each client test uses a Dockerfile that pulls an image that
contains the client, and connects to PostgreSQL with it.

'performance' contains performance regression tests. (中略) They should be run serially, to avoid the tests
interfering with the performance of each other.
```

**並列に走らせてよいものと、いけないものが分けてある。**

回帰テストは各自が自分の環境を立てるので並列でよい。性能テストは互いに干渉するので直列。**「並列実行可能か」がディレクトリの分割基準になっている。**

`pg_clients` が面白い。**各クライアントライブラリの Docker イメージを引いてきて、実際に接続する。** node-postgres、psycopg2、JDBC、Go の pgx。

Neon は wire protocol を自前で実装している場所がある ([pqproto](../pqproto/))。**仕様に準拠していても、実装が受け付けるとは限らない。** 実物のクライアントで確かめるしかない。

`cloud_regress` と `logical_repl` と `random_ops` もある。**本番環境に対して走らせるテスト**、論理レプリケーションのテスト、ランダムな操作列のテスト。

## 型ヒントを求める

```markdown title="test_runner/README.md"
- Adding more type hints to your code to avoid `Any`, especially:
  - For fixture parameters, they are not automatically deduced.
  - For function arguments and return values.
```

`docs/sourcetree.md` には `mypy` が必須チェックだと書かれている。

> We force code formatting via `ruff`, and type hints via `mypy`.

**150 個以上のテストファイルがある Python のコードベース**で、型検査を必須にしている。フィクスチャの型が推論されないという注意も具体的だ。

そして警告がある。

```markdown title="docs/sourcetree.md"
**WARNING**: do not run `mypy` from a directory other than the root of the repository.
Otherwise it will not find its configuration.
```

**設定ファイルの探索がディレクトリ依存で、間違えると黙って別の設定で動く。** ツールの落とし穴を、ドキュメントで塞いでいる。

## ドキュメントに何を書くか

```markdown title="test_runner/README.md"
- Writing a couple of docstrings to clarify the reasoning behind a new test.
```

**「なぜこのテストがあるのか」を書け。**

テストコードは「何をするか」は読めば分かる。分からないのは「なぜこれを確かめる必要があるのか」で、それは過去の障害やバグに紐づいていることが多い。

## この先に効いてくること

- **層ごとに守備範囲を分ける。** 単体、シミュレーション、統合、互換性。
- **テスト用の制御プレーン実装を本流のコードとして持つ。**
- **新旧バージョンの混在を正常系としてテストする。** ペアワイズで組み合わせを絞る。
- **failpoint に名前を付け、止められるようにする。** 競合状態を正確に再現する。
- **並列実行可能かをディレクトリの分割基準にする。**
- **仕様準拠と実クライアントの受け入れは別。** 実物で確かめる。

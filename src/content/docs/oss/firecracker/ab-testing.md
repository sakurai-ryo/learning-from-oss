---
title: "性能テストを、絶対値ではなく A/B で回す"
description: "Firecracker が「絶対的な閾値をリポジトリに維持しない」ためにどんな仕組みを持っているかを読む。tests/framework/ab_test.py が 2 リビジョンを一時 clone して出力を比較する構造、tools/ab_test.py が permutation test で性能回帰を判定する 3 段の閾値、そして SPECIFICATION.md の数値のうち何が hard assert され何が A/B と nonci に回されているか。"
group: "正しさをどう担保するか"
sidebar:
  order: 62
---

## 何を学んだか

### 「今の値」ではなく「変化したか」を見る

CI で性能や依存関係の健全性を検査しようとすると、たいてい最初に閾値をリポジトリに書き込むことになる。「起動時間は 125 ms 以内」「脆弱性のある依存は 0 個」。これは 2 つの理由で維持コストが高い。閾値そのもののメンテナンスが要ることと、自分たちの変更と無関係な外部要因で値が動くことだ。

Firecracker はこれに対して、絶対値を捨てて **PR の前後で変わっていないこと**を検査する方式を持っている。[`tests/framework/ab_test.py`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/tests/framework/ab_test.py) の冒頭がその定義である。

> A/B-Tests are style of tests where we do not care what state a test is in, but only that this state does not change across a pull request. This is useful if
>
> 1. Validating the state requires some baseline to be persisted in the repository, and maintaining this baseline adds significant operational burden (for example, performance tests), or
> 2. The state can change due to outside factors (e.g. Hardware changes), and such external changes would block all pull requests until they are resolved.

「テストがどんな状態にあるかは気にしない。その状態が PR をまたいで変わらないことだけを気にする」。判定基準を絶対値から差分に移す、という一手である。

### 実体は 2 つある

同じ「A/B」という言葉で、リポジトリには目的の違う 2 つの仕組みが入っている。

|              | `tests/framework/ab_test.py`             | `tools/ab_test.py`                           |
| ------------ | ---------------------------------------- | -------------------------------------------- |
| 呼ばれ方     | pytest のテスト内から関数として          | Buildkite が叩く独立スクリプト               |
| A 側の作り方 | 一時ディレクトリに `git clone`           | 事前ビルド済みバイナリのディレクトリを指定   |
| 比較の中身   | コマンド出力の集合比較（既定は完全一致） | `metrics.json` の数値列を permutation test   |
| 主な用途     | `cargo deny` の脆弱性リスト              | 起動遅延・スループット・スナップショット時間 |

前者は「出力が変わっていないか」、後者は「分布が有意に変わっていないか」を見る。どちらも「絶対値の閾値をリポジトリに置かない」という同じ動機から出ている。

### SPECIFICATION.md の数値は一律に hard assert されてはいない

[`SPECIFICATION.md`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/SPECIFICATION.md) は「These specifications are enforced by integration tests (that run for each PR and main branch merge).」と書いている。ただし実際に `tests/` を読むと、強制のされ方は数値ごとに違う。

| 数値目標                                         | 実際の扱い                                                                  |
| ------------------------------------------------ | --------------------------------------------------------------------------- |
| VMM のメモリオーバーヘッド `<= 5 MiB`            | **常時 hard assert**。全 microVM に memory cop スレッドが付き、超えたら例外 |
| InstanceStart から `/sbin/init` まで `<= 125 ms` | 閾値アサートは無い。`@pytest.mark.nonci` の性能テストがメトリクスを送るだけ |
| API ソケット到達まで `8 CPU ms`                  | 同上（ブート時間メトリクスの一部として送出）                                |
| ネットワーク・ストレージのスループット各種       | SPECIFICATION.md 自身が `[integration test pending]` と注記                 |

つまり「メモリオーバーヘッドだけが契約として毎回検査され、時間系はメトリクスと A/B に委ねられている」というのが実際の姿だ。[`../specification-as-contract/`](../specification-as-contract/) で見た「仕様を数値で公開する」という約束は、検査手段のレベルではこう分解されている。

## ソースコードのどこか

### `git_ab_test` — 2 リビジョンを一時 clone して同じランナーを走らせる

中核は 40 行ほどの関数である。

```python title="tests/framework/ab_test.py"
    with TemporaryDirectory() as tmp_dir:
        dir_a = git_clone(Path(tmp_dir) / a_revision, a_revision)
        result_a = test_runner(dir_a, True)

        if b_revision:
            dir_b = git_clone(Path(tmp_dir) / b_revision, b_revision)
        else:
            # By default, pytest execution happens inside the `tests` subdirectory. Pass the repository root, as
            # documented.
            dir_b = Path.cwd().parent
        result_b = test_runner(dir_b, False)

        comparison = comparator(result_a, result_b)
        return result_a, result_b, comparison
```

[`tests/framework/ab_test.py#L52-L94`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/tests/framework/ab_test.py#L52-L94)

`test_runner` は「作業ディレクトリのパス」と「これは A 側か」の 2 引数を受け取る呼び出し可能オブジェクトで、同じものが両リビジョンに対して走る。B 側は既定で現在のチェックアウトをそのまま使うので、clone は 1 回で済む。A 側の既定リビジョン `DEFAULT_A_REVISION` は Buildkite が渡す PR のターゲットブランチ、ローカルでは `main` である。

clone はネットワークを使わない。`git_clone` はローカルの git ルート（`git rev-parse --show-toplevel`）から clone し、デタッチド HEAD を直接チェックアウトできないので一時ブランチ `tmp-<commitish>` を作ってから消す（[`tests/framework/ab_test.py#L148-L168`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/tests/framework/ab_test.py#L148-L168)）。`@with_filelock` が付いているのは、pytest-xdist で並列実行したときに同じ clone を複数ワーカーが同時に作らないようにするためだ。

なお、`git_ab_test` 自身は「実行順序を保証しない」と docstring に明記している（"Note that there are no guarantees on the order in which the two tests are run."）。順序に依存する比較を書いてはいけない、という契約である。

### `cargo audit` を PR のブロッカーにしない使い方

docstring は用途を 1 つ具体的に挙げていて、これが設計の意図をいちばん端的に示す。

> Consider for example a `cargo audit` tests, which is used to reject usage of dependency versinos that have known security vulnerabilities, or which have been yanked. The "state" here is "list of vulnerable dependencies". Clearly, this can change due to external action (a new vulnerability is discovered and published to RustSec). At this point, every PR would fail until this dependency is removed, blocking all development. Simply removing the test from PR CI is not an option, since we want to avoid the scenario where a PR adds a dependency with a known vulnerability (e.g. the PR itself changes the "list of vulnerable dependencies"). A/B-Testing allows us to not block PRs on the former case, while still preventing the latter.

新しい脆弱性が RustSec に公開された瞬間、絶対値ベースの検査だと全 PR が落ちる。しかしテストを外すと、PR 自身が脆弱な依存を追加するケースを見逃す。A/B ならこの 2 つを分離できる。実装は `test_sec_audit.py` にある。

```python title="tests/integration_tests/security/test_sec_audit.py"
    git_ab_test_host_command_if_pr(
        f"RUSTUP_LOG=warn cargo deny --manifest-path {toml_file} -f json check advisories",
        comparator=set_did_not_grow_comparator(set_of_vulnerabilities),
    )
```

[`tests/integration_tests/security/test_sec_audit.py#L52-L59`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/tests/integration_tests/security/test_sec_audit.py#L52-L59)

比較器は完全一致ではなく「増えていないこと」である。`set_did_not_grow_comparator` はコマンド出力を集合に変換し、「B の集合が A の集合の部分集合であること」を判定する（[`tests/framework/ab_test.py#L137-L145`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/tests/framework/ab_test.py#L137-L145)）。集合の作り方も雑ではなく、`(code, advisory_id, crate)` の 3 つ組で 1 件の指摘を同定している。文字列の完全一致だとメッセージの表現が変わるだけで落ちるので、比較可能な粒度まで正規化してから集合にしているわけだ。

`_if_pr` という接尾辞にも意味がある。`global_props.buildkite_pr` が真、つまり PR コンテキストのときだけ A/B を行い、それ以外（main へのマージ後など）では `utils.run_cmd(command, check=check_in_nonpr, ...)` で単に実行して終了コードを見る（[`tests/framework/ab_test.py#L97-L114`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/tests/framework/ab_test.py#L97-L114)）。「PR は止めない、しかし main では絶対値で落とす」という二段構えになっている。docstring もこれを「with us being alerted to this situtation via a special pipeline that does not block PRs」と説明していて、非ブロッキングのパイプラインが実際に `.buildkite/pipeline_pr_no_block.py` として存在する（`-m no_block_pr` でマークされたテストだけを回す）。

### `tools/ab_test.py` — permutation test による性能回帰判定

性能側は別のスクリプトになる。2 つのリビジョンでビルドしたバイナリを `--binaries-a` / `--binaries-b` で受け取り、同じ pytest を両方で走らせて `metrics.json` を集め、統計的に比較する。

判定は U 検定ではなく **permutation test**（並べ替え検定）である。

```python title="tools/ab_test.py"
    return scipy.stats.permutation_test(
        (a_samples, b_samples),
        # Compute the difference of means, such that a positive different indicates potential for regression.
        lambda x, y, axis: numpy.mean(y, axis=axis) - numpy.mean(x, axis=axis),
        n_resamples=n_resamples,
    )
```

[`tools/ab_test.py#L235-L257`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/tools/ab_test.py#L235-L257)

docstring が手法をそのまま説明している。2 つの標本群を混ぜてランダムに分け直す操作を 9999 回繰り返し、そのたびに統計量（平均の差）を計算する。もし性能が変わっていないなら、元の分け方の統計量は並べ替えた分布の「真ん中あたり」に来るはずで、端に来る度合いが p 値になる。分布の形を仮定しない（ノンパラメトリック）のが利点で、レイテンシのように裾の重い分布に向く。

判定は p 値だけでは行わず、3 つの閾値を重ねる。

```python title="tools/ab_test.py"
    p_thresh = Threshold.from_args(args.significance, 0.01)
    strength_abs_thresh = Threshold.from_args(args.absolute_strength, 0.0)
    noise_threshold = Threshold.from_args(args.noise_threshold, 0.05)
```

[`tools/ab_test.py#L563-L565`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/tools/ab_test.py#L563-L565)

- `significance`（既定 0.01）— p 値がこれ未満なら有意
- `absolute-strength`（既定 0.0）— 平均差の絶対値がこれを超えなければ無視。「5 ms のポーリング周期より小さい変化は意味がない」といった単位付きの下限を置く
- `noise-threshold`（既定 0.05）— 同じメトリクスを別パラメータで測った結果を平均し、相対変化が 5% を超えていなければ却下

3 つ目が独特で、`analyze_data` の中に長い正当化コメントが付いている。同じメトリクス（たとえば `restore_latency`）を vCPU 数などのパラメータを変えて複数回測ったとき、真の性能変化なら全シナリオが同じ方向に動くはずで、片方が改善・片方が劣化なら打ち消し合ってノイズと見なせる、という考え方である。根拠として 2 点が挙げられている。

> 1. Historically, a true performance change has never shown up in just a single test, it always showed up across most (if not all) tests for a specific metric.
> 2. Analyzing data collected from historical runs shows that across different parameterizations of the same metric, the collected samples approximately follow mean / variance = const, with the constant independent of the parameterization.

そのうえで中心極限定理から「相対変化の平均は帰無仮説の下で期待値 0 の正規分布に従う」ことを導き、偽陽性に対する追加のふるいにしている。

さらに、有意差が出ても即座には落とさない。`ab_performance_test` は `for i in range(max_iterations)` のループで、反復ごとに A と B の実行順を入れ替えながらデータを蓄積する（[`tools/ab_test.py#L428-L477`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/tools/ab_test.py#L428-L477)）。コメントは「Changing the order or A and B executions across iterations, to avoid fluctuations caused by execution order」。回帰が検出されたら標本を追加して再判定する（既定 4 回、メモリホットプラグのように揺れの大きいテストは 30 回）。ノイズ由来の偽陽性を標本数で潰し、実行順の入れ替えで「先に走ったほうが有利／不利になる」系統誤差を平均化する設計だ。

それでも扱いきれないものは明示的に除外リストに入る。

```python title="tools/ab_test.py"
# Performance tests that we don't want to alarm on.
IGNORED = [
    # block latencies if guest uses async request submission
    {"fio_engine": "libaio", "metric": "clat_read"},
    # ...
    # boot time metrics
    {"performance_test": "test_boottime", "metric": "resume_time"},
```

[`tools/ab_test.py#L120-L136`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/tools/ab_test.py#L120-L136)

### パイプライン側の配線

`.buildkite/pipeline_perf.py` は、環境変数 `REVISION_A` / `REVISION_B` の有無で 2 つのモードを切り替える。両方が設定されていれば `--ab` を付けて `tools/ab_test.py run` を呼び、なければ単にその時点のコミットで性能テストを回す。

```python title=".buildkite/pipeline_perf.py"
    if REVISION_A:
        devtool_opts += " --ab"
        test_script_opts = f'{ab_opts} run --binaries-a build/{REVISION_A}/ --binaries-b build/{REVISION_B} --max-iterations={max_iterations} --pytest-opts "{test_selector}"'
```

[`.buildkite/pipeline_perf.py#L140-L160`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/.buildkite/pipeline_perf.py#L140-L160)

閾値の上書きはテスト定義側にリテラルで書かれ、理由がコメントで添えられる。メモリホットプラグの項は `"ab_opts": "--absolute-strength 0.005 --noise-threshold hotunplug_total_time=0.1"` で、コメントは「The test require polling (5 ms), so any change smaller than that is not significant.」。

A/B モードで走るときは `-m ''` が渡され、`nonci` マーカーの付いたテストも収集される。通常の PR では `tests/pytest.ini` の `addopts` に `-m 'not nonci and not no_block_pr'` があるため、これらは走らない。

### memory cop だけは絶対値で常時強制されている

対照的に、メモリオーバーヘッドは A/B ではなく絶対値のアサートで守られている。`Microvm` の生成時に既定でモニタスレッドが付く。

```python title="tests/framework/microvm.py"
        self.monitors = []
        self.memory_monitor = None
        if monitor_memory:
            self.memory_monitor = MemoryMonitor(self)
            self.monitors.append(self.memory_monitor)
```

[`tests/framework/microvm.py#L261-L265`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/tests/framework/microvm.py#L261-L265)

`monitor_memory: bool = True` が既定なので、明示的に切っていないすべての microVM（性能テストや大きなゲストを使うテストは切っている）で監視が走る。閾値は SPECIFICATION.md の 5 MiB がそのままコードに入っていて、`threshold_booted=5 << 20` / `threshold_snapshot=7 << 20` / `threshold_restored=5 << 20`、サンプリング周期は `period_s=0.01`（[`tests/host_tools/memory.py#L46-L53`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/tests/host_tools/memory.py#L46-L53)）。10 ms ごとに `/proc/<pid>/smaps` 相当を読み、ゲストメモリ領域をサイズで判別して除外し、残りの RSS 合計が閾値を超えたら記録して停止する。VM の終了時に `check_samples()` が呼ばれ、超過していれば `MemoryUsageExceededError` を投げる。スナップショット作成中だけ 7 MiB に緩める、という状態依存の閾値まで持っている。

### 起動時間には閾値アサートが無い

一方、`test_boottime.py` の性能テストは `@pytest.mark.nonci` が付いていて、通常の PR では収集すらされない。中身を見ても 125 ms との比較は無く、`metrics.put_metric("guest_boot_time", boot_time_us, unit="Microseconds")` のように計測値を送っているだけである（[`tests/integration_tests/performance/test_boottime.py#L162-L200`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/tests/integration_tests/performance/test_boottime.py#L162-L200)）。

同じファイルの `test_boot_timer` は `nonci` が付いておらず PR で走るが、こちらは「ブートタイマーデバイスが動作すること」を確認するだけで、時間の閾値は見ていない。`test_memory_overhead.py` も同様に `nonci` で、メトリクス送出のみ（メモリのほうは memory cop が別途常時見ているので、こちらは傾向の記録が役割になる）。

## なぜそうなっているか

### 絶対値の閾値は、外部要因の変化を全部自分の問題にしてしまう

`ab_test.py` の docstring が挙げる 2 つの条件——ベースラインの維持コストと外部要因——は、どちらも「テストが失敗したとき、原因が自分の変更にあるとは限らない」という状況を指している。

`cargo audit` の例が分かりやすい。RustSec に新しい advisory が載った瞬間、全 PR が赤くなる。原因は誰の PR にもない。しかしテストを外せば、脆弱な依存を追加する PR も通ってしまう。差分で見れば、外から降ってきた指摘は A 側にも B 側にも現れるので比較で消え、PR が追加した指摘だけが残る。

性能側も構造は同じである。SPECIFICATION.md 自身が起動時間について、こう注記している。

> _Note_: The wall-clock time has a large standard deviation, spanning `6 ms to 60 ms`, with typical durations around `12 ms`.

標準偏差が典型値の数倍あるものに固定閾値を置けば、閾値は「実測の最悪値 + 余裕」になる。そうなると小さな回帰は検出できず、閾値としては機能しない。分布そのものを比較する permutation test に移したのは、この性質への対応と読める。

### 「有意」だけでは足りないので、閾値を 3 重にしている

統計的に有意でも意味のない変化はある。標本を増やせば 0.1% の差でも p 値は下がる。だから `absolute-strength` で「単位付きの下限」を、`noise-threshold` で「相対変化の下限」を重ねている。メモリホットプラグのコメント「The test require polling (5 ms), so any change smaller than that is not significant.」は、測定機構の分解能を閾値にした例である。

さらに `max_iterations` によるリトライは、性能テストの CI における現実的な要求への回答になっている。落ちたときにその場で標本を足して再判定するので、真の回帰なら回数を重ねても消えず、ノイズなら消える。偽陽性を減らしながら真陽性を落とさない。コストは実行時間だが、これは「疑わしいときだけ」払う。

### memory cop が絶対値なのは、それが回帰検出ではなく契約だから

なぜメモリだけ扱いが違うのか。ドキュメント上の明示的な説明は見当たらないが、性質の違いは指摘できる（以下は推測を含む）。

メモリオーバーヘッドは、時間と違って**ホストの負荷にほとんど依存しない**。`test_memory_overhead.py` の docstring も「We take a single measurement as it only varies by a few KiB each run.」と書いていて、実測のばらつきが小さいことが前提になっている。ばらつきが小さいなら、絶対値の閾値が実際に機能する。

そしてこの数値は Firecracker の売り文句そのものでもある。「1 台あたり 5 MiB」は密度の話であり、これが崩れると製品の前提が崩れる（[`../minimalism-charter/`](../minimalism-charter/)）。A/B は「前より悪くなっていないか」しか見ないので、少しずつ悪化して 5 MiB を超えても検出できない。絶対値で守る意味がある。

逆に起動時間は、ホストの CPU 周波数・NUMA 配置・カーネルバージョンで簡単に数割動く。SPECIFICATION.md が測定条件を「M5D.metal（ハイパースレッディング無効）」と機種まで指定しているのは、そうしないと数値が意味を持たないからだ。CI のエージェントが常にその条件を満たす保証はない。だから絶対値ではなく、同一マシン上での A/B に落とす。

## どう活かすか

### 「絶対値か差分か」を、値のばらつきで決める

自分の CI に性能検査や依存関係検査を入れるとき、判断材料は 2 つで足りる。

1. **実行環境を変えたとき、値はどれくらい動くか。** 数 KiB しか動かないなら絶対値でよい。数割動くなら絶対値の閾値は「めったに落ちない緩い値」にしかならず、意味を持たない。
2. **値を動かせるのは自分たちだけか。** 外部のデータベース（advisory、ベースイメージ、依存の最新版）に依存するなら、絶対値は必ずいつか外部要因で落ちる。

Firecracker の内訳はこの 2 軸できれいに説明できる。メモリオーバーヘッド（ばらつき小・自分たち起因）は絶対値、起動時間（ばらつき大）は A/B、脆弱性リスト（外部起因）は A/B、である。

### 差分方式は「ゆっくりした劣化」を検出できない

A/B の弱点は明確で、1 回あたりの変化が閾値以下なら何回でも通る。100 回の PR がそれぞれ 1% ずつ遅くすれば、性能は 2.7 倍になるが A/B は一度も落ちない。

だから A/B だけにするのは危険で、少なくとも次のどちらかを併置する必要がある。

- 絶対値の上限を、緩くてもいいので置いておく（memory cop がこれに当たる）
- 時系列のメトリクスを外部に送り、ダッシュボードで長期の傾向を見る（`metrics.put_metric` がこれに当たる）

Firecracker は両方やっている。`nonci` の性能テストが CloudWatch 形式のメトリクスを吐き続けるのは、PR を止めるためではなく、この長期トレンドのためだ。「PR を止める仕組み」と「傾向を見る仕組み」を分けて、それぞれに適した判定を割り当てている。

### `_if_pr` と非ブロッキングパイプラインの組み合わせは移植しやすい

「PR では差分で見る、main では絶対値で見る、ただし main の失敗はマージをブロックしない別パイプラインで通知する」という三層は、実装が軽いわりに効く。

- PR: `git_ab_test_host_command_if_pr` — 増えていなければ通す
- main: 同じ関数の else 分岐 — 単に実行して終了コードを見る
- 非ブロッキング: `-m no_block_pr` のパイプライン — 落ちても止めないが通知は出る

pytest のマーカー 1 つと環境変数 1 つで実現されている。`pytest.ini` の `-m 'not nonci and not no_block_pr'` が既定の除外を担い、パイプラインごとに `-m` を上書きする。マーカーをテスト側に書いておけば、どのパイプラインで走るかがテストのソースを見るだけで分かる。

### 取り込むべきでない条件

- **測定基盤が用意できない場合。** `tools/ab_test.py` は「同一マシン上で 2 つのバイナリを交互に走らせる」ことが前提である。共有 CI ランナーで隣のジョブと CPU を取り合う環境では、A と B のどちらが不利になるかが実行ごとに変わり、順序の入れ替えでも吸収しきれない。Firecracker が `ag: 1` で専有ベアメタルを確保しているのは、この前提を成立させるためのコストである。それが払えないなら、性能の A/B は偽陽性の山になる。
- **標本が少ない場合。** permutation test は 9999 回の並べ替えを行うが、元の標本が数個しかなければ取りうる p 値が粗くなり、判定が離散的になる。`test_boottime` が同じ設定で 10 回起動し直しているのは標本を稼ぐためで、1 回の測定で A/B しようとしても意味がない。
- **比較対象が正規化できない場合。** `cargo deny` の例では、出力を `(code, advisory_id, crate)` の集合に落としてから比較していた。生の文字列を比較する A/B は、タイムスタンプやパスや順序が入っているだけで常に落ちる。差分方式を入れるなら、まず「何を同じと見なすか」を関数として書けるかを確かめるのが先になる。

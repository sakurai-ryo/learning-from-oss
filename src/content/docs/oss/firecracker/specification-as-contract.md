---
title: "起動 125 ms とオーバーヘッド 5 MiB を、テストで守る契約にする"
description: "SPECIFICATION.md に並ぶ数値は願望ではなく、統合テストが測っている契約である。メモリ 5 MiB は全機能テストに常駐する memory cop が 10 ms 周期でサンプルして落とす。起動 125 ms は boot timer 疑似デバイスで測って A/B 比較に回す。一方で「integration test pending」と書かれたままの項目も 5 つある。"
group: "Firecracker のかたち"
sidebar:
  order: 11
---

## 何を学んだか

### 70 行の仕様書に数値が並んでいる

`SPECIFICATION.md` はリポジトリのルートにある 70 行の文書で、Firecracker が利用者に対して約束する数値がそこに書かれている。冒頭がこう始まる。

> The specifications below quantify Firecracker's promise to enable minimal-overhead execution of container and serverless workloads. These specifications are enforced by integration tests (that run for each PR and main branch merge).

「これらの仕様は統合テストによって enforce される」と書いてある。数値目標を掲げるドキュメントは珍しくないが、その数値がテストに落ちているかどうかで意味が全く変わる。Firecracker の場合、どこまで本当にテストになっているかを実際に読むことができる。

主要な数値を並べるとこうなる（M5D.metal / M6G.metal 上、ホスト資源に余裕がある前提）。

| 項目                                             | 数値                                                    | 測定手段                                            |
| ------------------------------------------------ | ------------------------------------------------------- | --------------------------------------------------- |
| プロセス起動から API ソケットが立つまで          | 8 CPU ms                                                | `api_server.process_startup_time_cpu_us` メトリクス |
| InstanceStart からゲストの `/sbin/init` 開始まで | 125 ms                                                  | boot timer 疑似デバイス                             |
| VMM スレッドのメモリオーバーヘッド               | 5 MiB 以下                                              | memory cop（`tests/host_tools/memory.py`）          |
| ゲスト CPU の計算性能                            | ベアメタル比 95% 超                                     | **integration test pending**                        |
| ネットワークスループット                         | 14.5 Gbps（ホスト CPU コア 80% 以下）／ 25 Gbps（100%） | **integration test pending**                        |
| 仮想化層が足すレイテンシ                         | 平均 0.06 ms                                            | **integration test pending**                        |
| ストレージスループット                           | 1 GiB/s（ホスト CPU コア 70% 以下）                     | **integration test pending**                        |

`[integration test pending]` と明記された項目が 5 箇所ある。「全部テストで守っています」と言い切らず、守れていないものにその旨を書いている。

### 測定手段が 3 種類ある

数値の性質によって、守り方が違う。

**(1) メモリオーバーヘッド 5 MiB — 全テストに常駐するハード閾値**

`MemoryMonitor`（memory cop）は、テストフレームワークが microVM を作るたびに**既定で付く**。10 ms 周期で Firecracker プロセスの `memory_maps` を舐め、ゲストメモリと判定できる領域を除外した RSS を合計し、閾値を超えたらその時点のプロセスを記録して監視を止める。テストが microVM を kill するときに `check_samples()` が呼ばれ、超過があれば例外を投げる。閾値は起動後 5 MiB、スナップショット作成中 7 MiB、復元後 5 MiB。

つまり 5 MiB は、性能テストだけでなく**あらゆる機能テストが暗黙に守っている不変条件**になっている。何かの機能を足してメモリを 1 MiB 余計に使うようになれば、無関係なテストが大量に落ちる。

**(2) 起動時間 125 ms — 疑似デバイスで測って A/B 比較に回す**

boot timer は `--boot-timer` を付けたときだけアタッチされる疑似デバイスで、MMIO 空間の先頭に 1 ページ分だけ置かれる。ゲストのユーザ空間 init がそこに `123` を書くと、VMM が「InstanceStart を受け取った時刻」からの差分をログに出す。

```
Guest-boot-time =  95214 us 95 ms,  41230 CPU us 41 CPU ms
```

テストはこのログ行を正規表現で拾って値を取る。ただし、**125 ms との比較アサーションはコードに存在しない**。取れた値は CloudWatch のメトリクスとして送られ、`.buildkite/pipeline_perf.py` の A/B テストパイプラインで「変更前のリビジョン vs 変更後のリビジョン」として比較される。

**(3) API ソケット 8 CPU ms — こちらも A/B 比較**

`test_process_startup_time.py` は 100 回起動を繰り返し、Firecracker が自分で出す `api_server.process_startup_time_cpu_us` メトリクスを読む。ここでも 8 CPU ms とは比較しない。アサートしているのは「0 より大きい」ことと「テスト全体の経過時間より小さい」ことだけである。後者は、過去に値がオーバーフローするバグ（PR #4305）が入ったことへの対策だとコメントに書かれている。

### 絶対値と相対値の使い分け

この 3 つの違いは意図的だと読める。

- **メモリオーバーヘッド**は、ホストのハードウェアやカーネルにほとんど依存しない。だから絶対値の閾値が意味を持つ
- **起動時間**は、CPU のクロック、ホストのキャッシュ状態、ゲストカーネルのバージョンで簡単に数十 ms 動く。CI マシン上の絶対値を 125 ms と比べても、意味のある結果にならない

だから起動時間は「同じマシン上で 2 つのリビジョンを交互に走らせて統計的に比較する」という形（[A/B テスト](../ab-testing/)）に移されている。SPECIFICATION.md の数値は「本番相当のハードウェア上での約束」であり、CI が守るのは「その約束を壊す方向の回帰がないこと」である。この 2 つは別物で、後者だけが自動化できる。

### 脚注に書かれた限界

SPECIFICATION.md には脚注が 2 つある。どちらも「この数値の読み方を間違えるな」という注意である。

1 つ目は CPU ms の定義。

> CPU ms are actual ms of a user space thread's on-CPU runtime; useful for getting consistent measurements for some performance metrics.

壁時計時間ではなくスレッドが実際に CPU に載っていた時間である。本文にも「壁時計時間は標準偏差が大きく、6 ms から 60 ms の範囲に広がり、典型値は 12 ms 程度」と書かれている。8 CPU ms と 12 ms 前後の壁時計時間という 1.5 倍の乖離があることを、隠さずに書いている。

2 つ目は、ログの穴。

> No logs are currently produced in the span of time between the `jailer` process start-up and the logging system initialization in the `firecracker` process.

`jailer` が起動してから `firecracker` のロガーが初期化されるまでの区間はログが出ない。本文の「Failure Information: 外的要因による失敗はログに残る」という約束に、この区間だけ穴があると明記している。jailer は cgroup の作成、chroot、fd の受け渡しといった失敗しうる処理を行うので、この穴は実務上まったく無視できるものではない。

## ソースコードのどこか

### 仕様書本体

[`SPECIFICATION.md#L24-L45`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/SPECIFICATION.md#L24-L45) が Overhead の節で、5 MiB と 125 ms の両方がここにある。

```markdown title="SPECIFICATION.md"
- Firecracker's virtual machine manager threads have a memory overhead
  `<= 5 MiB`. The memory overhead is dependent on the **workload** (e.g. a
  workload with multiple [vsock](docs/vsock.md) connections might generate a
  memory overhead > 5MiB) and on the VMM **configuration** (the overhead does
  not include the memory used by the [MMDS](docs/mmds/mmds-design.md) data
  store.

  The overhead is tested as part of the Firecracker CI using a
  [memory cop](tests/host_tools/memory.py).
```

5 MiB が何を含まないかまで書いている。vsock のコネクションを多数張れば超えうること、MMDS のデータストアは勘定に入れないこと。数値だけを掲げず、その数値が成立する条件を並べている。

### memory cop

[`tests/host_tools/memory.py#L46-L66`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/tests/host_tools/memory.py#L46-L66) が閾値の定義である。

```python title="tests/host_tools/memory.py"
    def __init__(
        self,
        vm,
        threshold_booted=5 << 20,
        threshold_snapshot=7 << 20,
        threshold_restored=5 << 20,
        period_s=0.01,
    ):
```

計測ループ本体（[`tests/host_tools/memory.py#L86-L114`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/tests/host_tools/memory.py#L86-L114)）は素朴である。

```python title="tests/host_tools/memory.py"
        while not self._should_stop:
            mmaps = ps.memory_maps(grouped=False)
            mem_total = 0
            for mmap in mmaps:
                if self.is_guest_mem(mmap.size, guest_mem_bytes):
                    continue

                mem_total += mmap.rss
            self._current_rss = mem_total
            if mem_total > self.threshold:
                self._exceeded = ps
                return

            time.sleep(self._period_s)
```

面白いのは、ゲストメモリの除外方法が**マッピングのサイズによるヒューリスティック**である点である。`is_guest_mem_x86` は「サイズがゲストメモリ量と一致するか、x86_64 の 32bit ホール（3 GiB 〜 4 GiB）で分割されたときのサイズと一致するか」を見る（[`tests/host_tools/memory.py#L116-L138`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/tests/host_tools/memory.py#L116-L138)）。コメントも「それより大きければ FC 由来ではない可能性が高い、我々は大きなアロケーションをしないので」と、ヒューリスティックであることを認めている。

このヒューリスティックが成立するのは、Firecracker が**ゲストメモリ以外に大きな mmap をしない**からである。つまり memory cop 自体が「VMM はメモリをほとんど使わない」という設計前提に依存している。

監視を仕掛ける側（[`tests/framework/microvm.py#L211`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/tests/framework/microvm.py#L211) と [`#L261-L265`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/tests/framework/microvm.py#L261-L265)）を見ると、既定が `True` である。

```python title="tests/framework/microvm.py"
        monitor_memory: bool = True,
```

そして kill 時にチェックされる（[`tests/framework/microvm.py#L405-L406`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/tests/framework/microvm.py#L405-L406)）。

```python title="tests/framework/microvm.py"
        if self.memory_monitor:
            self.memory_monitor.check_samples()
```

性能テスト側は `monitor_memory=False` で明示的に切っている。測定対象のプロセスに 10 ms 周期の観測スレッドを付けたくないからである。逆に言うと、**機能テストの側でこそ常時オンになっている**。

### boot timer デバイス

[`src/vmm/src/devices/pseudo/boot_timer.rs#L11-L41`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/pseudo/boot_timer.rs#L11-L41) がデバイスの全部である。50 行しかない。

```rust title="src/vmm/src/devices/pseudo/boot_timer.rs"
const MAGIC_VALUE_SIGNAL_GUEST_BOOT_COMPLETE: u8 = 123;

/// Pseudo device to record the kernel boot time.
#[derive(Debug, Clone)]
pub struct BootTimer {
    start_ts: TimestampUs,
}

impl BusDevice for BootTimer {
    fn write(&mut self, _base: u64, offset: u64, data: &[u8]) -> Option<Arc<Barrier>> {
        // Only handle byte length instructions at a zero offset.
        if data.len() != 1 || offset != 0 {
            return None;
        }

        if data[0] == MAGIC_VALUE_SIGNAL_GUEST_BOOT_COMPLETE {
            let now_tm_us = TimestampUs::default();

            let boot_time_us = now_tm_us.time_us - self.start_ts.time_us;
            let boot_time_cpu_us = now_tm_us.cputime_us - self.start_ts.cputime_us;
            info!(
                "Guest-boot-time = {:>6} us {} ms, {:>6} CPU us {} CPU ms",
                ...
```

`start_ts` の出どころが重要である。[`src/vmm/src/builder.rs#L149-L150`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/builder.rs#L149-L150) で `build_microvm_for_boot` の先頭に置かれている。

```rust title="src/vmm/src/builder.rs"
    // Timestamp for measuring microVM boot duration.
    let request_ts = TimestampUs::default();
```

つまり測定区間は「InstanceStart を受けて microVM の組み立てを始めた瞬間 → ゲストのユーザ空間が MMIO に `123` を書いた瞬間」であり、SPECIFICATION.md の定義とそのまま一致する。

デバイスの登録場所にも制約がある（[`src/vmm/src/builder.rs#L221-L226`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/builder.rs#L221-L226)）。

```rust title="src/vmm/src/builder.rs"
    // The boot timer device needs to be the first device attached in order
    // to maintain the same MMIO address referenced in the documentation
    // and tests.
    if vm_resources.boot_timer {
        device_manager.attach_boot_timer_device(&kvm_vm, request_ts)?;
    }
```

アドレスが動くとゲスト側の書き込み先が変わってしまうので、アタッチ順が固定されている。実際には `BOOT_DEVICE_MEM_START`（MMIO 32bit 領域の先頭）に固定で置かれる。

### テスト側

[`tests/integration_tests/performance/test_boottime.py#L30-L49`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/tests/integration_tests/performance/test_boottime.py#L30-L49) がログを拾う部分である。

```python title="tests/integration_tests/performance/test_boottime.py"
    timestamp_log_regex = (
        r"Guest-boot-time =\s+(\d+) us\s+(\d+) ms,\s+(\d+) CPU us\s+(\d+) CPU ms"
    )

    iterations = 50
    sleep_time_s = 0.1
    for _ in range(iterations):
        timestamps = re.findall(timestamp_log_regex, vm.log_data)
        if timestamps:
            break
        time.sleep(sleep_time_s)
```

5 秒待って行が出なければ「microVM が起動しなかった」として失敗する。ここが実質的な上限だが、125 ms とは 40 倍離れている。取れた値の扱いは [`#L198-L213`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/tests/integration_tests/performance/test_boottime.py#L198-L213) にある。

```python title="tests/integration_tests/performance/test_boottime.py"
        metrics.put_metric(
            "guest_boot_time",
            boot_time_us,
            unit="Microseconds",
        )
        ...
        events = find_events(vm.log_data)
        build_time = events["build microvm for boot"]["duration"]
        metrics.put_metric("build_time", build_time.microseconds, unit="Microseconds")
        resume_time = events["boot microvm"]["duration"]
        metrics.put_metric("resume_time", resume_time.microseconds, unit="Microseconds")
```

全体の起動時間だけでなく、「microVM の組み立てにかかった時間」と「resume にかかった時間」も分けて出している。これらは `build_and_boot_microvm` が出す `event_start:` / `event_end:` のログ行（[`src/vmm/src/builder.rs#L379-L386`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/builder.rs#L379-L386)）を突き合わせて算出している。回帰が起きたときに、どの区間が伸びたかを切り分けられる。

`test_boottime` も `test_process_startup_time` も `@pytest.mark.nonci` が付いていて、[`tests/pytest.ini#L8`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/tests/pytest.ini#L8) の `-m 'not nonci and not no_block_pr'` により通常のテスト実行からは除外される。代わりに [`.buildkite/pipeline_perf.py#L73-L82`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/.buildkite/pipeline_perf.py#L73-L82) で、専用パイプラインの A/B 比較ジョブとして名前が挙がっている。

```python title=".buildkite/pipeline_perf.py"
    "boottime": {
        "label": "boottime",
        "tests": "integration_tests/performance/test_boottime.py::test_boottime",
        "devtool_opts": "-c 1-10 -m 0",
    },
```

`devtool_opts` の `-c 1-10 -m 0` は、測定対象を特定の CPU と NUMA ノードに固定するためのものである。測定条件を固定してノイズを削り、そのうえで 2 リビジョンを比較する。

## なぜそうなっているか

### 数値がテストにならないと、数値は腐る

「起動 125 ms」を掲げるだけなら簡単である。問題は、その後に入る個々の変更が 1 ms ずつ伸ばしていったときに誰も気づかないことである。SPECIFICATION.md の冒頭が「These specifications are enforced by integration tests」と書いているのは、この腐り方を防ぐための宣言である。

実際、Firecracker のコードには「起動時間を守るために入れた」としか説明のつかない実装がいくつもある。たとえば `main` の `resize_fdtable`（[`src/firecracker/src/main.rs#L476-L522`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/firecracker/src/main.rs#L476-L522)）は、fd テーブルの初期サイズ 64 を先に広げておく処理である。

```rust title="src/firecracker/src/main.rs"
/// We do this resizing because the kernel default is 64, with a reallocation happening whenever
/// the table fills up. This was happening for some larger microVMs, and reallocating the
/// fdtable while a lot of file descriptors are active (due to being eventfds/timerfds registered
/// to epoll) incurs a penalty of 30ms-70ms on the snapshot restore path.
```

30 ms から 70 ms という具体的な数字が付いている。契約に数値があるからこそ、こういう「気づきにくい 30 ms」を潰す作業に価値が生まれる。

### なぜメモリだけハード閾値なのか

メモリオーバーヘッドは、測定値の分散が小さい。`test_memory_overhead.py` の docstring も「1 回の測定で足りる。実行ごとに数 KiB しか変わらないので」と書いている（[`tests/integration_tests/performance/test_memory_overhead.py#L44-L47`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/tests/integration_tests/performance/test_memory_overhead.py#L44-L47)）。分散が小さいなら、閾値は誤検知を出さない。

一方、起動時間は 10 回繰り返して測っており、`test_process_startup_time.py` に至っては 100 回である。分散が大きいことが前提になっている。分散の大きい指標に絶対閾値を置くと、CI が不安定になって誰も見なくなる。**指標の分散に応じて守り方を変える**という判断が、そのままテストコードの形になっている。

### なぜ boot timer を「デバイス」にしたのか

ゲストの起動完了を検出する方法は他にもある。シリアルコンソールに出るメッセージを待つ、SSH で入れるようになるまで待つ、など。しかしどれもオーバーヘッドが大きく、測りたい対象（125 ms）と同じオーダーのノイズが乗る。

MMIO に 1 バイト書くのは、ゲストから見れば `movb` 1 命令である。VM exit が 1 回起きて、VMM スレッドが `TimestampUs::default()` を読む。測定のためのオーバーヘッドがマイクロ秒オーダーに収まる。

さらに、`--boot-timer` を付けなければデバイス自体がアタッチされない。**測定機構が本番構成に混ざらない**ようになっている。opt-in にすることで、「測定のためのコードが常時走ってオーバーヘッドを増やす」という自己矛盾を避けている。

### pending が残っていることをどう読むか

ネットワークとストレージのスループット、CPU 性能、レイテンシの 4 項目（5 箇所）は `[integration test pending]` のままである。実際には `test_network.py` や `test_block.py` が性能パイプラインに存在するので、測ってはいる。しかし「SPECIFICATION.md に書かれた数値を検証するテスト」としては認めていない。

推測だが、これらの数値はホストの NIC やストレージのハードウェアに強く依存するので、CI 環境で M5D.metal と同じ条件を再現できないのだと思われる。いずれにせよ、「テストがある」と書いてしまわずに pending と書き続けている点が重要である。契約文書の信頼性は、守れていない項目を守れていないと書けるかどうかで決まる。

## どう活かすか

**性能目標を書くなら、同時に「どのテストがそれを守るか」を書く**。SPECIFICATION.md は数値のすぐ後に `tests/host_tools/memory.py` や `tests/integration_tests/performance/test_boottime.py` へのリンクを置いている。リンク先が実在するので、読者は自分で確かめられるし、書き手も「テストがない項目」を自覚せざるを得ない。これは README に性能を書く程度のコストで真似できる。

**分散の小さい指標にはハード閾値、大きい指標には A/B 比較**という使い分けは、CI を持つプロジェクトなら広く応用できる。メモリ使用量、バイナリサイズ、生成物の行数、依存クレート数といった「実行環境にほぼ依存しない指標」は絶対値で殴っていい。レイテンシやスループットは、同一環境での前後比較にしないとノイズに埋もれる。

**測定機構を既定でオンにして、必要なときだけ切る**という配置も効く。memory cop は `monitor_memory=True` が既定で、性能テストだけが明示的に切る。もし逆（既定オフ、専用テストだけオン）だったら、5 MiB を守るのは 1 本のテストだけになっていた。既定オンにしたことで、機能追加の PR が無関係なテストで落ちるという形のフィードバックが得られる。

**測定のための機構は opt-in にして、本番構成から外す**。boot timer は `--boot-timer` がないとアタッチすらされない。観測のためのコードが常時走ると、観測対象が歪む。ただしこれは「測りたいものが測定オーバーヘッドと同じオーダー」の場合に特に重要で、秒オーダーの処理を測るのに神経質になる必要はない。

一方で、**そのまま真似すると危ないところ**もある。memory cop の「サイズでゲストメモリを判別する」というヒューリスティックは、Firecracker が大きな mmap を他にしないという前提に完全に依存している。同じ手法を、たとえばページキャッシュやアリーナアロケータを持つプロセスに適用すると誤判定する。テストコードが被テスト対象の設計前提に依存していること自体は悪くないが、その前提が変わったときにテストが静かに壊れる（見逃す方向に）ことは意識しておく必要がある。

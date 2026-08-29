---
title: "フィルタは、各スレッドが自分自身に課す"
description: "vmm / api / vcpu の 3 カテゴリに別々の seccomp フィルタがあり、それぞれのスレッドが自分で apply_filter を呼ぶ設計を、適用箇所 3 つの実際のコードで追う。prctl(PR_SET_NO_NEW_PRIVS) と seccomp(SECCOMP_SET_MODE_FILTER) の組み合わせ、TSYNC を使わない理由、そして「なぜ最初にまとめて適用できないのか」を扱う。"
group: "隔離とセキュリティ"
sidebar:
  order: 55
---

## 何を学んだか

Firecracker には 3 種類のスレッドがあり、seccomp フィルタも 3 つある。そして**フィルタを適用するのは、そのフィルタが課される当のスレッド自身**である。中央の「セキュリティ初期化関数」がまとめて適用するのではない。

```
                    起動                                   適用のタイミング
─────────────────────────────────────────────────────────────────────────
main()                                          filters = {vmm, api, vcpu}
  │
  ├─ fc_api スレッドを spawn ─────────────┐
  │    ApiServer::run()                    │
  │      apply_filter(api)  ★1  ───────────┤ HTTP サーバの listen 直前
  │      server.start_server()             │
  │      loop { requests() }               │
  │                                        │
  ├─ (メインスレッド = VMM スレッド)        │
  │    build_microvm...()                  │
  │      ├ KVM_CREATE_VM / メモリ確保       │  ← ここで大量の syscall が要る
  │      ├ カーネルロード / デバイス構築     │
  │      └ start_vcpus()                   │
  │           └ fc_vcpu N を spawn ────────┤
  │                Vcpu::run()             │
  │                  apply_filter(vcpu) ★3 │ KVM_RUN の状態機械に入る直前
  │                  loop { run_emulation }│
  │                                        │
  │    apply_filter(vmm)  ★2  ─────────────┘ microVM 構築の直後、
  │    event_manager.run()                   イベントループに入る直前
```

Linux の `seccomp(SECCOMP_SET_MODE_FILTER)` は、`SECCOMP_FILTER_FLAG_TSYNC` を付けない限り**呼び出しスレッドにだけ**適用される。Firecracker はフラグに 0 を渡しているので TSYNC は使っていない。つまり「各スレッドが自分で呼ぶ」のは実装の都合ではなく、スレッドごとに違うフィルタを課すための必然である。

### 適用の実体

`apply_filter` は 2 つのシステムコールを順に呼ぶだけの短い関数である。

```rust title="src/vmm/src/seccomp.rs"
    unsafe {
        let rc = libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0);
        ...
        let bpf_prog = SockFprog { len: bpf_filter_len, filter: bpf_filter.as_ptr() };
        let bpf_prog_ptr = &bpf_prog as *const SockFprog;
        let rc = libc::syscall(libc::SYS_seccomp, libc::SECCOMP_SET_MODE_FILTER, 0, bpf_prog_ptr);
```

`PR_SET_NO_NEW_PRIVS` が先に来る。`CAP_SYS_ADMIN` を持たないプロセスが seccomp フィルタをロードするには、このフラグが立っている必要がある。カーネルがこれを要求するのは、フィルタで syscall を細工して setuid バイナリの挙動を変える攻撃を防ぐためである。jailer 経由で起動した Firecracker は非特権ユーザなので、この 1 行がなければ 2 つ目の syscall が `EACCES` で失敗する。

`no_new_privs` が立つと、以後 `execve` で特権を得ることができなくなる。これ自体が防御としても効く。

`SockFprog` は `linux/filter.h` の `struct sock_fprog` を Rust で書き直したもので、命令数と命令列へのポインタを渡す。BPF 命令列は `Vec<u64>` として持っているので、8 バイト単位・4 バイトアラインメントというカーネル側の要求が自動的に満たされる。

この手前でカーネルの上限（4096 命令）を自分でも確認している。コメントいわく「そうしないと `prctl` がもっと分かりにくいエラーコードを返す」。

空のプログラムのときは何もせずに `Ok` を返す。`--no-seccomp` やデバッグビルドで seccomp が効かないのは、この早期リターンの経路である。BPF プログラムをロードしないので `no_new_privs` も立たない。

### 適用箇所 1: API スレッド、HTTP サーバの起動直前

```rust title="src/firecracker/src/api_server/mod.rs"
        // Load seccomp filters on the API thread.
        // Execution panics if filters cannot be loaded, use --no-seccomp if skipping filters
        // altogether is the desired behaviour.
        if let Err(err) = vmm::seccomp::apply_filter(seccomp_filter) {
            panic!(
                "Failed to set the requested seccomp filters on the API thread: {}",
                err
            );
        }

        server.start_server().expect("Cannot start HTTP server");
```

`start_server()` の 1 行前である。API スレッドは外部から HTTP リクエストを受ける唯一のスレッドなので、「リッスンを開始する前にフィルタが入っている」ことが必要になる。

失敗したら `panic!` で、フォールバックはない。コメントが「フィルタを飛ばしたいなら `--no-seccomp` を使え」と明示している。「セキュリティ機構の設定に失敗したら、機構なしで続行するのではなく止まる」という方針である。

なお、API スレッドに渡すフィルタは `BpfThreadMap` から `get` ではなく `remove` で取り出されている。以降このマップに `"api"` は存在しないので、取り違えて別のスレッドに api フィルタを適用してしまう余地が所有権のレベルで消える。`--no-api` の経路でも、`run_without_api` に渡す前に `"api"` を除いたマップを作り直している。

### 適用箇所 2: VMM スレッド、microVM 構築の直後

```rust title="src/firecracker/src/api_server_adapter.rs"
    // INVARIANT: seccomp must be applied before entering the event loop.
    // No guest-facing operations may occur between builder return and filter installation.
    let result = build_result.and_then(|vmm| {
        vmm::seccomp::apply_filter(
            seccomp_filters
                .get("vmm")
                .ok_or(ApiServerError::MissingSeccompFilter)?,
        )
        .map_err(ApiServerError::SeccompFilter)?;
```

コメントが不変条件を宣言している。「seccomp はイベントループに入る前に適用しなければならない。ビルダの return からフィルタのインストールまでの間に、ゲストに面した操作が入ってはならない」。

この位置が選ばれている理由は前後を見ると分かる。`build_microvm_from_requests`（あるいは `build_microvm_from_json`）が返るまでの間に、Firecracker は KVM の VM と vCPU を作り、ゲストメモリを `mmap` し、カーネルイメージを読み込み、デバイスを構築し、TAP を開き、そして vCPU スレッドを起動する。この構築処理には、ランタイムには不要なシステムコールが大量に要る。フィルタを先に入れてしまうと構築が通らない。

一方、構築が終わればイベントループに入るだけなので、必要な syscall は劇的に減る。だから「構築の直後・ループの直前」がフィルタを入れる唯一の位置になる。

`--no-api` の経路（`run_without_api`）にも同じコメントと同じ構造がある。ただしそちらは `panic!` ではなくエラーを返す。API スレッドは戻り値の型が `()` なので `panic!` するしかないが、こちらは `Result` を返せる。

### 適用箇所 3: vCPU スレッド、状態機械に入る直前

```rust title="src/vmm/src/vstate/vcpu.rs"
    pub fn run(&mut self, seccomp_filter: BpfProgramRef) {
        // Load seccomp filters for this vCPU thread.
        // Execution panics if filters cannot be loaded, use --no-seccomp if skipping filters
        // altogether is the desired behaviour.
        if let Err(err) = crate::seccomp::apply_filter(seccomp_filter) {
            panic!(
                "Failed to set the requested seccomp filters on vCPU {}: Error: {}",
                self.kvm_vcpu.index, err
            );
        }

        // Start running the machine state in the `Paused` state.
        let mut state = VcpuRunState::Paused;
```

`run()` の 1 行目である。この直後に状態機械のループが始まり、`Running` 状態になれば `run_emulation()` → `KVM_RUN` に入る。

ここに至るまでの流れも設計されている。`start_threaded` がスレッドを spawn し、その中でまず `register_kick_signal_handler()` を呼び、`Barrier` で全 vCPU スレッドの thread-local 初期化を待ち合わせ、それから `run(filter)` に入る。`Barrier` の待ち合わせと TLS 初期化をフィルタ適用より前に済ませるのは、それらが vcpu フィルタで許されていない syscall を使いうるからだと読める（推測だが、TLS の初期化やスレッド生成の後始末は定常状態の vCPU ループには不要な操作である）。

vCPU スレッドは `Paused` 状態から始まるので、フィルタが入ってから実際にゲストコードが走り出すまでにはさらに間がある。[脅威モデル](../threat-model/)の「vCPU スレッドは起動した瞬間から悪意あるコードを実行している」という前提に対して、実装は「ゲストコードが走る前に必ずフィルタが入っている」ことを保証している。

### 3 つのフィルタが違う理由

x86_64 musl のポリシーで、許可されているルール数は vmm が 80、api が 37、vcpu が 50 である。役割が違えば必要な syscall も違う。

- **api**: Unix ドメインソケットの `accept4` / `read` / `write` / `epoll_*`。KVM 関連の `ioctl` は一切要らない。
- **vcpu**: `KVM_RUN` の `ioctl`、MMIO / PIO 処理でデバイスモデルに触るための操作、`eventfd` の読み書き。ソケットの `accept4` は要らない。
- **vmm**: デバイスエミュレーション、レートリミッタのタイマ、ブロック I/O、TAP の読み書き、メトリクスとログの書き出し。

分けることで、あるスレッドが乗っ取られたときに使える syscall の集合が、そのスレッドの役割の範囲に留まる。API スレッドに任意コード実行の脆弱性が見つかっても、そこから `KVM_RUN` を呼ぶことはできない。

## ソースコードのどこか

適用処理は [`src/vmm/src/seccomp.rs#L94-L137`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/seccomp.rs#L94-L137) の `apply_filter`。`SockFprog` の定義は [`#L84-L91`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/seccomp.rs#L84-L91)、カーネル上限の定数は [`#L81-L82`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/seccomp.rs#L81-L82)。

API スレッドの適用は [`src/firecracker/src/api_server/mod.rs#L64-L84`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/firecracker/src/api_server/mod.rs#L64-L84)。フィルタを `remove` で取り出してスレッドに move する箇所は [`src/firecracker/src/api_server_adapter.rs#L179-L181`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/firecracker/src/api_server_adapter.rs#L179-L181) と [`#L203-L214`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/firecracker/src/api_server_adapter.rs#L203-L214)。

VMM スレッドの適用と不変条件のコメントは [`src/firecracker/src/api_server_adapter.rs#L250-L258`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/firecracker/src/api_server_adapter.rs#L250-L258)。`--no-api` 版は [`src/firecracker/src/main.rs#L656-L662`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/firecracker/src/main.rs#L656-L662)。`--no-api` のときにマップから `"api"` を落とす処理は [`#L459-L462`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/firecracker/src/main.rs#L459-L462)。

```rust title="src/firecracker/src/main.rs"
        let seccomp_filters: BpfThreadMap = seccomp_filters
            .into_iter()
            .filter(|(k, _)| k != "api")
            .collect();
```

vCPU スレッドの適用は [`src/vmm/src/vstate/vcpu.rs#L217-L236`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/vstate/vcpu.rs#L217-L236)、スレッド生成は [`#L182-L209`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/vstate/vcpu.rs#L182-L209)。フィルタは `Arc<BpfProgram>` として全 vCPU スレッドで共有される（[`src/vmm/src/vstate/vm.rs#L243-L276`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/vstate/vm.rs#L243-L276)）。BPF プログラムは読むだけなので共有して問題ない。

ビルダから vcpu フィルタを渡す箇所は [`src/vmm/src/builder.rs#L341-L350`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/builder.rs#L341-L350)。`"vcpu"` キーが無ければ `MissingSeccompFilters` で失敗する。

各スレッドの適用タイミングは [`docs/seccomp.md#L7-L12`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/docs/seccomp.md#L7-L12) にも「VMM（main）は vCPU スレッドがゲストコードを実行する直前、API は HTTP サーバの起動直前、vCPU はゲストコードの実行直前」と要約されている。

## なぜそうなっているか

**まとめて適用できないのは、起動と定常状態で必要な syscall が違うからである。** microVM の構築には、`open` / `mmap` / `ioctl(KVM_CREATE_VM)` / `ioctl(KVM_SET_USER_MEMORY_REGION)` / ファイル読み込み / スレッド生成といった操作が要る。これらの多くは、起動が済んだあとには二度と呼ばれない。プロセス開始時に全部許可するフィルタを入れると、そのフィルタは「構築に必要な集合 ∪ 定常状態に必要な集合」になり、定常状態でも `open` や `mmap` が許されたままになる。

seccomp は一度入れたフィルタを緩められない（追加したフィルタは AND で積み重なるだけ）。だから「広いフィルタを先に入れて、あとで狭める」ことはできても、実装上は「必要なタイミングまで待って、狭いフィルタを一度だけ入れる」ほうが単純になる。Firecracker は後者を採っている。

**スレッドごとに分けるのは、最小権限を粒度細かく適用するためである。** 3 つのスレッドは信頼度も攻撃面も違う。API スレッドはホスト側の管理プレーンから入力を受け、vCPU スレッドはゲストから入力を受け、VMM スレッドは両方の中間にいる。同じフィルタを課すと、3 つの和集合になってしまい、どのスレッドから見ても過剰な許可になる。

**適用を「自分自身に対して」行うのは、Linux の seccomp が本来そういう API だからでもある。** `SECCOMP_FILTER_FLAG_TSYNC` を使えば全スレッドに一括適用できるが、それでは 1 種類のフィルタしか課せない。結果として、フィルタの所有権とその適用が同じ場所にまとまり、「このスレッドは何を許されているか」がスレッドのエントリポイントを読めば分かる形になっている。

**失敗時に `panic!` するのは、部分的に守られた状態を作らないためである。** フィルタの適用に失敗したまま処理を続けると、そのスレッドだけ無防備になる。CHARTER の `cannot be mistakenly disabled by customers` に照らせば、無効化は明示的な `--no-seccomp` によってのみ起きるべきで、内部エラーの副作用として起きてはならない。

**`remove` で取り出すのは、誤用を型で防ぐためである。** `BpfThreadMap` から `get` で借りると、同じフィルタを複数箇所で使えてしまう。`remove` して所有権ごと渡せば、API フィルタは API スレッドにしか行き着かない。`--no-api` のときに `"api"` をマップから落とすのも同じ発想で、「使わないものは持たない」。

## どう活かすか

**権限を落とすタイミングを「もう要らなくなった直後」に置く。** これは seccomp に限らない。ファイルディスクリプタ、capability、データベース接続の権限、いずれも「初期化に必要だが定常運転には不要」なものがある。初期化の直後にその権限を手放すコードを置き、コメントで不変条件を書く。Firecracker の `// INVARIANT: seccomp must be applied before entering the event loop.` は 1 行だが、この行があるおかげで、あとから「メトリクスの初期化をここに足そう」とする人が立ち止まれる。

**権限を落とす処理は、落とされる主体が自分で呼ぶ。** 呼び出し元がまとめて設定する形にすると、「新しいスレッドを足したときに設定を書き忘れる」という失敗が起きる。エントリポイントの 1 行目に置いておけば、そのスレッドのコードを読む人には必ず見える。Rust なら、フィルタを引数として要求する（`fn run(&mut self, seccomp_filter: BpfProgramRef)`）ことで、書き忘れをコンパイルエラーにできる。

**適用条件。** この粒度が正当化されるのは、(1) スレッドごとに必要な操作の集合が実際に違う、(2) 各スレッドの寿命が長く、フィルタ適用のコストが償却できる、(3) 許可する操作の集合を列挙しきれる、という条件が揃うときである。スレッドプールで任意のタスクを実行するようなアーキテクチャでは、(1) も (3) も成り立たない。また、seccomp フィルタは一度入れると外せないので、実行時に機能を追加するタイプのシステム（プラグインの動的ロードなど）とは相性が悪い。

フィルタに引っかかった syscall がどう扱われるかは[次のページ](../sigsys-handler/)で、フィルタがどう作られてバイナリに入るかは[前のページ](../seccompiler/)で扱っている。microVM の構築処理そのものは[起動シーケンス](../boot-sequence/)を参照。

---
title: "KVM_RUN 中の vCPU を止めるのに、共有メモリとシグナルを両方使う"
description: "VMM スレッドが vCPU スレッドに Pause を伝えるには、mpsc チャネル・kvm_run の immediate_exit フラグ・SIGRTMIN の 3 つが全部要る。チャネルだけでは KVM_RUN 中の vCPU が見に来ず、シグナルだけでは KVM_RUN に入る直前のレースが残り、immediate_exit だけでは既にゲストを実行中の vCPU が抜けてこない。3 つの役割を分解する。"
group: "KVM をどう叩くか"
sidebar:
  order: 16
---

## 何を学んだか

### 走っている vCPU に用事を伝える手段は 1 つでは足りない

vCPU スレッドは [`KVM_RUN` のループ](../kvm-run-loop/)を回っている。`ioctl(vcpu_fd, KVM_RUN)` の中では**ホストの CPU がゲストコードを実行している**ので、その間このスレッドは Rust のコードを 1 行も実行していない。VMM スレッドから「止まれ」を伝えるのに、普通のスレッド間通信は使えない。

Firecracker の `VcpuHandle::send_event()` は 3 段階でこれをやる。

```
VMM スレッド                              vCPU スレッド
────────────                             ─────────────
(1) event_sender.send(Pause)  ──────>    [mpsc キューに積まれる]

(2) set_kvm_immediate_exit(1) ──────>    [kvm_run.immediate_exit = 1]
      (mmap で共有された kvm_run 構造体を直接書く)

(3) fence(Release)

(4) pthread_kill(SIGRTMIN)    ──────>    シグナルハンドラ (何もしない)
                                           └─> KVM_RUN が EINTR で返る
                                         run_emulation() が Interrupted を返す
                                         running() が event_receiver.try_recv()
                                           └─> Pause を受け取る
```

**3 つとも要る。** どれか 1 つでは、必ず取りこぼしのケースが残る。

### 3 つそれぞれが埋めている穴

| 手段                  | 単独では何が足りないか                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------------------------- |
| mpsc チャネルだけ     | `KVM_RUN` の中に居る vCPU はキューを見に来ない。ゲストが `HLT` もせず無限ループしていれば、永久に受け取らない   |
| シグナルだけ          | `KVM_RUN` に**入る直前**にシグナルが来ると、ハンドラが走ったあとで `KVM_RUN` に入ってしまい、その後は止まらない |
| `immediate_exit` だけ | このフラグは `KVM_RUN` の入口で見られる。**すでに `KVM_RUN` の中に居る** vCPU はフラグを見ないので抜けてこない  |

`immediate_exit` は、`vcpu_fd` を `mmap` して得た `kvm_run` 構造体の中にある 1 バイトのフラグである。ユーザ空間とカーネルが**同じページを共有している**ので、別スレッドから書き込める。KVM は `KVM_RUN` に入るときにこれを見て、立っていればゲストに入らず即座に戻る。

シグナルは逆に、**すでにゲスト実行中の vCPU を叩き落とす**手段である。シグナルが届くとホスト CPU は VM exit してカーネルの KVM コードに戻り、保留シグナルを見つけて `KVM_RUN` を `EINTR` で終わらせる。Firecracker が登録するハンドラは **何もしない**。シグナルを配送すること自体が目的で、`EINTR` を起こすためだけに存在する。

そして「入る直前のレース」は `immediate_exit` が埋める。シグナルが `KVM_RUN` の手前で消費されても、フラグが立っているので `KVM_RUN` は即座に戻る。**この 2 つは互いの穴を埋め合っている。**

## ソースコードのどこか

### 送る側

[`src/vmm/src/vstate/vcpu.rs#L617-L637`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/vstate/vcpu.rs#L617-L637) の `VcpuHandle::send_event`。VMM スレッドから見た vCPU への唯一の窓口で、`Pause` / `Resume` / `SaveState` / `DumpCpuConfig` / `Finish` はすべてここを通る。

```rust title="src/vmm/src/vstate/vcpu.rs"
    pub fn send_event(&mut self, event: VcpuEvent) -> Result<(), VcpuSendEventError> {
        // Use expect() to crash if the other thread closed this channel.
        self.event_sender
            .send(event)
            .expect("event sender channel closed on vcpu end.");
        // Kick the vcpu so it picks up the message.
        // Add a fence to ensure the write is visible to the vpu thread
        self.vcpu_fd.set_kvm_immediate_exit(1);
        fence(Ordering::Release);
        self.vcpu_thread
            .as_ref()
            // Safe to unwrap since constructor make this 'Some'.
            .unwrap()
            .kill(sigrtmin() + VCPU_RTSIG_OFFSET)?;
        Ok(())
    }
```

順序が重要である。**メッセージを積む → フラグを立てる → fence → シグナル**。逆順にすると、vCPU が起きてきたときにメッセージがまだ積まれていない可能性がある。

`VcpuHandle` が `vcpu_fd` を持っていることにも注目したい。これは vCPU スレッドが使っている fd と同じものではなく、スレッド起動時に `dup(2)` した複製である（[`src/vmm/src/vstate/vcpu.rs#L169-L178`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/vstate/vcpu.rs#L169-L178) の `copy_kvm_vcpu_fd`）。fd は複製しても**同じ `kvm_run` ページを指す**ので、VMM スレッド側から `immediate_exit` を書き換えられる。

### シグナルハンドラ

[`src/vmm/src/vstate/vcpu.rs#L122-L132`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/vstate/vcpu.rs#L122-L132)。中身は fence 1 行しかない。

```rust title="src/vmm/src/vstate/vcpu.rs"
    fn register_kick_signal_handler(&mut self) {
        extern "C" fn handle_signal(_: c_int, _: *mut siginfo_t, _: *mut c_void) {
            // We write to the immediate_exit from other thread, so make sure the read in the
            // KVM_RUN sees the up to date value
            fence(Ordering::Acquire);
        }
        register_signal_handler(sigrtmin() + VCPU_RTSIG_OFFSET, handle_signal)
            .expect("Failed to register vcpu signal handler");
    }
```

送信側の `fence(Release)` と受信側の `fence(Acquire)` が対になっている。これで **`immediate_exit = 1` の書き込みが、この後に読まれる値として見える** ことが保証される。シグナルハンドラは非同期に走る任意コードなので、`println!` も `malloc` もできない。ここで fence 1 個しか置いていないのは、その制約を守った結果でもある（[ログの再入問題](../logger-reentrancy/)と同じ話）。

使うシグナルは `SIGRTMIN + 0`（`VCPU_RTSIG_OFFSET = 0`、[`src/vmm/src/vstate/vcpu.rs#L32-L33`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/vstate/vcpu.rs#L32-L33)）。リアルタイムシグナルを選んでいるのは、`SIGUSR1` などの既定の意味を持つシグナルと衝突しないためである。Firecracker は `SIGSYS` を[seccomp 違反の検出](../sigsys-handler/)に、他のシグナルを[異常終了のハンドリング](../signal-handling/)に使っているので、用途ごとに番号を分ける必要がある。

### 受け取る側

`KVM_RUN` を呼ぶ直前のチェックが [`src/vmm/src/vstate/vcpu.rs#L407-L419`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/vstate/vcpu.rs#L407-L419) にある。

```rust title="src/vmm/src/vstate/vcpu.rs"
    pub fn run_emulation(&mut self) -> Result<VcpuEmulation, VcpuError> {
        if self.kvm_vcpu.fd.get_kvm_run().immediate_exit == 1u8 {
            warn!("Requested a vCPU run with immediate_exit enabled. The operation was skipped");
            self.kvm_vcpu.fd.set_kvm_immediate_exit(0);
            return Ok(VcpuEmulation::Interrupted);
        }

        match self.kvm_vcpu.fd.run() {
            Err(ref err) if err.errno() == libc::EINTR => {
                self.kvm_vcpu.fd.set_kvm_immediate_exit(0);
                // Notify that this KVM_RUN was interrupted.
                Ok(VcpuEmulation::Interrupted)
            }
```

**`immediate_exit` を見るのはカーネルだけではなく、Firecracker 自身も入口で見ている。** カーネルに任せても同じ結果になるが、ユーザ空間で判定すれば ioctl 1 回分を省ける。そしてどちらの経路でも、フラグは**必ず 0 に戻してから** `Interrupted` を返す。戻し忘れると、次の `KVM_RUN` も即座に抜けてしまい、ゲストが 1 命令も進まなくなる。

`Interrupted` を受けた `running()`（[`src/vmm/src/vstate/vcpu.rs#L240-L315`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/vstate/vcpu.rs#L240-L315)）が、ようやくチャネルを見に行く。

```rust title="src/vmm/src/vstate/vcpu.rs"
    fn running(&mut self) -> VcpuRunState {
        // This loop is here just for optimizing the emulation path.
        // No point in ticking the state machine if there are no external events.
        loop {
            match self.run_emulation() {
                // Emulation ran successfully, continue.
                Ok(VcpuEmulation::Handled) => (),
                // Emulation was interrupted, check external events.
                Ok(VcpuEmulation::Interrupted) => break,
```

コメントが設計意図を言っている。**MMIO や PIO の exit（`Handled`）ではチャネルを見ない。** 見に行くのは `Interrupted` のときだけである。ゲストが virtio デバイスを叩くたびに `try_recv()` を呼ぶのは無駄で、外部イベントがあるときは必ず `Interrupted` になると分かっているからこう書ける。**`immediate_exit` とシグナルの組み合わせが「必ず Interrupted になる」を保証しているので、この最適化が成り立つ。**

内側のループを抜けたあとの受け取りは `try_recv()` で、ブロックしない。`Ok(VcpuEvent::Pause)` なら `VcpuResponse::Paused` を返して `Paused` へ遷移する。`Interrupted` はシグナル以外の理由（`EAGAIN` など）でも起きうるので、キューが空であることは異常ではない。`Err(TryRecvError::Empty) => ()` で何もせず `Running` のまま戻る。

### 状態機械

vCPU スレッドは 3 状態を持つ。`run()`（[`src/vmm/src/vstate/vcpu.rs#L228-L237`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/vstate/vcpu.rs#L228-L237)）が状態遷移だけを回す。

```rust title="src/vmm/src/vstate/vcpu.rs"
        // Start running the machine state in the `Paused` state.
        let mut state = VcpuRunState::Paused;
        loop {
            state = match state {
                VcpuRunState::Running => self.running(),
                VcpuRunState::Paused => self.paused(),
                VcpuRunState::Finished => break,
            };
        }
```

**起動直後は `Paused` である。** スレッドは立ち上がるがゲストは走らない。[API で `InstanceStart`](../api-state-machine/) が来て初めて `Resume` が送られる。`Paused` 状態では `recv()`（ブロックする）を使う。`KVM_RUN` の中に居ないので、普通にチャネルを待てばよい。`Pause` 中に `SaveState` を受けると[状態を保存](../save-ordering/)して返し、`Running` 中に受けたら `NotAllowed` を返す。**「走っている vCPU の状態は保存できない」という制約が、状態機械のどの分岐に居るかで表現されている。**

`paused()` には `immediate_exit` の後始末がもう 1 箇所ある（[`src/vmm/src/vstate/vcpu.rs#L321-L328`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/vstate/vcpu.rs#L321-L328)）。`Resume` の `send_event()` 自体がフラグを立てるので、`Paused` 状態で `Resume` を受け取ると**フラグが立ったまま `Running` に入りかねない**。ここで `warn!` を出して 0 に戻しておかないと、再開直後に `KVM_RUN` が空振りする。

## なぜそうなっているか

### 「フラグ + シグナル」は KVM 側の API がそう設計されているから

`immediate_exit` は KVM が `kvm_run` 構造体に用意した公式のフィールドで、まさにこの用途のためにある。ユーザ空間 VMM が「走っている vCPU を止めたい」のは共通の要求で、シグナルだけでは競合が消えない。カーネルは、共有メモリ経由の 1 バイトという**シグナルより安いチャネル**を用意することでこれに答えた。

Firecracker はこの API をそのまま使っているだけで、独自の工夫は少ない。あるのは次の 3 点である。**fence を Release/Acquire で明示的に対にした**（ハンドラ側の fence にその旨のコメントが付いている）。**`run_emulation()` の入口でもフラグを見る**ことで、カーネルに任せず ioctl を 1 回節約する。**フラグを 0 に戻す箇所を 3 つ持つ**（`run_emulation()` の入口、`EINTR` を受けた直後、`paused()` で `Resume` を受けたとき）ので、どこを通っても後始末が漏れない。

### なぜチャネルも必要なのか

`immediate_exit` とシグナルは「止める」ことしか伝えられない。**何のために止めたのか**（Pause か SaveState か Finish か）は載せられない。だから mpsc チャネルで実データを運び、フラグとシグナルは「キューを見に行け」という起床通知にだけ使う。

この分業は逆にも効いている。**チャネルは Rust の型で `VcpuEvent` / `VcpuResponse` を運べる**（[`src/vmm/src/vstate/vcpu.rs#L532-L563`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/vstate/vcpu.rs#L532-L563)）。`VcpuResponse::SavedState(Box<VcpuState>)` のように応答に大きな構造体を載せられる。シグナルの `sival_int` に詰め込む設計では、こうはいかない。

## どう活かすか

### 「起床通知」と「データ」を分けるパターン

このパターンは KVM に限らず、**受け手がブロックする場所が複数種類あるとき**に一般化できる。受け手が `epoll_wait` で寝ているなら `eventfd` に write して起こす。長い計算の途中なら `AtomicBool` のキャンセルフラグを立てる。**割り込み不能な外部呼び出し**の中に居るなら、シグナルで叩き落とすしかない。いずれの場合もデータはキューから取らせる。

Firecracker が 3 つ使っているのは、`KVM_RUN` が「外部呼び出しの中」と「入口でのフラグチェック」の両方を持つからである。自分のコードでは、**受け手がどこでブロックしうるかを列挙して、それぞれに対応する起こし方が用意されているか**を確認すればよい。列挙し損ねると、そこで止まる。

### シグナルを使うときのコスト

シグナルは強力だが代償がある。**ハンドラの中でできることが極端に少ない**（async-signal-safe な関数しか呼べない。Firecracker のハンドラが fence 1 行なのはこのため）。**`sigaction()` はプロセス全体の設定**で、スレッドごとではない（Firecracker は `pthread_kill` で配送先を指定して回避している）。**番号が他のライブラリと衝突しうる**ので、割り当てを一箇所で管理する必要がある。そして **`EINTR` があらゆる syscall に飛び火する**。Firecracker の vCPU スレッドが[極端に狭い seccomp フィルタ](../per-thread-seccomp/)でほとんど `KVM_RUN` しか呼ばないのは、この面でも都合がよい。

**受け手が自前のループを回しているだけなら、シグナルは要らない。** `AtomicBool` + チャネルで足りる。シグナルが要るのは、止めたい相手が「自分で書いていないブロッキング呼び出し」の中に居るときだけである。逆に言えば、ライブラリ設計者としては**キャンセル可能な API を提供することで、利用者にシグナルを使わせずに済ませられる**。

### この設計が効かない前提

vCPU が 1 個で応答時間を気にしないなら、`Pause` はゲストが次に VM exit するまで待てばよく、フラグもシグナルも要らない。Firecracker がここまでやるのは、[スナップショット取得](../snapshot-format/)や API 応答のレイテンシが仕様に入っているからである。また、起こす頻度が高いならシグナル配送のコストが効いてくる。Firecracker で `send_event` が呼ばれるのは Pause/Resume/SaveState/Finish のときだけで、通常のデバイス I/O では呼ばれない。頻繁に叩く用途なら、共有メモリのフラグとポーリングのほうが安い。

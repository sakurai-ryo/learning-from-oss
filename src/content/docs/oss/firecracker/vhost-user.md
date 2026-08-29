---
title: "データパスを丸ごと別プロセスへ出すと、何を失うか"
description: "vhost-user では Firecracker はフロントエンドだけを実装し、virtqueue の処理を別プロセスに渡す。フロントエンドの責務が 4 つしかないことと、その代償——ゲストメモリの共有マッピング化によるページフォルト最大 24% 悪化、レートリミッタの無効化、スナップショット不可——をコードとドキュメントから確認する。"
group: "virtio を実装する"
sidebar:
  order: 34
---

## 何を学んだか

### virtqueue を処理しない virtio デバイス

これまでのページで見てきた virtio デバイスは、すべて Firecracker のプロセス内で virtqueue を処理していた。descriptor chain を検証し、`iovec` に変換し、`readv` / `writev` を発行し、used ring を書いて割り込みを上げる。

vhost-user はそこを丸ごと外に出す。virtqueue を処理するのは Unix ドメインソケットの向こう側にいる別プロセス(バックエンド)で、Firecracker はフロントエンドとして必要な情報を渡すだけになる。Firecracker が実装しているのはフロントエンドのみで、バックエンドは利用者が用意する。

```
       [ゲスト]
          |
          | MMIO 書き込み(doorbell)
          v
  +----------------------------+          +---------------------------+
  | Firecracker                |   UDS    | バックエンド (別プロセス)  |
  |  vhost-user フロントエンド |<-------->|                           |
  |   - UDS 接続               | 制御のみ |  virtqueue を直接読み書き |
  |   - feature negotiation    |          |  ディスク I/O を実行      |
  |   - config 要求の中継      |          |                           |
  |   - メモリ fd / vring 情報 |          |                           |
  +----------------------------+          +---------------------------+
          |                                        ^        |
          | guest memory の fd を送る               |        |
          v                                        |        v
       [ゲストメモリ (memfd, MAP_SHARED)] ---------+   [irqfd → KVM → ゲスト]
```

`docs/api_requests/block-vhost-user.md` はフロントエンドの責務を 4 項目に列挙している。

> In the vhost-user architecture, the VMM acts as a vhost-user frontend and it is responsible for:
>
> - connecting to the backend via a Unix domain socket (UDS)
> - feature negotiation with the backend and the guest
> - handling device configuration requests from the guest
> - sharing sufficient information about the guest memory and Virtio queues with the backend

[`docs/api_requests/block-vhost-user.md#L20-L36`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/docs/api_requests/block-vhost-user.md#L20-L36)

そして重要な補足がすぐ後に続く。

> The UDS socket is only used for control plane purposes and does not participate in the data plane.

UDS にデータは流れない。ソケットを通るのは feature ビットマスク、メモリ領域の記述、vring のアドレス、そしてファイルディスクリプタ(SCM_RIGHTS)だけである。実データはバックエンドがゲストメモリを直接マップして読み書きする。ソケットのスループットがボトルネックにならないのはこのためだ。

### イベントハンドラが空になる

外に出した結果は、event_handler の中身に露骨に現れる。

```rust title="src/vmm/src/devices/virtio/block/vhost_user/event_handler.rs"
impl MutEventSubscriber for VhostUserBlock {
    // Handle an event for queue or rate limiter.
    fn process(&mut self, event: Events, ops: &mut EventOps) {
        ...
        if self.is_activated() {
            if Self::PROCESS_ACTIVATE == source {
                self.process_activate_event(ops)
            } else {
                warn!("BlockVhost: Spurious event received: {:?}", source)
            }
```

[`src/vmm/src/devices/virtio/block/vhost_user/event_handler.rs#L37-L77`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/block/vhost_user/event_handler.rs#L37-L77)

登録するイベントは `activate_evt` ただ 1 つで、それも activate 完了時に解除される。ランタイムイベントの登録([activate 前後で購読を切り替える仕組み](../spurious-events/))が存在しない。activate 後の `VhostUserBlock` は epoll に何も登録していない。キューの eventfd は KVM の ioeventfd としてバックエンドに直接渡され、Firecracker のイベントループを一度も経由しない。

## ソースコードのどこか

### 接続と feature negotiation

デバイス生成時に UDS に接続し、`set_owner` でセッションの所有権を主張する。

```rust title="src/vmm/src/devices/virtio/vhost_user.rs"
    pub fn new(socket_path: &str, num_queues: u64) -> Result<Self, VhostUserError> {
        let stream = UnixStream::connect(socket_path).map_err(VhostUserError::Connect)?;

        let vu = T::from_stream(stream, num_queues);
        vu.set_owner().map_err(VhostUserError::VhostUserSetOwner)?;
```

[`src/vmm/src/devices/virtio/vhost_user.rs#L282-L295`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/vhost_user.rs#L282-L295)

feature negotiation は 2 段階になる。まずバックエンドと virtio feature の共通集合を取り、次にゲストのドライバとその共通集合の中から交渉する。

```rust title="src/vmm/src/devices/virtio/vhost_user.rs"
        let backend_features = self
            .vu
            .get_features()
            .map_err(VhostUserError::VhostUserGetFeatures)?;
        let acked_features = avail_features & backend_features;
```

[`src/vmm/src/devices/virtio/vhost_user.rs#L326-L364`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/vhost_user.rs#L326-L364)

デバイス側では、バックエンドと合意した feature をそのままゲストへの `avail_features` として提示する。

```rust title="src/vmm/src/devices/virtio/block/vhost_user/device.rs"
        // We negotiated features with backend. Now these acked_features
        // are available for guest driver to choose from.
        let avail_features = acked_features;
```

[`src/vmm/src/devices/virtio/block/vhost_user/device.rs#L212-L216`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/block/vhost_user/device.rs#L212-L216)

`VIRTIO_BLK_F_RO`(読み取り専用)もここで決まる。API に `readonly` を指定する口はなく、バックエンドが RO を広告したらそれを受け入れる。デバイスの性質そのものがバックエンド側の所有物になっている。

### config の中継

ゲストの config space 読み出しは Firecracker がキャッシュした `config_space` から返すが、その中身はバックエンドから取ってきたものである。`PATCH /drives` を受けると再取得して config change 割り込みを上げる。

```rust title="src/vmm/src/devices/virtio/block/vhost_user/device.rs"
        self.config_space = new_config_space;
        interrupt
            .trigger(VirtioInterruptType::Config)
            .map_err(VhostUserBlockError::Interrupt)?;
```

[`src/vmm/src/devices/virtio/block/vhost_user/device.rs#L260-L290`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/block/vhost_user/device.rs#L260-L290)

ディスク容量の変更をゲストに伝える経路が、これで成立する。Firecracker は中身を解釈せず、バイト列を右から左へ流している。

### activate で fd を渡し切る

activate の実体は `setup_backend` の 1 回の呼び出しである。

```rust title="src/vmm/src/devices/virtio/block/vhost_user/device.rs"
        self.vu_handle
            .set_features(self.acked_features)
            .and_then(|()| {
                self.vu_handle.setup_backend(
                    &mem,
                    &[(0, &self.queues[0], &self.queue_evts[0])],
                    interrupt.clone(),
                )
            })
```

[`src/vmm/src/devices/virtio/block/vhost_user/device.rs#L345-L377`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/block/vhost_user/device.rs#L345-L377)

`setup_backend` の中で渡されるものが、そのまま「データパスを移譲するために必要なもの」の一覧になる。

```rust title="src/vmm/src/devices/virtio/vhost_user.rs"
            self.vu
                .set_vring_addr(*queue_index, &config_data)
                .map_err(VhostUserError::VhostUserSetVringAddr)?;
            self.vu
                .set_vring_base(*queue_index, queue.avail_ring_idx_get())
                .map_err(VhostUserError::VhostUserSetVringBase)?;

            // No matter the queue, we set irq_evt for signaling the guest that buffers were
            // consumed.
            self.vu
                .set_vring_call(...)
            self.vu
                .set_vring_kick(*queue_index, queue_evt)
```

[`src/vmm/src/devices/virtio/vhost_user.rs#L395-L466`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/vhost_user.rs#L395-L466)

- `set_mem_table` — ゲストメモリ全領域の fd とオフセット
- `set_vring_addr` — descriptor table / available ring / used ring の**ホスト側**アドレス
- `set_vring_base` — 現在の available ring インデックス
- `set_vring_call` — used ring を進めたときにゲストへ割り込むための irqfd
- `set_vring_kick` — ゲストの doorbell が届く ioeventfd

`set_vring_call` に渡しているのは KVM に登録済みの irqfd である。バックエンドがこの fd に書けば、Firecracker を経由せずに KVM がゲストへ割り込みを注入する。`set_vring_kick` に渡すのは MMIO 通知レジスタに紐付いた ioeventfd で、ゲストの doorbell はこれまた Firecracker を素通りしてバックエンドに届く。activate が終わった時点で、データパス上に Firecracker のコードは 1 行も残っていない。

メモリテーブルの構築はこうなっている。

```rust title="src/vmm/src/devices/virtio/vhost_user.rs"
        for region in mem.iter() {
            let (mmap_handle, mmap_offset) = match region.file_offset() {
                Some(_file_offset) => (_file_offset.file().as_raw_fd(), _file_offset.start()),
                None => {
                    return Err(VhostUserError::VhostUserNoMemoryRegion);
                }
            };
```

[`src/vmm/src/devices/virtio/vhost_user.rs#L366-L393`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/vhost_user.rs#L366-L393)

各リージョンに `file_offset` がなければエラーになる。ゲストメモリがファイル(memfd)に裏打ちされていることが前提になっている。これが次の代償に直結する。

## なぜそうなっているか

Firecracker がバックエンドを実装しないのは、[ミニマリズム憲章](../minimalism-charter/)の帰結である。ドキュメントは「Firecracker only implements a vhost-user frontend. Users are free to choose from existing open source backends or implement their own」と述べ、QEMU / Cloud Hypervisor / crosvm / SPDK の実装を参照先として挙げている。利点も「バックエンドが独自の処理ロジックを実装できること」に限定して説明されており、素朴なバックエンドでは速くならないと明記されている。

> While vhost-user block is considered an optimisation to Firecracker IO, a naive implementation of the backend is not going to improve performance.

つまり vhost-user は「速くなる機能」ではなく「拡張点」である。ネットワーク越しにブロックデータを取ってくる、独自の先読みをする、といった Firecracker 本体に入れたくないロジックを外に出すための穴だ。

### 失うもの 1: ゲストメモリが共有マッピングになる

バックエンドが virtqueue を読むには、ゲストメモリを自分のアドレス空間にマップする必要がある。そのためには fd を渡さねばならず、fd を渡すには匿名の private マッピングでは足りない。

```rust title="src/vmm/src/resources.rs"
        // Page faults are more expensive for shared memory mapping, including  memfd.
        // For this reason, we only back guest memory with a memfd
        // if a vhost-user-blk device is configured in the VM, otherwise we fall back to
        // an anonymous private memory.
        if vhost_user_device_used {
            memory::memfd_backed(...)
        } else {
            memory::anonymous(...)
        }
```

[`src/vmm/src/resources.rs#L480-L516`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/resources.rs#L480-L516)。`memfd_backed` は `MAP_SHARED` でマップする([`src/vmm/src/vstate/memory.rs#L867-L883`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/vstate/memory.rs#L867-L883))。

代償の大きさはドキュメントに数字で書かれている。

> It was observed that page faults to a shared memory mapping take significantly longer (up to 24% in our testing), because Linux memory subsystem has to use atomic memory operations to update page status, which is an expensive operation under specific conditions.

[`docs/api_requests/block-vhost-user.md#L77-L88`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/docs/api_requests/block-vhost-user.md#L77-L88)

ページフォルトが最大 24% 遅くなる。しかもこれは**ブロックデバイスとは無関係な、microVM 全体のメモリアクセス**に効く。1 台のディスクを外部プロセスに任せた代償を、ゲストの全メモリが払う。CHANGELOG(PR #4498)は当初 memfd が常用されていたのを条件付きに変えたことを記録しており、「serving page faults of shared memory used by memfd is slower and may impact workloads」が理由である。vhost-user を使わない構成にまで代償が波及しないよう、後から切り分けられた。

セキュリティ面の代償もある。memfd は procfs に見えるので、`/proc/{pid}/fd` にアクセスできるプロセスはゲストメモリをマップして中身を覗ける。ドキュメントは「users need to make sure that the access to the Firecracker's procfs tree is restricted to trusted processes on the host」と注意を促している。

### 失うもの 2: レートリミッタ

vhost-user ブロックデバイスの設定は、レートリミッタが指定されていたら**構築時に弾く**。

```rust title="src/vmm/src/devices/virtio/block/vhost_user/device.rs"
        if let (Some(socket), None, None, None, None, None, None) = (
            &value.socket,
            &value.is_read_only,
            &value.path_on_host,
            &value.rate_limiter,
            &value.file_engine_type,
            &value.blk_size,
            &value.topology,
        ) {
```

[`src/vmm/src/devices/virtio/block/vhost_user/device.rs#L66-L91`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/block/vhost_user/device.rs#L66-L91)

`socket` があり、かつ他が全部 `None` のときだけ `VhostUserBlockConfig` になる。`rate_limiter` を同時に指定すると `VhostUserBlockError::Config` である。当然で、[レートリミッタ](../rate-limiter/)はリクエストが Firecracker のコードを通ることを前提にしている。通らないものは数えられない。

> In the vhost-user case, Firecracker does not participate in handling requests from the guest, so rate limiting becomes backend's responsibility.

[`docs/api_requests/block-vhost-user.md#L168-L178`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/docs/api_requests/block-vhost-user.md#L168-L178)

代替として cgroups による間接的な制限が挙げられているが、「ホスト CPU 消費を制限すれば結果的に I/O も制限される」という粗い手段である。Firecracker の脅威モデルでは「ゲストは悪意あるコードを実行している」と仮定するので、[脅威モデル](../threat-model/)上の防御線が 1 本、Firecracker からバックエンドへ移ることになる。バックエンドの実装品質がホストの公平性を左右する。ドキュメントがバックエンドを jailer 相当の環境で動かすこと、virtio レベルのファザーをゲストで走らせることを勧めているのも同じ理由だ。

### 失うもの 3: スナップショット

`Persist` の実装はスタブである。

```rust title="src/vmm/src/devices/virtio/block/vhost_user/persist.rs"
impl Persist<'_> for VhostUserBlock {
    type State = VhostUserBlockState;
    ...
    fn save(&self) -> Self::State {
        unimplemented!("VhostUserBlock does not support snapshotting yet");
    }

    fn restore(
        _constructor_args: Self::ConstructorArgs,
        _state: &Self::State,
    ) -> Result<Self, Self::Error> {
        Err(VhostUserBlockError::SnapshottingNotSupported)
    }
}
```

[`src/vmm/src/devices/virtio/block/vhost_user/persist.rs#L28-L43`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/block/vhost_user/persist.rs#L28-L43)

`VhostUserBlockState` という状態構造体は定義されているのに、それを埋める `save()` が `unimplemented!()` になっている。`VhostUserBlockImpl::prepare_save()` も同様である([`device.rs#L245-L248`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/block/vhost_user/device.rs#L245-L248))。

`unimplemented!()` は panic なので、ここに到達したら Firecracker が落ちる。だから到達させないための門番が別に置かれている。

```rust title="src/vmm/src/lib.rs"
    /// Check if the VM has any devices without snapshot support
    pub fn check_unsnapshottable_devices(&self) -> Result<(), MicrovmStateError> {
        let mut tuples = Vec::new();
        self.device_manager
            .for_each_virtio_device(|device_type, device| {
                if let VirtioDeviceType::Block = device_type
                    && let Some(b) = device.as_any().downcast_ref::<Block>()
                    && b.is_vhost_user()
                {
                    tuples.push(("vhost-user-block", b.id().to_owned()));
                }
            });
```

[`src/vmm/src/lib.rs#L436-L460`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/lib.rs#L436-L460)

`save_state()` の先頭でこれを呼び、vhost-user デバイスが 1 つでもあれば `MicrovmStateError::NotAllowed` を返してスナップショット取得そのものを断る([`#L499-L501`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/lib.rs#L499-L501))。panic する `unimplemented!()` の手前に、エラーとして返す関門を置く構成だ。

技術的な難しさは想像がつく。スナップショットを取るには、バックエンドが処理中のリクエストを完了させ、その内部状態も一緒に保存し、復元時に別のバックエンドプロセスへ戻す必要がある。それは vhost-user プロトコルの範囲を超え、バックエンド実装への追加要求になる。Firecracker の[スナップショット](../snapshot-format/)が成立していたのは、デバイスの状態がすべて自プロセス内にあったからだ。

CHANGELOG は vhost-user block 追加時点で「Known limitation: snapshotting is not currently supported for microVMs containing vhost-user block devices」と明記しており、この制約は最初から分かったうえで受け入れられている。機能自体も developer preview のままである。

## どう活かすか

**プロセス境界を引くとき、失うのは「越えられない仕組み」だと考える。** vhost-user の 3 つの代償は、いずれも「Firecracker のプロセス内に全部あることに依存していた仕組み」である。

| 依存していた前提                 | 壊れた仕組み                                |
| -------------------------------- | ------------------------------------------- |
| ゲストメモリは自分だけが触る     | 匿名 private マッピングの速いページフォルト |
| リクエストは自分のコードを通る   | レートリミッタ                              |
| デバイス状態は自分のメモリにある | スナップショット                            |

新しい境界を引くときは、機能一覧ではなくこの形で棚卸しするとよい。「今ある機能のうち、どれが『同一プロセスであること』を暗黙に前提にしているか」を先に洗い出す。プラグイン機構、サイドカー、マイクロサービス分割、どれも同じ問いになる。

**代償を局所化できるなら、そうする。** memfd の判定([`resources.rs`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/resources.rs#L480-L516))は好例だ。当初は常に memfd を使っていたが、vhost-user デバイスがある構成に限定するよう変更された。「拡張点を用意したせいで、使わない人まで遅くなる」を避けている。設定に応じて実装を切り替えるコストと、全員に代償を払わせるコストを比べる。

**両立しない組み合わせは、実行時に壊れる前に構成時に弾く。** `VhostUserBlockConfig::try_from` はレートリミッタ付きの設定を型変換の段階で拒否し、`check_unsnapshottable_devices` はスナップショット API を入口で断る。`unimplemented!()` が奥に残っていても、そこに到達する経路が塞がれていれば実害は出ない。「未実装」を型やバリデーションで表明し、panic は最後の防波堤に留める。

**逆に、vhost-user を選ぶ判断が正しくなる条件も具体的だ。**

- バックエンドが Firecracker には入れられない処理をする(ネットワークストレージ、独自の圧縮・重複排除、専用ハードウェアの利用)。単にローカルファイルを読むだけなら、[block-io-engine](../block-io-engine/) の io_uring エンジンのほうが構成が単純で速い可能性が高い。
- スナップショットを使わない。使うなら現時点で選択肢にならない。
- I/O の公平性をバックエンド側または cgroups で担保できる。マルチテナントで隣の microVM を守る必要があるなら、その責務をバックエンドに実装する覚悟が要る。
- ページフォルトのコスト増を許容できるワークロードである。ドキュメント自身が「We advise users to profile performance on their workloads」と、測ってから決めろと書いている。

境界を越えさせる判断は、性能の見積もりだけでは済まない。何が越えられなくなるかを列挙してから決める。

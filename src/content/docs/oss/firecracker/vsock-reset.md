---
title: "vsock の接続は、あえて壊す"
description: "Firecracker はスナップショット保存の直前に VIRTIO_VSOCK_EVENT_TRANSPORT_RESET をゲストへ送り、接続情報を一切保存しない。中途半端に復元するより明示的に壊して再接続させるという判断を、vsock の persist 定義とデバイスコードから読む。同じ論理がネットワーク（TAP 名だけ保存し network_overrides で差し替え）と MMDS データストアにも及んでいる。"
group: "スナップショット"
sidebar:
  order: 50
---

## 何を学んだか

### 保存する前に、接続を壊す

virtio-vsock はゲストとホストの間のソケット通信路で、スナップショット時点では複数の接続が確立している可能性がある。Firecracker はこれを保存しない。保存しないどころか、**スナップショットを取る直前にゲストへ「トランスポートがリセットされた」というイベントを送り、既存接続を明示的に破棄させる**。

```
  CreateSnapshot
      ├─ 各 virtio デバイスの prepare_save()
      │      └─ vsock: VIRTIO_VSOCK_EVENT_TRANSPORT_RESET を event queue へ
      │                pending_event_ack = true / used ring 更新 / 割り込み
      ├─ デバイス状態を保存（接続情報は入っていない）
      └─ メモリを保存

  Resume（元 VM でも復元先 VM でも）
      └─ kick(): pending_event_ack なら event queue を再度シグナル
             └─ ゲストのドライバ: 既存接続を全て close
                                  listen ソケットは残す（CID だけ更新）
```

イベントを送るのは保存の直前であって復元時ではない。したがってスナップショットを取った **元の VM** も、resume した時点で接続が切れる。ドキュメントは「スナップショット作成が現在の microVM に与える影響」として、vsock デバイスがリセットされることを明記している。

### 保存されるのは「配線」だけで、「通信状態」ではない

vsock の永続化状態を型定義で確認すると、何を諦めているかがはっきりする。

| 保存されるもの                                                           | 保存されないもの                                  |
| ------------------------------------------------------------------------ | ------------------------------------------------- |
| ゲストの CID                                                             | 確立済み接続の一覧                                |
| virtio デバイス状態（キュー、ネゴシエート済み feature、activate 済みか） | 各接続のポート・シーケンス番号・ウィンドウ        |
| `pending_event_ack`（リセットの ack 待ちかどうか）                       | 送受信途中のパケット（`rx_packet` / `tx_packet`） |
| ホスト側 UDS のパス                                                      | ホスト側ソケットの fd と epoll 登録               |
| ホスト側で最後に使ったローカルポート番号                                 | ゲスト側 listen ソケットの中身                    |

`pending_event_ack` だけが例外的に「通信状態っぽいもの」として保存される。これはリセットイベントを ack されるまで RX 配送を止めるゲートで、復元後も同じゲート状態から始めないと、ack を待ち続けて RX がハングする。

復元時、デバイスは `DeviceState::Inactive` に戻される。ゲストのドライバが改めてデバイスを activate し直す前提だ。

### ゲスト側では listen ソケットだけが生き残る

virtio 仕様上、`VIRTIO_VSOCK_EVENT_TRANSPORT_RESET` を受けたドライバは、確立済み接続を全て閉じ、`guest_cid` の設定フィールドを読み直す。listen ソケットは残るが、その CID は新しい `guest_cid` に更新される。

つまり復元後のゲストは、「サーバとして待ち受けている口はそのまま、既存のセッションは全部切れた」状態になる。アプリケーションから見れば、ネットワークケーブルを抜き差ししたのと同じで、再接続すれば動く。

### 同じ論理がネットワークにも及ぶ

virtio-net の永続化状態も、TAP デバイスの **名前** と MAC・MTU・レートリミッタ状態・MMDS スタック状態を持つだけで、ホスト側 TAP の fd も、ゲストの TCP 接続も持たない。復元時は同名の TAP を開き直す。

クローンを複数起動するとき、TAP 名は衝突する。Firecracker はこれを 2 通りで解く。

1. **netns で名前空間ごと分ける。** jailer の `--netns` で各クローンを別のネットワーク名前空間に入れれば、同名の TAP が共存できる。ゲスト内の IP が全クローンで同じになる問題は、ホスト側の `iptables` NAT で解決する（＝ VMM 側では何もしない）。
2. **`network_overrides` で名前を差し替える。** jailer を使わず、TAP がプールから割り当てられるような環境向けに、ロード時に `iface_id` → `host_dev_name` の対応を上書きできる。

どちらも「衝突は利用者側のホスト構成で解決する」という立場で、Firecracker は名前を差し替える口だけを開けている。vsock にも同じ発想の `vsock_override`（ホスト UDS パスの差し替え）がある。

MMDS も同様に、**設定はスナップショットに含まれるがデータストアは含まれない**。復元後にデータを入れ直すのは利用者の仕事になる。

## ソースコードのどこか

保存の入口。`prepare_save()` はトランスポート状態を保存する **前** に呼ばれる。デバイスの準備中にゲストへ割り込みを送ると、その結果がトランスポート状態に反映される必要があるからだ。

```rust title="src/vmm/src/device_manager/persist.rs"
            // We need to call `prepare_save()` on the device before saving the transport
            // so that, if we modify the transport state while preparing the device, e.g. sending
            // an interrupt to the guest, this is correctly captured in the saved transport state.
            locked_device.prepare_save();
            let transport_state = mmio_transport_locked.save();
```

[`src/vmm/src/device_manager/persist.rs#L277-L285`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/device_manager/persist.rs#L277-L285)

vsock の `prepare_save` は、activate 済みなら `send_transport_reset_event()` を呼ぶだけで、送信に失敗してもログを出して続行する（[`src/vmm/src/devices/virtio/vsock/device.rs#L467-L475`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/vsock/device.rs#L467-L475)）。

イベント送信の本体。関数の直上のコメントが、ゲスト側で何が起きるかを仕様として書いている。

```rust title="src/vmm/src/devices/virtio/vsock/device.rs"
    // Send TRANSPORT_RESET_EVENT to driver. According to specs, the driver shuts down established
    // connections and the guest_cid configuration field is fetched again. Existing listen sockets
    // remain but their CID is updated to reflect the current guest_cid.
    pub fn send_transport_reset_event(&mut self) -> Result<(), DeviceError> {
        ...
        mem.write_obj::<u32>(VIRTIO_VSOCK_EVENT_TRANSPORT_RESET, head.addr)
            .unwrap_or_else(|err| error!("Failed to write virtio vsock reset event: {:?}", err));
        ...
        self.pending_event_ack = true;
```

[`src/vmm/src/devices/virtio/vsock/device.rs#L252-L288`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/vsock/device.rs#L252-L288)

書き込む値は 4 バイトの定数 `0` である（[`#L48`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/vsock/device.rs#L48)）。event queue から descriptor を 1 つ取り、そこにイベント ID を書いて used ring へ返す。ここで `enable_notification()` を呼ぶのは、EVENT_IDX が有効なときにゲストの descriptor 補充通知が抑制されないようにするためだ。

保存される状態の型定義。接続に関するフィールドが 1 つもないことを確認できる。

```rust title="src/vmm/src/devices/virtio/vsock/persist.rs"
/// The Vsock frontend serializable state.
pub struct VsockFrontendState {
    /// Context Identifier.
    pub cid: u64,
    pub virtio_state: VirtioDeviceState,
    /// Whether a `TRANSPORT_RESET_EVENT` published to the guest's event queue
    /// is still awaiting the driver's acknowledgment. RX delivery stays gated
    /// until the guest acks, so a restored device must resume with the same
    /// gate state the source device had.
    pub pending_event_ack: bool,
}

/// The Vsock Unix Backend serializable state.
pub struct VsockBackendState {
    /// The path for the UDS socket.
    pub uds_path: String,
    /// The last used host-side port.
    pub local_port_last: u32,
}
```

[`src/vmm/src/devices/virtio/vsock/persist.rs#L26-L46`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/vsock/persist.rs#L26-L46)

復元 (`restore`) は、キューを組み直し、feature を戻し、`device_state` を `DeviceState::Inactive` に、`pending_event_ack` を保存値に設定するだけである（[`src/vmm/src/devices/virtio/vsock/persist.rs#L102-L123`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/vsock/persist.rs#L102-L123)）。

判断の理由は resume 側の `kick()` に長いコメントで残されている。

```rust title="src/vmm/src/devices/virtio/vsock/device.rs"
            // Vsock has a complicated protocol that isn't resilient to any packet loss,
            // so for Vsock we don't support connection persistence through snapshot. Any
            // in-flight packets or events are simply lost and Vsock is restored 'empty'.
```

[`src/vmm/src/devices/virtio/vsock/device.rs#L411-L465`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/vsock/device.rs#L411-L465)

同じ関数は、`pending_event_ack` が立っていないのに RX ゲートを張ってしまうと「ゲストが決して送れない ack を待って、以降のホスト起点の接続が全部ハングする」と警告している。壊す判断は徹底しているが、ゲート状態だけは正確に引き継ぐ必要がある、という非対称がここにある。

ネットワーク側の永続化状態 `NetState` も、`id` / `tap_if_name` / 送受信レートリミッタ状態 / `mmds_ns` / config space（MAC と MTU）/ `virtio_state` だけで、TAP は名前しか持たない（[`src/vmm/src/devices/virtio/net/persist.rs#L35-L45`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/net/persist.rs#L35-L45)）。

`network_overrides` は、ロード直前にデシリアライズ済みの状態へ手を入れて名前を差し替える。

```rust title="src/vmm/src/persist.rs"
        device_state
            .map(|device_state| device_state.tap_if_name.clone_from(&entry.host_dev_name))
            .ok_or(SnapshotStateFromFileError::UnknownNetworkDevice)?;
```

[`src/vmm/src/persist.rs#L384-L404`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/persist.rs#L384-L404)

vsock の UDS パスにも同じ仕組みがある（[`src/vmm/src/persist.rs#L406-L420`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/persist.rs#L406-L420)）。

## なぜそうなっているか

**リセットは、壊れた状態を復元して壊れるより良い、という判断の結果である。** ドキュメントは経緯まで書いている。

> The vsock device is reset across snapshot/restore to avoid inconsistent state between device and driver leading to breakage ([#2218](https://github.com/firecracker-microvm/firecracker/issues/2218)). This is done by sending a `VIRTIO_VSOCK_EVENT_TRANSPORT_RESET` event to the guest driver during `SnapshotCreate` ([#2562](https://github.com/firecracker-microvm/firecracker/pull/2562)).
>
> — [docs/snapshotting/snapshot-support.md](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/docs/snapshotting/snapshot-support.md#L667-L680)

「デバイスとドライバの状態が食い違って壊れる」を避けるのが目的で、接続を維持することは最初から目標ではない。

**vsock のプロトコルがパケットロスに耐えないことが根拠になっている。** `kick()` のコメントが述べるとおり、virtio-vsock はクレジットベースのフロー制御を持つ状態機械で、1 つのパケットが落ちるだけで両端の認識がずれる。スナップショットは本質的に「飛行中のパケット」を落とす操作なので、耐えない前提のプロトコルを無理に復元すると、静かに壊れた接続が残る。切断されたことがアプリケーションに見えるほうが、ハングするより扱いやすい。

**「明示的に壊す」ことにはもう 1 つ利点がある。** もし接続を維持するなら、VMM はホスト側のソケットを開き直し、シーケンス番号を合わせ、ゲストの CID 変更に追随し、クローン間で同じ接続が二重に生きないようにする必要が出る。リセットにすればこれらが全部消え、`persist.rs` は数十行で済む。

**ネットワークでも同じ判断が「衝突を利用者に押し出す」形で現れている。** network-for-clones.md は冒頭で `This should be considered as just an example to get you started, and we don't claim this is a performant or secure setup.` と断ったうえで netns と iptables NAT の手順を示す。VMM が IP 衝突を解決しないのは解決策がデプロイ環境ごとに違うからで、代わりに TAP 名の差し替えという最小限の口だけを提供している。

**MMDS のデータストアを保存しないのも同じ系列の判断だと読める（推測）。** snapshot-support.md は `The Firecracker microVM's MMDS config is included in the snapshot. However, the data store is not persisted across snapshots.` と書くだけで理由を述べていないが、クローンごとに異なるメタデータを注入したい運用（インスタンス ID、トークン）を考えれば、複製されるより空で始まるほうが安全側に倒れている。

## どう活かすか

**「復元できない状態は、復元しようとせず、明示的に無効化する」は汎用的に使える。** チェックポイント／リストアを実装するとき、外部との接続（TCP、gRPC ストリーム、DB コネクション、ファイル記述子）は原理的に復元できない。選択肢は 3 つある。

1. 復元しようとする → 相手が同意していないので必ず食い違う
2. 黙って捨てる → クライアントはタイムアウトまで気づかない
3. **明示的にリセットを通知して捨てる** → クライアントが即座に再接続できる

Firecracker が選んだのは 3 で、これは「相手側に再接続のロジックが既にある」場合に最も安く済む。vsock のドライバは仕様上リセットイベントを扱えるので、VMM 側は通知するだけでよかった。クライアントライブラリが再接続を実装しているなら、サーバ側は「切れたことを伝える」だけで責務を果たせる。

**通知のタイミングを「復元時」ではなく「保存直前」に置いた点は真似する価値がある。** 保存直前に通知すれば、その通知自体がスナップショットに含まれる。復元先は特別なことを何もしなくても、resume した瞬間にゲストがリセットを認識する。元の VM も同じ扱いになるので、「スナップショットを取った VM と、そこから復元した VM で挙動が違う」という分岐が消える。復元パスに特別処理を足すより、保存パスで状態を正規化するほうが、テストすべき組み合わせが減る。

**ただし「全部壊す」で済まない状態もある。** `pending_event_ack` がまさにそれで、これはリセットという操作自体の進行状態なので、正確に引き継がないと復元先がハングする。壊す方針を採る場合でも、**壊す手続きの途中で保存された場合** をどう扱うかは別途設計が要る。

**この設計が向かない条件も明確だ。** 接続の維持そのものが要件になる場合（長時間のストリーミング、状態を持つ双方向 RPC、クライアントが再接続を実装していないプロトコル）には使えない。その場合はスナップショットを「接続を持たない時点」に限る（＝アイドル時のみ取る）ほうが現実的で、Firecracker が「起動完了直後のスナップショットからクローンを大量に起動する」使い方を主眼にしているのも、その時点なら壊す接続が存在しないからだと理解できる。

---
title: "差分スナップショットと、dirty tracking がないときの妥協"
description: "差分スナップショットは KVM の dirty ページログと Firecracker 自前のビットマップを OR して、変更されたページだけをスパースファイルに書く。dirty tracking を有効にしていない場合のフォールバックとして mincore(2) で「コアに載っているページ」を dirty とみなす over-approximate な実装があり、swap が有効だと壊れることをコードとドキュメントの両方が明記している。"
group: "スナップショット"
sidebar:
  order: 46
---

## 何を学んだか

### 差分スナップショットは「前回から変わったページだけ」を書く

フルスナップショットはゲストメモリ全体をファイルへ書き出す。4GiB のゲストなら 4GiB を毎回書くことになり、時間もディスクも食う。差分 (Diff) スナップショットは、**前回のスナップショット以降に書き換わったページだけ** を出力する。

問題は「どのページが書き換わったか」をどう知るかだ。Firecracker はこれを 2 つの情報源から集めて OR する。

| 書き込みの経路                                                                                             | 検出方法                                                   |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| ゲスト vCPU がゲストメモリに store（EPT/NPT 経由の普通の書き込み）                                         | KVM の dirty ページログ (`KVM_GET_DIRTY_LOG`)              |
| VMM がホスト側からゲストメモリに書く（block の io_uring 完了、virtio の used ring 更新、`IoVecBufferMut`） | Firecracker 自前の `AtomicBitmap`（`mark_dirty` で立てる） |

この 2 つを OR したものが「書き出すページ」になる。2 つ目が要るのは、KVM の dirty ログがゲストのページテーブル経由の書き込みしか捕捉しないからだ。VMM がホストプロセスとして直接ゲストメモリへ書く経路には KVM が関与しないので、Firecracker は書き込み予定の領域を事前に自分のビットマップへマークしておく。

### KVM 側のログを有効にするかどうかは 1 つのフラグで決まる

`track_dirty_pages` が true のとき、ゲストメモリ領域は `AtomicBitmap` 付きで mmap される。そしてメモリスロットを KVM へ登録するとき、**ビットマップが存在するかどうかを見て** `KVM_MEM_LOG_DIRTY_PAGES` フラグを立てる。自前ビットマップと KVM 側ログの有効・無効は連動している。

### 書き出しは「連続する dirty ページをまとめて write、それ以外は seek」

ページごとに write すると syscall が爆発する。Firecracker はビットマップを走査しながら、dirty なページが続く限り書き込みサイズを積み上げ、clean なページに当たったところで一括 `write_all_volatile` する。clean なページ側は `seek(SeekFrom::Current(skip_size))` でカーソルを進めるだけなので、ファイルには **穴 (sparse hole)** が残る。

```
 ページ:   0    1    2    3    4    5    6    7
 dirty:    .    D    D    .    .    D    .    .
 動作:    seek───→ write(2 pages) ─→ seek──→ write(1) → seek(末尾まで)
 ファイル: hole [   data    ]  hole   [data]  hole
```

末尾が clean で終わった場合も seek でカーソルを進める。次のメモリスロットが正しいオフセットから書き始められるようにするためだ。

### dirty tracking が無効なら `mincore(2)` で近似する

`track_dirty_pages` を有効にすると KVM が dirty ログのためのコストを払い続ける。特に [huge pages](../hugepages/) を使っている場合、KVM は dirty tracking が有効だと**ホストが huge mapping を使っていてもゲストページテーブルを 4K 粒度で張る**ため、huge pages の利点がほぼ消える。

そこで Firecracker は、tracking を有効にしていない VM に対しても Diff スナップショットを許す。このとき dirty ビットマップの代わりに `mincore(2)` を使う。mincore は「そのページがコアに載っているか（ページキャッシュにあり、マイナーフォールトだけで解決できるか）」をページごとに 1 バイトで返す syscall だ。触られたページは常駐しているので、**書かれたページの集合は、常駐しているページの集合に含まれる**。つまり over-approximation になる。read しかしていないページも dirty 扱いで書き出されるので、スナップショットは大きくなるが、内容としては正しい。

ただしこれは **swap が無効な場合に限る**。書き込まれたページが swap out されていると mincore はそれを「コアにない」と報告し、本来書き出すべきページが落ちる。コード中の `TODO` コメントとドキュメントの両方に、この制約が明記されている。

### 書き込みに失敗したら dirty 情報を内部ビットマップへ戻す

`KVM_GET_DIRTY_LOG` はビットを取得すると同時にクリアする。ここでファイルへの書き出しが途中で失敗すると、「dirty だったという事実」だけが失われて、次回の差分スナップショットにそのページが含まれなくなる。Firecracker は書き出しがエラーになった場合に `store_dirty_bitmap` を呼び、KVM から取ったビットマップの内容を自前の `AtomicBitmap` へマージし直す。成功した場合だけ `reset_dirty()` で自前ビットマップをクリアする。

## ソースコードのどこか

メモリスロットを `kvm_userspace_memory_region` へ変換するところで、ビットマップの有無がそのまま KVM のフラグになる。

```rust title="src/vmm/src/vstate/memory.rs"
impl From<&GuestMemorySlot<'_>> for kvm_userspace_memory_region {
    fn from(mem_slot: &GuestMemorySlot) -> Self {
        let flags = if mem_slot.slice.bitmap().is_some() {
            KVM_MEM_LOG_DIRTY_PAGES
        } else {
            0
        };
```

[`src/vmm/src/vstate/memory.rs#L423-L438`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/vstate/memory.rs#L423-L438)

そのビットマップは `track_dirty_pages` から作られる（[`memory.rs#L364-L366`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/vstate/memory.rs#L364-L366)）。

ビットマップの収集側。ビットマップが付いていれば `KVM_GET_DIRTY_LOG`、付いていなければ `mincore_bitmap` にフォールバックする。

```rust title="src/vmm/src/vstate/vm.rs"
                let bitmap = match mem_slot.slice.bitmap() {
                    Some(_) => self
                        .fd()
                        .get_dirty_log(mem_slot.slot, mem_slot.slice.len())
                        .map_err(VmError::GetDirtyLog)?,
                    None => mincore_bitmap(
                        mem_slot.slice.ptr_guard_mut().as_ptr(),
                        mem_slot.slice.len(),
                    )?,
                };
```

[`src/vmm/src/vstate/vm.rs#L547-L566`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/vstate/vm.rs#L547-L566)

書き出しの本体。KVM のビットと自前のビットを OR して、連続 dirty を溜めてから write、clean は seek で飛ばす。

```rust title="src/vmm/src/vstate/memory.rs"
                let is_kvm_page_dirty = ((v >> j) & 1u64) != 0u64;
                let page_offset = ((i * 64) + j) * page_size;
                let is_firecracker_page_dirty = firecracker_bitmap.dirty_at(page_offset);
                ...
                if is_kvm_page_dirty || is_firecracker_page_dirty {
                    // We are at the start of a new batch of dirty pages.
                    if skip_size > 0 {
                        // Seek forward over the unmodified pages.
```

[`src/vmm/src/vstate/memory.rs#L441-L518`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/vstate/memory.rs#L441-L518)

エラー時の巻き戻し。`dump_dirty` の最後で結果を見て分岐する。

```rust title="src/vmm/src/vstate/memory.rs"
        if write_result.is_err() {
            self.store_dirty_bitmap(dirty_bitmap, page_size);
        } else {
            self.reset_dirty();
        }
```

[`src/vmm/src/vstate/memory.rs#L1046-L1080`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/vstate/memory.rs#L1046-L1080)

`mincore_bitmap` は mincore の 1 バイト/ページの出力を KVM 形式の 1 ビット/ページへ詰め直す。冒頭の TODO とコメントが制約を説明している。

```rust title="src/vmm/src/vstate/vm.rs"
/// Use `mincore(2)` to overapproximate the dirty bitmap for the given memslot. To be used
/// if a diff snapshot is requested, but dirty page tracking wasn't enabled.
fn mincore_bitmap(addr: *mut u8, len: usize) -> Result<Vec<u64>, VmError> {
    // TODO: Once Host 5.10 goes out of support, we can make this more robust and work on
    // swap-enabled systems, by doing mlock2(MLOCK_ONFAULT)/munlock() in this function (to
    // force swapped-out pages to get paged in, so that mincore will consider them incore).
```

[`src/vmm/src/vstate/vm.rs#L741-L774`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/vstate/vm.rs#L741-L774)

Diff とフルで挙動が分かれるのは `snapshot_memory_to_file` の 1 箇所だけである。Full は全体を書いたあとに KVM 側と自前ビットマップの両方をリセットし、次の差分の起点を張り直す。

```rust title="src/vmm/src/vstate/vm.rs"
        match snapshot_type {
            SnapshotType::Diff => {
                let dirty_bitmap = self.get_dirty_bitmap()?;
                self.guest_memory().dump_dirty(&mut file, &dirty_bitmap)?;
            }
            SnapshotType::Full => {
                self.guest_memory().dump(&mut file)?;
                self.reset_dirty_bitmap();
                self.guest_memory().reset_dirty();
            }
        };
```

[`src/vmm/src/vstate/vm.rs#L574-L634`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/vstate/vm.rs#L574-L634)

ホスト側の書き込みを自前ビットマップへ記録する側は、たとえば `IoVecBufferMut` を組み立てるときにある。iovec へ落とす前にマークしておかないと、あとから vm-memory の情報が失われてしまう。

```rust title="src/vmm/src/devices/virtio/iovec.rs"
            // We need to mark the area of guest memory that will be mutated through this
            // IoVecBufferMut as dirty ahead of time, as we loose access to all
            // vm-memory related information after converting down to iovecs.
            slice.bitmap().mark_dirty(0, desc.len as usize);
```

[`src/vmm/src/devices/virtio/iovec.rs#L278-L281`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/devices/virtio/iovec.rs#L278-L281)

## なぜそうなっているか

**mincore フォールバックが存在する理由は、dirty tracking の常時コストを避けたい利用者がいるから。** ドキュメントは明示的に、これが「実行時の dirty page logging のオーバーヘッドを避ける代わりに、メモリファイルが大きくなる（ただし依然スパースではある）」トレードオフだと書いている。

> If `track_dirty_pages` is not enabled, Firecracker uses the `mincore(2)` syscall to determine which pages to include in the snapshot. As such, this mode of snapshot taking will only work _if swap is disabled_, as mincore does not consider pages written to swap to be "in core".
>
> — [docs/snapshotting/snapshot-support.md](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/docs/snapshotting/snapshot-support.md)

さらに同じドキュメントは、dirty page tracking が huge pages の利点をほぼ打ち消すと注記している。[docs/hugepages.md](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/docs/hugepages.md#L74-L79) の Known Limitations によれば、理由は KVM が dirty tracking 有効時に無条件でゲストページテーブルを 4K 粒度で張るからだ。つまり mincore フォールバックは「huge pages と差分スナップショットを両立させたい」というケースへの答えでもある。

**mincore の粒度も注意点として明記されている。** コード中のコメントは、hugetlbfs の VMA に対しても mincore は常に PAGE_SIZE 粒度で動く（1 つの 2M ページが 512 個の 4K マーカーとして返る）と書いている。

**mlock2 での改善が保留されている理由もコメントに残っている。** swap 対応は `mlock2(MLOCK_ONFAULT)` で swap out されたページを強制的に読み戻せば可能だが、AMD の 5.10 ホストでスナップショット作成が 100% / 30ms 悪化したため採用されていない。制約を消すより、制約を文書化して選ばせる判断になっている。

**メモリファイルを truncate しない分岐にも理由がコメントされている。** Diff の場合は既存ファイルへ直接マージしたい。Full の場合も、そのファイルがまさにこの microVM の起動元スナップショットである可能性があり、truncate するとファイルの mmap 経由でゲストメモリがゼロ埋めされてしまう。だからサイズが一致する限り truncate しない。

## どう活かすか

**「変更検出の情報源が複数ある」設計は、そのまま持ち帰れる。** ハードウェアやカーネルが提供する変更追跡（ここでは KVM の dirty ログ）は、その層を通った変更しか見えない。自分のコードがその層を迂回して同じデータを書き換えているなら、迂回した分は自分で記録する責任がある。Firecracker が `IoVecBufferMut` の構築時点で「これから書く」領域を先にマークしているのは、書いた後では情報を持っていないからだ。**書く直前ではなく、書く権利を渡す時点でマークする** という順序は、非同期 I/O を挟む設計では有効なパターンになる。

**over-approximation を正式な代替手段として用意する判断も応用が利く。** 正確な変更追跡が高くつくとき、「安全側に倒した近似」は多くの場合実用に足る。ただし Firecracker が慎重なのは、その近似がいつ**安全側でなくなるか**（= swap 有効時）を特定し、コードコメント・API ドキュメント・運用ドキュメントの 3 箇所に書いている点だ。近似を導入するなら、近似が壊れる条件を同じ強さで文書化しないと、利用者は近似を精度の問題としか認識しない。

**一方、この設計が効く前提条件は狭い。** mincore フォールバックが成立するのは、(1) ホストの swap を無効にできる、(2) メモリファイルが大きくなってもディスクに余裕がある、(3) ゲストが read しかしていない領域を無駄に書き出しても許容できる、という運用が揃っている場合だ。ホストの swap 設定を握れない環境や、差分サイズが直接コストになる環境（差分をネットワーク転送する等）では、素直に `track_dirty_pages` を有効にするほうがよい。Firecracker 自身も [prod-host-setup.md](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/docs/prod-host-setup.md#L274-L286) で swap の無効化を（別の理由からだが）推奨しており、ホスト構成を握れる前提の上に成り立っている機能だと分かる。

**スパースファイルへの seek と write の組み合わせは、独自フォーマットを避けたいときの選択肢になる。** 「どのオフセットが有効か」をファイルシステムのホール情報として持たせれば、差分フォーマットを設計せずに済む。この判断の続きは [差分レイヤーを sendfile でスパースに合成する](../snapshot-rebase/) で扱う。

---
title: "復元を、ファイルの MAP_PRIVATE mmap で済ませる"
description: "スナップショットからのゲストメモリ復元でファイルバックエンドを選ぶと、Firecracker はメモリファイルを MAP_PRIVATE で mmap するだけで終わる。ページはカーネルの通常のフォルト機構でオンデマンドに入り、書き込みは COW で匿名ページに落ちる。実装が数行で済む代わりに、ページの供給元を制御できず hugetlbfs とも併用できない。"
group: "スナップショット"
sidebar:
  order: 44
---

## 何を学んだか

### 復元処理にメモリのコピーが出てこない

`PUT /snapshot/load` の `mem_backend.backend_type` には `File` と `Uffd` の 2 つがある。`File` を選んだときにゲストメモリを用意するコードは、実質 3 行しかない。

```rust
let mem_file = File::open(mem_file_path)?;
let guest_mem = memory::snapshot_file(mem_file, mem_state.regions(), track_dirty_pages, huge_pages)?;
Ok(guest_mem)
```

`snapshot_file()` がやるのは `mmap(..., MAP_PRIVATE, fd, offset)` である。**ファイルの中身を読む処理はどこにもない。**

```
[ snapshot の mem_file (ディスク上) ]
            │  mmap(MAP_PRIVATE)
            ▼
[ Firecracker の仮想アドレス空間 ]  <- この時点で物理ページは 0 枚
            │  KVM_SET_USER_MEMORY_REGION
            ▼
[ ゲスト物理アドレス空間 ]

  ゲストが未マップのページを読む
     -> EPT violation -> ホストのページフォルト
     -> カーネルがページキャッシュからページを供給（無ければディスクから読む）

  ゲストがそのページに書く
     -> COW でコピーが作られ、匿名ページに置き換わる
     -> 元のファイルは変更されない
```

つまり **復元とは「マッピングを張ること」であって「ロードすること」ではない**。ドキュメントもこの点を明示している。

> instead of loading at resume time the full contents from file to memory, Firecracker creates a MAP_PRIVATE mapping of the memory file, resulting in runtime on-demand loading of memory pages. Any subsequent memory writes go to a copy-on-write anonymous memory mapping.

### 通常起動と復元でメモリの素性が違う

同じ `create()` を通るが、フラグが違う。

|                                        | mmap フラグ                    | ファイル                                       |
| -------------------------------------- | ------------------------------ | ---------------------------------------------- |
| 通常起動 (`anonymous`)                 | `MAP_PRIVATE \| MAP_ANONYMOUS` | なし                                           |
| memfd 使用 (`memfd_backed`)            | `MAP_SHARED`                   | memfd                                          |
| スナップショット復元 (`snapshot_file`) | `MAP_PRIVATE`                  | メモリファイル                                 |
| UFFD 復元                              | `MAP_PRIVATE \| MAP_ANONYMOUS` | なし（[`../uffd-handler/`](../uffd-handler/)） |

**UFFD 方式は匿名メモリを確保する点で通常起動と同じである。** 違うのは、そこに userfaultfd を登録して外部プロセスにページ供給を任せる点だけだ。ファイル方式だけがファイルバックのマッピングになる。

### この方式の利点

- **実装がほぼゼロ。** ページの供給はカーネルがやる。Firecracker が書くのは mmap のフラグだけ。
- **復元が速い。** 数 GB のメモリでも mmap 自体は一瞬で返る。
- **ページキャッシュが共有される。** 同じベースメモリファイルから複数の microVM を起動すると、まだ書き込まれていないページはホストのページキャッシュ上の同じ物理ページを共有する。COW なので、書き込んだ microVM だけが自分のコピーを持つ。同じスナップショットから大量のクローンを作るワークロードでは、これがそのままメモリ節約になる。

### この方式の限界

- **ページの供給元を制御できない。** どのページをいつ、どこから持ってくるかはカーネルが決める。プリフェッチしたい、ネットワーク越しに取ってきたい、暗号化されたファイルから復号しながら埋めたい、といった要求には応えられない。
- **hugetlbfs と併用できない。** `MAP_HUGETLB` は匿名マッピングか hugetlbfs 上のファイルにしか使えず、通常のファイルの `MAP_PRIVATE` マッピングには付けられない。Firecracker は `File` バックエンドと hugetlbfs の組み合わせを明示的にエラーにし、「UFFD を使え」とメッセージで案内する。
- **メモリファイルを microVM の寿命の間ずっと保持し続けなければならない。** ページはオンデマンドで読まれるので、途中でファイルを消すと死ぬ。
- **ゲストのメモリ解放が素直にいかない。** [balloon](../balloon-zeroing/) がページを返すとき、ファイルバックのプライベートマッピングに `madvise(MADV_DONTNEED)` を掛けると、匿名ページは落ちるが**次に読んだときファイルの中身が再び現れる**。ゼロにならない。Firecracker はこのケースだけ、匿名マッピングを `MAP_FIXED` で上書きするという回避策を取っている。

## ソースコードのどこか

バックエンドの分岐は [`src/vmm/src/persist.rs#L455-L481`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/persist.rs#L455-L481)。hugetlbfs の拒否がここに埋まっている。

```rust title="src/vmm/src/persist.rs"
    let (guest_memory, uffd) = match params.mem_backend.backend_type {
        MemBackendType::File => {
            if vm_resources.machine_config.huge_pages.is_hugetlbfs() {
                return Err(RestoreFromSnapshotGuestMemoryError::File(
                    GuestMemoryFromFileError::HugetlbfsSnapshot,
                )
                .into());
            }
```

エラーの表示文字列は型定義側にある（[`src/vmm/src/persist.rs#L517-L526`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/persist.rs#L517-L526)）。`displaydoc` で doc コメントがそのままメッセージになる。

```rust title="src/vmm/src/persist.rs"
    /// Cannot restore hugetlbfs backed snapshot by mapping the memory file. Please use uffd.
    HugetlbfsSnapshot,
```

**「できない」だけでなく「代わりに何を使うか」まで書いてある。** 制約が API の設計から来ているので、ユーザには回避手段しか残されていない。

ファイル方式の本体は [`src/vmm/src/persist.rs#L528-L538`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/persist.rs#L528-L538) と、その先の [`src/vmm/src/vstate/memory.rs#L900-L928`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/vstate/memory.rs#L900-L928)。

```rust title="src/vmm/src/vstate/memory.rs"
pub fn snapshot_file(
    file: File,
    regions: impl Iterator<Item = (GuestAddress, usize)>,
    track_dirty_pages: bool,
    huge_pages: HugePageConfig,
) -> Result<Vec<GuestRegionMmap>, MemoryError> {
    let regions: Vec<_> = regions.collect();
    let memory_size = regions
        .iter()
        .try_fold(0u64, |acc, (_, size)| acc.checked_add(*size as u64))
        .ok_or(MemoryError::OffsetTooLarge)?;
    let file_size = file.metadata().map_err(MemoryError::FileMetadata)?.len();

    // ensure we do not mmap beyond EOF. The kernel would allow that but a SIGBUS is triggered
    // on an attempted access to a page of the buffer that lies beyond the end of the mapped file.
    if memory_size > file_size {
        return Err(MemoryError::OffsetTooLarge);
    }

    create(
        regions.into_iter(),
        libc::MAP_PRIVATE,
        Some(file),
        track_dirty_pages,
        huge_pages.madvise_flags(),
    )
}
```

関数の大半が EOF チェックである。**カーネルは EOF を超える mmap を許すが、その範囲に触ると SIGBUS が飛ぶ。** ページフォルトを踏むのは vCPU スレッドなので、そこで SIGBUS が出ると原因が非常に追いにくい。事前に metadata のサイズと比べて弾く、という 4 行が入っている。

比較のため、通常起動側は [`src/vmm/src/vstate/memory.rs#L885-L898`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/vstate/memory.rs#L885-L898)。フラグ以外は同じ `create()` を呼ぶ。

```rust title="src/vmm/src/vstate/memory.rs"
pub fn anonymous(
    regions: impl Iterator<Item = (GuestAddress, usize)>,
    track_dirty_pages: bool,
    huge_pages: HugePageConfig,
) -> Result<Vec<GuestRegionMmap>, MemoryError> {
    create(
        regions,
        libc::MAP_PRIVATE | libc::MAP_ANONYMOUS | huge_pages.mmap_flags(),
        None,
        track_dirty_pages,
        huge_pages.madvise_flags(),
    )
}
```

`snapshot_file` 側で `huge_pages.mmap_flags()` を渡していないのが目に付く。ファイルマッピングに `MAP_HUGETLB` を渡せないからで、前述の拒否と対になっている。`madvise_flags()`（THP 用の `MADV_HUGEPAGE`）だけは渡している。

balloon 由来の回避策は [`src/vmm/src/vstate/memory.rs#L726-L755`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/vstate/memory.rs#L726-L755)。条件が「ファイルがあり、かつ MAP_PRIVATE」で、コメントが「スナップショットファイルから復元したときに限り必要」と明言している。

```rust title="src/vmm/src/vstate/memory.rs"
            // If and only if we are resuming from a snapshot file, we have a file and it's mapped
            // private
            (Some(_), flags) if flags & libc::MAP_PRIVATE != 0 => {
                // Mmap a new anonymous region over the present one in order to create a hole
                // with zero pages.
                // This workaround is (only) needed after resuming from a snapshot file because the
                // guest memory is mmaped from file as private. In this case, MADV_DONTNEED on the
                // file only drops any anonymous pages in range, but subsequent accesses would read
                // whatever page is stored on the backing file. Mmapping anonymous pages ensures
                // it's zeroed.
```

### 復元全体の流れ

メモリは復元の一部でしかない。入口は [`src/vmm/src/persist.rs#L377-L493`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/persist.rs#L377-L493) の `restore_from_snapshot()` である。

```
restore_from_snapshot()
  1. snapshot_state_from_file()        状態ファイルを読み、MicrovmState に戻す
  2. network_overrides を適用           tap 名を差し替える
  3. vsock_override を適用              UDS パスを差し替える
  4. update_machine_config()           vCPU 数・メモリサイズ等をスナップショットの値に合わせる
  5. snapshot_state_sanity_check()     メモリ領域と CPU ベンダを検証
  6. guest_memory_from_file/uffd()     ゲストメモリを用意
  7. build_microvm_from_snapshot()     KVM とデバイスを組み立てる
```

2 と 3 が入っているのは、**状態ファイルが外部リソースを名前で参照している**からだ。tap デバイス名やホスト側 UDS のパスは、復元先のホストでは違う名前になっているかもしれない。そこで API で上書きできるようにしてある（[`src/vmm/src/vmm_config/snapshot.rs#L61-L76`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/vmm_config/snapshot.rs#L61-L76)）。上書きの実装は、シリアライズされたデバイス状態の中の文字列を直接書き換えるという素朴なものである（[`src/vmm/src/persist.rs#L385-L425`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/persist.rs#L385-L425)）。

5 の `snapshot_state_sanity_check()` は [`src/vmm/src/persist.rs#L313-L352`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/persist.rs#L313-L352)。

```rust title="src/vmm/src/persist.rs"
    // Check that the snapshot contains at least 1 mem region, that at least one is Dram,
    // and that Dram region contains a single plugged slot.
    // Upper bound check will be done when creating guest memory by comparing against
    // KVM max supported value kvm_context.max_memslots().
    let regions = &microvm_state.vm_state.memory.regions;
```

見ているのは、領域が 1 つ以上あること、DRAM 領域が存在すること、DRAM 領域のスロットが 1 つで plugged であること（[virtio-mem](../virtio-mem/) 由来の領域と区別している）。**上限はここでは見ない**とコメントが断っており、KVM のメモリスロット数との比較は実際に領域を登録する段階に任せている。同じ関数の末尾で x86_64 なら `validate_cpu_vendor()` を呼ぶが、これはベンダが違っても `warn!` を出すだけで、**エラーにはしない**（[`src/vmm/src/persist.rs#L237-L262`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/persist.rs#L237-L262)）。

7 の `build_microvm_from_snapshot()` は [`src/vmm/src/builder.rs#L427-L538`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/builder.rs#L427-L538)。順序は「KVM 生成 → vCPU 生成 → メモリ領域登録 → TSC スケーリング → vCPU 状態復元 → KVM VM 状態復元 → デバイス復元 → vCPU スレッド起動（Paused）」である。メモリ領域を KVM スロットに登録するのは [`src/vmm/src/vstate/vm.rs#L495-L517`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/vstate/vm.rs#L495-L517) で、ここでもファイルバックか匿名かは一切区別されない。**KVM から見れば、どちらもただのホスト仮想アドレスである。**

## なぜそうなっているか

### KVM のメモリ登録がホスト仮想アドレスしか見ないから成立する

`KVM_SET_USER_MEMORY_REGION` に渡すのはホスト側の仮想アドレスと長さである（[`../guest-memory/`](../guest-memory/)）。そのアドレスの裏に物理ページが存在するかどうかを KVM は問わない。ゲストがアクセスして EPT violation が起きたとき、ホスト側でページフォルトが発生し、通常のプロセスと同じ機構でページが供給される。

**この性質があるおかげで「メモリの中身をどう用意するか」を KVM の外側の問題に切り離せる。** ファイルを mmap するのも、匿名で確保するのも、userfaultfd を登録するのも、KVM 側のコードは 1 行も変わらない。ファイル方式が数行で済んでいるのは、この層の分離が効いているからだ。

### fsync の話とページキャッシュの話が繋がっている

[`../snapshot-format/`](../snapshot-format/) で見た `sync_snapshot_files` は、false にすると「データはホストのページキャッシュに残るので、同一ホストからの読み出しは完全な内容が見える」とドキュメントが書いている。復元がページキャッシュ経由の読み出しである以上、**保存直後に同じホストで復元するなら、ディスクに書き戻す必要すらない**。保存側の選択と復元側の仕組みが同じページキャッシュを介して繋がっている。

### 「ページ供給元を制御できない」が UFFD の存在理由

ファイル方式で困るのは、次のような要求である。

- 復元直後にまとめてページを埋めたい（フォルトのテールレイテンシを潰したい）。
- ページをリモートストレージから取りたい。
- hugetlbfs で 2MB ページを使いたい。
- どのページがいつ触られたかを観測したい。

いずれも「フォルトが起きたときに何が起きるか」を自分で決めたい、という要求である。カーネルに任せている限り介入点がない。**そこで介入点をプロセス境界として切り出したのが UFFD 方式である**（[`../uffd-handler/`](../uffd-handler/)）。API 上は `backend_type` の 1 フィールドで切り替わるが、性質はまったく違う。

### hugetlbfs の制約は Linux 側の都合

`MAP_HUGETLB` は匿名マッピングか hugetlbfs 上のファイルにしか使えない。スナップショットのメモリファイルは通常のファイルシステム上にあるので、そのまま huge page でマップすることはできない。一方 UFFD 方式は匿名マッピング（`MAP_HUGETLB` 可）を作るので問題にならない。

**Firecracker はこれを「サポート表の脚注」ではなく、実行時のエラーと明示的な案内文にした。** `docs/snapshotting/snapshot-support.md` にも「Explicit `2M` hugetlbfs pages require the `Uffd` backend, so combining `2M` with `File` returns an error」と書かれている。組み合わせの制約は API のドキュメントとコードの両方に置いてある。

## どう活かすか

### 「読み込む」を「マップする」に置き換えられないか考える

大きなデータを起動時にロードする処理があるとき、**本当にすべてを読む必要があるか**を疑う価値がある。mmap に置き換えられるなら、次が同時に手に入る。

- 起動時間が O(データサイズ) から O(1) に落ちる。
- 実際に触られたページだけがメモリに乗る（触られない部分にはコストがかからない）。
- 同じファイルを使う複数プロセスでページキャッシュが共有される。

この 3 つ目が Firecracker では特に重要で、「同じベーススナップショットから数百の microVM を起動する」という使い方が成立する根拠になっている。

置き換えられない条件も明確である。**データを解釈しながら読む必要がある（デコード・復号・エンディアン変換）なら mmap は使えない。** Firecracker のメモリファイルが「ゲスト物理アドレス空間そのままの生ダンプ」であることが前提になっている。フォーマットを素朴に保ったことが、この最適化を可能にしている。

### 遅延ロードのコストは「後で、どこかで」払う

mmap で復元が速くなるのは、コストを払っていないからではなく、**払うタイミングを分散して後ろにずらしている**からだ。実行中の vCPU スレッドがページフォルトで止まる。これは平均レイテンシではなくテールレイテンシに出る。

判断材料は次のとおりである。

- **触られるページの割合が低いなら得。** 全ページを触るワークロードなら、遅延ロードは合計コストを減らさない。
- **フォルトのレイテンシが許容できるか。** ローカル SSD のページキャッシュミスなら数十 µs だが、ネットワークストレージなら桁が変わる。
- **ファイルの寿命を管理できるか。** マッピングが生きている間、ファイルを消せない。ライフサイクルの結合が増える。

Firecracker はこれらを許容したうえで、許容できない人向けに UFFD という別の道を用意した。**「デフォルトは単純な方、要求が厳しい人には拡張点」という構成である。**

### 特殊なマッピングを選んだら、その帰結を全部洗い出す

`MAP_PRIVATE` のファイルマッピングを選んだ結果、`madvise(MADV_DONTNEED)` の意味が変わり、balloon の実装に条件分岐が 1 つ増えた。`MAP_HUGETLB` が使えなくなり、API の組み合わせに制約が 1 つ増えた。EOF を超える mmap が SIGBUS になるので、事前チェックが 1 つ増えた。

**マッピングの種類は「メモリをどう確保するか」だけの話に見えて、そのメモリに対する後続の操作すべてに波及する。** Firecracker のコードでは、その波及先に必ず「なぜここで分岐しているか」のコメントが付いている。同種の選択をするときは、`madvise` 系の挙動、シグナル、ページ会計、fork 時の扱いを一通り確認しておくのが安い。

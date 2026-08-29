---
title: "hugepages と dirty page tracking は両立しない"
description: "ゲストメモリを 2 MiB ページで確保すると TLB ミスと EPT 構築のコストが下がって起動が速くなる。だが差分スナップショットのために dirty page tracking を有効にすると、KVM は 4 KiB 粒度でページテーブルを張り直すので利点が消える。さらに 2M は UFFD 復元が必須でファイルバックエンドと併用できない。性能設定と運用機能が排他になる構図を読む。"
group: "メモリを伸縮させる"
sidebar:
  order: 40
---

## 何を学んだか

### 3 つのモードと、それぞれが実際に呼ぶシステムコール

Firecracker の `/machine-config` には `huge_pages` というフィールドがあり、取れる値は 3 つしかない。

| 値             | mmap に足すフラグ             | mmap 後の madvise | ページサイズ | メモリサイズ制約 |
| -------------- | ----------------------------- | ----------------- | ------------ | ---------------- |
| `None`（既定） | なし                          | なし              | 4096         | なし             |
| `Transparent`  | なし                          | `MADV_HUGEPAGE`   | 4096         | 2 MiB の倍数     |
| `2M`           | `MAP_HUGETLB \| MAP_HUGE_2MB` | なし              | 2 MiB        | 2 MiB の倍数     |

`Transparent` は THP をカーネルに「使ってよい」と伝えるだけで、実際に 2 MiB ページが来るかはカーネル任せである。だから `page_size()` は 4096 を返す。`2M` は hugetlbfs のプールから確保するので、確保できなければ失敗する（正確には後述のとおり `MAP_NORESERVE` のせいで、失敗はアクセス時の `SIGBUS` として現れる）。

### なぜ速くなるか

[ゲストメモリのページ](../guest-memory/) で見たとおり、ゲスト物理メモリはホストプロセスの mmap であり、`KVM_SET_USER_MEMORY_REGION` でメモリスロットとして登録される。ゲストが初めてあるゲスト物理アドレスに触ると、ハードウェアは EPT（拡張ページテーブル）に変換エントリが無いことを検出して VM exit し、KVM がホスト側のページフォールトを起こしてページを割り当て、EPT にエントリを張る。

4 KiB ページなら 1 GiB のゲストメモリを一通り触るのに 262144 回この処理が要るが、2 MiB ページなら 512 回で済む。TLB のエントリ 1 個がカバーする範囲も 512 倍になる。`docs/hugepages.md` は効果として TLB 競合の削減、アドレス変換のオーバーヘッド削減、そして **スナップショット復元後に EPT を再構築するのに必要な VM exit の削減** を挙げ、起動時間は「boot time performance tests の計測で最大 50% 改善」と書いている。

### 主題：dirty page tracking を有効にすると効果が消える

`docs/hugepages.md` の Known Limitations にこう書いてある。

> Enabling dirty page tracking for hugepage memory negates the performance benefits of using huge pages. This is because KVM will unconditionally establish guest page tables at 4K granularity if dirty page tracking is enabled, even if the host uses huge mappings.
> — [`docs/hugepages.md`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/docs/hugepages.md)

dirty page tracking（`KVM_MEM_LOG_DIRTY_PAGES`）は「ゲストがどのページを書き換えたか」をビットマップで記録する機能で、[差分スナップショット](../diff-snapshot/) の前提になる。前回のスナップショット以降に書き換わったページだけを書き出すために使う。

ビットマップの粒度は 4 KiB である。KVM が 2 MiB の EPT エントリを 1 個張ってしまうと、その 2 MiB のうちどこが書き換わったかを区別できない。だから dirty logging を有効にしたスロットでは、KVM は huge mapping を分解して 4 KiB 粒度で EPT を張る。ホスト側の VMA が hugetlbfs でも関係ない。**ページテーブルの構築コストも TLB カバレッジも 4 KiB のときと同じに戻る** ので、hugepages を指定した意味がなくなる。

Firecracker のコードでも、ダーティページの走査は一貫してホストのページサイズ（4096）で行われている。`huge_pages.page_size()` が 2 MiB を返す設定でも、`dump_dirty` に渡すのは `host_page_size()` である。

### さらに 2M は UFFD 復元が必須

ファイルバックエンドでの復元は、スナップショットのメモリファイルを `MAP_PRIVATE` で mmap する。この mmap に `MAP_HUGETLB` は付けられない（通常のファイルは hugetlbfs 上に無い）ので、2 MiB ページでバックされた VM をファイルバックエンドで 2 MiB ページのまま復元することはできない。Firecracker はこれをエラーとして明示的に弾く。エラー型は `GuestMemoryFromFileError::HugetlbfsSnapshot` で、メッセージは「Cannot restore hugetlbfs backed snapshot by mapping the memory file. Please use uffd.」である。

一方 `Transparent` は UFFD と組み合わせても弾かれない。ただし `docs/hugepages.md` は「THP does not integrate with UFFD; no transparent huge pages will be allocated during userfault-handling while resuming from a snapshot」と書いている。UFFD 経由で埋めたページに THP は付かないので、**受け付けはするが効果は限定的** という状態になる。

まとめると、こういう排他関係になっている。

```
                  None      Transparent      2M (hugetlbfs)
起動高速化         -         限定的            大きい
diff スナップ      OK        OK（利点は消える） OK（利点は消える）
ファイル復元       OK        OK                エラー
UFFD 復元          OK        OK（THP は付かない） 必須
vhost-user(memfd)  OK        shmem THP の設定次第 OK
```

## ソースコードのどこか

### 設定が何に変換されるか

`HugePageConfig` は 3 値の列挙で、mmap フラグと madvise フラグを返すメソッドを持つだけの薄い型である。

```rust title="src/vmm/src/vmm_config/machine_config.rs"
    /// Returns the flags required to pass to `mmap`, in addition to `MAP_ANONYMOUS`, to
    /// create a mapping backed by huge pages as described by this [`HugePageConfig`].
    pub fn mmap_flags(&self) -> libc::c_int {
        match self {
            HugePageConfig::None | HugePageConfig::Transparent => 0,
            HugePageConfig::Hugetlbfs2M => libc::MAP_HUGETLB | libc::MAP_HUGE_2MB,
        }
    }

    /// Returns the flags required to pass to [libc::madvise], after allocating anonymous guest memory.
    /// Note: returning [libc::MADV_NORMAL] might skip the call to `madvise` entirely.
    pub fn madvise_flags(&self) -> libc::c_int {
        match self {
            HugePageConfig::Transparent => libc::MADV_HUGEPAGE,
            HugePageConfig::None | HugePageConfig::Hugetlbfs2M => libc::MADV_NORMAL,
        }
    }
```

[`src/vmm/src/vmm_config/machine_config.rs#L64-L80`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/vmm_config/machine_config.rs#L64-L80)

`Transparent` は mmap のフラグを変えず、確保後に `madvise` するだけ。`2M` は mmap のフラグで決まり、`madvise` は不要。この 2 つが完全に別経路であることが型のレベルで見える。

確保側（[`src/vmm/src/vstate/memory.rs#L826-L865`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/vstate/memory.rs#L826-L865)）はこの 2 つを順に適用し、`madvise_flags != libc::MADV_NORMAL` のときだけ `madvise` を呼ぶ。呼び出し側は 3 つあり、`anonymous()` は `MAP_PRIVATE | MAP_ANONYMOUS | huge_pages.mmap_flags()`、`memfd_backed()` は `MAP_SHARED | huge_pages.mmap_flags()`（memfd 自体も `HugetlbSize::Huge2MB` で作る）、そして `snapshot_file()` は `MAP_PRIVATE` のみで **`mmap_flags()` を渡していない**（[`#L868-L928`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/vstate/memory.rs#L868-L928)）。ファイル復元では hugetlb フラグを付けようがない、という事実がここに現れている。

すべての確保経路が `MAP_NORESERVE` を付ける点にも注意が要る。`docs/hugepages.md` は「Should this pool be too small, Firecracker may behave erratically or receive the `SIGBUS` signal. This is because Firecracker uses the `MAP_NORESERVE` flag」と名指しで警告している。mmap の時点でプールを予約しないので、`mmap` は成功してもゲストが触った瞬間にプールが枯れていれば `SIGBUS` になる。

なお `allocate_protected`（[`#L116-L256`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/vstate/memory.rs#L116-L256)）は、`huge_pages` の設定に関わらず全ゲストメモリ領域を 2 MiB 境界に揃える。大きめに mmap して先頭と末尾を `munmap` で削る方式で、hugetlb のときはカーネルが元から揃えて返すので余分な確保が要らない、とコメントが説明している。境界が揃っていないと THP も hugetlbfs も効かないので、既定設定でも将来の切り替えに備えてある形になっている。

### dirty tracking のフラグが立つ場所

KVM に渡す構造体を組み立てるところで、ビットマップの有無から `KVM_MEM_LOG_DIRTY_PAGES` を決める。

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

`track_dirty_pages` が true のときだけ領域に `AtomicBitmap` が付き、その有無がそのままフラグになる。ここには hugepages に関する分岐が一切無い。**設定として組み合わせられてしまう** ので、性能が出ないことにはユーザーが気付きにくい。だからこそドキュメントの Known Limitations に書いてある。

ダンプ側も 4 KiB で走る。

```rust title="src/vmm/src/vstate/memory.rs"
        let page_size = host_page_size();
```

[`src/vmm/src/vstate/memory.rs#L1052`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/vstate/memory.rs#L1052) から `dump_dirty(writer, kvm_bitmap, page_size)` に渡される。KVM が返すビットマップが 4 KiB 単位である以上、`huge_pages` の設定に関わらずここは 4096 でなければならない。

### hugetlbfs × ファイル復元を弾く

```rust title="src/vmm/src/persist.rs"
        MemBackendType::File => {
            if vm_resources.machine_config.huge_pages.is_hugetlbfs() {
                return Err(RestoreFromSnapshotGuestMemoryError::File(
                    GuestMemoryFromFileError::HugetlbfsSnapshot,
                )
                .into());
            }
```

[`src/vmm/src/persist.rs#L455-L473`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/persist.rs#L455-L473)

エラー型の定義は [`persist.rs#L517-L526`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/persist.rs#L517-L526)、この分岐を守るテストは [`src/vmm/tests/integration_tests.rs#L368-L405`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/tests/integration_tests.rs#L368-L405) の `test_load_snapshot_rejects_hugetlbfs_with_file_backend` である。

判定に使う `huge_pages` は、復元リクエストの値とスナップショットに保存された値を `resolve` した結果である。`PUT /snapshot/load` の `huge_pages` を省略すると `Snapshot`（保存時の設定を再利用）になるので、**2M で取ったスナップショットをファイルバックエンドで読もうとすると、何も指定しなくてもここで弾かれる**。

[UFFD 経路](../uffd-handler/) では、ハンドシェイクで領域ごとのページサイズをハンドラに伝える。

```rust title="src/vmm/src/persist.rs"
            page_size: huge_pages.page_size(),
            page_size_kib: huge_pages.page_size(),
```

[`src/vmm/src/persist.rs#L589-L610`](https://github.com/firecracker-microvm/firecracker/blob/cc535f035f3828b2c5bfc85276c5d394022ed220/src/vmm/src/persist.rs#L589-L610)

UFFD のページ供給は登録時のページサイズ単位で行う必要があるので、ハンドラ側は 2 MiB 単位で `UFFDIO_COPY` しなければならない。ページサイズを外部プロセスに渡しているのはそのためである。

## なぜそうなっているか

**制約はどれも Firecracker の外側から来ている。** dirty logging と huge mapping が両立しないのは KVM（というより EPT のダーティビットの粒度）の性質であり、hugetlbfs をファイル mmap にできないのは Linux の mmap の性質、THP が UFFD 経路で付かないのもカーネルの実装である。Firecracker にできるのは、(1) 組み合わせが不正なら明示的なエラーで弾く、(2) 不正ではないが効果が消える組み合わせはドキュメントに書く、の 2 つだけである。実際そう分かれている。ファイル復元 × 2M は型付きエラーとテストで塞がれ、dirty tracking × hugepages はコードに分岐が無く Known Limitations に書かれている。

**弾けるものだけ弾いているのには理屈がある。** ファイル復元 × 2M は「動かない」ので実行時に失敗する。ここでエラーにしないと、SIGBUS か黙った不整合になる。一方 dirty tracking × hugepages は「動くが遅い」だけなので、弾いてしまうと正当なユースケース（性能はある程度諦めて差分スナップショットを取りたい）を潰す。**正しさの問題と性能の問題を、エラーとドキュメントに振り分けている。**

**balloon との組み合わせも同じ構図で文書化されている。** `docs/hugepages.md` は「The traditional balloon device reports free pages at 4k granularity, this means the device is unable to reclaim the hugepage backing of the guest and drop RSS」と書いている。[balloon のページ](../balloon-zeroing/) で見たとおり `VIRTIO_BALLOON_PFN_SHIFT` は 12 固定で、これは virtio の仕様である。2 MiB ページの一部だけを `MADV_DONTNEED` しても、hugetlbfs のページは分割できないので解放されない。ここでもエラーにはせず、「inflate してゲストの使用量を制限することはできる」と but 付きで書いている。

## どう活かすか

**「性能のための設定」と「運用機能のための設定」が排他になる場面では、どちらが先に決まるかで判断する。** 差分スナップショットを使うかどうかは、運用のアーキテクチャ（どのくらいの頻度で、どのくらいの粒度で状態を保存するか）の決定であって、あとから変えにくい。一方 hugepages は起動性能の話で、必要なら諦めが効く。Firecracker のケースなら、

- **起動レイテンシが最優先で、スナップショットはフルのみ、UFFD ハンドラを自前で持っている**なら `2M` を選ぶ。プールの事前確保という運用コストを払う価値がある。
- **差分スナップショットを回す**なら `huge_pages` は `None` でよい。`2M` を指定しても効果が消えるだけで、hugetlbfs プールの管理コストと `SIGBUS` のリスクだけが残る。
- **どちらとも決めきれない**なら `Transparent`。プールの事前確保が要らず、ファイル復元も通り、効かないときは静かに 4 KiB に落ちる。効果は小さいが、失敗モードが増えない。

**組み合わせの禁止を「型付きのエラー + テスト」で表現するのは真似する価値がある。** `HugetlbfsSnapshot` は単なる文字列エラーではなく専用のバリアントで、エラーメッセージが「Please use uffd.」と次の行動まで書いてある。しかも `test_load_snapshot_rejects_hugetlbfs_with_file_backend` がその分岐を守っている。設定の組み合わせ爆発が避けられないシステムでは、**不正な組み合わせに名前を付けてテストで固定する** ことで、後から片方の設定を触った人が気付ける。

**「動くが意味がない」組み合わせをどう扱うかは設計判断になる。** 選択肢はエラーにする・警告を出す・ドキュメントに書くの 3 つだが、**設定が正当なユースケースを持つなら弾いてはいけない**ので、実質は後ろ 2 つになる。Firecracker は警告ログすら出さず Known Limitations だけで済ませている。

**取り込むべきでない条件。** hugetlbfs プールはホスト全体の共有資源で、起動時か `sysctl` で確保する。マルチテナントのホストで複数の VMM が奪い合う構成では、`MAP_NORESERVE` のせいで「mmap は通ったが実行中に SIGBUS」という最悪の失敗モードになる。プールのサイジングを自分で管理できないなら `2M` は選ぶべきではない。また vhost-user を使う構成では memfd バックになるので、`Transparent` の効果は `/sys/kernel/mm/transparent_hugepage/shmem_enabled` の設定次第になり、既定では有効になっていないことが多い、とドキュメントが注意している。

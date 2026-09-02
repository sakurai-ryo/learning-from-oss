---
title: "storage_scrubber — S3 の整合性を外から検査する"
description: "pageserver がオンラインで解けない問題を、オフラインのバッチが引き受ける。S3 のオブジェクトを歩き、control plane と突き合わせ、レイヤマップの構造まで検証する。そして削除は 2 段階に分けてある。"
group: "検証と運用"
sidebar:
  order: 57
---

## 何を学んだか

```markdown title="storage_scrubber/README.md"
This tool directly accesses the S3 buckets used by the Neon `pageserver`
and `safekeeper`, and does housekeeping such as cleaning up objects for tenants & timelines that no longer exist.
```

([storage_scrubber/README.md](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/storage_scrubber/README.md))

[remote_timeline_client](../remote-timeline-client/) で、オブジェクトが漏れることを許容していた。**「リモートにだけあるファイル」が、漏れたゴミなのか、まだダウンロードしていない正常なファイルなのか、pageserver には区別できない。**

区別できるのは、**pageserver の外から見た者**だ。scrubber は S3 と control plane の両方を見る。

## find と purge を分ける

```markdown title="storage_scrubber/README.md"
This command outputs a JSON file describing tenants and timelines to remove, for subsequent
processing by the `purge-garbage` subcommand.
```

**検出と削除が別のコマンドになっている。** 間に人間のレビューが入る。

そして削除にはさらにフラグが要る。

```markdown title="storage_scrubber/README.md"
Add the `--delete` argument before `purge-garbage` to enable deletion. This is intentionally
not provided inline in the example above to avoid accidents. Without the `--delete` flag
the purge command will log all the keys that it would have deleted.
```

**「事故を避けるため、意図的にサンプルコマンドに含めていない」。** README のサンプルをコピペしても消えない。

**取り返しのつかない操作の安全策を、3 段重ねにしている。** 別コマンド、明示フラグ、そしてドキュメントでの非提示。

削除の対象にも段階がある。

```markdown title="storage_scrubber/README.md"
- `--mode`: controls whether to purge only garbage that was specifically marked
  deleted in the control plane (`deletedonly`), or also to purge tenants/timelines
  that were not present in the control plane at all (`deletedandmissing`)
```

**「削除済みと記録されているもの」と「control plane に存在しないもの」は別。** 後者は、control plane 側のバグかもしれないし、scrubber が古い情報を見ているのかもしれない。**「知らない」を「消してよい」と解釈しない。**

## 中間ファイルの形式は安定していない

```markdown title="storage_scrubber/README.md"
**Note that the garbage list format is not stable. The output of `find-garbage` is only
intended for use by the exact same version of the tool running `purge-garbage`**
```

**「まったく同じバージョンのツールでしか使えない」と大文字で書いてある。**

中間形式に互換性を持たせないことで、実装を自由に変えられる。**外部インターフェースにしない**という宣言が、ドキュメントの一部として明示されている。

## レイヤマップの構造まで検証する

scrubber の検査は、オブジェクトの存在確認だけではない。

```rust title="storage_scrubber/src/checks.rs"
                    let layer_names = index_part.layer_metadata.keys().cloned().collect_vec();
                    if let Some(err) = check_valid_layermap(&layer_names) {
                        result.warnings.push(format!(
                            "index_part.json contains invalid layer map structure: {err}"
                        ));
                    }
```

([storage_scrubber/src/checks.rs L139](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/storage_scrubber/src/checks.rs#L139))

`check_valid_layermap` は pageserver 本体の関数で、**「compaction が正しく動いていれば、こういう形にしかならないはず」**を検査する。

````rust title="pageserver/src/tenant/checks.rs"
/// Checks whether a layer map is valid (i.e., is a valid result of the current compaction algorithm if nothing goes wrong).
///
/// The function implements a fast path check and a slow path check.
///
/// The fast path checks if we can split the LSN range of a delta layer only at the LSNs of the delta layers. For example,
///
/// ```plain
/// |       |                 |       |
/// |   1   |    |   2   |    |   3   |
/// |       |    |       |    |       |
/// ```
///
/// This is not a valid layer map because the LSN range of layer 1 intersects with the LSN range of layer 2. 1 and 2 should have
/// the same LSN range.
````

([pageserver/src/tenant/checks.rs L7](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/pageserver/src/tenant/checks.rs#L7))

**delta layer の LSN 範囲は、分割点が揃っているはず。** ずれていたら compaction にバグがある。

例外が 2 つ書かれている。

```rust title="pageserver/src/tenant/checks.rs"
/// The exception is that when layer 2 only contains a single key, it could be split over the LSN range.
```

```rust title="pageserver/src/tenant/checks.rs"
/// However, if a partial compaction is still going on, it is possible that we get a layer map not satisfying the above condition.
/// Therefore, we fallback to simply check if any of the two delta layers overlap. (See "A slow path...")
```

**速い検査で引っかかったら、遅い (だが正確な) 検査に落ちる。** 前者は「compaction の想定する形か」、後者は「そもそも重なっていないか」。

**厳しい条件を先に、緩い条件を後に。** 大半のケースは速い検査で通り、通らなかったものだけ丁寧に見る。この構造だと**偽陽性が出ない**。

## errors / warnings / unknown の 3 分類

```rust title="storage_scrubber/src/checks.rs"
pub(crate) struct TimelineAnalysis {
    /// Anomalies detected
    pub(crate) errors: Vec<String>,

    /// Healthy-but-noteworthy, like old-versioned structures that are readable but
    /// worth reporting for awareness that we must not remove that old version decoding
    /// yet.
    pub(crate) warnings: Vec<String>,

    /// Objects whose keys were not recognized at all, i.e. not layer files, not indices, and not initdb archive.
    pub(crate) unknown_keys: Vec<String>,
}
```

([storage_scrubber/src/checks.rs L27](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/storage_scrubber/src/checks.rs#L27))

**`warnings` の定義が秀逸だ。「健全だが注目に値する。たとえば古いバージョンの構造で、読めるが、その復号コードをまだ消してはいけないと知らせるため」。**

これは**「いつ古い形式のサポートを削除できるか」を判断するための情報**になっている。「v2 の index が 13942 個ある」と分かれば、まだ消せない。

実際、`scan-metadata` の出力例にその数字が出ている。

```text
Index versions: 2: 13942, 4: 17162
```

**古い形式の残存数を数えることが、コードの削除計画になる。**

`unknown_keys` は、**scrubber が知らないオブジェクト**だ。新しい機能が追加されて scrubber が追いついていないのか、本当のゴミなのか。これも errors ではなく別枠になっている。

そして `is_healthy()` は errors と warnings の両方が空であることを要求する。**warning も「正常ではない」に含める**厳しい判定になっている。

## 統計を分位点で出す

```text
Timeline size bytes: min 22413312, 1% 52133887, 10% 56459263, 50% 101711871, 90% 191561727, 99% 280887295, max 167535558656
Layer size bytes: min 24576, 1% 36879, 10% 36879, 50% 61471, 90% 44695551, 99% 201457663, max 275324928
Timeline layer count: min 1, 1% 3, 10% 6, 50% 16, 90% 25, 99% 39, max 1053
```

**平均を出していない。** min、1%、10%、50%、90%、99%、max。

これで分布の形が分かる。timeline のサイズは中央値 100MB に対して最大 167GB — **4 桁の開きがある。** レイヤ数も中央値 16 に対して最大 1053。

**「典型的な tenant」と「極端な tenant」を同時に見る。** 平均だと両方が見えない。容量計画にも、性能問題の切り分けにも、この形が要る。

## 運用手順まで書いてある

README の最後に、実運用の落とし穴が書かれている。

```markdown title="storage_scrubber/README.md"
If S3 state is altered first manually, pageserver in-memory state will contain wrong data about S3 state, and tenants/timelines may get recreated on S3 (due to any layer upload due to compaction, pageserver restart, etc.). So before proceeding, for tenants/timelines which are already deleted in the console, we must remove these from pageservers.
```

**「S3 を先に消すと、pageserver が復活させる」。** pageserver は自分のメモリ上の状態を信じて index を書き直すので、消したはずのオブジェクトが戻ってくる。

だから **pageserver から先に detach する**必要がある。手順が curl のコマンド付きで書かれている。

そして最後の注意が実務的だ。

```markdown title="storage_scrubber/README.md"
Note that some tenants/timelines could be marked as deleted in console, but console might continue querying the node later to fully remove the tenant/timeline: wait for some time before ensuring that the "extra" tenant/timeline is not going away by itself.
```

**「しばらく待て。勝手に消えるかもしれない」。** 非同期に動いているシステムを外から掃除するときの、最も重要な忠告になっている。

## 他にもコマンドがある

- `pageserver-physical-gc` (31KB) — 物理的な GC。generation が古いオブジェクトの回収
- `tenant-snapshot` — tenant の全データをダウンロードする。障害調査用
- `find-large-objects` — 異常に大きいオブジェクトを探す
- `scan-safekeeper-metadata` — safekeeper 側のバケットの検査

**「S3 を歩く」という共通の基盤の上に、用途別のコマンドが乗っている。** `metadata_stream.rs` がその共通部分で、S3 のリスティングを非同期ストリームとして提供する。

safekeeper の検査には DB 接続が要る。

```markdown title="storage_scrubber/README.md"
For safekeepers, dump_db_connstr and dump_db_table must be
specified; they should point to table with debug dump which will be used
to list timelines and find their backup and start LSNs.
```

**safekeeper には index_part 相当の索引がない**ので、期待される状態を外部のダンプから持ってくる。設計の違いが、検査ツールの形にまで現れている。

## この先に効いてくること

- **オンラインで解けない問題を、オフラインのバッチに追い出す。** 全体を見られる者だけが判断できる。
- **検出と削除を分け、削除には明示フラグを要求し、README のサンプルには載せない。**
- **中間形式に互換性を持たせないことを、明示的に宣言する。**
- **warning は「古い形式がまだ残っている」の通知。** コードの削除計画になる。
- **統計は平均でなく分位点。** 典型と極端を同時に見る。

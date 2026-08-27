---
title: "レコードバッチ形式は、圧縮と冪等性のための入れ物でもある"
description: "Kafka のレコードは 1 件ずつではなくバッチ単位で送られ、保存され、CRC がかかる。バッチのヘッダは 61 バイトあり、その中にプロデューサ ID とシーケンス番号が埋まっている。CRC の対象範囲が「属性フィールド以降」に切られているのは、ブローカーが書き換えるフィールドを CRC の外に追い出すためだ。"
group: "ストレージ"
sidebar:
  order: 5
---

## 何を学んだか

### どんな状況の話か

「レコードを 1 件ずつ送る」を素直にやると、1 件ごとに次のものが付いてくる。

- offset (8 バイト)、タイムスタンプ (8 バイト)、CRC (4 バイト)、キーと値の長さ (各 4 バイト)。
- そして 1 件ごとに圧縮すると、圧縮率がまったく出ない。数十バイトのメッセージを個別に gzip しても縮まない。

さらに、Kafka には 1 件ずつでは表現できない要求が 3 つある。

- **冪等プロデューサ**: 「このプロデューサの何番目の書き込みか」を記録して、再送を重複させない。
- **トランザクション**: 「このレコード群は同じトランザクションに属する」を表す。
- **ブローカーによる offset 割り当て**: プロデューサは offset を知らない。ブローカーが受け取ってから決める。

### Kafka の答え

**レコードの単位を「バッチ」にする。** 送信も、保存も、圧縮も、CRC も、全部バッチ単位で行う。

1. **バッチヘッダは 61 バイト固定。** そこに offset の起点、タイムスタンプの起点、プロデューサ ID、エポック、シーケンス番号が入る。
2. **各レコードは差分で持つ。** offset とタイムスタンプはバッチ先頭からの差分で、しかも varint (可変長整数)。
3. **圧縮はバッチ全体にかける。** レコード列をまとめて圧縮するので、似たレコードが並ぶほど縮む。
4. **CRC は 1 個だけ。** バッチ全体に 1 つ、CRC-32C で。
5. **CRC の対象は「属性フィールドから末尾まで」。** その前にあるフィールドは、ブローカーが CRC を計算し直さずに書き換えられる。

## ソースコードのどこか

### バッチの形

```text title="clients/src/main/java/org/apache/kafka/common/record/internal/DefaultRecordBatch.java"
 * RecordBatch =>
 *  BaseOffset => Int64
 *  Length => Int32
 *  PartitionLeaderEpoch => Int32
 *  Magic => Int8
 *  CRC => Uint32
 *  Attributes => Int16
 *  LastOffsetDelta => Int32 // also serves as LastSequenceDelta
 *  BaseTimestamp => Int64
 *  MaxTimestamp => Int64
 *  ProducerId => Int64
 *  ProducerEpoch => Int16
 *  BaseSequence => Int32
 *  RecordsCount => Int32
 *  Records => [Record]
```

[`DefaultRecordBatch.java#L45-L103`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/common/record/internal/DefaultRecordBatch.java#L45-L103)。

合計 61 バイト。`ProducerId` から `BaseSequence` までの 14 バイトが冪等性とトランザクションのための領域で、**メッセージングの機能がバイト列のレイアウトに直接現れている**。

### レコード 1 件の形

```text title="clients/src/main/java/org/apache/kafka/common/record/internal/DefaultRecord.java"
 * Record =>
 *   Length => Varint
 *   Attributes => Int8
 *   TimestampDelta => Varlong
 *   OffsetDelta => Varint
 *   KeyLength => Varint
 *   Key => Bytes
 *   ValueLength => Varint
 *   Value => Bytes
 *   HeadersCount => Varint
 *   Headers => [HeaderKey HeaderValue]
 * ...
 * The offset and timestamp deltas compute the difference relative to the base offset and
 * base timestamp of the batch that this record is contained in.
```

[`DefaultRecord.java#L36-L69`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/common/record/internal/DefaultRecord.java#L36-L69)。

**固定長のフィールドがほとんどない。** 長さも offset の差分もタイムスタンプの差分も varint で、小さい値は 1 バイトになる。同じ瞬間に投入された 100 件のバッチなら、offset の差分は 0〜99、タイムスタンプの差分はほぼ 0。**どちらも 1 バイトで収まる。**

1 件あたりのオーバーヘッドを比べると差が分かる。

|                | 旧形式 (v0/v1、1 件 = 1 メッセージ) | v2 (バッチ内のレコード)       |
| -------------- | ----------------------------------- | ----------------------------- |
| offset         | 8 バイト                            | 差分の varint (通常 1 バイト) |
| タイムスタンプ | 8 バイト                            | 差分の varint (通常 1 バイト) |
| CRC            | 4 バイト                            | **なし** (バッチに 1 個)      |
| 長さ           | 4 バイト                            | varint                        |
| 属性           | 1 バイト                            | 1 バイト                      |

**100 件のバッチなら、ヘッダ 61 バイト + レコードごとに数バイト。** 旧形式の 100 × 26 バイトから桁が変わる。

### CRC の範囲

```java title="clients/src/main/java/org/apache/kafka/common/record/internal/DefaultRecordBatch.java"
private long computeChecksum() {
    return Crc32C.compute(buffer, ATTRIBUTES_OFFSET, buffer.limit() - ATTRIBUTES_OFFSET);
}
```

[`DefaultRecordBatch.java#L399-L401`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/common/record/internal/DefaultRecordBatch.java#L399-L401)。

CRC の直前にある `Magic` までは対象外。CRC 自身も当然対象外。**つまり `BaseOffset`、`Length`、`PartitionLeaderEpoch`、`Magic` の 17 バイトは CRC に守られていない。**

javadoc がその理由を説明している。

```text title="clients/src/main/java/org/apache/kafka/common/record/internal/DefaultRecordBatch.java"
 * The CRC covers the data from the attributes to the end of the batch (i.e. all the bytes that follow the CRC). It is
 * located after the magic byte, which means that clients must parse the magic byte before deciding how to interpret
 * the bytes between the batch length and the magic byte. The partition leader epoch field is not included in the CRC
 * computation to avoid the need to recompute the CRC when this field is assigned for every batch that is received by
 * the broker.
```

**`PartitionLeaderEpoch` はブローカーが受け取ったバッチ全部に書き込む。** CRC の内側にあったら、書き込むたびに CRC-32C を全バイトに対して計算し直すことになる。だから CRC の外に置いた。

`BaseOffset` も同じだ。

```java title="clients/src/main/java/org/apache/kafka/common/record/internal/DefaultRecordBatch.java"
@Override
public void setLastOffset(long offset) {
    buffer.putLong(BASE_OFFSET_OFFSET, offset - lastOffsetDelta());
}

@Override
public void setPartitionLeaderEpoch(int epoch) {
    buffer.putInt(PARTITION_LEADER_EPOCH_OFFSET, epoch);
}
```

[`DefaultRecordBatch.java#L366-L389`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/common/record/internal/DefaultRecordBatch.java#L366-L389)。

**どちらも CRC を再計算していない。** 一方、`setMaxTimestamp` は CRC の内側なので、

```java title="clients/src/main/java/org/apache/kafka/common/record/internal/DefaultRecordBatch.java"
buffer.putShort(ATTRIBUTES_OFFSET, attributes);
buffer.putLong(MAX_TIMESTAMP_OFFSET, maxTimestamp);
long crc = computeChecksum();
ByteUtils.writeUnsignedInt(buffer, CRC_OFFSET, crc);
```

と、きちんと再計算している。**「ブローカーが書き換えるフィールドを CRC の外に集める」というレイアウト設計が、コードの非対称性としてそのまま現れている。**

### 差分符号化が効くのは、書き込みパスでもある

ブローカーは、プロデューサから届いたバッチに offset を振らなければならない。圧縮されていたら、伸長して振り直して再圧縮する — のが素朴な実装だが、v2 ではそうしない。

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/LogValidator.java"
} else {
    // we can update the batch only and write the compressed payload as is;
    // again we assume only one record batch within the compressed set
    offsetCounter.value += validatedRecords.size();
    // there is only one batch in this path, so last offset can be viewed as shallowOffsetOfMaxTimestamp
    long lastOffset = offsetCounter.value - 1;
    firstBatch.setLastOffset(lastOffset);
    ...
    if (toMagic >= RecordBatch.MAGIC_VALUE_V2)
        firstBatch.setPartitionLeaderEpoch(partitionLeaderEpoch);
```

[`LogValidator.java#L366-L393`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/log/LogValidator.java#L366-L393)。

**書き換えるのは `BaseOffset` の 8 バイトと `PartitionLeaderEpoch` の 4 バイトだけ。圧縮されたペイロードには一切触らない。**

レコードが持っているのは差分なので、バッチの起点を動かせば全レコードの offset がまとめて動く。**差分符号化はサイズを削るためのものだと思われがちだが、ここでは「後から一括で書き換えられる」という性質のほうが効いている。**

検証のためのイテレータにも最適化がある。

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/LogValidator.java"
// if we are on version 2 and beyond, and we know we are going for in place assignment,
// then we can optimize the iterator to skip key / value / headers since they would not be used at all
CloseableIterator<Record> recordsIterator;
if (inPlaceAssignment && firstBatch.magic() >= RecordBatch.MAGIC_VALUE_V2)
    recordsIterator = batch.skipKeyValueIterator(bufferSupplier);
else
    recordsIterator = batch.streamingIterator(bufferSupplier);
```

[`LogValidator.java#L311-L317`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/log/LogValidator.java#L311-L317)。

**キーと値の中身は使わないので、伸長はするがコピーはしない。** 検証に必要なのは件数とヘッダだけだからだ。

そして「再圧縮が必要になる条件」は 3 つだけと明記されている。

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/LogValidator.java"
 * 1. Source and target compression codec are different
 * 2. When the target magic is not equal to batches' magic, meaning format conversion is needed.
 * 3. When the target magic is equal to V0, meaning absolute offsets need to be re-assigned.
```

[`LogValidator.java#L272-L279`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/log/LogValidator.java#L272-L279)。

**「ブローカーの圧縮設定をプロデューサと揃えておけば、ブローカーは再圧縮しない」** という運用上の指針が、この 3 行から直接読める。

### 圧縮後も残るもの

ログの[圧縮 (compaction)](../log-compaction/) でレコードが消えても、バッチヘッダは残ることがある。

```text title="clients/src/main/java/org/apache/kafka/common/record/internal/DefaultRecordBatch.java"
 * On Compaction: Unlike the older message formats, magic v2 and above preserves the first and last offset/sequence
 * numbers from the original batch when the log is cleaned. This is required in order to be able to restore the
 * producer's state when the log is reloaded. If we did not retain the last sequence number, then following
 * a partition leader failure, once the new leader has rebuilt the producer state from the log, the next sequence
 * expected number would no longer be in sync with what was written by the client. This would cause an
 * unexpected OutOfOrderSequence error, which is typically fatal.
 ...
 * Note that if all of the records in a batch are removed during compaction, the broker may still retain an empty
 * batch header in order to preserve the producer sequence information as described above.
```

[`DefaultRecordBatch.java#L74-L86`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/common/record/internal/DefaultRecordBatch.java#L74-L86)。

**中身が空のバッチヘッダだけが残る。** 61 バイトのゴミに見えるが、これがないと [冪等プロデューサ](../idempotent-producer/) が壊れる。リーダーが交代したとき、新リーダーはログを読んでプロデューサの状態を復元する。最後のシーケンス番号が消えていると、次の書き込みが `OutOfOrderSequence` で落ちる。

**「圧縮で消してよいのはユーザーデータだけで、プロトコルの状態は消してはいけない」** という区別が、形式のレベルで書かれている。

### 属性フィールドのビット割り当て

```text title="clients/src/main/java/org/apache/kafka/common/record/internal/DefaultRecordBatch.java"
 *  ---------------------------------------------------------------------------------------------------------------------------
 *  | Unused (7-15) | Delete Horizon Flag (6) | Control (5) | Transactional (4) | Timestamp Type (3) | Compression Type (0-2) |
 *  ---------------------------------------------------------------------------------------------------------------------------
```

[`DefaultRecordBatch.java#L96-L100`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/common/record/internal/DefaultRecordBatch.java#L96-L100)。

16 ビットのうち 7 ビットしか使っていない。**圧縮方式に 3 ビット割いてある**ので 8 種類まで入り、今は none/gzip/snappy/lz4/zstd の 5 つが埋まっている。`Control` はトランザクションのコミット/中断マーカーを表すビットで、**ユーザーが書いたレコードとシステムが書いたレコードを 1 ビットで区別している**。

## なぜそうなっているか

### バッチにすると、5 つの問題が同時に解ける

バッチ化は圧縮率のためだと思われがちだが、実際にはもっと広く効いている。

| 何が良くなるか       | 理由                                                         |
| -------------------- | ------------------------------------------------------------ |
| **サイズ**           | ヘッダを 1 件ずつではなく N 件で 1 回払う。差分符号化が効く  |
| **圧縮率**           | 似たレコードがまとまるので、辞書が共有される                 |
| **CRC の計算コスト** | 1 バッチ 1 回。1 件ずつなら N 回                             |
| **冪等性の表現**     | 「このバッチは producer X の seq 100〜199」と 1 回書けば済む |
| **ネットワーク効率** | 1 リクエストに複数バッチを詰められる                         |

そして、**バッチはブローカーにとって不可分の単位**でもある。フェッチのレスポンスはバッチ境界で切られ、コンシューマは要求したより多くのレコードを受け取ることがある。`max.poll.records` がクライアント側のバッファ分割でしか実現できないのは、この境界のためだ。

### なぜ CRC を属性フィールドから始めたか

これは **「不変な部分と可変な部分を、バイト列のレイアウトで分離した」** 設計だ。

```text
[ BaseOffset | Length | LeaderEpoch | Magic ] [ CRC ] [ Attributes ... Records ]
 └── ブローカーが書き換える (CRC 対象外) ──┘         └── 不変 (CRC 対象) ──┘
```

ブローカーは毎秒何十万バッチも受け取る。その全部に `PartitionLeaderEpoch` を書き込む。もし CRC の内側なら、**受信バッチのバイト数ぶんの CRC 計算が毎回発生する**。1 MB のバッチなら 1 MB 分。これを避けるためだけに、フィールドの並び順が決まっている。

代償として、**この 17 バイトは破損しても検出できない**。`BaseOffset` が化けたら、ログの offset が飛ぶ。それでもこの配置を選んだのは、書き込みパスのコストのほうが重いと判断したからだ。ちなみに、この 17 バイトのうち `Length` と `Magic` はセグメントの走査時に整合性チェックの役割を果たすので、完全に無防備というわけでもない。

### なぜ varint なのか

Protocol Buffers と同じ ZigZag varint を使っている。効くのは **値が小さいことが圧倒的に多い**からだ。

- `OffsetDelta`: バッチ内の位置。0 から数百。
- `TimestampDelta`: バッチ内での経過ミリ秒。linger.ms が数ミリ秒なら、ほぼ 0。
- `KeyLength` / `ValueLength`: 数十から数百バイトが典型。

いずれも 1〜2 バイトに収まる。固定長なら 8 + 8 + 4 + 4 = 24 バイトのところが、5 バイト程度になる。

ただし varint には代償がある。**ランダムアクセスができない。** レコード N 件目の位置を知るには、前から順に長さを読んでいくしかない。だから[インデックス](../sparse-index/)はレコード単位ではなくバッチ単位で位置を持ち、その先は走査する構造になっている。**バイト列を詰めた結果、索引の設計まで決まっている。**

### なぜ空のバッチヘッダを残すのか

これは **「派生データと権威データの区別」** の話だ。

レコードの中身 (キーと値) は、ユーザーのデータであり、圧縮で消えてよい。一方、プロデューサのシーケンス番号は **Kafka のプロトコルの状態** で、消えると再構築できない。

再構築できないのは、**シーケンス番号の権威がログにしかない**からだ。ブローカーのメモリ上の `ProducerStateManager` はログから復元されるものにすぎず、リーダーが交代すれば新しいリーダーがログから作り直す ([プロデューサ状態のページ](../producer-state/))。ログから消したら、もうどこにもない。

「データを消す機能」を作るときに、**消してよいものと、一緒に消してはいけない付帯情報を分ける**必要がある、という一般的な話でもある。

## どう活かすか

**「1 件ずつ処理する API を保ちながら、内部の単位をバッチにする」は、スループットを求めるシステムの定石として使える。** Kafka のプロデューサ API は `send(record)` を 1 件ずつ受け取るが、実際に飛ぶのはバッチだ ([アキュムレータのページ](../record-accumulator/))。API の粒度と転送・保存の粒度を分離しておくと、後者だけを最適化できる。

**「可変フィールドをチェックサムの外に置く」は、バイナリ形式を設計するときに真似できる。** 途中で書き換わるメタデータ (受信時刻、経路情報、シーケンス) があるなら、チェックサムの前に集める。**逆に言えば、「全体に 1 個のチェックサム」を素朴に付けると、1 バイト書き換えるたびに全体を再計算することになる。** 形式を決める前に「誰がどのフィールドを書き換えるか」を洗い出しておく価値がある。

**差分符号化は「サイズを削る」より「まとめて書き換えられる」ほうが効くことがある、という視点は持ち帰りたい。** Kafka がバッチヘッダの 8 バイトを書き換えるだけで全レコードの offset を確定できるのは、レコードが絶対値を持っていないからだ。ID の再採番、時刻のシフト、座標の平行移動 — 「起点を後から決めたい」データは、差分で持っておくと後の自由度が上がる。

**取り込むべきでない条件もある。** この形式の複雑さは、**「クライアントとブローカーが別々に進化する」「10 年前の形式を読み続ける」という要求から来ている**。magic バイトによる分岐、CRC 範囲の非対称性、圧縮後も残る空ヘッダ — どれも互換性の要求がなければ不要だ。**両端を同時にデプロイできるなら、素直な形式のほうが安い。** 形式を凝るのは、形式を変えられなくなってからでは遅い、という理由でだけ正当化される。

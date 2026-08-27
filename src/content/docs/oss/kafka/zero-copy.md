---
title: "ファイルからソケットへ直接流し、JVM ヒープを通さない"
description: "Kafka のフェッチ応答は、レコードをアプリケーションのメモリに読み込まない。ファイルディスクリプタとバイト範囲だけを持ち回り、書き出す瞬間に sendfile でカーネル内を直接転送する。平文の実装は 1 行、TLS の実装は 60 行 — この非対称性が、暗号化のコストの正体を示している。"
group: "ストレージ"
sidebar:
  order: 6
---

## 何を学んだか

### どんな状況の話か

ブローカーがコンシューマにレコードを返すとき、素朴に書くとこうなる。

```text
1. ファイルからバイト列を読む         disk → カーネルのページキャッシュ → JVM のバイト配列
2. 応答オブジェクトを組み立てる       JVM 内でコピー
3. ソケットに書く                     JVM のバイト配列 → カーネルのソケットバッファ → NIC
```

**同じバイト列が 4 回コピーされ、そのうち 2 回はカーネルとユーザー空間の往復**になる。しかもコピー先の JVM ヒープは GC の対象なので、毎秒 1 GB を配るブローカーは毎秒 1 GB のゴミを作ることになる。

Kafka が配っているデータには、もう 1 つ特徴がある。**ブローカーはレコードの中身に興味がない。** キーも値も解釈せず、ただのバイト列として右から左に流すだけだ。

### Kafka の答え

**レコードをアプリケーションのメモリに読み込まない。ファイルの位置と長さだけを持ち回り、ソケットに書く瞬間に `sendfile` でカーネル内を直接転送する。**

```text
disk → カーネルのページキャッシュ → NIC
                (ユーザー空間を通らない)
```

そのために、コードには次の 3 つが入っている。

1. **`Records` インタフェースが `writeTo(TransferableChannel)` を持つ。** 中身がヒープ上のバッファ (`MemoryRecords`) でもファイル (`FileRecords`) でも、同じ形で書ける。
2. **`FileRecords` は `FileChannel` とバイト範囲しか持たない。** フェッチの処理はここで止まり、実際の読み出しは応答を書き出すときに起きる。
3. **`TransferableChannel` が `transferFrom` を切り出している。** 平文なら `sendfile`、TLS なら読んで暗号化して書く。呼ぶ側はどちらか知らない。

## ソースコードのどこか

### 転送の本体

```java title="clients/src/main/java/org/apache/kafka/common/record/internal/FileRecords.java"
@Override
public int writeTo(TransferableChannel destChannel, int offset, int length) throws IOException {
    long newSize = Math.min(channel.size(), end) - start;
    int oldSize = sizeInBytes();
    if (newSize < oldSize)
        throw new KafkaException(String.format(
                "Size of FileRecords %s has been truncated during write: old size %d, new size %d",
                file.getAbsolutePath(), oldSize, newSize));

    long position = start + offset;
    int count = Math.min(length, oldSize - offset);
    // safe to cast to int since `count` is an int
    return (int) destChannel.transferFrom(channel, position, count);
}
```

[`FileRecords.java#L290-L303`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/common/record/internal/FileRecords.java#L290-L303)。

**バイト列がどこにも現れない。** あるのはチャネル、位置、長さだけだ。

冒頭の 5 行が、この設計の危うさを示している。**書き出そうとした瞬間にファイルが縮んでいたら例外を投げる。** データを先に読んでおけばこんな確認は要らないが、読まないと決めた以上、書く瞬間まで実体を確定できない。[セグメントを削除するときにいきなり `unlink` せず、リネームして 60 秒待つ](../log-segment/) のは、この窓を塞ぐためでもある。

### 抽象の切り出し方

```java title="clients/src/main/java/org/apache/kafka/common/network/TransferableChannel.java"
/**
 * Extends GatheringByteChannel with the minimal set of methods required by the Send interface. Supporting TLS and
 * efficient zero copy transfers are the main reasons for the additional methods.
 *
 * @see SslTransportLayer
 */
public interface TransferableChannel extends GatheringByteChannel {
    ...
    /**
     * Transfers bytes from `fileChannel` to this `TransferableChannel`.
     *
     * This method will delegate to {@link FileChannel#transferTo(long, long, java.nio.channels.WritableByteChannel)},
     * but it will unwrap the destination channel, if possible, in order to benefit from zero copy. This is required
     * because the fast path of `transferTo` is only executed if the destination buffer inherits from an internal JDK
     * class.
     */
    long transferFrom(FileChannel fileChannel, long position, long count) throws IOException;
}
```

[`TransferableChannel.java#L23-L50`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/common/network/TransferableChannel.java#L23-L50)。

**「宛先チャネルを unwrap する」という注意書きが、この最適化の脆さを表している。** `FileChannel.transferTo` が `sendfile` に落ちるのは、宛先が JDK 内部のクラスであるときだけだ。ラッパーで包むと、JDK は「知らないチャネルだ」と判断して普通の read/write ループにフォールバックする。**黙って遅くなる。** 例外も警告も出ない。

だから Kafka は、この境界に専用のインタフェースを 1 枚だけ置いて、実装が生のチャネルを直接触れるようにしている。

### 平文と TLS の非対称

平文の実装。

```java title="clients/src/main/java/org/apache/kafka/common/network/PlaintextTransportLayer.java"
@Override
public long transferFrom(FileChannel fileChannel, long position, long count) throws IOException {
    return fileChannel.transferTo(position, count, socketChannel);
}
```

[`PlaintextTransportLayer.java#L212-L215`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/common/network/PlaintextTransportLayer.java#L212-L215)。

**1 行。** カーネルにファイルディスクリプタとソケットディスクリプタを渡して終わり。

TLS の実装は 60 行ある。

```java title="clients/src/main/java/org/apache/kafka/common/network/SslTransportLayer.java"
if (fileChannelBuffer == null) {
    // Pick a size that allows for reasonably efficient disk reads, keeps the memory overhead per connection
    // manageable and can typically be drained in a single `write` call. The `netWriteBuffer` is typically 16k
    // and the socket send buffer is 100k by default, so 32k is a good number given the mentioned trade-offs.
    int transferSize = 32768;
    // Allocate a direct buffer to avoid one heap to heap buffer copy. SSLEngine copies the source
    // buffer (fileChannelBuffer) to the destination buffer (netWriteBuffer) and then encrypts in-place.
    // FileChannel.read() to a heap buffer requires a copy from a direct buffer to a heap buffer, which is not
    // useful here.
    fileChannelBuffer = ByteBuffer.allocateDirect(transferSize);
```

```java title="clients/src/main/java/org/apache/kafka/common/network/SslTransportLayer.java"
while (totalBytesWritten < totalBytesToWrite) {
    if (!fileChannelBuffer.hasRemaining()) {
        fileChannelBuffer.clear();
        int bytesRemaining = totalBytesToWrite - totalBytesWritten;
        if (bytesRemaining < fileChannelBuffer.limit())
            fileChannelBuffer.limit(bytesRemaining);
        int bytesRead = fileChannel.read(fileChannelBuffer, pos);
        if (bytesRead <= 0)
            break;
        fileChannelBuffer.flip();
    }
    int networkBytesWritten = write(fileChannelBuffer);
```

[`SslTransportLayer.java#L1003-L1062`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/common/network/SslTransportLayer.java#L1003-L1062)。

**TLS を有効にすると、ゼロコピーは成立しない。** 暗号化するには平文をユーザー空間に持ってくるしかないからだ。できるのは「持ってくる量を減らす」ことだけで、そのために

- **32 KB のダイレクトバッファを接続ごとに 1 個**持ち、使い回す (毎回確保しない)。
- **ダイレクトバッファにする**ことで、ヒープ ↔ ダイレクトのコピーを 1 回省く。`SSLEngine` はダイレクトバッファ同士でその場で暗号化できる。
- **32 KB という数字の根拠**まで書いてある。`netWriteBuffer` が 16 KB、ソケット送信バッファが既定 100 KB。32 KB なら 1 回の `write` で吐き切れて、接続あたりのメモリも許容範囲。

コメントの密度が平文側の 60 倍あるのが、そのままコストの差を表している。**「TLS を有効にするとスループットが落ちる」の中身は、暗号演算そのものよりも、この経路の変化にある。**

### ダウンコンバージョンは消えた

かつては、ゼロコピーが崩れる経路がもう 1 つあった。古いクライアントが v0/v1 のレコード形式を要求すると、ブローカーは v2 のバッチを読み込んで変換してから送る必要があり、そこでヒープにデータが載った。

4.0 で v0/v1 のサポートが切られたため、**現在のコードベースにダウンコンバージョンの実装は存在しない**。`lazyDownConversion` のような設定名も残っていない。

**古い形式を切ることの見返りが、コードの削除だけでなく「速いパスしか残らない」ことでもある**という例になっている。

### 書き出しの単位

応答全体が 1 つの `Send` として組み立てられる。ヘッダ部分はヒープ上の `ByteBuffer`、レコード部分は `FileRecords` で、`MultiRecordsSend` がそれらを順に書く。

```java title="clients/src/main/java/org/apache/kafka/common/record/internal/RecordsSend.java"
@Override
public final long writeTo(TransferableChannel channel) throws IOException {
    int written = 0;

    if (remaining > 0) {
        written = writeTo(channel, maxBytesToWrite - remaining, remaining);
```

[`RecordsSend.java#L45-L51`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/clients/src/main/java/org/apache/kafka/common/record/internal/RecordsSend.java#L45-L51)。

**部分書き込みを前提にしている**のがポイントだ。ノンブロッキングのソケットは、要求した量を書き切らずに返ることがある。`remaining` を持って、次に `Processor` が書けるようになったときに続きから再開する。

つまり **1 つの応答が、複数回の `write` に分割されて、その間ずっとファイルは開かれたまま**になる。ここでもセグメントの削除と競合しうる。

## なぜそうなっているか

### 「ブローカーがデータを解釈しない」から成立する

ゼロコピーが使えるのは、**ブローカーがレコードの中身を見ないから**だ。

- スキーマの検証をしない。
- 内容によるフィルタをしない。
- 型変換をしない。

もし「このフィールドが X のレコードだけ返す」ような機能があれば、その瞬間にバイト列をユーザー空間に持ってくる必要が出て、この設計は崩れる。**Kafka がブローカー側のフィルタ機能を持たないのは、機能を削ったというより、この設計を守っているからだと読める。**

裏を返すと、**バッチ単位のバイト列をそのまま返す**ので、コンシューマは要求より多いデータを受け取ることがある。バッチの途中で切れないからだ。[レコードバッチ形式](../record-batch/) が不可分の単位になっているのと表裏一体になっている。

### ページキャッシュへの依存

`sendfile` が効くのは、読みたいデータがページキャッシュにあるときだ。ディスクまで行くなら、コピー回数を削っても支配的なのはディスクの待ち時間になる。

Kafka の典型的な読者は **書き込みの直後に読むコンシューマ**なので、この前提はよく成り立つ。数秒前に書かれたデータはまだページキャッシュにいる。**「追いついているコンシューマにはディスク I/O が一切発生しない」** のが、Kafka が単純なハードウェアで高いスループットを出す理由だ。

だから Kafka のブローカーは、**JVM ヒープを小さく (数 GB)、残りのメモリを全部ページキャッシュに回す**のが正しい設定になる。ヒープを大きくすると、ページキャッシュに使える物理メモリが減って、かえって遅くなる。「アプリケーションが自前でキャッシュを持たない」という判断が、運用の指針まで決めている。

逆に、**長時間遅れているコンシューマは古いデータを読むので、ディスクに当たる**。そのアクセスがページキャッシュを汚染して、他のコンシューマの読みまで遅くなる。これが Kafka で「遅いコンシューマが 1 人いると全体が遅くなる」現象の正体で、[階層型ストレージ](../tiered-storage/) が古いデータを別経路に逃がす動機の 1 つでもある。

### なぜ `TransferableChannel` という 1 枚の抽象なのか

`transferFrom` を `GatheringByteChannel` に足すだけなら、既存の `WritableByteChannel` を使って `if (channel instanceof SocketChannel)` で分岐してもよかった。実際そうしている実装は世の中に多い。

**専用のインタフェースにしたのは、「ゼロコピーできるかどうか」を型として表現するため**だ。`Send#writeTo` の引数が `TransferableChannel` である以上、呼び出し側は必ずこの契約を通る。分岐で書くと、新しい経路を足した人が分岐を忘れて、黙ってゼロコピーが外れる。

**性能上の特性を型に載せる**という判断で、`unwrap` の注意書きが javadoc にあるのも同じ意図だ。この境界を触る人に、最適化が壊れる条件を伝えている。

## どう活かすか

**「アプリケーションがデータを解釈しないなら、ユーザー空間に持ってこない」は、プロキシやストレージを書くときにそのまま使える。** リバースプロキシ、静的ファイル配信、オブジェクトストレージのゲートウェイ — 中身を見ないパスがあるなら、`sendfile`/`splice` (Linux)、`FileChannel.transferTo` (JVM)、`copy_file_range` を検討する価値がある。**効果は「コピー回数が減る」だけでなく「GC 圧が消える」ほうが大きいことが多い。**

**そのうえで、ゼロコピーが崩れる条件を先に把握しておきたい。** Kafka のコードから読み取れるのは 3 つだ。

- **暗号化・圧縮・変換を挟んだ瞬間に崩れる。** TLS の 60 行がその証拠になっている。
- **チャネルをラップすると黙って崩れる。** JDK の fast path は宛先の型で判定するので、デコレータを 1 枚挟むだけで無効になる。
- **データを読み込まないので、書く瞬間まで実体が確定しない。** ファイルが縮む・消える競合を、別の仕組み (遅延削除) で塞ぐ必要がある。

**「性能の前提を型で表す」という手法も持ち帰れる。** `TransferableChannel` は機能的には `WritableByteChannel` で足りる。それでも別の型にしたのは、ゼロコピーの契約を通る経路を 1 本に絞るためだ。同じことは「このバッファはプールから来ているので解放が必要」「このオブジェクトはコピーせずに渡せる」といった性質にも使える。**コメントで書くと守られないが、型にすると守られる。**

**取り込むべきでない条件は明確で、データを加工するパスには効かない。** 「とりあえずゼロコピーにしておく」は意味がない。**加工しないパスと加工するパスを分離できるか**が先で、分離できないなら普通に読み書きするほうが単純で速い。

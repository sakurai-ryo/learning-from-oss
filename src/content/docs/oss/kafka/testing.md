---
title: "本体より多いテストコードは、何を確かめているのか"
description: "Kafka のテストコードは約 96 万行で、本体の 71 万行より多い。中心にあるのは「1 つのテストメソッドを、複数のクラスタ構成に対して自動的に展開する」JUnit 拡張だ。それに加えて Python の統合テスト、故障注入フレームワーク、マイクロベンチマークが層をなしている。"
group: "運用と品質"
sidebar:
  order: 37
---

## 何を学んだか

### どんな状況の話か

分散システムのテストは、単体テストだけでは足りない。

- **設定の組み合わせで挙動が変わる。** ブローカー 1 台と 3 台、平文と TLS、[`MetadataVersion`](../protocol-codegen/) の違い。
- **本当にクラスタを立てないと分からないことがある。** リーダー選出、リバランス、フェイルオーバー。
- **障害を起こさないと確認できない経路がある。** ネットワーク分断、ディスク障害、プロセスの強制終了。
- **性能の退行は、機能テストでは捕まらない。**

Kafka のテストコードは **約 96 万行**あり、**本体 (71 万行) より多い。**

### Kafka の答え

**目的の違うテストを、別々の仕組みで層にする。**

| 層                 | 仕組み                                      | 何を確かめるか                                |
| ------------------ | ------------------------------------------- | --------------------------------------------- |
| 単体テスト         | JUnit                                       | クラス単体の振る舞い                          |
| **クラスタテスト** | **`@ClusterTest` (JUnit 拡張)**             | 同一 JVM 内にクラスタを立てて、複数構成で検証 |
| 統合テスト         | Python (ducktape) 143 ファイル・約 2.5 万行 | 複数ノード、実際のプロセス、アップグレード    |
| 故障注入           | Trogdor                                     | 負荷をかけながら障害を起こす                  |
| ベンチマーク       | JMH 50 個                                   | 性能の測定と退行の検出                        |

**このページで見るのは、2 番目の `@ClusterTest` が中心になる。** 「1 つのテストを複数の構成に展開する」という発想が、設定の組み合わせ爆発に対する答えになっている。

## ソースコードのどこか

### 宣言だけでクラスタが立つ

```java title="test-common/test-common-internal-api/src/main/java/org/apache/kafka/common/test/api/README.md"
public class SampleTest {
    @ClusterTest
    void testSomething() { ... }
}
```

[`README.md#L1-L27`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/test-common/test-common-internal-api/src/main/java/org/apache/kafka/common/test/api/README.md)。

**これだけで、同一 JVM 内に Kafka クラスタが起動する。** ポートの確保、`log.dirs` の一時ディレクトリ、[ストレージのフォーマット](../kraft-overview/)、コントローラとブローカーの起動、そして後始末が自動になる。

パラメータで構成を変えられる。

```java title="test-common/test-common-internal-api/src/main/java/org/apache/kafka/common/test/api/README.md"
public class SampleTest {
    @ClusterTest(brokers = 3, metadataVersion = MetadataVersion.IBP_4_0_IV3)
    void testSomething() { ... }
}
```

**`MetadataVersion` を指定できる**のが Kafka らしい。「この機能は `IBP_4_0_IV3` 以降でだけ有効」という[互換性の検証](../protocol-codegen/)が、テストの宣言として書ける。

### 同じテストを複数構成で走らせる

```java title="test-common/test-common-internal-api/src/main/java/org/apache/kafka/common/test/api/README.md"
public class SampleTest {
    @ClusterTests({
        @ClusterTest(brokerSecurityProtocol = SecurityProtocol.PLAINTEXT),
        @ClusterTest(brokerSecurityProtocol = SecurityProtocol.SASL_PLAINTEXT)
    })
    void testSomething() { ... }
}
```

[`README.md#L61-L72`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/test-common/test-common-internal-api/src/main/java/org/apache/kafka/common/test/api/README.md)。

**テストの本体は 1 つ、実行は 2 回。** 平文と SASL の両方で同じ検証が走る。

これが**この仕組みの核心**だ。設定の組み合わせが増えても、**テストコードは増えない。**

構成を動的に生成することもできる。

```java title="test-common/test-common-internal-api/src/main/java/org/apache/kafka/common/test/api/README.md"
@ClusterTemplate("generateConfigs")
void testSomething() { ... }

static List<ClusterConfig> generateConfigs() {
  ClusterConfig config1 = ClusterConfig.defaultClusterBuilder()
          .name("Generated Test 1")
          .serverProperties(props1)
          .setMetadataVersion(MetadataVersion.IBP_2_7_IV1)
          .build();
  ...
  return List.of(config1, config2, config3);
}
```

[`README.md#L74-L110`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/test-common/test-common-internal-api/src/main/java/org/apache/kafka/common/test/api/README.md)。

**「アノテーションで書ける範囲」と「コードで生成したい範囲」の両方を用意している。** 宣言的な指定は読みやすいが、`MetadataVersion` を全部試すような網羅は書けない。**両方の口を用意することで、どちらも無理なく書ける。**

### ライフサイクルが明示されている

```text title="test-common/test-common-internal-api/src/main/java/org/apache/kafka/common/test/api/README.md"
For each generated test invocation we have the following lifecycle:

* Static `@BeforeAll` methods are called
* Test class is instantiated
* Kafka Cluster is started (if autoStart=true)
* Non-static `@BeforeEach` methods are called
* Test method is invoked
* Kafka Cluster is stopped
* Non-static `@AfterEach` methods are called
* Static `@AfterAll` methods are called

`@BeforeEach` methods give an opportunity to set up additional test dependencies
after the cluster has started but before the test method is run.
```

[`README.md#L120-L140`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/test-common/test-common-internal-api/src/main/java/org/apache/kafka/common/test/api/README.md)。

**クラスタの起動が `@BeforeEach` より前**という順序が明記されている。

これは重要で、**`@BeforeEach` の中でクラスタに接続してトピックを作る**といったことができる。逆順だと、テストの準備コードがクラスタを待つ処理を自分で書くことになる。

`autoStart=false` にすると、**テストメソッドの中で明示的に起動できる。** 起動そのものを検証したいテストのためだ。

### クラスタへのアクセス

```text title="test-common/test-common-internal-api/src/main/java/org/apache/kafka/common/test/api/README.md"
A ClusterInstance object can be injected into the test method or the test class constructor.
This object is a shim to the underlying test framework and provides access to things like
SocketServers and has convenience factory methods for getting a client.

The class is introduced to provide context to the underlying cluster and to provide reusable
functionality that was previously garnered from the test hierarchy.
```

[`README.md#L142-L152`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/test-common/test-common-internal-api/src/main/java/org/apache/kafka/common/test/api/README.md)。

**`previously garnered from the test hierarchy`** — 以前は、テストクラスが基底クラスを継承して、そこからクラスタにアクセスしていた。

**継承をやめて、依存性注入にした。** 基底クラスによる共有は、階層が深くなると「どこで何が設定されているか」が追えなくなる。**注入なら、テストメソッドの引数を見れば分かる。**

### 仕様として書くテスト

[階層型ストレージ](../tiered-storage/)のテストは、さらに一段抽象化されている。

```text title="storage/src/test/java/org/apache/kafka/tiered/storage/README.md"
Step 2: The test is written as a specification consisting of sequential actions and assertions.
The spec for the complete test is built first using `TieredStorageTestBuilder`, which creates
the "actions" to be executed.
...
Step 4: The test execution stops when any of the actions throws an exception (or an assertion error).
```

[`README.md#L1-L11`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/test/java/org/apache/kafka/tiered/storage/README.md)。

**テストを「アクションの列」として組み立ててから、順に実行する。**

こうすると、**テストの内容とテストの実行が分離される。** 実行前に全体を検査できるし、失敗したときに「どのアクションで止まったか」をレポートできる。

**「セグメントをリモートに移す → ローカルから消える → 読める」** のような、時間のかかる非同期の検証を宣言的に書ける。

### 他の層

**Python の統合テスト** (`tests/kafkatest/`) は 143 ファイル・約 2.5 万行。ducktape というフレームワークで、**複数のマシンに実際のプロセスを立てて**検証する。アップグレードのテスト (古いバージョンから新しいバージョンへのローリング) は、ここでしかできない。

**Trogdor** は故障注入のフレームワークだ。

```text title="trogdor/README.md"
Trogdor is a test framework for Apache Kafka.

Trogdor can run benchmarks and other workloads. Trogdor can also inject faults in order to stress test the system.

Trogdor should only be used in development environment and it is designed to allow users to inject commands.
For this reason, Apache Kafka project does not consider this a security issue.
```

[`README.md#L1-L9`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/trogdor/README.md)。

**「開発環境でだけ使え。任意のコマンドを実行できる設計なので、これをセキュリティ問題とは扱わない」** という但し書きが付いている。**危険な道具であることを、README の 5 行目で宣言している。**

**JMH のベンチマーク**は 50 個ある。

```text title="jmh-benchmarks/README.md"
Writing correct micro-benchmarks in Java (or another JVM language) is difficult and there are many non-obvious pitfalls (many
due to compiler optimizations). JMH is a framework for running and analyzing benchmarks (micro or macro) written in Java (or
another JVM language).
```

[`README.md#L1-L6`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/jmh-benchmarks/README.md)。

対象を見ると、**この章で扱ってきた場所とよく一致する。** `LogValidator` ([レコードバッチ](../record-batch/))、`FetchSession` ([フェッチセッション](../fetch-session/))、`TestPurgatoryPerformance` ([purgatory](../purgatory/))、`RegexResolutionBenchmark` ([グループ協調](../rebalance-protocol/))。

**性能が問題になった箇所には、ベンチマークが残っている。**

## なぜそうなっているか

### なぜ「テストを構成に展開する」のか

設定の組み合わせは掛け算で増える。ブローカー数 3 通り × セキュリティプロトコル 4 通り × `MetadataVersion` 10 通りで 120 通り。

**テストごとに全部書くのは不可能だ。** かといって 1 通りしかテストしないと、他の構成で壊れる。

**テストの本体と構成を分離すれば、構成は増えてもテストコードは増えない。** JUnit の「テストテンプレート」という機能がこれを可能にしている。

**「同じ検証を、違う環境で繰り返す」は分散システムのテストで本質的な要求**で、それを言語やフレームワークの機能で表現できるかが、テストの量を決める。

### なぜ同一 JVM でクラスタを立てるのか

Kafka のブローカーは、`BrokerServer` というクラスをインスタンス化するだけで起動する ([KRaft のページ](../kraft-overview/))。プロセスを分ける必要がない。

同一 JVM の利点は、

- **起動が速い。** 数秒。プロセスを立てると数十秒。
- **デバッガが使える。** ブレークポイントがブローカーの中で止まる。
- **テストからブローカーの内部状態を直接見られる。**

代償は、**本番と違う条件でテストしていること**だ。同じ JVM なのでクラスローダを共有し、GC も共有する。**プロセス分離が関わるバグは捕まらない。**

だから **Python の統合テストが別に要る。** 「速いが本番と違うテスト」と「遅いが本番に近いテスト」を両方持つ。

### なぜ継承をやめて注入にしたのか

`previously garnered from the test hierarchy` という一文が、以前の設計を示している。

テストの基底クラスによる共有は、最初は便利だ。だが、

- **階層が深くなる。** `AbstractXxxTest` → `BaseYyyTest` → `ZzzTest`。
- **どこで何が設定されているか追えない。** `@BeforeEach` が 3 階層で定義されている。
- **1 つのテストクラスは 1 つの基底クラスしか継承できない。** 組み合わせられない。

**注入なら、テストメソッドのシグネチャに全部現れる。** そして、複数の依存を注入できる。

**「テストの共通処理を継承で共有する」は、規模が大きくなると必ず破綻する。** Kafka はそれを経験して、注入に移した。

### なぜテストを「仕様」として組み立てるのか

階層型ストレージのテストは、**アクションの列を先に構築してから実行する。**

普通に手続き的に書くこともできる。そうしない理由は、

- **アクションが非同期で、待ちを伴う。** 「セグメントがリモートに移るまで待つ」を毎回書くと冗長になる。
- **失敗時のレポートを、共通の形で出したい。** どのアクションで止まったか。
- **テストの意図が読める。** アクション名の列が、そのままシナリオになる。

**「実行可能な仕様」という形は、シナリオが複雑で、待ちが多いテストで効く。** ただし **フレームワークを作るコストがかかる**ので、テストの数が少ないうちは割に合わない。

### 危険な道具に、危険だと書く

Trogdor の README にある `Trogdor should only be used in development environment and it is designed to allow users to inject commands. For this reason, Apache Kafka project does not consider this a security issue.` は、短いが重要な一文だ。

**「任意のコマンドを実行できる」は、普通なら重大な脆弱性だ。** だがこのツールは、故障を注入するために意図的にそう作られている。

**「これは仕様であって、バグではない」を明示している。** これがないと、セキュリティスキャナや監査で毎回指摘され、そのたびに説明することになる。

**意図的に危険な設計をするなら、その意図を最も目立つ場所に書く。**

### ベンチマークが残っている場所

JMH のベンチマーク 50 個の対象は、**性能問題が実際に起きた場所**とよく重なる。

- `LogValidator` — [レコードの検証と offset の割り当て](../record-batch/)。全書き込みが通る。
- `FetchSession` — [フェッチセッション](../fetch-session/)。パーティション数に比例する処理があった。
- `TestPurgatoryPerformance` — [purgatory](../purgatory/)。数十万の待機操作を扱う。
- `RegexResolutionBenchmark` — 正規表現による購読の解決。グループのメンバ数 × トピック数。

**ベンチマークは「ここが遅くなると困る」という知識の記録でもある。** 新しい人が最適化を外したときに、CI で気づける。

## どう活かすか

**「テストの本体と実行環境の構成を分離する」は、設定の組み合わせが多いシステムで決定的に効く。** JUnit のテストテンプレート、pytest の `parametrize`、Go のテーブル駆動テスト — **どの言語にも仕組みがある。** 構成を増やしてもテストコードが増えないなら、構成を増やすことをためらわなくなる。

**「宣言的な指定」と「コードでの生成」の両方の口を用意する。** アノテーションだけだと網羅的なテストが書けず、コード生成だけだと単純なケースが冗長になる。**Kafka は `@ClusterTest` と `@ClusterTemplate` の 2 つを持っている。**

**テストの共通処理は、継承ではなく注入で共有する。** 継承は最初は楽だが、階層が深くなると「どこで何が設定されているか」が追えなくなり、組み合わせもできない。**Kafka は基底クラスから `ClusterInstance` の注入に移した。** テストコードが増える前に、この判断をしておきたい。

**「速いが本番と違うテスト」と「遅いが本番に近いテスト」を両方持つ。** 片方だけだと、開発サイクルが遅くなるか、本番でしか出ないバグを見逃すかのどちらかになる。**同一 JVM のクラスタテストと、別プロセスの統合テストは、目的が違う。**

**意図的に危険な設計をしたら、その意図を README の冒頭に書く。** Trogdor の一文は 3 行だが、これがないと同じ説明を何度もすることになる。

**そして、性能が問題になった箇所にはベンチマークを残す。** ベンチマークは性能を測る道具であると同時に、**「ここは速くなければならない」という知識の記録**でもある。次に触る人が、それを知らずに遅くするのを防ぐ。

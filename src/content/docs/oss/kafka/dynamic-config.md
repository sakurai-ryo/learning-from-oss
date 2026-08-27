---
title: "再起動なしで設定を変える"
description: "Kafka の設定は、静的なファイルとメタデータログに書かれた動的な値の重ね合わせで決まる。動的に変えられる設定は、値を読み直すだけでは足りず、スレッドプールを縮めたり TLS 証明書を読み直したりという副作用を伴う。その副作用を持つコンポーネントが、共通のインタフェースで名乗り出る形になっている。"
sidebar:
  order: 36
---

## 何を学んだか

### どんな状況の話か

ブローカーの設定を変えたい。たとえば、

- I/O スレッドの数を増やす。
- TLS の証明書を更新する。
- ログの保持期間を延ばす。
- [クォータ](../quota-throttle/)の上限を変える。

**再起動すれば確実に反映される。** だが、ブローカーの再起動は安いオペレーションではない。

- そのブローカーがリーダーになっているパーティションを全部移す ([計画的シャットダウン](../broker-lifecycle/))。
- 起動時に[ログの復旧](../log-recovery/)が走る。数百 GB なら数分。
- 起動後、[メタデータに追いついてから unfence される](../broker-lifecycle/)。
- 100 台のクラスタなら、これを 100 回繰り返す。

**証明書の更新のたびにクラスタ全体を回すのは、現実的でない。**

### Kafka の答え

**設定を階層化し、動的に変えられるものは「変更を受け取るコンポーネント」が名乗り出る形にする。**

```scala title="core/src/main/scala/kafka/server/DynamicBrokerConfig.scala"
/**
  * Dynamic broker configurations may be defined at two levels:
  * <ul>
  *   <li>Per-broker configurations are persisted at the controller and can be described
  *         or altered using AdminClient with the resource name brokerId.</li>
  *   <li>Cluster-wide default configurations are persisted at the cluster level and can be
  *         described or altered using AdminClient with an empty resource name.</li>
  * </ul>
  * The order of precedence for broker configs is:
  * <ol>
  *   <li>STATIC_BROKER_CONFIG: properties that broker is started up with, typically from server.properties file</li>
  *   <li>DEFAULT_CONFIG: Default configs defined in KafkaConfig</li>
  * </ol>
  */
object DynamicBrokerConfig {
```

[`DynamicBrokerConfig.scala#L56-L88`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/core/src/main/scala/kafka/server/DynamicBrokerConfig.scala#L56-L88)。

1. **設定の層は 4 つ。** ブローカー個別の動的設定 > クラスタ全体の動的設定 > `server.properties` > コード上のデフォルト。
2. **動的設定は[メタデータログ](../kraft-overview/)に `ConfigRecord` として書かれる。**
3. **変更を受け取るコンポーネントは `Reconfigurable` / `BrokerReconfigurable` を実装する。**
4. **適用は 2 段階。** 全部を検証してから、全部を適用する。
5. **リスナーごとの設定は、専用の経路を持つ。**

## ソースコードのどこか

### 変更を受け取る契約

```scala title="core/src/main/scala/kafka/server/DynamicBrokerConfig.scala"
trait BrokerReconfigurable {

  def reconfigurableConfigs: util.Set[String]

  def validateReconfiguration(newConfig: KafkaConfig): Unit

  def reconfigure(oldConfig: KafkaConfig, newConfig: KafkaConfig): Unit
}
```

[`DynamicBrokerConfig.scala#L533-L540`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/core/src/main/scala/kafka/server/DynamicBrokerConfig.scala#L533-L540)。

**3 メソッドだけ。**

1. **`reconfigurableConfigs`**: 「私はこの設定に関心があります」。
2. **`validateReconfiguration`**: 「この新しい値は受け入れられますか」。**まだ適用しない。**
3. **`reconfigure`**: 「適用してください」。

**検証と適用が分かれている**のが要点だ。理由は次の節で見る。

実装は多い。`DynamicLogConfig`、`DynamicThreadPool`、`DynamicListenerConfig`、`DynamicMetricsReporters`、`SocketServer`、`ReplicaManager` など。

**「設定変更に反応する必要があるもの」が、それぞれ自分で名乗り出る。** `DynamicBrokerConfig` は、誰が何に反応するかを知らない。

### 2 段階の適用

```scala title="core/src/main/scala/kafka/server/DynamicBrokerConfig.scala"
// BrokerReconfigurable updates are processed after config is updated. Only do the validation here.
val brokerReconfigurablesToUpdate = mutable.Buffer[BrokerReconfigurable]()
brokerReconfigurables.forEach { reconfigurable =>
  if (needsReconfiguration(reconfigurable.reconfigurableConfigs, changeMap.keySet, deletedKeySet)) {
    reconfigurable.validateReconfiguration(newConfig)
    if (!validateOnly)
      brokerReconfigurablesToUpdate += reconfigurable
  }
}
(newConfig, brokerReconfigurablesToUpdate.toList)
} catch {
  case e: Exception =>
    if (!validateOnly)
      error(s"Failed to update broker configuration with configs : " +
            s"${ConfigUtils.configMapToRedactedString(newConfig.originalsFromThisConfig, KafkaConfig.configDef)}", e)
    throw new ConfigException("Invalid dynamic configuration", e)
}
```

[`DynamicBrokerConfig.scala#L463-L479`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/core/src/main/scala/kafka/server/DynamicBrokerConfig.scala#L463-L479)。

**全員の `validateReconfiguration` を先に呼ぶ。** 1 つでも例外を投げたら、**誰も `reconfigure` されない。**

これがないと、「スレッドプールは新しい値になったが、ログ設定の適用で失敗した」という **中途半端な状態**が生まれる。設定によっては元に戻せない。

```scala title="core/src/main/scala/kafka/server/DynamicBrokerConfig.scala"
private def updateCurrentConfig(doLog: Boolean): Unit = {
  val newProps = mutable.Map[String, String]()
  newProps ++= staticBrokerConfigs
  overrideProps(newProps, dynamicDefaultConfigs)
  overrideProps(newProps, dynamicBrokerConfigs)
  ...
  val oldConfig = currentConfig
  val (newConfig, brokerReconfigurablesToUpdate) = processReconfiguration(newProps, validateOnly = false, doLog)
  if (newConfig ne currentConfig) {
    currentConfig = newConfig
    kafkaConfig.updateCurrentConfig(newConfig)

    // Process BrokerReconfigurable updates after current config is updated
    brokerReconfigurablesToUpdate.foreach(_.reconfigure(oldConfig, newConfig))
  }
}
```

[`DynamicBrokerConfig.scala#L428-L446`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/core/src/main/scala/kafka/server/DynamicBrokerConfig.scala#L428-L446)。

**設定の合成が 3 行で書かれている。**

```text
staticBrokerConfigs        (server.properties)
  ← dynamicDefaultConfigs  (クラスタ全体の動的設定で上書き)
    ← dynamicBrokerConfigs (このブローカー個別の動的設定で上書き)
```

**上書きの順序が、そのまま優先順位になっている。**

そして **`reconfigure` に新旧両方の設定を渡している。** 「何が変わったか」を各コンポーネントが判断できる。**スレッド数が 8 から 16 に増えたのか、16 から 8 に減ったのかで、やることが違う。**

### 同義語の扱い

```scala title="core/src/main/scala/kafka/server/DynamicBrokerConfig.scala"
JDynamicBrokerConfig.brokerConfigSynonyms(k, false).forEach(props.remove)
props.put(k, v)
```

[`DynamicBrokerConfig.scala#L423-L424`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/core/src/main/scala/kafka/server/DynamicBrokerConfig.scala#L423-L424)。

javadoc に説明がある。

```scala title="core/src/main/scala/kafka/server/DynamicBrokerConfig.scala"
  *   <li>Some configs may be defined using multiple properties. For example, <tt>log.roll.ms</tt> and
  *       <tt>log.roll.hours</tt> refer to the same config that may be defined in milliseconds or hours.</li>
```

[`DynamicBrokerConfig.scala#L82-L84`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/core/src/main/scala/kafka/server/DynamicBrokerConfig.scala#L82-L84)。

**`log.roll.ms` と `log.roll.hours` は同じ設定を別の単位で表す。** 動的設定で `log.roll.ms` を入れたら、静的設定の `log.roll.hours` を**消さないといけない。** そうしないと、どちらが勝つかが不定になる。

**「同じ意味の設定が複数の名前を持つ」のは、後方互換性を保ちながら設定を改名した結果**だ。改名のコストが、こういう形で残っている。

**同義語の表を持ち、上書き時に関連する名前を全部消す。** 地味だが、これがないと「動的設定を入れたのに効かない」という不可解な現象になる。

### リスナー設定の特別扱い

```scala title="core/src/main/scala/kafka/server/DynamicBrokerConfig.scala"
reconfigurables.forEach {
  case listenerReconfigurable: ListenerReconfigurable =>
    processListenerReconfigurable(listenerReconfigurable, newConfig, customConfigs, validateOnly, reloadOnly = false)
  case reconfigurable =>
    if (needsReconfiguration(reconfigurable.reconfigurableConfigs, changeMap.keySet, deletedKeySet))
      processReconfigurable(reconfigurable, changeMap.keySet, newConfig.valuesFromThisConfig, customConfigs, validateOnly)
}
```

[`DynamicBrokerConfig.scala#L455-L461`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/core/src/main/scala/kafka/server/DynamicBrokerConfig.scala#L455-L461)。

**リスナーごとの設定は別経路になっている。** `listener.name.internal.ssl.keystore.location` のように、**設定名にリスナー名が埋め込まれる**からだ。

同じ `ssl.keystore.location` でも、リスナーごとに別の値を持ちうる。**「どのリスナー向けの設定か」を解決してから渡す**必要がある。

### ファイルの再読み込み

```scala title="core/src/main/scala/kafka/server/DynamicBrokerConfig.scala"
private val ReloadableFileConfigs = Set(SslConfigs.SSL_KEYSTORE_LOCATION_CONFIG, SslConfigs.SSL_TRUSTSTORE_LOCATION_CONFIG)
```

[`DynamicBrokerConfig.scala#L90`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/core/src/main/scala/kafka/server/DynamicBrokerConfig.scala#L90)。

**証明書のパスは変わらないが、中身が変わることがある。** 証明書の更新は、たいてい同じパスに新しいファイルを置く形で行われる。

**「設定値は変わっていないが、再読み込みしてほしい」** という要求のために、この 2 つだけ特別扱いされている。値の変更を検出するのではなく、**明示的に「再読み込みせよ」という操作を受け付ける。**

## なぜそうなっているか

### なぜ検証と適用を分けるのか

**設定変更は、複数のコンポーネントにまたがる。** 1 回の変更で、スレッドプール・ログ設定・メトリクスレポータが同時に反応しうる。

適用しながら進むと、**途中で失敗したときに中途半端になる。**

```text
[悪い順序]
1. スレッドプールを 16 に増やす → 成功
2. ログ保持期間を変える → 検証エラー
   → スレッドプールだけ変わった状態。元に戻すコードが必要
```

**全部検証してから全部適用すれば、失敗しても何も変わらない。** ロールバックのコードが要らない。

これは **2 相コミットと同じ形**で、[トランザクション](../transactions-eos/)の `PREPARE` → `COMMIT` に対応する。**「準備で失敗しうる操作」と「失敗しない適用」に分けられるかが、成立の条件になる。**

ただし、**`reconfigure` が失敗しないという保証はコードにはない。** 実装者が守るべき規約になっている。

### なぜコンポーネントが名乗り出るのか

`DynamicBrokerConfig` が「`num.io.threads` が変わったら `KafkaRequestHandlerPool.resize()` を呼ぶ」と直接書くこともできた。

そうしない理由は、

- **設定と、それに反応するコンポーネントの対応が増え続ける。** 中央に書くと、そのファイルが肥大化する。
- **コンポーネント側が「自分の設定」を一番よく知っている。** 検証のロジックもそこにある。
- **テストが独立する。** `DynamicThreadPool` だけをテストできる。

**登録型のプラグイン構造**で、[メタデータの購読者](../metadata-image-delta/) と同じ形になっている。

### なぜ設定を 4 層にするのか

層が多いのは複雑だが、それぞれに役割がある。

| 層                       | 誰が設定するか                | いつ変わるか                   |
| ------------------------ | ----------------------------- | ------------------------------ |
| ブローカー個別の動的設定 | 運用者 (`AdminClient`)        | **1 台だけ調整したいとき**     |
| クラスタ全体の動的設定   | 運用者                        | **全台に同じ値を配りたいとき** |
| `server.properties`      | プロビジョニング (Ansible 等) | デプロイ時                     |
| コードのデフォルト       | 開発者                        | リリース時                     |

**「1 台だけ」と「全台」を分けられるのが効いている。** 問題のあるブローカー 1 台だけスレッド数を増やして様子を見る、といった運用ができる。

そして、**動的設定は[メタデータログ](../kraft-overview/)に載る。** ブローカーが再起動しても残るし、新しく参加したブローカーにも自動的に配られる。

**[この章の主題](../) がここでも出ている** — 状態を持つ必要が出たら、ログに書く。

### なぜ「値が変わっていなくても再読み込み」が要るのか

設定の仕組みは、普通「値が変わったら反応する」で作られる。だが **TLS 証明書は、パスが同じで中身が変わる。**

値の変更を検出する仕組みでは、これを拾えない。**ファイルの mtime を監視する**手もあるが、それだと「いつ再読み込みされるか」が運用者から見て不透明になる。

**Kafka は「再読み込みせよ」という明示的な操作を受け付ける**ことにした。運用者が証明書を置き換えてから、`AdminClient` で同じ値を設定し直す。

**「値」ではなく「値が指す先」が変わるケースは、設定システムを作るとき必ず出てくる。** ファイルパス、URL、外部の参照。**値の比較では検出できない。**

### 動的にできない設定もある

すべての設定が動的に変えられるわけではない。`node.id`、`process.roles`、`log.dirs` などは静的なままだ。

動的にできるかどうかの分かれ目は、**「変更を安全に適用するコードが書けるか」** にある。

- **スレッドプールのサイズ** → 増やす・減らすの実装がある。動的にできる。
- **`log.dirs`** → ディスクを増やしたら、パーティションを再配置する必要がある。**設定の変更だけでは済まない。**

**「動的にできる」は、値を読み直せることではなく、状態を遷移させるコードがあること。** その差が `BrokerReconfigurable` を実装しているかどうかに現れている。

## どう活かすか

**「設定を層にして、上書きの順序を優先順位にする」は、シンプルだが強い。** 合成が 3 行の `overrideProps` で書けて、優先順位がコードを読めば分かる。**層を増やすときも、行を 1 つ足すだけで済む。**

**「変更を全部検証してから、全部適用する」は、複数コンポーネントにまたがる変更で必須だ。** 適用しながら進むと、失敗時のロールバックが必要になり、そのコードはテストされにくく、必ず腐る。**検証と適用を分けられる形に設計する。**

**「反応するコンポーネントが自分で名乗り出る」構造は、対応関係が増え続ける場面で効く。** 中央のディスパッチャに全部書くと、そこが肥大化し、新しい設定を足すたびに 2 箇所を触ることになる。**インタフェースを 3 メソッドに絞れば、実装のコストも低い。**

**「値が指す先が変わる」ケースを、設計に最初から入れておく。** ファイルパス、URL、シークレットの参照。**値の比較では変更を検出できない**ので、明示的な「再読み込み」操作が要る。後付けすると、値の変更検出のロジックに例外を挟む形になって汚くなる。

**そして、「動的に変えられる設定」を増やすときは、それが本当に「値を読み直すだけ」なのかを確認する。** スレッドプールの縮小、コネクションの張り直し、キャッシュの破棄 — **状態を持つコンポーネントの設定変更は、たいてい状態遷移を伴う。** その遷移が書けないなら、その設定は静的なままにしておくほうが正直だ。

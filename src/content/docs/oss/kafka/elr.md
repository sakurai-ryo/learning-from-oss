---
title: "ISR が空になったときの選択肢を増やす"
description: "ISR が全滅すると、Kafka には「止まる」か「データを失う」しかなかった。ELR は、ISR から外れたレプリカのうち「データを失っていないと分かっているもの」を別の集合として追跡し、第 3 の選択肢を作る。判定の根拠は、ブローカーがクリーンにシャットダウンしたかどうかだ。"
group: "レプリケーション"
sidebar:
  order: 14
---

## 何を学んだか

### どんな状況の話か

[ISR のページ](../isr-highwatermark/) で見たとおり、Kafka の書き込みは「ISR 全員が受け取ったら成功」だ。ISR が縮んでいくと、最後には空になりうる。

```text
replication.factor = 3, min.insync.replicas = 2

初期: ISR = {A, B, C}。A がリーダー。
1. C が遅れて ISR から外れる。ISR = {A, B}。まだ書ける。
2. B が落ちる。ISR = {A}。min.insync.replicas を下回るので acks=all は拒否される。
3. A も落ちる。ISR = {A} のまま (誰も更新できない)。リーダー不在。
```

この状態で選べるのは 2 つしかなかった。

- **待つ。** A が戻るまでパーティションは読み書きできない。A のディスクが壊れていたら永遠に戻らない。
- **unclean leader election。** B か C を強制的にリーダーにする。**確実にデータが失われる。** どこまで失われるかも分からない。

問題は、**3 の時点で B は「ほぼ最新」かもしれない**ことだ。B が ISR から外れたのは A が落ちる直前で、実は high watermark まで持っているかもしれない。**しかしその情報がどこにも残っていない。**

### Kafka の答え

**ISR から外れたレプリカのうち「データを失っていないと分かっているもの」を、ELR (Eligible Leader Replicas) として別に記録する。**

1. **ISR が `min.insync.replicas` を下回ったら、ISR から外れたメンバを ELR に移す。** 捨てずに覚えておく。
2. **ELR から外す条件は「unclean にシャットダウンした」こと。** ログの末尾を失った可能性があるレプリカだけを除く。
3. **ISR が空になったら、ELR から選出する。** これは unclean election ではない。**ELR のメンバは HW までのデータを持っていることが保証されている。**
4. **ISR が `min.insync.replicas` 以上に戻ったら、ELR をクリアする。** 平常時はメタデータを持たない。
5. **クリーンなシャットダウンかどうかは、シャットダウンマーカーに書かれた broker epoch で判定する。**

## ソースコードのどこか

### パーティションが持つようになった 2 つのフィールド

```java title="metadata/src/main/java/org/apache/kafka/metadata/PartitionRegistration.java"
public final int[] elr;
```

[`PartitionRegistration.java#L158`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/metadata/src/main/java/org/apache/kafka/metadata/PartitionRegistration.java#L158)。

`elr` と `lastKnownElr` の 2 つが増えている。どちらも[メタデータログ](../kraft-overview/) の `PartitionRecord` / `PartitionChangeRecord` に載り、クラスタ全体で共有される。

**「知っているが ISR ではない」という状態を、明示的に記録する場所を作った**のがこの機能の本体だ。

### ELR の維持

```java title="metadata/src/main/java/org/apache/kafka/controller/PartitionChangeBuilder.java"
private void maybePopulateTargetElr() {
    if (!eligibleLeaderReplicasEnabled) return;

    // If the ISR is larger or equal to the min ISR, clear the ELR and LastKnownElr.
    if (targetIsr.size() >= minISR) {
        targetElr = List.of();
        targetLastKnownElr = List.of();
        return;
    }

    Set<Integer> targetIsrSet = new HashSet<>(targetIsr);
    // Tracking the ELR. The new elr is expected to
    // 1. Include the current ISR
    // 2. Exclude the duplicate replicas between elr and target ISR.
    // 3. Exclude unclean shutdown replicas.
    // To do that, we first union the current ISR and current elr, then filter out the target ISR and unclean shutdown
    // Replicas.
    Set<Integer> candidateSet = new HashSet<>(targetElr);
    Arrays.stream(partition.isr).forEach(candidateSet::add);
    targetElr = candidateSet.stream()
        .filter(replica -> !targetIsrSet.contains(replica))
        .filter(replica -> uncleanShutdownReplicas == null || !uncleanShutdownReplicas.contains(replica))
        .collect(Collectors.toList());
```

[`PartitionChangeBuilder.java#L532-L554`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/metadata/src/main/java/org/apache/kafka/controller/PartitionChangeBuilder.java#L532-L554)。

**最初の分岐が効いている。** ISR が `min.insync.replicas` 以上あるなら、ELR は空にする。

つまり **平常時は ELR が存在しない**。メタデータのサイズが増えるのは、ISR が縮んで危険な状態になっているときだけだ。**新しい機能を足すときに「平常時のコストをゼロにする」設計になっている。**

ELR の中身は「(現在の ELR ∪ 現在の ISR) − 新しい ISR − unclean shutdown したレプリカ」。**ISR から落ちたメンバが、そのまま ELR に流れ込む。**

`lastKnownElr` はさらにその外側で、ELR からも外れたメンバを記録する。

```java title="metadata/src/main/java/org/apache/kafka/controller/PartitionChangeBuilder.java"
// Calculate the new last known ELR. Includes any ISR members since the ISR size drops below min ISR.
// In order to reduce the metadata usage, the last known ELR excludes the members in ELR and current ISR.
candidateSet.addAll(targetLastKnownElr);
targetLastKnownElr = candidateSet.stream()
    .filter(replica -> !targetIsrSet.contains(replica))
    .filter(replica -> !targetElr.contains(replica))
    .collect(Collectors.toList());
```

[`PartitionChangeBuilder.java#L556-L562`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/metadata/src/main/java/org/apache/kafka/controller/PartitionChangeBuilder.java#L556-L562)。

**3 つの集合が入れ子ではなく排他になっている** — ISR、ELR、lastKnownElr のどれか 1 つにしか入らない。メタデータのサイズを削るための工夫だ。

### リーダーになれる条件

```java title="metadata/src/main/java/org/apache/kafka/controller/PartitionChangeBuilder.java"
private boolean isValidNewLeader(int replica) {
    // The valid new leader should be in either ISR or in ELR when ISR is empty.
    return (targetIsr.contains(replica) || (targetIsr.isEmpty() && targetElr.contains(replica))) &&
        isAcceptableLeader.test(replica);
}
```

[`PartitionChangeBuilder.java#L318-L322`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/metadata/src/main/java/org/apache/kafka/controller/PartitionChangeBuilder.java#L318-L322)。

**ELR から選べるのは「ISR が空のとき」だけ。** ISR に誰かいるなら、必ずそちらを選ぶ。ELR はあくまで最後の手段だ。

選出の全体像を見ると、優先順位が 4 段になっているのが分かる。

```java title="metadata/src/main/java/org/apache/kafka/controller/PartitionChangeBuilder.java"
private ElectionResult electAnyLeader() {
    if (isValidNewLeader(partition.leader)) {
        // Don't consider a new leader since the current leader meets all the constraints
        return new ElectionResult(partition.leader, false);
    }

    Optional<Integer> onlineLeader = targetReplicas.stream()
        .filter(this::isValidNewLeader)
        .findFirst();
    if (onlineLeader.isPresent()) {
        return new ElectionResult(onlineLeader.get(), false);
    }

    if (canElectLastKnownLeader()) {
        return new ElectionResult(partition.lastKnownElr[0], true);
    }

    if (election == Election.UNCLEAN) {
        // Attempt unclean leader election
        Optional<Integer> uncleanLeader = targetReplicas.stream()
            .filter(isAcceptableLeader::test)
            .findFirst();
        if (uncleanLeader.isPresent()) {
            return new ElectionResult(uncleanLeader.get(), true);
        }
    }

    return new ElectionResult(NO_LEADER, false);
}
```

[`PartitionChangeBuilder.java#L256-L283`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/metadata/src/main/java/org/apache/kafka/controller/PartitionChangeBuilder.java#L256-L283)。

| 優先順位 | 候補                                                                | データ損失              |
| -------- | ------------------------------------------------------------------- | ----------------------- |
| 1        | 現在のリーダーが有効ならそのまま                                    | なし                    |
| 2        | ISR のメンバ、ISR が空なら **ELR のメンバ**                         | **なし**                |
| 3        | 最後に知られていたリーダー (`lastKnownElr`)                         | あり (`unclean = true`) |
| 4        | `unclean.leader.election.enable` があれば、生きている任意のレプリカ | あり                    |

**2 番目に ELR が入ったことで、「3 に落ちる前に助かる」ケースが増えた。** これが KIP-966 の効果だ。

選出後の処理も見ておきたい。

```java title="metadata/src/main/java/org/apache/kafka/controller/PartitionChangeBuilder.java"
if (targetElr.contains(electionResult.node)) {
    targetIsr = List.of(electionResult.node);
    targetElr = targetElr.stream().filter(replica -> replica != electionResult.node)
        .collect(Collectors.toList());
    log.info("Setting new leader for topicId {}, partition {} to {} using ELR. Previous partition: {}, change record: {}",
            topicId, partitionId, electionResult.node, partition, record);
}
```

[`PartitionChangeBuilder.java#L330-L336`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/metadata/src/main/java/org/apache/kafka/controller/PartitionChangeBuilder.java#L330-L336)。

**ELR から選ばれたレプリカは、その場で ISR に移される。** そしてログは INFO レベルで出る — clean election は TRACE なので、**「ELR から選出した」は運用者に見えるようになっている。**

### ISR が空でもよくなった

```java title="metadata/src/main/java/org/apache/kafka/controller/PartitionChangeBuilder.java"
// If ELR is enabled, the ISR is allowed to be empty.
if (record.isr() == null && (!targetIsr.isEmpty() || eligibleLeaderReplicasEnabled) &&
    !targetIsr.equals(Replicas.toList(partition.isr))) {
    // Set the new ISR if it is different from the current ISR and unclean leader election didn't already set it.
    if (targetIsr.isEmpty()) {
        log.debug("A partition will have an empty ISR. {}", this);
    }
    record.setIsr(targetIsr);
}
```

[`PartitionChangeBuilder.java#L441-L449`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/metadata/src/main/java/org/apache/kafka/controller/PartitionChangeBuilder.java#L441-L449)。

**ELR がない時代は、ISR を空にできなかった。** 空にすると「最後にいたのが誰か」の情報が失われ、unclean election で誰を選ぶかの手がかりがなくなるからだ。だから最後の 1 人は ISR に残し続けていた。

**ELR ができたので、ISR を正直に空にできる。** 情報は ELR が持っている。**「事実を正確に記録できるようになったので、嘘をつかなくてよくなった」** という形の改善になっている。

### 「クリーンに落ちたか」の判定

```java title="metadata/src/main/java/org/apache/kafka/controller/ReplicationControlManager.java"
/**
 * Create partition change records to remove replicas from any ISR or ELR for brokers when the shutdown is detected.
 */
void handleBrokerShutdown(int brokerId, boolean isCleanShutdown, List<ApiMessageAndVersion> records) {
    if (featureControl.isElrFeatureEnabled() && !isCleanShutdown) {
        // ELR is enabled, generate unclean shutdown partition change records
        generateLeaderAndIsrUpdates("handleBrokerUncleanShutdown", NO_LEADER, NO_LEADER, brokerId, records,
            brokersToIsrs.partitionsWithBrokerInIsr(brokerId));
        generateLeaderAndIsrUpdates("handleBrokerUncleanShutdown", NO_LEADER, NO_LEADER, brokerId, records,
            brokersToElrs.partitionsWithBrokerInElr(brokerId));
    } else {
        // ELR is not enabled or if it is a clean shutdown, handle the shutdown as if the broker was fenced
        generateLeaderAndIsrUpdates("handleBrokerShutdown", brokerId, NO_LEADER, NO_LEADER, records,
            brokersToIsrs.partitionsWithBrokerInIsr(brokerId));
    }
}
```

[`ReplicationControlManager.java#L1474-L1493`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/metadata/src/main/java/org/apache/kafka/controller/ReplicationControlManager.java#L1474-L1493)。

**unclean にシャットダウンしたブローカーは、ISR からも ELR からも外される。** クリーンなら ISR から外れるだけで、ELR には残る。

では「クリーンかどうか」はどう分かるのか。[復旧のページ](../log-recovery/) で見たクリーンシャットダウンマーカーが、ここで使われる。

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/LogManager.java"
// mark that the shutdown was clean by creating marker file for log dirs that:
//  1. had clean shutdown marker file; or
//  2. had no clean shutdown marker file, but all logs under it have been recovered at startup time
String logDirAbsolutePath = dir.getAbsolutePath();
if (hadCleanShutdownFlags.getOrDefault(logDirAbsolutePath, false) ||
        loadLogsCompletedFlags.getOrDefault(logDirAbsolutePath, false)) {
    CleanShutdownFileHandler cleanShutdownFileHandler = new CleanShutdownFileHandler(dir.getPath());
    LOG.debug("Writing clean shutdown marker at {} with broker epoch={}", dir, brokerEpoch);
    Utils.swallow(LOG, () -> cleanShutdownFileHandler.write(brokerEpoch));
}
```

[`LogManager.java#L905-L914`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/log/LogManager.java#L905-L914)。

**マーカーファイルに broker epoch を書く。** これが ELR のために追加された部分だ。単に「クリーンに落ちた」だけでは足りない — **「どの世代のプロセスがクリーンに落ちたか」が要る**。

起動時には全ログディレクトリのマーカーを読んで、epoch が揃っているかを確認する。

```java title="storage/src/main/java/org/apache/kafka/storage/internals/log/LogManager.java"
// Verify whether all the log dirs have the same broker epoch in their clean shutdown files. If there is any dir not
// live, fail the broker epoch check.
if (liveLogDirs.size() < logDirs.size()) {
    return OptionalLong.empty();
}
long brokerEpoch = -1L;
for (File dir : liveLogDirs) {
    ...
    if (brokerEpoch != -1 && currentBrokerEpoch.getAsLong() != brokerEpoch) {
        LOG.info("Found different broker epochs in {}. Other={} vs current={}.", dir, brokerEpoch, currentBrokerEpoch);
        return OptionalLong.empty();
    }
```

[`LogManager.java#L1835-L1855`](https://github.com/apache/kafka/blob/66c197c9f9749715de55f9a415e6aade73ac7830/storage/src/main/java/org/apache/kafka/storage/internals/log/LogManager.java#L1835-L1855)。

**ディスクが 1 本でも欠けていたら、クリーンとは認めない。** そのディスクにあったパーティションのデータは失われているかもしれない。epoch がディスク間で食い違っていても認めない。**「全部揃っていて、全部同じ世代」でなければ、クリーンではない。**

この epoch がブローカー登録時にコントローラへ報告され、コントローラが「前回はクリーンに落ちた」と判定する材料になる。

## なぜそうなっているか

### 情報を捨てなければ、選択肢が増える

ELR が解いているのは、**「ISR から外れた瞬間に、そのレプリカについて何も分からなくなる」** という情報の欠落だ。

ISR から外れる理由は「遅れている」であって、「データが壊れた」ではない。**遅れているレプリカも、HW までのデータは持っている**可能性が高い。その情報を捨てていたので、ISR が空になったときに「誰も信用できない」状態になっていた。

**ELR は新しい保証を作っていない。既にあった保証を記録するようにしただけだ。** 「ISR から外れたとき、そのレプリカは HW まで持っていた」という事実は前からあった。それを書き留めていなかった。

**「捨てていた情報に名前を付けて記録する」だけで、可用性と耐久性の両方が改善する** — というのがこの KIP の面白さになっている。

### なぜ判定基準が「クリーンなシャットダウン」なのか

ELR から外すべきなのは、**「HW まで持っている」が言えなくなったレプリカ**だ。

[セグメントのページ](../log-segment/) で見たとおり、Kafka は既定で fsync しない。**マシンが電源ごと落ちると、ページキャッシュにあったデータは失われる。** その分、ログの末尾が短くなる。だから unclean shutdown したレプリカは「HW まで持っている」と言えない。

一方、**プロセスが正常終了したなら、シャットダウン時にフラッシュしている**ので、持っているデータは残っている。

**「fsync しない」という選択が、ここで ELR の判定基準を決めている。** もし常に fsync していたら、電源断でもデータは残るので、この区別は不要だった。**下位層のトレードオフが、上位層の設計に条件として現れる**もう 1 つの例になっている。

### なぜ平常時は ELR を空にするのか

ELR を常に維持すると、`replication.factor - |ISR|` 個のレプリカ ID をメタデータに持ち続けることになる。パーティションが 10 万個あれば、それだけメタデータログが太る。

**[メタデータは全ブローカーに複製され、全ブローカーのメモリに載る](../metadata-image-delta/)。** サイズが直接コストになる。

だから「危険な状態のときだけ持つ」。`targetIsr.size() >= minISR` なら空にする、の 1 行がそれだ。

**新機能が平常時のコストをゼロにできるかどうか**は、大規模なシステムに機能を足すときの分かれ目になる。「常に少しずつ重くなる」機能は、既存ユーザーにとって純粋な損失になる。

### なぜ「最後のリーダー」だけは unclean 扱いなのか

`lastKnownElr` からの選出は `unclean = true` としてマークされる。ELR からの選出は `unclean = false` だ。

違いは **保証の有無**にある。

- **ELR のメンバ**: ISR から外れて以降 unclean shutdown していない。**HW までのデータを持っている。**
- **`lastKnownElr` のメンバ**: ELR からも外れた。**unclean shutdown している可能性がある。**

後者を選ぶのは「待ち続けるよりマシ」という判断で、データ損失を受け入れている。だから `unclean` とマークし、ログに INFO で残す。

**「安全な回復」と「損失を伴う回復」を、同じコードパスの中でフラグ 1 つで区別している。** 呼び出し側はどちらが起きたかを知ることができ、記録もできる。

## どう活かすか

**「今は使えないが、後で使えるかもしれないもの」に名前を付けて記録しておく、という発想は広く使える。** 障害時の選択肢は、**平常時にどれだけ情報を残していたか**で決まる。「使わないから捨てる」を続けると、いざというときに「何も分からないので全部やり直す」しかなくなる。ELR は、記録のコストが平常時ゼロで、障害時のリターンが「データ損失を回避できる」という、割の良い投資になっている。

**「集合を排他的な 3 段に分ける」設計も参考になる。** ISR / ELR / lastKnownElr は、それぞれ保証の強さが違い、重複しない。**保証の強さで階層を作ると、「どれを使うか」が優先順位としてそのまま書ける。** 入れ子や重複を許すと、判定のたびに集合演算が要る。

**「事実を正確に記録できるようになったので、嘘をつかなくてよくなった」という改善の形は覚えておきたい。** ELR 以前は「ISR を空にできない」という制約があり、最後の 1 人を残していた。それは「まだ同期している」という嘘だった。別の場所に情報を持てるようにしたら、嘘が不要になった。**モデルが表現力不足だと、既存のフィールドに嘘を入れて辻褄を合わせることになる。** その嘘は必ず後で読み手を混乱させる。

**そして「安全な回復と、損失を伴う回復を型やフラグで区別する」は、運用の透明性に直結する。** `unclean = true` が付いているかどうかで、ログレベルも変わり、メトリクスも変わる。**「データが失われたかもしれない瞬間」を、後から必ず特定できるようにしておく**のは、それ自体が機能だと言っていい。

---
title: "Multi-AZ 向け FailoverRestriction"
description: "DatabaseDialect が返す 2 つのフラグ、DISABLE_TASK_A と ENABLE_WRITER_IN_TASK_B。Multi-AZ MySQL の Dialect だけがこれを返し、failover (v1) の writer フェイルオーバーを「Task B 単独」「旧 writer も候補」に変える。フェイルオーバーの手順を Dialect 側から書き換える、この小さな拡張点を読む。"
group: "フェイルオーバー"
sidebar:
  order: 41
---

## 何を学んだか

`FailoverRestriction` は値が 2 つしかない enum で、**Dialect がフェイルオーバーの手順に口を出すための唯一の経路**である。

- `DISABLE_TASK_A`: writer フェイルオーバーで Task A (旧 writer への再接続) を走らせず、Task B だけにする
- `ENABLE_WRITER_IN_TASK_B`: Task B が「旧 writer と同じホスト」を新 writer 候補として受け入れる。reader 接続の候補にも writer を含める

MySQL 系 Dialect でこれを返すのは `RdsMultiAZClusterMySQLDatabaseDialect` だけで、両方を返す。Aurora MySQL では空配列で、Task A/B の競争がそのまま動く。

## ソースコードのどこか

### enum とインタフェース

[`common/lib/plugins/failover/failover_restriction.ts#L17`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/failover/failover_restriction.ts#L17)。

```ts title="common/lib/plugins/failover/failover_restriction.ts"
export enum FailoverRestriction {
  DISABLE_TASK_A,
  ENABLE_WRITER_IN_TASK_B,
}
```

`DatabaseDialect` インタフェースに `getFailoverRestrictions(): FailoverRestriction[]` がある ([`database_dialect.ts#L57`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/database_dialect/database_dialect.ts#L57))。MySQL 系の基底 `MySQLDatabaseDialect` は空を返し ([`mysql_database_dialect.ts#L146`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/dialect/mysql_database_dialect.ts#L146))、Multi-AZ 用だけが上書きする。

```ts title="mysql/lib/dialect/rds_multi_az_mysql_database_dialect.ts"
getFailoverRestrictions(): FailoverRestriction[] {
  return [FailoverRestriction.DISABLE_TASK_A, FailoverRestriction.ENABLE_WRITER_IN_TASK_B];
}
```

[`rds_multi_az_mysql_database_dialect.ts#L178`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/dialect/rds_multi_az_mysql_database_dialect.ts#L178)。`aurora-mysql` も `global-aurora-mysql` も `rds-mysql` も上書きしないので、[Dialect の自動判定](../dialect-resolution/) が Multi-AZ を選んだときだけ効く。

### 参照箇所は 3 つ

`grep` すると、この enum を読んでいるのは `failover/` 配下の 3 箇所だけである。[failover2](../failover2-writer/) は読まない。

#### 1. Task A を走らせない

[`writer_failover_handler.ts#L130`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/failover/writer_failover_handler.ts#L130)。

```ts title="common/lib/plugins/failover/writer_failover_handler.ts"
const singleTask: boolean = this.pluginService.getDialect().getFailoverRestrictions().includes(FailoverRestriction.DISABLE_TASK_A);
const failoverTaskPromise = singleTask ? taskB : Promise.any([taskA, taskB]);

const failoverTask = failoverTaskPromise
  .then((result) => {
    selectedTask = result.taskName;
    // If the first resolved promise is connected or has an error, return it.
    if (result.isConnected || result.error || singleTask) {
      return result;
    }
```

`taskA` の `call()` 自体は `singleTask` に関係なく呼ばれている点に注意 ([L125](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/failover/writer_failover_handler.ts#L125))。`Promise.any` に入れないだけで、Task A のループは裏で回り続け、`finally` の `cancel()` で止まる。Task A が旧 writer に張った接続は `cancel(failed, selectedTask)` の中で Task B が選ばれたときに閉じられる ([L297-306](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/failover/writer_failover_handler.ts#L297))。

`|| singleTask` は「Task B が繋がらずに終わっても、Task A の結果を待たずにそのまま返す」ための条件である。

#### 2. Task B が旧 writer を候補にする

[`writer_failover_handler.ts#L401`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/failover/writer_failover_handler.ts#L401)。

```ts title="common/lib/plugins/failover/writer_failover_handler.ts"
const allowOldWriter: boolean = this.pluginService.getDialect().getFailoverRestrictions().includes(FailoverRestriction.ENABLE_WRITER_IN_TASK_B);

while (Date.now() < this.endTime && !this.failoverCompleted) {
  // ...
      this.currentTopology = topology;
      const writerCandidate = getWriter(this.currentTopology);
      if (writerCandidate && (allowOldWriter || !this.isSame(writerCandidate, this.originalWriterHost))) {
        // new writer is available, and it's different from the previous writer
        logger.debug(logTopology(this.currentTopology, "[Task B] "));
        if (await this.connectToWriter(writerCandidate)) {
          return true;
        }
      }
```

Aurora では「トポロジの writer が旧 writer と同じ = まだ古いトポロジ」として読み飛ばす。Multi-AZ ではその判定を外し、トポロジが指す writer をそのまま信じる。

#### 3. reader 接続の候補に writer を入れる

[`reader_failover_handler.ts#L258`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/failover/reader_failover_handler.ts#L258)。Task B が最初に reader を確保するときに使う `getReaderHostsByPriority` である。

```ts title="common/lib/plugins/failover/reader_failover_handler.ts"
const numOfReaders = downHostList.length + activeReaders.length;
const hostsByPriority: HostInfo[] = [...activeReaders];
hostsByPriority.push(...downHostList);
if (
  writerHost !== null &&
  (numOfReaders === 0 ||
    this.pluginService
      .getDialect()
      .getFailoverRestrictions()
      .includes(FailoverRestriction.ENABLE_WRITER_IN_TASK_B))
) {
  hostsByPriority.push(writerHost);
}
```

Aurora では reader が 1 台もないときだけ writer を候補に入れる。Multi-AZ では常に最後尾に入れる。`failover()` 側の `getHostsByPriority` ([L268](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/failover/reader_failover_handler.ts#L268)) は Dialect を見ず、常に writer を候補に含める。

### 3 つの効果をまとめると

|                       | Aurora MySQL (制限なし)              | Multi-AZ MySQL (両方あり)        |
| --------------------- | ------------------------------------ | -------------------------------- |
| Task A                | 旧 writer に張り直して確認           | 走るが結果は使わない             |
| Task B の writer 判定 | 旧 writer と違うときだけ採用         | トポロジの writer をそのまま採用 |
| Task B の reader 候補 | reader のみ (reader ゼロなら writer) | reader → writer の順で全部       |

## なぜそうなっているか

### Multi-AZ の切り替えは「同じ 3 台の役割交換」

Aurora のフェイルオーバーは「新しい writer が選ばれ、旧 writer は落ちたまま、あるいは reader として戻ってくる」もので、Task A の「旧 writer がそのまま writer に戻る」ケースは一時的なネットワーク断のときにだけ起きる。

RDS Multi-AZ DB Cluster は常に 3 台で、マイナーバージョンアップグレードや OS メンテナンスのたびに約 1 秒で writer が切り替わる ([RDS Multi-AZ DB Cluster](../rds-multi-az-cluster/))。`SupportForRDSMultiAzDBCluster.md` は "the `failover` plugin switches the connection from the current writer to a newly upgraded reader" と書いている。切り替えは計画されたもので、旧 writer はすぐに reader として復帰する。Task A が旧 writer に繋ぎ直せてしまう可能性が高く、その時点でトポロジを読むと「自分は writer ではない」と分かるので Task A は必ず負ける。走らせる意味がない。

### トポロジの writer は Multi-AZ では別の経路で決まる

Aurora MySQL のトポロジは `replica_host_status` の `SESSION_ID = 'MASTER_SESSION_ID'` で writer が分かる ([トポロジクエリ (Aurora MySQL)](../topology-query-aurora/))。Multi-AZ の `rds_topology` には writer 情報がなく、`SHOW REPLICA STATUS` の `Source_Server_Id` から「自分の複製元 = writer」を割り出す ([トポロジクエリ (Multi-AZ MySQL)](../topology-query-multi-az/))。

この方式では、**繋いでいるホストが reader であれば writer の id は確実に取れる**。Aurora の「reader の自己申告は古いことがある」という問題とは性質が違うので、「旧 writer と同じなら古い」というガードは不要になり、むしろ邪魔になる。旧 writer が 1 秒後に再び writer に戻る運用操作 (切り替えの切り戻し) では、そのガードがあると永久に候補が見つからない。`ENABLE_WRITER_IN_TASK_B` はこれを外すフラグである。

### reader 候補に writer を入れるのは台数が少ないから

Task B の最初の一手は「reader に繋いでトポロジを読む」だが、Multi-AZ は reader が 2 台しかなく、アップグレード中はその 2 台が順に再起動する。reader が両方応答しない瞬間があり得るので、writer を候補の最後に置いて、少なくとも 1 台には繋げるようにしてある。Aurora なら reader が複数いる前提で、writer を候補に含めるのは reader ゼロのときだけでよい。

### なぜ Dialect にぶら下げたのか

フェイルオーバーの手順は `failover/` 配下にあり、DB の種類は `dialect/` 配下にある。Multi-AZ 固有の分岐を `writer_failover_handler.ts` に `if (isMultiAz)` として書くこともできたが、それだと handler が Dialect の種類を知ることになる。enum を 1 つ挟むことで、handler は「Task A を止めるべきか」だけを聞き、なぜ止めるのかは Dialect が知っている、という分担になる。

PG 側の Multi-AZ Dialect も同じ enum を返せるので、DB 種別が増えても handler は変わらない。

### failover2 が読まない理由

failover2 の writer フェイルオーバーは `forceMonitoringRefresh(true, timeout)` でモニタに「writer を確認して」と頼むだけで、Task A/B に相当する分岐を持たない ([failover2 の writer フェイルオーバー](../failover2-writer/))。モニタは全ホストに「自分は writer か」を直接聞くので、旧 writer と同じかどうかを気にする必要がなくなり、この enum の出番がない。

ただし `SupportForRDSMultiAzDBCluster.md` の動作確認済み一覧に `failover2` はなく、Known Issues には "the failover process may fail to complete due to the stale topology returning the incorrect writer instance" とある。Multi-AZ のトポロジ取得は `SHOW REPLICA STATUS` 依存で、切り替え直後のレプリケーション設定が追いつくまで古い writer を返し得る。v1 では `ENABLE_WRITER_IN_TASK_B` でそれを許容し、役割の確認は `strict-reader` のときだけ行う。failover2 は役割検証で弾いてしまうので、`FailoverFailedError` になる。Multi-AZ で v1 が残っているのはこのためである。

## どう活かすか

- **手順の分岐を「どの環境か」ではなく「何を変えるか」で表す。** `isMultiAz` ではなく `DISABLE_TASK_A` にすると、handler の読み手は環境の知識なしに分岐の意味が分かる。新しい環境が来ても、同じフラグを返すだけで済む
- **フラグは効果 1 つにつき 1 つ。** 2 つの enum 値は独立していて、片方だけ返す Dialect も書ける。「Multi-AZ モード」のような複合フラグにすると、後から片方だけ外したくなったときに困る
- **競争させる価値がない環境では競争しない。** Task A は Aurora では一時断への最短経路だが、Multi-AZ では必ず負ける。走らせるコスト (接続 + トポロジクエリ) を環境ごとに判断する場所を用意しておく
- **取り込むべきでない条件。** フラグの値が 2 つで、読む場所が 3 つ、返す Dialect が 1 つという規模だから enum で足りている。分岐が増えて「この組み合わせは何を意味するのか」が読めなくなったら、戦略オブジェクトに切り出したほうがよい

### つまずきどころ

- **Task A は「無効」でも走っている。** `DISABLE_TASK_A` は `Promise.any` から外すだけで、`call()` は呼ばれている。旧 writer への `forceConnect` がログに出ても、それは使われない接続である
- **Multi-AZ で `failover2` を使うと Known Issues の `FailoverFailedError` を踏む。** 既定プラグインは `failover2` なので、Multi-AZ では `plugins: "auroraConnectionTracker,failover,efm"` のように明示する必要がある
- **`getFailoverRestrictions` は毎回 Dialect から読む。** 接続後に Dialect が `rds-mysql` から `rds-multi-az-mysql` に昇格した場合 ([Dialect の自動判定](../dialect-resolution/))、フェイルオーバー開始時点の Dialect が使われる。判定前に切り替えが起きると Aurora 用の手順で動く

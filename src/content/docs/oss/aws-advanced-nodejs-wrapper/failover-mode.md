---
title: "failoverMode と URL からの既定値"
description: "failoverMode は strict-writer / reader-or-writer / strict-reader の 3 値で、省略時は接続先 URL の種類から決まる。cluster-ro- エンドポイントなら reader-or-writer、それ以外は全部 strict-writer。インスタンスエンドポイントで reader に繋いでいても既定は strict-writer になる、という落とし穴を initFailoverMode の 15 行から読む。"
group: "フェイルオーバー"
sidebar:
  order: 35
---

## 何を学んだか

`failoverMode` は「フェイルオーバー後にどの役割のホストへ繋ぎ直すか」を決める。値は 3 つで、`failover()` の分岐と reader 候補の受け入れ条件に直接効く。

| 値                 | 意味                                                     | `failover()` の経路 |
| ------------------ | -------------------------------------------------------- | ------------------- |
| `strict-writer`    | 新しい writer にだけ繋ぐ                                 | `failoverWriter`    |
| `reader-or-writer` | reader を探し、なければ writer でもよい                  | `failoverReader`    |
| `strict-reader`    | reader にだけ繋ぐ。writer しか残っていなければ失敗させる | `failoverReader`    |

省略したときの既定値は **接続先 URL の種類だけ**で決まる。`cluster-ro-` (読み取り専用クラスタエンドポイント) なら `reader-or-writer`、それ以外は `strict-writer`。**インスタンスエンドポイントで reader に繋いでいても、既定は `strict-writer`** である。

## ソースコードのどこか

### 3 値と正規化

[`common/lib/plugins/failover/failover_mode.ts#L17`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/failover/failover_mode.ts#L17)。v1 と v2 で共有している。

```ts title="common/lib/plugins/failover/failover_mode.ts"
export enum FailoverMode {
  STRICT_WRITER = "strict-writer",
  STRICT_READER = "strict-reader",
  READER_OR_WRITER = "reader-or-writer",
  UNKNOWN = "unknown",
}

export function failoverModeFromValue(value: string | null | undefined): FailoverMode {
  if (!value) {
    return FailoverMode.UNKNOWN;
  }
  const normalized = value.toLowerCase();
  return Object.values(FailoverMode).find((v) => v === normalized) ?? FailoverMode.UNKNOWN;
}
```

`"Strict-Writer"` は通るが、`"strictwriter"` や `"writer"` は `UNKNOWN` になる。`UNKNOWN` は「未指定」と同じ扱いで、例外にはならない。誤字は黙って既定値に落ちる。

`WrapperProperties.FAILOVER_MODE` の既定値は空文字列である ([`wrapper_property.ts#L427`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/wrapper_property.ts#L427))。

### initFailoverMode — 最初の connect で 1 回だけ

[`failover2_plugin.ts#L464`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/failover2/failover2_plugin.ts#L464)。

```ts title="common/lib/plugins/failover2/failover2_plugin.ts"
protected initFailoverMode(): void {
  if (this.rdsUrlType) {
    return;
  }

  this.failoverMode = failoverModeFromValue(WrapperProperties.FAILOVER_MODE.get(this.properties));
  const initialHostInfo: HostInfo | undefined | null = this.hostListProviderService?.getInitialConnectionHostInfo();
  this.rdsUrlType = this.rdsHelper.identifyRdsType(initialHostInfo?.host);

  if (this.failoverMode === FailoverMode.UNKNOWN) {
    this.failoverMode = this.rdsUrlType === RdsUrlType.RDS_READER_CLUSTER ? FailoverMode.READER_OR_WRITER : FailoverMode.STRICT_WRITER;
  }

  logger.debug(Messages.get("Failover.parameterValue", "failoverMode", String(this.failoverMode)));
}
```

`connect` の先頭で毎回呼ばれるが、`rdsUrlType` が決まった後は即 return する。つまり **最初の接続先 URL で確定し、以後変わらない**。フェイルオーバーで別のインスタンスに繋ぎ直しても、`rdsUrlType` は初回のまま、`failoverMode` も初回のままである。

`identifyRdsType` は [RdsUtils](../rds-utils/) の正規表現で URL を分類する ([`rds_utils.ts#L427`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/utils/rds_utils.ts#L427))。`RDS_READER_CLUSTER` になるのは `cluster-ro-` を含むホスト名だけで、`RDS_WRITER_CLUSTER` / `RDS_INSTANCE` / `RDS_CUSTOM_CLUSTER` / `IP_ADDRESS` / `OTHER` は全部 `strict-writer` 側に落ちる。

### failoverMode が効く 3 箇所

1. **`failover()` の分岐** ([`#L222`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/plugins/failover2/failover2_plugin.ts#L222))。`STRICT_WRITER` なら [`failoverWriter`](../failover2-writer/)、それ以外は [`failoverReader`](../failover2-reader/)
2. **reader 候補の受け入れ** (`getReaderFailoverConnection`)。`role === READER || failoverMode !== STRICT_READER` なので、`reader-or-writer` は writer に繋がってしまっても受け入れ、`strict-reader` は reader であることを `SELECT @@innodb_read_only` で確認してから受け入れる
3. **read-only エラーのトリガ** ([`shouldErrorTriggerClientSwitch`](../failover-triggers/))。`STRICT_WRITER` のときだけ errno 1290 / 1836 を切り替えの合図にする

### v1 との違い

v1 の `FailoverPlugin` も同じ `failover_mode.ts` を使い、既定値の決め方も同じである。v1 では `strict-reader` のとき `ClusterAwareReaderFailoverHandler.setEnableFailoverStrictReader(true)` を呼んで handler 側に伝える形だが、v2 では `failoverMode` をフィールドとして直接読む。詳細は [failover (v1)](../failover-v1/) に譲る。

## なぜそうなっているか

### なぜ URL から推測するのか

Aurora のエンドポイント自体が「役割の契約」だからである。`cluster-` は常に writer を指し、`cluster-ro-` は reader 群にラウンドロビンで振る。アプリがどちらのエンドポイントを選んだかは、そのままアプリの意図 (書きたいのか、読むだけでいいのか) を表している。docs の表にある "This logic mimics the logic of the Aurora read-only cluster endpoint" は、`reader-or-writer` が `cluster-ro-` の挙動 (reader がいなければ writer に振る) をラッパの中で再現している、という意味である。

### なぜ instance endpoint は strict-writer なのか

インスタンスエンドポイントは役割を約束しない。今 reader でも、フェイルオーバーで writer に昇格するかもしれない。URL からは意図が読めないので、「書き込みが必要なアプリだろう」という**安全側**に倒している。reader-only のアプリが instance endpoint を使う場合は `failoverMode: "strict-reader"` を明示する必要がある。docs の Warning 2 が「instance endpoint は使わないでほしい」と言っているのは、この曖昧さが理由である。

### なぜ 1 回で確定させるのか

`rdsUrlType` は [StaleDns](../stale-dns/) の判定や `isFailoverEnabled` の RDS Proxy 除外にも使われる。これが接続のたびに変わると、同じ client なのに「今回は Proxy 扱い」「次は instance 扱い」と挙動が揺れる。アプリが最初に指定した URL を「この client の意図」として固定するほうが、挙動を説明しやすい。

## どう活かすか

- **既定値を「入力の形」から導くなら、その形が意図を表していることを確認する。** エンドポイント名は役割を表すので推測できるが、instance endpoint のように意図を表さない入力には安全側の既定値を置く
- **列挙型の解析は、不正値を例外にするか黙って既定値にするかを決めて書く。** `failoverModeFromValue` は後者で、誤字が既定値に化ける。運用設定なら前者のほうが事故が少ない。少なくとも `UNKNOWN` に落ちたときにログを出す
- **一度決めたら固定する値は、なぜ固定なのかを書く。** `if (this.rdsUrlType) return;` の 1 行が「初回で確定」を担っているが、コメントはない。読み手は `connect` のたびに再評価されると誤読しやすい

### 実務で踏む失敗パターン

- **reader インスタンスのエンドポイントに `failoverMode` なしで繋ぐ。** 既定が `strict-writer` なので、そのインスタンスが落ちると新 writer に繋ぎ直す。読み取り専用のはずのアプリが writer に負荷をかけ始める
- **`"STRICT_WRITER"` と書く。** `toLowerCase()` しても `strict_writer` にしかならず、`UNKNOWN` → URL 既定値に落ちる。値はハイフン区切りの小文字である
- **カスタムエンドポイントに繋いで `reader-or-writer` を期待する。** `RDS_CUSTOM_CLUSTER` は `strict-writer` 側である。reader だけを集めたカスタムエンドポイントなら、`failoverMode` を明示する
- **`failoverMode` を変えたいのに client を作り直さない。** `rdsUrlType` と一緒に初回で確定するので、プロパティを書き換えても効かない。新しい `AwsMySQLClient` を作る

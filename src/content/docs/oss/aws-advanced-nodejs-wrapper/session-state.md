---
title: "SessionState — 5 つの設定と pristine 値"
description: "接続を差し替えるとき、autoCommit や USE で選んだ DB は新しい接続に引き継がれない。ラッパは 5 つのセッション設定を「現在値」と「触る前の値 (pristine)」のペアで持ち、setter が呼ばれた瞬間に pristine を確保する。サーバには一切聞かない、という設計の代償と割り切りを読む。"
group: "接続を差し替えても壊れないようにする"
sidebar:
  order: 51
---

## 何を学んだか

MySQL のセッション設定 (`autocommit`、`READ ONLY`、`USE db`、分離レベル) は**接続に紐づく**。フェイルオーバーや readWriteSplitting で物理接続を差し替えると、アプリが `SET autocommit=0` していた事実は新しい接続に残らない。ラッパはこれを `SessionState` という小さなクラスで追跡している。

- 追跡するのは **5 つ**: `autoCommit` / `readOnly` / `catalog` / `schema` / `transactionIsolation`。MySQL では `schema` が非対応で、`catalog` が `USE db` に対応する
- 各項目は **`value` と `pristineValue` のペア**。pristine は「アプリが触る前の値」で、`setReadOnly()` のような setter が**初めて呼ばれた瞬間**に確保される
- **サーバには聞かない。** pristine は `SELECT @@autocommit` で取るのではなく、ラッパ自身がその時点で覚えている値を写す。覚えていなければ `undefined` のままで、それは「触っていない = サーバ既定のまま」を意味する
- 判定は「分からないときは安全側」。`isPristine()` と `canRestorePristine()` は `undefined` の扱いをそれぞれ逆向きに倒している

## ソースコードのどこか

### `SessionStateField` — value と pristineValue のペア

[`common/lib/session_state.ts#L21`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/session_state.ts#L21)。

```ts title="common/lib/session_state.ts"
export abstract class SessionStateField<Type> {
  value?: Type;
  pristineValue?: Type;

  abstract setValue(state: SessionState): void;
  abstract setPristineValue(state: SessionState): void;
  abstract getQuery(dialect: DatabaseDialect, isPristine: boolean): string;
  abstract getClientValue(client: AwsClient): Type;

  isPristine(): boolean {
    // The value has never been set up so the session state has the pristine value.
    if (this.value === undefined) {
      return true;
    }
    // The pristine value isn't setup, so it's inconclusive.
    // Take the safest path.
    if (this.pristineValue === undefined) {
      return false;
    }
    return this.value === this.pristineValue;
  }

  canRestorePristine(): boolean {
    if (this.pristineValue === undefined) {
      return false;
    }
    if (this.value !== undefined) {
      // It's necessary to restore the pristine value only if the current session value is not the same as the pristine value.
      return this.value !== this.pristineValue;
    }
    // It's inconclusive if the current value is the same as pristine value, so we need to take the safest path.
    return true;
  }
}
```

`getQuery` と `getClientValue` を抽象にして、SQL の生成は `DatabaseDialect` に、値の読み出しは `AwsClient` に委ねる。この型自体は DB を知らない。

5 つの具象クラスは 15 行ずつで、たとえば `autoCommit` はこうなる ([L87](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/session_state.ts#L87))。

```ts title="common/lib/session_state.ts"
class AutoCommitState extends SessionStateField<boolean> {
  setValue(state: SessionState) {
    this.value = state.autoCommit.value;
  }
  setPristineValue(state: SessionState) {
    this.value = state.autoCommit.pristineValue;
  }
  getQuery(dialect: DatabaseDialect, isPristine: boolean = false) {
    return dialect.getSetAutoCommitQuery(isPristine ? this.pristineValue : this.value);
  }
  getClientValue(client: AwsClient): boolean {
    return client.getAutoCommit();
  }
}
```

MySQL 側の SQL は `MySQLDatabaseDialect` にある ([`mysql/lib/dialect/mysql_database_dialect.ts#L64`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/dialect/mysql_database_dialect.ts#L64))。

| 項目                   | SQL                                                | 備考                                                                                   |
| ---------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `readOnly`             | `SET SESSION TRANSACTION READ ONLY` / `READ WRITE` |                                                                                        |
| `autoCommit`           | `SET AUTOCOMMIT=${autoCommit}`                     | `true` / `false` がそのまま文字列化される。MySQL は `SET autocommit=true` を受け付ける |
| `transactionIsolation` | `SET SESSION TRANSACTION ISOLATION LEVEL ...`      | 4 段階を `switch` で変換                                                               |
| `catalog`              | `USE ${catalog}`                                   |                                                                                        |
| `schema`               | `UnsupportedMethodError` を投げる                  | MySQL にスキーマの概念がない                                                           |

### `SessionStateServiceImpl` — pristine を確保するタイミング

[`common/lib/session_state_service_impl.ts#L236`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/session_state_service_impl.ts#L236)。

```ts title="common/lib/session_state_service_impl.ts"
private setupPristineState<Type>(state: SessionStateField<Type>, val?: Type): void {
  if (!this.resetStateEnabledSetting()) {
    return;
  }
  if (state.pristineValue !== undefined) {
    return;
  }
  state.pristineValue = val ?? state.getClientValue(this.pluginService.getCurrentClient());
}

private setState<Type>(state: any, val: Type): void {
  if (!this.transferStateEnabledSetting()) {
    return;
  }
  this.sessionState[state].value = val;
  this.logCurrentState();
}
```

2 つの設定フラグがそれぞれ別の関数を止めている ([`wrapper_property.ts#L318`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/wrapper_property.ts#L318))。

| プロパティ                     | 既定   | 止める対象                                                    |
| ------------------------------ | ------ | ------------------------------------------------------------- |
| `transferSessionStateOnSwitch` | `true` | `setState` (現在値の記録) と、差し替え時の転送                |
| `resetSessionStateOnClose`     | `true` | `setupPristineState` (pristine の確保) と、close 時のリセット |

`transferSessionStateOnSwitch=false` にすると現在値の記録自体が止まるので、`client.getAutoCommit()` は常に `undefined` を返すようになる。getter が「サーバの値」ではなく「ラッパの記憶」を返していることが、ここから分かる。

### 呼び出し順 — setter の中で 3 段階

[`mysql/lib/client.ts#L118`](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/client.ts#L118)。

```ts title="mysql/lib/client.ts"
async setReadOnly(readOnly: boolean): Promise<Query | void> {
  this.pluginService.getSessionStateService().setupPristineReadOnly();
  const result = await this.queryWithoutUpdate({ sql: `SET SESSION TRANSACTION READ ${readOnly ? "ONLY" : "WRITE"}` });
  this.pluginService.getSessionStateService().updateReadOnly(readOnly);
  return result;
}

async setAutoCommit(autoCommit: boolean): Promise<Query | void> {
  this.pluginService.getSessionStateService().setupPristineAutoCommit();
  let setting = "1";
  if (!autoCommit) {
    setting = "0";
  }
  const result = await this.queryWithoutUpdate({ sql: `SET AUTOCOMMIT=${setting}` });
  this.pluginService.getSessionStateService().setAutoCommit(autoCommit);
  return result;
}
```

1. **pristine を確保する** (まだなければ)
2. **SQL を投げる** (`queryWithoutUpdate` は plugin chain を通るが、後述の SQL 解析はしない)
3. **現在値を記録する**

順序が重要で、pristine の確保は値を書き換える前に済ませる。`setupPristineState` の `getClientValue` は `client.getAutoCommit()` を呼び、それは `sessionStateService.getAutoCommit()` に戻ってきて `sessionState.autoCommit.value` を返す。つまり **pristine := その瞬間の value** であり、初回なら `undefined` のままになる。

`setTransactionIsolation` は現在値と同じなら SQL を投げない ([L162](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/client.ts#L162))。`setSchema` / `getSchema` は `UnsupportedMethodError` を投げる ([L155](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/mysql/lib/client.ts#L155))。

### `readOnly` だけ pristine の取り方が違う

`updateReadOnly` は他の 4 つと違って、**新しい値を pristine として渡す** ([L149](https://github.com/aws/aws-advanced-nodejs-wrapper/blob/6d0ba1bdae81a4e1fd274b3569c5dc50cf0a7095/common/lib/session_state_service_impl.ts#L149))。

```ts title="common/lib/session_state_service_impl.ts"
updateReadOnly(readOnly: boolean): void {
  this.pluginService.getSessionStateService().setupPristineReadOnly(readOnly);
  this.pluginService.getSessionStateService().setReadOnly(readOnly);
}
```

`setReadOnly()` の冒頭で呼ばれる `setupPristineReadOnly()` (引数なし) は初回なら `undefined` を確保しようとして何もしない。そのあと `updateReadOnly(true)` が `setupPristineReadOnly(true)` を呼ぶので、**readOnly の pristine は「アプリが最初に設定した値」になる**。他の 4 項目では pristine は「設定前の値」(初回は `undefined`) なので、readOnly だけ意味がずれている。

## なぜそうなっているか

### なぜサーバに聞かないのか

docs の `SessionState.md` には「original setting が不明なら追加で `getReadOnly` を呼んで pristine として保存する」と書かれているが、実装の `getClientValue` はラッパ内部の記憶を読むだけで、`SELECT @@autocommit` は発行されない。

理由は 2 つ考えられる。1 つは**コスト**で、setter のたびに往復が 1 回増える。もう 1 つは**「触っていない」という状態の表現**で、`undefined` を「サーバ既定のまま」と読めば、差し替え時にその項目は送らなくてよい (`applyCurrentState` は `value !== undefined` の項目だけ送る)。サーバに聞いて具体値を持ってしまうと、既定値と区別がつかず、毎回 5 つとも送ることになる。

代償は、**アプリが `query()` で直接 `SET autocommit=0` を投げたケース**を setter 経由と同じには扱えないことで、それを埋めるのが次のページの SQL 解析である ([SQL を読んで状態を追う](../tracking-state-from-sql/))。

### なぜ `undefined` の扱いが関数ごとに逆なのか

`isPristine()` は `pristineValue === undefined` を **false** (pristine ではない) に倒し、`canRestorePristine()` は `value === undefined` を **true** (戻す必要あり) に倒す。どちらも「不明なら、余計に戻す方向」に倒している。戻し損ねると次の利用者が汚れたセッションを掴むが、余計に戻しても `SET` が 1 回増えるだけ、という非対称性から来ている。

### なぜ 5 つなのか

この 5 つは JDBC の `Connection` インタフェースの `setAutoCommit` / `setReadOnly` / `setCatalog` / `setSchema` / `setTransactionIsolation` と一対一で対応する。このラッパは aws-advanced-jdbc-wrapper の移植で、`SessionState` の設計もそのまま持ち込まれた。MySQL に `schema` がなく PostgreSQL に `catalog` がない、という非対称は Dialect が `UnsupportedMethodError` を投げることで吸収し、転送側はそのエラーを握りつぶす ([転送とリセット](../transfer-and-reset/))。

タイムゾーン (`SET time_zone`) や `sql_mode`、`character_set_*` は追跡されない。公式サンプルの `setInitialSessionSettings` が `FailoverSuccessError` のたびに `SET time_zone = 'UTC'` を打ち直しているのは、そのためである ([FailoverSuccessError](../failover-success-error/))。

### `setPristineValue` が `value` に書いている

各具象クラスの `setPristineValue` は `this.value = state.X.pristineValue` と書いていて、`this.pristineValue` には書かない。呼び出し元は `SessionState.setPristineState(target, source)` の 1 箇所だけで、差し替え時のコピー (`copySessionState`) に対して使われる。コピー側の `value` を pristine に揃える用途なので実害は薄いが、名前から期待する動きではない。

## どう活かすか

- **「触っていない」を `undefined` で表す。** 具体値で埋めると既定値と区別できなくなる。転送すべき項目を最小にしたいなら、未設定を明示的に持つ
- **pristine は最初の変更の直前に確保する。** 変更のたびに上書きすると「戻すべき値」を失う。`if (pristine !== undefined) return` の 1 行がそれを守っている
- **不明時の倒し方を関数ごとに決め、コメントに書く。** `isPristine` と `canRestorePristine` は逆方向に倒しているが、どちらも「余計に戻す」で一貫している。読み手が混乱しないよう、"Take the safest path" が両方に書かれている
- **getter が記憶を返すなら、それを API 名で匂わせる。** `getAutoCommit()` は実際には「ラッパが最後に記録した値」で、`transferSessionStateOnSwitch=false` だと常に `undefined` になる。サーバの真の値が要るなら `SELECT @@autocommit` を自分で打つ

### 実務で踏む失敗パターン

- **`query()` で `SET SESSION time_zone` を打ったのに、フェイルオーバー後に消える。** 5 項目以外は追跡されない。`FailoverSuccessError` を捕まえて打ち直す
- **`getAutoCommit()` が `undefined` を返す。** 一度も `setAutoCommit()` を呼んでいないか、`transferSessionStateOnSwitch=false` にしている。サーバ既定 (`autocommit=1`) が返ってくるわけではない
- **`setSchema()` が例外を投げる。** MySQL では `setCatalog()` を使う
- **readOnly の「戻す先」が想定と違う。** pristine が「最初に設定した値」になるので、`setReadOnly(true)` → `setReadOnly(false)` と呼んだ接続を close 時にリセットすると `true` 側に戻る計算になる。ただし close 時のリセットが実際に走る条件はかなり狭い ([転送とリセット](../transfer-and-reset/))

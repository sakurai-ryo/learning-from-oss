---
title: "スキーマ移行を「可逆なアクションの並び」で書き、ダウングレード可否は WAL の中身から判定する"
description: "etcd はバージョンをまたぐダウングレードを正式にサポートしている。db 上のスキーマ移行は「上りと下りの 1 対」を持つアクションの列として書かれ、途中で失敗したら逆順に巻き戻る。そして「本当に下げてよいか」は、proto の各フィールドに書かれたバージョン注釈を使って、WAL の中身から機械的に判定される。"
sidebar:
  order: 10
---

## 何を学んだか

### どんな状況の話か

分散システムのバージョンアップは、全ノードを同時に入れ替えられない。**必ず、新旧のバージョンが混在する期間がある。**

etcd はこれを正面から扱っていて、

- **アップグレード**: 1 台ずつ新しいバイナリに入れ替える。混在中も動く。
- **ダウングレード**: 新しいバージョンから古いバージョンへ戻す。**これも正式にサポートされている。**

ダウングレードのほうが圧倒的に難しい。

- **db (bbolt) のスキーマが変わっていると、古いバイナリが読めない。** 新しいバージョンで追加されたキーが残っていると、古いバイナリの検証で弾かれる。
- **WAL の中に、古いバイナリが解釈できないエントリが入っているかもしれない。** 新機能のリクエストが 1 個でもログに残っていると、再生した瞬間に古いバイナリが死ぬ。

後者が厄介だ。**「新機能を使ったかどうか」を、運用者は覚えていない。**

### etcd の答え

**db のスキーマについて:**

1. **バージョンごとの「スキーマ変更」を、`upgradeAction()` と `downgradeAction()` の対として定義する。**
2. **移行は「現在のバージョンから目標まで、マイナーバージョンを 1 つずつ進める / 戻る」計画になる。**
3. **各アクションは、実行すると「逆操作のアクション」を返す。** 途中で失敗したら、返ってきた逆操作を逆順に実行して巻き戻す。
4. **ダウングレードのアクションは、順序も逆にする。**
5. **移行全体が 1 つの bbolt トランザクションで走る。**

**WAL について:**

6. **protobuf の各メッセージ・フィールド・enum 値に、「どの etcd バージョンで導入されたか」を注釈として書く。**
7. **ダウングレード前に、WAL のエントリを全部走査して、使われている注釈の最大値を取る。**
8. **それが目標バージョンより新しければ、ダウングレードを拒否する。**

**「このログを解釈できる最小の etcd バージョン」が、proto 定義から機械的に計算できる。**

## ソースコードのどこか

### アクションは「実行すると逆操作を返す」

[`server/storage/schema/actions.go#L19-L23`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/schema/actions.go#L19-L23)。

```go title="server/storage/schema/actions.go"
type action interface {
	// unsafeDo executes the action and returns revert action, when executed
	// should restore the state from before.
	unsafeDo(tx backend.UnsafeReadWriter) (revert action, err error)
}
```

**インターフェースがメソッド 1 個で、戻り値が「元に戻すためのアクション」。**

逆操作を「実行時に生成する」ところが要点だ。静的に「この操作の逆はこれ」と決めることもできるが、それだと **「元の値が何だったか」が表現できない**。

```go title="server/storage/schema/actions.go"
type setKeyAction struct {
	Bucket     backend.Bucket
	FieldName  []byte
	FieldValue []byte
}

func (a setKeyAction) unsafeDo(tx backend.UnsafeReadWriter) (action, error) {
	revert := restoreFieldValueAction(tx, a.Bucket, a.FieldName)
	tx.UnsafePut(a.Bucket, a.FieldName, a.FieldValue)
	return revert, nil
}

func restoreFieldValueAction(tx backend.UnsafeReader, bucket backend.Bucket, fieldName []byte) action {
	_, vs := tx.UnsafeRange(bucket, fieldName, nil, 1)
	if len(vs) == 1 {
		return &setKeyAction{
			Bucket:     bucket,
			FieldName:  fieldName,
			FieldValue: vs[0],
		}
	}
	return &deleteKeyAction{
		Bucket:    bucket,
		FieldName: fieldName,
	}
}
```

**書き込む前に、今の値を読んで逆操作を作る。**

- 値があったなら、逆操作は「その値に戻す `setKeyAction`」。
- 無かったなら、逆操作は「消す `deleteKeyAction`」。

**「無かった」と「あった」で逆操作の種類そのものが変わる** ので、実行時に決めるしかない。そして、逆操作もまた同じ `action` インターフェースなので、それを実行すればさらに逆操作が返る。

### 失敗したら逆順に巻き戻す

[`#L67-L93`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/schema/actions.go#L67-L93)。

```go title="server/storage/schema/actions.go"
type ActionList []action

// unsafeExecute executes actions one by one. If one of actions returns error,
// it will revert them.
func (as ActionList) unsafeExecute(lg *zap.Logger, tx backend.UnsafeReadWriter) error {
	revertActions := make(ActionList, 0, len(as))
	for _, a := range as {
		revert, err := a.unsafeDo(tx)
		if err != nil {
			revertActions.unsafeExecuteInReversedOrder(lg, tx)
			return err
		}
		revertActions = append(revertActions, revert)
	}
	return nil
}

// unsafeExecuteInReversedOrder executes actions in revered order. Will panic on
// action error. Should be used when reverting.
func (as ActionList) unsafeExecuteInReversedOrder(lg *zap.Logger, tx backend.UnsafeReadWriter) {
	for j := len(as) - 1; j >= 0; j-- {
		_, err := as[j].unsafeDo(tx)
		if err != nil {
			lg.Panic("Cannot recover from revert error", zap.Error(err))
```

**巻き戻し中のエラーは `Panic`。** 「元に戻すことすらできない」状態で続行する道は無い、という判断だ。

トランザクションで囲まれているので、実は panic しなくても bbolt のトランザクションを中断すれば元に戻る。それでも明示的に巻き戻しを実装しているのは、**アクション列が「トランザクションの内側」以外でも使えるようにするため** と、**メモリ上のキャッシュのような、トランザクションが戻してくれないものがありうるため** だろう。

### スキーマ変更の定義は 1 行

[`server/storage/schema/changes.go#L19-L37`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/schema/changes.go#L19-L37)。

```go title="server/storage/schema/changes.go"
type schemaChange interface {
	upgradeAction() action
	downgradeAction() action
}

// addNewField represents adding new field when upgrading. Downgrade will remove the field.
func addNewField(bucket backend.Bucket, fieldName []byte, fieldValue []byte) schemaChange {
	return simpleSchemaChange{
		upgrade: setKeyAction{
			Bucket:     bucket,
			FieldName:  fieldName,
			FieldValue: fieldValue,
		},
		downgrade: deleteKeyAction{
			Bucket:    bucket,
			FieldName: fieldName,
		},
	}
}
```

そして実際の定義がこれだけ ([`server/storage/schema/schema.go#L130-L139`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/schema/schema.go#L130-L139))。

```go title="server/storage/schema/schema.go"
	schemaChanges = map[semver.Version][]schemaChange{
		version.V3_6: {
			addNewField(Meta, MetaStorageVersionName, emptyStorageVersion),
		},
		version.V3_7: {},
		version.V3_8: {},
	}
	// emptyStorageVersion is used for v3.6 Step for the first time, in all other version StoragetVersion should be set by migrator.
	// Adding a addNewField for StorageVersion we can reuse logic to remove it when downgrading to v3.5
	emptyStorageVersion = []byte("")
```

**スキーマ移行の全体が、この 6 行のマップに集約されている。**

v3.7 と v3.8 が空なのも重要だ。**「変更がない」ことが明示的に書かれている。** マップにキーが無いとエラーになる作りなので、新しいバージョンを出すたびに、ここに 1 行足す必要がある。「スキーマ変更があるか」を必ず考えることになる。

`emptyStorageVersion` のコメントも実務的で、**「空文字を入れる `addNewField` にしておけば、v3.5 へ下げるときにフィールドを消すロジックが再利用できる」** と書いてある。値そのものは後で `UnsafeSetStorageVersion` が上書きするので、ここでは「キーの存在」だけを作っている。

### 計画を立ててから実行する

[`server/storage/schema/migration.go#L29-L50`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/schema/migration.go#L29-L50)。

```go title="server/storage/schema/migration.go"
func newPlan(lg *zap.Logger, current semver.Version, target semver.Version) (plan migrationPlan, err error) {
	current = trimToMinor(current)
	target = trimToMinor(target)
	if current.Major() != target.Major() {
		lg.Error("Changing major storage version is not supported", /* ... */)
		return plan, fmt.Errorf("changing major storage version is not supported")
	}
	for !current.Equal(&target) {
		isUpgrade := current.Minor() < target.Minor()

		changes, err := schemaChangesForVersion(current, isUpgrade)
		if err != nil {
			return plan, err
		}
		step := newMigrationStep(current, isUpgrade, changes)
		plan = append(plan, step)
		current = step.target
	}
	return plan, nil
}
```

**マイナーバージョンを 1 つずつ動かす。** 3.5 から 3.8 へなら 3 ステップ。3.8 から 3.5 へも 3 ステップ。

`trimToMinor` でパッチバージョンを落としているのは、**パッチリリースでスキーマを変えないという規律** の表れだ。3.6.1 と 3.6.14 のスキーマは同じ。

「メジャーバージョンの変更はサポートしない」も明示的に弾かれている。

ステップの構築 ([`#L76-L88`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/schema/migration.go#L76-L88))。

```go title="server/storage/schema/migration.go"
func newMigrationStep(v semver.Version, isUpgrade bool, changes []schemaChange) (step migrationStep) {
	step.actions = make(ActionList, len(changes))
	for i, change := range changes {
		if isUpgrade {
			step.actions[i] = change.upgradeAction()
		} else {
			step.actions[len(changes)-1-i] = change.downgradeAction()
		}
	}
```

**ダウングレードでは、アクションの順序も逆にする。** `step.actions[len(changes)-1-i]` の 1 行がそれをやっている。

「A を作ってから B を作る」の逆は「B を消してから A を消す」。**依存関係があるスキーマ変更では、順序の反転が必須になる。** 現状の etcd のスキーマ変更は 1 個しかないので実質的な差はないが、**構造として正しくしてある。**

### 「本当に下げてよいか」は WAL に聞く

[`server/storage/schema/schema.go#L69-L77`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/schema/schema.go#L69-L77)。

```go title="server/storage/schema/schema.go"
	if target.LessThan(&current) {
		minVersion := w.MinimalEtcdVersion()
		if minVersion != nil && target.LessThan(minVersion) {
			// Occasionally we may see this error during downgrade test due to ClusterVersionSet,
			// which is harmless. Please read https://github.com/etcd-io/etcd/pull/13405#discussion_r1890378185.
			return fmt.Errorf("cannot downgrade storage, WAL contains newer entries, as the target version (%s) is lower than the version (%s) detected from WAL logs",
				target.String(), minVersion.String())
		}
	}
```

引数の `w` は `wal.Version` というインターフェースで、メソッドは 1 つだけだ ([`server/storage/wal/version.go#L31-L35`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/wal/version.go#L31-L35))。

```go title="server/storage/wal/version.go"
// Version defines the wal version interface.
type Version interface {
	// MinimalEtcdVersion returns minimal etcd version able to interpret WAL log.
	MinimalEtcdVersion() *semver.Version
}
```

**「この WAL を解釈できる最小の etcd バージョン」** という、驚くほど的確な抽象になっている。

### そのバージョンは proto の注釈から来る

[`api/versionpb/version.proto`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/api/versionpb/version.proto)。

```proto title="api/versionpb/version.proto"
// Indicates etcd version that introduced the message, used to determine minimal etcd version required to interpret wal that includes this message.
extend google.protobuf.MessageOptions {
  optional string etcd_version_msg = 50000;
}

// Indicates etcd version that introduced the field, used to determine minimal etcd version required to interpret wal that sets this field.
extend google.protobuf.FieldOptions {
  optional string etcd_version_field = 50001;
}
```

メッセージ・フィールド・enum・enum 値の 4 段階すべてに注釈が付けられる。実際の使われ方 ([`api/etcdserverpb/rpc.proto`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/api/etcdserverpb/rpc.proto))。

```proto title="api/etcdserverpb/rpc.proto"
  bool prev_kv = 4 [(versionpb.etcd_version_field)="3.1"];
  // ...
  bool ignore_value = 5 [(versionpb.etcd_version_field)="3.2"];
  // ...
  bool ignore_lease = 6 [(versionpb.etcd_version_field)="3.2"];
```

**「このフィールドは 3.2 で入った」が、スキーマ定義そのものに書いてある。**

判定側 ([`server/storage/wal/version.go#L56-L71`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/wal/version.go#L56-L71))。

```go title="server/storage/wal/version.go"
// MinimalEtcdVersion returns minimal etcd able to interpret entries from  WAL log,
// determined by looking at entries since the last snapshot and returning the highest
// etcd version annotation from used messages, fields, enums and their values.
func MinimalEtcdVersion(ents []*raftpb.Entry) *semver.Version {
	var maxVer *semver.Version
	for _, ent := range ents {
		err := visitEntry(ent, func(path protoreflect.FullName, ver *semver.Version) error {
			maxVer = maxVersion(maxVer, ver)
			return nil
		})
		if err != nil {
			panic(err)
		}
	}
	return maxVer
}
```

**WAL のエントリを全部デコードし、リフレクションで「実際に値が設定されているフィールド」を辿り、その注釈の最大値を取る。**

つまり、

- `ignore_lease` を **一度も使っていなければ**、その注釈は数えられない。
- **一度でも使っていれば**、`MinimalEtcdVersion` は 3.2 以上になり、3.1 への降格が拒否される。

**「新機能を使ったかどうか」を、運用者ではなくログが覚えている。**

この仕組みが機能するために、**新しいフィールドを追加した人は注釈を書かなければならない**。書き忘れると、そのフィールドを使ったログが古いバイナリに渡されて壊れる。注釈が proto ファイルの中にあることで、**フィールドを足す作業と、注釈を書く作業が同じ場所になる。**

### 現在のスキーマバージョンをどう知るか

[`server/storage/schema/schema.go#L81-L108`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/schema/schema.go#L81-L108)。

```go title="server/storage/schema/schema.go"
// DetectSchemaVersion returns version of storage schema. Returned value depends on etcd version that created the backend. For
// * v3.6 and newer will return storage version.
// * v3.5 will return it's version if it includes all storage fields added in v3.5 (might require a snapshot).
// * v3.4 and older is not supported and will return error.
func DetectSchemaVersion(lg *zap.Logger, tx backend.ReadTx) (v semver.Version, err error) {
	// ...
}

// UnsafeDetectSchemaVersion non-threadsafe version of DetectSchemaVersion.
func UnsafeDetectSchemaVersion(lg *zap.Logger, tx backend.UnsafeReader) (v semver.Version, err error) {
	vp := UnsafeReadStorageVersion(tx)
	if vp != nil {
		return *vp, nil
	}

	// TODO: remove the operations of reading the field `term`
	// in 3.7. We only need to be back-compatible with 3.6 when
	// we are running 3.7, and the `storageVersion` already exists
	// in all versions >= 3.6, so we don't need to use any other
	// fields to identify the etcd's storage version.
	_, term := UnsafeReadConsistentIndex(tx)
	if term == 0 {
		return v, fmt.Errorf("missing term information")
	}
	return version.V3_5, nil
}
```

**「バージョンを記録するフィールド」自体が v3.6 で追加されたので、v3.5 のスキーマにはバージョン番号が書かれていない。**

そこで、v3.5 で追加された別のフィールド (`term`) の有無で判定している。**「バージョンを記録する仕組み」を導入する前のバージョンを、他の痕跡から推定する** という、後付けの互換維持だ。

`TODO` の内容も具体的で、「3.7 では 3.6 との互換だけあればよく、3.6 以降は `storageVersion` が必ずあるので、この判定は消せる」と書いてある。**互換のためのコードに、いつ消せるかが書いてある。**

`Validate` の側にも、この問題が現れている ([`#L35-L44`](https://github.com/etcd-io/etcd/blob/f5dc18a2989fbc8771dadf888562003d1e9eff95/server/storage/schema/schema.go#L35-L44))。

```go title="server/storage/schema/schema.go"
func unsafeValidate(lg *zap.Logger, tx backend.UnsafeReader) error {
	current, err := UnsafeDetectSchemaVersion(lg, tx)
	if err != nil {
		// v3.5 requires a wal snapshot to persist its fields, so we can assign it a schema version.
		lg.Warn("Failed to detect storage schema version. Please wait till wal snapshot before upgrading cluster.")
		return nil
	}
	_, err = newPlan(lg, current, localBinaryVersion())
	return err
}
```

**判定できなかったら、警告を出して通す。** そして、警告メッセージが **運用者への具体的な指示** になっている。「WAL スナップショットが取られるまで待ってからアップグレードしてください」。

`term` は WAL スナップショットのタイミングで db に書かれるので、**まだ一度もスナップショットが起きていない新しいクラスタでは判定できない**。エラーにして起動を止めるより、警告と手順を示すほうが実用的だ、という判断になっている。

そして、**検証の実体が「移行計画を立ててみる」こと** なのも上手い。実際に計画が立てば移行可能で、立たなければ非対応。検証専用のロジックを別に書いていない。

## なぜそうなっているか

- **アクションが逆操作を返すのは、逆操作が実行時の状態に依存するから。** 「キーを set する」の逆は、元の値があったかどうかで変わる。**静的に定義できるのは「操作の種類」までで、「元に戻す方法」は実行時にしか分からない。**
- **上りと下りを対で定義するのは、片方だけ書くことを許さないため。** `schemaChange` インターフェースが 2 メソッドなので、新しい変更を足すときに両方を書くしかない。**「ダウングレードは後で考える」ができない構造になっている。**
- **ダウングレードでアクションの順序を反転するのは、依存関係があるから。** A に依存する B を作る変更の逆は、B を消してから A を消す。**現状の etcd には依存する変更がないが、構造として正しくしてある。** 後から必要になったときに、そこを直す必要がない。
- **マイナーバージョンを 1 つずつ動かすのは、飛び越しの組み合わせを定義したくないから。** 3.5 → 3.8 の直接の移行を定義すると、バージョンが増えるたびに組み合わせが二乗で増える。**隣り合うバージョン間だけ定義して、合成する。**
- **proto に注釈を書くのは、「新機能を使ったか」を人間が覚えていられないから。** ダウングレード可否は、運用者の記憶や設定ファイルではなく、**実際に流れたデータから判定されるべき** だ。ログには真実が書いてある。
- **注釈を proto ファイルに置いたのは、フィールドを足す作業と同じ場所だから。** 別のファイルにバージョン表を持つと、追加のときに更新を忘れる。**スキーマと、そのメタデータを同じ場所に置く。**
- **`MinimalEtcdVersion` という抽象が的確なのは、問いをそのまま名前にしているから。** 「ダウングレードできるか」ではなく「このログを読める最小バージョンは何か」。**前者は文脈依存だが、後者はログだけで決まる。** 後者を計算して、比較は呼び出し側でやる。
- **判定できないときにエラーではなく警告にするのは、正常な状況でも起きうるから。** 新しいクラスタはまだスナップショットを取っていない。**「異常」ではなく「まだ情報がない」なら、止めるより待ち方を教えるほうがよい。**
- **検証を「計画を立ててみる」で実装したのは、二重管理を避けるため。** 「移行可能なバージョンの組み合わせ」を別に持つと、移行の定義とずれる。**実際の処理を dry-run するのが、最も正確な検証になる。**

## どう活かすか

- **可逆な操作は、「実行すると逆操作を返す」形にする。** Undo スタック、マイグレーション、設定の一時変更、テストのセットアップ。逆操作を実行時に生成すれば、元の状態を捕捉できる。返ってきた逆操作を逆順に実行するだけで巻き戻せる。
- **前進と後退を、インターフェースの 2 メソッドとして対で要求する。** 「戻し方」を型で強制すると、書き忘れがコンパイルエラーになる。ドキュメントやレビューに頼らない。
- **後退では、順序も反転する。** 依存関係のある操作列を巻き戻すときは、順序の反転が必須になる。今は依存がなくても、構造として入れておくと後で困らない。
- **バージョン間の移行は、隣接するペアだけ定義して合成する。** N 個のバージョンに対して N-1 個の定義で済む。飛び越しの移行を個別に定義すると、組み合わせが爆発する。
- **「変更なし」を明示的に書ける形にする。** マップにキーが無ければエラー、という作りにしておくと、新バージョンを切るたびに「スキーマ変更はあるか」を必ず考えることになる。
- **互換性の判定は、人の記憶ではなくデータから行う。** 「この機能を使ったか」は、ログ・スキーマ・実データのどこかに痕跡が残っている。**運用者への質問や設定フラグより、痕跡を読むほうが確実。**
- **スキーマにバージョンのメタデータを埋め込むと、判定が機械化できる。** protobuf のカスタムオプション、SQL のコメント、JSON Schema の拡張。**定義とメタデータを同じ場所に置くと、更新漏れが減る。**
- **問いを名前にした抽象を切る。** 「ダウングレードできるか」は文脈に依存するが、「このログを読める最小バージョンは何か」はログだけで決まる。**文脈から独立した問いに変換できると、実装もテストも単純になる。**
- **互換のためのコードには、いつ消せるかを書く。** 「N+2 リリースで削除可能」と書いてあれば、そのときに消せる。書いていない互換コードは、永久に残る。
- **検証は、実際の処理の dry-run で実装する。** 「できるかどうか」の判定ロジックを別に書くと、本体とずれる。計画を立てるところまでを共通化して、実行するかどうかだけを分ける。

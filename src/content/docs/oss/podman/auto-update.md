---
title: "auto-update — イメージの更新を検知してロールバックまでやる"
description: "podman auto-update は、ラベルの付いたコンテナのイメージがレジストリで更新されていないかを digest 比較で調べ、更新があれば pull して systemd unit を再起動する。再起動に失敗したら古いイメージにタグを付け直して、もう一度再起動する。定期実行は systemd の timer で、ロールバックの実装は「タグを戻すだけ」という 5 行になっている。"
group: "systemd 統合"
sidebar:
  order: 43
---

## 何を学んだか

### コンテナのラベルが更新ポリシーになる

`podman run --label io.containers.autoupdate=registry nginx` のように、**コンテナにラベルを付けることで更新対象を宣言する**。ポリシーは 3 つ。

| ポリシー          | 更新の判定                                                 |
| ----------------- | ---------------------------------------------------------- |
| `disabled` (既定) | 更新しない                                                 |
| `registry`        | レジストリの digest がローカルと違えば更新                 |
| `local`           | ローカルストアのイメージ ID が、コンテナ作成時と違えば更新 |

`local` は、自分でビルドしたイメージを使う場合のためのものだ。`podman build -t myapp` した後に `podman auto-update` を走らせると、新しいイメージで再起動される。

### 更新の単位は systemd unit

重要なのは、**更新の単位がコンテナではなく systemd unit** であることだ。

1. 全コンテナを走査し、`io.containers.autoupdate` ラベルを持つものを集める
2. それぞれがどの systemd unit に属するかを調べる (Quadlet が付けたラベルから分かる)
3. **unit ごとにタスクをまとめる**
4. unit 内のどれか 1 つでも更新があれば、イメージを pull して **unit ごと再起動する**

Pod のように 1 つの unit が複数のコンテナを持つ場合、個別に再起動すると壊れる。unit 単位にすることで、systemd に依存関係の解決を任せられる。

### ロールバックは「タグを戻す」だけ

更新して再起動したが、新しいイメージでアプリが起動しなかった。このとき Podman は、

1. **古いイメージに元のタグを付け直す** (`nginx:latest` を古い image ID に向け直す)
2. もう一度 unit を再起動する

これだけだ。イメージは digest で content-addressable なので、古いイメージは pull しても消えていない。**タグは単なる名前の付け替え** なので、戻すのは一瞬で済む。

### 定期実行は systemd timer

`podman-auto-update.timer` が 1 日 1 回、`podman auto-update` を起動する。

```ini
[Timer]
OnCalendar=daily
RandomizedDelaySec=900
Persistent=true
```

`RandomizedDelaySec=900` で最大 15 分ばらつかせる。**多数のホストが同時にレジストリを叩くのを防ぐ**ためだ。`Persistent=true` は、マシンが停止していて実行を逃した場合、起動後に実行する。

ヘルスチェックと同じく、定期実行の主体を systemd に置く方針が貫かれている ([transient timer](../systemd-healthcheck/))。同梱される unit ファイルの全体像は [Podman が systemd に委ねているものの全体像](../systemd-integration-map/) にある。

## ソースコードのどこか

### 更新の判定は digest の比較

[`pkg/autoupdate/autoupdate.go#L276`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/autoupdate/autoupdate.go#L276)。

```go title="pkg/autoupdate/autoupdate.go"
func (t *task) registryUpdateAvailable(ctx context.Context) (bool, error) {
	// The newer image has already been pulled for another task, so we know
	// there's a newer one available.
	if _, exists := t.auto.updatedRawImages[t.rawImageName]; exists {
		return true, nil
	}

	remoteRef, err := docker.ParseReference("//" + t.rawImageName)
	if err != nil {
		return false, err
	}
	options := &libimage.HasDifferentDigestOptions{
		AuthFilePath:          t.authfile,
		InsecureSkipTLSVerify: t.auto.options.InsecureSkipTLSVerify,
	}
	return t.image.HasDifferentDigest(ctx, remoteRef, options)
}
```

`HasDifferentDigest` は **manifest だけを取得して digest を比べる**。レイヤは落とさないので、更新が無ければネットワークの消費はごくわずかだ。

`updatedRawImages` のキャッシュも効いている。同じイメージを使うコンテナが 10 個あっても、レジストリへの問い合わせは 1 回で済む。`registryUpdate` (実際の pull) 側にも同じチェックがある。

```go title="pkg/autoupdate/autoupdate.go"
// registryUpdate pulls down the image from the registry.
func (t *task) registryUpdate(ctx context.Context) error {
	// The newer image has already been pulled for another task.
	if _, exists := t.auto.updatedRawImages[t.rawImageName]; exists {
		return nil
	}
	...
	t.auto.updatedRawImages[t.rawImageName] = true
	return nil
}
```

`local` ポリシーはもっと単純だ。

```go title="pkg/autoupdate/autoupdate.go"
// localUpdateAvailable returns whether a new image in the local storage is available.
func (t *task) localUpdateAvailable() (bool, error) {
	localImg, _, err := t.auto.runtime.LibimageRuntime().LookupImage(t.rawImageName, nil)
	if err != nil {
		return false, err
	}
	return localImg.ID() != t.image.ID(), nil
}
```

「その名前で今引けるイメージの ID」と「コンテナが使っているイメージの ID」を比べるだけ。ネットワークアクセスすら無い。

### unit 単位の更新とロールバック

[`pkg/autoupdate/autoupdate.go#L157`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/autoupdate/autoupdate.go#L157)。

```go title="pkg/autoupdate/autoupdate.go"
func (u *updater) updateUnit(ctx context.Context, unit string, tasks []*task) []error {
	var errors []error
	tasksUpdated := false

	for _, task := range tasks {
		err := func() error { // Use an anonymous function to avoid spaghetti continue's
			updateAvailable, err := task.updateAvailable(ctx)
			...
		}()
```

無名関数で囲んでいる理由がコメントに書いてある。「**spaghetti continue's を避けるため**」。ループの中で早期 return したいが、`continue` を連発すると読みにくい。無名関数を即時実行して `return` を使えるようにする、という Go でよく使われる形だ。

そして更新後の流れ。

```go title="pkg/autoupdate/autoupdate.go"
	// If no task has been updated, we can jump directly to the next unit.
	if !tasksUpdated {
		return errors
	}

	updateError := u.restartSystemdUnit(ctx, unit)
	for _, task := range tasks {
		if updateError == nil {
			task.status = statusUpdated
		} else {
			task.status = statusFailed
		}
	}

	// Jump to the next unit on successful update or if rollbacks are disabled.
	if updateError == nil || !u.options.Rollback {
		if updateError != nil {
			errors = append(errors, fmt.Errorf("restarting unit %s during update: %w", unit, updateError))
		}
		return errors
	}

	// The update has failed and rollbacks are enabled.
	for _, task := range tasks {
		if err := task.rollbackImage(); err != nil {
			...
		}
	}

	if err := u.restartSystemdUnit(ctx, unit); err != nil {
		...
		task.status = statusFailed
		...
	}

	for _, task := range tasks {
		task.status = statusRolledBack
	}
```

**状態遷移が明示的**だ。`statusUpdated` / `statusFailed` / `statusRolledBack` / `statusNotUpdated` / `statusPending` の 5 つがあり、各分岐で必ずどれかに設定される。`podman auto-update` の出力にそのまま出るので、何が起きたかが分かる。

ロールバックの再起動も失敗した場合は `statusFailed` のまま。**「ロールバックしたが直らなかった」状態も表現できる**。

### ロールバックの実装は 5 行

[`pkg/autoupdate/autoupdate.go#L321`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/autoupdate/autoupdate.go#L321)。

```go title="pkg/autoupdate/autoupdate.go"
// rollbackImage rolls back the task's image to the previous version before the update.
func (t *task) rollbackImage() error {
	// To fallback, simply retag the old image and restart the service.
	if err := t.image.Tag(t.rawImageName); err != nil {
		return err
	}
	t.auto.updatedRawImages[t.rawImageName] = false
	return nil
}
```

「フォールバックするには、単に古いイメージにタグを付け直してサービスを再起動するだけ」。

`t.image` は **更新前に保持しておいたイメージオブジェクト** だ。新しいイメージを pull すると `nginx:latest` というタグは新しい方に移るが、古いイメージは ID で残っている。`Tag()` でタグを戻せば、次の起動時に古い方が使われる。

**content-addressable なストレージだから可能な、極めて安いロールバック**といえる。バージョン管理も、スナップショットも、バックアップも要らない。

### systemd の再起動は結果を確認する

[`pkg/autoupdate/autoupdate.go#L333`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/autoupdate/autoupdate.go#L333)。

```go title="pkg/autoupdate/autoupdate.go"
func (u *updater) restartSystemdUnit(ctx context.Context, unit string) error {
	restartChan := make(chan string)
	if _, err := u.conn.RestartUnitContext(ctx, unit, "replace", restartChan); err != nil {
		return err
	}

	// Wait for the restart to finish and actually check if it was
	// successful or not.
	result := <-restartChan

	switch result {
	case "done":
		logrus.Infof("Successfully restarted systemd unit %q", unit)
		return nil

	default:
		return fmt.Errorf("error restarting systemd unit %q expected %q but received %q", unit, "done", result)
	}
}
```

D-Bus の `RestartUnit` は **非同期** で、呼び出しが成功しても再起動が成功したとは限らない。チャネルで結果を待ち、`"done"` 以外なら失敗とする。

コメントの「**実際に成功したかどうかをちゃんと確認する**」が要点で、ここを省略するとロールバックが機能しない。非同期 API を同期的に使うときの定型といえる。

### service unit が prune まで面倒を見る

```ini title="contrib/systemd/system/podman-auto-update.service.in"
[Service]
Type=oneshot
ExecStart=@@PODMAN@@ auto-update
ExecStartPost=@@PODMAN@@ image prune -f
```

`ExecStartPost` で `image prune -f` を実行する。更新を繰り返すと古いイメージが溜まるので、毎回掃除する。

**掃除を Podman のコードではなく unit ファイルに書いた** のが判断として面白い。`auto-update` の中で prune すると、ロールバックのために残しておきたいイメージまで消しかねない。unit を分けることで、「更新が全部終わってから掃除する」という順序が保証される。

## なぜそうなっているか

### ラベルで宣言するのは、コンテナに設定が付いて回るから

更新対象を別の設定ファイルで管理すると、コンテナと設定がずれる。ラベルならコンテナの一部なので、`podman inspect` で見えるし、Quadlet ファイルにも書ける。

**設定をオブジェクト自身に埋める**という形は Kubernetes のアノテーションと同じ発想で、containerd の GC ラベルとも通じる ([containerd 章の GC ラベル](../../containerd/gc-labels/))。

### unit 単位にしたのは、依存関係を systemd に任せるため

コンテナを個別に再起動すると、起動順序の依存 (DB が先、アプリが後) が守られない。systemd の unit なら `After=` や `Requires=` が既に書かれているので、**unit を再起動するだけで順序が守られる**。

デーモンレスの Podman が自前で依存グラフを持つ経路もある ([依存グラフで起動・停止の順序を決める](../container-graph/)) が、auto-update は systemd 側に寄せた。既に unit として管理されているものを、わざわざ Podman 側の仕組みで再起動する理由がないからだ。

### ロールバックが安いのは、イメージが不変だから

イメージが content-addressable で不変であることが、この設計の前提になっている。**古いバージョンは「消さない限り残っている」** ので、戻すのはタグの付け替えだけで済む。

もしイメージが可変だったら、更新前にバックアップを取り、失敗したら復元する、という重い処理が要る。ストレージの設計が上位の機能の設計を規定している例といえる。

ただし `image prune` で古いイメージが消えると、ロールバックはできなくなる。だから prune を `ExecStartPost` に置き、**更新とロールバックが完全に終わってから** 走らせている。

## どう活かすか

- **更新ポリシーはオブジェクト自身に持たせる。** 別の設定ファイルに書くと、対象が消えたときに設定が残る。ラベルやアノテーションとして埋め込むと、ライフサイクルが揃う。
- **非同期 API は結果まで確認する。** D-Bus の `RestartUnit` のように「受け付けた」と「完了した」が別なら、完了を待つ経路を必ず通す。ここを省くと、失敗時の分岐が全部死ぬ。
- **状態を列挙型にして、全分岐で必ず設定する。** `statusUpdated` / `statusRolledBack` / `statusFailed` の区別があるおかげで、出力を見れば何が起きたか分かる。bool 2 つで表すと、組み合わせの意味が曖昧になる。
- **不変なデータ構造は、ロールバックを無料にする。** content-addressable なストレージの上では「戻す」が「名前を付け替える」で済む。この性質を壊す操作 (prune) は、いつ走らせるかを慎重に決める。
- **定期実行の時刻はばらつかせる。** `RandomizedDelaySec` が無いと、全ホストが同時にレジストリを叩く。自分でスケジューラを書く場合も、ジッタを入れる。

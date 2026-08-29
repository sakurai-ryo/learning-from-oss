---
title: "Podman が systemd に委ねているものの全体像"
description: "デーモンを捨てた Podman は、常駐が要る仕事を systemd に渡した。cgroup の作成、定期実行、ブート時の起動、ログの保存と配信、API の socket activation、後始末。同梱される 7 つの unit ファイルと、生成される unit に必ず入る PODMAN_SYSTEMD_UNIT 環境変数が、その委譲の全体像を示している。"
group: "systemd 統合"
sidebar:
  order: 37
---

## 何を学んだか

### 委譲の一覧

前提群で「デーモンの役割を何に置き換えたか」を見た ([デーモンがあると何ができて、無いと何が難しいか](../daemon-or-not/))。置き換え先の多くが systemd だ。この群では、その systemd 側を正面から扱う。

| デーモンがやっていたこと         | systemd の何に渡したか                         | 詳しくは                                                          |
| -------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------- |
| cgroup の作成と資源制限          | transient scope / slice を D-Bus で作らせる    | [cgroup マネージャ](../cgroup-manager/)                           |
| rootless での cgroup の所有      | `Delegate=true` の scope をもらう              | [cgroup を systemd から委譲してもらう](../rootless-cgroup-scope/) |
| 定期的なヘルスチェック           | transient timer + service                      | [transient timer に呼び戻させる](../systemd-healthcheck/)         |
| コンテナの systemd 化            | generator が `.container` を `.service` に変換 | [Quadlet](../quadlet-generator/)                                  |
| 起動完了の通知と主プロセスの追跡 | `NOTIFY_SOCKET` と `MAINPID`                   | [sdnotify と MAINPID](../sdnotify-mainpid/)                       |
| ブート時のコンテナ起動           | `podman-restart.service` (oneshot)             | 本ページ                                                          |
| イメージ更新の定期チェック       | `podman-auto-update.timer`                     | [auto-update](../auto-update/)                                    |
| ログの保存・ローテーション・配信 | journald                                       | [標準入出力・attach・ログ](../container-io/)                      |
| API サーバの起動と停止           | socket activation + idle timeout               | [REST API と Docker 互換 API](../rest-api-compat/)                |
| 再起動後の残骸の掃除             | `podman-clean-transient.service`               | 本ページ                                                          |

Podman 側に残っているのは、**「何をするか」を決めることと、systemd に依頼を投げること** だけになる。

### 同梱される unit ファイルは 7 つ

`contrib/systemd/system/` に入っているのはこれだけだ。

| unit                             | 種類     | 役割                                               |
| -------------------------------- | -------- | -------------------------------------------------- |
| `podman.socket`                  | socket   | API の unix socket を保持し、接続で service を起動 |
| `podman.service`                 | service  | `podman system service` を動かす                   |
| `podman-restart.service`         | oneshot  | ブート時に `--restart` 付きコンテナを起動          |
| `podman-auto-update.service`     | oneshot  | イメージ更新の適用                                 |
| `podman-auto-update.timer`       | timer    | 上を 1 日 1 回起動                                 |
| `podman-clean-transient.service` | oneshot  | ブート時に transient store の残骸を掃除            |
| `podman-kube@.service`           | template | `kube play` で YAML を 1 つのサービスとして動かす  |

**常駐する service は `podman.service` だけ**で、それも socket activation で必要なときにしか起動しない。残りはすべて `oneshot` か `timer` だ。

「Podman はデーモンを持たない」という主張が、unit ファイルの `Type=` を見るだけで確認できる。

### 生成された unit には必ず環境変数が入る

Quadlet や `podman generate systemd` が作る unit には、必ず `PODMAN_SYSTEMD_UNIT=%n` が入る。`%n` は systemd が展開する unit 名だ。

この環境変数は、**そこから起動されたコンテナのラベルとして記録される**。だから後から「このコンテナはどの unit に属するか」を逆引きできる。auto-update が「unit 単位で更新して再起動する」を実現しているのは、この逆引きによる。

**プロセスの親子関係でも cgroup でもなく、環境変数 → ラベルという経路で紐付けている**。デーモンレスなので、起動時の文脈を後から復元する手段が要る。

## ソースコードのどこか

### `podman.socket` と `podman.service` の組

[`contrib/systemd/system/podman.socket`](https://github.com/podman-container-tools/podman/blob/v6.1.0/contrib/systemd/system/podman.socket)。

```ini title="contrib/systemd/system/podman.socket"
[Unit]
Description=Podman API Socket
Documentation=man:podman-system-service(1)

[Socket]
ListenStream=%t/podman/podman.sock
SocketMode=0660

[Install]
WantedBy=sockets.target
```

`%t` は systemd の指定子で、**system unit なら `/run`、user unit なら `$XDG_RUNTIME_DIR`** に展開される。1 つの unit ファイルが root でも rootless でも正しい場所を指す。

Docker が `/var/run/docker.sock` を固定で持つのに対し、Podman はここでもユーザごとに分かれる。`SocketMode=0660` は所有者とグループのみ。root の場合は root しか触れず、rootless なら本人だけになる。

対になる service。[`contrib/systemd/system/podman.service.in`](https://github.com/podman-container-tools/podman/blob/v6.1.0/contrib/systemd/system/podman.service.in)。

```ini title="contrib/systemd/system/podman.service.in"
[Unit]
Description=Podman API Service
Requires=podman.socket
After=podman.socket
Documentation=man:podman-system-service(1)
StartLimitIntervalSec=0

[Service]
Delegate=true
Type=exec
KillMode=process
Environment=LOGGING="--log-level=info"
ExecStart=@@PODMAN@@ $LOGGING system service
```

3 つの設定に意味がある。

- **`Delegate=true`** — この service の cgroup 以下を自分で管理してよい、と systemd に宣言させる。コンテナの cgroup を掘るために必要 ([cgroup マネージャ](../cgroup-manager/))
- **`KillMode=process`** — 停止時に **主プロセスだけ** を殺す。既定の `control-group` だと、この service の cgroup にいる全プロセス (= conmon とコンテナ) が巻き添えになる
- **`StartLimitIntervalSec=0`** — 起動レート制限を無効化。socket activation で頻繁に起動・終了するので、「短時間に何度も起動した」で止められては困る

**`KillMode=process` の 1 行が、「API サービスを止めてもコンテナは死なない」を担保している**。デーモンレスの主張が、unit ファイルの設定に依存している箇所といえる。

### ブート時の起動は oneshot

[`contrib/systemd/system/podman-restart.service.in`](https://github.com/podman-container-tools/podman/blob/v6.1.0/contrib/systemd/system/podman-restart.service.in)。

```ini title="contrib/systemd/system/podman-restart.service.in"
[Service]
Type=oneshot
RemainAfterExit=true
Environment=LOGGING="--log-level=info"
ExecStart=@@PODMAN@@ $LOGGING start --all --filter should-start-on-boot=true
ExecStop=@@PODMAN@@  $LOGGING stop --service --all
```

`RemainAfterExit=true` があるので、**プロセスは終了しているのに unit は active のまま**になる。これで `ExecStop` (シャットダウン時のコンテナ停止) が呼ばれる。

「起動時に 1 回、停止時に 1 回だけ実行される、常駐しない service」という形が、`Type=oneshot` + `RemainAfterExit=true` で表現されている。

`--filter should-start-on-boot=true` というフィルタが、`--restart=always` / `unless-stopped` の意味論を実装している。「前回の停止がユーザによるものか」まで見る必要があるので、フィルタとして Podman 側に持っている。

### 残骸の掃除

[`contrib/systemd/system/podman-clean-transient.service.in`](https://github.com/podman-container-tools/podman/blob/v6.1.0/contrib/systemd/system/podman-clean-transient.service.in) は、なぜ必要かをファイル冒頭で説明している。

```ini title="contrib/systemd/system/podman-clean-transient.service.in"
# This service runs once each boot to remove potential leftover
# container state from previous boots.

# This is needed when using transient storage mode in podman where the
# database and other configs are stored in tmpfs, but some other files
# are not. If we don't run this after an unclean boot then there may
# be some leftover files that grow over time.

[Unit]
Description=Clean up podman transient data
RequiresMountsFor=%t/containers
Documentation=man:podman-system-prune(1)
Requires=boot-complete.target
After=local-fs.target boot-complete.target

[Service]
Type=oneshot
ExecStart=@@PODMAN@@ system prune --external
```

transient store モードでは、DB は tmpfs にあるので再起動で消える。だが **レイヤの実体は永続ディスクに残る**。DB から参照されなくなったファイルが溜まり続けるので、ブートごとに掃除する。

`Requires=boot-complete.target` が効いている。**ブートが正常に完了してからでないと掃除しない**。起動に失敗して緊急モードに落ちた状態でデータを消すと、復旧の手段が減るからだ。

「消す」操作の実行条件を systemd の target で表現している。Podman 側のコードに「ブートが成功したか」の判定を書かずに済んでいる。

### Pod を 1 つのサービスにする template unit

[`contrib/systemd/system/podman-kube@.service.in`](https://github.com/podman-container-tools/podman/blob/v6.1.0/contrib/systemd/system/podman-kube@.service.in)。

```ini title="contrib/systemd/system/podman-kube@.service.in"
[Service]
Environment=PODMAN_SYSTEMD_UNIT=%n
TimeoutStopSec=70
ExecStart=@@PODMAN@@ kube play --replace --service-container=true %I
ExecStop=@@PODMAN@@ kube down %I
Type=notify
NotifyAccess=all
```

`@` 付きの template unit で、`%I` にインスタンス名 (YAML のパス) が入る。`systemctl start podman-kube@-home-user-app.yaml.service` のように使う。

`--service-container=true` が [kube play](../kube-play/) で見たサービスコンテナを作る。`Type=notify` と `NotifyAccess=all` の組み合わせで、**Pod の中のどのプロセスからでも `READY=1` を送れる** ようにしている ([sdnotify と MAINPID](../sdnotify-mainpid/))。

`NotifyAccess=all` は systemd の設定としては緩い方だ。主プロセス以外からの通知を許すので、通常は推奨されない。だが Pod は複数プロセスの集合なので、`main` に限定できない。**構造上の要求が、設定の緩さとして現れている**。

`TimeoutStopSec=70` は、`kube down` が Pod 内の全コンテナを止めるのに時間がかかるための余裕だ。既定の 90 秒より短いのは、コンテナの停止タイムアウト (既定 10 秒) × コンテナ数を見込んだ値になっている。

### 環境変数からラベルへの経路

[`pkg/systemd/define/const.go#L7-L9`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/systemd/define/const.go#L7)。

```go title="pkg/systemd/define/const.go"
	// EnvVariable "PODMAN_SYSTEMD_UNIT" is set in all generated systemd units and
	// is set to the unit's (unique) name.
	EnvVariable = "PODMAN_SYSTEMD_UNIT"
```

「**生成されるすべての systemd unit に設定され、その unit の (一意な) 名前が入る**」。

そして auto-update がこれを逆引きに使う。[`pkg/autoupdate/autoupdate.go#L467-L474`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/autoupdate/autoupdate.go#L467)。

```go title="pkg/autoupdate/autoupdate.go"
	infra, err := pod.InfraContainer()
	if err != nil {
		return "", false, fmt.Errorf("looking up pod's systemd unit: %w", err)
	}

	infraLabels := infra.Labels()
	unit, exists := infraLabels[systemdDefine.EnvVariable]
	return unit, exists, nil
}
```

**Pod の場合は infra コンテナのラベルを見る**。Pod 全体が 1 つの unit に属するので、代表として infra を使う。[Pod とは何か](../pods-and-infra-container/) で見た「infra が Pod を代表する」という性質が、ここでも効いている。

環境変数の名前を定数にして `pkg/systemd/define` に置き、生成側 (Quadlet、`generate systemd`) と読み取り側 (auto-update) が同じ定数を参照する。**文字列の一致に依存する仕組みを、定数 1 つに集約している**。

### unit ファイルは `.in` テンプレート

すべての service ファイルが `.in` で終わっているのは、ビルド時に `@@PODMAN@@` を実際のインストールパスに置換するためだ。`/usr/bin/podman` か `/usr/local/bin/podman` かがディストリビューションで違う。

`podman.socket` と `podman-auto-update.timer` だけが `.in` を持たない。**置換すべきパスを含まないから** で、socket と timer は Podman のバイナリを直接呼ばないことがファイル名から分かる。

## なぜそうなっているか

### 委譲先が「既に信頼されている常駐プロセス」であること

Podman が systemd に賭けたのは、それが **既にすべての Linux ディストリビューションで PID 1 として動いている** からだ。新しいデーモンを追加せずに、常駐が必要な仕事を渡せる。

しかも systemd の機能は、Podman が自作するより質が高い。cgroup の管理、ログの収集とローテーション、依存関係の解決、socket activation、タイマー。どれも単体で実装すれば数千行になる。

代償は、systemd の無い環境で機能が落ちることだ。ヘルスチェックは無効になり、cgroup の制限が効かなくなる。この章で繰り返し見たとおり、**Podman はフォールバックを書かずに機能を落とす方針** を取っている。

### unit ファイルを配ることが API になる

Podman が同梱する 7 つの unit は、単なる便利ファイルではない。**「Podman をどう運用すべきか」の規範**として機能している。

`KillMode=process` を書き忘れれば API サービスの停止でコンテナが死ぬし、`Delegate=true` が無ければ cgroup が作れない。これらを毎回ユーザに書かせるのは無理だ。だから正解の unit を同梱し、Quadlet ではそれを自動生成する。

**「設定の正解」をコードではなくファイルとして配る**という形は、systemd と統合するソフトウェア一般で有効な手といえる。

### 環境変数で文脈を運ぶ

デーモンがあれば、「このコンテナはどの unit から起動されたか」はデーモンのメモリに持てる。Podman にはそれがないので、**起動時の文脈を永続化する必要がある**。

環境変数 → コンテナのラベル、という経路を選んだのは、ラベルが DB に保存され、`podman inspect` で見え、フィルタで検索できるからだ。systemd 側は `%n` を展開するだけでよく、Podman 側は環境変数を読んでラベルにするだけでよい。**両側とも既存の仕組みで済む**。

## どう活かすか

- **常駐が要る仕事は、既に常駐しているものに渡せないか考える。** 新しいデーモンを増やす前に、systemd / cron / クラウドのスケジューラで足りるかを見る。実装量だけでなく、運用の観点数も減る。
- **`KillMode=process` は「子プロセスを生き残らせたい」service の必須設定。** 既定の `control-group` は cgroup ごと殺す。プロセスを起動して自分は終了する設計の service では、必ず確認する。
- **正解の設定はファイルとして配る。** ドキュメントに「こう書いてください」と書くのではなく、動く unit ファイルを同梱する。さらに生成できるなら生成する (Quadlet)。
- **起動時の文脈は、永続化できる形で運ぶ。** 環境変数 → ラベル、のように「起動側が知っていて、後から読みたい情報」を渡す経路を 1 本決めておくと、後付けの機能 (auto-update) が安く作れる。
- **破壊的な操作は、実行条件を宣言的に書く。** `Requires=boot-complete.target` のように、「いつ実行してよいか」を systemd の依存関係で表現すると、自前の判定コードが要らなくなる。

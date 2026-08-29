---
title: "デーモンがあると何ができて、無いと何が難しいか"
description: "常駐プロセスは「今どうなっているか」を無料で提供する。状態の単一の持ち主、プロセス内ロック、リアルタイムのイベント、定期実行の主体、再起動の見張り役。デーモンを捨てた Podman はこれらを 1 つずつ別の仕組みに置き換えた。再起動ポリシーは conmon が起動する新しい podman プロセスが評価し、システムの再起動は boot_id の比較で検出する。この置き換えの一覧が、章の後半の地図になる。"
group: "コンテナランタイムの前提"
sidebar:
  order: 6
---

## 何を学んだか

### デーモンが無料で提供していたもの

常駐プロセスがあると、次のことが「何もしなくても」手に入る。

1. **状態の単一の持ち主** — 「今どのコンテナが動いているか」はメモリの中にある。誰も競合しない。
2. **プロセス内ロック** — 排他は `sync.Mutex` で済む。プロセスが 1 つしかないから。
3. **リアルタイムのイベント** — 発生した瞬間に購読者へ push できる。
4. **定期実行の主体** — ヘルスチェックもガベージコレクションも、ゴルーチンを 1 本回せばよい。
5. **見張り役** — コンテナが落ちたら気づいて再起動できる。誰かが常に見ているから。
6. **再起動の検出** — マシンが再起動したらデーモンも再起動するので、初期化コードが 1 回走ればよい。

デーモンを捨てるということは、この 6 つを全部自前で置き換えるということだ。Podman の設計の大部分は、この置き換えの記録として読める。

### Podman が何にどう置き換えたか

| デーモンの役割    | Podman の置き換え                                             | 詳しくは                                                   |
| ----------------- | ------------------------------------------------------------- | ---------------------------------------------------------- |
| 状態の持ち主      | SQLite の DB + 実体 (conmon の生死、exit file) との照合       | [状態を SQLite に置く](../sqlite-state/)                   |
| 排他制御          | `/dev/shm` 上の robust な pthread mutex。番号を DB に保存     | [プロセス間ロックを共有メモリに置く](../shm-lock-manager/) |
| イベント          | journald かログファイルへの追記。購読は追記の tail            | 本ページ後半                                               |
| 定期実行          | systemd の transient timer が `podman healthcheck run` を起動 | [transient timer に呼び戻させる](../systemd-healthcheck/)  |
| 見張り役 / 再起動 | conmon が終了時に「新しい podman プロセス」を起動する         | 本ページ後半                                               |
| 再起動の検出      | `/proc/sys/kernel/random/boot_id` を alive ファイルと比較     | 本ページ後半                                               |
| 停止時の一貫性    | シグナルの配送を危険区間の外まで遅らせる                      | [シグナルの配送を遅らせる](../shutdown-inhibit/)           |

そして置き換えられなかったもの、つまり **Podman が systemd に押し付けたもの** がある。ブート時のコンテナ起動、依存関係のあるサービスの順序、失敗時のバックオフ、そして cgroup の作成。これらは `podman-restart.service` と Quadlet を通じて systemd の仕事になる。委譲の全体像は [Podman が systemd に委ねているものの全体像](../systemd-integration-map/) にまとめた。

### 「常駐しない」ことの現実的なコスト

正直に書くと、デーモンレスにはコストがある。

- **コマンド 1 回あたりの起動が重い。** `podman ps` はストアを開き、DB を開き、状態を照合する。`docker ps` はソケットに聞くだけ。
- **イベントの粒度が落ちる。** ファイルや journald を経由するので、in-memory の pub/sub ほど密ではない。
- **「今の状態」を知るのに毎回照合が要る。** DB に「running」と書いてあっても、conmon が死んでいるかもしれない。だから Podman はほぼすべての操作の入口で実体を確認する。
- **ロックの取得順序を全プロセスで揃える必要がある。** プロセス内ロックなら開発中に検出できるデッドロックが、プロセス間だと運用中に出る。

これらを承知の上で、**「特権を持った常駐プロセスを 1 つ減らす」ことに価値がある** と判断したのが Podman だ。

## ソースコードのどこか

### 再起動ポリシーは「新しい podman プロセス」が評価する

Docker では、デーモンがコンテナの終了を検知して `--restart` を実行する。Podman には見張る主体がいない。ではどう実装しているのか。

conmon には `--exit-command` という引数が渡されている ([`libpod/oci_conmon_common.go#L1069`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/oci_conmon_common.go#L1069))。

```go title="libpod/oci_conmon_common.go"
	args = append(args, "--exit-command", exitCommand[0])
	for _, arg := range exitCommand[1:] {
		args = append(args, []string{"--exit-command-arg", arg}...)
	}
```

コンテナが終了すると conmon がこのコマンドを実行する。中身は `podman container cleanup <id>` — **つまり新しい `podman` プロセス** だ。その中で呼ばれる `fullCleanup` が、片付けの前に再起動ポリシーを見る。[`libpod/container_internal.go#L2129-L2139`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/container_internal.go#L2129)。

```go title="libpod/container_internal.go"
	// Handle restart policy.
	// Returns a bool indicating whether we actually restarted.
	// If we did, don't proceed to cleanup - just exit.
	didRestart, err := c.handleRestartPolicy(ctx)
	if err != nil {
		return err
	}
	if didRestart {
		return nil
	}

	// If we didn't restart, we perform a normal cleanup
```

再起動したなら片付けない、しなかったなら片付ける。**「見張り」が「終了時に呼ばれるコールバック」に置き換わっている**。見張るプロセスは要らないが、その代わり conmon が確実に exit command を実行することに全面的に依存する。

ブート時の起動は別で、systemd の unit が受け持つ。[`contrib/systemd/system/podman-restart.service.in`](https://github.com/podman-container-tools/podman/blob/v6.1.0/contrib/systemd/system/podman-restart.service.in)。

```ini title="contrib/systemd/system/podman-restart.service.in"
[Service]
Type=oneshot
RemainAfterExit=true
ExecStart=@@PODMAN@@ $LOGGING start --all --filter should-start-on-boot=true
ExecStop=@@PODMAN@@  $LOGGING stop --service --all
```

`Type=oneshot` で「起動時に 1 回走って終わる」。`--restart=always` を付けたコンテナをブート後に立ち上げ直す仕事が、**常駐しない oneshot サービス**として表現されている。

### システムの再起動は boot_id で検出する

デーモンがあれば、デーモン自身の起動が「システムが再起動した」の合図になる。Podman にはそれがないので、外部の事実を見るしかない。[`libpod/runtime_linux.go#L37`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/runtime_linux.go#L37)。

```go title="libpod/runtime_linux.go"
func (r *Runtime) checkBootID(runtimeAliveFile string) error {
	systemBootID, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err == nil {
		podmanBootID, err := os.ReadFile(runtimeAliveFile)
		if err != nil {
			return fmt.Errorf("reading boot ID from runtime alive file: %w", err)
		}
		if len(podmanBootID) != 0 {
			if string(systemBootID) != string(podmanBootID) {
				return fmt.Errorf("current system boot ID differs from cached boot ID; an unhandled reboot has occurred. Please delete directories %q and %q and re-run Podman", r.storageConfig.RunRoot, r.config.Engine.TmpDir)
			}
		}
```

カーネルがブートごとに生成する UUID を、`alive` ファイルに書いた値と比較する。違っていれば「気づかないうちに再起動された」ことになる。

通常は再起動で tmpfs 上の `alive` ファイルごと消えるので、**ファイルが存在しないこと** が再起動の合図になる。[`libpod/runtime.go#L578-L580`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/runtime.go#L578)。

```go title="libpod/runtime.go"
	// We now need to see if the system has restarted
	// We check for the presence of a file in our tmp directory to verify this
	// This check must be locked to prevent races
	runtimeAliveFile := filepath.Join(runtime.config.Engine.TmpDir, "alive")
```

boot_id の比較はその保険で、「tmpdir が tmpfs でないなど、ファイルが残ってしまう環境」を捕まえる。残っていた場合は自動では直さず、**ディレクトリを消して再実行しろというエラーで止まる**。壊れた状態で進むより止まる方を選んでいる。

### 再起動を検出したらやること

再起動が検出されると `refresh` が走る。[`libpod/runtime.go#L892`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/runtime.go#L892)。

```go title="libpod/runtime.go"
// Reconfigures the runtime after a reboot
// Refreshes the state, recreating temporary files
// Does not check validity as the runtime is not valid until after this has run
func (r *Runtime) refresh(ctx context.Context, alivePath string) error {
	logrus.Debugf("Podman detected system restart - performing state refresh")
	...
	// Next refresh the state of all containers to recreate dirs and
	// namespaces, and all the pods to recreate cgroups.
	// Containers, pods, and volumes must also reacquire their locks.
```

DB に残っている「running」を全部クリアし、一時ディレクトリを作り直し、**すべてのコンテナ・Pod・ボリュームがロックを取り直す**。共有メモリ上のロックは再起動で消えるので、番号の割り当てからやり直す必要がある。

排他の取り方にも注目したい。

```go title="libpod/runtime.go"
	// No locks are taken during pod, volume, and container refresh.
	// Furthermore, the pod/volume/container refresh() functions are not
	// allowed to take locks themselves.
	// We cannot assume that any pod/volume/container has a valid lock until
	// after this function has returned.
	// The runtime alive lock should suffice to provide mutual exclusion
	// until this has run.
```

**「ロックを作り直している最中はロックが使えない」** という鶏と卵の問題を、より上位の `alive.lck` というファイルロック 1 つで解いている。デーモンなら起動時の初期化として自然に直列化されるところを、明示的なファイルロックで代替している例だ。

### イベントは追記されるログでしかない

Docker の `docker events` はデーモンからの push だが、Podman のイベントは書き込み先を選ぶ形になっている。[`libpod/events/events_supported.go#L14`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/events/events_supported.go#L14)。

```go title="libpod/events/events_supported.go"
// NewEventer creates an eventer based on the eventer type
func NewEventer(options EventerOptions) (Eventer, error) {
	logrus.Debugf("Initializing event backend %s", options.EventerType)
	switch EventerType(strings.ToLower(options.EventerType)) {
	case Journald:
		return newJournalDEventer(options)
	case LogFile:
		return newLogFileEventer(options)
	case Null:
		return newNullEventer(), nil
```

既定は journald。**イベントの保存と配信を systemd-journald に丸投げしている**。`podman events` は journald に問い合わせるだけで、Podman 側にイベントを保持する仕組みはない。journald がない環境ではファイルへの追記になり、購読は tail になる。

「イベントバス」という部品を自分で持たず、既にあるログ基盤に寄せる。デーモンを持たない設計では、こうした「OS に既にある常駐サービスを使う」判断が繰り返し出てくる。

## なぜそうなっているか

### 常駐プロセスの価値は「状態の一貫性」であって、機能ではない

デーモンでしかできない機能は、実はほとんどない。デーモンが本当に提供しているのは **状態の一貫性** だ。1 つのプロセスがすべてを知っていれば、競合も不整合も原理的に起きない。

Podman はこの一貫性を、次の 3 つの組み合わせで作り直している。

1. **永続化された真実** (SQLite) — 誰でも読める
2. **プロセス間の排他** (共有メモリの mutex) — 誰でも同じ順序で取れる
3. **実体との照合** — DB を信用せず、conmon の生死と exit file を毎回確認する

3 つ目が特に重要で、デーモンなら「自分が知っていること = 真実」でよいところを、Podman は **「DB は記録にすぎず、真実は OS の側にある」** という立場を取る。プロセスが強制終了されても、DB との差分は次の操作のときに解消される。

### systemd がある前提に賭けた

Podman が置き換えを完遂できたのは、**systemd という「既に常駐している信頼できるプロセス」がある** ことに賭けたからだ。定期実行、ブート時の起動、cgroup の管理、ログの収集 — どれも systemd が既に持っている。デーモンを新しく作る代わりに、既にあるデーモンに仕事を渡した。

この賭けの代償は、systemd の無い環境で機能が落ちることだ。ヘルスチェックは黙って無効になり、cgroup の制限はかからなくなる。Podman はこれを隠さず、**フォールバック実装を書かずに「その機能は無い」** とする方針を取っている。中途半端な代替実装を持たないことで、コードが増えるのを防いでいる。

## どう活かすか

- **「デーモンにするか」を機能で判断しない。** 常駐プロセスの本質は状態の一貫性であって、機能ではない。一貫性を別の手段 (永続化 + プロセス間ロック + 実体との照合) で得られるなら、常駐しない選択肢が出てくる。
- **「記録」と「真実」を分けて考える。** DB に書いた状態は記録にすぎず、真実は OS やネットワークの側にある、という前提でコードを書くと、プロセスが突然死んでも復帰できる。逆に「DB = 真実」と仮定した設計は、書き込みの途中で死んだ瞬間に壊れる。
- **既にある常駐サービスに仕事を渡せないか考える。** 定期実行のために自前のスケジューラを常駐させる前に、cron / systemd timer / クラウドのスケジューラで足りないかを見る。Podman が journald と systemd に寄せたのはその判断だ。
- **フォールバックを書かない勇気。** 依存先が無い環境で機能を落とす方が、劣化した独自実装を持つより保守が楽なことがある。ただし「黙って無効」ではなく、警告を出すことがセットになる。

---
title: "containerd が死んでもコンテナは死なない"
description: "デーモンの起動時、containerd は state ディレクトリを走査して bundle を見つけ、bootstrap.json のアドレスに ttrpc で繋ぎ直す。応答しない shim は掃除し、タスクを持たない shim は「クラッシュの残骸」として片付ける。全体に読み込みタイムアウトが 1 つ掛かっていて、無応答の shim が起動を止めない。"
group: "コンテナを実行する"
sidebar:
  order: 44
---

## 何を学んだか

### 起動時にディスクを走査する

containerd を再起動すると、runtime v2 プラグインの初期化で `LoadExistingShims` が走る。

```
/run/containerd/io.containerd.runtime.v2.task/
├── k8s.io/          ← namespace ごと
│   ├── <id-1>/      ← bundle。ここから shim に繋ぎ直す
│   └── <id-2>/
└── default/
```

namespace ディレクトリを列挙し、その下の bundle ごとに shim への接続を試みる。**メモリ上の状態は失われているが、ディスクとプロセスは残っている** ので、そこから再構築する。

### 3 通りの結末

読み込んだ shim は、次のいずれかになる。

1. **タスクを実行中** → 接続を保持し、タスク一覧に登録する
2. **sandbox の shim** → タスクがなくても正常。登録する
3. **タスクのない普通の shim** → containerd のクラッシュで取り残された残骸。片付ける

3 の判定が難しい。「sandbox ではなく、かつ PID が 1 つもない」なら残骸だと判断する。

### 応答しない shim で起動が止まらないように

shim との通信はネットワーク (Unix ソケット) 越しなので、応答しない可能性がある。しかもこの処理は **プラグインの初期化中** に走るので、止まると containerd 全体が起動しない。

そこで、shim 1 つの読み込み全体に 1 つのタイムアウトを掛ける。

### 並列に読む

bundle は namespace 内で並列に処理される。`GOMAXPROCS` を上限にした errgroup で、数百の Pod があるノードでも起動が遅くならないようにしている。

## ソースコードのどこか

### namespace ごとの走査

[`core/runtime/v2/shim_load.go#L28-L54`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/runtime/v2/shim_load.go#L28-L54)。

```go title="core/runtime/v2/shim_load.go"
// LoadExistingShims loads existing shims from the path specified by stateDir
// rootDir is for cleaning up the unused paths of removed shims.
func (m *ShimManager) LoadExistingShims(ctx context.Context, stateDir string, rootDir string) error {
	nsDirs, err := os.ReadDir(stateDir)
	...
	for _, nsd := range nsDirs {
		if !nsd.IsDir() {
			continue
		}
		ns := nsd.Name()
		// skip hidden directories
		if len(ns) > 0 && ns[0] == '.' {
			continue
		}
		log.G(ctx).WithField("namespace", ns).Debug("loading tasks in namespace")
		if err := m.loadShims(namespaces.WithNamespace(ctx, ns), stateDir); err != nil {
			log.G(ctx).WithField("namespace", ns).WithError(err).Error("loading tasks in namespace")
			continue
		}
```

**ディレクトリ構造がそのまま namespace の一覧** になっている。メタデータ DB を読む必要がない。

隠しディレクトリを飛ばすのは、削除中の bundle を拾わないため ([bundle: ディスク上に置かれた実行単位](../bundle/))。

ある namespace の読み込みが失敗しても `continue` する。**1 つの namespace の問題が他に波及しない**。

### 並列読み込みと fast path

[`core/runtime/v2/shim_load.go#L56-L110`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/runtime/v2/shim_load.go#L56-L110)。

```go title="core/runtime/v2/shim_load.go"
	eg, ctx2 := errgroup.WithContext(ctx)
	eg.SetLimit(runtime.GOMAXPROCS(0))
```

同時実行数を CPU 数に制限する。I/O 待ちが主なので CPU 数が最適とは限らないが、無制限にして数百の goroutine が同時に ttrpc 接続を試みるよりは安定する。

```go title="core/runtime/v2/shim_load.go"
			if len(bf) == 0 {
				bundle.Delete()
				return nil
			}
			if err := m.loadShim(ctx2, bundle); err != nil {
				log.G(ctx2).WithError(err).Errorf("failed to load shim %s", bundle.Path)
				bundle.Delete()
				return nil
			}
			return nil
```

**どの失敗経路でも `bundle.Delete()` して `nil` を返す**。errgroup にエラーを伝えないので、1 つの bundle の失敗が他の読み込みを止めない。

`eg.Wait()` の戻り値も捨てられている (`_ = eg.Wait()`)。errgroup をエラー伝播ではなく **並列度の制御と完了待ちのため** だけに使っている。

### 読み込み全体のタイムアウト

[`core/runtime/v2/shim_load.go#L113-L125`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/runtime/v2/shim_load.go#L113-L125)。

```go title="core/runtime/v2/shim_load.go"
	// One budget for the whole load: shims are loaded during plugin
	// initialization, so a shim that never answers would otherwise stall
	// containerd startup. Nested timeouts can only shorten a deadline, so this
	// bounds the load however many calls it makes.
	ctx, cancel := timeout.WithContext(ctx, loadTimeout)
	defer cancel()
```

「読み込み全体に 1 つの予算」。コメントの後半が要点で、**入れ子のタイムアウトは締め切りを短くすることしかできない** ので、外側で 1 つ掛ければ内部が何回 RPC を呼んでも全体が縛られる。

Go の `context` の性質 (親より長い締め切りは設定できない) を利用した、確実な打ち切り方だ。

### ランタイム名の復元

```go title="core/runtime/v2/shim_load.go"
	// If we're on 1.6+ and specified custom path to the runtime binary, path will be saved in 'shim-binary-path' file.
	if data, err := os.ReadFile(filepath.Join(bundle.Path, "shim-binary-path")); err == nil {
		runtime = string(data)
	} else if err != nil && !os.IsNotExist(err) {
		log.G(ctx).WithError(err).Error("failed to read `runtime` path from bundle")
	}

	// Query runtime name from metadata store
	if runtime == "" {
		container, err := m.containers.Get(ctx, id)
		if err != nil {
			log.G(ctx).WithError(err).Errorf("loading container %s", id)
			if err := mount.UnmountRecursive(filepath.Join(bundle.Path, "rootfs"), 0); err != nil {
```

まず bundle の `shim-binary-path` を読み、なければメタデータ DB のコンテナレコードから引く。**2 つの情報源** を持っている。

コンテナレコードもない場合は、rootfs をアンマウントしてから諦める。**マウントを残さない** ことが徹底されている。

### 接続の確認

```go title="core/runtime/v2/shim_load.go"
func loadShimTask(ctx context.Context, bundle *Bundle, onClose func()) (_ *shimTask, retErr error) {
	shim, err := loadShim(ctx, bundle, onClose)
	...
	// Check connectivity, TaskService is the only required service, so create a temp one to check connection.
	s, err := newShimTask(shim)
	...
	if _, err := s.PID(ctx); err != nil {
		if !errdefs.IsNotImplemented(err) {
```

接続しただけでは不十分で、**実際に RPC を 1 回呼んで疎通を確認する**。`PID` を選んでいるのは副作用がなく軽いからだ。

Unix ソケットは相手が死んでいても connect が成功することがあるので、この確認が要る。

### 残骸の判定

[`core/runtime/v2/shim_load.go#L188-L225`](https://github.com/containerd/containerd/blob/716cbaf51212adb5e80ca1c30b644bfeb9c9d779/core/runtime/v2/shim_load.go#L188-L225)。

```go title="core/runtime/v2/shim_load.go"
	// There are 3 possibilities for the loaded shim here:
	// 1. It could be a shim that is running a task.
	// 2. It could be a sandbox shim.
	// 3. Or it could be a shim that was created for running a task but
	// something happened (probably a containerd crash) and the task was never
	// created. This shim process should be cleaned up here. Look at
	// containerd/containerd#6860 for further details.

	_, sgetErr := m.sandboxStore.Get(ctx, id)
	pInfo, pidErr := shim.Pids(ctx)
	if shouldCleanupShim(sgetErr, pidErr, pInfo) {
```

**3 つの可能性が列挙され、issue 番号が添えてある**。3 番目のケース (shim は起動したがタスクが作られる前に containerd が落ちた) は、実際に報告されて対処された問題だ。

判定関数。

```go title="core/runtime/v2/shim_load.go"
// shouldCleanupShim determines whether or not a shim is in such a state that
// we should reap it. To be reapable we confirm that it is not a sandbox shim
// and it has no pids running
func shouldCleanupShim(sgetErr, pidErr error, pInfo []runtimeapi.ProcessInfo) bool {
	return errors.Is(sgetErr, errdefs.ErrNotFound) &&
		(errors.Is(pidErr, errdefs.ErrNotFound) ||
			(pidErr == nil && len(pInfo) == 0))
}
```

条件を **独立した関数に切り出している**。3 つの引数を取る純粋関数なので、単体テストが書きやすい。

「sandbox ストアにない」かつ「PID が取れない、または 0 個」。`pidErr` が `ErrNotFound` 以外 (通信エラーなど) の場合は残骸と判定しない — 判断できないなら消さない、という安全側の設計だ。

```go title="core/runtime/v2/shim_load.go"
	} else {
		if pidErr != nil {
			log.G(ctx).WithField("id", id).WithError(pidErr).Warn("failed to query shim pids, keeping shim registered")
		}
		m.shims.Add(ctx, shim.ShimInstance)
	}
```

PID の問い合わせに失敗しても、警告を出して **登録を維持する**。消してしまうと、生きているコンテナが containerd から見えなくなる。

### 掃除に失敗したら bundle を消す

```go title="core/runtime/v2/shim_load.go"
		if err := cleanupShimTask(ctx, shim); err != nil && !errdefs.IsNotFound(err) {
			// Returning an error makes loadShims remove the bundle; a shim we
			// cannot reap would otherwise be reloaded on every start.
			return fmt.Errorf("failed to clean up leaked shim %q: %w", id, err)
		}
```

掃除に失敗したらエラーを返し、呼び出し側が bundle を削除する。理由は「片付けられない shim を毎回の起動で読み直すことになるから」。

**同じ失敗を繰り返さない** ための判断で、多少乱暴でも起動のたびにエラーログが出続けるよりよい。

## なぜそうなっているか

### メモリの状態を捨てて、ディスクから作り直す

デーモンが再起動するとき、「前回の状態を引き継ぐ」方法は 2 つある。

- **状態をシリアライズして保存し、起動時に復元する**
- **観測可能な事実から再構築する**

containerd は後者を採っている。bundle ディレクトリの存在、`bootstrap.json` の内容、shim プロセスの生死。これらは **実際に今そうである事実** なので、前回の保存内容がずれている心配がない。

前者だと、保存後・再起動前に起きた変化 (コンテナの終了など) を取りこぼす。

### 起動を止めないことを最優先にする

この処理は containerd の起動パスにある。1 つの shim が応答しないだけで起動しなければ、ノード全体が使えなくなる。

だから、

- 全体にタイムアウトを掛ける
- 個々の失敗はログを出して次へ進む
- 判断できないものは残す (消さない)
- 片付けられないものは bundle ごと消す (繰り返さない)

という方針が徹底されている。**「正しく復元する」より「起動する」を優先** している。

### issue 番号をコメントに残す

`containerd/containerd#6860` のような参照が、判定ロジックの根拠として書かれている。「なぜこの 3 分岐なのか」は、コードだけからは復元できない。

ただし issue 参照は情報の外部化でもあり、リンクが切れれば意味を失う。containerd は **判定の内容自体もコメントで説明したうえで**、詳細を issue に譲る形にしている。

## どう活かすか

### 再起動後の状態を確認する

```sh
# containerd を再起動する
$ systemctl restart containerd

# コンテナが生き残っているか
$ ctr -n k8s.io tasks ls

# ログで読み込みの様子を見る
$ journalctl -u containerd | grep -E "loading tasks|cleaning leaked shim|failed to load shim"
```

`cleaning leaked shim process` が出ていたら、前回のクラッシュで取り残された shim があったということだ。頻発するなら containerd 自体が異常終了している。

### コンテナが「消えた」場合

再起動後にコンテナが `ctr tasks ls` に出てこない場合、

1. bundle が残っているか (`ls /run/containerd/io.containerd.runtime.v2.task/<ns>/`)
2. shim プロセスが生きているか (`ps -ef | grep shim`)
3. ログに `failed to load shim` が出ていないか

bundle が消えていれば、読み込み時に削除されている。ログに理由が出ているはずだ。

### 「事実から再構築する」復元設計

デーモンの再起動を跨いで状態を維持する仕組みを作るときの要点。

- **保存するのは「再接続に必要な最小限」だけ** — 状態そのものは保存しない
- **起動時に実際の状態を観測する** — プロセスの生死、ソケットの疎通
- **疎通確認は実際に 1 回呼ぶ** — 接続の成功を信じない
- **全体にタイムアウトを掛ける** — 起動を止めない
- **判断できないものは消さない、繰り返し失敗するものは諦める** — 両方の失敗モードに手当てする

最後の 2 つはトレードオフの関係にあり、containerd は「1 回の起動では残す、繰り返すなら諦める」という中間解を選んでいる。

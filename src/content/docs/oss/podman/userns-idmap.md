---
title: "uid のマッピングは setuid ヘルパーに書かせ、コンテナ側は「中間 ID」に対する二段目として作る"
description: "非特権プロセスが /proc/<pid>/uid_map に書けるのは自分の uid 1 行だけ。subuid の範囲を使うには setuid root の newuidmap に検証させて書かせる。コンテナの --userns=keep-id や nomap は、その rootless namespace の内側にもう 1 段作るマッピングで、親 namespace の範囲に収まるよう分割してから OCI ランタイムに渡す。"
group: "rootless"
sidebar:
  order: 6
---

## 何を学んだか

### どんな状況の話か

[前のページ](../constructor-reexec/) で、rootless の Podman は `clone(CLONE_NEWUSER)` した子が親の合図を待ってから `setresuid(0,0,0)` する、と書いた。親が合図の前にやるのは `/proc/<pid>/uid_map` と `gid_map` を書くことだ。この 2 つのファイルが、namespace の中の uid をホストの uid にどう対応させるかを決める。

書けるのは 1 回だけで、書式は `<namespace 内 ID> <親 namespace の ID> <個数>` の行を並べたもの。ここに制約がある。**特権のないプロセスが書けるのは、自分の euid をどれか 1 つの ID に対応させる 1 行だけ**。イメージに含まれる `www-data` (uid 33) や `nobody` (65534) のファイルを展開するには、複数の uid を対応させる行が要り、それを書くには親 namespace での `CAP_SETUID` が必要になる (man `user_namespaces(7)`)。

さらに、コンテナ自体にも `--userns=keep-id` のような user namespace の設定がある。rootless では Podman 自身がすでに namespace の中にいるので、コンテナの namespace は **namespace の中に作る namespace** になり、マッピングは 2 段になる。

### Podman の答え

1. **Podman は setuid ではない。`newuidmap` / `newgidmap` に書かせる。** shadow-utils の setuid root ヘルパーが `/etc/subuid` を自分で検証し、その範囲内なら `uid_map` に複数行を書く。Podman は「自分の uid → 0、subuid の各範囲 → 1 以降に連続配置」という引数を組み立てて渡すだけ。
2. **ヘルパーが使えなければ、自分の uid 1 行だけの単一マッピングに縮退して警告する。** ただしユーザーが明示的に設定した範囲があるときは縮退せずエラーにする。
3. **コンテナの `--userns` は「中間 ID」に対する二段目のマッピング。** docs はこれを "host UID → intermediate UID → container UID" と説明している。`keep-id` は中間 ID 0 (= ホストの自分) をコンテナ内の自分の uid に置く配置、`nomap` は中間 ID 0 を一切対応させない配置として、どちらも二段目のマッピングとして表現される。
4. **二段目の各行は、親 namespace の 1 つの範囲に完全に収まる必要がある。** rootless の親 namespace は `0 1000 1` と `1 100000 65536` のように分かれているので、`0:0:2` のような要求はカーネルに拒否される。`MaybeSplitMappings` が OCI spec を渡す直前に範囲を割る。
5. **`podman unshare` は namespace を作らない。** Podman はもう namespace の中にいるので、環境変数を足して子プロセスを exec すれば、子は同じ namespace を継承する。

## ソースコードのどこか

### subuid の範囲を連続配置する

`/etc/subuid` の読み取りとマッピングの組み立ては containers/storage (v1.64.0) にある。[`vendor/go.podman.io/storage/pkg/idtools/idtools.go#L300-L315`](https://github.com/podman-container-tools/podman/blob/v6.1.0/vendor/go.podman.io/storage/pkg/idtools/idtools.go#L300-L315) の `createIDMap` は、範囲を開始 ID 順に並べて、namespace 側の ID を 0 から詰める。

```go title="vendor/go.podman.io/storage/pkg/idtools/idtools.go"
func createIDMap(subidRanges []subIDRange) []IDMap {
	idMap := []IDMap{}

	// sort the ranges by lowest ID first
	slices.SortFunc(subidRanges, compareRanges)
	containerID := 0
	for _, idrange := range subidRanges {
		idMap = append(idMap, IDMap{
			ContainerID: containerID,
			HostID:      idrange.Start,
			Size:        idrange.Length,
		})
		containerID = containerID + idrange.Length
	}
	return idMap
}
```

Podman はこれを `GetConfiguredMappings` ([`pkg/rootless/rootless_linux.go#L165-L193`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/rootless/rootless_linux.go#L165-L193)) 経由で受け取る。ユーザー名は `$USER` を優先し、無ければ euid から引く。subuid が見つからなくてもエラーは返さず、空のマッピングを返して呼び出し側の縮退に任せる。

### newuidmap の引数を組み立てる

[`rootless_linux.go#L90-L140`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/rootless/rootless_linux.go#L90-L140) の `tryMappingTool`。

```go title="pkg/rootless/rootless_linux.go"
	args := []string{path, strconv.Itoa(pid)}
	args = appendTriplet(args, 0, hostID, 1)
	for _, i := range mappings {
		if hostID >= i.HostID && hostID < i.HostID+i.Size {
			what := "UID"
			where := "/etc/subuid"
			if !uid {
				what = "GID"
				where = "/etc/subgid"
			}
			return fmt.Errorf("invalid configuration: the specified mapping %d:%d in %q includes the user %s", i.HostID, i.Size, where, what)
		}
		args = appendTriplet(args, i.ContainerID+1, i.HostID, i.Size)
	}
	cmd := exec.Cmd{
		Path: path,
		Args: args,
	}

	if output, err := cmd.CombinedOutput(); err != nil {
		logrus.Errorf("running `%s`: %s", strings.Join(args, " "), output)
		errorStr := fmt.Sprintf("cannot set up namespace using %q", path)
		if isSet, err := unshare.IsSetID(cmd.Path, mode, cap); err != nil {
			logrus.Errorf("Failed to check for %s on %s: %v", idtype, path, err)
		} else if !isSet {
			errorStr = fmt.Sprintf("%s: should have %s or have filecaps %s", errorStr, idtype, idtype)
		}
		return fmt.Errorf("%v: %w", errorStr, err)
	}
```

uid 1000 で `/etc/subuid` が `1000:100000:65536` なら、実行されるのは `newuidmap <pid> 0 1000 1 1 100000 65536`。`createIDMap` が 0 から詰めた `ContainerID` を `+1` ずらしているのは、0 を自分の uid のために空けるためだ。自分の uid が subuid の範囲に含まれていると、カーネルが重複するマッピングを拒否するので、実行前に検出してエラーにする。実行に失敗したときは `IsSetID` で「そもそも newuidmap に setuid ビットか `cap_setuid` があるか」を調べ、原因をエラーメッセージに含める。

結果は `podman unshare cat /proc/self/uid_map` で見える ([`docs/source/markdown/podman-unshare.1.md#L66-L80`](https://github.com/podman-container-tools/podman/blob/v6.1.0/docs/source/markdown/podman-unshare.1.md#L66-L80))。

```
         0       1000          1
         1     100000      65536
```

### 3 段の縮退

マッピングを書く親側は [`rootless_linux.go#L288-L343`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/rootless/rootless_linux.go#L288-L343)。

```go title="pkg/rootless/rootless_linux.go"
	if err := copyMappings("/proc/self/uid_map", uidMap); err == nil {
		uidsMapped = true
	}

	if uids != nil && !uidsMapped {
		err := tryMappingTool(true, pid, os.Geteuid(), uids)
		// If some mappings were specified, do not ignore the error
		if err != nil && len(uids) > 0 {
			return false, -1, err
		}
		uidsMapped = err == nil
	}
	if !uidsMapped {
		logrus.Warnf("Using rootless single mapping into the namespace. This might break some images. Check /etc/subuid and /etc/subgid for adding sub*ids if not using a network user")
		setgroups := fmt.Sprintf("/proc/%d/setgroups", pid)
		err = os.WriteFile(setgroups, []byte("deny\n"), 0o666)
		if err != nil {
			return false, -1, fmt.Errorf("cannot write setgroups file: %w", err)
		}
		logrus.Debugf("write setgroups file exited with 0")

		err = os.WriteFile(uidMap, fmt.Appendf(nil, "%d %d 1\n", 0, os.Geteuid()), 0o666)
		if err != nil {
			return false, -1, fmt.Errorf("cannot write uid_map: %w", err)
		}
		logrus.Debugf("write uid_map exited with 0")
	}
```

順に、(a) すでに root だが `CAP_SYS_ADMIN` が無い (コンテナの中で Podman を動かしている) 場合は自分の `uid_map` をそのままコピー、(b) `newuidmap`、(c) 自分の euid 1 行だけの単一マッピング。(c) は特権なしで書ける唯一の形で、`gid_map` を書く前に `/proc/<pid>/setgroups` に `deny` を書く必要があるのもカーネルの規則だ。`len(uids) > 0` のときにエラーを返す分岐は、「subuid が設定されているのに newuidmap が失敗した」ならユーザーの意図に反する縮退をしない、という判断になっている。

(a) の `copyMappings` ([`#L195-L213`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/rootless/rootless_linux.go#L195-L213)) には OCI ランタイムとの噛み合わせの細工がある。

```go title="pkg/rootless/rootless_linux.go"
	// Both runc and crun check whether the current process is in a user namespace
	// by looking up 4294967295 in /proc/self/uid_map.  If the mappings would be
	// copied as they are, the check in the OCI runtimes would fail.  So just split
	// it in two different ranges.
	if bytes.Contains(content, []byte("4294967295")) {
		content = []byte("0 0 1\n1 1 4294967294\n")
	}
```

カーネルは (u32)-1 を含むマッピングの作成を拒否するので、`4294967295` が `uid_map` にあるのは初期 user namespace だけになる。runc も crun もこれで「namespace の中にいるか」を判定するため、初期 namespace のマッピングをそのまま写すと「中にいない」と誤認される。わざと 2 行に割ることで、全 ID を対応させたまま判定だけを変えている。

### 二段目: keep-id と nomap

コンテナの `--userns=keep-id` は [`pkg/util/utils.go#L177-L214`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/util/utils.go#L177-L214) の `getRootlessKeepIDMapping` で作られる。

```go title="pkg/util/utils.go"
	if len(uids) > 0 && uid != 0 {
		options.UIDMap = append(options.UIDMap, idtools.IDMap{ContainerID: 0, HostID: 1, Size: min(uid, maxUID)})
	}
	options.UIDMap = append(options.UIDMap, idtools.IDMap{ContainerID: uid, HostID: 0, Size: 1})
	if maxUID > uid {
		options.UIDMap = append(options.UIDMap, idtools.IDMap{ContainerID: uid + 1, HostID: uid + 1, Size: maxUID - uid})
	}
```

ここでの `HostID` はホストの uid ではなく、**rootless namespace の中の ID (中間 ID)** だ。uid 1000 なら、コンテナの 0〜999 ← 中間 1〜1000 (subuid の先頭 1000 個)、コンテナの 1000 ← 中間 0 (= ホストの自分)、コンテナの 1001〜 ← 中間 1001〜、という 3 行になる。結果としてコンテナ内の uid 1000 で作ったファイルは、ホストでは自分の所有になる。

`nomap` ([`#L262-L289`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/util/utils.go#L262-L289)) は逆に、中間 ID 0 をどこにも対応させない。

```go title="pkg/util/utils.go"
	uid, gid := 0, 0
	for _, u := range uids {
		options.UIDMap = append(options.UIDMap, idtools.IDMap{ContainerID: uid, HostID: uid + 1, Size: u.Size})
		uid += u.Size
	}
```

コンテナから抜け出したプロセスがいても、ホストの自分のファイルには触れない。docs の表 ([`docs/source/markdown/options/uidmap.container.md#L40-L100`](https://github.com/podman-container-tools/podman/blob/v6.1.0/docs/source/markdown/options/uidmap.container.md#L40-L100)) が "host UID → intermediate UID → container UID" の二段を説明しているのは、この `HostID` の意味を読者に伝えるためだ。

### 親 namespace の範囲に合わせて割る

OCI spec を組み立てる直前、[`libpod/container_internal_linux.go#L427-L449`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/container_internal_linux.go#L427-L449) で `MaybeSplitMappings` を通す。

```go title="libpod/container_internal_linux.go"
	availableUIDs, availableGIDs, err := rootless.GetAvailableIDMaps()
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			// The kernel-provided files only exist if user namespaces are supported
			logrus.Debugf("User or group ID mappings not available: %s", err)
		} else {
			return err
		}
	} else {
		g.Config.Linux.UIDMappings = rootless.MaybeSplitMappings(g.Config.Linux.UIDMappings, availableUIDs)
		g.Config.Linux.GIDMappings = rootless.MaybeSplitMappings(g.Config.Linux.GIDMappings, availableGIDs)
	}
```

本体は [`pkg/rootless/rootless.go#L163-L213`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/rootless/rootless.go#L163-L213)。要求された各行について、その `HostID` が親の `/proc/self/uid_map` のどの範囲に入るかを探し、範囲の残りで足りなければ余りを次の行に繰り越す。

```go title="pkg/rootless/rootless.go"
		// the current range can satisfy the whole request
		if usableIDs >= cur.Size {
			// reset the overflow
			overflow.Size = 0
		} else {
			// the current range can satisfy the request partially
			// so move the rest to overflow
			overflow.Size = cur.Size - usableIDs
			overflow.ContainerID = cur.ContainerID + usableIDs
			overflow.HostID = cur.HostID + usableIDs

			// and cap to the usableIDs count
			cur.Size = usableIDs
		}
		ret = append(ret, cur)
```

テスト ([`pkg/rootless/rootless_test.go#L25-L60`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/rootless/rootless_test.go#L25-L60)) が期待値を端的に示している。親が `0 1000 1` と `1 1000000 65536` のとき、`0:0:2` の要求は `0:0:1` と `1:1:1` に割られる。要求の `HostID` が親のどの範囲にも無ければ、元の要求をそのまま返してカーネルのエラーに任せる ("let other layers deal with it")。

### podman unshare は exec するだけ

[`pkg/domain/infra/abi/system.go#L322-L341`](https://github.com/podman-container-tools/podman/blob/v6.1.0/pkg/domain/infra/abi/system.go#L322-L341)。

```go title="pkg/domain/infra/abi/system.go"
func unshareEnv(graphroot, runroot string) []string {
	return append(os.Environ(), "_CONTAINERS_USERNS_CONFIGURED=done",
		fmt.Sprintf("CONTAINERS_GRAPHROOT=%s", graphroot),
		fmt.Sprintf("CONTAINERS_RUNROOT=%s", runroot))
}

func (ic *ContainerEngine) Unshare(_ context.Context, args []string, options entities.SystemUnshareOptions) error {
	unshare := func() error {
		cmd := exec.Command(args[0], args[1:]...)
		cmd.Env = unshareEnv(ic.Libpod.StorageConfig().GraphRoot, ic.Libpod.StorageConfig().RunRoot)
		cmd.Stdin = os.Stdin
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		return cmd.Run()
	}
	/* ... */
	return unshare()
}
```

`unshare(2)` はどこにも無い。man ページは "Launches a process ... in a new user namespace" と書いているが、実装上はこの関数に着いた時点で Podman は namespace 内の root なので、子プロセスは自動的に同じ namespace を継承する。`_CONTAINERS_USERNS_CONFIGURED=done` を足すのは、その中で `podman` や `buildah` を実行したときに、もう一度 namespace を作りに行かないようにするためだ。

## なぜそうなっているか

- **特権の境界を OS 標準の小さなヘルパーに置く。** [`docs/tutorials/rootless_tutorial.md#L205-L207`](https://github.com/podman-container-tools/podman/blob/v6.1.0/docs/tutorials/rootless_tutorial.md#L205-L207) は "Rootless Podman is not, and will never be, root; it's not a `setuid` binary, and gains no privileges when it runs" と明言している。複数 uid のマッピングには特権が要るが、それを Podman に持たせず、`/etc/subuid` の範囲検証まで含めて `newuidmap` に任せることで、監査対象は shadow-utils の小さなバイナリだけになる。
- **「中間 ID」の二段構造は、root と rootless で同じコードを使うための代償。** コンテナの `--userns` を扱うコードは、自分がホストの初期 namespace にいるか rootless の namespace にいるかを区別しない。`HostID` を「自分から見た親の ID」と定義すれば同じコードで済むが、ユーザーには「`--uidmap` の host 側は本当の host ではない」という難解さが残る。docs の `@` 記法 (`--userns=auto:uidmapping=1:@100000:1` のようにホストの ID を指定して中間 ID を逆引きする) は、その難解さを埋めるための後付けだ。
- **縮退は「設定が無い」場合だけ。** `newuidmap` が無い環境でも単一マッピングで動き続けるのは、ネットワークユーザー (LDAP など) のように subuid を設定できない環境を切り捨てないため。だが subuid が設定されているのに失敗したときは、黙って縮退するとイメージの展開が中途半端に壊れるので、エラーにする。
- **OCI ランタイムの判定に合わせて uid_map を細工する** (`copyMappings`) のは、Podman が runc / crun の内部実装に依存している実例でもある。マッピングの意味は同じでも、書き方でランタイムの挙動が変わる。

## どう活かすか

- 特権が要る操作を 1 つでも含むツールを作るなら、自分を setuid にする前に、その操作だけを担う既存の setuid ヘルパーが無いか探す。ヘルパーに入力の検証まで任せられれば、自分は非特権のままでいられる。
- 縮退経路を持つなら、「ユーザーが何も設定していない」と「設定したが使えない」を分ける。前者は警告して動き続け、後者はエラーにする。両方を同じ扱いにすると、設定ミスが黙って壊れた動作になる。
- 「親から見た ID」のような相対的な座標系を導入するときは、docs にその座標系の名前 (Podman なら "intermediate UID") を付け、表で示す。名前が無いと、ユーザーは `HostID` を文字通りに読む。
- 依存先 (OCI ランタイム) がデータの形を見て挙動を変えるなら、その判定条件をコメントに残す。`copyMappings` のコメントが無ければ、`0 0 1` と `1 1 4294967294` に割る理由は誰にも分からない。
- 取り込むべきでない条件: 二段マッピングは、単一ユーザー・単一 namespace で済む用途には持ち込むべきでない。Podman の docs がこの説明に多くの紙面を割いていること自体が、その複雑さの証拠だ。

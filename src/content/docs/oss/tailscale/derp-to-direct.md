---
title: "リレー経由から直結へ昇格する瞬間"
description: "最初のパケットは DERP を通る。同時に両側が候補アドレスへ ping を撒き、DERP 越しに「今送ったよ」と伝え合う。どちらかの Pong が返ってきた瞬間、その経路が bestAddr になり、以降のパケットは DERP を通らない。切り替えは 1 行の代入で、切り替わったことは ring buffer に記録される。"
group: "NAT 越え"
sidebar:
  order: 15
---

## 何を学んだか

### 通信は必ず DERP から始まる

新しいピアにパケットを送るとき、直結の経路はまだ分かっていない。だから **最初のパケットは [DERP](../derp/) を通る**。同時に、直結の探索が始まる。

順序はこうだ。

1. アプリケーションがパケットを送る → 送り先の `endpoint` に `bestAddr` がない
2. DERP へ送る (パケットは届く。通信は最初から成立している)
3. 同時に、相手の候補アドレス全部へ [disco Ping](../disco-protocol/) を撒く
4. DERP 経由で `CallMeMaybe` を送る — 「今 UDP を送った。そっちからも送って」
5. 相手も同じことをする
6. どちらかの Ping が通り、Pong が返る
7. **その経路が `bestAddr` になる。以降 DERP を通らない**

**ユーザーから見ると、通信は最初から成立していて、途中で速くなる。** 接続の確立を待つ段階が存在しない。

### 昇格の判断は Pong を受けた場所で行う

`Pong` を受け取った時点で、その経路の遅延が分かる。[betterAddr](../endpoint-selection/) が現在の `bestAddr` より良いと判定すれば、そこで差し替える。

**差し替えは代入 1 個だが、その前後に記録が入る。** `debugUpdates` というリングバッファに「いつ、なぜ、どこからどこへ変わったか」が積まれる。

### CallMeMaybe を受けたら、レート制限を破って ping する

通常、同じアドレスへの ping には最小間隔がある。だが `CallMeMaybe` を受け取ったときは、**全候補の `lastPing` をゼロにして、間隔を無視して ping し直す**。

理由はコメントに書かれている。「最初の ping はおそらくファイアウォールを通らなかったから」。相手が今まさに UDP を送ってきたなら、**今が通る瞬間**だ。

## ソースコードのどこか

### 探索の開始と CallMeMaybe

```go title="wgengine/magicsock/endpoint.go"
func (de *endpoint) sendDiscoPingsLocked(now mono.Time, sendCallMeMaybe bool) {
	...
	de.lastFullPing = now
	var sentAny bool
	for ep, st := range de.endpointState {
		if st.shouldDeleteLocked() {
			de.deleteEndpointLocked("sendPingsLocked", ep)
			continue
		}
		...
		if !st.lastPing.IsZero() && now.Sub(st.lastPing) < discoPingInterval {
			continue
		}
		firstPing := !sentAny
		sentAny = true
		...
		de.startDiscoPingLocked(epAddr{ap: ep}, now, pingDiscovery, 0, nil)
	}
	derpAddr := de.derpAddr
	if sentAny && sendCallMeMaybe && derpAddr.IsValid() {
		// Have our magicsock.Conn figure out its STUN endpoint (if
		// it doesn't know already) and then send a CallMeMaybe
		// message to our peer via DERP informing them that we've
		// sent so our firewall ports are probably open and now
		// would be a good time for them to connect.
		go de.c.enqueueCallMeMaybe(derpAddr, de)
	}
}
```

[`endpoint.go#L1401-L1437`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/magicsock/endpoint.go#L1401-L1437)。

**順序が重要だ。** 全候補への ping を **先に** 送り、その後で `CallMeMaybe` を DERP に流す。

ping が先に出ることで、自分側の NAT とファイアウォールにマッピングが作られる。`CallMeMaybe` はその事実を相手に伝える。相手が送り返してきたパケットは、**さっき作られたマッピングを通って自分に届く**。

**逆順だと成立しない。** 相手が先に送ってきても、自分の NAT にマッピングがなければ落とされる。

`sentAny` のチェックもある。**1 個も ping を送らなかった (全部レート制限に引っかかった) 場合は、CallMeMaybe を送らない。** 送っても相手が返してくるパケットを受け取れない。

### CallMeMaybe を受け取った側

```go title="wgengine/magicsock/endpoint.go"
// handleCallMeMaybe handles a CallMeMaybe discovery message via
// DERP. The contract for use of this message is that the peer has
// already sent to us via UDP, so their stateful firewall should be
// open. Now we can Ping back and make it through.
func (de *endpoint) handleCallMeMaybe(m *disco.CallMeMaybe) {
	...
	for ep := range de.isCallMeMaybeEP {
		de.isCallMeMaybeEP[ep] = false // mark for deletion
	}
	var newEPs []netip.AddrPort
	for _, ep := range m.MyNumber {
		if ep.Addr().Is6() && ep.Addr().IsLinkLocalUnicast() {
			// We send these out, but ignore them for now.
			continue
		}
		mak.Set(&de.isCallMeMaybeEP, ep, true)
		if es, ok := de.endpointState[ep]; ok {
			es.callMeMaybeTime = now
		} else {
			de.endpointState[ep] = &endpointState{callMeMaybeTime: now}
			newEPs = append(newEPs, ep)
		}
	}
	...
	// Delete any prior CallMeMaybe endpoints that weren't included
	// in this message.
	for ep, want := range de.isCallMeMaybeEP {
		if !want {
			delete(de.isCallMeMaybeEP, ep)
			de.deleteEndpointLocked("handleCallMeMaybe", ep)
		}
	}

	// Zero out all the lastPing times to force sendPingsLocked to send new ones,
	// even if it's been less than 5 seconds ago.
	for _, st := range de.endpointState {
		st.lastPing = 0
	}
	monoNow := mono.Now()
	de.sendDiscoPingsLocked(monoNow, false)
```

[`endpoint.go#L2028-L2098`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/magicsock/endpoint.go#L2028)。

3 つの処理が入っている。

**1. マーク&スイープで候補を更新する。** 既存の CallMeMaybe 由来の候補を全部「削除予定」にし、今回のメッセージに入っているものを「生存」に戻し、残りを消す。**メッセージが候補の完全なリストを表す** という前提で、差分ではなく置き換えとして扱っている。

**2. リンクローカル IPv6 は無視する。** 「送ってはいるが、今は無視する。TODO: 全インターフェースで ping するようにコードを教える」。リンクローカルアドレスはインターフェースごとに意味が変わるので、どのインターフェースから送るかを決める仕組みが要る。**送信側は先に対応し、受信側は後回しになっている。**

**3. レート制限をリセットする。** `lastPing = 0` にして、間隔を無視して即座に ping する。

そして最後の引数に注目すると、`sendDiscoPingsLocked(monoNow, false)` — **CallMeMaybe を受け取った側は、CallMeMaybe を送り返さない**。送り返すと無限に往復する。

### 昇格

```go title="wgengine/magicsock/endpoint.go"
	// Promote this pong response to our current best address if it's lower latency.
	if !isDerp {
		thisPong := addrQuality{
			epAddr:  sp.to,
			latency: latency,
			wireMTU: pingSizeToPktLen(sp.size, sp.to),
		}
		bestUntrusted := now.After(de.trustBestAddrUntil)
		if betterAddr(thisPong, de.bestAddr) || bestUntrusted {
			de.c.logf("magicsock: disco: node %v %v now using %v mtu=%v tx=%x", de.publicKey.ShortString(), de.discoShort(), sp.to, thisPong.wireMTU, m.TxID[:6])
			de.debugUpdates.Add(EndpointChange{
				When: time.Now(),
				What: "handlePongConnLocked-bestAddr-update",
				From: de.bestAddr,
				To:   thisPong,
			})
			de.setBestAddrLocked(thisPong)
		}
		if de.bestAddr.epAddr == thisPong.epAddr {
			de.debugUpdates.Add(EndpointChange{
				When: time.Now(),
				What: "handlePongConnLocked-bestAddr-latency",
				From: de.bestAddr,
				To:   thisPong,
			})
			de.bestAddr.latency = latency
			de.bestAddrAt = now
			de.trustBestAddrUntil = now.Add(trustUDPAddrDuration)
		}
	}
```

[`endpoint.go#L1872-L1902`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/magicsock/endpoint.go#L1872)。

**昇格の条件が 2 つある。**

- `betterAddr(thisPong, de.bestAddr)` — 単に良い経路
- `bestUntrusted` — **現在の bestAddr の信頼期限が切れている**

2 つ目が効くのは、現在の経路が壊れたときだ。[betterAddr は時間による信頼を考慮しない](../endpoint-selection/)ので、「遅いが生きている経路」が「速いが死んだ経路」に負けてしまう。期限切れなら無条件で乗り換える。

**2 つ目の `if` は、昇格しなかった場合にも実行される。** 同じアドレスへの Pong なら、遅延を更新して信頼期限を延ばす。これが [ハートビート](../endpoint-selection/)の効果で、3 秒ごとの ping が 6.5 秒の期限を延長し続ける。

### 変更を記録する

```go title="wgengine/magicsock/endpoint.go"
			de.debugUpdates.Add(EndpointChange{
				When: time.Now(),
				What: "handlePongConnLocked-bestAddr-update",
				From: de.bestAddr,
				To:   thisPong,
			})
```

`debugUpdates` は `*ringlog.RingLog[EndpointChange]` で、`endpoint` 構造体の先頭付近に置かれている。

**経路が変わるたびに、変更前・変更後・理由・時刻を固定長のリングバッファに積む。** `What` の値は `"handlePongConnLocked-bestAddr-update"` のように **関数名を含む文字列** で、どのコードパスが変更したかが後から分かる。

これは [なぜ繋がらないのかを説明する](../reachability-observability/) 仕組みの一部で、`tailscale debug` から取り出せる。

### 経路の型

```go title="wgengine/magicsock/endpoint.go"
// epAddr is a [netip.AddrPort] with an optional Geneve header (RFC8926)
// [packet.VirtualNetworkID].
type epAddr struct {
	ap  netip.AddrPort          // if ap == tailcfg.DerpMagicIPAddr then vni is never set
	vni packet.VirtualNetworkID // vni.IsSet() indicates if this [epAddr] involves a Geneve header
}

// isDirect returns true if e.ap is valid and not tailcfg.DerpMagicIPAddr,
// and a VNI is not set.
func (e epAddr) isDirect() bool {
	return e.ap.IsValid() && e.ap.Addr() != tailcfg.DerpMagicIPAddr && !e.vni.IsSet()
}

// addrQuality is an [epAddr], an optional [key.DiscoPublic] if a relay server
// is associated, a round-trip latency measurement, and path mtu.
type addrQuality struct {
	epAddr
	relayServerDisco key.DiscoPublic
	latency          time.Duration
	wireMTU          tstun.WireMTU
}
```

[`endpoint.go#L1905-L1932`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/wgengine/magicsock/endpoint.go#L1905)。

**3 種類の経路が 1 つの型で表現されている。**

| 経路                              | `ap`                      | `vni`    |
| --------------------------------- | ------------------------- | -------- |
| 直結                              | 実際の IP:port            | 未設定   |
| DERP 経由                         | `127.3.3.40:リージョンID` | 未設定   |
| [peer relay](../peer-relay/) 経由 | リレーの IP:port          | 設定済み |

[DerpMagicIP](../netmap/) の偽装が、ここでも効いている。`isDirect()` という 1 つの述語で「本当の直結か」を判定できる。

`addrQuality` は経路に「遅延」と「MTU」を添えた型だ。**経路の同一性 (`epAddr`) と、経路の品質 (`addrQuality`) が型として分かれている。** 比較するのは品質、記録するのは同一性。

## なぜそうなっているか

### なぜ最初から DERP を使うのか

**接続の確立を待たせないため** だ。

もし「まず直結を試して、駄目なら DERP」だと、直結が成立するかどうか分かるまで数百 ms から数秒かかる。その間パケットは出せない。ユーザーには「繋がらない」時間として見える。

DERP は常時接続されているので、**最初のパケットは即座に送れる**。直結はバックグラウンドで探せばよく、見つかったら黙って切り替わる。

**「遅いが確実な経路」を先に使い、「速いが不確実な経路」を裏で探す。** これは「速い経路を試して駄目なら遅い経路」の逆で、ユーザー体験としては圧倒的に良い。

### なぜ両側から同時に送る必要があるのか

NAT とステートフルファイアウォールは、**内から外へのパケットを見て、その応答を通す状態を作る**。

A と B が両方 NAT の内側にいるとき、

- A → B のパケットは、A の NAT を通り、B の NAT で落とされる (B は A に送ったことがない)
- B → A のパケットは、B の NAT を通り、A の NAT を通る (A はさっき B に送った)

つまり **A が先に送っておけば、B からのパケットが通る**。逆も同様なので、両方が「相手に送った」状態を作れば、双方向に通る。

`CallMeMaybe` は「私は送った。だからあなたも送って」という合図だ。**DERP という別経路がないと、この合図自体を送れない。**

### なぜ CallMeMaybe を送り返さないのか

受け取った側も `CallMeMaybe` を送り返すと、相手がまた送り返し、無限ループになる。

そもそも受け取った側は **送り返す必要がない**。「相手が送ってきた」ことは既に分かっており、自分が ping を送れば相手の NAT を通る。合図は片方向で足りる。

送信側の呼び出しは `sendDiscoPingsLocked(now, true)`、受信側は `sendDiscoPingsLocked(monoNow, false)`。**同じ関数の引数 1 個で「合図を送るか」を切り替えている。**

### なぜレート制限をリセットするのか

ping には最小間隔がある。同じアドレスに毎秒何十発も撃つのを防ぐためだ。

だが `CallMeMaybe` を受け取った瞬間は特別だ。**相手のファイアウォールがたった今開いた**。前回の ping はおそらく閉じたファイアウォールに当たって消えている。ここで「まだ 5 秒経っていないから」と待つと、**開いた窓を逃す**。

NAT のマッピングは短命 (30 秒程度) なので、タイミングを逃すコストは大きい。**レート制限の目的は「無駄なパケットを減らす」ことで、無駄でないと分かっているなら例外にしてよい。**

### なぜ信頼期限切れで無条件に乗り換えるのか

`betterAddr` は遅延とアドレス種別で比較するが、**「その経路が今も生きているか」は見ていない**。

現在の `bestAddr` が LAN の 1 ms で、その経路が切れた (LAN から離れた) 場合を考える。新しく見つかった WAN 経由の経路は 30 ms なので、`betterAddr` では負ける。しかし LAN の経路はもう使えない。

**期限切れは「その経路はもう信用できない」という情報** なので、比較を飛ばして乗り換える。**品質の比較と、生存の確認は別の軸** だという整理になっている。

### なぜ変更をリングバッファに記録するのか

経路の切り替えは自動で、ユーザーからは見えない。「さっきまで速かったのに遅くなった」という報告を受けたとき、**その瞬間に何が起きたかを知る手段が要る**。

ログに出す手もあるが、経路変更は頻繁に起きるのでログが溢れる。リングバッファなら **固定メモリで直近の履歴だけを保持** でき、必要なときだけ吸い出せる。

`What` フィールドに関数名を入れているのが実用的だ。同じ「bestAddr が変わった」でも、Pong 由来なのか、[relay の確立](../peer-relay/)由来なのか、[netmap の更新](../netmap-apply/)由来なのかで、調べるべき場所が違う。

## どう活かすか

**「確実だが遅い経路」を先に使い、「速いが不確実な経路」を裏で探して昇格させる。** 逆順にすると、確立を待つ時間がユーザーに見える。フォールバックがある系では、フォールバックを既定にして最適化を裏で走らせるほうが体験がよい。データベースのレプリカ選択、CDN のオリジン切り替え、キャッシュのウォームアップにも当てはまる。

**双方向の合意が要る操作は、片方が「やった」と伝えるだけで足りることが多い。** 両側から確認を送り合うと往復が増え、ループの危険が出る。`CallMeMaybe` は片方向で、受け手は返信しない。同じ関数の引数 1 個で送信の有無を切り替えるのは、実装として素直だ。

**レート制限には例外を作ってよい。** 制限の目的が「無駄を減らす」なら、無駄でないと分かっている瞬間 (相手が今アクションを起こした) は例外にする。ただし例外の条件は「外部からのイベント」に限定し、自分の都合で緩めない。

**「品質の比較」と「生存の確認」は別の軸として扱う。** 比較関数に生存を混ぜると、死んだ最良候補が勝ち続ける。「期限切れなら無条件で乗り換える」を比較の外側に置くと、両方の性質が保たれる。

**自動で切り替わるものは、切り替えの履歴を固定長バッファに残す。** ログに出すと溢れ、出さないと調査できない。リングバッファは、その中間として実用的だ。**変更の理由に、変更したコードパスの名前を入れる** と、調査の起点になる。

**同じ抽象の下に複数の経路種別を収めるなら、値空間の一部を特別扱いするのは有効。** `127.3.3.40:N` で DERP を表現し、`vni` の有無でリレーを区別する。判定は `isDirect()` の 1 メソッドに閉じる。

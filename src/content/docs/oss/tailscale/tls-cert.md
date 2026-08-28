---
title: "ノードが自分で TLS 証明書を取る"
description: "*.ts.net の証明書を Let's Encrypt から取る。DNS-01 のチャレンジは control server が代行し、funnel が有効なら TLS-ALPN-01 も使える。更新時期は ACME の Renewal Information に聞き、答えられなければ「有効期間の 2/3 を過ぎたら」に落ちる。"
group: "その上に載るもの"
sidebar:
  order: 39
---

## 何を学んだか

### ブラウザが警告を出さない HTTPS

[serve](../serve-funnel/) で `https://myhost.tailnet.ts.net/` を公開したとき、**ブラウザが証明書の警告を出さない**。

これは Tailscale が **Let's Encrypt から本物の証明書を取得している** からだ。`*.ts.net` は Tailscale が管理するドメインなので、その配下のサブドメインに対して証明書を発行できる。

### チャレンジの 2 方式

ACME でドメインの所有を証明する方法として、Tailscale は 2 つを使う。

| 方式            | 条件                | 仕組み                                                            |
| --------------- | ------------------- | ----------------------------------------------------------------- |
| **DNS-01**      | 常に使える          | control server が `_acme-challenge.*` の TXT レコードを立てる     |
| **TLS-ALPN-01** | funnel が有効なとき | 443 番で特殊な ALPN プロトコルの TLS 接続を受け、証明書で応答する |

**ノードは自分のドメインの DNS を操作できない。** `_acme-challenge.myhost.tailnet.ts.net` の TXT レコードを立てられるのは Tailscale の DNS サーバだけだ。だから **control server にチャレンジの応答を依頼する**。

### 更新のタイミングは ACME サーバに聞く

証明書をいつ更新するかは、伝統的に「有効期限の N 日前」で決めていた。

現在は **ARI (ACME Renewal Information)** という仕組みがあり、**ACME サーバが「この証明書はこの時間帯に更新してほしい」と答える**。

Tailscale は ARI を優先し、**失敗したら「有効期間の 2/3 を過ぎたら」にフォールバックする**。

### 機能ごと落とせる

証明書の機能は `feature/acme` パッケージにあり、**フックで本体に差し込まれる**。`ts_omit_acme` を付けてビルドすれば、ACME のコードごとバイナリから消える。

## ソースコードのどこか

### フックによる分離

```go title="ipn/ipnlocal/cert.go"
// errNoCerts is returned by the wrapper methods below when ACME/cert
// support is not compiled into this build.
var errNoCerts = errors.New("cert support not compiled in this build")

// Hooks installed by the feature/acme package at init time. In builds
// without ACME support (js or ts_omit_acme), feature/acme is not linked
// in and these hooks remain unset; the wrapper methods below then
// behave as no-ops or return errNoCerts.
var (
	// HookGetCertPEM implements [LocalBackend.GetCertPEMWithValidity].
	HookGetCertPEM feature.Hook[func(ctx context.Context, b *LocalBackend, domain string, minValidity time.Duration) (*TLSCertKeyPair, error)]

	// HookGetACMETLSALPNCert returns the ACME tls-alpn-01 challenge
	// certificate for hi, if any.
	HookGetACMETLSALPNCert feature.Hook[func(b *LocalBackend, hi *tls.ClientHelloInfo) (*tls.Certificate, bool)]
	...
	// HookUpdateCertRefreshLoop is called when [LocalBackend]'s state
	// or serve config changes, so the cert refresh loop can be
	// (re)started or stopped. It is invoked with b.mu held.
	HookUpdateCertRefreshLoop feature.Hook[func(b *LocalBackend, state ipn.State, sc ipn.ServeConfigView)]
```

[`cert.go#L19-L45`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/ipn/ipnlocal/cert.go#L19-L45)。

**フックが 7 つある。** 証明書の取得、ALPN チャレンジの応答、更新ループの開始・停止、[c2n](../c2n/) のハンドラ。

各フックのコメントに **「いつ呼ばれるか」「どんなロックを持って呼ばれるか」** が書かれている。`HookUpdateCertRefreshLoop` は `b.mu` を持った状態で呼ばれる — **フックの実装がそのロックを取ろうとするとデッドロックする。**

**機能を分離するときの契約が、フックの宣言に集まっている。** [ビルドタグのページ](../build-tags/) で扱う仕組みの実例だ。

### 更新時期の決定

```go title="feature/acme/cert.go"
// shouldStartDomainRenewal reports whether the domain's cert should be
// renewed based on the current time, the cert's expiry, and the ARI
// check.
func (e *extension) shouldStartDomainRenewal(...) (bool, error) {
	if minValidity != 0 {
		cert, err := parseCertificate(pair)
		...
		return cert.NotAfter.Sub(now) < minValidity, nil
	}
	e.renewMu.Lock()
	defer e.renewMu.Unlock()
	if renewAt, ok := e.renewCertAt[domain]; ok {
		return now.After(renewAt), nil
	}

	renewTime, err := e.domainRenewalTimeByARI(b, cs, pair)
	if err != nil {
		// Log any ARI failure and fall back to checking for renewal by expiry.
		b.Logger()("acme: ARI check failed: %v; falling back to expiry-based check", err)
		renewTime, err = domainRenewalTimeByExpiry(pair)
		if err != nil {
			return false, err
		}
	}

	mak.Set(&e.renewCertAt, domain, renewTime)
	return now.After(renewTime), nil
}
```

[`cert.go#L170-L199`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/feature/acme/cert.go#L170-L199)。

**3 段階の判定。**

1. **呼び出し側が最低有効期間を指定した** → その期間を切っているか
2. **既に更新時刻を計算済み** → キャッシュを使う
3. **未計算** → ARI に聞く、失敗したら期限から計算する

**ARI の結果をキャッシュする**のが重要だ。ARI は ACME サーバへの HTTP リクエストなので、証明書を使うたびに聞くわけにはいかない。1 回聞いて `renewCertAt` に保存する。

### ARI に聞く

```go title="feature/acme/cert.go"
func (e *extension) domainRenewalTimeByARI(b *ipnlocal.LocalBackend, cs certStore, pair *ipnlocal.TLSCertKeyPair) (time.Time, error) {
	...
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ri, err := ac.FetchRenewalInfo(ctx, blocks[0].Bytes)
	if err != nil {
		return time.Time{}, fmt.Errorf("failed to fetch renewal info from ACME server: %w", err)
	}
	...
	// Select a random time in the suggested window and renew if that time has
	// passed. Time is randomized per recommendation in
	// https://datatracker.ietf.org/doc/draft-ietf-acme-ari/
```

[`cert.go#L306-L336`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/feature/acme/cert.go#L306)。

**ARI は「更新すべき時間帯 (window)」を返す。** その中からランダムに 1 点を選ぶ。

理由は draft の仕様に書かれている — **全クライアントが window の開始時刻に一斉に更新すると、ACME サーバに負荷が集中する**。ランダムに散らせば平準化される。

[DERP のキープアライブ](../derp/)、[DNS フォールバックのシャッフル](../dns-bootstrap/) と同じ、**「多数のクライアントの同期を避ける」** 設計になっている。

そして **ARI は Let's Encrypt が緊急で証明書を失効させる必要があるときにも使える**。「この証明書は今すぐ更新して」と返せば、クライアントが自発的に更新する。**証明書の失効 (CRL、OCSP) より実効性が高い仕組み** として設計されている。

### フォールバックの計算

```go title="feature/acme/cert.go"
func domainRenewalTimeByExpiry(pair *ipnlocal.TLSCertKeyPair) (time.Time, error) {
	cert, err := parseCertificate(pair)
	...
	certLifetime := cert.NotAfter.Sub(cert.NotBefore)
	if certLifetime < 0 {
		return time.Time{}, fmt.Errorf("negative certificate lifetime %v", certLifetime)
	}

	// Per https://github.com/tailscale/tailscale/issues/8204, check
	// whether we're more than 2/3 of the way through the certificate's
	// lifetime, which is the officially-recommended best practice by Let's
	// Encrypt.
	renewalDuration := certLifetime * 2 / 3
	renewAt := cert.NotBefore.Add(renewalDuration)
	return renewAt, nil
}
```

[`cert.go#L233-L251`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/feature/acme/cert.go#L233-L251)。

**「有効期限の N 日前」ではなく「有効期間の 2/3」で計算する。**

Let's Encrypt の証明書は 90 日だが、**将来短くなる可能性がある** (業界の議論では 45 日、さらに短くという方向)。「30 日前」と書くと、45 日の証明書では「発行直後から更新対象」になってしまう。

**割合で計算すれば、有効期間が変わっても正しく動く。**

`certLifetime < 0` の検査は、**`NotBefore` が `NotAfter` より後という壊れた証明書** への対処だ。負の値で計算すると、`renewAt` が過去になり、無限に更新を繰り返す。

### 更新の重複を防ぐ

```go title="feature/acme/cert.go"
// beginAsyncRenewal marks a domain as having an async renewal in flight,
// and reports whether this caller started it.
//
// The caller must arrange for endAsyncRenewal(domain) when the renewal
// finishes, regardless of result.
func (e *extension) beginAsyncRenewal(domain string) bool {
	e.renewMu.Lock()
	defer e.renewMu.Unlock()
	if e.renewingCertDomains.Contains(domain) {
		...
```

[`cert.go#L207-L215`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/feature/acme/cert.go#L207-L215)。

**「更新中のドメイン」の集合を持ち、二重に始めない。**

証明書は複数の場所から要求される — HTTP のリクエストごと、[serve](../serve-funnel/) の設定変更時、定期的な更新ループ。**同時に更新を始めると、ACME サーバへのリクエストが重複し、レート制限に当たる。**

戻り値が「この呼び出しが開始したか」なので、**呼び出し側は `if beginAsyncRenewal(d) { defer endAsyncRenewal(d); ... }` と書ける**。

コメントの **「結果に関わらず、終わったら `endAsyncRenewal` を呼ぶよう手配せよ」** が、契約を明示している。失敗時に呼び忘れると、**そのドメインは二度と更新されなくなる**。

### ロック順序の宣言

```go title="feature/acme/acme.go"
	// renewMu guards renewCertAt and renewingCertDomains.
	// Lock order: per-domain lock before renewMu.
	renewMu     syncs.Mutex
	renewCertAt map[string]time.Time // lazily initialized under renewMu

	// renewingCertDomains tracks domains for which an async renewal is
	// in progress.
	renewingCertDomains set.Set[string]
```

[`acme.go#L86-L93`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/feature/acme/acme.go#L86-L93)。

**「ロック順序: ドメインごとのロック → renewMu」** がフィールドのコメントに書かれている。

ロックが 2 種類ある。

- **ドメインごとのロック** — 同じドメインの証明書取得を直列化する
- **`renewMu`** — 更新の状態 (マップと集合) を守る

**順序を逆にするとデッドロックする。** Go にはロック順序を検査する仕組みがないので、**宣言の場所にコメントを書くのが唯一の防御**になる。

### チャレンジ方式の選択

```go title="feature/acme/cert.go"
func (e *extension) shouldUseACMETLSALPN01(b *ipnlocal.LocalBackend, domain string, previous *ipnlocal.TLSCertKeyPair, logf logger.Logf) bool {
	if isWildcardDomain(domain) {
		logf("acme: using dns-01: tls-alpn-01 does not support wildcard certificates")
		return false
	}
	if !b.HasFunnelForHostPort(domain, 443) {
```

[`cert.go#L253-L258`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/feature/acme/cert.go#L253-L258)。

**TLS-ALPN-01 が使える条件が 2 つある。**

- **ワイルドカード証明書ではない** — ACME の仕様上、ワイルドカードは DNS-01 でしか取れない
- **443 番で funnel が有効** — ACME サーバがインターネットから接続できる必要がある

条件を満たさなければ DNS-01 に落ちる。**そしてその理由をログに出す** — 「なぜ遅いほうの方式が使われているか」が分かる。

### ALPN チャレンジの応答

```go title="feature/acme/cert.go"
// getACMETLSALPNCert returns the short-lived ACME challenge certificate
// for hi.ServerName. The ok result reports whether hi offered acme-tls/1
// and an ACME order is actively waiting on that challenge for
// hi.ServerName.
func (e *extension) getACMETLSALPNCert(hi *tls.ClientHelloInfo) (cert *tls.Certificate, ok bool) {
	if hi == nil || hi.ServerName == "" || !slices.Contains(hi.SupportedProtos, xacme.ALPNProto) {
		return nil, false
	}
	cert, ok = e.pendingACMETLSALPNCerts.Load(hi.ServerName)
	return cert, ok
}
```

[`cert.go#L22-L32`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/feature/acme/cert.go#L22-L32)。

**TLS-ALPN-01 は、「特殊な証明書を返す」ことで所有を証明する。**

ACME サーバが `acme-tls/1` という ALPN プロトコルを指定して TLS 接続してくる。サーバは **チャレンジの値を埋め込んだ自己署名証明書** を返す。それが一致すれば、そのドメインを制御していると認められる。

**通常の TLS ハンドラの中に、チャレンジ用の分岐を入れるだけで実装できる。** 別のポートも、別のサーバも要らない。

`pendingACMETLSALPNCerts` は **進行中のチャレンジだけを持つ**。チャレンジが終われば消える。「今まさに待っているものだけ」という状態が、`ok` の戻り値に表れている。

## なぜそうなっているか

### なぜノードが自分で証明書を取るのか

Tailscale が中央で証明書を発行し、ノードに配ることもできた。だが、

- **秘密鍵が中央を通る**。Tailscale がユーザーの TLS 秘密鍵を持つことになる
- **配布の仕組みが要る**。netmap に載せる? 大きい
- **更新のたびに配り直す**

ノードが自分で取れば、**秘密鍵はそのノードから出ない**。[control server がパケットを見ない](../architecture/) のと同じ思想だ。

control server がやるのは **DNS-01 チャレンジの代行だけ**。TXT レコードを立てるのに秘密鍵は要らない。

### なぜ DNS-01 が主で、TLS-ALPN-01 が従なのか

**DNS-01 は常に使える。** ノードがインターネットから到達可能である必要がない。NAT の内側のノートパソコンでも証明書が取れる。

**TLS-ALPN-01 は、ACME サーバが 443 番に接続できる必要がある。** [funnel](../serve-funnel/) が有効なときだけ成立する。

だが TLS-ALPN-01 にも利点がある。

- **control server を経由しない**。Tailscale のインフラに依存しない
- **DNS の伝播を待たない**。DNS-01 は TXT レコードが伝播するまで待つ必要がある

**「常に使えるが遅い方式」と「速いが条件付きの方式」を両方実装し、条件を満たせば速いほうを使う。** [netstack と TUN](../netstack/)、[OS の split DNS と quad-100](../split-dns/) と同じ構造だ。

### なぜ ARI に聞くのか

「有効期限の 30 日前に更新する」は長年の慣行だったが、問題がある。

- **更新が期限に紐づくので、発行が集中すると更新も集中する**
- **CA が緊急に証明書を入れ替えたいとき、伝える手段がない** (失効しても、クライアントは更新のタイミングを変えない)

ARI は **CA が「いつ更新してほしいか」をクライアントに伝える** 仕組みだ。

- 通常時は、負荷を平準化する時間帯を返す
- **緊急時 (鍵の漏洩、CA の不正発行) は「今すぐ」を返す**

**「CA が主導権を持てる」ことが本質的な改善だ。** 数百万の証明書を短期間で入れ替える必要が生じたとき、クライアントの協力が得られる。

Tailscale が ARI を実装しているのは、**この協調に参加するため** でもある。

### なぜ更新を割合で計算するのか

証明書の有効期間は短くなり続けている。

- かつて: 3 年、2 年
- 現在: 90 日 (Let's Encrypt)、398 日 (商用 CA の上限)
- 議論中: 45 日、さらに短く

**「期限の 30 日前」を固定値で書くと、有効期間が 45 日になった瞬間に破綻する。** 発行から 15 日で更新対象になり、そのうち「発行直後から更新対象」になる。

**割合 (2/3) なら、有効期間が何日でも比例して動く。** そして「2/3」は Let's Encrypt が推奨する値だ。

**時間に関する定数は、絶対値ではなく割合で持てないかを考える。** 環境が変わったときの耐性が違う。

### なぜ更新の重複を防ぐ必要があるのか

ACME サーバには **レート制限** がある。Let's Encrypt では「同じドメインへの証明書発行は週 5 回まで」といった制限がある。

証明書の要求は複数の経路から来る。

- HTTPS のリクエストが来たとき (`GetCertificate` コールバック)
- [serve](../serve-funnel/) の設定が変わったとき
- 定期的な更新ループ

**これらが同時に「更新が必要だ」と判断すると、3 回の発行要求が飛ぶ。** レート制限に当たると、**次に本当に必要になったときに発行できない**。

「更新中」の集合を持つのは、**外部サービスのレート制限を守るため** の典型的な対処だ。

### なぜロック順序をコメントに書くのか

Go には、ロックの取得順序を検査する仕組みがない (`go vet` も検出しない)。**デッドロックは実行時にしか現れず、しかも再現しにくい。**

複数のロックを持つコードでは、**「必ずこの順序で取る」という規約** が唯一の防御になる。そして規約は、**ロックの宣言の隣に書くのが最も見つけやすい**。

Tailscale のコードには、この種のコメントが多い。`LocalBackend` の `mu` にも「[`Conn.mu`、その後 `endpoint.mu`](../endpoint-selection/)」といった順序が書かれている。

**ロックが 2 つ以上あるなら、順序を書く。** これは規模に関係なく効く。

## どう活かすか

**秘密鍵は、それを使う場所から出さない。** 中央で発行して配るより、各ノードが自分で取得するほうが、鍵の露出面が小さい。中央がやるのは「所有の証明を代行する」ことだけに絞れる。

**「常に使えるが遅い方式」と「速いが条件付きの方式」を両方実装する。** そして **条件を満たさないときに、なぜ遅いほうを使うのかをログに出す**。ユーザーが「なぜ遅いのか」を調べられる。

**期間に関する閾値は、絶対値ではなく割合で持てないか考える。** 「期限の 30 日前」より「有効期間の 2/3」のほうが、環境の変化に耐える。**外部が決める値 (証明書の有効期間、トークンの寿命) に依存する閾値では、特に効く。**

**外部サービスのレート制限があるなら、「処理中」の集合を持って重複を防ぐ。** 複数の経路から同じ処理が要求される構造では、必ず重複が起きる。**戻り値を「この呼び出しが開始したか」にすると、呼び出し側が `defer` で後始末を書ける。**

**多数のクライアントが同じスケジュールで動く処理には、ランダム性を入れる。** ARI の window の中からランダムに選ぶ、キープアライブにジッタを入れる、リストをシャッフルする。**同期は必ず負荷の集中を招く。**

**ロックが 2 つ以上あるなら、取得順序を宣言の隣にコメントで書く。** コンパイラも vet も検査してくれない。デッドロックは再現しにくいので、事前の規約が唯一の防御になる。

**フックで機能を分離するなら、各フックに「いつ呼ばれるか」「どのロックを持って呼ばれるか」を書く。** 実装側がそのロックを取ろうとするとデッドロックする。**契約をフックの宣言に集める** と、実装者が見落としにくい。

**外部の仕様 (ARI、Let's Encrypt の推奨) に従うなら、その出典を URL でコメントに書く。** 「なぜランダムに選ぶのか」「なぜ 2/3 なのか」は、コードからは読めない。

---
title: "「繋がっていない」をユーザーに説明する状態機械"
description: "20 個の警告が、コード・タイトル・本文生成関数・重大度・依存関係・可視化までの待ち時間を持つ。ネットワークが落ちているなら「DERP に繋がらない」は表示しない — 依存を辿って、根本原因だけを見せる。壊れ始めた時刻は、再報告されても更新しない。"
group: "実装の作法"
sidebar:
  order: 45
---

## 何を学んだか

### 「繋がらない」の内訳を伝える

Tailscale が動かないとき、原因はさまざまだ。

- ネットワーク自体が落ちている
- ログインしていない
- [DERP](../derp/) に接続できない
- [IP forwarding が無効](../subnet-router-exit-node/)
- 証明書の期限が切れている
- 更新が必要

**ユーザーに見せるべきは「根本原因 1 つ」で、その結果として起きている症状ではない。**

`health` パッケージは、これを **Warnable (警告可能なもの)** の集合として管理する。20 個が定義されている。

### Warnable が持つもの

```go
type Warnable struct {
	Code                WarnableCode          // 一意の識別子
	Title               string                // 短い見出し
	Text                func(args Args) string // 本文を生成する関数
	Severity            Severity              // 重大度
	DependsOn           []*Warnable           // 依存する警告
	ImpactsConnectivity bool                  // 通信に影響するか
	TimeToVisible       time.Duration         // 表示するまでの待ち時間
}
```

### 依存関係で根本原因だけを見せる

`DependsOn` に列挙した警告が不健全なら、**この警告は「関係ない」として扱う**。

「ネットワークが落ちている」なら、「DERP に繋がらない」も「control に繋がらない」も当然だ。**それらを全部並べても、ユーザーは混乱するだけ。**

### 一瞬の異常は表示しない

`TimeToVisible` は「不健全な状態がこの時間続いたら表示する」。

ネットワークの瞬断で警告が出て、すぐ消える。**それを毎回ユーザーに見せると、警告の価値が下がる。**

### 壊れ始めた時刻は保持する

同じ警告が再度報告されても、**`BrokenSince` は最初の時刻のまま**。「5 秒前から壊れている」ではなく「3 分前から壊れている」と言える。

## ソースコードのどこか

### Warnable の定義

```go title="health/health.go"
type Warnable struct {
	// Code is a string that uniquely identifies this Warnable across the entire Tailscale backend,
	// and can be mapped to a user-displayable localized string.
	Code WarnableCode
	// Title is a string that the GUI uses as title for any message involving this Warnable. The title
	// should be short and fit in a single line.
	Title string
	// Text is a function that generates an extended string that the GUI will display to the user when
	// this Warnable is in an unhealthy state. The function can use the Args map to provide dynamic
	// information to the user.
	Text func(args Args) string
	// Severity is the severity of the Warnable, which the GUI can use to determine how to display it.
	// For instance, a Warnable with SeverityHigh could trigger a modal view, while a Warnable with
	// SeverityLow could be displayed in a less intrusive way.
	Severity Severity
	// DependsOn is a set of Warnables that this Warnable depends on and need to be healthy
	// before this Warnable is relevant. The GUI can use this information to ignore
	// this Warnable if one of its dependencies is unhealthy.
	// That is, if any of these Warnables are unhealthy, then this Warnable is not relevant
	// and should be considered healthy to bother the user about.
	DependsOn []*Warnable
	...
	// ImpactsConnectivity is whether this Warnable in an unhealthy state will impact the user's
	// ability to connect to the Internet or other nodes on the tailnet. On platforms where
	// the client GUI supports a tray icon, the client will display an exclamation mark
	// on the tray icon when ImpactsConnectivity is set to true and the Warnable is unhealthy.
	ImpactsConnectivity bool

	// TimeToVisible is the Duration that the Warnable has to be in an unhealthy state before it
	// should be surfaced as unhealthy to the user. This is used to prevent transient errors from being
	// displayed to the user.
	TimeToVisible time.Duration
}
```

[`health.go#L285-L324`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/health/health.go#L285-L324)。

**各フィールドが「GUI がどう使うか」まで説明している。**

- `Code` は **ローカライズされた文字列にマップできる** — 多言語対応の前提
- `Title` は **1 行に収まる短さ** — UI の制約
- `Severity` は **`SeverityHigh` ならモーダル、`SeverityLow` なら控えめに**
- `ImpactsConnectivity` は **トレイアイコンに感嘆符を付ける**

**バックエンドのデータ構造が、UI の要求から設計されている。** 「警告を出す」だけでなく「どう見せるか」までがモデルに入っている。

`Text` が関数なのも要点だ。**動的な情報 (バージョン番号、エラーの内容) を埋め込める。**

### 実際の警告

```go title="health/warnings.go"
// NetworkStatusWarnable is a Warnable that warns the user that the network is down.
var NetworkStatusWarnable = condRegister(func() *Warnable {
	return &Warnable{
		Code:                tsconst.HealthWarnableNetworkStatus,
		Title:               "Network down",
		Severity:            SeverityMedium,
		Text:                StaticMessage("Tailscale cannot connect because the network is down. Check your Internet connection."),
		ImpactsConnectivity: true,
		TimeToVisible:       5 * time.Second,
	}
})
```

[`warnings.go#L63-L73`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/health/warnings.go#L63-L73)。

**メッセージが「原因」と「対処」の両方を含む。** 「ネットワークが落ちているので接続できません。**インターネット接続を確認してください。**」

`TimeToVisible: 5 * time.Second` — **5 秒未満のネットワーク断は表示しない。**

そしてプラットフォームで文面を変える例もある。

```go title="health/warnings.go"
		Text: func(args Args) string {
			if version.IsMacAppStore() || version.IsAppleTV() || version.IsMacSys() || version.IsWindowsGUI() || runtime.GOOS == "android" {
				return fmt.Sprintf("An update from version %s to %s is available.", args[ArgCurrentVersion], args[ArgAvailableVersion])
			} else {
				return fmt.Sprintf("An update from version %s to %s is available. Run `tailscale update` or `tailscale set --auto-update` to update now.", args[ArgCurrentVersion], args[ArgAvailableVersion])
			}
		},
```

[`warnings.go#L27-L33`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/health/warnings.go#L27-L33)。

**GUI があるプラットフォームでは、CLI のコマンドを案内しない。** Mac App Store 版では `tailscale update` が使えない (App Store 経由で更新する) ので、書いても混乱を招く。

**「同じ問題でも、環境によって対処法が違う」を、メッセージ生成関数で吸収している。**

### 依存関係

```go title="health/warnings.go"
		DependsOn: []*Warnable{NetworkStatusWarnable, IPNStateWarnable},
```

[`warnings.go#L128`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/health/warnings.go#L128)。

**20 個の警告のうち、8 個が `DependsOn` を持つ。** そのほとんどが `NetworkStatusWarnable` (ネットワークが落ちている) と `IPNStateWarnable` (ログインしていない) に依存する。

依存の意味は **「これらが不健全なら、この警告は関係ないので、ユーザーを煩わせるべきでない」**。

- ネットワークが落ちている → **DERP に繋がらないのは当然**
- ログインしていない → **netmap が来ないのは当然**

**因果関係をデータとして持つことで、「表示すべき警告」を絞り込める。**

これは監視システムの「アラートの抑制 (alert suppression)」と同じ考え方だ。**根本原因のアラートだけを出し、その結果のアラートは抑える。**

### 壊れた時刻を保持する

```go title="health/health.go"
func (t *Tracker) setUnhealthyLocked(w *Warnable, args Args) {
	if !buildfeatures.HasHealth || w == nil {
		return
	}

	// If we already have a warningState for this Warnable with an earlier BrokenSince time, keep that
	// BrokenSince time.
	brokenSince := t.now()
	if existingWS := t.warnableVal[w]; existingWS != nil {
		brokenSince = existingWS.BrokenSince
	}
```

[`health.go#L443-L453`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/health/health.go#L443-L453)。

**同じ警告が再報告されても、最初に壊れた時刻を保つ。**

これがないと、`SetUnhealthy` が定期的に呼ばれるたびに時刻が更新され、**「1 秒前から壊れている」としか言えなくなる**。

`TimeToVisible` の判定も壊れる。5 秒待つはずが、**1 秒ごとに再報告されると永久に表示されない**。

**「状態が継続している」ことを、時刻の保持で表現している。**

### 変化したときだけ通知する

```go title="health/health.go"
	prevWs := t.warnableVal[w]
	mak.Set(&t.warnableVal, w, ws)
	if !ws.Equal(prevWs) {
		change := Change{
			WarnableChanged: true,
			Warnable:        w,
			UnhealthyState:  w.unhealthyState(ws),
		}
		// Publish the change to the event bus. If the change is already visible
		// now, publish it immediately; otherwise queue a timer to publish it at
		// a future time when it becomes visible.
```

[`health.go#L462-L473`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/health/health.go#L462-L473)。

**状態が変わったときだけ [イベントバス](../eventbus/) に流す。**

そして **「今すぐ可視なら即座に発行、そうでなければタイマーで将来発行する」**。`TimeToVisible` の待ち時間を、通知の遅延として実装している。

**「5 秒後にまだ壊れていたら通知する」ではなく、「5 秒後に通知をスケジュールし、途中で直ったらキャンセルする」** という形だ。ポーリングが要らない。

### 機能ごと落とせる

```go title="health/warnings.go"
func condRegister(f func() *Warnable) *Warnable {
	if !buildfeatures.HasHealth {
		return nil
	}
	return f()
}
```

[`warnings.go#L10-L15`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/health/warnings.go#L10-L15)。

**[ビルドタグ](../build-tags/) で health 機能を外すと、Warnable が全部 `nil` になる。**

そして `SetUnhealthy` は `nil` の Warnable を受け取ると何もしない。

```go
func (t *Tracker) setUnhealthyLocked(w *Warnable, args Args) {
	if !buildfeatures.HasHealth || w == nil {
		return
	}
```

**呼び出し側は `if buildfeatures.HasHealth` で囲む必要がない。** `nil` を渡しても安全だ。

`condRegister` が関数を受け取るのも重要で、**機能が無効なら Warnable の構造体自体が構築されない**。文字列リテラルも `Text` のクロージャも、バイナリに含まれない可能性がある。

### control への報告

[long poll のページ](../map-longpoll/) で見たとおり、健全性の状態は **デバッグフラグとして control server に送られる**。

```go
	// MapDebugFlag is a MapRequest.DebugFlag that is sent to control when this Warnable is unhealthy
	//
	// Deprecated: this is only used in one case, and will be removed in a future PR
	MapDebugFlag string
```

[`health.go#L309-L312`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/health/health.go#L309-L312)。

**「1 箇所でしか使われておらず、将来の PR で削除する」** と明記されている。

**廃止予定を、削除の見込みとともに書く。** 「Deprecated」だけだと、いつ消えるか分からない。

## なぜそうなっているか

### なぜ「警告」を構造化するのか

素朴には、問題が起きたらログに書く。だが、

- **ユーザーはログを見ない**。GUI に表示する必要がある
- **多言語対応が要る**。文字列をコードに埋め込むと翻訳できない
- **重要度が違う**。「更新があります」と「接続できません」は同列にできない
- **因果関係がある**。1 つの原因が複数の症状を生む

**構造化すれば、これらを扱える。** `Code` で翻訳、`Severity` で表示方法、`DependsOn` で抑制。

そして **UI 側が判断できる**。「Severity が High ならモーダル」は GUI の実装で決められる。バックエンドは事実を報告するだけだ。

### なぜ依存関係で抑制するのか

Wi-Fi が切れたとき、Tailscale の内部では大量の異常が起きる。

- DERP への接続が切れる
- control への long poll が切れる
- ピアへの ping が失敗する
- DNS の設定が読めなくなる

**これを全部表示すると、5 個の警告が並ぶ。** ユーザーは「何が問題なのか」が分からない。

**根本原因は 1 つ「ネットワークが落ちている」** だ。それだけを見せれば、対処が分かる。

`DependsOn` は **「この警告は、これらが健全であって初めて意味を持つ」** という関係を表す。監視システムのアラート抑制と同じで、**因果のグラフを持つことで、表示すべきものを絞れる**。

### なぜ表示に遅延を入れるのか

ネットワークは一瞬途切れる。Wi-Fi のローミング、モバイルのハンドオーバー、スリープからの復帰。

**これらで毎回警告が出て消えると、警告そのものが信用されなくなる。** 「また出た、どうせすぐ消える」と学習される。

5 秒待って、まだ壊れているなら表示する。**一瞬の異常はユーザーに見えない。**

そして実装が **「タイマーで将来発行し、直ったらキャンセル」** なのが効いている。ポーリングだと、5 秒後に「まだ壊れているか」を確認する処理が要る。

### なぜ BrokenSince を保持するのか

**「いつから壊れているか」は、ユーザーにとって重要な情報** だ。

- 「10 秒前から」→ 待てば直るかも
- 「2 時間前から」→ 何か対処が要る

再報告のたびに時刻を更新すると、**常に「今壊れた」になる**。

そして `TimeToVisible` の判定にも使われる。**「壊れてから 5 秒経ったか」の起点が、最初の報告でなければならない。**

**「状態の開始時刻」と「最後の確認時刻」は別物** で、必要なのは前者だ。

### なぜ Text が関数なのか

静的な文字列だと、

- **動的な情報を含められない**。「バージョン 1.2 から 1.3 への更新」
- **プラットフォームで文面を変えられない**。「`tailscale update` を実行」は GUI 版では無意味

関数にすれば、`Args` から値を取り、環境を見て分岐できる。

そして **`StaticMessage` というヘルパーがある** ので、動的でない場合は簡潔に書ける。

```go
Text: StaticMessage("Tailscale cannot connect because the network is down. Check your Internet connection."),
```

**「一般形は関数、よくある場合はヘルパー」** という API 設計になっている。

### なぜエラーの文面に対処法を書くのか

「ネットワークが落ちています」だけでは、ユーザーは何をすればよいか分からない。

**「インターネット接続を確認してください」** まで書けば、次の行動が分かる。

そして **その行動が環境によって違う** なら、環境を見て文面を変える。CLI が使える環境では `tailscale update` を案内し、App Store 版では案内しない。

**エラーメッセージは「何が起きたか」だけでなく「どうすればよいか」を含む** — これはユーザー向けソフトウェアの基本だが、実装するには環境の情報が要る。

## どう活かすか

**ユーザーに見せる警告は、構造化されたデータとして持つ。** コード (翻訳のキー)、タイトル、本文の生成関数、重大度。文字列をログに書くだけだと、多言語化も、重要度による出し分けもできない。

**警告の因果関係をデータとして持ち、根本原因だけを表示する。** 1 つの障害が 5 つの症状を生むなら、5 つ全部を見せてはいけない。**依存のグラフがあれば、抑制が自動になる。**

**一過性の異常には、表示までの待ち時間を設ける。** すぐ消える警告が繰り返されると、警告全体が無視されるようになる。**「N 秒続いたら表示」を、タイマーとキャンセルで実装すればポーリングが要らない。**

**「状態が始まった時刻」を保持し、再報告で更新しない。** 「いつから壊れているか」はユーザーにとって重要で、待ち時間の判定の起点にもなる。**最後の確認時刻とは別に持つ。**

**バックエンドのデータ構造を、UI の要求から設計する。** 「Severity が High ならモーダル」「ImpactsConnectivity ならトレイに感嘆符」。UI がどう使うかをフィールドのコメントに書けば、両者の契約が明確になる。

**エラーメッセージには対処法を含め、環境によって変える。** 「更新があります」ではなく「`tailscale update` を実行してください」。ただし **そのコマンドが使えない環境では書かない**。メッセージを関数にすれば、環境を見て分岐できる。

**機能を無効化したときに `nil` を返す設計にすると、呼び出し側の分岐が要らなくなる。** `nil` を受け取る側が no-op になれば、`if enabled` が全呼び出し箇所から消える。

**廃止予定には、削除の見込みを書く。** 「Deprecated: 1 箇所でしか使われておらず、将来の PR で削除する」— いつ消えるかの見通しがあると、依存する側が判断できる。

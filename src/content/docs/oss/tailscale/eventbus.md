---
title: "疎結合のための内部イベントバス"
description: "型ごとの publish/subscribe を 1 プロセスの中で行う。全イベントに単一の順序があり、同じクライアント内では公開順に届く。だがクライアント間の同期は保証しない — 「あなたの今」と「相手の今」は違うと、ドキュメントが明示している。"
group: "実装の作法"
sidebar:
  order: 44
---

## 何を学んだか

### コンポーネント間の直接呼び出しを減らす

[LocalBackend](../architecture/) は多くのコンポーネントを束ねる。[magicsock](../magicsock/) が「ホーム DERP が変わった」を伝えたい、[netmon](../link-change/) が「ネットワークが変わった」を伝えたい。

素朴にはコールバックを渡す。だが **コールバックが増えると、誰が誰を呼ぶかが追えなくなる**。ロックの順序も絡む。

`util/eventbus` は、**型をキーにした publish/subscribe** をプロセス内で提供する。

```go
// 発行側
pub := eventbus.Publish[HomeDERPChanged](client)
pub.Publish(HomeDERPChanged{Region: 5})

// 購読側
sub := eventbus.Subscribe[HomeDERPChanged](client)
for {
	select {
	case ev := <-sub.Events():
		...
	case <-sub.Done():
		return
	}
}
```

### 順序の保証を形式的に書く

ドキュメントに **「並行性の性質」という節があり、保証を箇条書きで定義している**。

- イベントは `Publish` の呼び出しの開始と終了の間のある瞬間に発行される
- **2 つのイベントが同時に発行されることはない** ので、発行時刻で全順序が付く
- **同じクライアントの購読者には、発行順に届く**
- **クライアント間の同期はしない**

そして **平易な言い換え** が続く。

> 公開されたすべてのイベントには、1 つの真のタイムラインがある。クライアントを作って購読すれば、そのタイムラインと同じ順序で、1 つずつイベントを受け取る。購読していないイベントは「飛ばす」が、**あなたの世界の見方は常に前へ進み、後戻りはせず、他の全員と同じ順序でイベントを観測する**。

**だが「あなたの今」と「他のクライアントの今」は違う。**

### 遅い購読者は全体を止める

バスの内部バッファは **小さく固定** だ。購読者が受け取りを怠ると、**やがて全発行者がブロックする**。

そして **それは「遅い購読者のバグ」だと明言されている**。

### アクターモデルを勧める

> コードをテストしやすく理解しやすくするために、**アクターモデルに従った構造にすべきだ**。自分が権限を持つローカルな状態があり、プログラムの他の場所にある状態と関わる唯一の方法は、他から来るイベントを受け取って処理するか、自分のイベントを出すことだ。

## ソースコードのどこか

### 保証の記述

```go title="util/eventbus/doc.go"
// # Concurrency properties
//
// The bus serializes all published events across all publishers, and
// preserves that ordering when delivering to subscribers that are
// attached to the same Client. In more detail:
//
//   - An event is published to the bus at some instant between the
//     start and end of the call to [Publisher.Publish].
//   - Two events cannot be published at the same instant, and so are
//     totally ordered by their publication time. Given two events E1
//     and E2, either E1 happens before E2, or E2 happens before E1.
//   - Clients dispatch events to their Subscribers in publication
//     order: if E1 happens before E2, the client always delivers E1
//     before E2.
//   - Clients do not synchronize subscriptions with each other: given
//     clients C1 and C2, both subscribed to events E1 and E2, C1 may
//     deliver both E1 and E2 before C2 delivers E1.
```

[`doc.go#L27-L44`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/util/eventbus/doc.go#L27-L44)。

**「happens before」という語彙で保証を定義している。** これは並行プログラミングのメモリモデルの用語で、**曖昧さがない**。

そして最後の項目が重要だ。**「クライアント同士は同期しない」** — C1 が E1 と E2 を配り終えた時点で、C2 はまだ E1 も配っていないかもしれない。

**保証しないことを明示する** のが、この種のドキュメントで最も価値がある部分だ。

### 平易な言い換え

```go title="util/eventbus/doc.go"
// Less formally: there is one true timeline of all published events.
// If you make a Client and subscribe to events, you will receive
// events one at a time, in the same order as the one true
// timeline. You will "skip over" events you didn't subscribe to, but
// your view of the world always moves forward in time, never
// backwards, and you will observe events in the same order as
// everyone else.
//
// However, you cannot assume that what your client see as "now" is
// the same as what other clients. They may be further behind you in
// working through the timeline, or running ahead of you. This means
// you should be careful about reaching out to another component
// directly after receiving an event, as its view of the world may not
// yet (or ever) be exactly consistent with yours.
```

[`doc.go#L46-L59`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/util/eventbus/doc.go#L46-L59)。

**形式的な定義の後に、平易な言い換えを置く。** 「Less formally」という接続で、**同じことを 2 通りに書いている**。

そして **具体的な注意** に落とす。「イベントを受け取った直後に、他のコンポーネントを直接呼ぶのは慎重に。その世界の見方は、まだ (あるいは永遠に) あなたと一致していないかもしれない」。

**「保証の記述」から「使い方の指針」まで、ドキュメントが橋渡ししている。**

### 期待される購読者の振る舞い

```go title="util/eventbus/doc.go"
// # Expected subscriber behavior
//
// Subscribers are expected to promptly receive their events on
// [Subscriber.Events]. The bus has a small, fixed amount of internal
// buffering, meaning that a slow subscriber will eventually cause
// backpressure and block publication of all further events.
//
// In general, you should receive from your subscriber(s) in a loop,
// and only do fast state updates within that loop. Any heavier work
// should be offloaded to another goroutine.
//
// Causing publishers to block from backpressure is considered a bug
// in the slow subscriber causing the backpressure, and should be
// addressed there. Publishers should assume that Publish will not
// block for extended periods of time, and should not make exceptional
// effort to behave gracefully if they do get blocked.
//
// These blocking semantics are provisional and subject to
// change. Please speak up if this causes development pain, so that we
// can adapt the semantics to better suit our needs.
```

[`doc.go#L66-L85`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/util/eventbus/doc.go#L66-L85)。

**3 つの規約が宣言されている。**

**1. バッファは小さく固定。** 遅い購読者は背圧を生み、**全発行者をブロックする**。

**2. それは購読者のバグ。** 「発行者は `Publish` が長時間ブロックしないと仮定してよく、ブロックされた場合に優雅に振る舞う特別な努力をすべきでない」。

**責任の所在を明示している。** 発行者がタイムアウトやバッファリングで対処すると、**問題が隠れて悪化する**。購読者が遅いなら、そこを直す。

**3. この意味論は暫定的。** 「開発の苦痛になるなら声を上げてほしい。ニーズに合わせて調整できる」。

**設計判断を「暫定」と明示し、フィードバックを求める** のは、内部ライブラリらしい正直さだ。無限バッファにすればブロックはしないが、**メモリが無限に増え、遅延が見えなくなる**。ブロックするほうが問題が早く見つかる。

### 発行のコストを避ける

```go title="util/eventbus/publish.go"
func (p *Publisher[T]) ShouldPublish() bool {
	return p.core.client.shouldPublish(p.core.typ)
}
```

[`publish.go#L111-L113`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/util/eventbus/publish.go#L111-L113)。

ドキュメントの説明。

> **イベントの構築が高価なら、`ShouldPublish` を使って、誰も聞いていないときに作業を省ける。**

イベントの構造体を作るのにアロケーションや計算が要る場合、**購読者が 0 人ならそれは完全な無駄** だ。

```go
if pub.ShouldPublish() {
	pub.Publish(expensiveToConstruct())
}
```

**ログライブラリの `if log.V(2) { ... }` と同じ形。** 「出力先があるか」を先に確認する。

### ジェネリクスの境界

```go title="util/eventbus/publish.go"
func (p *Publisher[T]) Publish(v T) {
	publish(p.core, v)
}

// publish is the non-generic body of Publisher[T].Publish. The only
// per-T work is the boxing of v into evt.Event (an `any` field) and
// the construction of the PublishedEvent struct itself; all of the
// channel/select dance is shared across every T.
func publish(c *publisherCore, v any) {
```

[`publish.go#L77-L85`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/util/eventbus/publish.go#L77-L85)。

**ジェネリックな薄いラッパーと、非ジェネリックな本体に分けている。**

Go のジェネリクスは、**型パラメータごとにコードを生成する** (GC shape stenciling)。イベント型が 50 種類あれば、**チャネルの select や停止判定のコードが 50 回複製される**。

`any` に box してしまえば、**残りの処理は 1 つの関数で済む**。バイナリサイズが減る。

**「型安全な API を外に、型を消した実装を中に」** は、ジェネリクスを持つ言語で共通のパターンだ。

そして **コメントで「T ごとに固有な作業は何か」を明示している** — boxing と構造体の構築だけ。

### デバッグの手段

```go title="util/eventbus/doc.go"
// # Debugging facilities
//
// The [Debugger], obtained through [Bus.Debugger], provides
// introspection facilities to monitor events flowing through the bus,
// and inspect publisher and subscriber state.
//
// Additionally, a debug command exists for monitoring the eventbus:
//
//	tailscale debug daemon-bus-events
```

[`doc.go#L87-L96`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/util/eventbus/doc.go#L87-L96)。

**バスを流れるイベントを、実行中に観測できる。** `debughttp.go` (5.5 KB) は HTML の画面を提供し、`fetch-htmx.go` があるので htmx を使った動的な表示になっている。

疎結合の代償は **「何が起きているか分からなくなる」** ことだ。直接呼び出しならスタックトレースを見れば分かるが、**イベントバス経由だと因果関係が見えない**。

だから **バス自体に観測手段を組み込む**。これがないと、疎結合は「追跡不能」と同義になる。

### クライアントに名前を付けさせる

```go title="util/eventbus/doc.go"
// To send or receive events, first use [Bus.Client] to register with
// the bus. Clients should register with a human-readable name that
// identifies the code using the client, to aid in debugging.
```

[`doc.go#L11-L14`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/util/eventbus/doc.go#L11-L14)。

**「デバッグを助けるために、人間が読める名前で登録する」。**

デバッガの画面で「magicsock が HomeDERPChanged を発行し、ipnlocal と netlog が購読している」と表示できる。**名前がなければ、型とポインタしか出ない。**

### テストの支援

```go title="util/eventbus/doc.go"
// # Testing facilities
//
// Helpers for testing code with the eventbus can be found in:
//
//	eventbus/eventbustest
```

[`doc.go#L98-L103`](https://github.com/tailscale/tailscale/blob/1e69418c298b680562a2fecd7020f7f58d17d166/util/eventbus/doc.go#L98-L103)。

**テスト用のヘルパーが別パッケージにある。** 「このイベントが発行されたか」「この順序で来たか」を検証する道具だろう。

**非同期の仕組みを導入したら、テストの道具も一緒に提供する。** これがないと、利用者が各自でポーリングやスリープを書き、テストが不安定になる。

## なぜそうなっているか

### なぜイベントバスなのか

コンポーネント間の通知をコールバックで行うと、

- **登録の管理が要る**。誰がいつ登録・解除するか
- **ロックの順序が絡む**。コールバックの中で相手のロックを取ると、デッドロックしうる
- **依存が双方向になる**。A が B にコールバックを渡すと、A は B を知る必要がある

イベントバスなら、

- **発行者は購読者を知らない**。型だけを知る
- **同期はバスが引き受ける**。コールバックの中でロックを取る問題が消える
- **依存がイベント型だけになる**

代償は **追跡の難しさ** で、それをデバッガで補っている。

### なぜ「happens before」で書くのか

「イベントは順番に届きます」では曖昧だ。

- **どの範囲で順番か**? 同じ発行者から? 全発行者を通して?
- **どの受け手にとって順番か**? 同じ購読者? 全購読者?

**並行プログラミングの用語 (happens-before、全順序) を使えば、これらが一意に決まる。**

そして **「保証しないこと」も同じ精度で書ける**。「クライアント間の同期はしない」は、平易な言葉では表現しにくい。

### なぜ背圧を「購読者のバグ」とするのか

遅い購読者への対処には 3 通りある。

| 方式                        | 問題                               |
| --------------------------- | ---------------------------------- |
| **無限バッファ**            | メモリが増え続ける。遅延が見えない |
| **イベントを捨てる**        | 購読者が状態を見失う               |
| **発行者をブロック (採用)** | 全体が止まる                       |

**ブロックが最も「痛い」が、最も早く問題が分かる。** 無限バッファだと、メモリ不足になるまで気づかない。捨てると、状態の不整合という分かりにくい症状になる。

そして **「これは遅い購読者のバグだ」と宣言する** ことで、対処の方向が定まる。発行者側でタイムアウトを入れると、**問題が隠れて、別の場所で顕在化する**。

これは Go のチャネルの設計思想と同じで、**バッファなしチャネルが既定** なのも同じ理由だ。

### なぜアクターモデルを勧めるのか

イベントバスを使っても、**受け取ったイベントの処理で他のコンポーネントを直接呼べば、結局は密結合になる**。

アクターモデル (自分の状態だけを持ち、外とはメッセージだけで関わる) に従えば、

- **各コンポーネントが独立してテストできる**。イベントを流し込んで、出るイベントを検証する
- **デッドロックが起きにくい**。他のコンポーネントのロックを取らない
- **順序の保証が意味を持つ**。状態の変化がイベントの順序で決まる

**ドキュメントで「こう書け」と勧めるのは、ライブラリだけでは強制できないから** だ。API は直接呼び出しを禁止しない。

### なぜジェネリクスを薄く保つのか

Go のジェネリクスは、型パラメータの「GC shape」ごとにコードを生成する。ポインタ型はまとめられるが、**構造体の値型はそれぞれ別のコードになる**。

イベント型が 50 種類あり、`Publish` の実装が 30 行なら、**1,500 行分のコードが生成される**。バイナリサイズに効く。

**型に依存する部分 (boxing) だけをジェネリックにし、残りを `any` で受ける非ジェネリック関数に委譲する。**

これは Go に限らない。C++ のテンプレートでも「薄いテンプレート + 型消去した実装」は、コードサイズを抑える定石だ。

### なぜ観測手段を組み込むのか

疎結合の最大の代償は、**「何が起きているか」が分からなくなる** ことだ。

- 直接呼び出しなら、スタックトレースで因果が見える
- **イベントバス経由だと、発行と受信が別の goroutine になり、繋がらない**

「イベント A が発行されたが、コンポーネント B が反応していない」というバグを追うには、**バスを流れるイベントを見るしかない**。

**疎結合を導入するなら、観測手段もセットで導入する。** 後から足すのは難しい (バスの実装に手を入れる必要がある)。

## どう活かすか

**コンポーネント間の通知が増えてきたら、イベントバスを検討する。** コールバックの登録管理、ロックの順序、双方向の依存。これらがイベント型への依存だけになる。**ただし追跡が難しくなるので、観測手段も同時に用意する。**

**並行性の保証は、「happens before」などの正確な用語で書き、その後に平易な言い換えを添える。** 形式的な記述だけだと読まれず、平易な記述だけだと曖昧になる。**両方書く。**

**保証しないことを、保証することと同じ精度で書く。** 「クライアント間は同期しない」は、使う側が最も知りたい制約だ。**書かれていないと、暗黙に仮定される。**

**背圧の方針を決めて、責任の所在を宣言する。** 「遅い購読者のバグであり、そこで直すべき」。発行者側で対処すると問題が隠れる。**そして「この意味論は暫定」と書いて、フィードバックを求める** のは、内部ライブラリでは誠実な態度だ。

**構築が高価なイベントには、`ShouldPublish` のような事前確認を用意する。** 購読者が 0 人なら、構築のコストが完全な無駄になる。ログの `if V(2)` と同じ形。

**ジェネリックな API の実装は薄く保ち、型を消した非ジェネリック関数に委譲する。** 型パラメータごとにコードが生成される言語では、バイナリサイズに直結する。**「T ごとに固有の作業は何か」をコメントに書く。**

**登録する主体に人間が読める名前を付けさせる。** デバッグ画面で型とポインタしか出ないのと、コンポーネント名が出るのとでは、調査の速さが桁違いになる。

**非同期の仕組みには、テスト用のヘルパーを一緒に提供する。** ないと、利用者がスリープとポーリングでテストを書き、不安定なテストが量産される。

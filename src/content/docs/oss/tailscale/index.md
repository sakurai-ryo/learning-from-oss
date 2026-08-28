---
title: "Tailscale"
description: "WireGuard を使った VPN、と説明される。だが自前で書いているのは WireGuard の周りの全部だ。NAT の向こうにいる 2 台をどうやって UDP で直結させるか、繋がらないときどう中継するか、経路が変わったらどう張り直すか、OS のルーティングテーブルと DNS をどう乗っ取るか。コードの大半は「そもそも届くのか」という問いに費やされている。"
oss:
  repo: https://github.com/tailscale/tailscale
  language: Go
  ref: 1e69418c298b680562a2fecd7020f7f58d17d166
sidebar:
  label: 概要
  order: 0
---

Tailscale は、**同じアカウントに属するマシンどうしを、互いのプライベート IP で直接繋ぐ** ソフトウェアだ。ノードには `100.x.y.z` のアドレスが 1 つ配られ、相手がオフィスの NAT の内側にいようが、モバイル回線の CGNAT の内側にいようが、そのアドレス宛にパケットを送れば届く。

暗号化と鍵交換は WireGuard がやる。だが WireGuard 自体は「相手の UDP エンドポイントを知っている」ことを前提にしたプロトコルで、**相手がどこにいるのかを見つける機能は持っていない**。Tailscale のコードの大半は、まさにその欠けている部分だ。相手の候補アドレスをどう集め、どれが実際に通るかをどう試し、通らないときにどう中継し、Wi-Fi から LTE に切り替わった瞬間にどう張り直すか。

**「暗号化されたトンネルの手前にある、"そもそも届くのか" という問題」** — この章はそれを追う。

## この OSS について

- BSD 3-Clause。本体 (テストを除く) は Go 1,691 ファイル・約 35 万行。テストコードは約 23 万行。
- **WireGuard 本体は書いていない。** `github.com/tailscale/wireguard-go` (wireguard-go のフォーク) を依存として使い、その `conn.Bind` インターフェースに自前の実装を差し込む。差し込まれるのが `wgengine/magicsock` で、1 ファイル 162KB。ここが実質的な本体だ。
- **経路探索のために、WireGuard とは別のプロトコルをもう 1 つ喋る。** `disco` と呼ばれる 9 種類のメッセージを、NaCl box で暗号化して UDP に流す。マジックナンバーは `TS💬` の 6 バイト。ping/pong で経路を試し、`CallMeMaybe` で「今から君に送るからこっちにも送り返して」と伝える。ICE の役割を、STUN/TURN とは別に自分で書いている。
- **「直結できないときは中継する」を、標準機能として持つ。** DERP (Detoured Encrypted Routing Protocol) サーバへの接続は、直結できているときでも張りっぱなしにする。制御メッセージの経路であり、直結が切れた瞬間のフォールバック先でもある。
- **OS のネットワーク設定を、OS ごとに全部違う方法で書き換える。** DNS だけで systemd-resolved・NetworkManager・resolvconf (2 種)・Windows NRPT・macOS・Plan 9 の実装が並ぶ。ルーティングとファイアウォールも同様で、Linux では iptables と nftables の両方を持っている。
- **カーネルを使わないモードがある。** TUN デバイスを作れない環境 (コンテナ、非 root、iOS) のために、gVisor の netstack でユーザースペースの TCP/IP スタックを動かす。`tsnet` はこれを使って、Tailscale ノードを Go のライブラリとして 1 プロセスに埋め込む。
- **84 個の機能が、ビルドタグで個別に落とせる。** `ts_omit_<feature>` を付けるとその機能のコードがバイナリから消える。組み込み向けにサイズを削るための仕組みが、パッケージの依存関係の切り方そのものを規定している。
- **ルーティングテーブルのデータ構造まで自作している。** `net/art` は論文由来の Allotment Routing Table の実装で、Go 標準ライブラリにも取り込まれた。

## 読む順番

Tailscale の使用経験がない場合は、[アーキテクチャのページ](./architecture/) から読んでほしい。coordination server・netmap・DERP・disco・tailnet といった語彙を、全部ここで導入する。

WireGuard そのものに馴染みがなければ、次の [WireGuard のページ](./wireguard-basics/) を読んでおくと、以降が速い。この章の残り全部が「WireGuard がやらないこと」の話になるので、その境界を先に押さえておくと見通しがよくなる。

「前提」の 3 ページを読んだら、「NAT 越え」へ直行してよい。この章の重心はそこにある。「制御プレーン」は netmap がどこから来るのかの話で、後から読んでも困らない。

「データパス」「OS 統合とルーティング」「DNS」は、それぞれ独立して読める。ただし [magicsock のページ](./magicsock/) だけは「NAT 越え」の後に読むほうがよい。

前提:

- [Tailscale のアーキテクチャを一枚で読む](./architecture/)
- [WireGuard は何をして、何をしないのか](./wireguard-basics/)
- [鍵が 3 種類あるのは、信用する相手が 3 通りあるから](./keys/)
- [netmap: ネットワーク全体を 1 つの構造体で表す](./netmap/)

制御プレーン (ネットワークの形は誰が決めるか):

- [HTTP の上に Noise のトランスポートを自分で張る](./noise-transport/)
- [long poll でネットワークの変化を受け取り続ける](./map-longpoll/)
- [netmap をローカル状態へ落とす場所を 1 つに絞る](./netmap-apply/)
- [control からクライアントへ RPC を返す](./c2n/)
- [署名チェーンを持たせて、control server を信用しないで済ませる](./tailnet-lock/)

NAT 越え (この章の中心):

- [自分がどんなネットワークにいるのかを測る](./netcheck/)
- [ルータに穴を開ける 3 つのプロトコル](./portmapper/)
- [WireGuard とは別に、経路探索用のプロトコルを喋る](./disco-protocol/)
- [候補パスを全部保持し、最良経路を選び続ける](./endpoint-selection/)
- [常時つないでおくリレーが、到達性の最後の砦になる](./derp/)
- [リレー経由から直結へ昇格する瞬間](./derp-to-direct/)
- [DERP でも直結でもない、第三の経路](./peer-relay/)
- [ネットワークが変わったことに、どうやって気づくか](./link-change/)
- [ピアごとに MTU を探る](./peer-mtu/)
- [なぜ繋がらないのかを、後から説明できるようにする](./reachability-observability/)

データパス (パケットが通る道):

- [WireGuard の下に潜り込む Conn 実装](./magicsock/)
- [TUN デバイスのラッパーを、あらゆる処理の挿入点にする](./tstun/)
- [ACL をパケットフィルタに落とす](./packet-filter/)
- [カーネルを使わずに TCP/IP を喋る](./netstack/)
- [UDP を束ねて送り、システムコールを減らす](./udp-batching/)
- [フロー単位でトラフィックを数える](./netlog/)

OS 統合とルーティング (OS をどう乗っ取るか):

- [ルーティングとファイアウォールを OS ごとに書き分ける](./router-firewall/)
- [自分のトンネルに、自分のパケットを吸い込ませない](./netns-loop/)
- [subnet router と exit node は、同じ仕組みの別設定](./subnet-router-exit-node/)
- [ルーティングテーブルのデータ構造を自作する](./art-routing-table/)
- [キャプティブポータルの内側にいることを検出する](./captive-portal/)

DNS (名前解決を横取りする):

- [100.100.100.100 に住むリゾルバ](./magicdns-resolver/)
- [OS の DNS 設定を、6 通りの方法で書き換える](./os-dns-config/)
- [split DNS と exit node DNS の優先順位](./split-dns/)
- [自分が繋がる前に、control server の名前を引く](./dns-bootstrap/)

その上に載るもの (トンネルができた後の話):

- [ノードどうしが直接叩ける HTTP エンドポイント](./peerapi/)
- [Taildrop がファイル転送プロトコルを持たない理由](./taildrop/)
- [SSH サーバを自分で実装し、ACL で認可する](./tailscale-ssh/)
- [serve と funnel を、1 つの設定木で表す](./serve-funnel/)
- [ノードが自分で TLS 証明書を取る](./tls-cert/)
- [ドメインごとに経路を割り当てる](./app-connector/)
- [Tailscale ノードを Go のライブラリとして埋め込む](./tsnet/)

実装の作法:

- [84 個の機能を、ビルドタグで個別に落とせるようにする](./build-tags/)
- [不変ビューをコード生成で作る](./codegen-views/)
- [疎結合のための内部イベントバス](./eventbus/)
- [「繋がっていない」をユーザーに説明する状態機械](./health/)
- [NAT をシミュレートしてテストする](./natlab-testing/)

## この章で扱わないこと

- **Kubernetes operator と containerboot** (約 1.8 万行) — Tailscale をサイドカーやプロキシとして k8s に載せる仕組みで、単独で 1 章に値する。
- **GUI クライアントと OS 固有の管理機能** — `util/winutil`、`util/syspolicy` (MDM ポリシー)、`client/systray`、`ipn/desktop`。
- **WireGuard の実装そのもの** — Noise_IKpsk2 ハンドシェイクと ChaCha20-Poly1305 の実装、`wireguard-go` の内部構造。[基礎のページ](./wireguard-basics/) でプロトコルの外形だけを扱い、それ以降は「WireGuard に何を渡すか」の側だけを見る。
- **DERP サーバの運用まわり** — `cmd/derper`、`prober`、`derp/xdp` (eBPF による高速化)。

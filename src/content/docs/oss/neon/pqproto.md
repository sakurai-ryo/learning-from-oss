---
title: "pqproto — Postgres wire protocol を自分で書く"
description: "proxy は Postgres のクライアントでもサーバでもなく、両方のふりをする中継者だ。だから libpq もサーバ実装も使えず、プロトコルを自前で書いている。startup パケットの 5 通りの分岐に、そのプロトコルの歴史が全部見える。"
group: "proxy"
sidebar:
  order: 49
---

## 何を学んだか

proxy がやることは、クライアントの接続を受けて、認証して、適切な compute に繋いで、あとはバイト列を流すことだ。

そのために **Postgres のプロトコルを両側から話す**必要がある。クライアントに対してはサーバとして、compute に対してはクライアントとして。

```rust title="proxy/src/pqproto.rs"
//! Postgres protocol codec
//!
//! <https://www.postgresql.org/docs/current/protocol-message-formats.html>
```

([proxy/src/pqproto.rs L1](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/proxy/src/pqproto.rs#L1))

Neon には `libs/pq_proto` という汎用のプロトコル crate もある (pageserver と safekeeper が使う)。proxy が別に持っているのは、**要求が違うから**だ。pageserver は自分がサーバであることだけを知っていればいいが、proxy は両方の役をこなす。

## 接続の最初の 8 バイト

```rust title="proxy/src/pqproto.rs"
/// This first reads the startup message header, is 8 bytes.
/// The first 4 bytes is a big-endian message length, and the next 4 bytes is a version number.
///
/// The length value is inclusive of the header. For example,
/// an empty message will always have length 8.
struct StartupHeader {
    len: big_endian::U32,
    version: ProtocolVersion,
}
```

([proxy/src/pqproto.rs L71](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/proxy/src/pqproto.rs#L71))

**Postgres の接続は、メッセージ種別のバイトなしで始まる。** 最初のメッセージだけが特別で、長さとバージョン番号から始まる。

そしてバージョン番号のフィールドが、実は種別として使われている。

```rust title="proxy/src/pqproto.rs"
const RESERVED_INVALID_MAJOR_VERSION: u16 = 1234;
const CANCEL_REQUEST_CODE: ProtocolVersion = ProtocolVersion::new(1234, 5678);
const NEGOTIATE_SSL_CODE: ProtocolVersion = ProtocolVersion::new(1234, 5679);
const NEGOTIATE_GSS_CODE: ProtocolVersion = ProtocolVersion::new(1234, 5680);
```

([proxy/src/pqproto.rs L59](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/proxy/src/pqproto.rs#L59))

**メジャーバージョン 1234 は「バージョンではない」ことを意味する。** マイナーバージョンが実際の種別になる。1234/5678、1234/5679、1234/5680。

これは Postgres が後方互換を保ちながらプロトコルを拡張した痕跡だ。**既存のフィールドに、あり得ない値を入れて別の意味を持たせる。** 新しいフィールドを足せない場所での定石で、そして永久に残る。

各定数に、Postgres 本体の該当行への URL が付いている。**外部仕様に依存する定数は、出典を書く。**

## TLS の 2 通りの始まり方

```rust title="proxy/src/pqproto.rs"
    // First byte indicates standard SSL handshake message
    // (It can't be a Postgres startup length because in network byte order
    // that would be a startup packet hundreds of megabytes long)
    if header.as_bytes()[0] == 0x16 {
        return Ok(FeStartupPacket::SslRequest {
            // The bytes we read for the header are actually part of a TLS ClientHello.
            direct: Some(zerocopy::transmute!(header)),
        });
    }
```

([proxy/src/pqproto.rs L127](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/proxy/src/pqproto.rs#L127))

Postgres の TLS は本来、**平文で `SSLRequest` を送り、`S` が返ってきたら TLS ハンドシェイクを始める**という 2 段階になっている。

しかし Postgres 17 から、いきなり TLS ClientHello を送る「direct TLS」が入った。proxy は両方を受け付ける必要がある。

判定が**「最初のバイトが 0x16 なら TLS」**という、極めて低レベルなものになっている。0x16 は TLS の handshake レコード型だ。

そして「なぜ誤判定しないか」の論証が書かれている。**`0x16` から始まる 4 バイトをビッグエンディアンの長さとして読むと、数百 MB になる。** そんな startup パケットは存在しない。

**2 つのプロトコルを同じポートで受けるとき、判別は先頭バイトの値域が重ならないことに依存する。** そしてその根拠を書き残しておく必要がある。

読んでしまった 8 バイトを捨てないのも要点だ。`direct: Some(...)` として持ち回り、TLS のパーサに渡し直す。**先読みしたバイトを返す仕組みがないと、この形の判別はできない。**

コメントの但し書きも正直だ。

```rust
            // In theory, if the ClientHello was < 8 bytes we would fail with EOF before we get here.
            // In practice though, I see no world where a ClientHello is less than 8 bytes
            // since it includes ephemeral keys etc.
```

**「理論上は 8 バイト未満の ClientHello で EOF になるが、実際にはあり得ない」。** 前提を認識したうえで許容している。

## zerocopy でバイト列を構造体にする

```rust title="proxy/src/pqproto.rs"
/// read the type from the stream using zerocopy.
///
/// not cancel safe.
macro_rules! read {
    ($s:expr => $t:ty) => {{
        // cannot be implemented as a function due to lack of const-generic-expr
        let mut buf = [0; size_of::<$t>()];
        $s.read_exact(&mut buf).await?;
        let res: $t = zerocopy::transmute!(buf);
        res
    }};
}
```

([proxy/src/pqproto.rs L78](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/proxy/src/pqproto.rs#L78))

**`zerocopy` の `FromBytes` / `IntoBytes` で、バイト列を構造体として直接読む。** `big_endian::U16` のような型がバイト順を型で表すので、変換忘れが起きない。

マクロになっている理由が明記されている — **「const generic expression がないので関数にできない」**。`[0; size_of::<T>()]` が関数の中では書けない。

そして `not cancel safe` という注記。**`read_exact` の途中でキャンセルすると、読んだ分が失われてストリームがずれる。** async Rust でストリームを扱うときの定番の落とし穴で、それをマクロの doc に書いている。

## 長さの検証

```rust title="proxy/src/pqproto.rs"
    let Some(len) = (header.len.get() as usize).checked_sub(8) else {
        return Err(io::Error::other(format!(
            "invalid startup message length {}, must be at least 8.",
            header.len,
        )));
    };

    // TODO: add a histogram for startup packet lengths
    if len > MAX_STARTUP_PACKET_LENGTH {
        tracing::warn!("large startup message detected: {len} bytes");
        return Err(io::Error::other(format!(
            "invalid startup message length {len}"
        )));
    }
```

([proxy/src/pqproto.rs L137](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/proxy/src/pqproto.rs#L137))

**下限と上限の両方を検証する。** `checked_sub` で下限 (アンダーフローの防止)、定数比較で上限。

`MAX_STARTUP_PACKET_LENGTH` は 10000 で、Postgres 本体の値と同じ。**インターネットに直接晒されるプロセスなので、確保するメモリ量を必ず制限する。**

上限超過のときにログを出しているのが実務的だ。攻撃かもしれないし、正当な巨大パラメータかもしれない。**弾く前に記録する。**

## メッセージの種別が 5 つある

```rust title="proxy/src/pqproto.rs"
    match header.version {
        CANCEL_REQUEST_CODE => { /* ... */ }
        NEGOTIATE_SSL_CODE => {
            // Requested upgrade to SSL (aka TLS)
            Ok(FeStartupPacket::SslRequest { direct: None })
        }
        NEGOTIATE_GSS_CODE => {
            // Requested upgrade to GSSAPI
            Ok(FeStartupPacket::GssEncRequest)
        }
        version if version.major() == RESERVED_INVALID_MAJOR_VERSION => Err(io::Error::other(
            format!("Unrecognized request code {version:?}"),
        )),
        // StartupMessage
        version => { /* ... */ }
    }
```

**1234 で始まる未知のコードは、明示的にエラーにする。** ワイルドカードで StartupMessage として扱うと、パラメータのパースで意味不明なエラーになる。**「予約領域の未知の値」を「不正なバージョン番号」として扱わない。**

GSSAPI は proxy がサポートしないが、**種別としては認識する。** 認識したうえで拒否するのと、パースに失敗するのでは、クライアントに返せるエラーが違う。

## CancelRequest が特別なわけ

```rust title="proxy/src/pqproto.rs"
        CANCEL_REQUEST_CODE => {
            if len != 8 {
                return Err(io::Error::other(
                    "CancelRequest message is malformed, backend PID / secret key missing",
                ));
            }

            Ok(FeStartupPacket::CancelRequest(
                read!(stream => CancelKeyData),
            ))
        }
```

**クエリのキャンセルは、既存の接続では送れない。** Postgres のプロトコルでは、クエリ実行中のバックエンドは新しいメッセージを読まない。だから**別の TCP 接続を張って、そこにキャンセル要求を送る。**

proxy にとって、これは厄介な要求になる。キャンセル要求は「どの compute に繋いでいたか」の情報を持たない。持っているのは PID と秘密鍵だけだ ([コネクションプールとキャンセル](../pool-and-cancel/))。

## この先に効いてくること

- **中継者は両方の役を演じる。** クライアントライブラリもサーバ実装も使えない。
- **既存フィールドにあり得ない値を入れて拡張する。** そしてそれは永久に残る。
- **同じポートで 2 つのプロトコルを受けるには、先頭バイトの値域が重ならないこと。** その根拠を書く。
- **外部仕様の定数には出典を書く。**
- **予約領域の未知の値は、明示的に拒否する。** ワイルドカードに落とさない。

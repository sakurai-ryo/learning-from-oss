---
title: "SCRAM を中継しながら、認証は control plane でやる"
description: "proxy はパスワードを知らない。SCRAM の検証子だけを control plane から取り、クライアントとの認証をその場で完結させる。そして PBKDF2 が CPU を食うので、専用のスレッドプールと部分キャッシュがある。"
group: "proxy"
sidebar:
  order: 51
---

## 何を学んだか

SCRAM (RFC 5802) は、**サーバがパスワードを知らなくても認証できる**プロトコルだ。サーバが持つのは検証子で、そこからパスワードは復元できない。

```rust title="proxy/src/scram/secret.rs"
/// Server secret is produced from user's password,
/// and is used throughout the authentication process.
pub(crate) struct ServerSecret {
    /// When this secret was cached.
    pub(crate) cached_at: Instant,

    /// Number of iterations for `PBKDF2` function.
    pub(crate) iterations: u32,
    /// Salt used to hash user's password.
    pub(crate) salt_base64: Box<str>,
    /// Hashed `ClientKey`.
    pub(crate) stored_key: ScramKey,
    /// Used by client to verify server's signature.
    pub(crate) server_key: ScramKey,
    /// Should auth fail no matter what?
    /// This is exactly the case for mocked secrets.
    pub(crate) doomed: bool,
}
```

([proxy/src/scram/secret.rs L11](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/proxy/src/scram/secret.rs#L11))

パース元は Postgres の `pg_authid.rolpassword` と同じ形式だ。

```rust title="proxy/src/scram/secret.rs"
    pub(crate) fn parse(input: &str) -> Option<Self> {
        // SCRAM-SHA-256$<iterations>:<salt>$<storedkey>:<serverkey>
```

**proxy は control plane からこの文字列を取ってきて、自分がサーバとして SCRAM を実行する。**

これで得られるものが大きい。

- **proxy はパスワードを知らない。** 漏洩しても被害が限定される
- **compute に繋ぐ前に認証できる。** compute を起こす前に不正な接続を弾ける
- **クライアントの側から見ると、普通の Postgres と同じ。** ドライバの変更が要らない

## パスワードなしで compute に繋ぐ

proxy はクライアントを認証したが、**compute に対して認証する手段を持っていない。** パスワードを知らないからだ。

Neon はここを JWT で解決している。`docs/authentication.md` にある通り、Neon の内部コンポーネント間の認証は JWT で、**Postgres の接続ではそれをパスワードとして渡す。**

> For PostgreSQL connections we expect the token to be passed as a password.

そして実務的な注意が付いている。

> There is a caveat for `psql`: it silently truncates passwords to 100 symbols, so to correctly pass JWT via `psql` you have to either use `PGPASSWORD` environment variable, or store password in `psql`'s config file.

**`psql` はパスワードを 100 文字で黙って切り詰める。** JWT はそれより長い。既存のツールの制限が、認証方式の選択に影響している。

## 存在しないユーザーでも同じ手順を踏む

```rust title="proxy/src/scram/secret.rs"
    /// To avoid revealing information to an attacker, we use a
    /// mocked server secret even if the user doesn't exist.
    /// See `auth-scram.c : mock_scram_secret` for details.
    pub(crate) fn mock(nonce: [u8; 32]) -> Self {
```

([proxy/src/scram/secret.rs L57](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/proxy/src/scram/secret.rs#L57))

**ユーザーが存在しなくても、偽の検証子を作って SCRAM を最後まで実行する。**

そのための `doomed` フラグがある。

```rust title="proxy/src/scram/secret.rs"
    /// Should auth fail no matter what?
    /// This is exactly the case for mocked secrets.
    pub(crate) doomed: bool,
```

**「何があっても失敗する」という状態を明示的に持つ。** 早期リターンして「ユーザーがいません」と返すと、**ユーザー名の存在が観測できてしまう。**

Postgres 本体の `mock_scram_secret` を参照しているので、**本家と同じ対策を移植している**ことが分かる。

比較も定数時間だ。

```rust title="proxy/src/scram/secret.rs"
    pub(crate) fn is_password_invalid(&self, client_key: &ScramKey) -> Choice {
        // constant time to not leak partial key match
        client_key.sha256().ct_ne(&self.stored_key) | Choice::from(self.doomed as u8)
    }
```

**`subtle` crate の `ConstantTimeEq` を使う。** そして `doomed` の判定も同じ式に `|` で混ぜている。分岐にすると、そこでタイミングが変わる。

戻り値が `bool` ではなく `Choice` なのも重要で、**`Choice` は `if` に使えない型**になっている。定数時間の比較結果を、うっかり分岐に使うことを型で防いでいる。

## channel binding

```rust title="proxy/src/scram/exchange.rs"
/// The only channel binding mode we currently support.
struct TlsServerEndPoint;
```

([proxy/src/scram/exchange.rs L21](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/proxy/src/scram/exchange.rs#L21))

SCRAM の channel binding は、**認証を特定の TLS セッションに結びつける**仕組みだ。`tls-server-end-point` は、サーバ証明書のハッシュを認証のやりとりに混ぜる。

これがあると、中間者が TLS を張り直して認証を中継することができなくなる。**まさに proxy がやっていることを、他人ができなくする仕組み**になっている。

proxy が正当にこれを提供できるのは、proxy 自身が正規の証明書を持っているからだ ([SNI からエンドポイントを決める](../sni-routing/))。

## PBKDF2 が CPU を食う

SCRAM の検証には PBKDF2 (既定 4096 回の HMAC 反復) が要る。**接続のたびにこれをやると、CPU が持たない。**

```rust title="proxy/src/scram/threadpool.rs"
//! Custom threadpool implementation for password hashing.
//!
//! Requirements:
//! 1. Fairness per endpoint.
//! 2. Yield support for high iteration counts.
```

([proxy/src/scram/threadpool.rs L1](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/proxy/src/scram/threadpool.rs#L1))

**要件が 2 つだけ書かれていて、どちらも既存のライブラリでは満たせなかった。**

```rust title="proxy/src/scram/threadpool.rs"
        // rayon would be nice here, but yielding in rayon does not work well afaict.
```

**`rayon` を使いたかったが、yield がうまく動かない。** 反復回数が大きい (顧客が設定できる) 場合に、1 つのハッシュ計算がワーカーを占有し続けてしまう。

「エンドポイントごとの公平性」のために、`CountMinSketch` を使っている。

```rust title="proxy/src/scram/threadpool.rs"
use crate::scram::countmin::CountMinSketch;

/// How often to reset the sketch values
const SKETCH_RESET_INTERVAL: u64 = 1021;
```

**「どのエンドポイントが最近たくさんハッシュを要求したか」を、確率的データ構造で数える。** 正確な計数は要らない。多く使っている側を後回しにできればいい。

リセット間隔が 1021 (素数) なのは、**周期的なワークロードとの同期を避ける**ためだろう。

## 部分ハッシュのキャッシュ

```rust title="proxy/src/scram/cache.rs"
/// To speed up password hashing for more active customers, we store the tail results of the
/// PBKDF2 algorithm. If the output of PBKDF2 is U1 ^ U2 ^ ⋯ ^ Uc, then we store
/// suffix = U17 ^ U18 ^ ⋯ ^ Uc. We only need to calculate U1 ^ U2 ^ ⋯ ^ U15 ^ U16
/// to determine the final result.
///
/// The suffix alone isn't enough to crack the password. The stored_key is still required.
/// While both are cached in memory, given they're in different locations is makes it much
/// harder to exploit, even if any such memory exploit exists in proxy.
pub struct Pbkdf2CacheEntry {
    /// corresponds to [`super::ServerSecret::cached_at`]
    pub(super) cached_from: Instant,
    pub(super) suffix: pbkdf2::Block,
}
```

([proxy/src/scram/cache.rs L22](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/proxy/src/scram/cache.rs#L22))

**PBKDF2 は XOR の連鎖なので、後半だけを事前に計算しておける。** 4096 回のうち 16 回だけ計算すれば、残りはキャッシュから XOR するだけ。**256 倍速くなる。**

そして安全性の議論が付いている。**「suffix だけではパスワードは割れない。stored_key も要る。両方がメモリにあるが、別の場所にあるので、仮にメモリを読む脆弱性があっても悪用は難しい」。**

キャッシュを入れるときに「これは何を漏らすか」を検討して書き残している。最適化のたびに攻撃面を評価する、という姿勢が見える。

そして後始末もある。

```rust title="proxy/src/scram/cache.rs"
impl Drop for Pbkdf2CacheEntry {
    fn drop(&mut self) {
        self.suffix.zeroize();
    }
}
```

**drop 時にメモリをゼロで潰す。** `zeroize` crate は、コンパイラが最適化で消さないことを保証する。

キャッシュのサイズと TTL も小さい。

```rust title="proxy/src/scram/cache.rs"
        const SIZE: u64 = 100;
        const TTL: std::time::Duration = std::time::Duration::from_secs(60);
```

**100 エントリ、60 秒。** 「アクティブな顧客」だけを対象にした、意図的に小さいキャッシュになっている。秘密を保持する時間と量を最小限にする、という判断だ。

`cached_from` が `ServerSecret::cached_at` と対応しているのも要点で、**パスワードが変更されて検証子が変わったら、部分ハッシュも無効になる。** 2 つのキャッシュの整合を、タイムスタンプの一致で取っている。

## 状態機械は 2 状態

```rust title="proxy/src/scram/exchange.rs"
enum ExchangeState {
    /// Waiting for [`ClientFirstMessage`].
    Initial(SaslInitial),
    /// Waiting for [`ClientFinalMessage`].
    SaltSent(SaslSentInner),
}
```

([proxy/src/scram/exchange.rs L51](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/proxy/src/scram/exchange.rs#L51))

**SCRAM は 2 往復。** クライアントが nonce を送り、サーバが salt と自分の nonce を返し、クライアントが証明を送り、サーバが自分の証明を返す。

各状態が、次のステップで必要になるデータだけを持つ。

```rust title="proxy/src/scram/exchange.rs"
struct SaslSentInner {
    cbind_flag: ChannelBinding<TlsServerEndPoint>,
    client_first_message_bare: String,
    server_first_message: OwnedServerFirstMessage,
}
```

**署名の検証には、それまでに交換した全メッセージが要る。** SCRAM の署名は会話全体に対して計算されるので、文字列をそのまま保持しておく必要がある。

`SaslInitial` が `nonce: fn() -> [u8; N]` という関数ポインタを持っているのは、**テストで nonce を固定するため**だ。暗号プロトコルのテストには決定的な乱数が要る。

## この先に効いてくること

- **検証子だけで認証できるプロトコルは、中継者に優しい。** パスワードを預けずに済む。
- **存在しないユーザーでも同じ手順を踏む。** 「必ず失敗する」を状態として持つ。
- **定数時間比較の結果を、分岐に使えない型で返す。**
- **最適化のたびに攻撃面を評価して書き残す。** 部分ハッシュのキャッシュ。
- **秘密を保持する時間と量は最小限にし、drop でゼロ化する。**

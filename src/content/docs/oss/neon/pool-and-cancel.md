---
title: "コネクションプールとキャンセル"
description: "HTTP のリクエストごとに Postgres へ繋いでいたら遅い。プールを持つと、キャンセル要求がどの proxy に届くか分からなくなる。Redis に外部化された cancel key と、そこに付随する認可の問題。"
group: "proxy"
sidebar:
  order: 54
---

## 何を学んだか

HTTP 越しの SQL では、1 リクエスト = 1 クエリになる ([HTTP 越しの SQL](../serverless-sql/))。毎回 compute に接続していたら、接続確立のコストがクエリのコストを上回る。

だから proxy は compute への接続をプールする。

```rust title="proxy/src/serverless/conn_pool_lib.rs"
pub(crate) struct ConnInfo {
    pub(crate) user_info: ComputeUserInfo,
    pub(crate) dbname: DbName,
}

impl ConnInfo {
    pub(crate) fn db_and_user(&self) -> (DbName, RoleName) {
        (self.dbname.clone(), self.user_info.user.clone())
    }
```

([proxy/src/serverless/conn_pool_lib.rs L27](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/proxy/src/serverless/conn_pool_lib.rs#L27))

**プールのキーは (エンドポイント, DB, ロール) の組。** 違うロールの接続を使い回すと、権限が混ざる。

そしてプールしてはいけない場合がある。

```rust title="proxy/src/serverless/conn_pool_lib.rs"
    pub(crate) fn endpoint_cache_key(&self) -> Option<EndpointCacheKey> {
        // We don't want to cache http connections for ephemeral endpoints.
        if self.user_info.options.is_ephemeral() {
            None
        } else {
            Some(self.user_info.endpoint_cache_key())
        }
    }
```

**一時的なエンドポイント (テスト用のブランチなど) はプールしない。** すぐ消えるので、プールに残しても再利用されずゴミになる。

`Option` を返すことで、**「プールできない」を型で表現している。** 呼び出し側は必ずこのケースを扱うことになる。

## クライアントの種類が 3 つある

```rust title="proxy/src/serverless/conn_pool_lib.rs"
pub(crate) enum ClientDataEnum {
    Remote(ClientDataRemote),
    Local(ClientDataLocal),
    Http(ClientDataHttp),
}
```

([proxy/src/serverless/conn_pool_lib.rs L49](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/proxy/src/serverless/conn_pool_lib.rs#L49))

- **Remote** — 通常の proxy から compute への Postgres 接続
- **Local** — `local_proxy` (compute と同居する proxy) の接続
- **Http** — HTTP プロキシとしての接続 (`auth_broker` 用)

**プールの機構は共通で、中身だけが違う。** `conn_pool_lib.rs` がジェネリックな部分を持ち、3 つのファイルが具体を持つ。

そして共通部分に drop 処理がある。

```rust title="proxy/src/serverless/conn_pool_lib.rs"
impl<C: ClientInnerExt> Drop for ClientInnerCommon<C> {
    fn drop(&mut self) {
        match &mut self.data {
            ClientDataEnum::Remote(remote_data) => {
                remote_data.cancel();
            }
```

([proxy/src/serverless/conn_pool_lib.rs L63](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/proxy/src/serverless/conn_pool_lib.rs#L63))

**プールから捨てられるとき、キャンセル用の登録も片付ける。** 接続の寿命と、それに紐づく外部状態の寿命を合わせている。

## キャンセルは別の接続から来る

[pqproto](../pqproto/) で見たとおり、クエリのキャンセルは新しい TCP 接続で送られる。中身は PID と秘密鍵だけだ。

**proxy が複数台あると、キャンセル要求が別の proxy に届く。** その proxy は、その接続のことを何も知らない。

解決は Redis への外部化になる。

```rust title="proxy/src/cancellation.rs"
pub enum CancelKeyOp {
    Store {
        key: CancelKeyData,
        value: Box<str>,
        expire: Duration,
    },
    Refresh {
        key: CancelKeyData,
        expire: Duration,
    },
    Get {
        key: CancelKeyData,
    },
    GetOld {
        key: CancelKeyData,
    },
}
```

([proxy/src/cancellation.rs L42](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/proxy/src/cancellation.rs#L42))

**接続を受けた proxy が「この cancel key は自分が持っている」を Redis に書き、キャンセル要求を受けた proxy がそれを引く。**

`GetOld` があるのは、**キーの形式が変わったときの移行のため**だろう。新旧両方を引いて、どちらかが当たればいい。

## TTL の 2 段構え

```rust title="proxy/src/cancellation.rs"
/// Initial period and TTL is shorter to clear keys of short-lived connections faster.
const CANCEL_KEY_INITIAL_PERIOD: Duration = Duration::from_secs(60);
const CANCEL_KEY_REFRESH_PERIOD: Duration = Duration::from_secs(10 * 60);
/// `CANCEL_KEY_TTL_SLACK` is added to the periods to determine the actual TTL.
const CANCEL_KEY_TTL_SLACK: Duration = Duration::from_secs(30);
```

([proxy/src/cancellation.rs L35](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/proxy/src/cancellation.rs#L35))

**最初の TTL は 60 秒、更新後は 10 分。**

理由が書かれている — **「短命な接続のキーを速く消すため」。** 接続の大半はすぐ終わる。全部を 10 分保持すると Redis が無駄に膨らむ。

長生きする接続だけが、60 秒後に更新されて 10 分の TTL を得る。**分布に合わせて、最初は短く、続くなら長く。**

`TTL_SLACK` は更新の遅れへの余裕だ。**更新周期と TTL を同じにすると、わずかな遅延でキーが消える。**

## キャンセルには認可が要る

キャンセル要求は認証されていない。PID と秘密鍵しか持っていないし、それは Postgres のプロトコル上、暗号学的に強い秘密ではない。

だから proxy 側で守る必要がある。

```rust title="proxy/src/cancellation.rs"
        let subnet_key = match ctx.peer_addr() {
            IpAddr::V4(ip) => IpNet::V4(Ipv4Net::new_assert(ip, 24).trunc()), // use defaut mask here
            IpAddr::V6(ip) => IpNet::V6(Ipv6Net::new_assert(ip, 64).trunc()),
        };

        let allowed = {
            let rate_limit_config = None;
            let limiter = self.limiter.lock_propagate_poison();
            limiter.check(subnet_key, rate_limit_config, 1)
        };
        if !allowed {
            // log only the subnet part of the IP address to know which subnet is rate limited
            tracing::warn!("Rate limit exceeded. Skipping cancellation message, {subnet_key}");
```

([proxy/src/cancellation.rs L370](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/proxy/src/cancellation.rs#L370))

**レート制限のキーが個別 IP ではなくサブネット。** IPv4 は /24、IPv6 は /64。

IPv6 では 1 台のホストが /64 全体を持つのが普通なので、**個別アドレスで制限すると簡単に回避される。** 割り当ての最小単位で制限をかけるのが正しい。

ログにもサブネットだけを出している。**個別 IP を出さないのはプライバシーへの配慮**であり、同時に「どのサブネットが問題か」という運用上の情報としては十分になっている。

そして本来の認可がある。

```rust title="proxy/src/cancellation.rs"
        let access_controls = auth_backend
            .get_endpoint_access_control(&ctx, &info.endpoint, &info.user)
            .await
            .map_err(|e| CancelError::AuthError(e.into()))?;

        access_controls.check(&ctx, check_ip_allowed, check_vpc_allowed)?;
```

([proxy/src/cancellation.rs L409](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/proxy/src/cancellation.rs#L409))

**cancel key から endpoint とユーザーを引き、その endpoint の IP 許可リストと VPC 許可リストを検査する。**

**キャンセルは「そのエンドポイントに接続できる者」だけができるべき**という判断になっている。cancel key を推測できても、許可リストの外からは使えない。

## エラーを「誰の問題か」で分類する

```rust title="proxy/src/cancellation.rs"
impl ReportableError for CancelError {
    fn get_error_kind(&self) -> crate::error::ErrorKind {
        match self {
            CancelError::IO(_) => crate::error::ErrorKind::Compute,
            CancelError::Postgres(e) if e.as_db_error().is_some() => {
                crate::error::ErrorKind::Postgres
            }
            CancelError::Postgres(_) => crate::error::ErrorKind::Compute,
            CancelError::RateLimit => crate::error::ErrorKind::RateLimit,
            CancelError::NotFound | CancelError::AuthError(_) => crate::error::ErrorKind::User,
            CancelError::InternalError => crate::error::ErrorKind::Service,
        }
    }
```

([proxy/src/cancellation.rs L227](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/proxy/src/cancellation.rs#L227))

**`ErrorKind` は「誰の問題か」の分類だ。** `User`、`Compute`、`Postgres`、`Service`、`RateLimit`。

同じ `Postgres` エラーでも、**DB エラー (SQL の問題) なら `Postgres`、それ以外 (接続の問題) なら `Compute`** と分けている。

そして `NotFound` が `User` に分類されているのが目を引く。**「そんな cancel key はない」はユーザーの問題**として扱う。古い接続をキャンセルしようとしたか、鍵を間違えたか。システム側のアラートには載せない。

この分類がメトリクスのラベルになり、**「エラー率」を「誰のせいのエラー率」に分解できる。** proxy のように多数の外部システムに挟まれたコンポーネントでは、この分解がないと障害の切り分けができない。

## ランダムなキャンセル

```rust title="proxy/src/serverless/cancel_set.rs"
//! A set for cancelling random http connections
```

([proxy/src/serverless/cancel_set.rs L1](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/proxy/src/serverless/cancel_set.rs#L1))

**HTTP の接続をランダムに切るための集合。** 用途は負荷分散だ。

HTTP の keep-alive は接続を保持し続けるので、**proxy を増やしても既存の接続は移動しない。** デプロイ直後の新しい proxy に負荷が来ない。

だから時々ランダムに接続を切る。クライアントは再接続し、そのとき別の proxy に当たる可能性がある。

`IndexMap` を使っているのは、**ランダムなインデックスで要素を取り出すため**だ。`HashMap` では「ランダムな 1 個」を効率的に取れない。

そしてシャードに分けている (`CancelSet::new(shards)`)。**ロックの競合を避けつつ、ランダム性を保つ。**

## この先に効いてくること

- **プールのキーは、混ざってはいけないものの組。** エンドポイント、DB、ロール。
- **「プールできない」を `Option` で表す。** 呼び出し側に扱いを強制する。
- **接続の寿命と、それに紐づく外部状態の寿命を drop で合わせる。**
- **TTL は分布に合わせて 2 段にする。** 最初は短く、続くなら長く。
- **IPv6 のレート制限は /64 で。** 個別アドレスでは回避される。
- **エラーを「誰の問題か」で分類する。** 障害の切り分けが可能になる。

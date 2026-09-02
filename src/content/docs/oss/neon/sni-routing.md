---
title: "SNI からエンドポイントを決める"
description: "Postgres のプロトコルには「どのデータベースサーバに繋ぎたいか」を伝える場所がない。proxy は TLS の SNI を使ってそれを解決し、SNI が使えないクライアントのために 2 つの迂回路を用意している。"
group: "proxy"
sidebar:
  order: 50
---

## 何を学んだか

HTTP なら `Host` ヘッダがあるので、1 つの IP で複数のサイトを提供できる。**Postgres のプロトコルにはそれがない。** startup パケットにあるのは `user`、`database`、`options` などで、「どのサーバに繋ぎたいか」は入っていない。TCP で繋いだ先がサーバだ、という前提になっている。

Neon はエンドポイント (プロジェクトごとの Postgres) が数百万ある。全部に別の IP を割り当てるわけにはいかない。

**解決策は TLS の SNI (Server Name Indication) を使うこと**だった。

```rust title="proxy/src/auth/credentials.rs"
pub(crate) fn endpoint_sni(sni: &str, common_names: &HashSet<String>) -> Option<EndpointId> {
    let (subdomain, common_name) = sni.split_once('.')?;
    if !common_names.contains(common_name) {
        return None;
    }
    if subdomain == SERVERLESS_DRIVER_SNI || subdomain == AUTH_BROKER_SNI {
        return None;
    }
    Some(EndpointId::from(subdomain))
}
```

([proxy/src/auth/credentials.rs L63](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/proxy/src/auth/credentials.rs#L63))

**サブドメインがそのままエンドポイント ID。** `ep-cool-darkness-123456.us-east-2.aws.neon.tech` の先頭部分だ。

`common_names` の検査があるのは、**任意のドメインからエンドポイント名を取り出さないため**。自分が証明書を持つドメインでなければ拒否する。

そして予約されたサブドメイン (`SERVERLESS_DRIVER_SNI`、`AUTH_BROKER_SNI`) は除外する。**同じ proxy が複数の用途を持っていて、サブドメインで用途を分けている。**

## ワイルドカード証明書

SNI でルーティングするには、**そのドメイン名の証明書を持っていなければならない。** エンドポイントごとに証明書を取るのは非現実的だ。

```rust title="proxy/src/tls/server_config.rs"
    // In scram-proxy we use wildcard certificates only, with the database endpoint as the wildcard subdomain, taken from SNI.
    // We need to remove the wildcard prefix for the purposes of certificate selection.
```

([proxy/src/tls/server_config.rs L176](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/proxy/src/tls/server_config.rs#L176))

**`*.us-east-2.aws.neon.tech` のワイルドカード証明書 1 枚で、そのリージョンの全エンドポイントをカバーする。**

証明書の選択は、SNI から順にサブドメインを削りながら探す。

```rust title="proxy/src/tls/server_config.rs"
        // loop here and cut off more and more subdomains until we find
        // a match to get a proper wildcard support. OTOH, we now do not
        // use nested domains, so keep this simple for now.
        if let Some(mut sni_name) = server_name {
            loop {
                if let Some(cert) = self.certs.get(sni_name) {
                    return cert.clone();
                }
                if let Some((_, rest)) = sni_name.split_once('.') {
                    sni_name = rest;
                } else {
```

([proxy/src/tls/server_config.rs L212](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/proxy/src/tls/server_config.rs#L212))

**完全一致 → 1 段削って一致 → ... と探す。** ワイルドカードのマッチングを、辞書の逐次探索で実装している。

見つからなかったときの処理に、判断が書かれている。

```rust title="proxy/src/tls/server_config.rs"
                    // The customer has some custom DNS mapping - just return
                    // a default certificate.
                    //
                    // This will error if the customer uses anything stronger
                    // than sslmode=require. That's a choice they can make.
                    return self.default.clone();
```

**「顧客が独自の DNS マッピングを使っている場合、デフォルト証明書を返す。`sslmode=require` より強い設定を使っていればエラーになるが、それは顧客の選択」。**

証明書の検証に失敗させるのではなく、**失敗する可能性のある証明書を返して、判断をクライアントに委ねる。** `sslmode=require` は「暗号化はするが証明書は検証しない」なので、これで動く。

## SNI がない場合

```rust title="proxy/src/tls/server_config.rs"
            // No SNI, use the default certificate, otherwise we can't get to
            // options parameter which can be used to set endpoint name too.
            // That means that non-SNI flow will not work for CNAME domains in
            // verify-full mode.
            //
            // If that will be a problem we can:
            //
            // a) Instead of multi-cert approach use single cert with extra
            //    domains listed in Subject Alternative Name (SAN).
            // b) Deploy separate proxy instances for extra domains.
            self.default.clone()
```

**SNI がなくても、とりあえず TLS を確立させる。** そうしないと startup パケットの `options` パラメータを読めない。

そして制約と、その回避策が 2 つ挙げられている。**現時点で採用しない理由は書かれていないが、選択肢は記録されている。**

## エンドポイントの決め方は 3 通り

```rust title="proxy/src/auth/credentials.rs"
        let kind = if sni.is_some() {
            debug!("Connection with sni");
            SniKind::Sni
        } else if endpoint.is_some() {
            debug!("Connection without sni");
            SniKind::NoSni
        } else {
            debug!("Connection with password hack");
            SniKind::PasswordHack
        };
```

([proxy/src/auth/credentials.rs L133](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/proxy/src/auth/credentials.rs#L133))

**3 種類あって、それぞれメトリクスとして数えられている。** どの経路がどれだけ使われているかが分かる。

**1. SNI** — 本来の経路。

**2. options パラメータ。**

```rust title="proxy/src/auth/credentials.rs"
        // Project name might be passed via PG's command-line options.
        let endpoint_option = params
            .options_raw()
            .and_then(|options| {
                // We support both `project` (deprecated) and `endpoint` options for backward compatibility.
                // However, if both are present, we don't exactly know which one to use.
                // Therefore we require that only one of them is present.
                options
                    .filter_map(parse_endpoint_param)
                    .at_most_one()
                    .ok()?
            })
```

([proxy/src/auth/credentials.rs L89](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/proxy/src/auth/credentials.rs#L89))

`psql "...options=endpoint%3Dep-xxx"` のように渡せる。**`project` と `endpoint` の両方を受け付けるが、両方あったらエラー。** 曖昧なときに勝手に決めない。

そして両方の経路で指定された場合の検査もある。

```rust title="proxy/src/auth/credentials.rs"
        let endpoint = match (endpoint_option, endpoint_from_domain) {
            // Invariant: if we have both project name variants, they should match.
            (Some(option), Some(domain)) if option != domain => {
                Some(Err(ComputeUserInfoParseError::InconsistentProjectNames {
                    domain,
                    option,
                }))
            }
```

**SNI と options が矛盾したらエラー。** どちらかを優先するのではなく、拒否する。**同じ情報を伝える経路が複数あるとき、食い違いは黙って解決しない。**

**3. password hack.**

```rust title="proxy/src/auth/password_hack.rs"
    pub(crate) fn parse(bytes: &[u8]) -> Option<Self> {
        // The format is `project=<utf-8>;<password-bytes>` or `project=<utf-8>$<password-bytes>`.
        // The endpoint name is restricted to alphanumeric/hyphen, so it never
        // contains either separator; split on whichever one appears first so
        // we don't truncate the password when it contains the other separator.
        let split = bytes.iter().position(|&b| b == b';' || b == b'$')?;
```

([proxy/src/auth/password_hack.rs L15](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/proxy/src/auth/password_hack.rs#L15))

**パスワードの先頭にエンドポイント名を埋め込む。** 名前が `password_hack` で、実際そのとおりのものだ。

SNI も options も使えないクライアント (古いドライバ、GUI ツール、SNI を送らない TLS ライブラリ) のための最終手段になっている。

区切り文字が 2 つあるのが実装の妙で、**「エンドポイント名には英数字とハイフンしか使えない」という制約を利用して、パスワードにどちらかの記号が含まれていても正しく分割できる**ようにしている。先に現れたほうで切る。

これは後から見つかったバグの修正だろう。パスワードに `;` が含まれていると、素朴な実装では切り詰められる。

そしてこの経路は **SCRAM が使えない**。パスワードそのものを proxy が受け取ることになるからだ ([SCRAM を中継しながら、認証は control plane でやる](../scram-proxying/))。`allow_cleartext` の設定がこれを制御している。

## 名前の検証

```rust title="proxy/src/auth/credentials.rs"
            // Invariant: project name may not contain certain characters.
            (a, b) => a.or(b).map(|name| {
                if project_name_valid(name.as_ref()) {
                    Ok(name)
                } else {
                    Err(ComputeUserInfoParseError::MalformedProjectName(name))
                }
            }),
```

**どの経路から来た名前も、必ず同じ検証を通す。** SNI 経由なら証明書のドメインだから安全、とはしない。

エンドポイント名は control plane への問い合わせに使われ、キャッシュのキーになり、メトリクスのラベルになる。**外部入力が内部の識別子になる場所では、経路によらず同じ検証をかける。**

## この先に効いてくること

- **プロトコルに宛先を伝える場所がなければ、下位層 (TLS の SNI) から取る。**
- **ワイルドカード証明書 1 枚で、無数のサブドメインをカバーする。**
- **どうしても無理な経路には迂回路を用意する。** ただし機能 (SCRAM) は落ちる。
- **同じ情報の経路が複数あるとき、食い違いは黙って解決しない。**
- **外部入力が識別子になる場所では、経路によらず同じ検証をかける。**

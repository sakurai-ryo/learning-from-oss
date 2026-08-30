---
title: "既定はすべて閉じる — WasiCtxBuilder と cap-std"
description: "WasiCtx の既定値は全部「閉じて」いる。preopen は cap-std の Dir という能力オブジェクトとして表現され、ambient_authority() というトークンを要求する関数を 1 回呼ぶだけでホスト側のアンビエント権限は使い切られる。ソケットの許可判定が async クロージャであること、exit が Rust の Error として実装されていることまで含めて、ケイパビリティモデルを実装から裏付ける。"
group: "WASI"
sidebar:
  order: 76
---

[WASI とは何か — 権限ではなく能力を渡す](../what-wasi-is/) で見た「アンビエント権限を取り除く」という思想が、wasmtime のコードでは 3 つの形になっている。**既定値が全部閉じていること**、**preopen が `cap-std` の `Dir` という能力オブジェクトになっていること**、そして **ソケットの許可判定が差し替え可能な非同期クロージャであること**だ。このページはその 3 つを実装から追う。

## 既定値の一覧が 1 箇所に書かれている

`WasiCtxBuilder::new` の doc に、何も設定しなかったときの状態が全部並んでいる。

```rust title="crates/wasi/src/ctx.rs"
/// The current defaults are:
///
/// * stdin is closed
/// * stdout and stderr eat all input and it doesn't go anywhere
/// * no env vars
/// * no arguments
/// * no preopens
/// * clocks use the host implementation of wall/monotonic clocks
/// * RNGs are all initialized with random state and suitable generator
///   quality to satisfy the requirements of WASI APIs.
/// * TCP/UDP are allowed but all addresses are denied by default.
/// * `wasi:sockets/ip-name-lookup` is denied by default.
pub fn new() -> Self {
    Self::default()
}
```

[crates/wasi/src/ctx.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasi/src/ctx.rs#L48-L67)

そして `WasiCtxBuilder` は `#[derive(Default)]` で、フィールドは 5 つのドメイン別コンテキストだけだ。**「既定値」という概念が Rust の `Default` にそのまま乗っている**ので、閉じている状態が特別扱いではなく最も単純な状態になっている。何かを開けるには必ずビルダのメソッドを呼ぶ必要があり、呼ばなければ閉じたままになる。

ネットワークの実際の既定は、この doc よりさらに厳しい。

```rust title="crates/wasi/src/sockets/mod.rs"
#[derive(Copy, Clone, Default)]
pub(crate) struct AllowedNetworkUses {
    pub(crate) ip_name_lookup: bool,
    pub(crate) udp: bool,
    pub(crate) tcp: bool,
}
```

[crates/wasi/src/sockets/mod.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasi/src/sockets/mod.rs#L80-L86)

`Default` は `bool` を `false` にするので、**TCP も UDP も既定では使用そのものが拒否される**。`allow_tcp` / `allow_udp` の doc も「By default this is disabled」と書いている。ビルダの doc にある「TCP/UDP are allowed but all addresses are denied」は、いまのコードよりひとつ緩い記述になっている。いずれにせよ**閉じる側に倒れている**ので害はないが、doc と実装のどちらが正かを確認したいときは `Default` を見るのが速い。

拒否は 2 段構えになっていて、`check_allowed_tcp` は「プロトコル自体が許されているか」を、後述の `SocketAddrCheck` は「そのアドレスが許されているか」を見る。**「ソケットを作る能力」と「特定のアドレスへ繋ぐ能力」が別々**という粒度が、そのまま 2 つのチェックになっている。

## preopen は `Dir` という能力オブジェクト

ファイルシステムの能力は `Dir` という構造体で表現される。この doc が能力そのものの説明になっている。

```rust title="crates/wasi/src/filesystem.rs"
#[derive(Clone)]
pub struct Dir {
    /// The operating system file descriptor this struct is mediating access
    /// to.
    ///
    /// This is a handle to a directory, and all paths accessed through this
    /// struct are sandboxed to be within this directory via `cap-primitives`.
    pub dir: Arc<std::fs::File>,
    /// Permissions to enforce on access to the filesystem under this
    /// directory are specified by a user of the `crate::WasiCtxBuilder`, and
    /// are enforced prior to any enforced by the underlying operating system.
    ///
    /// These permissions are also enforced on any directories opened under
    /// this directory.
    pub perms: FsPerms,
    /// The mode the directory was opened under: bits for reading, and writing.
    pub open_mode: OpenMode,

    pub(crate) allow_blocking_current_thread: bool,
}
```

[crates/wasi/src/filesystem.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasi/src/filesystem.rs#L779-L802)

**`Dir` は OS の fd を 1 本包んでいるだけ**で、そこに `FsPerms` (`ReadOnly` か `ReadWrite`) が貼り付いている。そして重要なのが「これらの権限は、この配下で開かれたディレクトリにも適用される」という一文だ。**能力から派生した能力は、元の能力より強くなれない。** 読み取り専用で渡したディレクトリの中でサブディレクトリを開いても、それは読み取り専用のままになる。

もうひとつ、「OS が課すものより先に適用される (`enforced prior to any enforced by the underlying operating system`)」という記述も効いている。ホストのユーザに書き込み権限があっても、`FsPerms::ReadOnly` で渡した preopen 配下には書けない。**Unix の権限とケイパビリティは独立した 2 枚の壁**で、緩いほうに引きずられない。

## `ambient_authority()` という名前が持つ意味

preopen を作るコードは、[WASI とは何か](../what-wasi-is/) でも引いたとおりこれだけだ。

```rust title="crates/wasi/src/ctx.rs"
let dir = cap_primitives::fs::open_ambient_dir(host_path.as_ref(), ambient_authority())?;
```

[crates/wasi/src/ctx.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasi/src/ctx.rs#L297-L318)

注目したいのは **関数名と引数名の両方に `ambient` が入っている**ことだ。`cap-std` の設計では、パス名からファイルを開くようなアンビエント権限を使う操作は `*_ambient_*` という名前になり、さらに `AmbientAuthority` というゼロサイズのトークンを引数で要求する。トークンを作れるのは `ambient_authority()` 関数だけで、この呼び出しは grep で全部見つかる。

つまり `cap-std` は**アンビエント権限を「使えなくする」のではなく「目立たせる」ことで安全性を作っている**。ホスト側のコードでこれを呼ぶのは preopen を作るこの 1 回だけで、それ以降ゲストの操作が触るのは `Dir` から生えた相対操作しかない。`Dir` の中では `openat` 系のシステムコールと、`cap-primitives` によるパス要素ごとのシンボリックリンク検査が働く。

**「危険な操作を禁止する」ではなく「危険な操作に必ず現れるマーカを決めて、その出現箇所を数えられるようにする」**という方針だ。禁止は逃げ道を塞ぎきれないが、マーカは監査できる。

## ソケットの許可判定は async クロージャ

ネットワークのアドレス許可は、固定のリストではなく関数として持たれている。

```rust title="crates/wasi/src/sockets/mod.rs"
#[derive(Clone)]
pub(crate) struct SocketAddrCheck(
    Arc<
        dyn Fn(SocketAddr, SocketAddrUse) -> Pin<Box<dyn Future<Output = bool> + Send + Sync>>
            + Send
            + Sync,
    >,
);

impl Default for SocketAddrCheck {
    fn default() -> Self {
        Self(Arc::new(|_, _| Box::pin(async { false })))
    }
}
```

[crates/wasi/src/sockets/mod.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasi/src/sockets/mod.rs#L112-L165)

既定は `async { false }`、つまり**すべてのアドレスを拒否する関数**だ。そして「全部許す」ほうはこの関数の特殊ケースでしかない。

```rust title="crates/wasi/src/ctx.rs"
pub fn inherit_network(&mut self) -> &mut Self {
    self.socket_addr_check(|_, _| Box::pin(async { true }))
}
```

[crates/wasi/src/ctx.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasi/src/ctx.rs#L383-L392)

**`inherit_network` は糖衣であり、特権的な抜け道ではない。** 「全許可」と「全拒否」が同じ型の値で、その間の任意のポリシーも同じ型で書ける。

そしてこのクロージャが **`Future` を返す**ことが効く。ホスト関数の実装は `check(addr, reason).await` を呼ぶだけなので、判定の中で外部の認可サービスに HTTP で問い合わせても、データベースを引いても、レートリミットの取得を待ってもよい。**同期の述語なら「事前に読み込んだリストと突き合わせる」以上のことができないが、非同期にした瞬間ポリシー決定を別のシステムへ委譲できる。**

判定には理由が渡される。

```rust title="crates/wasi/src/sockets/mod.rs"
pub enum SocketAddrUse {
    /// Binding TCP socket.
    TcpBind,
    /// Put a TCP socket in listener mode.
    TcpListen,
    /// Accepting a new client TCP socket.
    ///
    /// The address passed to the check is the remote address of the client that
    /// is being accepted. If the check fails, the client socket will be
    /// silently dropped before reaching the guest.
    TcpAccept,
    /// Connecting a TCP socket.
    TcpConnect,
    // UdpBind / UdpConnect / UdpOutgoingDatagram も同型で続く
}
```

[crates/wasi/src/sockets/mod.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasi/src/sockets/mod.rs#L168-L230)

`bind` / `listen` / `accept` / `connect` が区別されるので、「外向きの接続は許すが listen は許さない」ようなポリシーが書ける。**サーバになる能力とクライアントになる能力は別物**という区別が、型として存在している。

`TcpAccept` の扱いが独特で、拒否されたクライアントは**ゲストに届く前に黙って落とされる**。

```rust title="crates/wasi/src/sockets/tcp.rs"
match accept(&listener).await {
    Ok((client, addr)) => {
        if permissions
            .check(addr, SocketAddrUse::TcpAccept)
            .await
            .is_ok()
        {
            return Ok(client);
        } else {
            reset(client);
            continue;
        }
    }
    Err(err) => {
        return Err(err.into());
    }
}
```

[crates/wasi/src/sockets/tcp.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasi/src/sockets/tcp.rs#L572-L590)

`reset(client)` してから `continue` でループを回り、次の接続を待つ。**エラーをゲストに返さない**のは、そうすると「拒否されたアドレスから接続があった」という情報がゲストに漏れるからだ。`accept` は「許された接続だけが返ってくる操作」に見え、拒否の存在自体がゲストから観測できない。ケイパビリティモデルでは、持っていない能力の存在すら知らせないほうが一貫している。

## `exit` は Rust のエラーとして実装されている

もうひとつ、ケイパビリティとは別の角度で面白い実装がある。`wasi:cli/exit` はプロセスを終了する API だが、ホスト側で `std::process::exit` を呼んだりはしない。

```rust title="crates/wasi/src/p2/host/exit.rs"
impl exit::Host for WasiCliCtxView<'_> {
    fn exit(&mut self, status: Result<(), ()>) -> wasmtime::Result<()> {
        let status = match status {
            Ok(()) => 0,
            Err(()) => 1,
        };
        Err(wasmtime::format_err!(I32Exit(status)))
    }

    fn exit_with_code(&mut self, status_code: u8) -> wasmtime::Result<()> {
        Err(wasmtime::format_err!(I32Exit(status_code.into())))
    }
}
```

[crates/wasi/src/p2/host/exit.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasi/src/p2/host/exit.rs#L5-L17)

`I32Exit` は `i32` を 1 個持つだけの型で、`std::error::Error` を実装している。ホスト関数がエラーを返すと wasmtime はそれをトラップとして扱い、ゲストのスタックを巻き戻して埋め込み側まで伝播する ([トラップの発生をシグナルで捕まえる](../traps-via-signals/))。**「終了」がトラップという既存の巻き戻し機構に相乗りしている**わけだ。

受け取る側は downcast する。

```rust title="src/commands/run.rs"
if store.data().wasip1_ctx.is_some() {
    if let Some(exit) = e.downcast_ref::<wasmtime_wasi::I32Exit>() {
        std::process::exit(exit.0);
    }
}
```

[src/commands/run.rs](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/src/commands/run.rs#L486-L493)

`I32Exit` の doc も「埋め込み側は wasm から返ったエラーがこれかどうかを検査でき、その場合は致命的でないトラップとして扱ってよい」と書いている ([crates/wasi/src/error.rs#L5-L10](https://github.com/bytecodealliance/wasmtime/blob/d8a0da6d661605713798c1c9c76be5c28e3159ff/crates/wasi/src/error.rs#L5-L10))。

この形が効くのは、**プロセスを終わらせる権限をホスト側に残せる**からだ。`wasmtime` の CLI はプロセスごと落とすが、1 プロセスで多数のゲストを回すサーバなら、`I32Exit` を「このリクエストは終わった」と読み替えるだけでよい。ゲストが `exit` を呼んでもサーバは死なない。**ゲストが持つのは「自分を終わらせる能力」であって「プロセスを終わらせる能力」ではない**、という切り分けがコードに出ている。

## なぜ「既定で閉じる」なのか

閉じた既定値は使いにくい。`wasmtime run app.wasm` と打つと何も読めないし、`--dir` を毎回書く必要がある。それでもこちらを選ぶ理由は、**2 種類の失敗の重さが違う**ことにある。

既定が開いていて閉じ忘れた場合、プログラムは動く。テストも通る。問題は本番で誰かが `/etc/passwd` を読んだときに初めて分かる。既定が閉じていて開き忘れた場合、プログラムは動かない。最初の実行で `No such file or directory` が出て、そこで気づく。**前者の失敗は沈黙し、後者の失敗は叫ぶ。**

そしてこの非対称は、設定が増えるほど効いてくる。preopen もソケットも環境変数も引数も乱数も、すべてが同じ規則に従うなら、「何が渡っているか」は `WasiCtxBuilder` の呼び出し列を読むだけで分かる。**設定を読まないと危険度が分からない設計と、設定に書いてあることが危険度のすべてである設計**の差だ。

## どう活かすか

持ち帰りは 2 つある。

ひとつは、**「安全な既定値」を言語の `Default` に一致させること**。`#[derive(Default)]` が最も閉じた状態を作るようにフィールドの真偽の向きを決めておくと、フィールドを追加した人が既定値を考え忘れても閉じたままになる。`allow_tcp: bool` は良い名前で、`deny_tcp: bool` なら `Default` が「許可」になってしまう。

もうひとつは、**危険な操作にマーカ型を要求すること**。`cap-std` の `ambient_authority()` は実行時には何もしないゼロコストのトークンだが、「この操作は監査対象だ」という印を型システムに埋め込んでいる。同じことは `unsafe fn` でも `#[must_use]` でもできる。禁止できないものは、せめて数えられるようにする。

次は、この上に載る I/O の共通土台を見る ([なぜ wasi:io だけが別クレートなのか](../wasi-io/))。

---
title: "ページ単位の AEAD で、nonce と tag をページの中に押し込む"
description: "暗号化はファイル形式を変えずに載せられる。SQLite のヘッダには「各ページ末尾の予約バイト数」という既存のフィールドがあり、そこに nonce と tag を置けば B-tree の側は何も知らなくていい。ページ 1 だけは例外で、接続の初期化にヘッダの中身が要るため暗号化できない。そこはヘッダを AAD (追加認証データ) にして改竄検知だけかける。「変えられない形式の中に、規定の隙間を見つけて収める」という設計の実例になっている。"
sidebar:
  order: 11
---

## 何を学んだか

`.db` ファイルの暗号化を後から足すとき、素直に思いつくのは「ファイル全体を暗号化する」だ。だがそれをやると、ページ単位のランダムアクセスができなくなる。

ページ単位で暗号化するなら、ページごとに nonce と認証タグを持つ必要がある。**その場所をどこから捻り出すか** が問題になる。

Turso の答えは、**SQLite の形式に元からある隙間を使う** だった。

```rust title="core/storage/sqlite3_ondisk.rs"
    /// Bytes of unused "reserved" space at the end of each page. Usually 0.
    pub reserved_space: u8,
```

```rust title="core/storage/sqlite3_ondisk.rs"
    pub fn usable_space(self) -> usize {
        (self.page_size.get() as usize) - (self.reserved_space as usize)
    }
```

[`core/storage/sqlite3_ondisk.rs#L329-L330`, `#L377-L379`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/sqlite3_ondisk.rs#L377-L379)。

**SQLite のヘッダ 20 バイト目に、「各ページの末尾に何バイト使わないか」を指定するフィールドが元からある。** B-tree はページ全体ではなく `usable_space` の範囲だけを使う。

つまり、**このフィールドに 48 を書けば、全ページの末尾 48 バイトが空く**。B-tree のコードは 1 行も変えなくていい。

## ソースコードのどこか

### レイアウト

````rust title="core/storage/encryption.rs"
/// Example: Assume the page size is 4096 bytes and we use AEGIS 256. So we reserve the last 48 bytes
/// for the nonce (32 bytes) and tag (16 bytes).
///
/// ```ignore
///             Unencrypted Page              Encrypted Page
///             ┌───────────────┐            ┌───────────────┐
///             │               │            │               │
///             │ Page Content  │            │   Encrypted   │
///             │ (4048 bytes)  │  ────────► │    Content    │
///             │               │            │ (4048 bytes)  │
///             ├───────────────┤            ├───────────────┤
///             │   Reserved    │            │    Tag (16)   │
///             │  (48 bytes)   │            ├───────────────┤
///             │   [empty]     │            │   Nonce (32)  │
///             └───────────────┘            └───────────────┘
///                4096 bytes                   4096 bytes
/// ```
````

[`core/storage/encryption.rs#L26-L42`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/encryption.rs#L26-L42)。

必要な予約バイト数は、暗号方式から決まる。

```rust title="core/storage/encryption.rs"
    pub fn required_reserved_bytes(&self) -> u8 {
        self.cipher_mode.metadata_size() as u8
    }
```

[`core/storage/encryption.rs#L627-L629`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/encryption.rs#L627-L629)。

そして開くときに突き合わせる。

```rust title="core/database.rs"
        if let (Some(codec), Some(reserved_bytes)) = (page_codec, header_reserved_bytes) {
            let required_reserved_bytes = codec.required_reserved_bytes();
            if reserved_bytes != required_reserved_bytes {
                return Err(LimboError::InvalidArgument(format!(
                    "page codec requires exactly {required_reserved_bytes} reserved bytes, but database provides {reserved_bytes}"
                )));
            }
        }
```

[`core/database.rs#L2948-L2956`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/database.rs#L2948-L2956)。

**ファイルが宣言している予約バイト数と、要求された暗号方式が必要とする量が一致しなければ、開かない。** 「AES-128 で作ったファイルを AEGIS-256 で開く」が事故にならない。

### 暗号方式は、検証つきのものだけ

```rust title="core/storage/encryption.rs"
/// Encryption Scheme
/// We support two major algorithms: AEGIS, AES GCM. These algorithms picked so that they also do
/// verification of the ciphertext, so we don't need to implement. That is if the page is corrupted
/// (or tampered), then we will know if we got garbage bytes post decryption.
```

[`core/storage/encryption.rs#L17-L21`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/encryption.rs#L17-L21)。

**AEAD (認証つき暗号) だけを採用し、「自前で検証を実装しなくて済む」ことを理由に挙げている。**

ページの破損検知は、暗号化していない DB では別の仕組み (チェックサム) が要る。AEAD を使えば、**復号の失敗がそのまま破損・改竄の検知になる**。1 つの仕組みが 2 つの役目を果たす。

nonce は毎回新しく生成する。

```rust title="core/storage/encryption.rs"
/// We perform encryption at the page level, i.e., each page is encrypted and decrypted individually.
/// We store the nonce and tag (or the verification bits) in the page itself.  We also generate a
/// random nonce every time we encrypt a page.
```

[`core/storage/encryption.rs#L22-L24`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/encryption.rs#L22-L24)。

**同じページを 2 回書けば、2 回とも違う暗号文になる。** ページ番号を nonce にする実装 (よくある手抜き) だと、同じページの新旧の暗号文を比べられてしまう。

### ページ 1 だけは暗号化できない

```rust title="core/storage/encryption.rs"
/// The above applies to all the pages except Page 1. The page 1 contains the SQLite header (the
/// first 100 bytes). Specifically, the bytes 16 to 24 contain metadata which is required to
/// initialise the connection, which happens before we can setup the encryption context. So, we
/// don't encrypt the header but instead use the header data as additional data (AD) for the
/// encryption of the rest of the page. This provides us protection against tampering and
/// corruption for the unencrypted portion.
```

[`core/storage/encryption.rs#L44-L49`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/encryption.rs#L44-L49)。

**卵と鶏がここにもある。** ページサイズと予約バイト数を知らないと暗号コンテキストを作れないが、それはヘッダの中にある。

解決は **「暗号化しないが、認証はする」** だ。ヘッダを AAD (追加認証データ) として渡すと、暗号文には含まれないが、**改竄されると復号が失敗する**。

「隠せない情報」と「守れない情報」は別だ、という区別がここで効いている。ページサイズは隠さなくてもいいが、書き換えられては困る。AEAD の AAD は、ちょうどその要求に対応する。

### 暗号化した DB は、SQLite だと分かる形で開けなくなる

```rust title="core/storage/encryption.rs"
///                    Turso Header (16 bytes)
///        ┌─────────┬───────┬────────┬──────────────────┐
///        │  Turso  │Version│ Cipher │     Unused       │
///        │  (5)    │ (1)   │  (1)   │    (9 bytes)     │
///        └─────────┴───────┴────────┴──────────────────┘
///         0-4      5       6        7-15
///
///        Standard SQLite Header: "SQLite format 3\0" (16 bytes)
///                            ↓
///        Turso Encrypted Header: "Turso" + Version + Cipher ID + Unused
```

```rust title="core/storage/encryption.rs"
pub const TURSO_HEADER_PREFIX: &[u8] = b"Turso";
pub const SQLITE_HEADER: &[u8] = b"SQLite format 3\0";
const TURSO_VERSION: u8 = 0x00;
```

[`core/storage/encryption.rs#L53-L74`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/encryption.rs#L53-L74)。

**マジックバイトを `"SQLite format 3\0"` から `"Turso"` に置き換える。**

これは [互換性の契約](../sqlite-compat/) から見ると重要な判断だ。暗号化した DB は SQLite で開けない。だから **「開ける形をしていながら中身が読めない」ではなく、「開けない形にする」** を選んでいる。

しかも空いた 11 バイトのうち 2 バイトに、**バージョンと暗号方式の ID を書いている**。鍵さえあれば、どの方式で暗号化されたかはファイルから分かる。

`docs/manual.md` の設計メモは、鍵について明確だ。

```text title="docs/manual.md"
3. The key is not stored anywhere. So each connection should carry an encryption key. Trying to open a db with an invalid or empty key should return an error.
```

[`docs/manual.md#L1472-L1500`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/docs/manual.md#L1472)。

**鍵はどこにも保存されない。** ファイルにも、`Database` 構造体にも。実際、`Database` の定義にはこう書いてある。

```rust title="core/database.rs"
/// Do that `Database` object is cached and can be long lived. DO NOT store anything sensitive like
/// encryption key here.
```

[`core/database.rs#L515-L517`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/database.rs#L515-L517)。

**「長く生きるオブジェクトだから、機微な情報を置くな」** と、型の定義のすぐ上に書いてある。鍵は接続ごとに持つ。

### 書く前に、予約領域が空であることを確かめる

```rust title="core/storage/encryption.rs"
        let metadata_size = self.cipher_mode.metadata_size();
        let reserved_bytes = &page[self.page_size - metadata_size..];

        #[cfg(debug_assertions)]
        {
            let reserved_bytes_zeroed = reserved_bytes.iter().all(|&b| b == 0);
            turso_assert!(
                reserved_bytes_zeroed,
                "last reserved bytes must be empty/zero, but found non-zero bytes"
            );
        }
```

[`core/storage/encryption.rs#L742-L753`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/encryption.rs#L742-L753)。

**B-tree が予約領域まではみ出して書いていないかを、暗号化の直前に確かめている。**

もしはみ出していたら、その内容は nonce と tag に上書きされて消える。**しかも暗号化しているので、消えたことに気付くのは復号した後になる。** データ破壊としては最悪の形だ。

「他の層が守るべき不変条件を、それに依存する層が assert する」形になっている。予約バイト数を守るのは B-tree の責任だが、破られたときに困るのは暗号化の側だ。**困る側が見張る。**

前後のサイズも毎回確かめている。

```rust title="core/storage/encryption.rs"
        assert_eq!(
            result.len(),
            self.page_size,
            "Encrypted page must be exactly {} bytes",
            self.page_size
        );
```

[`core/storage/encryption.rs#L766-L773`](https://github.com/tursodatabase/turso/blob/34b38a1a43a4449b868141c62508ab0c8376308b/core/storage/encryption.rs#L766-L773)。

**暗号化してもページサイズは 1 バイトも変わらない。** これがこの設計の核心で、変わってしまったら pager から下が全部影響を受ける。

## なぜそうなっているか

- **形式に元からある予約領域を使ったのは、B-tree を変えずに済むから。** 新しい領域を作ると、`usable_space` の計算からセルの配置まで全部に手が入る。既にある概念を使えば、値を変えるだけになる。
- **ヘッダの値と暗号方式の要求を突き合わせるのは、取り違えを検出するため。** 予約バイト数は暗号方式ごとに違うので、不一致は「違う方式で開こうとしている」を意味する。開く前に落とせる。
- **AEAD だけを採用したのは、破損検知を別に作りたくないから。** 暗号化と完全性検証を別々に実装すると、組み合わせを間違える余地が生まれる。1 つで両方満たすものを選ぶ。
- **nonce を毎回生成するのは、同じ平文が同じ暗号文にならないようにするため。** ページ番号を nonce にすると、更新前後の暗号文を比較できてしまう。
- **ページ 1 を暗号化しないのは、それを読まないと暗号化を設定できないから。** 循環がある。「隠す」を諦めて「守る」だけにするのが、この循環の断ち方になる。
- **AAD を使ったのは、「暗号文に含めずに認証する」がまさに必要な機能だから。** 暗号化と認証を分けて考えられていなければ、この選択肢は出てこない。
- **マジックバイトを変えたのは、「開けるが読めない」を避けるため。** SQLite で開けてしまうと、中身がゴミに見える。ツールによっては壊れたファイルとして扱われ、修復を試みられる可能性すらある。開けない方が安全になる。
- **暗号方式の ID をヘッダに書いたのは、鍵だけでは方式が分からないから。** 利用者に「何で暗号化したか」を覚えさせるのは非現実的だ。
- **鍵をどこにも保存しないのは、保存した瞬間にそれが攻撃対象になるから。** 長生きするオブジェクトに置けば、メモリダンプで取れる。型の定義に警告を書くところまでやっている。
- **予約領域が空であることを debug ビルドで確かめるのは、破られたときの被害が大きいから。** 暗号化した後では、上書きされたことに気付けない。

## どう活かすか

- **形式を変えずに機能を足したいなら、形式が既に持っている「使われていない場所」を探す。** 予約領域、パディング、未使用フラグ。仕様に「未使用」と書いてある場所は、既存の実装が触らないことが保証されている。
- **その場所の使い方は、開くときに検証する。** 「何バイト予約されているか」と「この機能が何バイト必要とするか」を突き合わせれば、取り違えが起動時に落ちる。
- **暗号化と完全性検証を、別々に実装しない。** AEAD を使えば 1 つで済む。分けると、組み合わせを間違える余地が生まれる。
- **nonce は決定的な値から作らない。** ページ番号やオフセットを使うと、同じ場所の更新前後を比較できてしまう。
- **暗号化できないメタデータは、「暗号化しない」ではなく「認証する」にする。** AAD に入れれば、隠せなくても改竄は検知できる。「隠す」と「守る」は別の要求だ。
- **中身を読めなくするなら、開けなくもする。** 「開けるがゴミが返る」は、ツールに修復を試みさせる余地を残す。マジックバイトを変えれば、そもそも触られない。
- **鍵や資格情報は、長生きするオブジェクトに置かない。** そして置かない理由を、その型の定義の隣に書く。
- **他の層が守るべき不変条件でも、破られて困る側が assert する。** 「予約領域を超えて書かない」は B-tree の責任だが、破られたときに沈黙するのは暗号化の側だ。困る側に見張らせる。

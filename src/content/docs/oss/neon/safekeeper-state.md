---
title: "control file — 状態を持つということ"
description: "safekeeper が持つ永続状態は 1 ファイルに収まる。しかし全部を毎回 fsync していたら遅い。永続化が要る状態と要らない状態を型で分け、フォーマットのバージョンを 10 回上げてきた、その運用の作法を読む。"
group: "safekeeper — WAL の合意"
sidebar:
  order: 22
---

## 何を学んだか

safekeeper の timeline ごとの状態は、`safekeeper.control` という 1 つのファイルに入っている。中身は [LSN がシステム全体の論理時計になる](../lsn-as-clock/) で見た通り、ほとんど LSN だ。

問題は、**この中に「更新のたびに fsync が要るもの」と「要らないもの」が混在している**ことだった。

- `term` — **必須。** 投票を返す前に永続化しないと split brain が起きる
- `commit_lsn` — **不要。** 失っても他の safekeeper と compute から再計算できる
- `backup_lsn` — 不要。S3 を見れば分かる (ただし調べるのが遅い)
- `remote_consistent_lsn` — 不要。pageserver から再度報告される

`commit_lsn` は WAL が届くたびに更新される。ここで毎回 fsync していたら、safekeeper のスループットは control file の fsync 回数に律速される。

## 型で分ける

Neon の解決は、**同じフィールドを 2 つの構造体に持つ**というものだった。

```rust title="safekeeper/src/state.rs"
// In memory safekeeper state. Fields mirror ones in `SafeKeeperPersistentState`; values
// are not flushed yet.
pub struct TimelineMemState {
    pub commit_lsn: Lsn,
    pub backup_lsn: Lsn,
    pub peer_horizon_lsn: Lsn,
    pub remote_consistent_lsn: Lsn,
    #[serde(with = "hex")]
    pub proposer_uuid: PgUuid,
}

/// Safekeeper persistent state plus in memory layer.
///
/// Allows us to avoid frequent fsyncs when we update fields like commit_lsn
/// which don't need immediate persistence. Provides transactional like API
/// to atomically update the state.
///
/// Implements Deref into *persistent* part.
pub struct TimelineState<CTRL: control_file::Storage> {
    pub inmem: TimelineMemState,
    pub pers: CTRL, // persistent
}
```

([safekeeper/src/state.rs L169](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/safekeeper/src/state.rs#L169))

**`inmem` は「最新だがまだディスクにない値」、`pers` は「ディスクにある値」。** そして `Deref` が `pers` に向いているので、`state.term` と書けば永続化済みの値が取れる。うっかり `inmem` の値を永続的な判断に使わないようになっている。

更新は 2 段構えの API になる。

```rust title="safekeeper/src/state.rs"
    /// Start atomic change. Returns SafeKeeperPersistentState with in memory
    /// values applied; the protocol is to 1) change returned struct as desired
    /// 2) atomically persist it with finish_change.
    pub fn start_change(&self) -> TimelinePersistentState {
        let mut s = self.pers.clone();
        s.commit_lsn = self.inmem.commit_lsn;
        s.backup_lsn = self.inmem.backup_lsn;
        s.peer_horizon_lsn = self.inmem.peer_horizon_lsn;
        s.remote_consistent_lsn = self.inmem.remote_consistent_lsn;
        s.proposer_uuid = self.inmem.proposer_uuid;
        s
    }
```

([safekeeper/src/state.rs L213](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/safekeeper/src/state.rs#L213))

**`start_change()` が返すのは「今の永続状態 + 溜まっていたインメモリの値」**だ。つまり `term` を 1 つ上げるために `finish_change()` を呼ぶと、ついでに溜まっていた `commit_lsn` も一緒に永続化される。

**必要な fsync に、不要な fsync を相乗りさせる。** どうせ書くなら全部書く。これで `commit_lsn` は「たまたま何か他の理由で fsync が起きたとき」に永続化されることになり、専用の fsync が消える。

`finish_change` にも節約がある。

```rust title="safekeeper/src/state.rs"
    pub async fn finish_change(&mut self, s: &TimelinePersistentState) -> Result<()> {
        if s.eq(&*self.pers) {
            // nothing to do if state didn't change
        } else {
            self.pers.persist(s).await?;
        }
```

**変わっていなければ書かない。** 「term を最低でも N にする」のような冪等な操作が、実際には何も変えないことがよくある。

## 永続化は rename でアトミックにする

```rust title="safekeeper/src/control_file.rs"
// contains persistent metadata for safekeeper
pub const CONTROL_FILE_NAME: &str = "safekeeper.control";
// needed to atomically update the state using `rename`
const CONTROL_FILE_NAME_PARTIAL: &str = "safekeeper.control.partial";
```

([safekeeper/src/control_file.rs L26](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/safekeeper/src/control_file.rs#L26))

`.partial` に全部書いて、flush して、`durable_rename` で置き換える。

```rust title="safekeeper/src/control_file.rs"
        let control_path = self.timeline_dir.join(CONTROL_FILE_NAME);
        durable_rename(&control_partial_path, &control_path, !self.no_sync)
```

([safekeeper/src/control_file.rs L225](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/safekeeper/src/control_file.rs#L225))

**「途中まで書かれた control file」という状態を作らない**ための定型手順だ。`durable_rename` はファイルの fsync に加えて、親ディレクトリの fsync もやる (rename の永続化にはそれが要る)。

さらに CRC も付く。

```rust title="safekeeper/src/control_file.rs"
        // calculate checksum before resize
        let checksum = crc32c::crc32c(&buf);
        buf.extend_from_slice(&checksum.to_le_bytes());
```

rename でアトミック性は保証されるのに、なぜ CRC が要るのか。**アトミックなのは「置き換え」であって、「書き込んだ内容が正しい」ことではないからだ。** ディスクのビット腐敗、ファイルシステムのバグ、ハードウェアの故障は rename では防げない。

`no_sync` フラグがあるのも実務的だ。テストでは fsync を全部飛ばせる。**テストの速度のために、意図的に安全性を落とす経路を用意する**のは珍しくないが、それが型の外にある `bool` で表現されているのはやや危うい。

## フォーマットバージョンは 10 まで来た

```rust title="safekeeper/src/control_file.rs"
pub const SK_MAGIC: u32 = 0xcafeceefu32;
pub const SK_FORMAT_VERSION: u32 = 10;
```

読み込みはこうなる。

```rust title="safekeeper/src/control_file.rs"
        let version = ReadBytesExt::read_u32::<LittleEndian>(buf)?;
        if version == SK_FORMAT_VERSION {
            let res = TimelinePersistentState::des(buf)?;
            return Ok(res);
        }
        // try to upgrade
        upgrade_control_file(buf, version)
```

([safekeeper/src/control_file.rs L100](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/safekeeper/src/control_file.rs#L100))

`control_file_upgrade.rs` に、v1 から v10 までの全バージョンの構造体定義と変換が残っている。**古い構造体の定義を消せない。** 世の中のどこかに v3 の control file を持つ safekeeper がいるかもしれない限り。

そして書き込み側に、もっと変わった処理がある。

```rust title="safekeeper/src/control_file.rs"
        if self.mconf.generation == INVALID_GENERATION {
            // Temp hack for forward compatibility test: in case of none
            // configuration save cfile in previous v9 format.
            const PREV_FORMAT_VERSION: u32 = 9;
            let prev = downgrade_v10_to_v9(self);
            WriteBytesExt::write_u32::<LittleEndian>(&mut buf, PREV_FORMAT_VERSION)?;
            prev.ser_into(&mut buf)?;
        } else {
            // otherwise, we write the current format version
            WriteBytesExt::write_u32::<LittleEndian>(&mut buf, SK_FORMAT_VERSION)?;
            self.ser_into(&mut buf)?;
        }
```

([safekeeper/src/control_file.rs L169](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/safekeeper/src/control_file.rs#L169))

**新機能 (メンバーシップ設定) を使っていない timeline は、あえて古い形式で書く。** そうすれば、ロールバックして古いバイナリに戻したときにも読める。

これは「前方互換性テストのための一時的なハック」とコメントされているが、やっていることは**段階的ロールアウトの基本形**だ。新形式で書き始めるのは、新機能を実際に使い始めてからでいい。それまでは古い形式で書いておけば、いつでも戻れる。

## eviction 状態も control file にある

```rust title="safekeeper/src/state.rs"
    /// Eviction state of the timeline. If it's Offloaded, we should download
    /// WAL files from remote storage to serve the timeline.
    pub eviction_state: EvictionState,
```

([safekeeper/src/state.rs L69](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/safekeeper/src/state.rs#L69))

**「WAL ファイルがローカルにあるか、S3 に退避したか」も永続状態の一部**になっている ([S3 への WAL バックアップと eviction](../wal-backup-eviction/))。合意プロトコルの状態とストレージ管理の状態が同じファイルに同居しているわけで、きれいな分離ではない。

しかし理由はある。**この 2 つは一緒に更新される必要がある。** 退避したのに「退避した」と記録し損ねたら、ローカルにないファイルを探しに行くことになる。別ファイルに分けると、2 つのファイルの整合を取る問題が新しく生まれる。

**1 つのファイルにまとめる = 1 回の rename で全部が更新される**という性質を取るために、責務の混在を許している。

## この先に効いてくること

- **永続化が要る状態と要らない状態を型で分ける。** `Deref` を永続側に向けることで、誤用が起きにくくなっている。
- **必要な fsync に不要な fsync を相乗りさせる。** どうせ書くなら全部書く。
- **rename + fsync + CRC。** アトミック性と正しさは別の保証。
- **新機能を使うまでは古い形式で書く。** ロールバック可能性を段階的に手放す。
- **一緒に更新される状態は同じファイルに置く。** 責務の分離より整合性を優先することがある。

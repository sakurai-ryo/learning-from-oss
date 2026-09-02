---
title: "term と epoch — WAL を多数決で永続化する"
description: "fsync が過半数の ack に変わると、split brain が生まれる。safekeeper は term と term history という 2 つの状態でそれを防ぐ。Raft のログ整合性検査を、レコード単位ではなく「term が切り替わった LSN の列」でやっているのが特徴になる。"
group: "safekeeper — WAL の合意"
sidebar:
  order: 20
---

## 何を学んだか

safekeeper がやっていることを一言で言うと、**「WAL のバイト列を、過半数で持つ」**になる。ファイルの中身は Postgres の WAL セグメントそのもので、safekeeper はその意味を (ほとんど) 解釈しない。

しかし単に 3 台にコピーするだけでは足りない。compute が再起動して、古い compute がまだ生きていたら、2 つの書き手が同じ WAL ストリームを別の内容で伸ばそうとする。これを防ぐのが合意プロトコルの仕事だ。

状態は 2 つある。

```rust title="safekeeper/src/safekeeper.rs"
/// Persistent consensus state of the acceptor.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AcceptorState {
    /// acceptor's last term it voted for (advanced in 1 phase)
    pub term: Term,
    /// History of term switches for safekeeper's WAL.
    /// Actually it often goes *beyond* WAL contents as we adopt term history
    /// from the proposer before recovery.
    pub term_history: TermHistory,
}
```

([safekeeper/src/safekeeper.rs L257](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/safekeeper/src/safekeeper.rs#L257))

`term` は Raft と同じ。**`term_history` が Neon 固有の工夫になる。**

## term history — 「term が切り替わった LSN」の列

```rust title="safekeeper/src/safekeeper.rs"
pub struct TermLsn {
    pub term: Term,
    pub lsn: Lsn,
}

pub struct TermHistory(pub Vec<TermLsn>);
```

([safekeeper/src/safekeeper.rs L35](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/safekeeper/src/safekeeper.rs#L35))

`[(term=1, lsn=0), (term=5, lsn=1000), (term=7, lsn=5000)]` のような列で、「LSN 0 から 1000 までは term 1 が書いた、1000 から 5000 までは term 5 が書いた、5000 以降は term 7 が書いた」という意味になる。

**なぜこれが要るのか。** Raft では、ログエントリ 1 つ 1 つが term を持っている。だから「index i のエントリの term は何か」がいつでも引ける。safekeeper が持っているのは**バイト列**で、レコードの境界すら意識していない。エントリごとに term を書き込む場所がない。

そこで、term が切り替わった位置だけを記録する。**バイト列に term を埋め込む代わりに、term の変わり目を別の配列に持った。** 情報量は同じで、格納場所が違う。

「LSN X の時点での term」は、この列を LSN で切って最後の要素を見れば分かる。

```rust title="safekeeper/src/safekeeper.rs"
impl AcceptorState {
    /// acceptor's last_log_term is the term of the highest entry in the log
    pub fn get_last_log_term(&self, flush_lsn: Lsn) -> Term {
        let th = self.term_history.up_to(flush_lsn);
        match th.0.last() {
            Some(e) => e.term,
            None => 0,
        }
    }
}
```

([safekeeper/src/safekeeper.rs L202](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/safekeeper/src/safekeeper.rs#L202))

`last_log_term` は Raft の「最後のログエントリの term」に相当する。**選挙で「誰が最も進んでいるか」を比べるとき、`flush_lsn` だけでは足りない。`(last_log_term, flush_lsn)` の辞書順で比べる必要がある。**

古い設計ではこれを `epoch` と呼んでいた。`docs/safekeeper-protocol.md` にその説明が残っている。

> `Epoch` plays almost the same role as `term`, but algorithm of `epoch` bumping is different. (中略) When proposer calculates max(`FlushLSN`), it first compares `Epoch`. So actually we compare (`Epoch`,`FlushLSN`) pairs.

**なぜ `flush_lsn` だけではダメか。** 古い term でたくさん書いた safekeeper と、新しい term で少しだけ書いた safekeeper がいたとき、前者のほうが LSN は大きい。しかし前者のデータは既に上書きされることが決まっている (コミットされなかった) 可能性がある。term が新しいほうを信じないと、コミット済みのデータを失う。

## 投票 — 1 フェーズで、拒否がデフォルト

```rust title="safekeeper/src/safekeeper.rs"
        // initialize with refusal
        let mut resp = VoteResponse {
            generation: self.state.mconf.generation,
            term: self.state.acceptor_state.term,
            vote_given: false,
            flush_lsn: self.flush_lsn(),
            truncate_lsn: self.state.inmem.peer_horizon_lsn,
            term_history: self.get_term_history(),
        };
        if self.state.acceptor_state.term < msg.term {
            let mut state = self.state.start_change();
            state.acceptor_state.term = msg.term;
            // persist vote before sending it out
            self.state.finish_change(&state).await?;

            resp.term = self.state.acceptor_state.term;
            resp.vote_given = true;
        }
```

([safekeeper/src/safekeeper.rs L1069](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/safekeeper/src/safekeeper.rs#L1069))

読みどころが 3 つある。

**1. 拒否で初期化する。** 応答を「拒否」で組み立ててから、条件を満たしたときだけ承認に書き換える。分岐を書き忘れても安全側に倒れる。

**2. 投票を永続化してから返す。** `finish_change` が control file の fsync を含む。ここを飛ばすと、再起動後に同じ term でもう一度投票してしまい、2 つのプロポーザが同時に選ばれる。**Raft の「投票は永続化する」規則そのもの**で、破ると安全性が壊れる箇所だ。

**3. 拒否しても情報は返す。** `term` に自分の現在の term を入れて返すので、プロポーザは「自分より新しい term がいる」ことを知れる。

投票の直前に WAL を flush しているのも意図的だ。

```rust title="safekeeper/src/safekeeper.rs"
        // Once voted, we won't accept data from older proposers; flush
        // everything we've already received so that new proposer starts
        // streaming at end of our WAL, without overlap.
        self.wal_store.flush_wal().await?;
```

**投票した瞬間に古いプロポーザからのデータは受け付けなくなる**ので、その前に受け取ったぶんは確定させておく。そうしないと、新プロポーザに報告した `flush_lsn` と実際にディスクにある量がずれる。

## 選出後 — どこから送り直すか

プロポーザは過半数の投票を集めたら、最も進んだ safekeeper (donor) を選び、そこから WAL を引いて自分の状態を作る。そして各 safekeeper に `ProposerElected` を送る。

このとき、各 safekeeper は自分の WAL のどこから上書きされるかを知る必要がある。分岐点の計算がこれだ。

```rust title="safekeeper/src/safekeeper.rs"
    /// Find point of divergence between leader (walproposer) term history and
    /// safekeeper. Arguments are not symmetric as proposer history ends at
    /// +infinity while safekeeper at flush_lsn.
    /// C version is at walproposer SendProposerElected.
    pub fn find_highest_common_point(
        prop_th: &TermHistory,
        sk_th: &TermHistory,
        sk_wal_end: Lsn,
    ) -> Option<TermLsn> {
```

([safekeeper/src/safekeeper.rs L115](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/safekeeper/src/safekeeper.rs#L115))

**「C version is at walproposer SendProposerElected」** — 同じ計算が C と Rust の両方にある。プロポーザ側が計算した `start_streaming_at` を、safekeeper 側が独立に検算する。

```rust title="safekeeper/src/safekeeper.rs"
        if last_common_point.lsn != msg.start_streaming_at {
            bail!(
                "refusing ProposerElected with unexpected truncation point: lcp={:?} start_streaming_at={}, ...",
```

([safekeeper/src/safekeeper.rs L1162](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/safekeeper/src/safekeeper.rs#L1162))

**送られてきた切り詰め位置を信じず、自分でも計算して一致を確かめる。** データを消す操作なので、相手の言い分だけでは実行しない。

そのうえで、もっと強い assert がある。

```rust title="safekeeper/src/safekeeper.rs"
        // We are also expected to never attempt to truncate committed data.
        assert!(
            msg.start_streaming_at >= self.state.inmem.commit_lsn,
            "attempt to truncate committed data: start_streaming_at={}, commit_lsn={}, ...",
```

([safekeeper/src/safekeeper.rs L1174](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/safekeeper/src/safekeeper.rs#L1174))

**コミット済みのデータを切り詰めようとしたら panic する。** これはプロトコルの安全性そのもので、起きたらプロセスを止めるほうがマシだという判断になっている。前者 (`bail!`) は再接続で直る一過性のエラー、後者 (`assert!`) は直らないバグ、と扱いが分かれている。

その区別もコメントに明記されている。

```rust title="safekeeper/src/safekeeper.rs"
        // This is expected to happen in a rare race when another connection
        // from the same walproposer writes + flushes WAL after this connection
        // sent flush_lsn in VoteRequest; (中略) In such cases error is transient;
        // reconnection makes safekeeper send newest term history and flush_lsn
        // and walproposer recalculates the streaming point. OTOH repeating
        // error indicates a serious bug.
```

**「1 回起きるのは正常、繰り返すのはバグ」**という、分散システムの運用でよくある性質を、コードのコメントに残してある。

## 追記の受け入れ — 3 段の門

`handle_append_request` の頭にも、同じ形の検査が並ぶ。

```rust title="safekeeper/src/safekeeper.rs"
        if self.state.acceptor_state.term < msg.h.term {
            bail!("got AppendRequest before ProposerElected");
        }

        // If our term is higher, immediately refuse the message. Send term only
        // response; elected walproposer can never advance the term, so it will
        // figure out the refusal from it -- which is important as term change
        // should cause not just reconnection but whole walproposer re-election.
        if self.state.acceptor_state.term > msg.h.term {
            let resp = AppendResponse::term_only(...);
            return Ok(Some(AcceptorProposerMessage::AppendResponse(resp)));
        }
```

([safekeeper/src/safekeeper.rs L1308](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/safekeeper/src/safekeeper.rs#L1308))

古い term を拒否するとき、**エラーで接続を切るのではなく、term だけ入った応答を返す。** 理由が書いてある — 「term の変化は、再接続ではなく walproposer 全体の再選出を引き起こすべきだから」。

接続を切ると、プロポーザは「ネットワークの問題かな」と思って再接続する。同じ term のまま。永遠に拒否され続ける。**拒否の理由を伝えないと、相手は正しい復旧手段を選べない。**

さらに書き込み位置の連続性も検査する。

```rust title="safekeeper/src/safekeeper.rs"
        // Disallow any non-sequential writes, which can result in gaps or
        // overwrites. If we need to move the pointer, ProposerElected message
        // should have truncated WAL first accordingly.
        let write_lsn = self.wal_store.write_lsn();
```

**WAL に穴を開けることも、既に書いたところを上書きすることも許さない。** 位置を戻すには `ProposerElected` による明示的な切り詰めが要る。

## commit_lsn の計算

プロポーザは各 safekeeper の `flush_lsn` を集め、**過半数が到達している最大の LSN** を `commit_lsn` とする。3 台なら 2 番目に大きい値だ。

safekeeper 側でも `commit_lsn` を持つが、更新には制約がある。

```rust title="safekeeper/src/safekeeper.rs"
    async fn update_commit_lsn(&mut self, mut candidate: Lsn) -> Result<()> {
        // Both peers and walproposer communicate this value, we might already
        // have a fresher (higher) version.
        candidate = max(candidate, self.state.inmem.commit_lsn);
        let commit_lsn = min(candidate, self.flush_lsn());
        assert!(
            commit_lsn >= self.state.inmem.commit_lsn,
            "commit_lsn monotonicity violated: old={} new={}",
```

([safekeeper/src/safekeeper.rs L1266](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/safekeeper/src/safekeeper.rs#L1266))

**自分が持っていない位置をコミット済みとは言わない** (`min(candidate, flush_lsn)`)。安全側の解釈だ。この safekeeper から WAL を読む pageserver に対して「ここまでは読んでよい」と言う値なので、手元にないものを含めてはいけない。

そして**単調性は assert で守る。** commit_lsn が戻ることは、プロトコルの破綻を意味する。

## この先に効いてくること

- **term history は「term をバイト列に埋め込めない」ことへの答え。** Raft のログエントリごとの term を、切り替え点の列に置き換えた。
- **投票は永続化してから返す。** ここを省くと split brain が起きる。
- **切り詰め位置は受信側でも検算する。** データを消す操作は相手を信じない。
- **一過性のエラーとバグを、`bail!` と `assert!` で書き分ける。**
- **拒否には理由を付ける。** 相手が正しい復旧手段を選べるように。

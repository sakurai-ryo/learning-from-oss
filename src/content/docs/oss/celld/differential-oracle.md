---
title: "正解は本物の上流バイナリから取り、スキップを CI で禁止する"
description: "crates/ltx は Litestream の LTX フォーマットを Rust に移植したもの。期待値を自分の実装から生成せず、本物の `litestream` バイナリと双方向に突き合わせる。ゴールデン fixture は上流ツールで採取し、再生成を禁じる。"
sidebar:
  order: 8
---

## 何を学んだか

### どんな状況の話か

`crates/ltx` は、Litestream (SQLite をオブジェクトストレージへ継続的にバックアップする Go 製ツール) が使う LTX というファイル形式を Rust で実装したクレートだ。celld はこれでセルの SQLite をバケットへ複製する。

既存のフォーマットを別言語で実装するとき、テストの期待値をどこから持ってくるかが問題になる。自分の実装で書いたファイルを自分の実装で読んで一致を確認しても、「読み書きが対称」なことしか分からない。仕様の読み違いがあれば、書く側と読む側で同じ間違いをして、テストは緑のまま上流と非互換になる。

### celld の答え

- **正解 (オラクル) は本物の `litestream` バイナリ。** 自分が書いたものを上流が読めるか、上流が書いたものを自分が読めるか、同じデータを両方で復元してバイト一致するか、圧縮したものを上流が読めるか。4 方向で突き合わせる。
- **fixture (テスト用の固定データ) は上流ツールで採取し、自分で再生成しない。** 不一致は fixture ではなく実装のバグとみなす。
- **オラクルが無い環境でのスキップは、CI では失敗にする。** オラクルをインストールした上でゲート全体をスキップするジョブは「間違った理由で緑」になっている。

## ソースコードのどこか

### 4 方向の差分テスト

[`crates/ltx/tests/differential_xtool.rs#L8-L27`](https://github.com/denoland/celld/blob/v0.3.0/crates/ltx/tests/differential_xtool.rs#L8-L27)。

```rust title="crates/ltx/tests/differential_xtool.rs"
//! This is the strongest correctness oracle in the project. The expected value
//! comes from the real Litestream binary, not from the implementation under test.
//!
//! * **D1 (write path):** rustyriver replicates a DB into a file replica, then the
//!   **real `litestream restore`** reproduces it → **Oracle A** vs the source.
//! * **D2 (restore path):** the **real `litestream replicate`** writes a replica,
//!   then **rustyriver restores** it → **Oracle A** vs the source.
//! * **D3 (format cross-check):** both tools restore the **same** replica → the two
//!   output DB files are **byte-identical** (**Oracle B**, after a TRUNCATE checkpoint).
//! * **D4 (compaction write path):** celld compacts L0 into an L1 object, then the
//!   **real `litestream restore`** reads that object → **Oracle A** vs the source.
```

オラクルのバージョンは 1 箇所に固定され ([`differential_xtool.rs#L92`](https://github.com/denoland/celld/blob/v0.3.0/crates/ltx/tests/differential_xtool.rs#L92) `PINNED_LITESTREAM_VERSION = "0.5.16"`)、実行前にバイナリのバージョンを検証する。

「Oracle A」「Oracle B」の定義は [`crates/ltx/scripts/db_equal.sh`](https://github.com/denoland/celld/blob/v0.3.0/crates/ltx/scripts/db_equal.sh)。A は SQLite の `integrity_check` + スキーマのハッシュ + 全列をソートした行のハッシュで、「同じデータベースか」を見る。B は checkpoint 後のファイルの sha256 で、「バイト単位で同じか」を見る。

### スキップの扱い

[`differential_xtool.rs#L99-L115`](https://github.com/denoland/celld/blob/v0.3.0/crates/ltx/tests/differential_xtool.rs#L99-L115)。

```rust title="crates/ltx/tests/differential_xtool.rs"
/// `CELLD_LTX_LITESTREAM_REQUIRED=1` forbids every skip in this file. A job that
/// installs the oracle and then skips the whole gate is green for the wrong
/// reason, so CI sets this and a failed install reds the run.
fn required() -> bool { ... }

fn unavailable(test: &str, reason: &str) {
    assert!(!required(), "{test}: {reason} (CELLD_LTX_LITESTREAM_REQUIRED=1 forbids the skip)");
    eprintln!("skipping {test}: {reason}");
}
```

ローカルの開発環境では「ログを出して return」で、静かな成功にも失敗にもしない ([`differential_xtool.rs#L29-L37`](https://github.com/denoland/celld/blob/v0.3.0/crates/ltx/tests/differential_xtool.rs#L29-L37))。検証を弱める形のスキップはしない。CI では環境変数を立てるので、バイナリが無ければジョブが赤くなる。S3 の統合テストも同じ `CELLD_LTX_S3_REQUIRED` のパターンだ ([`integration_s3.rs`](https://github.com/denoland/celld/blob/v0.3.0/crates/ltx/tests/integration_s3.rs))。

### ゴールデン fixture

[`crates/ltx/tests/fixtures/golden/MANIFEST.md#L1-L9`](https://github.com/denoland/celld/blob/v0.3.0/crates/ltx/tests/fixtures/golden/MANIFEST.md#L1-L9): "Captured from the **real** upstream tooling. Do not edit or regenerate these fixtures from celld-ltx. A mismatch means the implementation is wrong." 採取に使った litestream と sqlite3 のバージョンを記録し、再採取は [`scripts/capture-golden.sh`](https://github.com/denoland/celld/blob/v0.3.0/crates/ltx/scripts/capture-golden.sh) で行う。

同じ MANIFEST は「書き手のバイト一致は golden と比較して**主張しない**」とも書いている。LTX のヘッダにタイムスタンプが入るためで、代わりに D1 (上流が読めること) がその役を担う。何を比較して何を比較しないかを、fixture の隣に書いている。

### シードはリポジトリ内に固定する

[`crates/ltx/tests/fuzz_parsers.rs#L35-L46`](https://github.com/denoland/celld/blob/v0.3.0/crates/ltx/tests/fuzz_parsers.rs#L35-L46): `const SEED: u64 = 0x5279_5374_795F_5232; // "RySty_R2"` を種にした乱数で 20,000 回のファズ (でたらめな入力を与えて壊れないか見るテスト) を決定論的に回し、失敗時に入力の hex とシードを出力する。[`property_roundtrip.rs`](https://github.com/denoland/celld/blob/v0.3.0/crates/ltx/tests/property_roundtrip.rs) の proptest も「失敗ケースはシードから再現できる」ことを前提に書かれている。

### 上流のテストを移植する

[`crates/ltx/tests/faults_inject.rs#L4-L21`](https://github.com/denoland/celld/blob/v0.3.0/crates/ltx/tests/faults_inject.rs#L4-L21) は上流 Go の `TestReplica_Restore_InvalidFileSize` を移植し、複製データを壊してから復元したときの許容結果を「複製済みの範囲で有効な DB」か「きれいなエラー」の 2 つに限定する。panic は許さない。[`litestream_helpers.rs`](https://github.com/denoland/celld/blob/v0.3.0/crates/ltx/tests/litestream_helpers.rs) は `litestream_test.go` のヘルパーの移植。

### 出自を manifest に残す

[`crates/ltx/Cargo.toml#L1-L8`](https://github.com/denoland/celld/blob/v0.3.0/crates/ltx/Cargo.toml#L1-L8) に、rustyriver → Litestream v0.5 → LTX format という移植の系譜と「celld はこのスナップショットを所有して進化させ、上流ブランチを追跡しない」という方針が書かれている。`LICENSE.pierrec-lz4` のような由来別のライセンスファイルも同梱。

## なぜそうなっているか

- **互換性の定義は上流にしかない。** LTX の仕様書 ([`crates/ltx/reference/ltx-format.md`](https://github.com/denoland/celld/blob/v0.3.0/crates/ltx/reference/ltx-format.md)) を読んで実装しても、解釈違いは自分のテストでは見つからない。本物のバイナリだけが「上流はこう読む」を答えられる。
- **オラクルの不在は環境の問題で、実装の問題ではない。** 開発者のローカルにバイナリがないのは普通なので失敗にはしない。しかし CI はバイナリをインストールする責任があるので、そこで無ければジョブの不備として赤にする。「どの環境で何を要求するか」を環境変数 1 つで切り替えている。
- **fixture を実装から作り直せると、テストは自分自身と比較するだけになる。** 再生成禁止をファイルの先頭に書いておくのは、便利なスクリプトが後から追加されるのを防ぐため。

## どう活かすか

- 既存のフォーマットやプロトコルを再実装するときは、上流の本物の実装を CI に入れて双方向で突き合わせる。片方向 (自分が書いて上流が読む) だけでは、読む側の互換性が抜ける。
- ゴールデン fixture には採取元のツールとバージョンを書き、「実装から再生成しない」を明記する。何を比較して何を比較しないかも隣に書く。
- 環境依存のテストのスキップは、ローカルでは許容し CI では禁止する。`*_REQUIRED=1` のような環境変数で切り替えると、CI 設定の側に「このジョブはオラクルを持つ」責任が明示される。
- ファズやプロパティテストのシードは固定するか、失敗時に必ず出力する。再現できない失敗は結果として扱えない。
- 取り込むべきでない条件: 上流が仕様のみでリファレンス実装を持たない場合は、この形は取れない。その場合は複数の独立した実装との相互運用テストが代替になる。

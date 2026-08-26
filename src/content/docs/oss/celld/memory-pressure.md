---
title: "測定と判断を分け、判断に使う数字は同じ瞬間から取る"
description: "メモリが逼迫したらセルを追い出す判断は、OS が報告する RSS ではなく「RSS からアロケータが抱える空きページを引いた値」で行う。2 つの数字は 1 回の呼び出しで同時に取り、判断は純粋なコアが行う。"
sidebar:
  order: 11
---

## 何を学んだか

### どんな状況の話か

ノードのメモリが足りなくなったら、使っていないセルをメモリから追い出す。この判断には「今どれだけ使っているか」の数字が要る。OS が報告するプロセスのメモリ使用量 (RSS、Resident Set Size) を使いたくなるが、これには落とし穴がある。

Rust のプログラムがメモリを `free` しても、アロケータ (jemalloc など) はそのページをすぐ OS に返さず、次の割り当てに備えて抱えておく。だから RSS には「セルが使っている分」と「アロケータが抱えているだけの分」が混ざっている。RSS で判断すると、セルを追い出しても数字が下がらず、追い出し続けることになる。

### celld の答え

1. **判断に使う数字は「RSS − アロケータの抱え込み」。** 報告 (テレメトリ) には RSS をそのまま使う。
2. **2 つの数字は 1 回の呼び出しで同時に取る。** 別々に取ると、その間に大きな解放があった場合、「使用量が RSS を超える」という存在しなかった状態を報告してしまう。
3. **測定はシェル、判断はコア。** `/proc` や jemalloc の統計を読むのは I/O 層で、閾値との比較やヒステリシス (一度発動したら余裕ができるまで解除しない仕組み) は純粋な分類器が行う。[決定コア](../decision-core/) と同じ理由で、判断をシミュレーションでテストできる。

## ソースコードのどこか

### 1 つの瞬間から 2 つの数字

[`crates/celld/memory.rs#L3-L11`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/memory.rs#L3-L11)。

```rust title="crates/celld/memory.rs"
//! Two numbers, and they must come from one instant. The resident set size is
//! what the operating system reports. The in-use bytes are that number less the
//! pages the allocator keeps after a free, which no cell holds and no eviction
//! returns. The pressure classifier decides on the second and reports the
//! first, so a caller that samples them apart can publish a pair that never
//! existed -- including an in-use figure above the resident set size.
//! [`sample`] is therefore the only way to obtain them.
```

アロケータの抱え込みは jemalloc の `stats.resident - stats.allocated` で求める ([`memory.rs#L70-L84`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/memory.rs#L70-L84))。この統計を有効にする `stats` feature について、[`Cargo.toml#L111-L116`](https://github.com/denoland/celld/blob/v0.3.0/Cargo.toml#L111-L116) は「無いと、全セルを追い出したノードが、アロケータの都合で決まる RSS の値に引っかかったままになる」と説明する。

シェル側の呼び出し ([`crates/celld/actor.rs#L2526-L2528`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/actor.rs#L2526-L2528)) も一言添える: "Both numbers: a gap between them is memory the allocator kept, which no eviction returns. One sample, so they cannot disagree."

### 判断は純粋なコアで

[`crates/logic/pressure.rs#L3-L14`](https://github.com/denoland/celld/blob/v0.3.0/crates/logic/pressure.rs#L3-L14) のモジュールコメント。I/O も時計も無い分類器で、環境変数の読み取りは `main.rs` に留める。常駐セル数の判断はわざと別にする — "Conflating the two produced the placement churn and the admission wedge; splitting them is what keeps each decision small." (2 つを混ぜたら配置の揺れと受け入れの詰まりが起きた。分けることで各判断が小さく保てる)。

[`crates/celld/machine.rs#L123-L143`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/machine.rs#L123-L143): "The arithmetic lives in the core, where it is tested; the shell supplies only the two facts it can read."

### 閾値の算術

[`pressure.rs#L114-L140`](https://github.com/denoland/celld/blob/v0.3.0/crates/logic/pressure.rs#L114-L140) の `from_limits`。既定の天井は `total / 5 * 4` (80%)、ハードキャップは `total / 100 * 95`。[`pressure.rs#L115-L119`](https://github.com/denoland/celld/blob/v0.3.0/crates/logic/pressure.rs#L115-L119) は「ゼロの閾値は閾値無しより悪い: 全サンプルが超え、どれも解除できない。Linux は cgroup の limit `0` に対して 0 を返す」と、ゼロを特別扱いする理由を書く。

ハードキャップを天井から導出しない理由 ([`pressure.rs#L36-L41`](https://github.com/denoland/celld/blob/v0.3.0/crates/logic/pressure.rs#L36-L41), [`#L105-L109`](https://github.com/denoland/celld/blob/v0.3.0/crates/logic/pressure.rs#L105-L109)): 「天井の 125% 以上」にすると既定の 80% では機械の 100% になり、カーネルが到達させない値なので出荷設定で下限が存在しなかった。「両方ともこのファイルで出荷されたことがあり、どちらも下限ではない」。

ヒステリシスは閾値ごとに独立したラッチで、解除は閾値の 80% ([`pressure.rs#L166-L193`](https://github.com/denoland/celld/blob/v0.3.0/crates/logic/pressure.rs#L166-L193))。定義を 1 箇所にする理由は "One definition, because two callers read it ... Two copies of the arithmetic drift" (2 箇所に書くと食い違っていく)。追い出す量は 1 ステップで常駐セルの 10% (最低 1) — 「追い出しの効果は次のサンプルまで見えない」ため ([`pressure.rs#L225-L227`](https://github.com/denoland/celld/blob/v0.3.0/crates/logic/pressure.rs#L225-L227))。

### アロケータの後始末

[`memory.rs#L86-L101`](https://github.com/denoland/celld/blob/v0.3.0/crates/celld/memory.rs#L86-L101) は jemalloc の background thread を有効にする。抱え込んだページを OS に返す処理は「次にどれかのスレッドがアロケータを呼んだとき」にしか走らず、セルを追い出した直後のノードはそれを呼ばない。"This repairs what RSS reports, not the decision." — これは RSS の報告値を直すもので、判断には影響しない。判断と報告を分けているからこそ、こう言える。

## なぜそうなっているか

- **OS が報告する RSS は判断材料として不正確。** free 済みだがアロケータが返していないページを含むので、追い出しても下がらない。それで判断すると「追い出し続けるが数字が変わらない」ループになる。
- **2 つの数字の間隔は嘘の元。** RSS を先に読み、次に jemalloc の統計を読む間に大きな解放があると、使用量が RSS を上回る。テレメトリに「存在しなかった状態」を出すことになる。
- **判断をコアに置くと、ヒステリシスがテストできる。** [決定コア](../decision-core/) と同じ理由。

## どう活かすか

- リソース圧の判定では「OS の数字」と「実際に使っている数字」を区別し、判断は後者、報告は前者にする。
- 複数の指標を組み合わせて判断するなら、1 回の関数呼び出しで全部を取る API にして、バラバラにサンプルできないようにする。
- 閾値の既定値は、他の閾値からの導出ではなく機械の固定割合にする。導出は「既定値の組み合わせで意味を失う」ことがある。ゼロや上限の特殊値を明示的に扱う。
- ヒステリシスの上下の定義は 1 箇所に置く。
- 取り込むべきでない条件: アロケータを差し替えられない環境では、抱え込みの測定手段が無いので RSS で判断せざるを得ない。その場合は「追い出しても下がらない」ことを前提に、ラッチの解除に別の条件 (時間経過など) を入れる必要がある。

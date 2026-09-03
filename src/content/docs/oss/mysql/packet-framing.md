---
title: "パケット — 4 バイトヘッダ、16MB 分割、圧縮"
description: "MySQL のワイヤ形式は 3 バイト長 + 1 バイト連番の 4 バイトヘッダだけでできている。長さが 3 バイトしかないので 16MB を超えるペイロードは 0xFFFFFF の連鎖で分割され、その分割コードは送信側に 2 つ独立に存在する。max_allowed_packet はサーバとクライアントの両方が別々に持つ上限で、Got a packet bigger than 'max_allowed_packet' bytes がどちら側から出たのかで対処が変わる。圧縮を有効にすると 7 バイトヘッダの外側フレームがもう 1 層かぶさる。"
group: "接続とプロトコル"
sidebar:
  order: 14
---

## 何を学んだか

MySQL のワイヤ形式は驚くほど単純で、**4 バイトのヘッダしかない**。

```
非圧縮パケット
+----------+----------+----------+----------+-------------------------+
|  byte 0  |  byte 1  |  byte 2  |  byte 3  |  payload (length バイト) |
+----------+----------+----------+----------+-------------------------+
|      payload length (LE, 24bit)|  seq nr  |                         |
+--------------------------------+----------+-------------------------+
```

ここから 4 つの帰結が出る。

1. **1 パケットのペイロードは最大 0xFFFFFF = 16777215 バイト。** これを超える論理パケットは、`0xFFFFFF` の物理パケットを並べ、最後に `< 0xFFFFFF` のパケット (長さ 0 でもよい) を置いて終端する
2. **連番は 1 バイトで、255 の次は 0 に戻る。** リセットされるのはコマンドの境界だけ。ずれたら `Got packets out of order`
3. **長さの上限を決めるのはヘッダではなく `max_allowed_packet`。** サーバとクライアントが別々の値を持ち、どちらでも `ER_NET_PACKET_TOO_LARGE` が出る
4. **圧縮を有効にすると、この 4 バイトヘッダの外側に 7 バイトのヘッダがもう 1 層かぶる。** 内側の論理パケットは変わらない

そして実装上の面白い点として、**16MB 分割のコードは送信側に 2 つ、独立に書かれている**。`my_net_write` (結果セットの行など) と `net_write_command` (コマンドの送信) で、しかも境界の計算が微妙に違う。

## ソースコードのどこか

定数はすべて [`include/mysql_com.h`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/include/mysql_com.h#L108) にある。

```cpp title="include/mysql_com.h"
#define MAX_PACKET_LENGTH (256L * 256L * 256L - 1)
```

```cpp title="include/mysql_com.h"
#define NET_HEADER_SIZE 4  /**< standard header size */
#define COMP_HEADER_SIZE 3 /**< compression header extra size */
```

[L1123](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/include/mysql_com.h#L1123)。実装は [`sql-common/net_serv.cc`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql-common/net_serv.cc) 1 ファイルに集約されていて、**サーバとクライアントが同じコードをリンクしている** (`#ifdef MYSQL_SERVER` で分岐する)。

### 送信 1 — `my_net_write`

```cpp title="sql-common/net_serv.cc"
  /*
    Big packets are handled by splitting them in packets of MAX_PACKET_LENGTH
    length. The last packet is always a packet that is < MAX_PACKET_LENGTH.
    (The last packet may even have a length of 0)
  */
  while (len >= MAX_PACKET_LENGTH) {
    const ulong z_size = MAX_PACKET_LENGTH;
    int3store(buff, z_size);
    buff[3] = (uchar)net->pkt_nr++;
    if (net_write_buff(net, buff, NET_HEADER_SIZE) ||
        net_write_buff(net, packet, z_size)) {
      return true;
    }
    packet += z_size;
    len -= z_size;
  }
  /* Write last packet */
  int3store(buff, static_cast<uint>(len));
  buff[3] = (uchar)net->pkt_nr++;
```

[`my_net_write` (L443)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql-common/net_serv.cc#L443)。`len` がちょうど 16MB の倍数のとき、最後に**長さ 0 のパケット**が飛ぶ。これがないと受信側は「まだ続きがある」と解釈してしまう。

`buff[3] = (uchar)net->pkt_nr++` のキャストが連番の 1 バイト巻き戻しをやっている。`net->pkt_nr` 自体は `uchar` なので、257 個目のパケットで自然に 1 に戻る。

サーバが結果セットの 1 行を書くとき ([`Protocol_classic::end_row`](./text-protocol-and-resultset/)) に呼ばれるのがこの関数だ。

### 送信 2 — `net_write_command`

コマンド (`COM_QUERY` など) はコマンドバイトを 1 個先頭に足す必要があるので、別の関数になっている。

```cpp title="sql-common/net_serv.cc"
  buff[4] = command; /* For first packet */

  if (length >= MAX_PACKET_LENGTH) {
    /* Take into account that we have the command in the first header */
    len = MAX_PACKET_LENGTH - 1 - head_len;
    do {
      int3store(buff, MAX_PACKET_LENGTH);
      buff[3] = (uchar)net->pkt_nr++;
      if (net_write_buff(net, buff, header_size) ||
          net_write_buff(net, header, head_len) ||
          net_write_buff(net, packet, len)) {
        return true;
      }
      packet += len;
      length -= MAX_PACKET_LENGTH;
      len = MAX_PACKET_LENGTH;
      head_len = 0;
      header_size = NET_HEADER_SIZE;
    } while (length >= MAX_PACKET_LENGTH);
    len = length; /* Data left to be written */
  }
```

[`net_write_command` (L879)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql-common/net_serv.cc#L879)。**最初の 1 パケットだけ `MAX_PACKET_LENGTH - 1 - head_len` バイトしか運べない**のがポイントだ。コマンドバイト 1 個と、あれば追加ヘッダ (prepared statement の stmt_id など) がその分を食う。2 パケット目以降は `header_size` を `NET_HEADER_SIZE` に戻し、丸ごと 16MB を運ぶ。

つまり同じ 16MB 分割でも、`my_net_write` は「ペイロードを 16MB ずつ」、`net_write_command` は「コマンドバイト込みで 16MB ずつ」という違いがある。片方を読んで分かったつもりになると、もう片方でずれる。

`net_write_command` は最後に `net_flush(net)` を呼ぶ。`my_net_write` は呼ばない。**コマンドは送ったら即座に出す、結果セットの行はバッファに溜める**、という非対称もここにある。

### バッファリング — `net_write_buff`

```cpp title="sql-common/net_serv.cc"
  @note
    The cached buffer can be sent as it is with 'net_flush()'.
    In this code we have to be careful to not send a packet longer than
    MAX_PACKET_LENGTH to net_write_packet() if we are using the compressed
    protocol as we store the length of the compressed packet in 3 bytes.
```

[`net_write_buff` (L945)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql-common/net_serv.cc#L945)。書き込みは `net->buff` (大きさ `net->max_packet` = `net_buffer_length`) に溜まり、溢れたら `net_write_packet` で実際に `write(2)` される。**結果セットの何行かがまとめて 1 回の syscall で出る**のはこの層の効果だ。

`net->buff` は必要に応じて `net_realloc` で伸びる。ここが `max_allowed_packet` の門になっている。

```cpp title="sql-common/net_serv.cc"
bool net_realloc(NET *net, size_t length) {
  ...
  if (length >= net->max_packet_size) {
    DBUG_PRINT("error",
               ("Packet too large. Max size: %lu", net->max_packet_size));
    /* Error, but no need to stop using the socket. */
    net->error = NET_ERROR_SOCKET_RECOVERABLE;
    net->last_errno = ER_NET_PACKET_TOO_LARGE;
#ifdef MYSQL_SERVER
    my_error(ER_NET_PACKET_TOO_LARGE, MYF(0));
#endif
    return true;
  }
```

[L217](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql-common/net_serv.cc#L217)。`ER_NET_PACKET_TOO_LARGE` が `Got a packet bigger than 'max_allowed_packet' bytes` の正体だ。**エラーは `NET_ERROR_SOCKET_RECOVERABLE` で、ソケットは殺さない。**

### `max_packet` と `max_packet_size` は別物

`NET` 構造体には似た名前のフィールドが 2 つある。

| フィールド             | 意味                             | 初期値                                       |
| ---------------------- | -------------------------------- | -------------------------------------------- |
| `net->max_packet`      | いま確保しているバッファの大きさ | `net_buffer_length` (既定 16384)             |
| `net->max_packet_size` | 伸ばしてよい上限                 | `max(net_buffer_length, max_allowed_packet)` |

サーバ側の初期化はこれだけだ。

```cpp title="sql/sql_client.cc"
void my_net_local_init(NET *net) {
  net->max_packet = (uint)global_system_variables.net_buffer_length;

  my_net_set_read_timeout(net, (uint)global_system_variables.net_read_timeout);
  my_net_set_write_timeout(net,
                           (uint)global_system_variables.net_write_timeout);

  net->retry_count = (uint)global_system_variables.net_retry_count;
  net->max_packet_size =
      max<size_t>(global_system_variables.net_buffer_length,
                  global_system_variables.max_allowed_packet);
}
```

[`sql/sql_client.cc#L39`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/sql_client.cc#L39)。**`global_system_variables` を読んでいる**ことに注意。`max_allowed_packet` は `SESSION_VAR` ([`sys_vars.cc#L2752`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/sys_vars.cc#L2752)、既定 64MB) だが、`NET` にコピーされるのは接続を作った時点のグローバル値だ。セッションで `SET max_allowed_packet` しても `net->max_packet_size` は変わらない。

クライアント側は別経路で入る。

```cpp title="sql-common/client.cc"
  if (mysql->options.max_allowed_packet)
    net->max_packet_size = mysql->options.max_allowed_packet;
```

[`client.cc#L6848`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql-common/client.cc#L6848)。`mysql_options(MYSQL_OPT_MAX_ALLOWED_PACKET, ...)` で指定した値。**同じエラーメッセージがクライアント側からも出る。**

レプリカだけは明示的に上書きする。

```cpp title="sql/rpl_replica.cc"
  thd->get_protocol_classic()->set_max_packet_size(replica_max_allowed_packet +
```

[`rpl_replica.cc#L401`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/rpl_replica.cc#L401)。`replica_max_allowed_packet` の既定は `max_log_event_size` ([`sys_vars.cc#L2760`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/sys_vars.cc#L2760))。巨大なトランザクションのイベントが `max_allowed_packet` に引っかかってレプリケーションが止まらないようにするためだ。

### 受信 — 連番の検算と再結合

ヘッダを読む [`net_read_packet_header` (L1482)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql-common/net_serv.cc#L1482) が、連番を検算する。

```cpp title="sql-common/net_serv.cc"
  pkt_nr = net->buff[net->where_b + 3];

  /*
    Verify packet serial number against the truncated packet counter.
    The local packet counter must be truncated since its not reset.
  */
  if (pkt_nr != (uchar)net->pkt_nr) {
```

サーバ側では即 `ER_NET_PACKETS_OUT_OF_ORDER`。クライアント側だけは、**「サーバが `wait_timeout` でエラーを送ってきた可能性」を先に疑う**分岐がある ([接続層のページ](./connection-layer/))。

再結合は `my_net_read` の側。

```cpp title="sql-common/net_serv.cc"
      len = net_read_packet(net, &complen);
    } while (len == MAX_PACKET_LENGTH);
    if (len != packet_error) len += total_length;
    net->where_b = save_pos;
  }
  net->read_pos = net->buff + net->where_b;
  if (len != packet_error)
    net->read_pos[len] = 0; /* Safeguard for mysql_use_result */
```

[L2225 付近](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql-common/net_serv.cc#L2225)。`len == MAX_PACKET_LENGTH` である限りループする、というのがそのまま「16MB の連鎖」の受信側だ。読み終わったバッファの末尾に `\0` を置くのは、[`mysql_use_result`](./client-library-and-streaming/) で行データを C 文字列として扱うためのお守りになっている。

### 圧縮 — 外側にもう 1 層

`CLIENT_COMPRESS` か `CLIENT_ZSTD_COMPRESSION_ALGORITHM` を交渉すると、[`prepare_new_connection_state`](./connection-layer/) が `net->compress = true` を立てる。以後、`net_write_packet` が実際に書く直前に外側フレームを付ける。

```
圧縮パケット
+--------------------------+----------+--------------------------+---------------+
| compressed length (24bit)|  seq nr  | uncompressed length (24) | 圧縮ペイロード |
+--------------------------+----------+--------------------------+---------------+
 <-------- NET_HEADER_SIZE (4) -------> <-- COMP_HEADER_SIZE (3) -->
```

```cpp title="sql-common/net_serv.cc"
  /* Compress the encapsulated packet. */
  if (my_compress(compress_ctx, compr_packet + header_length, length,
                  &compr_length)) {
    /*
      If the length of the compressed packet is larger than the
      original packet, the original packet is sent uncompressed.
    */
    compr_length = 0;
  }

  /* Length of the compressed (original) packet. */
  int3store(&compr_packet[NET_HEADER_SIZE], static_cast<uint>(compr_length));
  /* Length of this packet. */
  int3store(compr_packet, static_cast<uint>(*length));
  /* Packet number. */
  compr_packet[3] = (uchar)(net->compress_pkt_nr++);
```

[`compress_packet` (L1255)](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql-common/net_serv.cc#L1255)。ここに 2 つの罠がある。

**「uncompressed length が 0」は「圧縮していない」の意味だ。** 変数名が `compr_length` なのに `int3store(&compr_packet[NET_HEADER_SIZE], compr_length)` で書かれ、圧縮しなかったら 0 になる。この 3 バイトは「展開後のサイズ、ただし 0 なら非圧縮」という兼用フィールドになっている。

**連番が 2 系統ある。** `net->pkt_nr` (内側の論理パケット) と `net->compress_pkt_nr` (外側の圧縮パケット) が別々に進む。受信側の `net_read_packet` は毎回 `net->compress_pkt_nr = net->pkt_nr` で同期を取り直している。

## なぜそうなっているか

**長さを 3 バイトにしたのは、当時の 4 バイト整列より 1 バイト削ることを優先したからだ。** 結果として 16MB という上限が生まれ、それを超えるために「0xFFFFFF が続いたら次がある」という可変長エンコーディングを後から被せることになった。3 バイト長 + 1 バイト連番でちょうど 4 バイトに収まっているので、アラインメントの意味では損はしていない。

**連番があるのは、`SEQ` のようなセッション再開のためではなく、パケットの取りこぼしを検出するためだ。** TCP はバイトストリームの順序を保証するので、本来ならこのフィールドは要らない。実際に効くのは「サーバが前のコマンドの残りを送っている最中にクライアントが次のコマンドを送った」ような、**プロトコルの状態がずれたケース**で、そのときに黙って壊れたデータを解釈するかわりに `Got packets out of order` で止まる。[`mysql_use_result` で結果を読み切らずに次のクエリを送る](./client-library-and-streaming/)と、まさにこれになる。

**`max_allowed_packet` が送受信の両側にあるのは、これがメモリ確保の上限だからだ。** `net_realloc` が伸ばすのは 1 接続あたりのバッファで、`max_connections` 分だけ同時に存在しうる。64MB × 151 接続 = 9.6GB という掛け算が成立してしまうので、上限を持たせるしかない。逆に言えば、**この値を上げると「上げた側」のメモリ使用量の上限が上がる。**

**16MB 分割のコードが 2 つあるのは、コマンドバイトを詰める場所が特殊だからだ。** `net_write_command` は「コマンドバイト + 追加ヘッダ + ペイロード」という 3 分割の入力を、コピーせずに 1 本のパケットにしたい。そのために `uchar buff[NET_HEADER_SIZE + 1]` という 5 バイトのローカル配列を作って、4 バイトヘッダとコマンドバイトを 1 回の `net_write_buff` で書いている。この芸当のせいで、境界計算を `my_net_write` と共有できなくなった。

**圧縮を「もう 1 層のフレーム」にしたのは、内側を触らずに後付けするためだ。** 論理パケットの構造も連番も変えないので、上位層 (`Protocol_classic`、`Prepared_statement`) は圧縮の有無を知らなくてよい。代償として、**圧縮パケットの境界と論理パケットの境界が一致しない**ので、受信側は「バッファに溜めて論理パケット単位で切り出す」という状態を持つことになった (`net_read_compressed_packet` の `start_of_packet` / `first_packet_offset` / `multi_byte_packet` の 3 変数)。

## どう活かすか

**`Got a packet bigger than 'max_allowed_packet' bytes` は、どちら側から出たかを先に決める。**

| 状況                                                  | 出ている側   | 直す変数                                                                                                                                        |
| ----------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 巨大な `INSERT` / `LOAD DATA` / BLOB の書き込みが失敗 | サーバ       | サーバの `max_allowed_packet` (グローバル、要再接続)                                                                                            |
| 大きな BLOB を `SELECT` して失敗                      | クライアント | 接続オプション。mysql2 なら `maxPreparedStatements` ではなく `maxAllowedPacket` 相当のライブラリ設定、C API なら `MYSQL_OPT_MAX_ALLOWED_PACKET` |
| レプリカが `ER_NET_PACKET_TOO_LARGE` で止まる         | レプリカ     | `replica_max_allowed_packet`                                                                                                                    |

**サーバ側は `SET GLOBAL max_allowed_packet` してもすでに張っている接続には効かない。** `my_net_local_init` は `my_net_init`、つまり接続を作るときにしか呼ばれない。設定変更後に張り直した接続からしか反映されない。

**`net_buffer_length` は「最初に確保する量」であって上限ではない。** `net_realloc` が `max_allowed_packet` まで伸ばす。逆に、`do_command` は毎コマンドの前後で `shrink(net_buffer_length)` を呼んで縮めているので ([`sql_parse.cc#L1458`](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/sql/sql_parse.cc#L1458))、一度大きなパケットを扱っても常駐はしない。

**`Got packets out of order` はプロトコル状態のずれで、ネットワークの問題ではない。** 典型的には (a) ストリーミング中に別のクエリを送った、(b) タイムアウトで切られた接続をプールが再利用した、(c) 同じ接続を複数スレッドで共有した、のどれか。TCP の再送やパケットロスではこのエラーは出ない。

**圧縮は CPU と帯域のトレードオフだが、レイテンシも増える。** `net_write_packet` のたびに `my_malloc` で作業バッファを取って圧縮している (`compress_packet` の先頭)。ローカルネットワークで小さい結果セットをやりとりする用途では、圧縮を有効にすると遅くなる。効くのは「大きな結果セットを細い回線で運ぶ」ケースで、`SHOW GLOBAL STATUS` の `Bytes_sent` / `Bytes_received` で圧縮前後を比べる。

**`net_write_timeout` は「バッファを書き出せない時間」の上限だ。** 結果セットの送信中にクライアントが読まなくなると、TCP の送信バッファが埋まり `write(2)` がブロックし、この timeout に当たって接続が切られる。行数の多いクエリで遅いクライアントに送っていると踏む ([行の返送のページ](./sending-rows-and-limit/))。逆に言えば、**サーバスレッドは行を送っている間ずっとそのクエリの資源を握ったままだ。**

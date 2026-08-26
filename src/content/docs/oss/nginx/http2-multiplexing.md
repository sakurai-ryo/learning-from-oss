---
title: "多重化を、既存の「1 接続 1 リクエスト」のコードに触らずに載せる"
description: "HTTP/2 のストリームごとに、本物の接続を丸ごとコピーした「偽の ngx_connection_t」を作る。リクエスト処理から見ると、それはただの接続に見える。フロー制御で送れないときは偽の接続の write->ready を 0 にするだけで、上位のコードは「まだ書けない」といういつもの状態として扱う。1 スレッドのイベントループを、そのままストリームのスケジューラとして流用している。"
sidebar:
  order: 19
---

## 何を学んだか

### どんな状況の話か

Nginx のリクエスト処理は「1 本の TCP 接続の上を、1 つのリクエストが順に流れる」という前提で書かれている。[ステートマシン](../state-machine/) の `c->read->handler`、[出力フィルタチェーン](../output-filter-chain/) の `c->send_chain`、[接続の再利用](../connection-reuse/) の keepalive。どれも `ngx_connection_t` が 1 つのリクエストに対応することを暗黙に仮定している。

HTTP/2 はこれを壊す。1 本の TCP 接続の上に複数のストリームが並び、各ストリームが独立したリクエストになる。ストリーム 1 の応答を送っている途中でストリーム 3 のリクエストが届く。しかもフロー制御があり、**「このストリームには今これ以上送れない」** という状態が個別に存在する。

素直に対応しようとすると、`ngx_http_request_t` から `ngx_connection_t` への参照を「ストリームか接続か」の分岐だらけにすることになる。25 万行のコードベースで、それは現実的でない。

### Nginx の答え

1. **ストリームごとに、偽の `ngx_connection_t` を作る。** しかも本物の接続を `ngx_memcpy` で丸ごとコピーして作る。
2. **偽の接続には偽の読みイベントと書きイベントを持たせる。** `epoll` には登録しない。フラグだけを Nginx 自身が操作する。
3. **リクエスト処理は完全にそのまま。** `ngx_http_create_request(fc)` を呼べば、あとは HTTP/1.1 と同じ道を通る。
4. **`fc->send_chain` を差し替える。** 出力フィルタチェーンの最後に来る書き出しだけが、HTTP/2 のフレーム化に変わる。
5. **フロー制御は `fc->write->ready = 0` で表す。** 「今は書けない」という、Nginx が既に持っている概念にマッピングする。
6. **WINDOW_UPDATE が来たら `ready = 1` にして handler を呼ぶ。** 「書けるようになった」という、これも既にある概念になる。
7. **偽の接続を使い回す。** ストリームが閉じたら `free_fake_connections` に戻す。
8. **本物の接続の読み handler は、フレームのパーサに置き換わる。** そこから各ストリームに配る。

## ソースコードのどこか

### 本物の接続をコピーして偽物を作る

[`src/http/v2/ngx_http_v2.c#L2987-L3110`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/v2/ngx_http_v2.c#L2987-L3110)。

```c title="src/http/v2/ngx_http_v2.c"
    fc = h2c->free_fake_connections;

    if (fc) {
        h2c->free_fake_connections = fc->data;

        rev = fc->read;
        wev = fc->write;
        log = fc->log;
        ctx = log->data;

    } else {
        fc = ngx_palloc(h2c->pool, sizeof(ngx_connection_t));
        /* ... rev, wev, log, ctx も確保 ... */
    }

    ngx_memcpy(log, h2c->connection->log, sizeof(ngx_log_t));

    log->data = ctx;
    log->action = "reading client request headers";

    ngx_memzero(rev, sizeof(ngx_event_t));

    rev->data = fc;
    rev->ready = 1;
    rev->handler = ngx_http_v2_close_stream_handler;
    rev->log = log;

    ngx_memcpy(wev, rev, sizeof(ngx_event_t));

    wev->write = 1;

    ngx_memcpy(fc, h2c->connection, sizeof(ngx_connection_t));

    fc->data = h2c->http_connection;
    fc->read = rev;
    fc->write = wev;
    fc->sent = 0;
    fc->log = log;
    fc->buffered = 0;
    fc->sndlowat = 1;
    fc->tcp_nodelay = NGX_TCP_NODELAY_DISABLED;

    r = ngx_http_create_request(fc);
```

**`ngx_memcpy(fc, h2c->connection, sizeof(ngx_connection_t))`** が核心だ。偽の接続は、本物の接続の完全なコピーから始まる。だから `fc->sockaddr`、`fc->local_sockaddr`、`fc->ssl`、`fc->listening`、`fc->fd` — 全部が本物と同じ値を持つ。

これで `$remote_addr` も `$ssl_protocol` も `$server_port` も、**[変数のページ](../variables/) のハンドラを一切変えずに正しい値を返す**。コピーしなければ、変数のハンドラ全部に「HTTP/2 なら親の接続を見る」という分岐が要った。

コピーした後で上書きするのは 7 個だけ。`read` / `write` (偽のイベントに差し替え)、`sent` / `buffered` (ストリームごとにカウント)、`log` (ストリームごとのログ文脈)、`data`、`sndlowat` / `tcp_nodelay` (TCP のパラメータは意味を持たない)。

**変えるものだけを列挙する**形になっているので、「HTTP/2 のストリームが本物の接続と違うのは何か」が 7 行で読める。

`rev->ready = 1` で **偽の読みイベントは常に「読める」状態**にしておく。データは Nginx 自身がフレームから取り出して渡すので、`recv()` を呼ぶことはない。

`ngx_http_create_request(fc)` から先は、[ステートマシンのページ](../state-machine/) で見た HTTP/1.1 とまったく同じ関数だ。

### 偽の接続の使い回し

`h2c->free_fake_connections` は、[接続の再利用のページ](../connection-reuse/) の `ngx_cycle->free_connections` と同じ形をしている。`fc->data` を next ポインタに流用した単方向リスト。

ストリームは短命で、1 本の TCP 接続の上で何百も作られては消える。**毎回 `ngx_palloc` すると、接続プールが単調に増える** ([メモリプールのページ](../memory-pool/) のとおり、プールは個別解放できない)。だから使い回す。

`log` と `ctx` も一緒に使い回されていて、再利用時は `ngx_memcpy(log, h2c->connection->log, ...)` で中身だけ上書きする。

### 出力だけを差し替える

[`src/http/v2/ngx_http_v2_filter_module.c#L820-L838`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/v2/ngx_http_v2_filter_module.c#L820-L838)。

```c title="src/http/v2/ngx_http_v2_filter_module.c"
    if (stream->initialized) {
        return NGX_OK;
    }

    stream->initialized = 1;

    cln = ngx_http_cleanup_add(r, 0);
    if (cln == NULL) {
        return NGX_ERROR;
    }

    cln->handler = ngx_http_v2_filter_cleanup;
    cln->data = stream;

    fc->send_chain = ngx_http_v2_send_chain;
    fc->need_last_buf = 1;
    fc->need_flush_buf = 1;

    return NGX_OK;
```

**差し替えるのは `send_chain` の 1 本だけ。** [出力フィルタチェーンのページ](../output-filter-chain/) の `ngx_http_write_filter` は `c->send_chain(c, r->out, limit)` を呼ぶので、そこが HTTP/2 のフレーム化に化ける。gzip も SSI も range も、その上流にいるフィルタは何も変わらない。

`need_last_buf` / `need_flush_buf` は、[出力フィルタチェーンのページ](../output-filter-chain/) で見た `ngx_http_write_filter` の判定に使われる。

```c title="src/http/ngx_http_write_filter_module.c"
    if (size == 0
        && !(c->buffered & NGX_LOWLEVEL_BUFFERED)
        && !(last && c->need_last_buf)
        && !(flush && c->need_flush_buf))
```

HTTP/1.1 では「サイズ 0 の最終 buf」は送る意味がないが、HTTP/2 では **END_STREAM フラグ付きの空 DATA フレームを送る必要がある**。「サイズ 0 でも送ってほしい」という要求を、接続のフラグ 2 つで表現している。

ヘッダのほうも同じで、`ngx_http_v2_header_filter` が `ngx_http_top_header_filter` に登録される。[出力フィルタチェーン](../output-filter-chain/) の `auto/modules` の並びで `ngx_http_v2_filter_module` が `ngx_http_header_filter_module` の直後に置かれているので、**HTTP/1.1 のテキストのヘッダを生成する手前で横取りする**位置になる。

### フロー制御を「書けない」に翻訳する

`ngx_http_v2_send_chain` の冒頭 ([`#L1111-L1122`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/v2/ngx_http_v2_filter_module.c#L1111-L1122))。

```c title="src/http/v2/ngx_http_v2_filter_module.c"
    if (size && ngx_http_v2_flow_control(h2c, stream) == NGX_DECLINED) {

        if (ngx_http_v2_filter_send(fc, stream) == NGX_ERROR) {
            return NGX_CHAIN_ERROR;
        }

        if (ngx_http_v2_flow_control(h2c, stream) == NGX_DECLINED) {
            fc->write->active = 1;
            fc->write->ready = 0;
            return in;
        }
    }
```

**フロー制御のウィンドウが尽きたら、`fc->write->ready = 0` にして、送れなかったチェーンをそのまま返す。**

これが起こすことを追うと面白い。`ngx_http_write_filter` は返ってきたチェーンを `r->out` に残して `NGX_AGAIN` を返す。[出力フィルタチェーン](../output-filter-chain/) を遡って `ngx_http_output_filter` が `NGX_AGAIN` を返し、`ngx_http_upstream` や静的ファイルの handler が「まだ書けない」として中断する。**[ステートマシンのページ](../state-machine/) の `NGX_AGAIN` の扱いが、そのまま HTTP/2 のフロー制御になっている。**

`fc->write->active = 1` は「カーネルに登録済み」の意味だが、偽の接続なので実際には登録されていない。ここでは **「誰かが起こしてくれるのを待っている」の印**として使われている。フラグの意味を少しずらして流用している。

### 起こす側

WINDOW_UPDATE フレームを受け取ったとき ([`src/http/v2/ngx_http_v2.c#L2473-L2489`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/v2/ngx_http_v2.c#L2473-L2489))。

```c title="src/http/v2/ngx_http_v2.c"
        stream->send_window += window;

        if (stream->exhausted) {
            stream->exhausted = 0;

            wev = stream->request->connection->write;

            wev->active = 0;
            wev->ready = 1;

            if (!wev->delayed) {
                wev->handler(wev);
            }
        }
```

**`ready = 1` にして handler を呼ぶだけ。** `wev->handler` は `ngx_http_request_handler` ([ステートマシンのページ](../state-machine/)) で、そこから `r->write_event_handler` が呼ばれ、リクエストが中断したところから再開する。

`epoll` から「書けるようになった」と通知が来たときとまったく同じ経路を通る。**通知の出どころが、カーネルから HTTP/2 のフレームパーサに変わっただけ。**

接続レベルのウィンドウが更新されたときは、待ち行列を順に起こす ([`#L2502-L2525`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/v2/ngx_http_v2.c#L2502-L2525))。

```c title="src/http/v2/ngx_http_v2.c"
    h2c->send_window += window;

    while (!ngx_queue_empty(&h2c->waiting)) {
        q = ngx_queue_head(&h2c->waiting);

        ngx_queue_remove(q);

        stream = ngx_queue_data(q, ngx_http_v2_stream_t, queue);

        stream->waiting = 0;

        wev = stream->request->connection->write;

        wev->active = 0;
        wev->ready = 1;

        if (!wev->delayed) {
            wev->handler(wev);

            if (h2c->send_window == 0) {
                break;
            }
        }
    }
```

**FIFO で起こしていき、ウィンドウを使い切ったらそこで止める。** 残りのストリームはキューに残ったまま、次の WINDOW_UPDATE を待つ。

これが HTTP/2 のストリーム間スケジューリングの実体で、優先度ツリーの類は無い (RFC 7540 の優先度は 1.25 で削除された)。**先に待ち始めたものから順に、というだけ。** 単純だが、飢餓が起きない。

### フレームのパース

本物の接続の読み handler は、フレームのパーサになっている ([`src/http/v2/ngx_http_v2.c#L397-L440`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/v2/ngx_http_v2.c#L397-L440))。

```c title="src/http/v2/ngx_http_v2.c"
    do {
        p = h2mcf->recv_buffer;
        end = ngx_cpymem(p, h2c->state.buffer, h2c->state.buffer_used);

        n = c->recv(c, end, available);

        if (n == NGX_AGAIN) {
            break;
        }
        /* ... エラー処理 ... */
        end += n;

        h2c->state.buffer_used = 0;
        h2c->state.incomplete = 0;

        do {
            p = h2c->state.handler(h2c, p, end);

            if (p == NULL) {
                return;
            }

        } while (p != end);

        h2c->total_bytes += n;

        if (h2c->total_bytes / 8 > h2c->payload_bytes + 1048576) {
            ngx_log_error(NGX_LOG_INFO, c->log, 0, "http2 flood detected");
            ngx_http_v2_finalize_connection(h2c, NGX_HTTP_V2_NO_ERROR);
            return;
        }

    } while (rev->ready);
```

`h2c->state.handler` が関数ポインタで、フレームの種類と読み進めた位置に応じて差し替わる。[ステートマシンのページ](../state-machine/) の「handler の付け替えが状態遷移」が、フレームパーサの中でも使われている。

**受信バッファはワーカーで 1 枚を共有する** (`h2mcf->recv_buffer`)。接続ごとに持たない。1 スレッドで、しかも `recv()` から `state.handler` を呼び終わるまでの間しか使わないので、共有できる。接続の数だけバッファを持つ設計と比べて、メモリが劇的に減る。

途中で切れたフレームのために `h2c->state.buffer` (小さい固定長) があり、次の呼び出しで先頭にコピーして続きから読む。**大きな共有バッファと、小さな per-connection の持ち越しバッファ**という組み合わせになっている。

`total_bytes / 8 > payload_bytes + 1MB` の判定は **flood 検出**で、「制御フレームばかりを大量に送ってくる」攻撃 (CVE-2019-9511 系) への対処。受信した総バイト数に対してペイロードが少なすぎたら切る。プロトコルの非対称性 (小さなフレームで大きな処理を要求できる) に対する、シンプルな比率の閾値になっている。

### リクエストとして走らせる

`ngx_http_v2_run_request()` ([`#L3811-L3930`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/v2/ngx_http_v2.c#L3811-L3930)) は、HEADERS フレームを読み終わってから呼ばれる。

```c title="src/http/v2/ngx_http_v2.c"
    if (ngx_http_v2_construct_request_line(r) != NGX_OK) {
        goto failed;
    }

    if (ngx_http_v2_construct_cookie_header(r) != NGX_OK) {
        goto failed;
    }

    r->http_state = NGX_HTTP_PROCESS_REQUEST_STATE;

    if (r->headers_in.connection) {
        ngx_log_error(NGX_LOG_INFO, fc->log, 0,
                      "client sent \"Connection\" header");
        ngx_http_finalize_request(r, NGX_HTTP_BAD_REQUEST);
        goto failed;
    }
    /* ... Keep-Alive, Transfer-Encoding, Upgrade も同様に拒否 ... */
```

**`:method` / `:path` / `:scheme` の擬似ヘッダから、HTTP/1.1 形式のリクエストラインを組み立てる。** `$request` 変数がちゃんと `"GET /foo HTTP/2.0"` を返すのはこれのおかげで、[変数のページ](../variables/) の `ngx_http_variable_request_line` を変えずに済んでいる。

Cookie も同じで、HTTP/2 では複数の `cookie` ヘッダに分割されるので、`; ` で連結して 1 本にする。**`$http_cookie` を見るコードが変わらない。**

HTTP/2 で禁止されているヘッダ (`Connection`、`Keep-Alive`、`Transfer-Encoding`、`Upgrade`) をここで拒否する。**プロトコルの制約チェックが、変換の直後に 1 箇所に集まっている。**

### リクエストボディ

[`#L4440-L4480`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/v2/ngx_http_v2.c#L4440-L4480) のあたりで、DATA フレームから受け取ったボディをリクエストに渡す。

```c title="src/http/v2/ngx_http_v2.c"
    if (fc->read->timedout) {
        if (stream->recv_window) {
            stream->skip_data = 1;
            fc->timedout = 1;

            return NGX_HTTP_REQUEST_TIME_OUT;
        }

        fc->read->timedout = 0;
    }

    if (fc->error) {
        stream->skip_data = 1;
        return NGX_HTTP_BAD_REQUEST;
    }
```

**偽の接続の `read->timedout` と `error` を、本物の接続と同じように見ている。** [タイマのページ](../timer-rbtree/) の赤黒木に、偽の接続の読みイベントがそのまま登録される。タイマの仕組みは偽物かどうかを知らない。

`r->read_event_handler = ngx_http_v2_read_client_request_body_handler` で読み側の handler も差し替えられていて、**ここも [ステートマシンのページ](../state-machine/) の二段構造をそのまま使っている。**

## なぜそうなっているか

### 「偽物を作る」ことで、分岐を 1 箇所に閉じた

素直な設計なら、`ngx_http_request_t` に「これは HTTP/2 のストリームか」のフラグを持たせ、`r->connection` を使っているコード全部に分岐を入れることになる。`ngx_http_variable_remote_addr`、`ngx_http_write_filter`、`ngx_http_finalize_connection`、`ngx_reusable_connection`。数十箇所。

偽の接続を作ると、**分岐が `ngx_http_v2_create_stream()` の中だけに閉じる。** 「本物と何が違うか」を 7 行で宣言して、あとは全部同じに見せる。

これが成立したのは、`ngx_connection_t` が **もともと「I/O ができる何か」の抽象になっていた**からだ。`recv` / `send` / `send_chain` が関数ポインタで、`read` / `write` がイベント構造体へのポインタ。[ステートマシンのページ](../state-machine/) で見た「`c->recv` を差し替えることで平文と SSL を同じに見せる」設計が、そのまま HTTP/2 にも効いた。

**20 年前に SSL のために作った抽象が、HTTP/2 を受け止めた**ということになる。抽象を作るときに何を隠すかの選択が、どれだけ長く効くかの例として読める。

### `ngx_memcpy` で丸ごとコピーする大胆さ

「本物の接続の全フィールドをコピーして、違うところだけ上書き」は、フィールドを 1 つずつ設定するより短い。しかも **本物の接続に新しいフィールドが増えても、自動的にコピーされる。**

代償は、コピーすべきでないフィールドを上書きし忘れると壊れること。`fc->buffered = 0` を忘れたら、ストリームが親の buffered 状態を継承してしまう。実際、上書きしている 7 行のうち何行かは、バグ修正として後から追加されたはずだ。

「デフォルトは継承、例外を列挙」という方針は、**継承するのが正しい場合が多数派のときにだけ**正しい。ここでは `sockaddr` も `ssl` も `listening` も継承すべきなので、多数派になっている。

### フロー制御を `write->ready` にマッピングする

HTTP/2 のフロー制御は「アプリケーション層の送信ウィンドウ」で、TCP の送信バッファとは別物だ。それでも `fc->write->ready = 0` で表す。

なぜこれが正しいかというと、**上位のコードにとって、どちらも「今は書けない、後で起こしてくれ」でしかない**からだ。理由が TCP の輻輳制御でも、HTTP/2 のウィンドウでも、[出力フィルタチェーン](../output-filter-chain/) がやることは変わらない。

新しい概念を導入せず、**既存の概念に翻訳する**。これができるかどうかは、既存の概念がどれだけ「理由」から独立しているかで決まる。`ready` が「カーネルが書けると言っている」ではなく「書ける状態にある」を意味していたから、翻訳できた。

同じことが `wev->active = 1` にも言えるが、こちらは少し無理がある。本来は「カーネルに登録済み」の意味で、偽の接続では登録していない。**「誰かが起こす責任を持っている」という別の意味を重ねている**ので、読むときに戸惑う。

### イベントループがストリームのスケジューラになる

HTTP/2 のストリーム間の公平性を、専用のスケジューラで実装することもできた。実際、優先度ツリー (RFC 7540) はそういう仕組みだった。

Nginx がやっているのは、**「書けるようになったストリームの write handler を呼ぶ」** だけだ。呼ばれた handler は [出力フィルタチェーン](../output-filter-chain/) を通って `send_chain` に行き、送れるだけ送って戻る。次のストリームに移る。

これはイベントループそのもので、**接続を単位としたスケジューリングを、ストリームを単位としたスケジューリングに流用している**。優先度は付けられないが、飢餓は起きないし、追加のコードもほぼ無い。

RFC 9113 で優先度ツリーが削除されたのは、複雑さに見合わなかったからで、Nginx の割り切りが結果的に正しかった形になっている。

### 受信バッファをワーカーで共有できる理由

`h2mcf->recv_buffer` はワーカーに 1 枚。既定 64KB。接続が 10 万本あっても 64KB。

これが成立するのは、[ステートマシンのページ](../state-machine/) のとおり **1 スレッドで、しかも `recv()` からフレーム処理までが 1 回のイベント処理の中で完結する**からだ。他の接続がその間に割り込むことはない。

代わりに、**フレームの途中で中断できない**。`h2c->state.handler` を呼んでいる間に「下流に書けないので待つ」ことになったら、共有バッファの内容を持ち越せない。だから `h2c->state.buffer` という小さな per-connection のバッファがあり、**次のフレームの先頭部分だけを保存する**。フレームの本体は、リクエストのバッファにコピーされる。

シングルスレッドという制約が、メモリ効率という利益に変わっている例になっている。

### flood 検出が比率である理由

`total_bytes / 8 > payload_bytes + 1048576`。受信した総バイトの 1/8 よりペイロードが少なければ切る。

固定の閾値 (「1 秒に N フレーム以上なら切る」) にしなかったのは、**正当なトラフィックの絶対量が読めない**からだ。比率にすると、通信量が大きくても小さくても同じ基準で判定できる。

`+ 1048576` のマージンは、接続の初期段階で SETTINGS や WINDOW_UPDATE が集中しても誤検出しないため。**比率だけだと立ち上がりで引っかかる**ので、絶対量の下駄を履かせている。

## どう活かすか

### そのまま真似できるところ

**新しい概念を導入する前に、既存の概念に翻訳できないかを考える。** HTTP/2 のフロー制御を「書けない」に、WINDOW_UPDATE を「書けるようになった」にマッピングしたことで、上位のコードが 1 行も変わらずに済んでいる。

**「実体の抽象」を早めに作っておくと、後から別の実装を差し込める。** `ngx_connection_t` が「I/O ができる何か」だったから、SSL・HTTP/2・QUIC のストリームが同じ枠に収まった。逆に、`ngx_http_request_t` が接続を直接持っていたら成立しなかった。

**「本物をコピーして、違うところだけ上書きする」** は、フィールドが多くて多数派が継承すべきときに有効。上書きするフィールドの一覧が、そのまま「何が違うか」のドキュメントになる。

**短命なオブジェクトはプールに戻して使い回す。** 偽の接続、そのイベント、ログ構造体。アリーナ方式のメモリ管理では特に効く。

**既存のスケジューラを流用する。** イベントループが「起こす」仕組みを持っているなら、それをそのままストリームのスケジューリングに使える。専用のスケジューラを書く前に、既存の起床機構で表現できないかを試す。

**シングルスレッドの制約を、共有バッファという利益に変える。** 「同時に 1 つしか使わない」が言えるなら、per-object のバッファを per-worker にできる。ただし「中断できない」という制約とセットになるので、持ち越し用の小さなバッファを別に用意する。

**プロトコルの非対称性への防御は、絶対量ではなく比率で。** 「小さな入力で大きな処理を要求できる」プロトコルには、入力量と処理量の比率で閾値を置く。立ち上がりのためのマージンを足す。

**変換した直後に、プロトコルの制約を検査する。** `ngx_http_v2_run_request()` が禁止ヘッダをまとめて弾いているので、下流のコードは「ありえない組み合わせ」を気にしなくていい。

### 取り込むべきでない条件

**フラグの意味を少しずらして流用するのは、読み手を混乱させる。** `wev->active = 1` が「カーネルに登録済み」ではなく「誰かが起こす責任を持っている」を意味するのは、コードからは読み取れない。意味が違うなら、フラグを分けたほうがいい。

**丸ごとコピーは、コピーすべきでないフィールドが増えたときに壊れる。** 本物の接続に新しいフィールドを足す人が、「HTTP/2 の偽の接続でも継承していいか」を考える必要がある。この依存関係はコードに現れない。

**偽のオブジェクトは、デバッグを難しくする。** コアダンプを見たときに、`ngx_connection_t` が本物か偽物かが分からない。ログの出力先だけが違う 2 つの接続が並んでいて、`fd` が同じ、という状況になる。

**ワーカー共有の受信バッファは、シングルスレッド前提。** マルチスレッド化すると成立しない。「今のところ 1 スレッドだから」で共有したリソースは、後から並列化するときの障害になる。

**優先度を捨てた割り切りは、結果的に正しかっただけ。** RFC 7540 の優先度ツリーを実装しなかった判断は、後から RFC 9113 で削除されたことで正当化されたが、当時は「仕様の一部を実装しない」という賭けだった。標準の一部を選択的に実装しないなら、その理由を記録しておく必要がある。

## 関連

- 偽の接続が使い回す仕組みは [接続の再利用のページ](../connection-reuse/) と同じ形。
- `fc->send_chain` が呼ばれる場所は [出力フィルタチェーンのページ](../output-filter-chain/)。
- `write->ready` と `NGX_AGAIN` による中断・再開は [ステートマシンのページ](../state-machine/)。
- 偽の接続のイベントもタイマの赤黒木に入る。[タイマのページ](../timer-rbtree/)。

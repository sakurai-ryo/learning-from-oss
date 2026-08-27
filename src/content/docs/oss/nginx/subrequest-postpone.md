---
title: "リクエストの中で別のリクエストを走らせ、出力の順序だけを後から辻褄合わせする"
description: "SSI も auth_request も、内部で別のリクエストを立てて結果を待つ。子は親と同じ接続・同じプール・同じ変数配列を共有し、リクエスト処理の全機構をそのまま使える。問題は出力の順序で、Nginx は「今この接続で出力してよいのは誰か」を c->data の 1 ポインタで表し、順番でない出力は親のツリーに積んで後から流す。"
group: "上流とデータの流れ"
sidebar:
  order: 17
---

## 何を学んだか

### どんな状況の話か

`auth_request /auth;` と書くと、Nginx はリクエスト処理の途中で `/auth` への内部リクエストを走らせ、その応答コードで元のリクエストを通すか弾くかを決める。SSI の `<!--# include virtual="/header" -->` は、応答の途中に別の URI の内容を差し込む。`mirror` は同じリクエストを別の場所にも投げる。

これらを実装するのに、HTTP クライアントを内蔵するのは無駄が多い。`/auth` は `location` にマッチさせたいし、`proxy_pass` も `fastcgi_pass` も使いたいし、キャッシュも効かせたい。**リクエスト処理の機構をまるごと再利用したい。**

厄介なのは出力の順序だ。SSI が

```
[本文の前半] <!--# include virtual="/a" --> [中間] <!--# include virtual="/b" --> [本文の後半]
```

を処理するとき、`/a` と `/b` は独立に走る。`/b` が先に終わることも普通にある。それでもクライアントには **前半 → a → 中間 → b → 後半** の順で届けなければならない。

そして [ステートマシン](../state-machine/) なので、`/a` の完了を待つ間、元のリクエストは中断している。

### Nginx の答え

1. **子リクエストは `ngx_http_request_t` をもう 1 個作るだけ。** 接続・プール・変数配列・リクエストボディを親と共有する。
2. **`sr->main` が常にトップのリクエストを指す。** 参照カウントもタイマも `r->main` に集約される。
3. **「今この接続で出力してよいのは誰か」を `c->data` の 1 ポインタで表す。** これが自分でなければ、出力は下流に流さず溜める。
4. **親は `r->postponed` に「子」と「自分の出力」を、発生順に並べたリストを持つ。** 出力の順序はこのリストの順序そのもの。
5. **`postpone` フィルタが、そのリストを先頭から消化する。** 先頭が子なら、その子に `c->data` を渡して起こす。先頭が出力なら、下流に流す。
6. **子が終わったら `c->data` を親に戻して、親をポストキューに積む。** 親が再開して、リストの続きを処理する。
7. **深さと参照カウントに上限を設けて、暴走を止める。**

## ソースコードのどこか

### 子リクエストを作る

[`src/http/ngx_http_core_module.c#L2393-L2581`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_core_module.c#L2393-L2581)。

```c title="src/http/ngx_http_core_module.c"
    if (r->subrequests == 0) {
        ngx_log_error(NGX_LOG_ERR, r->connection->log, 0,
                      "subrequests cycle while processing \"%V\"", uri);
        return NGX_ERROR;
    }

    /*
     * 1000 is reserved for other purposes.
     */
    if (r->main->count >= 65535 - 1000) {
        ngx_log_error(NGX_LOG_CRIT, r->connection->log, 0,
                      "request reference counter overflow "
                      "while processing \"%V\"", uri);
        return NGX_ERROR;
    }
```

**入口に 2 つの上限がある。** `r->subrequests` は入れ子の深さ (既定 50)、`r->main->count` は [ステートマシンのページ](../state-machine/) で見た参照カウント。`count` は 16 ビットのビットフィールドなので 65535 が上限で、そこから 1000 を余裕として引いている。

SSI で自分自身を include すると無限に増えるので、この 2 つが最後の砦になる。**「壊れた設定が書けてしまう」ことを認めた上で、暴走を検出可能な形で止める。**

構造体を作った後、親から引き継ぐものが並ぶ。

```c title="src/http/ngx_http_core_module.c"
    c = r->connection;
    sr->connection = c;

    sr->ctx = ngx_pcalloc(r->pool, sizeof(void *) * ngx_http_max_module);
    /* ... */
    cscf = ngx_http_get_module_srv_conf(r, ngx_http_core_module);
    sr->main_conf = cscf->ctx->main_conf;
    sr->srv_conf = cscf->ctx->srv_conf;
    sr->loc_conf = cscf->ctx->loc_conf;

    sr->pool = r->pool;

    sr->headers_in = r->headers_in;
    /* ... */
    sr->request_body = r->request_body;
    /* ... */
    sr->main = r->main;
    sr->parent = r;
    sr->post_subrequest = ps;
    sr->read_event_handler = ngx_http_request_empty_handler;
    sr->write_event_handler = ngx_http_handler;

    sr->variables = r->variables;
```

**共有するもの**: 接続、プール、リクエストヘッダ、リクエストボディ、変数の値配列。
**新しく作るもの**: `ctx` (モジュールごとの状態)、`headers_out`、`postponed`。
**設定は `server` レベルから取り直す**: `location` は URI から決め直すので、`cscf->ctx->loc_conf` (server のデフォルト) から始める。

`sr->variables = r->variables` が特に効いている。**[変数のページ](../variables/) のキャッシュが親子で共有される。** 親が `$remote_addr` を評価済みなら、子は評価しない。逆に子が評価した値は親からも見える。これが `auth_request_set` で「子の応答から取った値を親で使う」ができる理由になっている。

`sr->read_event_handler = ngx_http_request_empty_handler` は「子はクライアントから読まない」の意味。読むのは常に親だ。

`sr->write_event_handler = ngx_http_handler` で、起こされたら [フェーズエンジン](../phase-engine/) の最初から走る。

### 出力の順番を予約する

[`#L2519-L2540`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_core_module.c#L2519-L2540)。

```c title="src/http/ngx_http_core_module.c"
    if (!sr->background) {
        pr = ngx_palloc(r->pool, sizeof(ngx_http_postponed_request_t));
        if (pr == NULL) {
            return NGX_ERROR;
        }

        pr->request = sr;
        pr->out = NULL;
        pr->next = NULL;

        if (c->data == r && r->postponed == NULL) {
            c->data = sr;
        }

        if (r->postponed) {
            for (p = r->postponed; p->next; p = p->next) { /* void */ }
            p->next = pr;

        } else {
            r->postponed = pr;
        }
    }
```

`ngx_http_postponed_request_t` は `{ request, out, next }` の 3 ワード。**`request` が入っていれば「ここで子リクエストの出力が入る」、`out` が入っていれば「ここに親自身の出力がある」** という 2 種類のノードが、1 本のリストに時系列で並ぶ。

SSI の例なら、こうなる。

```
r->postponed: [out: 前半] → [request: /a] → [out: 中間] → [request: /b] → [out: 後半]
```

**このリストの順序が、そのまま出力の順序になる。**

`if (c->data == r && r->postponed == NULL) c->data = sr;` の条件が肝で、**「今出力権を持っているのが自分で、かつ自分より前に予約が無い」ときだけ、出力権を子に渡す**。既に `postponed` に何かあれば、そちらが先なので渡さない。

`background` なフラグが立った子 (`mirror` モジュールが使う) は `postponed` に入らない。**出力を待たない子**なので、順序の管理から外れる。

最後に、子を実行キューに積む。

```c title="src/http/ngx_http_core_module.c"
    r->main->count++;

    *psr = sr;
    /* ... */
    return ngx_http_post_request(sr, posted);
```

`ngx_http_post_request()` は [ステートマシンのページ](../state-machine/) の `r->main->posted_requests` に積む。**その場では実行しない。** 呼び出し元は `NGX_AGAIN` を返して帰り、`ngx_http_run_posted_requests()` が後で子を起動する。

### 出力権の判定

`ngx_http_postpone_filter` は [出力フィルタチェーン](../output-filter-chain/) の 1 つ ([`src/http/ngx_http_postpone_filter_module.c#L55-L138`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_postpone_filter_module.c#L55-L138))。

```c title="src/http/ngx_http_postpone_filter_module.c"
    if (r != c->data) {

        if (in) {
            if (ngx_http_postpone_filter_add(r, in) != NGX_OK) {
                return NGX_ERROR;
            }

            return NGX_OK;
        }
        /* ... */
        return NGX_OK;
    }

    if (r->postponed == NULL) {

        if (in || c->buffered) {
            return ngx_http_next_body_filter(r->main, in);
        }

        return NGX_OK;
    }

    if (in) {
        if (ngx_http_postpone_filter_add(r, in) != NGX_OK) {
            return NGX_ERROR;
        }
    }
```

3 つの場合に分かれる。

1. **`r != c->data`** (自分は出力権を持っていない) → **溜める。** 自分の `postponed` リストの末尾に積む。
2. **`r == c->data` で `postponed` が空** → **そのまま下流へ。** 待つべきものが無い。
3. **`r == c->data` で `postponed` がある** → 自分の出力もいったんリストに積んでから、リストを頭から消化する。

**`ngx_http_next_body_filter(r->main, in)` の第 1 引数が `r` ではなく `r->main`** なのがポイントで、これ以降のフィルタ (`gzip` / `chunked` / `write`) は **常にメインリクエストとして扱う**。子リクエストの出力も、メインの応答ストリームの一部として圧縮され、chunked に包まれる。ここがサブリクエストの出力とメインの出力が合流する地点になっている。

### リストの消化

```c title="src/http/ngx_http_postpone_filter_module.c"
    do {
        pr = r->postponed;

        if (pr->request) {

            ngx_log_debug2(NGX_LOG_DEBUG_HTTP, c->log, 0,
                           "http postpone filter wake \"%V?%V\"",
                           &pr->request->uri, &pr->request->args);

            r->postponed = pr->next;

            c->data = pr->request;

            return ngx_http_post_request(pr->request, NULL);
        }

        if (pr->out == NULL) {
            ngx_log_error(NGX_LOG_ALERT, c->log, 0,
                          "http postpone filter NULL output");

        } else {
            /* ... */
            if (ngx_http_next_body_filter(r->main, pr->out) == NGX_ERROR) {
                return NGX_ERROR;
            }
        }

        r->postponed = pr->next;

    } while (r->postponed);
```

**先頭が子リクエストなら、そこで止まる。** `c->data` をその子に渡し (出力権の委譲)、ポストキューに積んで `return` する。この時点で親は「その子が終わるまで何もできない」状態になる。

**先頭が出力なら、下流に流してリストを進める。** 次も出力なら続けて流す。子に当たったら止まる。

「出力権」という概念が `c->data` というポインタ 1 個で表現されていて、**それが誰であるかを見るだけで、溜めるか流すかが決まる**。ロックもフラグの組み合わせも要らない。

積む側 ([`#L141-L177`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_postpone_filter_module.c#L141-L177))。

```c title="src/http/ngx_http_postpone_filter_module.c"
    if (r->postponed) {
        for (pr = r->postponed; pr->next; pr = pr->next) { /* void */ }

        if (pr->request == NULL) {
            goto found;
        }

        ppr = &pr->next;

    } else {
        ppr = &r->postponed;
    }

    pr = ngx_palloc(r->pool, sizeof(ngx_http_postponed_request_t));
    /* ... */
    pr->request = NULL;
    pr->out = NULL;
    pr->next = NULL;

found:

    if (ngx_chain_add_copy(r->pool, &pr->out, in) == NGX_OK) {
        return NGX_OK;
    }
```

**末尾が「出力ノード」ならそこに追記し、そうでなければ新しいノードを作る。** 連続する出力が 1 ノードにまとまるので、リストが無駄に長くならない。

[buf のページ](../buf-chain/) の `ngx_chain_add_copy` を使っているので、**溜めているのはリンクだけで、バッファの実体はコピーされない**。

### 子が終わったとき

`ngx_http_finalize_request()` のサブリクエスト部分 ([`src/http/ngx_http_request.c#L2755-L2827`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_request.c#L2755-L2827))。

```c title="src/http/ngx_http_request.c"
    if (r != r->main) {

        if (r->buffered || r->postponed) {

            if (ngx_http_set_write_handler(r) != NGX_OK) {
                ngx_http_terminate_request(r, 0);
            }

            return;
        }

        pr = r->parent;

        if (r == c->data || r->background) {
            /* ... ログを書く ... */
            r->done = 1;

            if (r->background) {
                ngx_http_finalize_connection(r);
                return;
            }

            r->main->count--;

            r->write_event_handler = ngx_http_request_empty_handler;

            if (pr->postponed && pr->postponed->request == r) {
                pr->postponed = pr->postponed->next;
            }

            c->data = pr;

        } else {
            /* ... */
            r->write_event_handler = ngx_http_request_finalizer;

            if (r->waited) {
                r->done = 1;
            }
        }

        if (ngx_http_post_request(pr, NULL) != NGX_OK) {
            r->main->count++;
            ngx_http_terminate_request(r, 0);
            return;
        }
        /* ... */
        return;
    }
```

**自分がまだ出力を持っている (`r->buffered || r->postponed`) なら、終われない。** 書き出し用の handler に切り替えて待つ。

出力権を持ったまま終わった場合 (`r == c->data`)、**`c->data = pr` で親に返し、親をポストキューに積む**。親が再開すると、[出力フィルタチェーン](../output-filter-chain/) の `postpone` フィルタがまた呼ばれ、リストの続きを処理する。

出力権を持っていない子が先に終わった場合 (`else` 節) は、**`c->data` を触らない**。`ngx_http_request_finalizer` に差し替えて、後で自分の番が来たときに即座に終わるようにしておく。SSI の `/b` が `/a` より先に終わるケースがこれで、**`/b` の出力は `postponed` に溜まったまま、順番が来るのを待つ。**

`r->waited` が立っているときだけ `r->done = 1` にするのが細かい。`waited` は `NGX_HTTP_SUBREQUEST_WAITED` フラグで作られた子で、**親が「終わったかどうか」を問い合わせる子**を意味する。

### 完了を親に伝える

`post_subrequest` コールバックが `ngx_http_finalize_request()` の早い段階で呼ばれる ([`#L2711-L2713`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_request.c#L2711-L2713))。

```c title="src/http/ngx_http_request.c"
    if (r != r->main && r->post_subrequest) {
        rc = r->post_subrequest->handler(r, r->post_subrequest->data, rc);
    }
```

`auth_request` の使い方が一番分かりやすい ([`src/http/modules/ngx_http_auth_request_module.c#L182-L234`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/modules/ngx_http_auth_request_module.c#L182-L234))。

```c title="src/http/modules/ngx_http_auth_request_module.c"
    ctx = ngx_pcalloc(r->pool, sizeof(ngx_http_auth_request_ctx_t));
    /* ... */
    ps = ngx_palloc(r->pool, sizeof(ngx_http_post_subrequest_t));
    /* ... */
    ps->handler = ngx_http_auth_request_done;
    ps->data = ctx;

    if (ngx_http_subrequest(r, &arcf->uri, NULL, &sr, ps,
                            NGX_HTTP_SUBREQUEST_WAITED)
        != NGX_OK)
    {
        return NGX_ERROR;
    }

    /*
     * allocate fake request body to avoid attempts to read it and to make
     * sure real body file (if already read) won't be closed by upstream
     */

    sr->request_body = ngx_pcalloc(r->pool, sizeof(ngx_http_request_body_t));
    /* ... */
    sr->header_only = 1;

    ctx->subrequest = sr;

    ngx_http_set_ctx(r, ctx, ngx_http_auth_request_module);

    return NGX_AGAIN;
```

```c title="src/http/modules/ngx_http_auth_request_module.c"
static ngx_int_t
ngx_http_auth_request_done(ngx_http_request_t *r, void *data, ngx_int_t rc)
{
    ngx_http_auth_request_ctx_t   *ctx = data;
    /* ... */
    ctx->done = 1;
    ctx->status = r->headers_out.status;

    return rc;
}
```

**コールバックがやるのは、フラグとステータスを `ctx` に記録することだけ。** 実際の判断は、親のフェーズハンドラが再度呼ばれたときに行う ([`#L119-L180`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/modules/ngx_http_auth_request_module.c#L119-L180))。

```c title="src/http/modules/ngx_http_auth_request_module.c"
    ctx = ngx_http_get_module_ctx(r, ngx_http_auth_request_module);

    if (ctx != NULL) {
        if (!ctx->done) {
            return NGX_AGAIN;
        }
        /* ... 判断 ... */
    }
    /* ... 初回: 子リクエストを作って NGX_AGAIN ... */
```

**同じハンドラが 2 回呼ばれ、`ctx` の有無で「初回」と「再開」を区別する。** [フェーズエンジン](../phase-engine/) の checker が `NGX_AGAIN` を「まだ終わっていない」として扱うので、この形が成立する。

`sr->header_only = 1` で、**子の応答ボディは捨てる**。認証の判定に必要なのはステータスコードだけだ。`request_body` に空の構造体を入れておくのも、コメントのとおり「読もうとさせない」ためで、**やらせたくないことを、フィールドに偽の値を入れることで防いでいる**。

## なぜそうなっているか

### 「もう 1 個リクエストを作る」ことの効果

子リクエストが `ngx_http_request_t` である以上、**リクエストにできることは全部できる**。`location` のマッチング、`rewrite`、アクセス制御、`proxy_pass`、キャッシュ、gzip。モジュールから見て、子リクエストは特別なものではない。

代償として、`r != r->main` という判定がコードのあちこちに現れる。[フェーズエンジンのページ](../phase-engine/) の ACCESS checker、[出力フィルタチェーンのページ](../output-filter-chain/) の not_modified フィルタ、ログの書き込み。**「サブリクエストでは、これはやらない」を各所で書く必要がある。**

この判定を書き忘れたモジュールは、サブリクエストで妙な挙動をする。サードパーティモジュールの典型的なバグの 1 つになっている。

### `c->data` という 1 ポインタが同期の全部

複数のリクエストが 1 本の接続を共有していて、出力できるのは 1 人。**この排他を、ポインタ 1 個の値で表している。**

ロックが要らないのは [ステートマシンのページ](../state-machine/) のとおり 1 スレッドだからで、値を書き換える瞬間に他の誰かが割り込むことがない。

もう 1 つの利点は、**「今誰が出力しているか」がデバッグ時に一目で分かる**ことだ。実際、`ngx_http_finalize_request` のデバッグログには `a:%d` (= `r == c->data`) が入っている。

`ngx_event_pipe` の中に `p->downstream->data == p->output_ctx` という条件が出てくる ([upstream のページ](../upstream-event-pipe/)) のも、この仕組みだ。**「下流に流せるか」の判定が、出力権を持っているかの判定と同じになっている。**

### 出力順序を「予約」として持つ

素朴には、子の出力を全部バッファに溜めて、完了してから順に流す方法がある。これだとメモリを食う。

Nginx は **「順序の予約」だけを先に作り、実際の出力は可能なら即座に流す**。`c->data` が自分なら溜めない。SSI で `/a` が最初の子なら、`/a` の出力は 1 バイトも溜まらずにクライアントへ流れる。溜まるのは `/b` の出力だけで、しかも [buf のページ](../buf-chain/) のとおりリンクだけを繋いでいるので、コピーは発生しない。

リストのノードが「子」と「出力」の 2 種類を兼ねているのが効いていて、**時系列の一本道**として表現できる。子ごとにバッファを持つ構造だと、「親の出力と子の出力の相対順序」を別に記録する必要が出てくる。

### 完了通知が 2 段になっている理由

子が終わると、`post_subrequest` コールバックと、親のポストキューへの積み直しの **両方** が起きる。

コールバックは「値を受け取る」ための同期的な通知で、`ctx` に結果を書く。ポストキューは「親を再開させる」ための非同期の起床で、実際の判断はそこから始まる。

分かれている理由は、**コールバックの実行文脈が「子の終了処理の途中」だから**だ。ここで親のフェーズを進めると、子の後始末が終わっていない状態で親が動く。値の記録だけに留めて、判断は親が再開してから、という分離になっている。

これは非同期処理一般に出てくる形で、「完了ハンドラでは記録だけして、続きはイベントループに戻ってから」という [ステートマシンのページ](../state-machine/) の原則と同じになっている。

### 上限が「壊れた設定を認めた上での防御」

`r->subrequests` (深さ 50) と `r->main->count` (65535 - 1000) の 2 つ。どちらも「正しい設定なら絶対に到達しない」値だ。

到達したときのログが `"subrequests cycle while processing"` と `"request reference counter overflow"` で、**どちらも「設定が壊れている」と読める文言**になっている。エラーコードだけを返すのではなく、運用者が原因にたどり着ける言葉を選んでいる。

`count` が 16 ビットのビットフィールドで、そこから 1000 を予約しているのも実務的だ。サブリクエスト以外にも `count` を増やす場所 (AIO、上流、[タイマ](../timer-rbtree/)) があるので、その余地を残している。**上限に「安全マージン」を含めておく**という判断で、マジックナンバーの意図がコメントに書かれている。

### `header_only` と偽の `request_body`

`auth_request` は子の応答ボディを必要としない。`sr->header_only = 1` で捨てる。

`sr->request_body` に空の構造体を入れるのは、**子がリクエストボディを読もうとするのを防ぐ**ため。「まだ読んでいない」と「読んだが空だった」を区別する仕組みが `request_body == NULL` かどうかなので、空の構造体を置くことで「読んだ (ことにする)」を表現している。

コメントに書かれた 2 つ目の理由 (`won't be closed by upstream`) がより重要で、**親が既に読んで一時ファイルに落としたボディを、子の upstream 処理が閉じてしまう**のを防いでいる。共有しているリソースを子が片付けてしまう、という所有権の問題で、偽のオブジェクトを置くことで回避している。

素直な解は「子はボディを所有しない」というフラグを足すことだが、既存のコードを触らずに済ませる方を選んでいる。

## どう活かすか

### そのまま真似できるところ

**「内部で自分自身の機構を再利用する」を、同じ型のオブジェクトを作ることで実現する。** 専用の内部 API を作るより、既存の処理系をそのまま通すほうが、機能の再利用が効く。ミドルウェアやルーティングを持つフレームワークで、内部リクエストを「本物のリクエストオブジェクト」として作るのは同じ発想になる。

**排他を、ロックではなく「今の担当者を指すポインタ」で表す。** シングルスレッドのイベントループなら、これで十分で、しかもデバッグが容易になる。「今誰が出力してよいか」を 1 箇所で読める。

**順序の制約を、「予約リスト」として先に確定させる。** 実際の値が揃うのを待たずに、順序だけを先に決めておく。並行に走る処理の結果を決まった順序で出したいとき (Promise の順序保証、並列ダウンロードの結合) に使える。

**予約リストのノードに 2 種類を兼ねさせる。** 「自分の出力」と「他人の出力の場所取り」を同じリストに並べると、相対順序を別に管理しなくて済む。

**溜めるのはリンクだけにする。** 順序待ちのデータをコピーしない。参照だけを繋いでおけば、メモリのコストは順序管理の構造体ぶんだけになる。

**完了通知を「値の記録」と「続きの起動」に分ける。** 完了ハンドラでは記録だけして、判断はイベントループに戻ってから。完了ハンドラの中で次の処理を始めると、後始末が終わっていない状態で動くことになる。

**同じハンドラが複数回呼ばれる前提で書き、コンテキストの有無で段階を判別する。** `ctx == NULL` なら初回、あれば再開。状態機械の実装として素朴だが読みやすい。

**上限には安全マージンを含め、超えたときのログを「原因が分かる言葉」にする。** `"subrequests cycle"` は、運用者が SSI の循環参照を疑うのに十分な情報になっている。

### 取り込むべきでない条件

**`r != r->main` の判定が全体に散らばる。** 子リクエストを「普通のリクエスト」として扱えるのは利点だが、「子ではやってはいけないこと」を各所で書く必要が出る。コアが 20 箇所くらいでこれをやっていて、サードパーティモジュールが漏らすと事故になる。「サブリクエストで無効化すべき処理」を型やフェーズの属性で表現できるなら、そのほうが安全になる。

**共有するリソースの所有権が曖昧になる。** 親子で `r->pool` も `request_body` も共有しているので、「どちらが片付けるか」が暗黙になる。`auth_request` が偽の `request_body` を置いているのは、その曖昧さへの対処療法だ。共有するなら、所有権を明示する仕組みを最初から入れたい。

**`c->data` の付け替えを間違えると、静かに固まる。** 出力権を持ったまま終了しない子がいると、親は永遠に再開しない。実際 Nginx でも、サブリクエストを使うサードパーティモジュールでこの種のハングが報告されている。ポインタ 1 個で表現している以上、「誰も持っていない」「2 人が持っている」を検出する手段が無い。

**参照カウントが 16 ビットのビットフィールドなのは、構造体を詰めた結果。** 65535 という上限が設計に現れてしまっている。カウンタは素直に 32 ビット以上にできるなら、そのほうがいい。

## 関連

- `r->main->count` と `posted_requests` の仕組みは [ステートマシンのページ](../state-machine/)。
- `postpone` フィルタがチェーンのどこにいるかは [出力フィルタチェーンのページ](../output-filter-chain/)。
- `p->downstream->data == p->output_ctx` という判定が使われる場所は [upstream と event_pipe のページ](../upstream-event-pipe/)。
- 親子で共有される変数のキャッシュは [変数のページ](../variables/)。

---
title: "拡張点を「フェーズの配列」にして、制御構造そのものをデータとして持つ"
description: "リクエスト処理の骨格は 11 段のフェーズで、モジュールは自分の関数をどれかに登録する。起動時にそれが 1 本のフラットな配列に畳まれ、実行時のループは配列を舐めるだけになる。フェーズごとの「戻り値をどう解釈するか」は checker 関数に切り出され、次にどこへ飛ぶかは配列の各要素が持つ next フィールドが決める。だからループの中に if が 1 つも無い。"
sidebar:
  order: 12
---

## 何を学んだか

### どんな状況の話か

HTTP サーバの処理には、決まった順序がある。IP でアクセス制御して、認証して、URI を書き換えて、どの `location` に当てはまるかを決めて、内容を生成して、ログを書く。

この順序に、モジュールが割り込みたい。`ngx_http_access_module` は IP のチェックを、`ngx_http_auth_basic_module` は Basic 認証を、`ngx_http_rewrite_module` は書き換えを、`ngx_http_proxy_module` は内容の生成を担当する。

素朴に書くとこうなる。

```c
if (access_module_enabled) { rc = access_handler(r); if (rc != OK) return rc; }
if (auth_basic_enabled)    { rc = auth_handler(r);   if (rc != OK) return rc; }
if (limit_req_enabled)     { ... }
/* ... 40 個のモジュールぶん ... */
```

これはコアがモジュール全部を知っていることになるので、サードパーティモジュールを足せない。しかも段によって「戻り値の意味」が違う。認証は「1 つでも通ればいい」ことがある (`satisfy any`)、書き換えは「書き換えたらもう一度最初からやり直す」必要がある、内容生成は「1 つだけが成功すればいい」。

### Nginx の答え

1. **処理の骨格を 11 個のフェーズとして enum で固定する。** ここは拡張できない。増やせるのは各フェーズの中身だけ。
2. **モジュールは、設定を読み終わった時点で自分のハンドラを配列に push する。** どのフェーズに入るかは、push する配列を選ぶことで決まる。
3. **起動時に、全フェーズの全ハンドラを 1 本のフラットな配列に畳む。** 実行時にはフェーズの入れ子構造が消えていて、`ngx_http_phase_handler_t` が一列に並んでいるだけになる。
4. **各要素が「checker」「handler」「next」の 3 つを持つ。** checker はそのフェーズ用の戻り値解釈ルール、handler はモジュールの関数、next は「このフェーズを飛ばすときの跳び先」。
5. **実行時のループは 4 行しかない。** `while (ph[i].checker) { rc = ph[i].checker(r, &ph[i]); if (rc == NGX_OK) return; }`。`i` を進めるのは checker の仕事。
6. **checker は 7 種類しかない。** generic / rewrite / find_config / post_rewrite / access / post_access / content。フェーズごとの特殊性は全部ここに閉じている。
7. **中断と再開が自然に入る。** checker が `NGX_OK` を返すのは「今は先に進めない」の意味で、そのまま関数から抜ける。次のイベントで `ngx_http_core_run_phases()` がまた呼ばれ、`r->phase_handler` の続きから再開する。

## ソースコードのどこか

### フェーズの定義

[`src/http/ngx_http_core_module.h#L110-L129`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_core_module.h#L110-L129)。

```c title="src/http/ngx_http_core_module.h"
typedef enum {
    NGX_HTTP_POST_READ_PHASE = 0,

    NGX_HTTP_SERVER_REWRITE_PHASE,

    NGX_HTTP_FIND_CONFIG_PHASE,
    NGX_HTTP_REWRITE_PHASE,
    NGX_HTTP_POST_REWRITE_PHASE,

    NGX_HTTP_PREACCESS_PHASE,

    NGX_HTTP_ACCESS_PHASE,
    NGX_HTTP_POST_ACCESS_PHASE,

    NGX_HTTP_PRECONTENT_PHASE,

    NGX_HTTP_CONTENT_PHASE,

    NGX_HTTP_LOG_PHASE
} ngx_http_phases;
```

空行の入れ方が意味を持っていて、`FIND_CONFIG` / `REWRITE` / `POST_REWRITE` が 1 つの塊になっている。ここがループするからだ (書き換えが起きたら `FIND_CONFIG` に戻る)。`ACCESS` と `POST_ACCESS` も対になっている。

`POST_READ` / `PREACCESS` / `PRECONTENT` は **サードパーティのために空けてある枠**という性格が強い。`PRECONTENT` は 1.13.3 で `TRY_FILES` フェーズを一般化して作られた枠で、`mirror` や `auth_request` がここに入る。

要素は `{ checker, handler, next }` の 3 つ ([`#L136-L140`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_core_module.h#L136-L140))。

```c title="src/http/ngx_http_core_module.h"
struct ngx_http_phase_handler_s {
    ngx_http_phase_handler_pt  checker;
    ngx_http_handler_pt        handler;
    ngx_uint_t                 next;
};
```

`next` が `ngx_uint_t` (ポインタではなく添字) なのは、配列がフラットだからそれで足りるため。

### 登録は 1 行

`ngx_http_static_module` の場合 ([`src/http/modules/ngx_http_static_module.c#L281-L297`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/modules/ngx_http_static_module.c#L281-L297))。

```c title="src/http/modules/ngx_http_static_module.c"
static ngx_int_t
ngx_http_static_init(ngx_conf_t *cf)
{
    ngx_http_handler_pt        *h;
    ngx_http_core_main_conf_t  *cmcf;

    cmcf = ngx_http_conf_get_module_main_conf(cf, ngx_http_core_module);

    h = ngx_array_push(&cmcf->phases[NGX_HTTP_CONTENT_PHASE].handlers);
    if (h == NULL) {
        return NGX_ERROR;
    }

    *h = ngx_http_static_handler;

    return NGX_OK;
}
```

これが `postconfiguration` コールバックとして呼ばれる。**「どのフェーズか」は、push する配列の添字でしかない。** 優先度の数値も、依存の宣言も、登録用の API も無い。

モジュールが持てるフックは 8 個だけ ([`src/http/ngx_http_config.h#L24-L36`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_config.h#L24-L36))。

```c title="src/http/ngx_http_config.h"
typedef struct {
    ngx_int_t   (*preconfiguration)(ngx_conf_t *cf);
    ngx_int_t   (*postconfiguration)(ngx_conf_t *cf);

    void       *(*create_main_conf)(ngx_conf_t *cf);
    char       *(*init_main_conf)(ngx_conf_t *cf, void *conf);

    void       *(*create_srv_conf)(ngx_conf_t *cf);
    char       *(*merge_srv_conf)(ngx_conf_t *cf, void *prev, void *conf);

    void       *(*create_loc_conf)(ngx_conf_t *cf);
    char       *(*merge_loc_conf)(ngx_conf_t *cf, void *prev, void *conf);
} ngx_http_module_t;
```

`preconfiguration` は設定を読む前 (変数を登録する場所)、`postconfiguration` は読んだ後 (フェーズに登録する場所)。残り 6 つは [設定マージのページ](../conf-merge/) の話。**拡張点の数を 8 個に固定している**ので、どこで何が起きるかを全部覚えられる。

### 起動時に配列を畳む

[`src/http/ngx_http.c#L455-L560`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http.c#L455-L560)。ここが表を組み立てる場所で、この関数を読むとフェーズエンジンの全部が分かる。

```c title="src/http/ngx_http.c"
    cmcf->phase_engine.server_rewrite_index = (ngx_uint_t) -1;
    cmcf->phase_engine.location_rewrite_index = (ngx_uint_t) -1;
    find_config_index = 0;
    use_rewrite = cmcf->phases[NGX_HTTP_REWRITE_PHASE].handlers.nelts ? 1 : 0;
    use_access = cmcf->phases[NGX_HTTP_ACCESS_PHASE].handlers.nelts ? 1 : 0;

    n = 1                  /* find config phase */
        + use_rewrite      /* post rewrite phase */
        + use_access;      /* post access phase */

    for (i = 0; i < NGX_HTTP_LOG_PHASE; i++) {
        n += cmcf->phases[i].handlers.nelts;
    }

    ph = ngx_pcalloc(cf->pool,
                     n * sizeof(ngx_http_phase_handler_t) + sizeof(void *));
```

**まず全体の個数を数えて、1 回で確保する。** `+ sizeof(void *)` の余分は終端用で、`ngx_pcalloc` でゼロ埋めされているから `checker == NULL` になり、ループの終了条件になる。番兵を明示的に書かずにサイズを足すだけで済ませている。

`use_rewrite` / `use_access` が効いていて、**`rewrite` を 1 つも使っていない設定なら `POST_REWRITE` のエントリを作らない**。ハンドラが 0 個のフェーズは、配列から丸ごと消える。設定ごとに最適な長さの配列ができる。

畳み込み本体。

```c title="src/http/ngx_http.c"
    for (i = 0; i < NGX_HTTP_LOG_PHASE; i++) {
        h = cmcf->phases[i].handlers.elts;

        switch (i) {

        case NGX_HTTP_SERVER_REWRITE_PHASE:
            if (cmcf->phase_engine.server_rewrite_index == (ngx_uint_t) -1) {
                cmcf->phase_engine.server_rewrite_index = n;
            }
            checker = ngx_http_core_rewrite_phase;

            break;

        case NGX_HTTP_FIND_CONFIG_PHASE:
            find_config_index = n;

            ph->checker = ngx_http_core_find_config_phase;
            n++;
            ph++;

            continue;
        /* ... */
        case NGX_HTTP_POST_REWRITE_PHASE:
            if (use_rewrite) {
                ph->checker = ngx_http_core_post_rewrite_phase;
                ph->next = find_config_index;
                n++;
                ph++;
            }

            continue;
        /* ... */
        default:
            checker = ngx_http_core_generic_phase;
        }

        n += cmcf->phases[i].handlers.nelts;

        for (j = cmcf->phases[i].handlers.nelts - 1; j >= 0; j--) {
            ph->checker = checker;
            ph->handler = h[j];
            ph->next = n;
            ph++;
        }
    }
```

3 つのことが同時に起きている。

**1. checker の割り当て。** フェーズごとに `switch` で選ぶ。`default` は `ngx_http_core_generic_phase`。特殊な checker が要るのは 6 フェーズだけで、残りは共通のものを使う。

**2. `next` の設定。** `n` はこのフェーズが終わった直後の位置。`ph->next = n` を全ハンドラに書くので、**「このフェーズを打ち切って次のフェーズへ」が添字 1 個で表される**。`POST_REWRITE` だけは `ph->next = find_config_index` で、**前に戻る**。書き換えが起きたときに `FIND_CONFIG` からやり直すループが、この 1 行で作られている。

**3. ハンドラを逆順に並べる。** `for (j = nelts - 1; j >= 0; j--)`。`postconfiguration` はモジュールの登録順に呼ばれるが、実行してほしい順序はその逆になるように `ngx_modules` の並びが作られている。畳むときに反転させることで、辻褄を合わせている。

`server_rewrite_index` を覚えているのは、内部リダイレクトのときに使うため。[`ngx_http_handler()`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_core_module.c#L841-L883) がこう書いている。

```c title="src/http/ngx_http_core_module.c"
    if (!r->internal) {
        /* ... keepalive の判定 ... */
        r->phase_handler = 0;

    } else {
        cmcf = ngx_http_get_module_main_conf(r, ngx_http_core_module);
        r->phase_handler = cmcf->phase_engine.server_rewrite_index;
    }
    /* ... */
    r->write_event_handler = ngx_http_core_run_phases;
    ngx_http_core_run_phases(r);
```

内部リダイレクト (`error_page` や `X-Accel-Redirect`) では `POST_READ` をやり直さず、`SERVER_REWRITE` から始める。**「どこから始めるか」が配列の添字を代入するだけで表現できる。**

### 実行ループ

[`src/http/ngx_http_core_module.c#L886-L905`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_core_module.c#L886-L905)。

```c title="src/http/ngx_http_core_module.c"
void
ngx_http_core_run_phases(ngx_http_request_t *r)
{
    ngx_int_t                   rc;
    ngx_http_phase_handler_t   *ph;
    ngx_http_core_main_conf_t  *cmcf;

    cmcf = ngx_http_get_module_main_conf(r, ngx_http_core_module);

    ph = cmcf->phase_engine.handlers;

    while (ph[r->phase_handler].checker) {

        rc = ph[r->phase_handler].checker(r, &ph[r->phase_handler]);

        if (rc == NGX_OK) {
            return;
        }
    }
}
```

**これがリクエスト処理の骨格の全部。** フェーズの名前も、`if` も、`switch` も出てこない。

肝は `r->phase_handler` が **リクエスト構造体のメンバであって、この関数のローカル変数ではない**ことだ。だから `return` して後で再入しても、続きから再開できる。[ステートマシンのページ](../state-machine/) の「状態はスタックに置けない」がここにも効いている。

`r->write_event_handler = ngx_http_core_run_phases` が設定されているので、上流を待って中断した後、書けるようになったら **この関数がそのまま再呼び出しされる**。ステートマシンの「次にやること」が、フェーズの続きになっている。

### checker が戻り値の解釈を持つ

一番単純な generic checker ([`#L908-L942`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_core_module.c#L908-L942))。

```c title="src/http/ngx_http_core_module.c"
    rc = ph->handler(r);

    if (rc == NGX_OK) {
        r->phase_handler = ph->next;
        return NGX_AGAIN;
    }

    if (rc == NGX_DECLINED) {
        r->phase_handler++;
        return NGX_AGAIN;
    }

    if (rc == NGX_AGAIN || rc == NGX_DONE) {
        return NGX_OK;
    }

    /* rc == NGX_ERROR || rc == NGX_HTTP_...  */

    ngx_http_finalize_request(r, rc);

    return NGX_OK;
```

戻り値の語彙が全部出ている。

- `NGX_OK`: このフェーズは完了。次のフェーズへ (`ph->next`)。
- `NGX_DECLINED`: 自分は関係ない。同じフェーズの次のハンドラへ (`++`)。
- `NGX_AGAIN` / `NGX_DONE`: まだ終わっていない。ループを抜けて後で再開。
- それ以外 (エラーや HTTP ステータス): リクエストを終わらせる。

**checker の戻り値と handler の戻り値が別の語彙になっている**のが設計として効いている。checker が返す `NGX_OK` は「ループを止めろ」、`NGX_AGAIN` は「ループを続けろ」。handler が返す `NGX_OK` は「フェーズ完了」。同じ定数が階層によって違う意味を持つのは読みにくいが、`ngx_http_core_run_phases()` 側の判定が `if (rc == NGX_OK) return;` の 1 つで済んでいる。

rewrite checker はもっと短い ([`#L945-L969`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_core_module.c#L945-L969))。

```c title="src/http/ngx_http_core_module.c"
    rc = ph->handler(r);

    if (rc == NGX_DECLINED) {
        r->phase_handler++;
        return NGX_AGAIN;
    }

    if (rc == NGX_DONE) {
        return NGX_OK;
    }

    /* NGX_OK, NGX_AGAIN, NGX_ERROR, NGX_HTTP_...  */

    ngx_http_finalize_request(r, rc);

    return NGX_OK;
```

**書き換えフェーズには「このフェーズを打ち切る」という概念が無い。** 全部のハンドラが順に走るか、途中で終わるか、エラーになるかのどれか。だから `ph->next` を使わない。同じ配列構造の上で、フェーズごとに違う制御フローが実現している。

### ループを作る checker

`POST_REWRITE` ([`#L1068-L1108`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_core_module.c#L1068-L1108))。

```c title="src/http/ngx_http_core_module.c"
    if (!r->uri_changed) {
        r->phase_handler++;
        return NGX_AGAIN;
    }

    /*
     * gcc before 3.3 compiles the broken code for
     *     if (r->uri_changes-- == 0)
     * if the r->uri_changes is defined as
     *     unsigned  uri_changes:4
     */

    r->uri_changes--;

    if (r->uri_changes == 0) {
        ngx_log_error(NGX_LOG_ERR, r->connection->log, 0,
                      "rewrite or internal redirection cycle "
                      "while processing \"%V\"", &r->uri);

        ngx_http_finalize_request(r, NGX_HTTP_INTERNAL_SERVER_ERROR);
        return NGX_OK;
    }

    r->phase_handler = ph->next;

    cscf = ngx_http_get_module_srv_conf(r, ngx_http_core_module);
    r->loc_conf = cscf->ctx->loc_conf;

    return NGX_AGAIN;
```

このエントリには handler が無い。**checker だけを持つ、純粋な制御ノード**だ。URI が書き換わっていたら `ph->next` = `find_config_index` に戻る。

`r->uri_changes` は 4 ビットのビットフィールドで、10 で初期化される。無限ループの防止で、これが「rewrite or internal redirection cycle」のエラーメッセージの正体になる。

コメントの gcc 3.3 の話は、**回避策の理由が明記されている**例として面白い。`if (x-- == 0)` をビットフィールドに対して書くと古い gcc が壊れたコードを吐いたので、2 文に分けてある。2026 年のコードに 20 年前のコンパイラの話が残っているのは、消す理由が無いからだ。

### 同じフェーズを 2 つの意味で使う

`ACCESS` checker が一番複雑になっている ([`#L1111-L1185`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_core_module.c#L1111-L1185))。

```c title="src/http/ngx_http_core_module.c"
    if (r != r->main) {
        r->phase_handler = ph->next;
        return NGX_AGAIN;
    }
    /* ... */
    rc = ph->handler(r);

    if (rc == NGX_DECLINED) {
        r->phase_handler++;
        return NGX_AGAIN;
    }

    if (rc == NGX_AGAIN || rc == NGX_DONE) {
        return NGX_OK;
    }

    clcf = ngx_http_get_module_loc_conf(r, ngx_http_core_module);

    if (clcf->satisfy == NGX_HTTP_SATISFY_ALL) {

        if (rc == NGX_OK) {
            r->phase_handler++;
            return NGX_AGAIN;
        }

    } else {
        if (rc == NGX_OK) {
            r->access_code = 0;
            /* ... WWW-Authenticate ヘッダを消す ... */
            r->phase_handler = ph->next;
            return NGX_AGAIN;
        }

        if (rc == NGX_HTTP_FORBIDDEN
            || rc == NGX_HTTP_UNAUTHORIZED
            || rc == NGX_HTTP_PROXY_AUTH_REQUIRED)
        {
            /* ... */
            r->phase_handler++;
            return NGX_AGAIN;
        }
    }
```

先頭の `if (r != r->main)` で、**サブリクエストはアクセス制御フェーズを丸ごと飛ばす**。内部で発行したリクエストに認証をかけても意味がないからだ。この 1 行が [サブリクエストのページ](../subrequest-postpone/) の前提になっている。

その下が `satisfy` ディレクティブの実装で、**`all` なら「成功しても次のハンドラへ」、`any` なら「成功したらフェーズを打ち切る」**。同じ配列、同じハンドラ列に対して、設定値で `++` と `= ph->next` を切り替えている。

`any` のときに失敗を `r->access_code` に溜めて、`POST_ACCESS` で判定する ([`#L1188-L1219`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_core_module.c#L1188-L1219))。

```c title="src/http/ngx_http_core_module.c"
    access_code = r->access_code;

    if (access_code) {
        if (access_code == NGX_HTTP_FORBIDDEN) {
            ngx_log_error(NGX_LOG_ERR, r->connection->log, 0,
                          "access forbidden by rule");
        }
        /* ... */
        r->access_code = 0;

        ngx_http_finalize_request(r, access_code);
        return NGX_OK;
    }

    r->phase_handler++;
    return NGX_AGAIN;
```

**「全部のハンドラが失敗した」という判定を、フェーズの後ろに置いた専用ノードで行う。** ループの終端でフラグを見る、という構造が、配列上のエントリとして表現されている。

### 内容生成だけ扱いが違う

`CONTENT` checker ([`#L1295-L1344`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_core_module.c#L1295-L1344))。

```c title="src/http/ngx_http_core_module.c"
    if (r->content_handler) {
        r->write_event_handler = ngx_http_request_empty_handler;
        ngx_http_finalize_request(r, r->content_handler(r));
        return NGX_OK;
    }
    /* ... */
    rc = ph->handler(r);

    if (rc != NGX_DECLINED) {
        ngx_http_finalize_request(r, rc);
        return NGX_OK;
    }

    /* rc == NGX_DECLINED */

    ph++;

    if (ph->checker) {
        r->phase_handler++;
        return NGX_AGAIN;
    }

    /* no content handler was found */

    if (r->uri.data[r->uri.len - 1] == '/') {
        /* ... */
        ngx_http_finalize_request(r, NGX_HTTP_FORBIDDEN);
        return NGX_OK;
    }

    ngx_log_error(NGX_LOG_ERR, r->connection->log, 0, "no handler found");

    ngx_http_finalize_request(r, NGX_HTTP_NOT_FOUND);
    return NGX_OK;
```

**`r->content_handler` が設定されていたら、フェーズの配列を無視して直接呼ぶ。** これが `proxy_pass` や `fastcgi_pass` の実装で、`location` にこれらが書いてあると `clcf->handler` が設定され、[`ngx_http_update_location_config()`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_core_module.c#L1347) が `r->content_handler` にコピーする。

つまり CONTENT フェーズには 2 通りの入り方がある。**`location` に紐づいた専用ハンドラ (1 つだけ)** と、**フェーズに登録されたハンドラ列 (`index` → `autoindex` → `static` と順に試す)**。前者が指定されていれば後者は見ない。

「全部が `NGX_DECLINED` を返した」ときの処理も、この checker が持っている。`ph++` して `checker` が無ければ配列の終端、つまり誰も内容を作らなかったということなので 404 になる。**配列の終端を検出することが、そのまま「該当なし」の判定になっている。**

### バイナリ互換性のための署名

フェーズエンジンとは直接関係ないが、モジュール機構としてもう 1 つ面白いものがある。`ngx_module_t` の `signature` フィールドだ ([`src/core/ngx_module.h#L205-L217`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_module.h#L205-L217))。

```c title="src/core/ngx_module.h"
#define NGX_MODULE_SIGNATURE                                                  \
    NGX_MODULE_SIGNATURE_0 NGX_MODULE_SIGNATURE_1 NGX_MODULE_SIGNATURE_2      \
    NGX_MODULE_SIGNATURE_3 NGX_MODULE_SIGNATURE_4 NGX_MODULE_SIGNATURE_5      \
    /* ... 35 個 ... */
    NGX_MODULE_SIGNATURE_33 NGX_MODULE_SIGNATURE_34
```

`NGX_MODULE_SIGNATURE_n` はそれぞれ、ビルド時の機能フラグから "0" か "1" に展開される。

```c title="src/core/ngx_module.h"
#if (NGX_HAVE_EPOLL)
#define NGX_MODULE_SIGNATURE_6   "1"
#else
#define NGX_MODULE_SIGNATURE_6   "0"
#endif
```

なぜこれが要るか。**`#if` によって構造体のメンバが増減する**からだ。`ngx_event_t` に `kq_errno` が入るかどうか、`ngx_http_request_t` にキャッシュ関連のフィールドが入るかどうかが、ビルドオプションで変わる。動的モジュールを別のオプションでビルドすると、構造体のレイアウトが食い違って謎のクラッシュになる。

そこで、レイアウトに影響する 35 個のフラグを文字列に固めて比較する ([`src/core/ngx_module.c#L170-L182`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_module.c#L170-L182))。

```c title="src/core/ngx_module.c"
    if (module->version != nginx_version) {
        ngx_conf_log_error(NGX_LOG_EMERG, cf, 0,
                           "module \"%V\" version %ui instead of %ui",
                           file, module->version, (ngx_uint_t) nginx_version);
        return NGX_ERROR;
    }

    if (ngx_strcmp(module->signature, NGX_MODULE_SIGNATURE) != 0) {
        ngx_conf_log_error(NGX_LOG_EMERG, cf, 0,
                           "module \"%V\" is not binary compatible",
                           file);
        return NGX_ERROR;
    }
```

**ABI の互換性を、バージョン番号ではなく「レイアウトを決める条件の集合」で判定している。** `ngx_module_t` に `spare0`〜`spare1` と `spare_hook0`〜`spare_hook7` という予約領域があるのも同じ動機で、後からフィールドを足してもサイズが変わらないようにしてある。

## なぜそうなっているか

### 制御構造をデータにすると、`if` が消える

素朴な実装では、「どのモジュールを呼ぶか」「どの順で呼ぶか」「戻り値をどう解釈するか」「次にどこへ行くか」が全部 `if` と `switch` の入れ子になる。Nginx はこれを 3 つに分解した。

- **順序** → 配列の並び順
- **戻り値の解釈** → checker 関数
- **跳び先** → `next` フィールド

結果、実行ループから条件分岐が消える。読むほうから見ると、**`ngx_http_core_run_phases()` を読んでも何も分からない代わりに、`ngx_http_init_phase_handlers()` を読めば全部分かる**。制御構造の全体が 1 つの関数に集まるので、「rewrite の後は find_config に戻る」のような大域的な性質を、1 箇所で確認できる。

これは表駆動 (table-driven) の典型で、パーサジェネレータが生成する状態遷移表と同じ発想だ。違うのは、**表を組み立てるのが設定の読み込み時**だということ。設定によって表の形が変わる。

### 起動時に畳むことで、実行時のコストがゼロになる

`use_rewrite` が 0 なら `POST_REWRITE` のエントリは作られない。使っていないモジュールのハンドラは配列に入らない。**設定に書かれていない機能は、実行時に 1 命令も消費しない。**

これは「毎回全モジュールを回って `if (enabled)` する」実装との決定的な差になる。40 個のモジュールがあっても、実際に使っているのが 5 個なら配列の長さは 5 + 制御ノード数になる。

畳み込みは設定リロードのたびに走るので、コストは払っている。ただしそれは数百マイクロ秒の話で、リクエストごとに払うコストとは桁が違う。**「めったに起きないこと」に計算を寄せて、「毎回起きること」を軽くする**という原則そのままだ。

### 順序を宣言させず、モジュールの並び順で決める

多くのプラグイン機構は、優先度の数値 (`priority: 100`) や依存の宣言 (`after: auth`) を持つ。Nginx にはそれが無い。順序は `ngx_modules[]` の並び順で、それは `configure` が生成する。サードパーティモジュールは `--add-module` の順で並ぶ。

これは明らかに不便で、**モジュールの順序に依存する問題は Nginx のユーザーが定期的に踏む**。`configure` の引数の順番を変えると挙動が変わる。

それでもこうなっているのは、優先度や依存の解決が「解けない場合」を持ち込むからだと思う。循環依存をどう報告するか、同じ優先度をどう並べるか、宣言されていない依存をどう扱うか。フェーズという粗い枠を先に固定して、その中の順序は「ビルド時に決まる列」に丸投げすることで、**実行時に解くべき問題が 1 つも残らない**ようにしてある。

### フェーズが 11 個で固定されていることの意味

拡張できるのは各フェーズの中身だけで、フェーズそのものは増やせない。サードパーティが「認証の前だけど preaccess の後」に新しい段を作ることはできない。

これは制約だが、**フェーズの意味が全モジュールで共有される**という利点を生んでいる。`NGX_HTTP_ACCESS_PHASE` に登録されたハンドラは、必ず `satisfy` の対象になり、サブリクエストでは飛ばされる。ハンドラを書く側は「自分がどのフェーズにいるか」を選ぶだけで、その振る舞いを継承できる。

フェーズを自由に足せるようにすると、この共有された意味が失われる。「`PRECONTENT` フェーズ」が 1.13.3 で追加されたときも、**サードパーティが足したのではなくコアが増やした**。拡張点を増やす判断はコアが握っている。

### handler の無いエントリ

`FIND_CONFIG` / `POST_REWRITE` / `POST_ACCESS` は checker だけを持つ。これらは「モジュールが登録するもの」ではなく「コアが挿入する制御ノード」だ。

同じ配列に、拡張点と制御ノードが混在している。**制御フローの合流点や判定点を、実行される要素と同じ形で表現する**ことで、ループが 1 種類で済む。パーサの世界で言えば、文法規則と還元アクションを同じテーブルに載せるのと同じ形だ。

## どう活かすか

### そのまま真似できるところ

**拡張点を「配列への登録」にする。** 優先度も依存宣言も持たせず、「どの段に入るか」だけを選ばせる。段の数を先に決めておくと、拡張が可能な範囲がドキュメントなしで分かる。

**起動時に、実行時の構造を組み立てておく。** 設定を読み終わった時点で、「実際に呼ばれるものだけ」を並べた配列を作る。ミドルウェアチェーンやフィルタパイプラインを持つシステムなら、リクエストごとに構築するのではなく 1 回だけ構築する。使われない機能のコストが完全にゼロになる。

**「次にどこへ行くか」をデータとして持つ。** `next` フィールド 1 つで、順次実行・スキップ・ループ back が全部表せる。制御フローをコードではなくデータで表すと、全体像を 1 箇所で確認できる。

**段ごとの「戻り値の解釈」を、専用の関数に切り出す。** Nginx の checker がそれで、7 個の関数を読めば制御フローの全パターンが分かる。ハンドラ側は素直な値を返すだけでよくなる。

**制御ノードを、実行ノードと同じ配列に混ぜる。** 「ここで判定する」「ここに戻る」を要素として表現すると、ループが 1 種類で済む。

**進行位置を、ループのローカル変数ではなくコンテキストに置く。** `r->phase_handler` がリクエストのメンバであることが、中断と再開を可能にしている。非同期なミドルウェアチェーンを書くなら必須の形になる。

**ABI 互換性を、バージョン番号ではなくビルド条件の集合で判定する。** 条件コンパイルで構造体のレイアウトが変わりうるなら、その条件を文字列に固めて比較する。プラグインをバイナリで配る仕組みを作るときに、そのまま使える。

### 取り込むべきでない条件

**順序をビルド順に委ねるのは、Nginx の弱点でもある。** 「モジュールの登録順が挙動を変える」は、ユーザーから見て予測しにくい。プラグインの数が多いシステムで同じことをすると、順序に起因する問題が定期的に出る。優先度や依存の宣言を入れるなら、循環の検出とエラー報告まで含めて設計する必要がある。

**checker と handler で同じ定数の意味が違うのは、読みにくい。** `NGX_OK` が階層によって「成功」だったり「ループを止めろ」だったりする。型で区別できるなら、そのほうがいい。

**フェーズを固定するのは、ドメインが安定しているから成立する。** HTTP のリクエスト処理は 20 年変わっていない。ドメインがまだ動いているうちに段を固定すると、後から入らないものが出てくる。実際 Nginx も `PRECONTENT` を後から足している。

**「配列を舐めるだけ」のループは、デバッグしにくい。** 何が起きているかを知るには、組み立ての結果を見るしかない。Nginx はデバッグログに `"generic phase: %ui"` のようにフェーズの添字を出しているが、それでも配列の中身を見ないと意味が取れない。表駆動にするなら、表をダンプする手段を一緒に用意しておくといい。

## 関連

- モジュールの残り 6 つのフック (`create_*_conf` / `merge_*_conf`) は [設定マージのページ](../conf-merge/)。
- 出力側の拡張点は、フェーズではなくリンクリストになっている。[出力フィルタチェーンのページ](../output-filter-chain/)。
- checker が `NGX_OK` を返してループを抜ける = 中断する仕組みは [ステートマシンのページ](../state-machine/)。

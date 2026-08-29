---
title: "設定の継承を「未設定」という第 3 の状態で表し、マージを機械的にする"
description: "http / server / location の 3 階層で、書かれた設定だけが子に降りてくる。Nginx は全フィールドを NGX_CONF_UNSET で初期化し、パース後に親子を突き合わせる。「未設定」を型の中の 1 つの値として持つので、マージは 1 フィールド 1 行のマクロで書け、同じ値が「同じディレクティブが 2 回書かれた」の検出にも使い回される。"
group: "設計の掘り下げ"
sidebar:
  order: 42
---

## 何を学んだか

### どんな状況の話か

Nginx の設定はブロックが入れ子になっている。

```nginx
http {
    gzip on;
    server {
        gzip_min_length 1000;
        location /api/ {
            gzip off;
        }
    }
}
```

`location /api/` の中では `gzip off` と `gzip_min_length 1000` が効き、`gzip_comp_level` は書かれていないので既定値になる。つまり **「書かれた設定は子に降り、子で上書きできる。どこにも書かれていなければ既定値」** という規則がある。

モジュールは 100 個以上あり、それぞれ十数個のディレクティブを持つ。全部の組み合わせについてこの規則を実装しなければならない。しかも C なので `undefined` も `null` も無い。`gzip_comp_level 0;` と「`gzip_comp_level` が書かれていない」を、`int` 1 個でどう区別するか。

### Nginx の答え

1. **「未設定」を型ごとに専用の値として定義する。** `NGX_CONF_UNSET` = -1、`NGX_CONF_UNSET_UINT` = `(ngx_uint_t) -1`、`NGX_CONF_UNSET_SIZE`、`NGX_CONF_UNSET_MSEC`、`NGX_CONF_UNSET_PTR`。
2. **`create_loc_conf` で全フィールドを UNSET に初期化する。** ここでは既定値を入れない。
3. **パースが終わってから、親子を突き合わせる `merge_loc_conf` を呼ぶ。** ここで初めて既定値が入る。
4. **マージは 1 フィールド 1 行のマクロ。** `ngx_conf_merge_value(conf->level, prev->level, 1)` は「自分が未設定なら、親を見る。親も未設定なら 1」。
5. **`http` / `server` / `location` の 3 階層ぶん、同じ構造体を作る。** `location` が入れ子なら、その深さぶん作る。マージは木を再帰的に降りていく。
6. **同じ UNSET 値が、重複検出にも使われる。** ディレクティブを処理する時点で値が UNSET でなければ「2 回書かれた」ということなので `"is duplicate"` を返す。
7. **ディレクティブの定義は、コードではなくテーブル。** 名前・使える場所・引数の数・格納先のオフセット・パース関数を並べた `ngx_command_t` の配列で、検証は全部コアがやる。

## ソースコードのどこか

### 未設定の値

[`src/core/ngx_conf_file.h#L56-L60`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_conf_file.h#L56-L60)。

```c title="src/core/ngx_conf_file.h"
#define NGX_CONF_UNSET       -1
#define NGX_CONF_UNSET_UINT  (ngx_uint_t) -1
#define NGX_CONF_UNSET_PTR   (void *) -1
#define NGX_CONF_UNSET_SIZE  (size_t) -1
#define NGX_CONF_UNSET_MSEC  (ngx_msec_t) -1
```

すべて `-1` のビットパターン。符号付きなら -1、符号なしなら最大値、ポインタなら `(void *) -1`。**「ありえない値」を型ごとに 1 つ決めているだけ**で、特別な仕組みは無い。

`(void *) -1` を「未設定」に使えるのは、`NULL` を有効な値として使いたい場面があるから。`NULL` を UNSET にしてしまうと、「明示的に NULL を設定した」が表せなくなる。

`ngx_str_t` と `ngx_bufs_t` には UNSET が無い。前者は `data == NULL` を、後者は `num == 0` を未設定とみなす。構造体なので、フィールドの 1 つを見れば足りる。

### 初期化とマージ

`ngx_http_gzip_filter_module` が短くて分かりやすい ([`src/http/modules/ngx_http_gzip_filter_module.c#L1064-L1124`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/modules/ngx_http_gzip_filter_module.c#L1064-L1124))。

```c title="src/http/modules/ngx_http_gzip_filter_module.c"
static void *
ngx_http_gzip_create_conf(ngx_conf_t *cf)
{
    ngx_http_gzip_conf_t  *conf;

    conf = ngx_pcalloc(cf->pool, sizeof(ngx_http_gzip_conf_t));
    if (conf == NULL) {
        return NULL;
    }

    /*
     * set by ngx_pcalloc():
     *
     *     conf->bufs.num = 0;
     *     conf->types = { NULL };
     *     conf->types_keys = NULL;
     */

    conf->enable = NGX_CONF_UNSET;
    conf->no_buffer = NGX_CONF_UNSET;

    conf->postpone_gzipping = NGX_CONF_UNSET_SIZE;
    conf->level = NGX_CONF_UNSET;
    conf->wbits = NGX_CONF_UNSET_SIZE;
    conf->memlevel = NGX_CONF_UNSET_SIZE;
    conf->min_length = NGX_CONF_UNSET;

    return conf;
}
```

`ngx_pcalloc` でゼロ埋めしてから、**「ゼロが未設定を意味しないフィールドだけ」** を明示的に UNSET にする。コメントで「ゼロ埋めで済むフィールド」を列挙しているのは Nginx 全体の慣習で、`create_*_conf` にはほぼ必ずこの形のコメントがある。全フィールドが `create` の中で一度は言及されることになるので、フィールドを追加したときに初期化を忘れたかどうかが目で確認できる。

マージ側。

```c title="src/http/modules/ngx_http_gzip_filter_module.c"
static char *
ngx_http_gzip_merge_conf(ngx_conf_t *cf, void *parent, void *child)
{
    ngx_http_gzip_conf_t *prev = parent;
    ngx_http_gzip_conf_t *conf = child;

    ngx_conf_merge_value(conf->enable, prev->enable, 0);
    ngx_conf_merge_value(conf->no_buffer, prev->no_buffer, 0);

    ngx_conf_merge_bufs_value(conf->bufs, prev->bufs,
                              (128 * 1024) / ngx_pagesize, ngx_pagesize);

    ngx_conf_merge_size_value(conf->postpone_gzipping, prev->postpone_gzipping,
                              0);
    ngx_conf_merge_value(conf->level, prev->level, 1);
    ngx_conf_merge_size_value(conf->wbits, prev->wbits, MAX_WBITS);
    ngx_conf_merge_size_value(conf->memlevel, prev->memlevel,
                              MAX_MEM_LEVEL - 1);
    ngx_conf_merge_value(conf->min_length, prev->min_length, 20);

    if (ngx_http_merge_types(cf, &conf->types_keys, &conf->types,
                             &prev->types_keys, &prev->types,
                             ngx_http_html_default_types)
        != NGX_CONF_OK)
    {
        return NGX_CONF_ERROR;
    }

    return NGX_CONF_OK;
}
```

**1 フィールド 1 行で、既定値がその行に書いてある。** `gzip_comp_level` の既定が 1 であることが、この 1 行を見れば分かる。ドキュメントと実装が離れにくい。

マクロの中身 ([`src/core/ngx_conf_file.h#L205-L213`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_conf_file.h#L205-L213))。

```c title="src/core/ngx_conf_file.h"
#define ngx_conf_merge_value(conf, prev, default)                            \
    if (conf == NGX_CONF_UNSET) {                                            \
        conf = (prev == NGX_CONF_UNSET) ? default : prev;                    \
    }

#define ngx_conf_merge_ptr_value(conf, prev, default)                        \
    if (conf == NGX_CONF_UNSET_PTR) {                                        \
        conf = (prev == NGX_CONF_UNSET_PTR) ? default : prev;                \
    }
```

3 行。**「自分が未設定なら、親を見る。親も未設定なら既定値」** がそのまま書いてある。型ごとに同じものが 8 個並んでいる。C にジェネリクスが無いので、型ごとにマクロを複製している。

`ngx_str_t` 用は少し形が違う ([`#L240-L249`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_conf_file.h#L240-L249))。

```c title="src/core/ngx_conf_file.h"
#define ngx_conf_merge_str_value(conf, prev, default)                        \
    if (conf.data == NULL) {                                                 \
        if (prev.data) {                                                     \
            conf.len = prev.len;                                             \
            conf.data = prev.data;                                           \
        } else {                                                             \
            conf.len = sizeof(default) - 1;                                  \
            conf.data = (u_char *) default;                                  \
        }                                                                    \
    }
```

既定値がリテラル文字列であることを前提に、`sizeof(default) - 1` で長さをコンパイル時に計算する。`ngx_str_t` は NUL 終端に依存しないので長さが必須で、**マクロが長さの計算を隠している**ぶん、呼び出し側は `"text/html"` と書くだけで済む。

そして `init` 系のマクロ ([`#L180-L203`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_conf_file.h#L180-L203))。

```c title="src/core/ngx_conf_file.h"
#define ngx_conf_init_value(conf, default)                                   \
    if (conf == NGX_CONF_UNSET) {                                            \
        conf = default;                                                      \
    }
```

親を持たない設定 (`main_conf` や、`events` ブロックの中身) 用。`init_main_conf` から呼ばれる。

### 3 階層ぶんの構造体を作る

`ngx_http_block()` が `http { }` を見つけたときにやること ([`src/http/ngx_http.c#L155-L217`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http.c#L155-L217))。

```c title="src/http/ngx_http.c"
    ctx->main_conf = ngx_pcalloc(cf->pool,
                                 sizeof(void *) * ngx_http_max_module);
    /* ... */

    /*
     * the http null srv_conf context, it is used to merge
     * the server{}s' srv_conf's
     */

    ctx->srv_conf = ngx_pcalloc(cf->pool, sizeof(void *) * ngx_http_max_module);
    /* ... */

    /*
     * the http null loc_conf context, it is used to merge
     * the server{}s' loc_conf's
     */

    ctx->loc_conf = ngx_pcalloc(cf->pool, sizeof(void *) * ngx_http_max_module);
    /* ... */

    for (m = 0; cf->cycle->modules[m]; m++) {
        if (cf->cycle->modules[m]->type != NGX_HTTP_MODULE) {
            continue;
        }

        module = cf->cycle->modules[m]->ctx;
        mi = cf->cycle->modules[m]->ctx_index;

        if (module->create_main_conf) {
            ctx->main_conf[mi] = module->create_main_conf(cf);
            /* ... */
        }

        if (module->create_srv_conf) {
            ctx->srv_conf[mi] = module->create_srv_conf(cf);
            /* ... */
        }

        if (module->create_loc_conf) {
            ctx->loc_conf[mi] = module->create_loc_conf(cf);
            /* ... */
        }
    }
```

**`http { }` の直下にも `srv_conf` と `loc_conf` を作る。** コメントの "the http null srv_conf context" がそれで、`http` レベルに書かれた `gzip on;` は、この「偽の server」の `loc_conf` に入る。実際の `server { }` をマージするときの親になる。

**「親を持たない場合」を無くすために、ルートに空の親を作る**という形になっている。マージのコードに「親がいない」の分岐が要らなくなる。

構造体は `void *` の配列で持たれ、添字が `ctx_index`。だからモジュールは自分の設定を `ctx->loc_conf[ngx_http_gzip_filter_module.ctx_index]` で引ける。これがマクロになっている ([`src/http/ngx_http_config.h#L55-L58`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_config.h#L55-L58))。

```c title="src/http/ngx_http_config.h"
#define ngx_http_get_module_main_conf(r, module)                             \
    (r)->main_conf[module.ctx_index]
#define ngx_http_get_module_srv_conf(r, module)  (r)->srv_conf[module.ctx_index]
#define ngx_http_get_module_loc_conf(r, module)  (r)->loc_conf[module.ctx_index]
```

`ctx_index` は「HTTP モジュールの中で何番目か」で、起動時に採番される。**リクエストから設定を引くコストが、配列の添字アクセス 1 回**になっている。ハッシュもリストの探索も無い。

### マージは木を再帰的に降りる

パースが終わってから、モジュールごとにマージを走らせる ([`src/http/ngx_http.c#L254-L275`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http.c#L254-L275))。

```c title="src/http/ngx_http.c"
    for (m = 0; cf->cycle->modules[m]; m++) {
        if (cf->cycle->modules[m]->type != NGX_HTTP_MODULE) {
            continue;
        }

        module = cf->cycle->modules[m]->ctx;
        mi = cf->cycle->modules[m]->ctx_index;

        /* init http{} main_conf's */

        if (module->init_main_conf) {
            rv = module->init_main_conf(cf, ctx->main_conf[mi]);
            /* ... */
        }

        rv = ngx_http_merge_servers(cf, cmcf, module, mi);
        /* ... */
    }
```

**外側のループがモジュール、内側が設定の木**になっている。モジュールごとに木を丸ごと 1 周する。逆 (木を 1 周しながら全モジュールをマージ) でも結果は同じだが、この向きだとモジュール 1 個ぶんの処理が独立して読める。

`ngx_http_merge_servers()` ([`#L563-L622`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http.c#L563-L622))。

```c title="src/http/ngx_http.c"
    for (s = 0; s < cmcf->servers.nelts; s++) {

        /* merge the server{}s' srv_conf's */

        ctx->srv_conf = cscfp[s]->ctx->srv_conf;

        if (module->merge_srv_conf) {
            rv = module->merge_srv_conf(cf, saved.srv_conf[ctx_index],
                                        cscfp[s]->ctx->srv_conf[ctx_index]);
            if (rv != NGX_CONF_OK) {
                goto failed;
            }
        }

        if (module->merge_loc_conf) {

            /* merge the server{}'s loc_conf */

            ctx->loc_conf = cscfp[s]->ctx->loc_conf;

            rv = module->merge_loc_conf(cf, saved.loc_conf[ctx_index],
                                        cscfp[s]->ctx->loc_conf[ctx_index]);
            if (rv != NGX_CONF_OK) {
                goto failed;
            }

            /* merge the locations{}' loc_conf's */

            clcf = cscfp[s]->ctx->loc_conf[ngx_http_core_module.ctx_index];

            rv = ngx_http_merge_locations(cf, clcf->locations,
                                          cscfp[s]->ctx->loc_conf,
                                          module, ctx_index);
            /* ... */
        }
    }

failed:

    *ctx = saved;

    return rv;
```

`server` の `srv_conf` を `http` の null srv_conf とマージし、`server` の `loc_conf` を `http` の null loc_conf とマージし、それから `location` へ降りる。

`saved = *ctx` して最後に `*ctx = saved` で戻すのは、`cf->ctx` が **現在位置を表すグローバルな状態**だからだ。マージ中に呼ばれるモジュールのコードが `ngx_http_conf_get_module_loc_conf(cf, ...)` を使うので、正しい位置を指していないといけない。`goto failed` でもラベルの後で復元されるので、エラーパスでも状態が壊れない。

`location` は再帰 ([`#L625-L667`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http.c#L625-L667))。

```c title="src/http/ngx_http.c"
    for (q = ngx_queue_head(locations);
         q != ngx_queue_sentinel(locations);
         q = ngx_queue_next(q))
    {
        lq = (ngx_http_location_queue_t *) q;

        clcf = lq->exact ? lq->exact : lq->inclusive;
        ctx->loc_conf = clcf->loc_conf;

        rv = module->merge_loc_conf(cf, loc_conf[ctx_index],
                                    clcf->loc_conf[ctx_index]);
        if (rv != NGX_CONF_OK) {
            return rv;
        }

        rv = ngx_http_merge_locations(cf, clcf->locations, clcf->loc_conf,
                                      module, ctx_index);
        if (rv != NGX_CONF_OK) {
            return rv;
        }
    }
```

**親をマージしてから子に降りる (前順走査)。** これが重要で、親が既にマージ済み = 既定値まで解決済みになっているので、子は「親の値」を見れば必ず具体的な値が得られる。UNSET が残っているのは自分のフィールドだけになる。

だから `ngx_conf_merge_value(conf, prev, default)` の `prev == NGX_CONF_UNSET` の判定は、**実はほとんどの場合で偽になる**。真になるのは最上位のマージのときだけだ。

### 同じ値が重複検出にも使われる

ディレクティブを処理する関数の共通の形 ([`src/core/ngx_conf_file.c#L1259-L1287`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_conf_file.c#L1259-L1287))。

```c title="src/core/ngx_conf_file.c"
char *
ngx_conf_set_msec_slot(ngx_conf_t *cf, ngx_command_t *cmd, void *conf)
{
    char  *p = conf;

    ngx_msec_t       *msp;
    ngx_str_t        *value;
    ngx_conf_post_t  *post;


    msp = (ngx_msec_t *) (p + cmd->offset);
    if (*msp != NGX_CONF_UNSET_MSEC) {
        return "is duplicate";
    }

    value = cf->args->elts;

    *msp = ngx_parse_time(&value[1], 0);
    if (*msp == (ngx_msec_t) NGX_ERROR) {
        return "invalid value";
    }

    if (cmd->post) {
        post = cmd->post;
        return post->post_handler(cf, post, msp);
    }

    return NGX_CONF_OK;
}
```

**`*msp != NGX_CONF_UNSET_MSEC` は「既に誰かが書いた」を意味する。** 同じブロックに同じディレクティブを 2 回書くと、2 回目でここに引っかかって `"is duplicate"` が返る。

UNSET が「まだ誰も書いていない」を表すので、重複検出のための別のフラグが要らない。1 つの値に 2 つの役割を持たせているが、意味は一貫している。

返り値が `char *` で、エラーメッセージそのものを返すのも独特だ。コアがこう組み立てる ([`#L473-L476`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_conf_file.c#L473-L476))。

```c title="src/core/ngx_conf_file.c"
            ngx_conf_log_error(NGX_LOG_EMERG, cf, 0,
                               "\"%s\" directive %s", name->data, rv);
```

`"\"proxy_read_timeout\" directive is duplicate"` になる。**エラーメッセージの前半 (どのディレクティブか、どのファイルの何行目か) をコアが、後半 (何が悪いか) をモジュールが担当する。** モジュール側は文字列リテラルを `return` するだけでよく、フォーマットもファイル名も行番号も知らなくていい。

### ディレクティブの定義はテーブル

[`src/core/ngx_conf_file.h#L77-L86`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_conf_file.h#L77-L86)。

```c title="src/core/ngx_conf_file.h"
struct ngx_command_s {
    ngx_str_t             name;
    ngx_uint_t            type;
    char               *(*set)(ngx_conf_t *cf, ngx_command_t *cmd, void *conf);
    ngx_uint_t            conf;
    ngx_uint_t            offset;
    void                 *post;
};

#define ngx_null_command  { ngx_null_string, 0, NULL, 0, 0, NULL }
```

`type` にはビットが詰まっている ([`#L16-L52`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_conf_file.h#L16-L52))。

```c title="src/core/ngx_conf_file.h"
/*
 *        AAAA  number of arguments
 *      FF      command flags
 *    TT        command type, i.e. HTTP "location" or "server" command
 */

#define NGX_CONF_NOARGS      0x00000001
#define NGX_CONF_TAKE1       0x00000002
/* ... */
#define NGX_CONF_BLOCK       0x00000100
#define NGX_CONF_FLAG        0x00000200
#define NGX_CONF_ANY         0x00000400
#define NGX_CONF_1MORE       0x00000800
#define NGX_CONF_2MORE       0x00001000
```

先頭のコメントが、32 ビットをどう分割しているかを示している。下位 8 ビットが引数の数 (ビットマスクなので `TAKE12` は 1 個か 2 個の意味)、次がフラグ、上位 8 ビットが「どのブロックに書けるか」。

コアがこれを全部検証する ([`src/core/ngx_conf_file.c#L375-L461`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_conf_file.c#L375-L461))。

```c title="src/core/ngx_conf_file.c"
            found = 1;

            if (cf->cycle->modules[i]->type != NGX_CONF_MODULE
                && cf->cycle->modules[i]->type != cf->module_type)
            {
                continue;
            }

            /* is the directive's location right ? */

            if (!(cmd->type & cf->cmd_type)) {
                continue;
            }

            if (!(cmd->type & NGX_CONF_BLOCK) && last != NGX_OK) {
                ngx_conf_log_error(NGX_LOG_EMERG, cf, 0,
                                  "directive \"%s\" is not terminated by \";\"",
                                  name->data);
                return NGX_ERROR;
            }
            /* ... 引数の数のチェック ... */

            /* set up the directive's configuration context */

            conf = NULL;

            if (cmd->type & NGX_DIRECT_CONF) {
                conf = ((void **) cf->ctx)[cf->cycle->modules[i]->index];

            } else if (cmd->type & NGX_MAIN_CONF) {
                conf = &(((void **) cf->ctx)[cf->cycle->modules[i]->index]);

            } else if (cf->ctx) {
                confp = *(void **) ((char *) cf->ctx + cmd->conf);

                if (confp) {
                    conf = confp[cf->cycle->modules[i]->ctx_index];
                }
            }

            rv = cmd->set(cf, cmd, conf);
```

**`set` 関数が呼ばれる時点で、名前が一致し、書ける場所にあり、引数の数が合っていて、書き込むべき構造体が特定されている。** モジュールの `set` 関数は「値をパースして代入する」だけでいい。だから `ngx_conf_set_msec_slot` のような汎用の関数が使い回せる。

`cmd->conf` の使い方が巧妙で、これは `ngx_http_conf_ctx_t` の中でのオフセットが入る (`NGX_HTTP_LOC_CONF_OFFSET` = `offsetof(ngx_http_conf_ctx_t, loc_conf)`)。**「main か srv か loc か」をオフセットで表す**ので、コアは HTTP の構造を知らなくても正しい配列を選べる。同じコードが `stream` や `mail` でも動く。

`found` の扱いも丁寧で、名前は一致したが場所やモジュール種別が合わなかった場合を覚えておく ([`#L480-L488`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_conf_file.c#L480-L488))。

```c title="src/core/ngx_conf_file.c"
    if (found) {
        ngx_conf_log_error(NGX_LOG_EMERG, cf, 0,
                           "\"%s\" directive is not allowed here", name->data);

        return NGX_ERROR;
    }

    ngx_conf_log_error(NGX_LOG_EMERG, cf, 0,
                       "unknown directive \"%s\"", name->data);
```

**「知らないディレクティブ」と「ここには書けないディレクティブ」を区別する。** タイプミスなのか場所の間違いなのかで、ユーザーが次にやることが変わる。

## なぜそうなっているか

### なぜ「作るときに既定値を入れる」ではダメなのか

`create_loc_conf` で既定値を入れてしまうと、**`location` の設定と `server` の設定の区別がつかなくなる**。

```nginx
server {
    gzip_comp_level 5;
    location /a/ { }
}
```

`location /a/` の `gzip_comp_level` を「作るときに既定の 1」にしてしまうと、マージのときに「1 は既定値なのか、明示的に 1 と書かれたのか」が分からない。親の 5 を継がせるべきか、自分の 1 を使うべきかが決められない。

**「未設定」という第 3 の状態を持つことが、継承を表現するための必要条件**になっている。TypeScript の `undefined` と `null` の区別、Rust の `Option<T>`、Java の `Optional` が解いているのと同じ問題を、C で「ありえない値」を決めることで解いている。

### 「ありえない値」を使うことのコスト

`-1` を未設定にするということは、**`-1` を有効な値として設定できない**ということだ。実際、`worker_priority -1;` のような負の値を取るディレクティブでは、UNSET を別の値にするか、専用の判定を書く必要が出てくる。

Nginx がこれで大きく困っていないのは、設定値のほとんどがサイズ・時間・カウント・真偽値で、負の値に意味が無いからだ。**ドメインを見て「使わない値」を確信できるときにだけ成立する**やり方になっている。

`(void *) -1` はもう少し危うい。有効なポインタが `-1` になることはまず無いが、`mmap` が `MAP_FAILED` として `(void *) -1` を返すのと同じ理由で「無効な値」とみなしているだけで、規格上の保証があるわけではない。

### マクロがマージを「機械的」にしている

`merge_loc_conf` は 100 個以上のモジュールが書く関数で、**書き方を間違えると継承が壊れるが、テストで気づきにくい**。「`location` の中で設定が効かない」は動くコードとして通ってしまう。

そこでマクロにして、書ける形を 1 通りに絞っている。`ngx_conf_merge_value(A, B, C)` の A は自分、B は親、C は既定。この順序さえ守れば正しく動く。順序を間違えるとコンパイルは通るが動作がおかしくなるので完全な安全網ではないが、**行の形が揃っているのでレビューで気づける**。

副次的な効果として、**既定値の一覧が `merge_*_conf` を見れば分かる**。Nginx のドキュメントに書かれている既定値と、コードの `merge` 関数の第 3 引数が 1 対 1 に対応している。

### 親を先にマージすることで、条件が 1 つ減る

前順走査で降りていくので、子がマージされる時点で親は既に完全に解決済みになっている。もし後順 (子から先) にすると、親がまだ UNSET のまま子にマージされることになり、**「親も未設定なら、そのまた親を見る」という再帰が必要**になる。

前順にすることで、マージのマクロが 1 段しか見なくてよくなっている。`prev == NGX_CONF_UNSET` の判定が残っているのは、最上位 (`http` レベル) のマージのためだけだ。

**走査順を決めることで、各ステップのロジックを単純にする**という形で、動的計画法の考え方に近い。

### `cf->ctx` というグローバルな現在位置

設定のパース中、`cf->ctx` は「今どのブロックの中にいるか」を表す。`server { }` に入るときに差し替え、出るときに戻す。マージ中も同じように動かしている。

これは実質的にグローバル変数で、保存と復元を書き忘れると壊れる。Nginx のコードには `saved = *ctx; ... *ctx = saved;` が何度も出てくる。

引数で渡すほうが安全だが、**`ngx_command_t` の `set` 関数のシグネチャが `(cf, cmd, conf)` で固定されている**ので、追加の文脈を渡す場所が無い。`cf` に全部を持たせる設計を選んだ以上、こうなる。テーブル駆動にするために引数を固定した代償だ。

### エラーメッセージを分担する

`set` 関数が `"is duplicate"` という文字列を返し、コアが `"\"%s\" directive %s"` に埋める。この分担がうまくいっているのは、**エラーの文脈 (ファイル名・行番号・ディレクティブ名) をコアが全部持っている**からだ。

モジュールが自分でログを書く設計にすると、100 個のモジュールがそれぞれ `ngx_conf_log_error(NGX_LOG_EMERG, cf, 0, "\"foo\" directive ...")` と書くことになり、書式がばらつく。文字列を返すだけにすることで、**設定エラーのメッセージが全部同じ形になる**。

## どう活かすか

### そのまま真似できるところ

**継承のある設定では、「未設定」を明示的な状態として持つ。** これは設計の必要条件で、既定値を早く埋めると継承が表現できなくなる。`Option<T>` や `undefined` がある言語なら素直に使う。無いなら「ありえない値」を決めて、ドメイン上それが本当に使われないことを確認する。

**既定値を入れるタイミングを、読み込みの後まで遅らせる。** 「パースする」「継承を解決する」「既定値を埋める」の 3 段に分けると、それぞれが単純になる。読みながら埋めようとすると、順序に依存したバグが出る。

**継承の解決は、親から子へ (前順) 走査する。** 各ステップで 1 段だけ見れば済むようになる。

**ルートに空の親を作って、「親がいない」を無くす。** Nginx の "null srv_conf" がそれで、マージのコードから特殊ケースが消える。

**既定値を、マージのコードにインラインで書く。** 定数テーブルを別に持つより、`merge(conf->x, prev->x, 20)` の形で 1 行に収まっているほうが、実装とドキュメントがずれにくい。

**「未設定」を重複検出にも使う。** 追加のフラグを持たずに「まだ誰も書いていない」が判定できる。

**エラーメッセージを、文脈 (コア) と理由 (モジュール) に分ける。** 拡張可能なシステムで、エラー出力の形式を揃える一番安い方法になる。モジュール側は文字列リテラルを返すだけでよくなる。

**「知らない名前」と「ここでは使えない名前」を区別する。** ユーザーが次に何をすべきかが変わる。設定パーサやコマンドラインパーサを書くなら必ず入れたい。

**設定の定義をテーブルにして、検証をコアに寄せる。** 引数の数、書ける場所、型、格納先のオフセット。全部データにすれば、個々のハンドラは値を代入するだけになる。

### 取り込むべきでない条件

**`-1` を未設定に使うのは、ドメイン次第。** 負の値やゼロが有効な設定では破綻する。実際 Nginx でも `ngx_str_t` と `ngx_bufs_t` は別の判定になっている。型ごとに規約がばらつくので、`Option` が使える環境ならそちらのほうがいい。

**マクロによる型ごとの複製は、C の制約から来ている。** ジェネリクスがあるなら 1 つの関数で済む。8 個のマクロを手で同期するのは、増やすときに漏れる。

**`cf->ctx` のようなグローバルな現在位置は、保存と復元を書き忘れると壊れる。** 引数で渡せるなら渡す。Nginx がこうなっているのは、テーブル駆動のためにシグネチャを固定した結果だ。

**設定がフラットな (継承の無い) システムでは、この複雑さは要らない。** 3 階層のマージ、null 親、前順走査は、全部「継承がある」ことのコストとして払われている。継承を入れるかどうかは、そのコストに見合うかを先に考える。

## 関連

- モジュールの残り 2 つのフック (`preconfiguration` / `postconfiguration`) を含めた 8 本の並びは [モジュールシステムのページ](../module-system/)。`postconfiguration` で handler を登録する側は [フェーズエンジンのページ](../phase-engine/)。
- `ngx_command_t` を名前で引いて `create_*_conf` の結果に値を書き込む側は [設定パースのページ](../conf-parse/)。
- `ngx_conf_merge_bufs_value` が扱う `ngx_bufs_t` は [buf と chain のページ](../buf-chain/)。
- ここで作られた `loc_conf` を実行時に引くのが `ngx_http_get_module_loc_conf()` で、[変数のページ](../variables/) でも頻繁に出てくる。

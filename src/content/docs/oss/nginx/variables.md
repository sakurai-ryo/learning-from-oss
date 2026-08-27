---
title: "設定に書かれた `$変数` を、参照されたときに初めて評価してキャッシュする"
description: "$remote_addr も $upstream_response_time も、値ではなく「値を計算する関数」として登録されている。設定を読む時点で名前を配列の添字に変換しておき、実行時はハッシュを引かずに配列を舐める。一度評価した値はリクエストに残り、途中で変わりうる変数だけが nocacheable の印で毎回捨てられる。"
group: "拡張の仕組み"
sidebar:
  order: 15
---

## 何を学んだか

### どんな状況の話か

Nginx の設定には `$` で始まる名前が書ける。

```nginx
log_format  main  '$remote_addr - $remote_user [$time_local] "$request" '
                  '$status $body_bytes_sent "$http_referer" '
                  '"$http_user_agent" "$http_x_forwarded_for"';

proxy_set_header  X-Real-IP  $remote_addr;

if ($http_user_agent ~* MSIE) { ... }
```

これらは全部リクエストごとに違う値になる。しかも **中身の作り方がまるで違う**。`$remote_addr` はソケットから取れる。`$time_local` は現在時刻をフォーマットする。`$http_user_agent` はヘッダのリストから探す。`$http_x_custom_header` のように、**任意の名前が使える** ものまである。`$upstream_response_time` に至っては、上流と通信し終わるまで値が決まらない。

さらに、変数は 200 個以上あるのに、1 つのリクエストで実際に参照されるのは 10 個程度だ。全部を先に計算するのは無駄になる。

### Nginx の答え

1. **変数を「値」ではなく「値を計算する関数」として登録する。** `ngx_http_variable_t` は名前と `get_handler` の組。
2. **参照されたときに初めて `get_handler` を呼ぶ。** 使わない変数は 1 命令も消費しない。
3. **設定を読む時点で、名前を配列の添字に変換する。** 実行時に文字列のハッシュを引かない。
4. **一度評価した値はリクエストの配列に残す。** 同じ変数を 10 箇所で参照しても評価は 1 回。
5. **途中で値が変わる変数には `NOCACHEABLE` の印を付ける。** `$uri` は `rewrite` で変わるので、参照のたびに評価し直す。
6. **`$http_` / `$arg_` / `$cookie_` などは「プレフィックス変数」として、名前の一部をハンドラに渡す。** 事前に登録できない無数の名前を、1 つのエントリで扱う。
7. **ハンドラは `uintptr_t data` を受け取る。** ここに `offsetof` を入れることで、1 つのハンドラを何十個の変数で共有する。
8. **設定を読み終わった時点で、名前が解決できない変数はエラーにする。** タイポは起動時に落ちる。

## ソースコードのどこか

### 変数の定義と値

[`src/http/ngx_http_variables.h#L37-L44`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_variables.h#L37-L44)。

```c title="src/http/ngx_http_variables.h"
struct ngx_http_variable_s {
    ngx_str_t                     name;   /* must be first to build the hash */
    ngx_http_set_variable_pt      set_handler;
    ngx_http_get_variable_pt      get_handler;
    uintptr_t                     data;
    ngx_uint_t                    flags;
    ngx_uint_t                    index;
};
```

コメントの "must be first to build the hash" は、`ngx_hash_t` が「先頭が `ngx_str_t name` である構造体」を前提にしているため。**汎用のハッシュに任意の構造体を入れるための約束事**が、構造体のレイアウトとして表れている。

値のほうは 8 バイト ([`src/core/ngx_string.h#L28-L37`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_string.h#L28-L37))。

```c title="src/core/ngx_string.h"
typedef struct {
    unsigned    len:28;

    unsigned    valid:1;
    unsigned    no_cacheable:1;
    unsigned    not_found:1;
    unsigned    escape:1;

    u_char     *data;
} ngx_variable_value_t;
```

`ngx_str_t` は `{ size_t len; u_char *data; }` で 16 バイトだが、こちらは長さを 28 ビットに削って 4 ビットのフラグを詰め込み、**64 ビット環境でも 16 バイト、32 ビットなら 8 バイト**に収めている。変数の数だけリクエストごとに確保される配列なので、サイズが効く。

フラグの意味が重要だ。

- `valid`: 評価済みで、値が入っている。
- `not_found`: 評価済みで、値が無かった。
- `no_cacheable`: この値は使い回してはいけない。
- `escape`: ログに出すときにエスケープが要る。

**`valid` と `not_found` の 2 ビットで 3 状態を表している。** どちらも 0 なら「まだ評価していない」。`ngx_pcalloc` でゼロ埋めするだけで「未評価」になるので、初期化のコードが要らない。

### 定義はテーブル

[`src/http/ngx_http_variables.c#L168-L400`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_variables.c#L168-L400)。200 行以上の巨大な配列。

```c title="src/http/ngx_http_variables.c"
static ngx_http_variable_t  ngx_http_core_variables[] = {

    { ngx_string("http_host"), NULL, ngx_http_variable_header,
      offsetof(ngx_http_request_t, headers_in.host), 0, 0 },

    { ngx_string("http_user_agent"), NULL, ngx_http_variable_header,
      offsetof(ngx_http_request_t, headers_in.user_agent), 0, 0 },

    { ngx_string("http_referer"), NULL, ngx_http_variable_header,
      offsetof(ngx_http_request_t, headers_in.referer), 0, 0 },
    /* ... */
```

**`data` に `offsetof` を入れている。** ハンドラは共通の `ngx_http_variable_header` で、渡されたオフセットで `ngx_http_request_t` の中を指す。

同じ手が `ngx_http_variable_request` にも使われている ([`#L758-L778`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_variables.c#L758-L778))。

```c title="src/http/ngx_http_variables.c"
static ngx_int_t
ngx_http_variable_request(ngx_http_request_t *r, ngx_http_variable_value_t *v,
    uintptr_t data)
{
    ngx_str_t  *s;

    s = (ngx_str_t *) ((char *) r + data);

    if (s->data) {
        v->len = s->len;
        v->valid = 1;
        v->no_cacheable = 0;
        v->not_found = 0;
        v->data = s->data;

    } else {
        v->not_found = 1;
    }

    return NGX_OK;
}
```

**`(char *) r + data` で構造体の中の任意の `ngx_str_t` を指す。** `$uri`、`$document_uri`、`$query_string`、`$args`、`$request_uri` が全部この 1 つの関数で処理される。

`v->data = s->data` で **文字列をコピーしていない**。`ngx_str_t` が長さ付きでポインタだけを持つので、リクエスト構造体の中の文字列をそのまま指せる。[メモリプール](../memory-pool/) のおかげで、この参照が壊れないことも保証されている (どちらも `r->pool` の中にあり、同時に消える)。

先頭のコメントも実装の判断を説明している ([`#L161-L166`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_variables.c#L161-L166))。

```c title="src/http/ngx_http_variables.c"
/*
 * the $http_host, $http_user_agent, $http_referer, and $http_via
 * variables may be handled by generic
 * ngx_http_variable_unknown_header_in(), but for performance reasons
 * they are handled using dedicated entries
 */
```

`$http_host` は `$http_` プレフィックスの一般処理でも扱えるが、よく使われるので専用エントリを置いている。**汎用の仕組みで足りるものに、性能のために特例を作った**という判断が、理由付きで残っている。

### インデックス化

設定を読むとき、`$foo` を見つけたら添字を確保する ([`#L559-L615`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_variables.c#L559-L615))。

```c title="src/http/ngx_http_variables.c"
ngx_http_get_variable_index(ngx_conf_t *cf, ngx_str_t *name)
{
    /* ... */
    v = cmcf->variables.elts;

    if (v == NULL) {
        /* ... 配列の初期化 ... */
    } else {
        for (i = 0; i < cmcf->variables.nelts; i++) {
            if (name->len != v[i].name.len
                || ngx_strncasecmp(name->data, v[i].name.data, name->len) != 0)
            {
                continue;
            }

            return i;
        }
    }

    v = ngx_array_push(&cmcf->variables);
    /* ... */
    v->index = cmcf->variables.nelts - 1;

    return v->index;
}
```

**同じ名前が既にあればその添字を返し、無ければ末尾に足して新しい添字を返す。** `log_format` に `$remote_addr` があり、`proxy_set_header` にも `$remote_addr` があれば、両方が同じ添字を持つ。

この時点では `get_handler` は `NULL` のまま。「この名前の変数を使う」という予約だけをしている。

リクエストが生まれるとき、この個数ぶんの配列を確保する ([`src/http/ngx_http_request.c#L630-L637`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_request.c#L630-L637))。

```c title="src/http/ngx_http_request.c"
    cmcf = ngx_http_get_module_main_conf(r, ngx_http_core_module);

    r->variables = ngx_pcalloc(r->pool, cmcf->variables.nelts
                                        * sizeof(ngx_http_variable_value_t));
```

**設定で実際に使われている変数のぶんだけ。** 定義されている 200 個ではなく、`nginx.conf` に書かれた 15 個ぶん、といった大きさになる。`ngx_pcalloc` のゼロ埋めが、そのまま全部「未評価」を意味する。

### 評価とキャッシュ

[`#L618-L665`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_variables.c#L618-L665)。

```c title="src/http/ngx_http_variables.c"
ngx_http_get_indexed_variable(ngx_http_request_t *r, ngx_uint_t index)
{
    /* ... */
    if (cmcf->variables.nelts <= index) {
        ngx_log_error(NGX_LOG_ALERT, r->connection->log, 0,
                      "unknown variable index: %ui", index);
        return NULL;
    }

    if (r->variables[index].not_found || r->variables[index].valid) {
        return &r->variables[index];
    }

    v = cmcf->variables.elts;

    if (ngx_http_variable_depth == 0) {
        ngx_log_error(NGX_LOG_ERR, r->connection->log, 0,
                      "cycle while evaluating variable \"%V\"",
                      &v[index].name);
        return NULL;
    }

    ngx_http_variable_depth--;

    if (v[index].get_handler(r, &r->variables[index], v[index].data)
        == NGX_OK)
    {
        ngx_http_variable_depth++;

        if (v[index].flags & NGX_HTTP_VAR_NOCACHEABLE) {
            r->variables[index].no_cacheable = 1;
        }

        return &r->variables[index];
    }

    ngx_http_variable_depth++;

    r->variables[index].valid = 0;
    r->variables[index].not_found = 1;

    return NULL;
}
```

**`not_found || valid` なら、評価済みなのでそのまま返す。** これがキャッシュのすべてで、別のキャッシュ構造は無い。値の置き場所そのものが、評価済みかどうかの記録を兼ねている。

`ngx_http_variable_depth` は 100 で初期化されるグローバルカウンタ ([`#L421`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_variables.c#L421))。変数の評価が別の変数を参照し、それがまた別を参照する、という連鎖の深さを制限する。`map` や `set` で循環を作ると、ここで検出されて `"cycle while evaluating variable"` になる。

**グローバル変数を「再帰の深さ」に使っているので、増やして減らすのを対にしないと壊れる。** 成功パスと失敗パスの両方で `++` が書かれているのはそのためだ。

`get_handler` が `NGX_OK` 以外を返したら `not_found = 1` を立てる。**次に同じ変数を参照しても、ハンドラは呼ばれない。** 「見つからなかった」という結果もキャッシュされる。

### 変わる変数

`$uri` は `rewrite` ディレクティブで書き換わる。だから「1 回評価したらそれっきり」では困る ([`#L247-L253`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_variables.c#L247-L253))。

```c title="src/http/ngx_http_variables.c"
    { ngx_string("uri"), NULL, ngx_http_variable_request,
      offsetof(ngx_http_request_t, uri),
      NGX_HTTP_VAR_NOCACHEABLE, 0 },

    { ngx_string("document_uri"), NULL, ngx_http_variable_request,
      offsetof(ngx_http_request_t, uri),
      NGX_HTTP_VAR_NOCACHEABLE, 0 },
```

`NOCACHEABLE` が付いた変数を正しく扱うのが `ngx_http_get_flushed_variable()` ([`#L668-L685`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_variables.c#L668-L685))。

```c title="src/http/ngx_http_variables.c"
ngx_http_variable_value_t *
ngx_http_get_flushed_variable(ngx_http_request_t *r, ngx_uint_t index)
{
    ngx_http_variable_value_t  *v;

    v = &r->variables[index];

    if (v->valid || v->not_found) {
        if (!v->no_cacheable) {
            return v;
        }

        v->valid = 0;
        v->not_found = 0;
    }

    return ngx_http_get_indexed_variable(r, index);
}
```

**`no_cacheable` が立っていたら、評価済みのフラグを消してから評価し直す。** 「キャッシュを無効化する」を「未評価の状態に戻す」で表している。状態が 1 種類しかないので、無効化のための別の仕組みが要らない。

`NOCACHEABLE` が付いているものを眺めると、**「リクエスト処理の途中で変わりうるもの」と「時刻に依存するもの」**の 2 種類に分かれる。

- 変わりうる: `$uri`、`$args`、`$is_args`、`$request_filename`、`$document_root`、`$request_method`
- 時刻: `$msec`、`$time_iso8601`、`$time_local`、`$connection_time`
- カーネルから毎回取る: `$tcpinfo_rtt` など

逆に `$remote_addr`、`$server_name`、`$connection`、`$nginx_version` にはフラグが無い。**一度決まったら変わらないと言い切れるものだけがキャッシュされる。**

呼び分けは呼び出し側の責任になっている。`ngx_http_get_indexed_variable()` を使うか `ngx_http_get_flushed_variable()` を使うかで、キャッシュを尊重するかどうかが変わる。ログモジュールのように「その時点の値」が欲しいところは flushed を使う。

### 名前が事前に分からない変数

`$http_x_request_id` のようなヘッダ変数は、名前を全部登録することができない。プレフィックス変数がこれを扱う ([`#L396-L400`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_variables.c#L396-L400))。

```c title="src/http/ngx_http_variables.c"
    { ngx_string("http_"), NULL, ngx_http_variable_unknown_header_in,
      0, NGX_HTTP_VAR_PREFIX, 0 },

    { ngx_string("sent_http_"), NULL, ngx_http_variable_unknown_header_out,
      0, NGX_HTTP_VAR_PREFIX, 0 },
```

`$arg_`、`$cookie_`、`$proxy_protocol_tlv_` も同じ形。解決は最長一致で行う ([`#L730-L750`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_variables.c#L730-L750))。

```c title="src/http/ngx_http_variables.c"
    len = 0;

    v = cmcf->prefix_variables.elts;
    n = cmcf->prefix_variables.nelts;

    for (i = 0; i < cmcf->prefix_variables.nelts; i++) {
        if (name->len >= v[i].name.len && name->len > len
            && ngx_strncmp(name->data, v[i].name.data, v[i].name.len) == 0)
        {
            len = v[i].name.len;
            n = i;
        }
    }

    if (n != cmcf->prefix_variables.nelts) {
        if (v[n].get_handler(r, vv, (uintptr_t) name) == NGX_OK) {
            return vv;
        }

        return NULL;
    }

    vv->not_found = 1;
```

**プレフィックスが長いほうを選ぶ。** `$upstream_http_foo` は `$upstream_` ではなく `$upstream_http_` に当たる。

そして `data` に **名前そのもののポインタ**を渡している (`(uintptr_t) name`)。テーブルの他の変数では `offsetof` が入っていた同じフィールドに、ここでは文字列へのポインタが入る。`uintptr_t` という型が「ここには何を入れてもいい」を表していて、ハンドラ側が自分の約束で解釈する。

「見つからない」も `not_found = 1` を立てた値として返す。`NULL` を返さないのは、**呼び出し側に「変数が無かった」と「エラーが起きた」を区別させる**ためだ。`$http_nonexistent` は空文字列として扱われるべきで、エラーではない。

### 起動時に名前を解決する

`ngx_http_get_variable_index()` は `get_handler` を埋めない。埋めるのは設定を読み終わってから ([`#L2790-L2865`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_variables.c#L2790-L2865))。

```c title="src/http/ngx_http_variables.c"
    for (i = 0; i < cmcf->variables.nelts; i++) {

        for (n = 0; n < cmcf->variables_keys->keys.nelts; n++) {

            av = key[n].value;

            if (v[i].name.len == key[n].key.len
                && ngx_strncmp(v[i].name.data, key[n].key.data, v[i].name.len)
                   == 0)
            {
                v[i].get_handler = av->get_handler;
                v[i].data = av->data;

                av->flags |= NGX_HTTP_VAR_INDEXED;
                v[i].flags = av->flags;

                av->index = i;
                /* ... */
                goto next;
            }
        }

        len = 0;
        av = NULL;

        for (n = 0; n < cmcf->prefix_variables.nelts; n++) {
            /* ... 最長一致でプレフィックス変数を探す ... */
        }

        if (av) {
            v[i].get_handler = av->get_handler;
            v[i].data = (uintptr_t) &v[i].name;
            v[i].flags = av->flags;

            goto next;
        }

        if (v[i].get_handler == NULL) {
            ngx_log_error(NGX_LOG_EMERG, cf->log, 0,
                          "unknown \"%V\" variable", &v[i].name);

            return NGX_ERROR;
        }

    next:
        continue;
    }
```

2 つのリストを突き合わせている。**`cmcf->variables` は「設定で使われた変数」の配列、`cmcf->variables_keys` は「定義された変数」のハッシュ用のキー列。** 前者の各要素について後者から名前を探し、見つかったらハンドラをコピーする。

見つからなければプレフィックス変数を探し、それも無ければ **起動時にエラー**。`$remote_add` とタイプミスすれば、リクエストを 1 本も受ける前に落ちる。

`av->index = i` と `av->flags |= NGX_HTTP_VAR_INDEXED` で、定義側にも添字が書き戻される。これが効くのが `ngx_http_get_variable()` (名前で引く経路) ([`#L701-L704`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_variables.c#L701-L704))。

```c title="src/http/ngx_http_variables.c"
    if (v) {
        if (v->flags & NGX_HTTP_VAR_INDEXED) {
            return ngx_http_get_flushed_variable(r, v->index);
        }
```

**名前で引いた場合でも、インデックス化されていればキャッシュを共有する。** SSI や Perl モジュールのように実行時に名前で引く経路と、設定に書かれてインデックス化された経路が、同じ `r->variables[index]` を見る。

### 書き込める変数

`get_handler` の隣に `set_handler` がある。`$limit_rate` と `$args` がこれを持つ ([`#L267-L271`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_variables.c#L267-L271), [`#L350-L353`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_variables.c#L350-L353))。

```c title="src/http/ngx_http_variables.c"
    { ngx_string("args"),
      ngx_http_variable_set_args,
      ngx_http_variable_request,
      offsetof(ngx_http_request_t, args),
      NGX_HTTP_VAR_CHANGEABLE|NGX_HTTP_VAR_NOCACHEABLE, 0 },
    /* ... */
    { ngx_string("limit_rate"), ngx_http_variable_set_limit_rate,
      ngx_http_variable_request_get_size,
      offsetof(ngx_http_request_t, limit_rate),
      NGX_HTTP_VAR_CHANGEABLE|NGX_HTTP_VAR_NOCACHEABLE, 0 },
```

`set $limit_rate 100k;` と書くと、**変数への代入がリクエストの `limit_rate` フィールドの書き換えになる**。[出力フィルタチェーン](../output-filter-chain/) の帯域制限がその値を読む。

`NGX_HTTP_VAR_CHANGEABLE` は「同じ名前で再定義してよい」の意味で、`ngx_http_add_variable()` の重複チェックで使われる ([`#L455-L459`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/ngx_http_variables.c#L455-L459))。

```c title="src/http/ngx_http_variables.c"
        if (!(v->flags & NGX_HTTP_VAR_CHANGEABLE)) {
            ngx_conf_log_error(NGX_LOG_EMERG, cf, 0,
                               "the duplicate \"%V\" variable", name);
            return NULL;
        }
```

**`set $remote_addr ...;` は起動時にエラーになる。** コアの変数を上書きされると挙動が予測できなくなるので、上書きしてよい変数だけに印を付けている。

## なぜそうなっているか

### 遅延評価が前提を変える

設定に書かれた変数を全部先に計算する設計だと、**変数を増やすことがリクエストごとのコストになる**。`$upstream_response_time` のように「まだ値が決まらない」ものは、そもそも計算できない。

参照時評価にすると、この 2 つが同時に解ける。使わなければコストゼロ、値が決まってから参照されるので順序の問題も無い。代わりに **「いつ評価されるか」がコードから読みにくくなる**。`$request_time` をアクセスログで参照すると、ログを書く瞬間に評価されるので正しい値になる。同じ変数を `proxy_set_header` で参照すると、上流にリクエストを送る時点で評価されるので 0 に近い値になる。この違いは、設定を書く人からは見えない。

### インデックス化は「設定時にできることは設定時にやる」

`$remote_addr` を参照するたびにハッシュを引くのは無駄だ。設定を読む時点で名前は分かっているので、そこで添字に変換しておく。

これは [フェーズエンジン](../phase-engine/) の「起動時に配列を畳む」と同じ発想になっている。**設定の読み込みは 1 回、リクエストは何億回。** 前者に計算を寄せる。

`cmcf->variables` と `cmcf->variables_keys` という 2 つのリストがあり、それを `ngx_http_variables_init_vars()` で突き合わせるという二段構えも、この方針から来ている。「使う側の登録」と「定義側の登録」が別々のタイミングで起きるので、最後に照合する。

### `valid` と `not_found` を分ける理由

`valid` だけでは「評価してみたが値が無かった」を表せない。`data == NULL` で表そうとすると、空文字列と区別できない。

3 状態 (未評価 / 値あり / 値なし) を 2 ビットで表し、**未評価をゼロで表す**ことで、`ngx_pcalloc` の結果がそのまま初期状態になる。C で構造体の配列を扱うときの定番だが、「ゼロが自然な初期値になるようにビットの意味を決める」は意識しないとできない。

### `no_cacheable` を値側に持つ

`NGX_HTTP_VAR_NOCACHEABLE` は定義側 (`ngx_http_variable_t`) のフラグだが、評価するたびに値側 (`ngx_http_variable_value_t`) の `no_cacheable` にコピーされる。

一見冗長だが、これが効く場面がある。**定義側では cacheable でも、ハンドラが実行時に「これはキャッシュするな」と判断できる。** 逆に、`ngx_http_get_flushed_variable()` は値側だけを見ればよく、定義の配列を引く必要がない。ホットパスで参照するデータを 1 箇所に集めている。

### プレフィックス変数が「動的な名前空間」を作る

`$http_` の 1 エントリで、任意のヘッダ名に対応できる。事前登録できない名前空間を扱うための一般的な手法で、**プレフィックスの最長一致**という単純な規則だけで済ませている。

代償として、`$http_x` と `$http_x_forwarded_for` のような曖昧さが出る。前者は「`X` ヘッダ」で、後者は専用エントリがあればそちら、無ければ `$http_` プレフィックス。最長一致にしておけば、専用エントリのほうが常に勝つ。

`data` に「名前へのポインタ」を渡すのは型としては乱暴だが、`uintptr_t` にしてあるので**「ここには何を入れてもよい、解釈はハンドラの責任」**という契約が型で表現されている。C で汎用のコールバックを作るときの、`void *userdata` と同じ役割になっている。

### 起動時に名前を解決することの価値

`$remote_add` (タイポ) を書いたら、Nginx は起動しない。リクエストが来てから「空文字列だった」と気づくのではない。

これは設定ファイルを「実行前に検証できる言語」として扱っているということで、`nginx -t` の価値の一部になっている。**動的な名前空間 (プレフィックス変数) を持ちながら、静的な検証もできる**のは、プレフィックスの一覧が起動時に確定しているからだ。

### グローバルな再帰カウンタ

`ngx_http_variable_depth` は static なグローバル変数で、リクエストごとではない。1 スレッドで動くこと ([ステートマシンのページ](../state-machine/)) を前提に、リクエスト構造体を 1 フィールド節約している。

正しく動くが、**リクエストをまたいで漏れると壊れる**。だから成功パスと失敗パスの両方に `ngx_http_variable_depth++` が書かれている。片方を書き忘れると、そのワーカーは以後、深さ 99 からしか始められなくなる。ミスが即座には現れず、じわじわ効くタイプのバグになる。

## どう活かすか

### そのまま真似できるところ

**「値」ではなく「値の作り方」を登録する。** テンプレートエンジン、ログフォーマッタ、ルールエンジン、監視のラベル。名前から値を引く仕組みを作るとき、遅延評価にしておくと「使われないものは計算されない」と「まだ決まっていない値も書ける」が両方手に入る。

**名前の解決を、設定時に添字へ落とす。** 実行時のハッシュ探索が配列アクセスになる。設定が変わる頻度と参照される頻度に差があるなら、必ず効く。

**評価済みかどうかを、値の置き場所そのものに持たせる。** 別のキャッシュ構造を持たない。「ゼロ埋め = 未評価」になるようにフラグの意味を決めると、初期化コードが消える。

**キャッシュしてよい値と、してはいけない値を、定義側で宣言させる。** Nginx の `NOCACHEABLE` は 1 ビット。何がキャッシュ可能かを、実装のあちこちに散らばった `if` ではなく、定義テーブルの 1 列で表せる。

**「見つからない」を、エラーではなく値として返す。** `not_found = 1` の値を返すことで、呼び出し側が「無い」と「壊れた」を区別できる。`null` を返して呼び出し側に判断させると、区別が失われる。

**動的な名前空間を、プレフィックスの最長一致で扱う。** 事前に列挙できない名前 (ヘッダ、クエリパラメータ、タグ) を、少数のエントリで扱える。専用エントリを足せば個別の最適化もできる。

**コールバックに `uintptr_t` (または `void *`) の自由枠を渡す。** `offsetof` を入れれば 1 つのハンドラを何十個の項目で共有でき、ポインタを入れれば動的なデータも渡せる。ハンドラの数を劇的に減らせる。

**名前の解決を起動時に済ませて、解決できないものはそこで落とす。** 設定のタイポが本番のトラフィックで初めて分かる、を防げる。動的な名前空間があっても、そのプレフィックス一覧が起動時に確定していれば検証はできる。

**上書きしてよい定義に印を付ける。** `CHANGEABLE` が無い変数は再定義でエラー。拡張可能なシステムで、コアの意味を壊されないための最小の防御になる。

### 取り込むべきでない条件

**「いつ評価されるか」が設定から読み取れない。** `$request_time` を書く場所によって値が変わるのは、遅延評価の直接の帰結だ。ユーザーに見える仕様として説明が要る。Nginx のドキュメントもこの点を明記している。

**キャッシュ可否の判断を間違えると、静かに壊れる。** `NOCACHEABLE` を付け忘れた変数は、リクエストの途中で値が変わっても古い値を返し続ける。テストで見つけにくい。サードパーティモジュールが変数を足すときの典型的なバグがこれだ。

**グローバルな再帰カウンタは真似しないほうがいい。** 増減が対になっていないと、プロセスの寿命にわたって影響が残る。コンテキスト (Nginx なら `r`) に置くほうが安全で、コストは 1 フィールドだけだ。

**`uintptr_t data` は型安全ではない。** `offsetof` が入っているのかポインタが入っているのかは、ハンドラを読まないと分からない。ジェネリクスやタグ付き union が使える言語なら、そちらを使う。

**変数の値がリクエスト構造体の中を直接指しているので、寿命が結びついている。** `v->data = s->data` はコピーではないので、元の文字列が書き換わると変数の値も変わる。`$uri` が `NOCACHEABLE` なのは値が変わるからだが、キャッシュされた値が指す先が変わってしまう可能性も同時に扱っている。アリーナと組み合わせて初めて安全に成立する形になっている。

## 関連

- 変数の値を確保しているプールは [メモリプールのページ](../memory-pool/)。値がコピーではなく参照であることは、寿命が揃っているから成立する。
- `set_handler` で書き換えられる `$limit_rate` を読むのは [出力フィルタチェーンのページ](../output-filter-chain/)。
- 「設定時にできることは設定時にやる」は [フェーズエンジンのページ](../phase-engine/) と同じ方針。

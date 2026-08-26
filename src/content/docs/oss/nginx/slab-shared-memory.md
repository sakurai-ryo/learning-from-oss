---
title: "プロセスをまたぐメモリのために、ポインタを使えないアロケータを別に持つ"
description: "limit_req のカウンタや upstream の状態は、全ワーカーが同じものを見なければならない。Nginx は fork の前に MAP_SHARED で 1 枚 mmap し、全プロセスが同じ仮想アドレスに持つことを前提に生ポインタを格納する。その上に載るのはページを 2 のべき乗で切り分けるスラブアロケータで、管理情報はページ構造体 3 ワードのビットに詰め込まれている。満杯になったときに何を捨てるかは、アロケータではなく利用側が決める。"
sidebar:
  order: 11
---

## 何を学んだか

### どんな状況の話か

[メモリプール](../memory-pool/) は 1 プロセスの中で完結している。ところが、どうしてもプロセスをまたいで共有しなければならないデータがある。

- `limit_req` / `limit_conn` のカウンタ。「この IP から毎秒 10 リクエストまで」を、ワーカーが 32 個あっても合計で数えなければ意味がない。
- upstream の状態。あるバックエンドが落ちていると判定したなら、全ワーカーが同じ判定を共有すべきだ。
- SSL のセッションキャッシュ。ワーカー A で握手したセッションを、ワーカー B で再開できないと困る。

このデータには、プールが前提にしていた性質が 3 つとも無い。**寿命がリクエストと一致しない** (無期限に生きて、古いものから捨てられる)。**個別解放が必須** (まとめて捨てる機会が無い)。**複数プロセスが同時に触る** (ロックが要る)。

### Nginx の答え

1. **fork の前に `mmap(MAP_ANON|MAP_SHARED)` で 1 枚確保する。** 子は fork でマッピングを受け継ぐので、**全ワーカーが同じ仮想アドレスで同じ物理メモリを見る**。
2. **同じアドレスであることを前提に、生ポインタをそのまま格納する。** オフセットに変換したり、相対ポインタを作ったりしない。前提が崩れていないかは起動時に 1 回検査する。
3. **その領域の先頭にスラブアロケータを置く。** ページを 2 のべき乗のサイズに切り分け、使用状況をビットマップで管理する。ページより大きい要求はページ単位で連続確保する。
4. **管理情報を、ページ 1 枚あたり 3 ワードに詰め込む。** ポインタの下位ビットが必ず 0 になることを使って、`prev` にリンクと種別を同居させる。
5. **ロックは atomic な CAS + スピン + セマフォ。** 短時間ならスピンし、長引きそうならセマフォで寝る。ロック変数には pid を書く。
6. **満杯になったときの方針は、アロケータではなく利用側が決める。** `limit_req` は「まず期限切れを 1〜2 個消す」→「ダメなら最も古いものを強制的に捨てる」の 2 段構え。
7. **設定リロードでは、名前・タグ・サイズが一致するゾーンをそのまま引き継ぐ。** 中身を作り直さない。

## ソースコードのどこか

### 共有メモリの確保

[`src/os/unix/ngx_shmem.c#L14-L28`](https://github.com/nginx/nginx/blob/release-1.31.4/src/os/unix/ngx_shmem.c#L14-L28)。

```c title="src/os/unix/ngx_shmem.c"
ngx_int_t
ngx_shm_alloc(ngx_shm_t *shm)
{
    shm->addr = (u_char *) mmap(NULL, shm->size,
                                PROT_READ|PROT_WRITE,
                                MAP_ANON|MAP_SHARED, -1, 0);

    if (shm->addr == MAP_FAILED) {
        ngx_log_error(NGX_LOG_ALERT, shm->log, ngx_errno,
                      "mmap(MAP_ANON|MAP_SHARED, %uz) failed", shm->size);
        return NGX_ERROR;
    }

    return NGX_OK;
}
```

`MAP_ANON|MAP_SHARED` はファイルの裏付けを持たない共有マッピングで、**fork した子とだけ共有される**。名前も付いていないので、外部のプロセスからは触れない。`MAP_ANON` が無い環境向けに `/dev/zero` を `mmap` する版と、`shm_open` を使う版が同じファイルに並んでいる。

これが呼ばれるのは `ngx_init_cycle()` の中、つまり [master/worker のページ](../master-worker/) で見たとおり **fork より前**だ。だから全ワーカーがこのマッピングを継承する。

### 「同じアドレスであること」を検査する

[`src/core/ngx_cycle.c#L965-L1028`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_cycle.c#L965-L1028)。

```c title="src/core/ngx_cycle.c"
static ngx_int_t
ngx_init_zone_pool(ngx_cycle_t *cycle, ngx_shm_zone_t *zn)
{
    u_char           *file;
    ngx_slab_pool_t  *sp;

    sp = (ngx_slab_pool_t *) zn->shm.addr;

    if (zn->shm.exists) {

        if (sp == sp->addr) {
            return NGX_OK;
        }

#if (NGX_WIN32)

        /* remap at the required address */

        if (ngx_shm_remap(&zn->shm, sp->addr) != NGX_OK) {
            return NGX_ERROR;
        }

        sp = (ngx_slab_pool_t *) zn->shm.addr;

        if (sp == sp->addr) {
            return NGX_OK;
        }

#endif

        ngx_log_error(NGX_LOG_EMERG, cycle->log, 0,
                      "shared zone \"%V\" has no equal addresses: %p vs %p",
                      &zn->shm.name, sp->addr, sp);
        return NGX_ERROR;
    }

    sp->end = zn->shm.addr + zn->shm.size;
    sp->min_shift = 3;
    sp->addr = zn->shm.addr;
    /* ... */
    if (ngx_shmtx_create(&sp->mutex, &sp->lock, file) != NGX_OK) {
        return NGX_ERROR;
    }

    ngx_slab_init(sp);

    return NGX_OK;
}
```

**`sp->addr` に「作られたときのアドレス」を書き込んでおき、`sp == sp->addr` で今のアドレスと一致するかを見る。** 一致しなければ、その領域に入っている全ポインタが無効ということなので、起動を止める。

Unix では fork でマッピングを継承するので、常に一致する。この検査が意味を持つのは Windows で、そこには fork が無いので新しいプロセスがマッピングを開き直す。運悪く別のアドレスに載ったら `ngx_shm_remap()` で指定アドレスに貼り直し、それも失敗したら諦める。

**移植性のために生ポインタを諦めるのではなく、「同じアドレスに置けること」を要件にして、満たせない環境では動かないことにした**という判断になっている。オフセットベースのポインタにすると、すべてのアクセスに加算が挟まり、`ngx_rbtree` や `ngx_queue` を共有できなくなる。

`sp->min_shift = 3` なので、最小の確保単位は 8 バイト。

### スラブの構造

[`src/core/ngx_slab.h#L18-L59`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_slab.h#L18-L59)。

```c title="src/core/ngx_slab.h"
struct ngx_slab_page_s {
    uintptr_t         slab;
    ngx_slab_page_t  *next;
    uintptr_t         prev;
};
/* ... */
typedef struct {
    ngx_shmtx_sh_t    lock;

    size_t            min_size;
    size_t            min_shift;

    ngx_slab_page_t  *pages;
    ngx_slab_page_t  *last;
    ngx_slab_page_t   free;

    ngx_slab_stat_t  *stats;
    ngx_uint_t        pfree;

    u_char           *start;
    u_char           *end;

    ngx_shmtx_t       mutex;

    u_char           *log_ctx;
    u_char            zero;

    unsigned          log_nomem:1;

    void             *data;
    void             *addr;
} ngx_slab_pool_t;
```

領域のレイアウトは `ngx_slab_init()` が決める ([`src/core/ngx_slab.c#L98-L165`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_slab.c#L98-L165))。先頭から順に、`ngx_slab_pool_t` 本体、サイズクラスごとのリスト頭 (`slots`)、統計、ページ 1 枚につき 1 個の `ngx_slab_page_t` の配列、そして残りが実データのページ。

```c title="src/core/ngx_slab.c"
    n = ngx_pagesize_shift - pool->min_shift;

    for (i = 0; i < n; i++) {
        /* only "next" is used in list head */
        slots[i].slab = 0;
        slots[i].next = &slots[i];
        slots[i].prev = 0;
    }
    /* ... */
    pages = (ngx_uint_t) (size / (ngx_pagesize + sizeof(ngx_slab_page_t)));
```

サイズクラスは `2^3` (8) から `2^11` (2048) まで、4KB ページなら 9 個。`pages` の計算が **「1 ページぶんの実データ + 1 個の管理構造体」を 1 単位として割る** ようになっているのが素直だ。

ページの管理構造体と実データが物理的に離れているので、相互の変換はインデックス計算になる ([`#L52-L54`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_slab.c#L52-L54))。

```c title="src/core/ngx_slab.c"
#define ngx_slab_page_addr(pool, page)                                        \
    ((((page) - (pool)->pages) << ngx_pagesize_shift)                         \
     + (uintptr_t) (pool)->start)
```

管理構造体の配列内での位置がそのままページ番号になる。

### ポインタの下位ビットに種別を詰める

サイズクラスによって、使用状況の持ち方が 3 通りに変わる ([`#L11-L15`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_slab.c#L11-L15))。

```c title="src/core/ngx_slab.c"
#define NGX_SLAB_PAGE_MASK   3
#define NGX_SLAB_PAGE        0
#define NGX_SLAB_BIG         1
#define NGX_SLAB_EXACT       2
#define NGX_SLAB_SMALL       3
```

- **SMALL** (`shift < exact_shift`): 1 ページに入る個数が多すぎて、`uintptr_t` 1 個のビットマップに収まらない。ページの先頭に **ビットマップ自体を置く** (最初の数スロットをビットマップ用に潰す)。
- **EXACT** (`shift == exact_shift`): ちょうど `8 * sizeof(uintptr_t)` 個入るサイズ。64 ビット環境の 4KB ページなら 64 バイト。`page->slab` がそのままビットマップになる。
- **BIG** (`shift > exact_shift`): 個数が少ないので、`page->slab` の **上位半分をビットマップ、下位半分に shift 値** を入れる。

この 3 種の区別を、`page->prev` の下位 2 ビットに埋め込んでいる ([`#L47-L50`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_slab.c#L47-L50))。

```c title="src/core/ngx_slab.c"
#define ngx_slab_page_type(page)   ((page)->prev & NGX_SLAB_PAGE_MASK)

#define ngx_slab_page_prev(page)                                              \
    (ngx_slab_page_t *) ((page)->prev & ~NGX_SLAB_PAGE_MASK)
```

`ngx_slab_page_t` は 3 ワードの倍数のサイズなので、そのアドレスは必ず 4 バイト以上でアライメントされている。つまり **下位 2 ビットは必ず 0** で、そこに種別を入れても情報が失われない。取り出すときにマスクするだけ。

BIG の確保パスがこの詰め込みをよく見せてくれる ([`#L296-L326`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_slab.c#L296-L326))。

```c title="src/core/ngx_slab.c"
        } else { /* shift > ngx_slab_exact_shift */

            mask = ((uintptr_t) 1 << (ngx_pagesize >> shift)) - 1;
            mask <<= NGX_SLAB_MAP_SHIFT;

            for (m = (uintptr_t) 1 << NGX_SLAB_MAP_SHIFT, i = 0;
                 m & mask;
                 m <<= 1, i++)
            {
                if (page->slab & m) {
                    continue;
                }

                page->slab |= m;

                if ((page->slab & NGX_SLAB_MAP_MASK) == mask) {
                    prev = ngx_slab_page_prev(page);
                    prev->next = page->next;
                    page->next->prev = page->prev;

                    page->next = NULL;
                    page->prev = NGX_SLAB_BIG;
                }

                p = ngx_slab_page_addr(pool, page) + (i << shift);
                /* ... */
```

`NGX_SLAB_MAP_SHIFT` は 64 ビットで 32。`page->slab` の下位 32 ビットに shift 値、上位 32 ビットにビットマップが入っている。**満杯になったらリストから外す** (`page->next = NULL; page->prev = NGX_SLAB_BIG;`) ので、`slots[slot]` に繋がっているページは必ず空きがある。探索が「リストの先頭を見る」だけで済む。

新しいページを切り出すときの初期化 ([`#L389-L403`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_slab.c#L389-L403))。

```c title="src/core/ngx_slab.c"
        } else { /* shift > ngx_slab_exact_shift */

            page->slab = ((uintptr_t) 1 << NGX_SLAB_MAP_SHIFT) | shift;
            page->next = &slots[slot];
            page->prev = (uintptr_t) &slots[slot] | NGX_SLAB_BIG;

            slots[slot].next = page;
```

1 行で「先頭の 1 個を使用中にして、shift 値を記録する」が済んでいる。`page->prev` にリスト前方へのポインタと種別を同時に書いている。

SMALL の初期化はもっと入り組んでいて、**ビットマップ自身が占めるスロットを最初から使用中にしておく** ([`#L335-L371`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_slab.c#L335-L371))。

```c title="src/core/ngx_slab.c"
            n = (ngx_pagesize >> shift) / ((1 << shift) * 8);

            if (n == 0) {
                n = 1;
            }

            /* "n" elements for bitmap, plus one requested */

            for (i = 0; i < (n + 1) / (8 * sizeof(uintptr_t)); i++) {
                bitmap[i] = NGX_SLAB_BUSY;
            }
```

コメントの "n elements for bitmap, plus one requested" が分かりやすい。ビットマップ用に `n` 個、それに今回の要求ぶん 1 個を、最初から埋まっていることにする。**メタデータをデータ領域の中に置き、自分自身を「使用中」として管理する。**

### ページより大きいものと、ありえない状態

`ngx_slab_alloc_locked()` の入口 ([`#L191-L206`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_slab.c#L191-L206))。

```c title="src/core/ngx_slab.c"
    if (size > ngx_slab_max_size) {

        page = ngx_slab_alloc_pages(pool, (size >> ngx_pagesize_shift)
                                          + ((size % ngx_pagesize) ? 1 : 0));
        if (page) {
            p = ngx_slab_page_addr(pool, page);

        } else {
            p = 0;
        }

        goto done;
    }
```

`ngx_slab_max_size` は `ngx_pagesize / 2` なので、2KB を超える確保はページ単位になる。連続したページを探すのは `pool->free` の空きリストを辿る線形探索で、**断片化には弱い**。共有ゾーンに入るのは同じ形の小さいレコードばかりという前提がある。

3 つのサイズクラスのループを全部抜けてしまった場合の処理 ([`#L328-L329`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_slab.c#L328-L329))。

```c title="src/core/ngx_slab.c"
        ngx_slab_error(pool, NGX_LOG_ALERT, "ngx_slab_alloc(): page is busy");
        ngx_debug_point();
```

「空きがあるはずのリストの先頭ページに空きが無かった」ということなので、ビットマップが壊れている。**共有メモリの破壊は複数プロセスに波及するので、黙って続けずにその場で落ちる**ようになっている。

### ロック

`ngx_shmtx` は 3 層になっている ([`src/core/ngx_shmtx.c#L69-L133`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_shmtx.c#L69-L133))。

```c title="src/core/ngx_shmtx.c"
void
ngx_shmtx_lock(ngx_shmtx_t *mtx)
{
    ngx_uint_t         i, n;

    for ( ;; ) {

        if (*mtx->lock == 0 && ngx_atomic_cmp_set(mtx->lock, 0, ngx_pid)) {
            return;
        }

        if (ngx_ncpu > 1) {

            for (n = 1; n < mtx->spin; n <<= 1) {

                for (i = 0; i < n; i++) {
                    ngx_cpu_pause();
                }

                if (*mtx->lock == 0
                    && ngx_atomic_cmp_set(mtx->lock, 0, ngx_pid))
                {
                    return;
                }
            }
        }

#if (NGX_HAVE_POSIX_SEM)

        if (mtx->semaphore) {
            (void) ngx_atomic_fetch_add(mtx->wait, 1);

            if (*mtx->lock == 0 && ngx_atomic_cmp_set(mtx->lock, 0, ngx_pid)) {
                (void) ngx_atomic_fetch_add(mtx->wait, -1);
                return;
            }

            while (sem_wait(&mtx->sem) == -1) { /* ... */ }

            continue;
        }

#endif

        ngx_sched_yield();
    }
}
```

1. **まず CAS を 1 回。** 取れれば終わり。
2. **取れなければスピン。** 待つ長さを 1, 2, 4, ... と指数的に増やしながら、間に `ngx_cpu_pause()` (x86 の `PAUSE` 命令) を挟む。上限は `mtx->spin` = 2048。
3. **それでもダメならセマフォで寝る。** セマフォが使えない環境では `sched_yield()` に落ちる。

**CPU が 1 個ならスピンを丸ごと飛ばす** (`if (ngx_ncpu > 1)`) のが正しくて、単一 CPU では他プロセスが走らない限りロックが解放されないので、スピンは純粋な無駄になる。

ロック変数に `1` ではなく `ngx_pid` を書いているのは、デバッグのため。ロックが取られたまま詰まったとき、値を見れば誰が持っているか分かる。

`ngx_shmtx_trylock()` は CAS 1 回だけ ([`#L62-L66`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_shmtx.c#L62-L66))。[accept の分配](../accept-distribution/) で使われているのはこちらで、accept ロックは「取れなければ諦める」ものなので待たない。

### 満杯のときに何を捨てるか

スラブアロケータは `NULL` を返すだけで、何も捨てない。捨て方は利用側が決める。`limit_req` の例 ([`src/http/modules/ngx_http_limit_req_module.c#L488-L505`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/modules/ngx_http_limit_req_module.c#L488-L505))。

```c title="src/http/modules/ngx_http_limit_req_module.c"
    size = offsetof(ngx_rbtree_node_t, color)
           + offsetof(ngx_http_limit_req_node_t, data)
           + key->len;

    ngx_http_limit_req_expire(ctx, 1);

    node = ngx_slab_alloc_locked(ctx->shpool, size);

    if (node == NULL) {
        ngx_http_limit_req_expire(ctx, 0);

        node = ngx_slab_alloc_locked(ctx->shpool, size);
        if (node == NULL) {
            ngx_log_error(NGX_LOG_ALERT, ngx_cycle->log, 0,
                          "could not allocate node%s", ctx->shpool->log_ctx);
            return NGX_ERROR;
        }
    }
```

**確保の前に必ず掃除を 1 回、失敗したら強制的に掃除してもう 1 回。** 掃除の中身 ([`#L632-L695`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/modules/ngx_http_limit_req_module.c#L632-L695))。

```c title="src/http/modules/ngx_http_limit_req_module.c"
    /*
     * n == 1 deletes one or two zero rate entries
     * n == 0 deletes oldest entry by force
     *        and one or two zero rate entries
     */

    while (n < 3) {

        if (ngx_queue_empty(&ctx->sh->queue)) {
            return;
        }

        q = ngx_queue_last(&ctx->sh->queue);

        lr = ngx_queue_data(q, ngx_http_limit_req_node_t, queue);

        if (lr->count) {

            /*
             * There is not much sense in looking further,
             * because we bump nodes on the lookup stage.
             */

            return;
        }

        if (n++ != 0) {

            ms = (ngx_msec_int_t) (now - lr->last);
            ms = ngx_abs(ms);

            if (ms < 60000) {
                return;
            }

            excess = lr->excess - ctx->rate * ms / 1000;

            if (excess > 0) {
                return;
            }
        }

        ngx_queue_remove(q);

        node = (ngx_rbtree_node_t *)
                   ((u_char *) lr - offsetof(ngx_rbtree_node_t, color));

        ngx_rbtree_delete(&ctx->sh->rbtree, node);

        ngx_slab_free_locked(ctx->shpool, node);
    }
```

データは **赤黒木と LRU キューの両方に入っている**。木はキーでの検索用、キューは古い順の走査用。ノードは両方のリンクを持つので、追加の確保は要らない ([タイマのページ](../timer-rbtree/) の侵入型と同じ話)。

`n` が引数と兼用のループカウンタになっていて、`n == 1` で呼べば「レートが 0 に戻ったエントリを 1〜2 個消す」、`n == 0` なら「最も古いものを 1 個強制的に消してから、さらに 1〜2 個」になる。上限が 3 なのは、**1 リクエストの処理時間を伸ばしすぎないため**。ゾーンが満杯でも 1 回の確保で捨てるのは高々 3 個で、少しずつ掃除される。

コメントの "we bump nodes on the lookup stage" が効いていて、参照されたノードはキューの先頭に移される。だから末尾は必ず最も古い。末尾が現役 (`lr->count != 0`) なら、それより新しいものも全部現役なので、探索を打ち切ってよい。

エラー時のログの `ctx->shpool->log_ctx` は、ゾーン名を含む文字列を **共有メモリの中に確保しておいたもの** ([`#L750-L758`](https://github.com/nginx/nginx/blob/release-1.31.4/src/http/modules/ngx_http_limit_req_module.c#L750-L758))。

```c title="src/http/modules/ngx_http_limit_req_module.c"
    ctx->shpool->log_ctx = ngx_slab_alloc(ctx->shpool, len);
    if (ctx->shpool->log_ctx == NULL) {
        return NGX_ERROR;
    }

    ngx_sprintf(ctx->shpool->log_ctx, " in limit_req zone \"%V\"%Z",
                &shm_zone->shm.name);

    ctx->shpool->log_nomem = 0;
```

`log_nomem = 0` で **スラブ側のエラーログを黙らせている**。満杯は `limit_req` にとって想定内で、自分で対処するから、アロケータに騒がれると困る。汎用のアロケータが「メモリが足りない」と叫ぶかどうかを、利用側がフラグ 1 つで制御できるようにしてある。

### 設定リロードでの引き継ぎ

[`src/core/ngx_cycle.c#L440-L508`](https://github.com/nginx/nginx/blob/release-1.31.4/src/core/ngx_cycle.c#L440-L508)。

```c title="src/core/ngx_cycle.c"
            if (shm_zone[i].tag == oshm_zone[n].tag
                && shm_zone[i].shm.size == oshm_zone[n].shm.size)
            {
                shm_zone[i].shm.addr = oshm_zone[n].shm.addr;
                /* ... */
                if (shm_zone[i].init(&shm_zone[i], oshm_zone[n].data)
                    != NGX_OK)
                {
                    goto failed;
                }

                goto shm_zone_found;
            }

            break;
        }

        if (ngx_shm_alloc(&shm_zone[i].shm) != NGX_OK) {
            goto failed;
        }

        if (ngx_init_zone_pool(cycle, &shm_zone[i]) != NGX_OK) {
            goto failed;
        }
```

**名前が一致し、タグが一致し、サイズが一致するなら、古いゾーンのアドレスをそのまま使う。** `init` コールバックには古い `data` が渡るので、モジュールは「既存のデータ構造をそのまま使う」と判断できる。

3 つのどれかが違えば、新しく `mmap` して初期化する。特にサイズを変えたら中身は捨てられる。`limit_req_zone` のサイズを変更するとカウンタがリセットされるのは、この分岐の帰結だ。

タグを見ているのは、**別のモジュールが同じ名前のゾーンを宣言している場合を区別するため**。タグには [buf のページ](../buf-chain/) と同じく、モジュール構造体のアドレスが入る。

## なぜそうなっているか

### 生ポインタを使うという賭け

共有メモリに複雑なデータ構造を置くとき、教科書的には「ポインタではなくオフセットを使う」。プロセスごとにマッピングアドレスが違いうるからだ。

Nginx はそれをやらず、**「fork するから同じアドレスになる」に賭けて、起動時に検査する** 方式を採った。得られる見返りが大きい。

- `ngx_rbtree` と `ngx_queue` を、プロセス内と共有メモリで **同じ実装のまま使える**。オフセット版を別に書く必要がない。
- アクセスのたびに base + offset の計算が入らない。
- `limit_req` のように「木とキューの両方に入るノード」を、侵入型のまま書ける。

賭けが外れるのは Windows と、fork せずに共有メモリを開き直す場面だけで、そこは検査で弾く。**「動く環境を限定して、その代わり中身をシンプルにする」**という判断で、20 年経っても破綻していない。

`sp == sp->addr` という 1 行の検査が、この設計全体を支えている。エラーメッセージ (`"shared zone \"%V\" has no equal addresses: %p vs %p"`) も、何が起きたかを正確に伝える。

### なぜスラブで、なぜ 3 種類か

共有ゾーンに入るのは「同じ形の小さいレコードが大量に」というパターンばかりだ。IP ごとのカウンタ、セッションごとのキャッシュエントリ、upstream のピア情報。

このパターンには、汎用の `malloc` よりスラブが向く。サイズが揃っているので断片化しにくく、ビットマップ 1 個で数十個ぶんの使用状況を持てる。

3 種類に分かれているのは、**1 ページに入る個数によって、ビットマップの置き場所が変わるから**だ。64 ビット環境の 4KB ページなら、`uintptr_t` 1 個に 64 ビット持てる。64 バイトのオブジェクトなら 1 ページにちょうど 64 個入るので、`page->slab` がそのままビットマップになる (EXACT)。それより大きければビットが余るので、余った下位ビットに shift 値を入れる (BIG)。それより小さければビットが足りないので、ページの中にビットマップを置く (SMALL)。

**「1 ワードに収まるか」を境界にして実装を 3 つに分ける**というのは、ビット演算の効率を最優先した設計だ。読みにくさと引き換えに、確保が数十命令で終わる。

### 下位ビットへの詰め込みが許されるのは

`page->prev` にポインタと種別を同居させるのは、アライメントの保証があるから成立する。`ngx_slab_page_t` は 3 ワードなので 8 バイト境界に並び、下位 3 ビットが 0。そのうち 2 ビットを使っている。

同じ手法は GC や VM の実装でよく使われる (tagged pointer)。C で書くときの条件は、**その型が必ず十分にアライメントされていること**を確信できることで、Nginx の場合は自分で確保した配列の要素なので確実に言える。

代償は、`page->prev` を直接読むコードが書けなくなることだ。必ず `ngx_slab_page_prev()` を通す必要がある。マクロにしてあるので事故は起きにくいが、フィールドの型が `ngx_slab_page_t *` ではなく `uintptr_t` になっているのが、**「これは素直なポインタではない」というシグナル**になっている。

### アロケータは捨て方を知らない

スラブは `NULL` を返すだけで、LRU も TTL も知らない。それは正しくて、**何を捨てるべきかはデータの意味に依存する**。`limit_req` なら「レートが 0 に戻った古いエントリ」、SSL セッションキャッシュなら「期限切れのセッション」、`proxy_cache` のキーゾーンなら参照カウントを見なければならない。

そのぶん、利用側は毎回「確保 → 失敗 → 掃除 → 再確保」を書くことになる。`limit_req` の 2 段構えは他のモジュールにもほぼ同じ形でコピーされている。**汎用性のために重複を許した**形になっていて、共通化しようとすると捨て方のポリシーを渡す仕組みが要り、それは C では関数ポインタと `void *` の組になって、結局読みにくくなる。

`log_nomem` フラグは、この分担の帳尻を合わせる仕掛けだ。アロケータは既定では「メモリが足りない」と警告するが、それを想定内として扱うモジュールは黙らせられる。

### 掃除の上限が 3 である意味

`while (n < 3)` で、1 回の確保あたり最大 3 個しか消さない。ゾーンが満杯でも、リクエスト 1 本の処理時間はほぼ一定に保たれる。

**「まとめて掃除する」ではなく「使うたびに少しずつ掃除する」**を選んでいる。GC の世界でいうインクリメンタル回収と同じ発想で、レイテンシの尖りを避けるための選択だ。イベントループを 1 スレッドで回している以上、どこかで長く止まるのが一番まずい ([ステートマシンのページ](../state-machine/))。

## どう活かすか

### そのまま真似できるところ

**共有メモリを使うなら、「同じアドレスに載っていること」を起動時に検査する。** 自己参照ポインタを 1 つ置いて、読み出した値と自分のアドレスを比べるだけ。前提が崩れたときに「なんとなく壊れる」のを「起動時に明確なエラー」に変えられる。

**アロケータとポリシーを分ける。** 「メモリが足りない」ときに何を捨てるかは、データの意味を知っている側でしか決められない。アロケータは失敗を返すだけにして、リトライと掃除を利用側に書かせる。共通化したくなったら、それは本当に共通のポリシーかを疑う。

**掃除は「まとめて」ではなく「使うたびに少しずつ」。** 上限を定数で決めておくと、最悪ケースのレイテンシが読める。

**同じデータを 2 つのインデックスに入れるなら、侵入型にする。** `limit_req` のノードは赤黒木のノードと LRU キューのリンクを両方持つ。検索用と走査用で構造を変えたいときの定石で、追加の確保もポインタの逆引きも要らない。

**ロックは、スピンしてから寝る。** ただし CPU 数が 1 ならスピンを飛ばす。指数的にバックオフしながらスピンする形 (`for (n = 1; n < spin; n <<= 1)`) は、そのまま持ち帰れる。

**ロック変数に、識別できる値を書く。** `1` ではなく pid やスレッド ID を書いておくと、デッドロックの調査でコアダンプを見たときに持ち主が分かる。コストはゼロ。

**「これは想定内の失敗だ」を利用側から表明できるようにする。** `log_nomem` の 1 ビット。ライブラリが親切に警告を出す設計は、想定内として扱いたい呼び出し側にとってノイズになる。

### 取り込むべきでない条件

**共有メモリのアロケータを自分で書くのは、最後の手段。** 断片化に弱く、デバッグが極端に難しく、壊れたときの影響が全プロセスに及ぶ。Redis のような外部プロセスに持たせるか、そもそも共有せずに済ませられないかを先に考える。Nginx がこれを書いたのは、外部依存を持たない方針と、レイテンシ要件のためだ。

**タグ付きポインタは、アライメントの保証が言い切れるときだけ。** 型のサイズが変わったり、パッキング指定が入ったり、別のアロケータから取るようになったりすると、静かに壊れる。使うなら、その型の確保経路を限定して、コメントで理由を残す。

**ページより大きい確保が頻繁に起きるなら、このスラブは向かない。** 空きページの線形探索と、断片化への弱さが効いてくる。サイズの揃った小さいレコード専用と割り切るべきものだ。

**リロードでサイズを変えたら中身が消える、という挙動は説明が要る。** Nginx でも「`limit_req_zone` のサイズを変えたらカウンタがリセットされる」は知られていないと驚く挙動になっている。設定の同一性判定に何を使っているかは、ドキュメントに書くほうがいい。

## 関連

- 同じ共有メモリの上に、[accept の分配](../accept-distribution/) で使う `accept_mutex` も載っている。
- プロセス内の確保は [メモリプールのページ](../memory-pool/)。寿命の扱いがまったく違う。
- 侵入型データ構造の話は [タイマのページ](../timer-rbtree/) にもある。

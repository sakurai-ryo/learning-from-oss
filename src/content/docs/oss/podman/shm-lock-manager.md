---
title: "プロセス間ロックは共有メモリに固定数確保し、番号を DB に保存して再起動後も同じロックを引き当てる"
description: "コンテナ・Pod・Volume ごとの排他は、/dev/shm 上の pthread mutex の配列で行う。どのオブジェクトが何番を使うかは DB の JSON に保存し、次のプロセスは番号でロックを引く。mutex は robust 属性で、保持したまま死んだプロセスのロックを次の取得者が回復する。ロック順序 (Pod → Container → Volume) を守れない場面は、事前検出で失敗させるか、あえてロックを取らない。"
group: "デーモンレス"
sidebar:
  order: 3
---

## 何を学んだか

### どんな状況の話か

[SQLite のページ](../sqlite-state/) の排他トランザクションは、1 回の読み書きの整合性しか守らない。「状態を読み、判断し、conmon を起動し、書き戻す」という一連の操作の途中で、別のプロセスが同じコンテナを止めに来ないことを保証するには、コンテナ単位のミューテックスが要る。それも **プロセスをまたいで** 効くものが。

Go の `sync.Mutex` はプロセス内でしか効かない。ファイルロックは使えるが遅い。そして Podman のプロセスは `kill -9` されうるので、ロックを保持したまま死んだときに永久に詰まらない仕組みも要る。

### Podman の答え

1. **POSIX 共有メモリに pthread mutex の配列を置く。** `/dev/shm/libpod_lock` (rootless は `/dev/shm/libpod_rootless_lock_<uid>`) を `shm_open` + `mmap` し、`num_locks` 個 (既定 2048) の `pthread_mutex_t` を `PTHREAD_PROCESS_SHARED` で初期化する。32 個ごとに 1 つのビットマップで割り当て状況を管理する。
2. **robust 属性で、保持者の死を次の取得者が回復する。** `PTHREAD_MUTEX_ROBUST` にすると、保持したまま死んだ mutex を次に取ろうとしたプロセスに `EOWNERDEAD` が返る。`pthread_mutex_consistent` で自分のものにする。
3. **ロックの番号を DB に保存し、実体は再構築可能なキャッシュとして扱う。** コンテナ作成時に番号を割り当てて `config.LockID` に書く。次のプロセスは `RetrieveLock(LockID)` で同じ mutex を引く。再起動で `/dev/shm` が消えたら、DB に保存された番号を `AllocateAndRetrieveLock` で再確保する。
4. **割り当てられていない番号でもロックできる。** 「ロックを取ってから DB を読んで、削除済みと知る」という順序を成立させるため。
5. **ロック順序は Pod → Container → Volume。守れない場面は 3 通りで逃がす。** 同じ番号を共有するオブジェクトは `ErrWillDeadlock` で事前に失敗させる。Volume の削除はあえてロックを取らない。依存コンテナの `/etc/hosts` 更新はコンテナロックではなくファイルロックを使う。
6. **`num_locks` を変えたら `podman system renumber`。** SHM のサイズが合わないと `ERANGE` になるので、alive lock を取って全ロックを解放し、全オブジェクトに番号を振り直して DB に書き戻す。

## ソースコードのどこか

### Manager と Locker の契約

[`libpod/lock/lock.go#L3-L33`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/lock/lock.go#L3-L33)。

```go title="libpod/lock/lock.go"
// Manager provides an interface for allocating multiprocess locks.
// Locks returned by Manager MUST be multiprocess - allocating a lock in
// process A and retrieving that lock's ID in process B must return handles for
// the same lock, and locking the lock in A should exclude B from the lock until
// it is unlocked in A.
// All locks must be identified by a UUID (retrieved with Locker's ID() method).
// All locks with a given UUID must refer to the same underlying lock, and it
// must be possible to retrieve the lock given its UUID.
/* ... */
type Manager interface {
	// AllocateLock returns an unallocated lock.
	/* ... */
	AllocateLock() (Locker, error)
	// RetrieveLock retrieves a lock given its UUID.
	// The underlying lock MUST be the same as another other lock with the
	// same UUID.
	RetrieveLock(id uint32) (Locker, error)
	// AllocateAndRetrieveLock marks the lock with the given UUID as in use
	// and retrieves it.
	// RetrieveAndAllocateLock will error if the lock in question has
	// already been allocated.
	// This is mostly used after a system restart to repopulate the list of
	// locks in use.
	AllocateAndRetrieveLock(id uint32) (Locker, error)
```

`Locker` ([`#L60-L92`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/lock/lock.go#L60-L92)) は `sync.Locker` に `ID()` と `Free()` を足したもので、"The lock MUST still be usable after a Free() - some libpod instances may still retain Container structs with the old lock" と、解放後も他プロセスが使いうることを契約に含めている。

### 共有メモリのレイアウトと mutex 属性

[`libpod/lock/shm/shm_lock.h#L7-L33`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/lock/shm/shm_lock.h#L7-L33)。

```c title="libpod/lock/shm/shm_lock.h"
// Magic number to ensure we open the right SHM segment
#define MAGIC 0x87D1

// Type for our bitmaps
typedef uint32_t bitmap_t;

// bitmap size
#define BITMAP_SIZE (sizeof(bitmap_t) * 8)

// Struct to hold a single bitmap and associated locks
typedef struct lock_group {
  bitmap_t        bitmap;
  pthread_mutex_t locks[BITMAP_SIZE];
} lock_group_t;

// Struct to hold our SHM locks.
// Unused is required to be 0 in the current implementation. If we ever make
// changes to this structure in the future, this will be repurposed as a version
// field.
typedef struct shm_struct {
  uint16_t        magic;
  uint16_t        unused;
  pthread_mutex_t segment_lock;
  uint32_t        num_bitmaps;
  uint32_t        num_locks;
  lock_group_t    locks[];
} shm_struct_t;
```

属性の設定は [`shm_lock.c#L138-L167`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/lock/shm/shm_lock.c#L138-L167)。

```c title="libpod/lock/shm/shm_lock.c"
  // Ensure that recursive locking of a mutex by the same OS thread (which may
  // refer to numerous goroutines) blocks.
  ret_code = pthread_mutexattr_settype(&attr, PTHREAD_MUTEX_NORMAL);
  /* ... */
  // Set mutexes to pshared - multiprocess-safe
  ret_code = pthread_mutexattr_setpshared(&attr, PTHREAD_PROCESS_SHARED);
  /* ... */
  // Set mutexes to robust - if a process dies while holding a mutex, we'll get
  // a special error code on the next attempt to lock it.
  // This should prevent panicking processes from leaving the state unusable.
  ret_code = pthread_mutexattr_setrobust(&attr, PTHREAD_MUTEX_ROBUST);
```

`PTHREAD_MUTEX_NORMAL` を選ぶ理由のコメントに注意。Go の 1 つの OS スレッドは複数の goroutine を実行するので、再帰ロックを許すと、別の goroutine が同じスレッド上で二重に取れてしまう。

### 死んだ保持者からの回復

[`shm_lock.c#L19-L51`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/lock/shm/shm_lock.c#L19-L51)。

```c title="libpod/lock/shm/shm_lock.c"
// Take the given mutex.
// Handles exceptional conditions, including a mutex locked by a process that
// died holding it.
// Returns 0 on success, or positive errno on failure.
static int take_mutex(pthread_mutex_t *mutex, bool trylock) {
  int ret_code;

  if (!trylock) {
    do {
      ret_code = pthread_mutex_lock(mutex);
    } while(ret_code == EAGAIN);
  } else {
    /* ... */
  }

  if (ret_code == EOWNERDEAD) {
    // The previous owner of the mutex died while holding it
    // Take it for ourselves
    ret_code = pthread_mutex_consistent(mutex);
    if (ret_code != 0) {
      // Someone else may have gotten here first and marked the state consistent
      // However, the mutex could also be invalid.
      // Fail here instead of looping back to trying to lock the mutex.
      return ret_code;
    }
  } else if (ret_code != 0) {
    return ret_code;
  }

  return 0;
}
```

短命な Podman プロセスが `kill -9` されても、ロックが永久に詰まらない。これはデーモンレスの前提条件だ。

### 割り当てられていなくてもロックできる

[`shm_lock.c#L511-L531`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/lock/shm/shm_lock.c#L511-L531)。

```c title="libpod/lock/shm/shm_lock.c"
// Lock a given semaphore
// Does not check if the semaphore is allocated - this ensures that, even for
// removed containers, we can still successfully lock to check status (and
// subsequently realize they have been removed).
// Returns 0 on success, -1 on failure
int32_t lock_semaphore(shm_struct_t *shm, uint32_t sem_index) {
```

Go 側 ([`shm_lock.go#L212-L232`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/lock/shm/shm_lock.go#L212-L232)) は、pthread mutex の「ロックと解放は同じスレッドで」という制約のために `runtime.LockOSThread()` してから C を呼ぶ。

```go title="libpod/lock/shm/shm_lock.go"
	// For pthread mutexes, we have to guarantee lock and unlock happen in
	// the same thread.
	runtime.LockOSThread()

	retCode := C.lock_semaphore(locks.lockStruct, C.uint32_t(sem))
```

割り当てで領域が尽きたときの `ENOSPC` は、そのまま返すと "no space left on device" と読まれて誤診されるので、`num_locks` の話に翻訳する ([`#L131-L146`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/lock/shm/shm_lock.go#L131-L146))。

### 番号は DB、実体は SHM

再起動後の再確保は [`libpod/container_internal.go#L699-L704`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/container_internal.go#L699-L704)。

```go title="libpod/container_internal.go"
	// We need to pick up a new lock
	lock, err := c.runtime.lockManager.AllocateAndRetrieveLock(c.config.LockID)
	if err != nil {
		return fmt.Errorf("acquiring lock %d for container %s: %w", c.config.LockID, c.ID(), err)
	}
	c.lock = lock
```

再起動で `/dev/shm` は空になる。`NewSHMLockManager` がビットマップ全 0 で作り直し、refresh で各オブジェクトが DB に保存された番号を「使う」と宣言する。この間はどのロックも取れないので、[`libpod/runtime.go#L926-L932`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/runtime.go#L926-L932) が "The runtime alive lock should suffice to provide mutual exclusion until this has run" と、alive lock で代替すると書いている。

ロックマネージャの選択は [`libpod/runtime.go#L230-L285`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/runtime.go#L230-L285)。

```go title="libpod/runtime.go"
	case "", "shm":
		lockPath := define.DefaultSHMLockPath
		if rootless.IsRootless() {
			lockPath = fmt.Sprintf("%s_%d", define.DefaultRootlessSHMLockPath, rootless.GetRootlessUID())
		}
		// Set up the lock manager
		manager, err = lock.OpenSHMLockManager(lockPath, runtime.config.Engine.NumLocks)
		if err != nil {
			switch {
			case errors.Is(err, os.ErrNotExist):
				manager, err = lock.NewSHMLockManager(lockPath, runtime.config.Engine.NumLocks)
				/* ... */
			case errors.Is(err, syscall.ERANGE) && runtime.doRenumber:
				logrus.Debugf("Number of locks does not match - removing old locks")

				// ERANGE indicates a lock numbering mismatch.
				// Since we're renumbering, this is not fatal.
				// Remove the earlier set of locks and recreate.
				if err := os.Remove(filepath.Join("/dev/shm", lockPath)); err != nil {
```

`ERANGE` は `open_lock_shm` ([`shm_lock.c#L272-L280`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/lock/shm/shm_lock.c#L272-L280)) が MAGIC を確かめたあと、`num_locks` がセグメントのサイズと合わないときに返す。renumber 中でなければ致命的で、`podman system renumber` を促す。

### renumber

[`libpod/runtime_renumber.go#L12-L57`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/runtime_renumber.go#L12-L57)。

```go title="libpod/runtime_renumber.go"
// RenumberLocks reassigns lock numbers for all containers and pods in the
// state. This should NOT be run while there are other Libpod
func (r *Runtime) RenumberLocks() error {
	// TODO: It would be desirable to make it impossible to call this until all
	// other libpod sessions are dead.
	// Possibly use a read-write file lock, with all non-renumber podmans owning the
	// lock as read, renumber attempting to take a write lock?
	// The alternative is some sort of session tracking, and I don't know how
	// reliable that can be.

	// Acquire the alive lock and hold it.
	// Ensures that we don't let other Podman commands run while we are
	// changing around lock numbers.
	aliveLock, err := r.getRuntimeAliveLock()
	/* ... */
	// Start off by deallocating all locks
	if err := r.lockManager.FreeAllLocks(); err != nil {
		return err
	}

	allCtrs, err := r.state.AllContainers(false)
	/* ... */
	for _, ctr := range allCtrs {
		lock, err := r.lockManager.AllocateLock()
		/* ... */
		ctr.config.LockID = lock.ID()

		// Write the new lock ID
		if err := r.state.RewriteContainerConfig(ctr, ctr.config); err != nil {
			return err
		}
	}
```

TODO が「他の Podman が動いていないことを保証できない」と正直に書いている。`FreeAllLocks` の契約 ([`lock.go#L34-L47`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/lock/lock.go#L34-L47)) も "PLEASE READ FULL DESCRIPTION BEFORE USING" で始まり、renumber とテスト以外で使うなと警告している。

### ロック順序と、守れない場面の逃がし方

コンテナ削除で Pod のロックを取る前 ([`libpod/runtime_ctr.go#L766-L776`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/runtime_ctr.go#L766-L776))。

```go title="libpod/runtime_ctr.go"
		if !opts.RemovePod {
			// Lock the pod while we're removing container
			if pod.config.LockID == c.config.LockID {
				retErr = fmt.Errorf("container %s and pod %s share lock ID %d: %w", c.ID(), pod.ID(), c.config.LockID, define.ErrWillDeadlock)
				return removedCtrs, removedPods, retErr
			}
			if !opts.NoLockPod {
				pod.lock.Lock()
				defer pod.lock.Unlock()
			}
```

mutex は `PTHREAD_MUTEX_NORMAL` なので、同じ番号を二重に取ると永久にブロックする。同じ番号を共有する状況は、renumber せずに `num_locks` を変えた場合や古い Podman からの移行で起きる。`ErrWillDeadlock` ([`libpod/define/errors.go#L106-L109`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/define/errors.go#L106-L109)) のコメントは "This is usually caused by upgrade issues, and is resolved by renumbering the locks" だ。同じ検査が `mountNamedVolume` ([`libpod/container_internal.go#L1904-L1908`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/container_internal.go#L1904-L1908)) にもある。

Volume の削除は、逆にロックを取らない ([`libpod/runtime_volume_common.go#L378-L382`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/runtime_volume_common.go#L378-L382))。

```go title="libpod/runtime_volume_common.go"
	// DANGEROUS: Do not lock here yet because we might needed to remove containers first.
	// In general we must always acquire the ctr lock before a volume lock so we cannot lock.
	// THIS MUST BE DONE to prevent ABBA deadlocks.
	// It also means the are several races around creating containers with volumes and removing
	// them in parallel. However that problem exists regadless of taking the lock here or not.
```

順序を守れないなら、レースを許容してデッドロックを避ける、という判断だ。依存コンテナの `/etc/hosts` 更新 ([`libpod/container_internal.go#L2199-L2203`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/container_internal.go#L2199-L2203)) は 3 つ目の逃がし方で、"we cannot use the dependency container lock due ABBA deadlocks" と書いてファイルロックに切り替えている。

### 観測手段

`podman system locks` (hidden コマンド) は `LockConflicts` ([`libpod/runtime.go#L1248-L1254`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/runtime.go#L1248-L1254)) で、同じ番号を共有するオブジェクトと、現在保持されているロックを表示する。

```go title="libpod/runtime.go"
// Get information on potential lock conflicts.
// Returns a map of lock number to object(s) using the lock, formatted as
// "container <id>" or "volume <id>" or "pod <id>", and an array of locks that
// are currently being held, formatted as []uint32.
// If the map returned is not empty, you should immediately renumber locks on
// the runtime, because you have a deadlock waiting to happen.
```

保持中の検出は `try_lock` ([`shm_lock.c#L605-L613`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/lock/shm/shm_lock.c#L605-L613)) で、取れたら即座に離す。"Note that this is NOT POSIX trylock as the lock is immediately released if taken" と、観測専用であることを明記している。

### file ロック

cgo が使えない環境向けに `lock_type = "file"` がある ([`libpod/lock/file/file_lock.go#L75-L95`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/lock/file/file_lock.go#L75-L95))。`<TmpDir>/locks/<n>` を `O_EXCL` で作れたら割り当て、containers/storage の lockfile で排他する。上限が無いので `ERANGE` は出ないが、`LocksHeld` は未実装で、その理由 ([`libpod/lock/file_lock_manager.go#L83-L96`](https://github.com/podman-container-tools/podman/blob/v6.1.0/libpod/lock/file_lock_manager.go#L83-L96)) が "my motivation to dig into c/storage and add trylock semantics to the filelocker implementation for an uncommonly-used lock backend is lacking" と率直だ。FreeBSD では既定 ([`vendor/go.podman.io/common/pkg/config/default_bsd.go#L19-L21`](https://github.com/podman-container-tools/podman/blob/v6.1.0/vendor/go.podman.io/common/pkg/config/default_bsd.go#L19-L21))。

## なぜそうなっているか

- **1.0 以前はファイルロックで、それがデッドロックの原因だった。** [`docs/source/markdown/podman-system-renumber.1.md`](https://github.com/podman-container-tools/podman/blob/v6.1.0/docs/source/markdown/podman-system-renumber.1.md): "**podman system renumber** can also be used to migrate 1.0 and earlier versions of Podman, which used a different locking scheme, to the new locking model. It is not strictly required to do this, but it is highly recommended to do so as deadlocks can occur otherwise." コミット 185136cf0e (2018-08-08) "Add interface for libpod multiprocess locks" で今の形になった。
- **固定数にしたのは SHM のサイズを決めるため。** [`containers.conf#L683-L688`](https://github.com/podman-container-tools/podman/blob/v6.1.0/vendor/go.podman.io/common/pkg/config/containers.conf#L683-L688): "Each container, pod, and volume consumes 1 lock for as long as it exists. If this is changed, a lock renumber must be performed". 固定数の代償が renumber という運用コマンドで、コミット 7fdd20ae5a (2019-02-14) "Add initial version of renumber backend" が "Renumber is a way of renumbering container locks after the number of locks available has changed" と説明している。
- **file ロックは可搬性のため。** [`containers.conf#L655-L662`](https://github.com/podman-container-tools/podman/blob/v6.1.0/vendor/go.podman.io/common/pkg/config/containers.conf#L655-L662): "in general 'file' is useful only on platforms where cgo is not available for using the faster 'shm' lock type". rootless のためではない。rootless は uid ごとの SHM を使う。
- **ブロックする前にロックを手放す。** [conmon のページ](../conmon-supervision/) の `stopInternal` が Stopping 状態にしてからロックを外すのは、issue #8501 で「長い stop timeout が `podman ps` まで止めた」から。ロックの粒度をオブジェクト単位にしたうえで、保持時間を短く保つ規律が要る。

## どう活かすか

- プロセス間ミューテックスが要るなら、「固定数のロック + 番号を永続ストアに保存」を考える。番号さえ残せば、どのプロセスからでも同じロックを引ける。ロックの実体は再起動で消えてよい。
- robust mutex (または同等の「保持者が死んだ」検出) を使い、クラッシュしたプロセスがシステム全体を止めないようにする。
- ロック順序違反を、番号や型のレベルで事前に検出して即座に失敗させる。デッドロックしてから調べるより、発生条件が分かっているなら前段でエラーにする。
- 順序を守れない箇所は「ロックを取らない」「別のロック (ファイルロック) を使う」「作業をキューに逃がす」のどれかを選び、選んだ理由をコメントに残す。Podman は 3 つとも使っている。
- 観測手段 (`podman system locks`、`LocksHeld`) を最初から作る。
- 取り込むべきでない条件: 単一プロセスなら `sync.Mutex` で足りる。SHM + cgo + pthread はビルドと可搬性のコストが大きく、Podman も FreeBSD と cgo なしビルド向けのフォールバックを持たざるを得なかった。「割り当てられていない番号でもロックできる」設計は、番号の再利用と組み合わさると別オブジェクトのロックを取りうる。Podman は「ロック後に DB で存在確認」で吸収しているが、それは全コードがその順序を守る前提だ。

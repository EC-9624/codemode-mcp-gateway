# Bun/WASM memory follow-up

Local investigation, 2026-10-15. Nothing published upstream.

Follow-up, 2026-10-16: the [host-runtime study](runtime-study.md) verifies the relevant
allocator fix in Bun 1.4.3 and compares real executor memory, throughput, and Node
portability. The measurements and upstream inspection below remain historical.

**Outcome:** growth is tied to Bun 1.4.2's WASM fast-memory allocation path. The
measurements and pinned source strongly match mimalloc's retained page-map metadata
described in [Bun #41459](https://github.com/oven-sh/bun/issues/41459) and
[Bun PR #41512](https://github.com/oven-sh/bun/pull/41512). This narrows the earlier
worker-memory finding; it does not establish a CMG ownership defect or justify
changing executor lifetimes.

## Environment and method

- Apple M3 Pro, macOS 26.6.2 (25G83), arm64. The JSONL environment records include
  the Darwin release and CPU model.
- Bun 1.4.2, revision `744846f844374847c902b5e7fd59b4342a51ef99`.
- `process.versions.webkit`: `2e2aa2290fac856d6f451ceacb58f7f5b44dd057`.
- `process.versions.mimalloc`: `6a64e1ba7f5b2130d4efccb67ec87fd0003f0f6a`;
  allocator statistics report version 30500.
- Fresh process per comparison, sequential workers, batches of 1,000, forced
  **main-thread** `Bun.gc(true)` at snapshots, natural worker exit, one-second idle.
  Each 2,000-worker comparison observed 2,000 starts, replies, and exits, with zero
  awaited forced terminations. The second batch distinguishes growth from startup.
- All installation, probes, profiling, builds, and checks ran through a temporary
  shared `with-exclusive.py` lock. Each measured interval held one acquisition through
  startup, workload, idle, and final profiling. No runtime installation or upgrade.

## Measurements

MiB, at 1,000 → 2,000 completed workers, before the final idle:

| Workload                                     | Process RSS     | mimalloc commitment | mimalloc reservation | Main JSC heap |
| -------------------------------------------- | --------------- | ------------------- | -------------------- | ------------- |
| WASM, 16 MiB, touch one byte                 | 72.64 → 90.69   | 165.95 → 228.64     | 1090.88 → 1153.38    | 2.326 → 2.349 |
| WASM, same constructor, never read `.buffer` | 79.77 → 97.27   | 176.89 → 239.64     | 1090.88 → 1153.38    | 2.332 → 2.348 |
| ArrayBuffer, 16 MiB, touch one byte          | 104.47 → 105.38 | 144.45 → 144.45     | 1028.38 → 1028.38    | 2.325 → 2.347 |
| WASM, touch one byte, fast memory disabled   | 64.73 → 66.61   | 137.45 → 137.45     | 1028.38 → 1028.38    | 2.332 → 2.349 |

The first two runs add **exactly 65,536,000 reserved bytes per 1,000 workers**;
commitment increases by about 62.7 MiB. The controls have no reservation or
commitment increase in that interval. One second idle does not remove the WASM
growth. Absolute RSS differs between runs and is not a live-allocation measurement.

The dependency-free reproduction also completed all 2,000 replies and natural
exits without profiler instrumentation: at 1,000 → 2,000 workers, RSS was
68.33 → 84.58 MiB and commitment 147.52 → 210.20 MiB. Its main JSC heap stayed
near 1.3 MiB. The standalone empty-worker control completed 1,000 replies/exits.

### OS mappings and allocator pages

- Default WASM: `vmmap`'s `Memory Tag 240` region count grows from 1,010 at 1,000
  workers to 2,010 at 2,000. Its virtual size grows 194.9 → 257.4 MiB. macOS physical
  footprint grows 37.6 → 54.1 MiB. This is distinct from process RSS and mimalloc's
  commitment counter.
- A targeted 1,000-worker follow-up captured a non-coalesced full map: **1,002
  regions of 64 KiB with 16 KiB resident/dirty each**. The fast-memory-disabled
  2,000-worker run has only two regions with that shape. These are mappings tagged
  by the allocator, not 16-MiB WASM memories left resident.
- Default WASM's reported allocator page count is 374 → 363; heaps remain four.
  Its main JSC heap stays near 2.3 MiB. Those counters do not account for every
  native metadata allocation; the heap dump is not a whole-process leak detector.
- A three-worker `BUN_JSC_logWasmMemory=true` trace reports each 16-MiB logical
  allocation freed and each fast reservation released, with the manager returning
  to zero memories/bytes after each worker. It is direct runtime bookkeeping
  evidence for those three workers, not an allocation-stack trace for every run.
- A separate three-worker trace verifies that `BUN_JSC_useWasmFastMemory=false`
  takes the non-fast path. The measured 2,000-worker run disables logging.

## Source-based explanation

These references are pinned to the revisions reported by the installed binary.

1. [Bun's statistics implementation][bun-stats] takes JSC statistics from the
   calling VM. `memoryUsage().currentCommit` comes from `mi_process_info`, whose
   [macOS implementation][mi-prim] keeps mimalloc's commitment counter rather than
   replacing it with process RSS. `heapStats()` itself calls `mi_collect(false)`;
   these observations are not passive, JS-only measurements.
2. [WasmMemory.cpp][wasm-memory] tries signaling/fast memory for a default memory32
   allocation. [BufferMemoryHandle.cpp][buffer-memory] reserves the 32-bit address
   range plus redzone, independently of the 16-MiB logical size, and frees that
   reservation on destruction. No WASM module compilation is needed by this repro.
3. [bmalloc.cpp][bmalloc-cpp] routes virtual allocation through `tryMemalign` and
   purges the pages. The mimalloc branch of [bmalloc.h][bmalloc-h] uses
   `mi_malloc_aligned`; freeing uses `mi_free`. The virtual-memory API therefore
   still goes through mimalloc in this build.
4. [mimalloc os.c][mi-os] advances an address-hint cursor for aligned allocations.
   The pinned version has no unconditional 1-GiB cutoff. Large allocations can
   therefore visit fresh address ranges even when earlier allocations were freed.
5. The two-level map in [page-map.c][mi-map] allocates submaps on demand. The sizes
   in [internal.h][mi-internal] are 64 KiB per submap covering 512 MiB of address
   space. Registration covers the beginning of a huge allocation, not all its
   logical bytes. Unregistration clears entries; it does not free submaps.

This explains why a freed multi-GiB reservation can leave small native mappings
behind without retaining the WASM buffer. The size, mapping count, resident-page
shape, and fast-memory intervention agree with that mechanism. We did not capture
native allocation backtraces or rebuild Bun with the proposed fix, so attribution
of every retained mapping to that function remains an inference, not a local
symbolized proof.

## Upstream status inspected on 2026-10-15

- [Bun #41459](https://github.com/oven-sh/bun/issues/41459): open; reports the same
  `WebAssembly.Memory`-only growth on Linux, including Bun 1.4.2. Its approximately
  4-KiB RSS/cycle figure is not the macOS arm64 measurement here.
- [mimalloc PR #34](https://github.com/oven-sh/mimalloc/pull/34): merged on
  2026-09-16; limits address hints for allocations above 1 GiB.
- [Bun PR #41512](https://github.com/oven-sh/bun/pull/41512): open, unmerged at
  inspection; proposes adopting that allocator revision. Its Linux results and
  fast-memory intervention corroborate this diagnosis. They are upstream claims,
  not locally reproduced fixed-runtime results.
- [mimalloc PR #36](https://github.com/oven-sh/mimalloc/pull/36): closed **without
  merge**; describes the same mechanism with an arena-size-based cutoff.

No fixed Bun release was verified. The environment flag below is an experimental
diagnostic control, not a recommended production configuration or a measured CMG
performance tradeoff.

## Reproduce locally

The single-file [standalone reproduction](../scripts/studies/wasm-memory-repro.ts) needs
only the existing Bun runtime. Copy it outside the repository if desired. It
defaults to 2,000 workers, accepts 1–3,000, validates replies and natural exits,
has a five-minute watchdog, and prints bounded JSONL snapshots. `worker` is an
empty-worker control. No CMG, QuickJS, Zod, or compiled package is imported.

Run these comparisons sequentially, without other memory-heavy workloads:

```sh
bun scripts/studies/wasm-memory-repro.ts wasm 2000
bun scripts/studies/wasm-memory-repro.ts worker 2000

bun run baseline:memory --scenario wasm-memory \
  --runs 2000 --batch-size 1000 --gc forced --worker-exit natural --profile
bun run baseline:memory --scenario wasm-memory-unread \
  --runs 2000 --batch-size 1000 --gc forced --worker-exit natural --profile
bun run baseline:memory --scenario array-buffer \
  --runs 2000 --batch-size 1000 --gc forced --worker-exit natural --profile
env BUN_JSC_useWasmFastMemory=false bun run baseline:memory \
  --scenario wasm-memory --runs 2000 --batch-size 1000 --gc forced \
  --worker-exit natural --profile
```

`--profile` is macOS-only: it emits additional `allocator` records containing
`heapStats({ dump: true })` diagnostics and `vmmap` records containing OS output.
The Bun 1.4.2 diagnostic argument is implemented but absent from its TypeScript
declarations; the harness checks that the returned diagnostic fields exist.
Maps are taken between workers: summaries before/after batches and a full,
non-coalesced map after idle. Profiling affects allocation and timing; snapshots
are sequential, not atomic. The first three comparisons used summaries throughout;
the full-map follow-up and fast-memory-disabled run used the final full map.

These finite, single-host comparisons do not establish indefinite growth, a
production memory bound, or the total source of QuickJS/executor overhead. Main
GC cannot measure every worker heap; observed exit events and flat post-warmup
stack/allocator counts provide separate lifecycle evidence.

[bun-stats]: https://github.com/oven-sh/bun/blob/744846f844374847c902b5e7fd59b4342a51ef99/src/jsc/modules/BunJSCModule.h
[mi-prim]: https://github.com/oven-sh/mimalloc/blob/6a64e1ba7f5b2130d4efccb67ec87fd0003f0f6a/src/prim/unix/prim.c
[wasm-memory]: https://github.com/oven-sh/WebKit/blob/2e2aa2290fac856d6f451ceacb58f7f5b44dd057/Source/JavaScriptCore/wasm/WasmMemory.cpp
[buffer-memory]: https://github.com/oven-sh/WebKit/blob/2e2aa2290fac856d6f451ceacb58f7f5b44dd057/Source/JavaScriptCore/runtime/BufferMemoryHandle.cpp
[bmalloc-cpp]: https://github.com/oven-sh/WebKit/blob/2e2aa2290fac856d6f451ceacb58f7f5b44dd057/Source/bmalloc/bmalloc/bmalloc.cpp
[bmalloc-h]: https://github.com/oven-sh/WebKit/blob/2e2aa2290fac856d6f451ceacb58f7f5b44dd057/Source/bmalloc/bmalloc/bmalloc.h
[mi-os]: https://github.com/oven-sh/mimalloc/blob/6a64e1ba7f5b2130d4efccb67ec87fd0003f0f6a/src/os.c
[mi-map]: https://github.com/oven-sh/mimalloc/blob/6a64e1ba7f5b2130d4efccb67ec87fd0003f0f6a/src/page-map.c
[mi-internal]: https://github.com/oven-sh/mimalloc/blob/6a64e1ba7f5b2130d4efccb67ec87fd0003f0f6a/include/mimalloc/internal.h

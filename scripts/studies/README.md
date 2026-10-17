# Historical studies

These opt-in scripts preserve earlier investigations. They are not build,
installation, or acceptance-check dependencies. Measurements remain in
[`docs/measurements/`](../../docs/measurements/).

- `runtime-contract.ts`, `runtime-comparison.ts`, `runtime-matrix.ts`, and
  `fixtures/runtime-worker.ts`: the [Bun/Node host study](../../docs/runtime-study.md).
  Its starting revision was `9ce90ed`, with the portability changes documented
  there. The current executor uses Bun APIs; the archived matrix's Node host is
  not supported against today's tree. Use the study's recorded source/runtime
  combination to reproduce historical measurements, not current acceptance checks.
- `wasm-memory-repro.ts`: the dependency-free
  [Bun 1.4.2 allocator reproduction](../../docs/wasm-memory.md). It remains useful
  for comparing runtime versions but does not test gateway ownership or readiness.

No historical measurement data was regenerated when these scripts were moved.

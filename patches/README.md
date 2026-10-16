# QuickJS memory-growth patch

`quickjs-emscripten-core@0.32.0` retains a TypedArray over WASM memory across FFI
calls. When memory grows, that view detaches. In `executePendingJobs()`, the stale
context-pointer read produces `undefined`, creates an unmanaged context, and later
fails `JS_FreeRuntime` disposal.

Upstream: [issue #240](https://github.com/justjake/quickjs-emscripten/issues/240),
[unreleased fix #248](https://github.com/justjake/quickjs-emscripten/pull/248).

The Bun patch changes only `ModuleMemory.newTypedArray()` in the CommonJS and ESM
bundles. Its returned `typedArray` getter refreshes the view when the WASM buffer
changes, retaining the original pointer, element type, length, and disposer:

```js
const module = this.module;
return new Lifetime(
  {
    get typedArray() {
      if (typedArray.buffer !== module.HEAPU8.buffer) {
        typedArray = new kind(module.HEAPU8.buffer, ptr, length);
      }
      return typedArray;
    },
    ptr,
  },
  undefined,
  (value) => module._free(value.ptr),
);
```

This also protects other users of `newMutablePointerArray()` without changing the
SDK's public API. Replace it with a reviewed fixed release when available.

The codemode build bundles the patched SDK JavaScript through
`src/runtime/quickjs.ts`; WASM variants remain external dependencies. Installed
consumers need no install scripts or consumer overrides. Distribution checks
exercise large async results in an unrelated installation. The MIT notices ship
with the package.

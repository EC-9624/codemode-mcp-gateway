// QuickJS SDK 0.32.0 caches typed-array views that detach when WASM memory grows.
// A stale pending-job context pointer becomes undefined, creating an unmanaged
// context that crashes runtime disposal. Our patch refreshes views before access.
// The build bundles this entry so standalone installs receive the fix too.
// Replace the patch with a reviewed fixed release; see patches/README.md (#240, #248).
export { getQuickJS } from "quickjs-emscripten";

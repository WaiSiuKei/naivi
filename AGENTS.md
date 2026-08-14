# AGENTS.md

blitz is a Rust browser engine; **naivi** is a Vue Vapor (AOT) frontend for it — TS toolchain in `js/naivi-*`, shared Rust hosts in `packages/naivi-wasm` + `packages/naivi-native`. See `docs/naivi.md` for architecture and per-command usage (`nv web` / `wasm` / `desktop`).

## naivi guest debug log forwarding

The runtime can forward every `console.*` line — including tracing_wasm's styled Rust logs on the wasm channel — to a local HTTP endpoint, so a host-side listener can observe the guest's event flow even when the page runs in a browser you cannot inspect. **Off by default.** Enable before the guest loads:

- `window.__NAIVE_DEBUG_LOG = true` (set `window.__NAIVE_DEBUG_LOG_URL` to override the endpoint), or
- a `naivi_debug_log` query param on the page URL.

Default endpoint: `http://localhost:8091/log?lv=<level>&m=<message>`. Implementation: module-scope forwarder in `js/naivi-runtime/src/native-tree.ts`. Do **not** add unconditional `console.log` debugging to the runtime — use this switch instead.

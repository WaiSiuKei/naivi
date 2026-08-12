# naivi counter — wasm channel (U4)

Runs the naivi (Vue Vapor) counter on **blitz-dom** in the browser: a `cdylib`
exposing the KTD1 mutation-mirror protocol (U4) over the U3 `OpsCore`, driven
by `BlitzApplication` (winit + VelloHybrid renderer) on the `#blitz-target`
canvas.

## Layout

- `src/lib.rs` — wasm-bindgen exports (`create_element`, `create_text_node`,
  `set_text`, `set_attr`, `set_style`, `append_child`, `insert_before`,
  `insert_after`, `replace_node`, `remove_node`, `bind_event`, `unbind_event`,
  `set_event_callback`, `tick`) + `start()` (canvas → EventLoop →
  VelloHybrid renderer → `NaiviDocument` → `BlitzApplication`).
- `assets/DejaVuSans.woff2` — bundled font (`build_single_font_ctx`).
- `assets/guest/` — **generated** by `naivi wasm --release` (gitignored):
  `guest.js` (wrapper) + `guest.bundle.js` (Vite-built Vue Vapor bundle).
- `index.html` — trunk host page; loads the wasm glue and the guest bundle.

## Reproduce (documented U4 wiring)

```bash
# 1. Build the guest bundle and copy it into assets/guest/ (run from the demo):
cd examples/naivi/counter
node ../../../js/naivi-cli/bin/naivi.mjs wasm --release
#    (or, with the demo's devDependency installed: pnpm build:wasm)

# 2. Build the wasm host + bundle everything with trunk:
cd ../counter-wasm
trunk build        # or: trunk build --release
```

`trunk build` produces `dist/` containing `index.html`,
`naivi-counter-wasm-<hash>.js` + `_bg.wasm` (the wasm glue), and
`assets/guest/*` (copied verbatim by trunk via the `copy-dir` link). Serve
`dist/` and open the page.

## Protocol notes

- Node ids are blitz-allocated `NodeId`s as `u64` / JS `bigint`.
- Event kinds are `u8` in `NaiviEventKind::ALL` order (click=0 … dblclick=8),
  mirrored by `EVENT_KINDS` in `js/naivi-runtime/src/wasm-types.ts`.
- `bind_event` returns the node id as the handler id; `unbind_event` clears
  every binding on that node.
- `set_event_callback` receives `(nodeId, kind, x, y)` per drained event.
- The JS side consumes the wasm glue from `window.wasmBindings`
  (published by trunk, `TrunkApplicationStarted` event) — see
  `js/naivi-runtime/src/index-vue-vapor.ts`.

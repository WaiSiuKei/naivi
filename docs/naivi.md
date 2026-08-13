# naivi — Vue Vapor AOT frontend on blitz

`naivi` runs a **Vue Vapor** (AOT) frontend on top of blitz's engine. A forked
TS toolchain (`js/naivi-*`) compiles Vue SFCs and drives blitz's render tree
(stylo CSS + taffy layout + parley text) through a **Mutation Mirror Bridge** —
the same DOM operations a browser performs, delivered as engine-neutral ops.

```
Vue SFC → Vapor AOT (TS) → JS mirror tree → mutation ops → host exports
  (wasm-bindgen on wasm / rquickjs FFI on native) → OpsCore (Rust) →
  DocumentMutator → blitz-dom BaseDocument → blitz-paint → anyrender →
  blitz-shell (winit / trunk)
```

Both platforms share one code path: the JS mirror tree is channel-agnostic; the
Rust `OpsCore` is engine-neutral; only the host adapters differ.

## Repository layout

| Path | What it is |
|---|---|
| `js/naivi-runtime/` | Guest runtime: mirror tree, DOM facade, style stub, dual-mode mount (`vue-vapor`) |
| `js/naivi-compiler/` | Build-time AOT CSS producer (`compileSfcStyles` extracts SFC `<style>` → CSS text) |
| `js/naivi-cli/` | `naivi` CLI: `web` / `wasm --release` / `desktop` (Vite bundling + host launch) |
| `packages/naivi-dom/` | Rust `Document` impl + engine-neutral `OpsCore` + rquickjs FFI (feature `quickjs`) |
| `packages/naivi-guest-quickjs/` | QuickJS guest lifecycle (eval bundle, microtask pump, event drain) |
| `packages/naivi-wasm/` | **Shared** trunk host for the wasm channel (bundles DejaVu Sans; serves any demo's guest) |
| `packages/naivi-native/` | **Shared** winit entry for the native channel (rquickjs guest; evals any demo's main + page bundles) |
| `examples/naivi/counter/` | The counter demo (Vue SFC) |
| `examples/naivi/todomvc/` | The todomvc demo (Vue SFC, official TodoMVC structure) |

Both hosts are generic — one wasm host and one native host serve **every**
demo. There are no per-demo host crates: `naivi wasm --release` drops the
demo's guest into `packages/naivi-wasm/assets/guest/`, and `naivi desktop`
runs `naivi-native` with the demo's main + page bundles.

The desktop `main` entry (from `naive.config.ts` `main`, e.g. `app/main.ts`)
is the Electron-style main process: `app.whenReady()` + `NaiveWindow` drive
window creation and page loading. The CLI bundles it into `main-bundle.js`
(`@naivi/runtime` aliased to the desktop-main API) and the page entry into
`page-bundle.js` (`@naivi/runtime/vue-vapor` aliased to the desktop mount);
the host evals the main bundle, resolves `whenReady`, and `loadFile('index.html')`
evals the page bundle as window content.

The whole JS side is one **pnpm workspace anchored at the repo root**
(`pnpm-workspace.yaml`): the `@naivi/*` toolchain (`js/naivi-*`) plus the
demos (`examples/naivi/counter`, `examples/naivi/hello`), wired with
`workspace:*` deps. Install once at the top level:

```sh
pnpm install        # at the repo root
pnpm -r typecheck   # whole workspace
pnpm -r test
```

## Run the counter demo

### Web (plain browser, no blitz)
```sh
cd examples/naivi/counter
node ../../../js/naivi-cli/bin/naivi.mjs web
```

### Wasm (blitz in the browser via trunk)
```sh
cd examples/naivi/counter
node ../../../js/naivi-cli/bin/naivi.mjs wasm   # build guest + serve host → http://localhost:8090
# `--release` instead builds the host into packages/naivi-wasm/dist (no serve)
```

### Native (blitz in a winit window via QuickJS)
```sh
cd examples/naivi/counter
node ../../../js/naivi-cli/bin/naivi.mjs desktop
```

## Protocol notes

- Node ids are blitz-allocated `u64`s (JS `bigint`).
- `bind_event(nodeId, kind)` takes the DOM event-type **string** (`"click"`, …)
  on both channels (the wasm adapter encodes it as the protocol `u8`).
- Rust→JS events arrive as `(nodeId, kind, x, y)`; `kind` follows
  `NaiviEventKind::ALL` order (click=0 … dblclick=8).
- Inline `:style` bindings flow through the `el.style` stub → `set_style`
  (camelCase→kebab-case). SFC `<style>` / author CSS is compiled to CSS text
  (`__NAIVE_CSS`) and injected as a stylo author stylesheet via
  `add_stylesheet` — class / tag / `:hover` / `:active` / `:checked` are
  matched natively by stylo.

## Status

| Unit | Scope | Status |
|---|---|---|
| U1 | Fork `js/naivi-*` toolchain | ✅ |
| U2 | `naivi web` counter demo | ✅ |
| U3 | `naivi-dom` (OpsCore + NaiviDocument + events) | ✅ |
| U4 | Wasm channel + browser counter | ✅ |
| U5 | Native channel (rquickjs) + native counter | ✅ |
| U6 | AOT CSS → stylo injection (`:hover` verified) | ✅ |
| U7 | Acceptance wrap-up | in progress |

See `docs/plans/2026-08-12-072-arch-naivi-vapor-frontend-plan.md` for the full
plan and rationale.

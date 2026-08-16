**English** | [简体中文](./README.zh-CN.md)

# naivi

**Vue Vapor frontend on the [blitz](https://github.com/DioxusLabs/blitz) browser engine.**

Write Vue SFCs; run them on blitz's real rendering stack — stylo CSS, taffy
layout, parley text, vello GPU rasterization — in the browser (wasm) or in a
native window (winit + QuickJS), with no browser DOM involved.

```
Vue SFC → Vapor AOT (TS) → JS mirror tree → mutation ops → host exports
  (wasm-bindgen on wasm / rquickjs FFI on native) → OpsCore (Rust) →
  DocumentMutator → blitz-dom BaseDocument → blitz-paint → anyrender →
  blitz-shell (winit / trunk)
```

The JS mirror tree is channel-agnostic and the Rust `OpsCore` is
engine-neutral — **one code path drives both platforms**; only the host
adapters differ. This "mutation mirror bridge" replays the same DOM operations
a browser performs, as engine-neutral ops.

## Live demos (wasm)

Try the demos in your browser — Vue SFCs rendered by the blitz engine via
WebAssembly (hosted on GitHub Pages):

- **Counter** — https://waisiukei.github.io/naivi/counter/
- **TodoMVC** — https://waisiukei.github.io/naivi/todomvc/

## Platform support

naivi currently targets **three** platforms:

| Platform | Channel | Status |
|---|---|---|
| **macOS** desktop | `nv desktop` — winit window + QuickJS, Metal/vello | ✅ supported |
| **Web** (plain browser) | `nv web` — standard Vite, no blitz | ✅ supported |
| **WebAssembly** | `nv wasm` — blitz in the browser via trunk | ✅ supported |

The native desktop host (`packages/naivi-native`) is currently **macOS-only**:
its native input and text backends are macOS-specific (AppKit/ObjC). Linux and
Windows desktop, as well as iOS/Android, are not supported yet.

## Text rendering & input

- **Fonts — macOS desktop**: native CoreText text backend
  (`packages/blitz-macos-text` + the naivi-maintained parley fork). System
  fonts; CJK falls back to PingFang SC.
- **Fonts — wasm**: Google Fonts slices are loaded **dynamically** — the host
  fetches the font CSS and schedules unicode-range slices on demand (Noto
  Sans / Noto Sans SC / Noto Color Emoji / Noto Sans Hebrew / Noto Sans
  Arabic), with weight fallbacks and lazily-loaded RTL sheets; DejaVu Sans is
  bundled as the fallback.
- **Input — macOS desktop**: real native text input — AppKit `NSTextField` /
  `NSTextView` (native IME, caret/selection, padding & font parity). Enter
  keeps the editing session (implicit form submit); blur / focus-move / Tab
  ends it.
- **Input — web (`nv web`)**: the browser's own `<input>` (no blitz).
- **Input — wasm**: an HTML `<input>` / `<textarea>` overlay is positioned
  over the blitz canvas (browser-native IME + CJK composition); the canvas
  skips painting the mirrored text during the session and the final value
  commits on blur.

## Quick start

Prerequisites: Node.js ≥ 24, pnpm, Rust stable (with `wasm32-unknown-unknown`
for wasm), and `trunk` for the wasm host.

```sh
pnpm install        # at the repo root (pnpm workspace)
pnpm -r typecheck   # whole workspace
pnpm -r test
```

### Web (plain browser, no blitz)

```sh
cd examples/naivi/counter
npx nv web
# `--release` builds the plain static site into dist/
```

### Wasm (blitz in the browser via trunk)

```sh
cd examples/naivi/counter
npx nv wasm   # build guest + serve host → http://localhost:8090
# `--release` builds the deployable wasm site (engine + guest) into dist/
```

### Native (blitz in a winit window via QuickJS)

```sh
cd examples/naivi/counter
npx nv desktop
# `--release` packages a macOS .app into release/<name>.app (name from naivi.config.ts)
```

The desktop `main` entry (`app/main.ts` from `naivi.config.ts`) is the
Electron-style main process: `app.whenReady()` + `NaiveWindow` create the
window and load `index.html`.

## npm packages

| Package | What it is |
|---|---|
| `@naivi/cli` | `nv` CLI (web / wasm / desktop) |
| `@naivi/compiler` | AOT compiler — Vue SFC → RenderTree IR + Style IR |
| `@naivi/protocol` | Bridge protocol single source of truth |
| `@naivi/runtime` | Vue Vapor runtime adapter (`@naivi/runtime/vue-vapor`, `/desktop-main`, …) |

## Built on blitz

This repository is a fork of [DioxusLabs/blitz](https://github.com/DioxusLabs/blitz)
and adds the naivi frontend on top. naivi keeps upstream mergeable; see
`docs/naivi.md` for the architecture and per-command usage, and `docs/plans/`
for the implementation plans.

## License

MIT OR Apache-2.0 (matching blitz).

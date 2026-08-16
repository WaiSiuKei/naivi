# Contributing to naivi

naivi is a **Vue Vapor (AOT) frontend on the [blitz](https://github.com/DioxusLabs/blitz)
browser engine** — write Vue SFCs and run them on blitz's real rendering stack
(stylo CSS, taffy layout, parley text, vello GPU) in the browser (wasm) or in a
native window (winit + QuickJS). See `docs/naivi.md` for the architecture.

This repository is a fork of blitz with the naivi toolchain layered on top. The
Rust engine crates follow blitz conventions; the `js/naivi-*` toolchain follows
the pnpm workspace conventions below.

## Prerequisites

All platforms require **Rust**, **Python 3** and a **C toolchain** to build the
blitz engine (stylo's build generates code via Python).

- Rust: https://rustup.rs
- Node.js ≥ 24 and pnpm (naivi JS toolchain)
- `trunk` for the wasm host (`cargo install trunk`)

### macOS

Python is pre-installed. Use the C toolchain from the Xcode Command Line Tools.
`rustup target add wasm32-unknown-unknown` is required for wasm builds.

### Linux

To build you need a C toolchain plus a few dependencies:

- `pkg-config` and a C compiler (`build-essential`)
- `python3` — used to generate code while building `stylo`
- `libssl-dev` (OpenSSL) — required by `reqwest` via `blitz-net`
- `libfontconfig-dev` (fontconfig) — required by `parley`/`fontique`

```sh
sudo apt-get update
sudo apt-get install build-essential pkg-config python3 libssl-dev libfontconfig-dev
```

To **run** a windowed application you additionally need X11/Wayland:

```sh
sudo apt-get install libfontconfig-dev libx11-dev libxcb1-dev libwayland-dev
```

### VSCode

Recommended `rust-analyzer` settings in `.vscode/settings.json`:

```json
{
    "rust-analyzer.check.features": "all",
    "rust-analyzer.cargo.features": "all",
    "rust-analyzer.check.allTargets": true,
    "rust-analyzer.cargo.allTargets": true
}
```

## Project layout

| Path | What it is |
|---|---|
| `js/naivi-runtime/` `js/naivi-compiler/` `js/naivi-protocol/` `js/naivi-cli/` | The TS toolchain (`@naivi/*`, one pnpm workspace) |
| `packages/naivi-dom/` `packages/naivi-guest-quickjs/` | Rust engine side of naivi (OpsCore, Document impl, QuickJS guest) |
| `packages/naivi-wasm/` `packages/naivi-native/` | The **shared** wasm / native hosts that serve every demo |
| `examples/naivi/counter/` `examples/naivi/todomvc/` | Vue SFC demos |
| `packages/blitz-*` etc. | The blitz engine (upstream) |

## Setting up

```sh
pnpm install          # at the repo root — installs the whole JS workspace
pnpm -r typecheck     # type-check toolchain + demos
pnpm -r test          # run the vitest suites
```

## Running the demos

From a demo directory (e.g. `examples/naivi/counter` or `examples/naivi/todomvc`):

```sh
node ../../../js/naivi-cli/bin/nv.mjs web       # plain browser (Vite, no blitz)
node ../../../js/naivi-cli/bin/nv.mjs wasm      # blitz in the browser → http://localhost:8090
node ../../../js/naivi-cli/bin/nv.mjs desktop   # blitz in a native winit window
```

`justfile` / `Makefile` wrap the same commands (`just naivi-counter-wasm`,
`make wasm DEMO=todomvc`, …).

## Checking / building

```sh
cargo check --workspace    # Rust engine
cargo fmt --all            # formatting
cargo clippy --workspace   # lints
pnpm -r typecheck          # JS toolchain
pnpm -r test               # JS tests
pnpm -r build              # JS builds (dist/)
```

Rust tests live with their crates (`cargo test -p naivi-dom`, …); the WPT
runner is `just wpt` / `cargo run --release --package wpt`.

## Code conventions

- **Rust** — follow blitz conventions: `cargo fmt`, no `unsafe` without a
  comment, engine-neutral design in `naivi-dom` (the OpsCore must not know
  about a specific host).
- **TypeScript** — `type: module`, strict types, `tsc` for build/typecheck.
  Keep the mirror-tree runtime channel-agnostic; host adapters live at the
  edges (`desktop-main`, wasm exports).
- **Protocol** — `js/naivi-protocol` is the single source of truth for event
  kinds / wire tables. `packages/naivi-dom`'s `build.rs` parses the same
  literal tables: **breaking changes must be coordinated across both sides**.

## Contribution process

1. Open an issue or pick one up; for larger changes, add a plan under
   `docs/plans/` (see `docs/plans/2026-08-12-072-arch-naivi-vapor-frontend-plan.md`
   for the format) and get it agreed before implementing.
2. Branch from `main` (`feat/*` or `fix/*`), commit with a clear message
   prefixed by scope (e.g. `fix(naivi/todomvc): …`, `perf(naivi-native): …`).
3. Run the checks above (fmt, clippy, typecheck, tests) and make sure the
   demos still run.
4. Open a PR against `main`.

### Keeping mergeable with upstream blitz

This repo tracks `DioxusLabs/blitz` upstream. Keep naivi changes additive and
localized so `main` stays mergeable: prefer adding naivi crates / `js/naivi-*`
packages over modifying upstream engine files, and when upstream code must
change, do it in a way that upstream would accept. Never blanket-resolve
root `Cargo.toml` conflicts with `--theirs` (it wipes naivi's members, deps
and the `naivi-parley` fork pin) — always diff and restore naivi bits.

## Documentation

- `docs/naivi.md` — architecture and per-command usage.
- `docs/plans/` — implementation plans (numbered, dated).
- `CONTEXT.md` — the naivi domain model / glossary.
- `AGENTS.md` — agent/automation notes (naivi guest debug log forwarding, …).

## License

MIT OR Apache-2.0 (matching blitz).

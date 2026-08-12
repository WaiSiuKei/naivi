
## Build/lint commands

check:
  cargo check --workspace

clippy:
  cargo clippy --workspace

fmt:
  cargo fmt --all

small:
  cargo build --profile small -p counter --no-default-features --features cpu,system-fonts

## naivi (Vue Vapor AOT frontend on blitz)

# Type-check the whole pnpm workspace (toolchain + demos) from the repo root
naivi-js-check:
  pnpm -r typecheck

# Build the counter wasm guest into the SHARED trunk host
# (packages/naivi-wasm/assets/guest), then:
# cd packages/naivi-wasm && trunk serve --release --port 8090
naivi-counter-wasm:
  cd examples/naivi/counter && node ../../../js/naivi-cli/bin/naivi.mjs wasm --release

# Run the counter in a native winit window (shared rquickjs guest host)
naivi-counter-desktop:
  cd examples/naivi/counter && node ../../../js/naivi-cli/bin/naivi.mjs desktop

# Serve the counter in a plain browser (standard Vite, no WASM)
naivi-counter-web:
  cd examples/naivi/counter && node ../../../js/naivi-cli/bin/naivi.mjs web

# Build the todomvc wasm guest into the SHARED trunk host
# (packages/naivi-wasm/assets/guest), then:
# cd packages/naivi-wasm && trunk serve --release --port 8090
naivi-todomvc-wasm:
  cd examples/naivi/todomvc && node ../../../js/naivi-cli/bin/naivi.mjs wasm --release

# Run the todomvc in a native winit window (shared rquickjs guest host)
naivi-todomvc-desktop:
  cd examples/naivi/todomvc && node ../../../js/naivi-cli/bin/naivi.mjs desktop

# Serve the todomvc in a plain browser (standard Vite, no WASM)
naivi-todomvc-web:
  cd examples/naivi/todomvc && node ../../../js/naivi-cli/bin/naivi.mjs web

## WPT test runner

wpt *ARGS:
  cargo run --release --package wpt {{ARGS}}

browser *ARGS:
  cargo run --release --package browser --features log-frame-times,log-phase-times {{ARGS}}

browser-with-perf:
  cargo run --release --package browser --features log-frame-times,log-phase-times

browskia:
  cargo run -rp browser --no-default-features --features skia,floats,cookies,cache,log-frame-times,log-phase-times

## Browser

screenshot *ARGS:
  cargo run --release --example screenshot {{ARGS}}

open *ARGS:
  cargo run --release --package rdme --features log-frame-times,log-phase-times {{ARGS}}

openskia *ARGS:
  cargo run --release --package rdme --no-default-features --features skia,comrak,floats,log-frame-times,log-phase-times {{ARGS}}

opencpu *ARGS:
  cargo run --release --package rdme --no-default-features --features cpu,comrak,floats,log-frame-times,log-phase-times {{ARGS}}

dev *ARGS:
  cargo run --package rdme --features log-frame-times,log-phase-times {{ARGS}}

cpu *ARGS:
  cargo run --release --package rdme --no-default-features --features cpu,comrak,floats,log-frame-times,log-phase-times {{ARGS}}

hybrid *ARGS:
  cargo run --release --package rdme --no-default-features --features hybrid,comrak,floats,log-frame-times,log-phase-times {{ARGS}}

skia *ARGS:
  cargo run --release --package rdme --no-default-features --features skia,comrak,floats,log-frame-times,log-phase-times {{ARGS}}

skia-pixels *ARGS:
  cargo run --release --package rdme --no-default-features --features skia-pixels,comrak,floats,log-frame-times,log-phase-times {{ARGS}}

skia-softbuffer *ARGS:
  cargo run --release --package rdme --no-default-features --features skia-softbuffer,comrak,floats,log-frame-times,log-phase-times {{ARGS}}

## 7GUIs

seven_guis *ARGS:
  cargo run --release --package seven_guis --bin seven_guis_native {{ARGS}}

## TodoMVC commands

todomvc *ARGS:
  cargo run --release --package todomvc --bin todomvc_native {{ARGS}}

todoskia *ARGS:
  cargo run --release --package todomvc --bin todomvc_native {{ARGS}} --no-default-features --features skia

todoandroid *ARGS:
  export CARGO_APK_RELEASE_KEYSTORE="$HOME/.android/debug.keystore"
  export CARGO_APK_RELEASE_KEYSTORE_PASSWORD="android"
  cargo apk run --lib --no-default-features --features skia -p todomvc

counterandroid *ARGS:
  export CARGO_APK_RELEASE_KEYSTORE="$HOME/.android/debug.keystore"
  export CARGO_APK_RELEASE_KEYSTORE_PASSWORD="android"
  cargo apk run --lib --no-default-features --features skia -p counter

## WASM

wasm-build APP *ARGS:
  cd examples/{{APP}} && trunk build --release --public-url ./ {{ARGS}}

wasm-serve APP *ARGS:
  cd examples/{{APP}} && trunk serve --release --public-url ./ {{ARGS}}

## Ops

bump *ARGS:
  cargo run --release --package bump {{ARGS}}
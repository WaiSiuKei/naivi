# naivi — Vue Vapor AOT frontend on blitz. Mirrors naive/Makefile: `nv
# wasm` is now ONE command (builds the demo's guest JS, then builds/serves the
# shared Rust host `packages/naivi-wasm` via trunk). The remaining targets are
# the lower-level building blocks it composes.
#
# Usage:
#   make wasm                     # `nv wasm` — build guest + serve host (:8090)
#   make wasm DEMO=hello          # another demo
#   make build-host               # trunk-build the Rust wasm host
#   make serve-host               # trunk serve on :8090 (local nginx owns :8080)
#   make desktop                  # run the demo in a native winit window
#   make web                      # plain-Vite browser fallback (no blitz)
#   make check                    # pnpm typecheck + cargo check

DEMO ?= todomvc

.PHONY: wasm wasm-guest build-host serve-host desktop web check

# One command: build the demo's guest into the SHARED host's assets/guest,
# then serve the host with trunk (blocking). Stale trunk on :8090 is replaced.
wasm:
	cd examples/naivi/$(DEMO) && node ../../../js/naivi-cli/bin/nv.mjs wasm

# Build only the demo's guest JS bundle (then run `make serve-host`).
wasm-guest:
	cd examples/naivi/$(DEMO) && node ../../../js/naivi-cli/bin/nv.mjs wasm --release

# Build the Rust wasm host (the shared cdylib that serves any demo's guest).
build-host:
	cd packages/naivi-wasm && trunk build --release

# Serve the wasm host (rebuilds the Rust wasm on demand). Port 8090: local
# nginx owns 8080. Open http://localhost:8090
serve-host:
	cd packages/naivi-wasm && trunk serve --release --port 8090

# Run the demo in a native winit window (shared rquickjs host).
desktop:
	cd examples/naivi/$(DEMO) && node ../../../js/naivi-cli/bin/nv.mjs desktop

# Serve the demo in a plain browser (standard Vite, no WASM).
web:
	cd examples/naivi/$(DEMO) && node ../../../js/naivi-cli/bin/nv.mjs web

check:
	pnpm -r typecheck
	cargo check --workspace

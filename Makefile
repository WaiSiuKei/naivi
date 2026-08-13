# naivi — Vue Vapor AOT frontend on blitz. Mirrors naive/Makefile: the wasm
# flow is TWO steps: (1) build the demo's guest JS, (2) build/serve the Rust
# host (trunk). The host is the SHARED `packages/naivi-wasm` cdylib — it
# serves whichever demo's guest was built last.
#
# Usage:
#   make wasm-guest              # build the default demo's guest (DEMO=todomvc)
#   make wasm-guest DEMO=hello   # build another demo's guest
#   make build-host              # trunk-build the Rust wasm host
#   make serve-host              # trunk serve on :8090 (local nginx owns :8080)
#   make desktop                 # run the demo in a native winit window
#   make web                     # plain-Vite browser fallback (no blitz)
#   make check                   # pnpm typecheck + cargo check

DEMO ?= todomvc

.PHONY: wasm-guest build-host serve-host desktop web check

# Build the demo's guest JS bundle into the SHARED trunk host's assets/guest.
# The guest alone is not enough — run `make build-host` / `serve-host` after,
# since trunk serves it.
wasm-guest:
	cd examples/naivi/$(DEMO) && node ../../../js/naivi-cli/bin/naivi.mjs wasm --release

# Build the Rust wasm host (the shared cdylib that serves any demo's guest).
build-host:
	cd packages/naivi-wasm && trunk build --release

# Serve the wasm host (rebuilds the Rust wasm on demand). Port 8090: local
# nginx owns 8080. Open http://localhost:8090
serve-host:
	cd packages/naivi-wasm && trunk serve --release --port 8090

# Run the demo in a native winit window (shared rquickjs host).
desktop:
	cd examples/naivi/$(DEMO) && node ../../../js/naivi-cli/bin/naivi.mjs desktop

# Serve the demo in a plain browser (standard Vite, no WASM).
web:
	cd examples/naivi/$(DEMO) && node ../../../js/naivi-cli/bin/naivi.mjs web

check:
	pnpm -r typecheck
	cargo check --workspace

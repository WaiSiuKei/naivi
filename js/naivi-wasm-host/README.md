# @naivi/wasm-host

Prebuilt **naivi WASM host** — the blitz engine compiled to WebAssembly plus
the trunk host page and assets, exactly as `trunk build --release` produces
for `packages/naivi-wasm`.

## Why this package

`nv wasm` needs the WASM engine (`naivi-wasm-*.wasm`) and its host page to
render. In the naivi monorepo the CLI compiles these from source with trunk.
This package ships the **prebuilt** result, so a standalone npm install of
`@naivi/cli` can run `nv wasm` without cloning the monorepo, installing
Rust, or running trunk.

## Usage

It is a dependency of `@naivi/cli` — install that and `nv wasm` just works:

```sh
npm i -D @naivi/cli
npx nv wasm            # serve the WASM host (http://localhost:8090)
npx nv wasm --release  # build the deployable static site into dist/
```

The per-demo guest is injected by the CLI at build time (`@naivi/wasm-host`
deliberately ships **without** a guest).

## Build

```sh
pnpm build   # copies packages/naivi-wasm/dist → ./dist (guest stripped)
```

Requires the monorepo's trunk build output (`packages/naivi-wasm/dist`) to
exist — that is produced in CI by `trunk build --release`.

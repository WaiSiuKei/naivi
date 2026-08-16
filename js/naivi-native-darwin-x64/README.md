# @naivi/native-darwin-x64

Prebuilt **naivi-native** desktop host binary for **macOS x64** (Intel).

## Why this package

`nv desktop` needs the native host (`naivi-native` — winit window + QuickJS
guest + the blitz engine). In the naivi monorepo the CLI compiles it from
source with cargo. This package ships the **prebuilt** binary, so a standalone
npm install of `@naivi/cli` can run `nv desktop` without cloning the
monorepo, installing Rust, or compiling the engine.

## Usage

It is an `optionalDependency` of `@naivi/cli` — npm installs the matching
platform package automatically:

```sh
npm i -D @naivi/cli
npx nv desktop            # run the native window
npx nv desktop --release  # package release/<name>.app
```

## Platform packages

| Package | Platform |
|---|---|
| `@naivi/native-darwin-x64` | macOS x64 |
| (`@naivi/native-darwin-arm64`, …) | (future) |

## Build

```sh
pnpm build   # copies target/release/naivi-native → ./naivi-native
```

Requires the monorepo's `cargo build --release -p naivi-native` output —
produced in CI on a per-platform build matrix.

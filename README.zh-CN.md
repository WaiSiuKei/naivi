[English](./README.md) | **简体中文**

# naivi

**基于 [blitz](https://github.com/DioxusLabs/blitz) 浏览器引擎的 Vue Vapor 前端。**

用 Vue SFC 编写应用，跑在 blitz 真实的渲染栈上 —— stylo CSS、taffy 布局、
parley 文本、vello GPU 光栅化 —— 既可以在浏览器（wasm）中运行，也可以在
原生窗口（winit + QuickJS）中运行，全程不涉及浏览器 DOM。

```
Vue SFC → Vapor AOT (TS) → JS mirror tree → mutation ops → host exports
  (wasm-bindgen on wasm / rquickjs FFI on native) → OpsCore (Rust) →
  DocumentMutator → blitz-dom BaseDocument → blitz-paint → anyrender →
  blitz-shell (winit / trunk)
```

JS mirror tree 与通道无关，Rust `OpsCore` 与引擎无关 —— **一套代码路径驱动两个平台**，
只有宿主适配层不同。这种 "mutation mirror bridge" 把浏览器执行的 DOM 操作以
引擎无关的 op 形式重放一遍。

## 平台支持

naivi 目前支持**三个**平台：

| 平台 | 通道 | 状态 |
|---|---|---|
| **macOS** 桌面 | `nv desktop` — winit 窗口 + QuickJS，Metal/vello | ✅ 支持 |
| **Web**（纯浏览器） | `nv web` — 标准 Vite，无 blitz | ✅ 支持 |
| **WebAssembly** | `nv wasm` — 浏览器内通过 trunk 跑 blitz | ✅ 支持 |

原生桌面宿主（`packages/naivi-native`）目前**仅支持 macOS**：其原生输入和
文本后端是 macOS 专属实现（AppKit/ObjC）。Linux/Windows 桌面以及 iOS/Android
暂不支持。

## 文本渲染与输入

- **字体 — macOS 桌面**：原生 CoreText 文本后端（`packages/blitz-macos-text`
  + naivi 维护的 parley fork）。使用系统字体，CJK 回退到苹方（PingFang SC）。
- **字体 — wasm**：Google Fonts 分片**动态加载**——宿主按需获取字体 CSS 并调度
  unicode-range 分片（Noto Sans / Noto Sans SC / Noto Color Emoji / Noto Sans
  Hebrew / Noto Sans Arabic），带字重回退与懒加载的 RTL 样式表；DejaVu Sans
  作为内置回退字体。
- **输入 — macOS 桌面**：真正的原生文本输入——AppKit `NSTextField` /
  `NSTextView`（原生 IME、光标/选区、padding 与字体对齐）。回车保持编辑会话
  （隐式表单提交）；失焦 / 焦点移动 / Tab 结束会话。
- **输入 — web（`nv web`）**：使用浏览器自身的 `<input>`（无 blitz）。
- **输入 — wasm**：在 blitz canvas 上叠加 HTML `<input>` / `<textarea>`
  （浏览器原生 IME + CJK 组合输入）；会话期间 canvas 跳过镜像文本的绘制，
  失焦时提交最终值。

## 快速开始

前置依赖：Node.js ≥ 24、pnpm、Rust stable（wasm 需要 `wasm32-unknown-unknown`）、
以及 wasm 宿主的 `trunk`。

```sh
pnpm install        # 在仓库根目录（pnpm workspace）
pnpm -r typecheck   # 整个 workspace
pnpm -r test
```

### Web（纯浏览器，无 blitz）

```sh
cd examples/naivi/counter
npx nv web
# `--release` 构建纯静态站点到 dist/
```

### Wasm（浏览器内通过 trunk 跑 blitz）

```sh
cd examples/naivi/counter
npx nv wasm   # 构建 guest 并启动宿主 → http://localhost:8090
# `--release` 构建可部署的 wasm 站点（引擎 + guest）到 dist/
```

### 原生（winit 窗口内通过 QuickJS 跑 blitz）

```sh
cd examples/naivi/counter
npx nv desktop
# `--release` 打包 macOS .app 到 release/<name>.app（name 来自 naivi.config.ts）
```

桌面 `main` 入口（`naivi.config.ts` 的 `main`，如 `app/main.ts`）是 Electron
风格的主进程：`app.whenReady()` + `NaiveWindow` 创建窗口并加载 `index.html`。

## npm 包

| 包 | 说明 |
|---|---|
| `@naivi/cli` | `nv` CLI（web / wasm / desktop） |
| `@naivi/compiler` | AOT 编译器 — Vue SFC → RenderTree IR + Style IR |
| `@naivi/protocol` | 桥接协议的唯一事实来源 |
| `@naivi/runtime` | Vue Vapor 运行时适配器（`@naivi/runtime/vue-vapor`、`/desktop-main` 等） |

## 基于 blitz

本仓库是 [DioxusLabs/blitz](https://github.com/DioxusLabs/blitz) 的 fork，
并在其上增加了 naivi 前端。naivi 保持与上游可合并；架构与命令用法见
`docs/naivi.md`，实施计划见 `docs/plans/`。

## 许可证

MIT OR Apache-2.0（与 blitz 一致）。

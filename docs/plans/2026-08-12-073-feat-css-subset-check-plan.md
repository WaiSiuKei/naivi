---
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
title: Naivi CSS Subset Check - Plan
date: 2026-08-12
---

# Naivi CSS Subset Check - Plan

## Goal Capsule

- **Objective:** 在 `naivi wasm` 与 `naivi desktop` 构建流程内加入 CSS 子集检测门槛——用 kiln 的规则集静态扫描编译后的最终作者 CSS 与 Vue 模板工具类，命中任一不支持项即打印报告并以非零退出码失败构建，保证产物不含引擎不支持的关键 CSS。
- **Product authority:** naivi-cli 构建流程（wasm/desktop 两通道）；范围已由用户确认。
- **Open blockers:** 无。规则集以 kiln 为起点；若现有 demo 或 Tailwind 编译产物出现误报，需按引擎实际微调规则表（见 OQ2）。

## Product Contract

### Summary

`naivi wasm --release` 与 `naivi desktop` 构建时，在作者 CSS 编译完成之后静态检查最终 CSS 与 Vue 模板工具类，套用 kiln 的 CSS 子集规则（code + hint），命中即打印报告并以非零退出码失败。严格失败、无豁免、无独立命令。

### Problem Frame

naivi 运行在 blitz 引擎（stylo + taffy + parley）上，与 kiln 同源，因此有一批引擎不支持或部分支持的 CSS 特性（float、`position: sticky/fixed`、`:has()`、`@container`、subgrid、`text-overflow: ellipsis`、`display: table`、3D transform、`backdrop-filter`、`mix-blend-mode`、`writing-mode`、`contain`、`::backdrop`、`@scope`）。这些缺口目前只在运行时由 stylo 以 `Unsupported property` / `Invalid property value` 日志暴露（`packages/blitz-dom/src/node/element.rs:609,622`），开发者构建时无从得知，产物可能静默携带失效的样式。目标是把"产物承诺"前移到构建期。

### Requirements

**检测输入与规则**

- R1. `naivi wasm --release` 与 `naivi desktop` 在作者 CSS 编译完成（`compileIfNeeded` 产出 `node_modules/.naive/styles.css`）之后执行 CSS 子集检测；检测内嵌于现有构建命令，不新增独立子命令。
- R2. 检测对象包含两部分：编译后的最终作者 CSS（含 Tailwind 编译产物，即引擎实际解析的内容），以及 demo 的 Vue 模板（`.vue`）中出现的工具类。
- R3. 规则集复用 kiln 的规则表（`property` / `selector` / `at-rule` 三类，每条含稳定 code 与 hint，如 KC1101 float、KC1201 sticky、KC1002 `:has()`、KC1401 `@container`）作为起点；与引擎实际行为不符或产生误报时，可在规则表中按需微调。
- R4. 模板扫描以 `.vue` 模板（仅 `.vue`，不含 `.tsx` / `.ts`）的 `class` 与 `:class` 字符串字面量为来源定位，把命中映射到组件文件与行列（报告中的 origin），而非仅指向编译后的 CSS。

**构建门槛**

- R5. 命中任一不支持项时，构建打印完整报告并以非零退出码失败；严格失败，不提供豁免或 allowlist 机制。
- R6. 检测覆盖 wasm 与 desktop 两个构建通道；`naivi web`（dev server）不在检测范围内。

**报告**

- R7. 报告沿用 kiln 的形态：声明总数、支持数、支持百分比，以及每条命中（次数、code、hint、文件:行:列、来源组件或工具类）。

**验收**

- R8. 现有 demo（counter / hello / todomvc）的 wasm 与 desktop 构建必须零命中通过检测。

### Acceptance Examples

- AE1. 命中即失败并给出定位（Covers R5、R7）：当 demo 的模板或 CSS 中出现 `float-left` 时，`naivi wasm --release` 打印含 code（KC1101）、hint、文件:行:列与来源组件的报告，并以非零退出码退出。
- AE2. 工具类来源映射（Covers R2、R4）：当模板 `:class="'fixed'"` 且编译 CSS 含对应声明（如 `.fixed{position:fixed}`）触发 KC1202 时，报告把命中定位到该 `.vue` 文件的行列，而非编译后 CSS 的行；模板类本身不构成独立失败源（KTD2）。
- AE3. 无命中通过（Covers R1、R6、R8）：counter / hello / todomvc 现状分别运行 `naivi wasm --release` 与 `naivi desktop`，全部零命中、构建成功。

### Scope Boundaries

- 不含独立 `naivi check` 子命令、`naivi web` 检测、运行时或页面内提示。
- 不含自定义/可扩展规则集 API、allowlist / 豁免机制。
- 不含引擎修复或 stylo 运行时日志改造。
- 不含通用 CSS 质量检查（格式化、lint、跨浏览器兼容矩阵）。

### Key Decisions

- KD1. 形态为构建时自动检测，内嵌于 wasm/desktop 构建，而非独立命令。(session-settled: user-directed — chosen over 独立 `naivi check` 子命令: 用户明确要"构建时自动警告")
- KD2. 检测输入为编译后最终 CSS + 模板工具类，而非仅编译 CSS 或仅源码。(session-settled: user-directed — chosen over 仅编译 CSS / 仅源码: 用户选"最全面、kiln 式")
- KD3. 失败语义为命中即失败、严格无豁免。(session-settled: user-directed — chosen over 仅警告 / 警告 + strict 模式: 用户要产物承诺门槛)
- KD4. 命令覆盖为 wasm + desktop 两个构建通道。(session-settled: user-directed — chosen over 含 web / 仅 wasm: 用户指定两通道)
- KD5. 规则集复用 kiln 规则表作为起点，可按引擎实际微调。(session-settled: user-directed — chosen over 从零定制/重新定义: 同引擎、缺口一致，且严格失败下需要微调通道防误报)
- KD6. 模板扫描的定位是来源映射：编译 CSS 已包含被用到的工具类，模板扫描的价值是把命中映射回开发者写的组件。(session-settled: user-approved — chosen over 不做模板扫描: 用户在综合确认时同意该定位)

### Outstanding Questions

- OQ1. 检测实现载体——TS 侧用已有 `postcss` 依赖，还是小型 Rust 二进制复用 workspace 的 `cssparser` / `selectors` 依赖？分类：Deferred to Planning（已由 KTD1 决定：TS + postcss）。
- OQ2. Tailwind 编译产物中可能出现的合成声明（如 `translateZ(0)`）是否触发 3D 规则导致误报？需要对照实际产物校准规则表。分类：Deferred to Planning（已由 KTD3 决定：3d 规则仅作用于作者 CSS；U4 校准）。

---

## Planning Contract

> **Product Contract preservation:** Product Contract unchanged（R1–R8、AE1–AE3、Scope Boundaries、Key Decisions 均保留原意与 ID；KD6 的模板归因语义由 KTD2 落到实现层）。OQ1/OQ2 由 KTD1/KTD3 决定，转为 Deferred to Planning。

### Key Technical Decisions

- KTD1. 实现载体为 TS，复用已安装未使用的 `postcss`（8.5.26）解析编译 CSS，不新增 Rust 二进制。naivi-cli 是纯 TS 工具链（`js/naivi-cli` 无 Cargo.toml），`postcss` / `postcss-value-parser` 已在 `js/naivi-cli/package.json` 且已安装；kiln 用 Rust cssparser 是因为 kiln 本身是 Rust 应用。(Governs R1、R3、R7)
- KTD2. 检测判定源是编译后的最终作者 CSS（引擎实际解析的内容）；`.vue` 模板扫描只做**归因**（把命中映射到来源组件与行列），不构成独立失败源。动态构造的类（`classList.add`、对象/三元绑定）无法从模板静态捕获，由编译 CSS 兜底。(Governs R2、R4)
- KTD3. 3D transform 规则（KC1320：`transform`/`translate` 含 `3d` 或 `perspective`）只作用于作者亲手写的 CSS（SFC `<style>` / 独立 CSS 文件），不作用于 Tailwind 编译产物中的 transform 声明。(Governs R3)
  - **载体**：U1 的扫描器接受两个输入——合并编译后的最终作者 CSS（含 Tailwind 产物，套全部规则）与原始收集的作者亲手写的 CSS（仅 3d 规则）；原始作者 CSS 复用 `compileIfNeeded` 的收集逻辑（`findCSSFiles` + `extractSfcStyles`，见 `js/naivi-cli/src/compile.ts`）。
  - **冲突说明（doc-review F-F1，anchor 100）**：kiln 规则文本为 `value.contains("3d") || value.contains("perspective")`，`translateZ(0)` 不含任一子串，因此不会触发 KC1320——该豁免原动机（Tailwind 产物误报）实际上不存在。保留该已确认决策（作者亲手写的 CSS 才报 3d），实现按上述载体进行，U4 对照实际产物校准并记录结论。
- KTD4. 报告语义：命中按 `(code, declaration)` 去重；支持率按去重后的声明计数计算；`styles.css` 缺失或为空时跳过并打印 dim 提示，不失败；无法解析的 CSS 片段记为警告而非命中。(Governs R7)
- KTD5. 失败传播：命中任一不支持项时打印完整报告并 `throw`，由 `main()` 的 catch-all 统一 `process.exit(1)`（`js/naivi-cli/src/cli.ts` 既有失败路径）；desktop 路径中 `execFileSync` 前的任一步抛错都会在窗口启动前中止。(Governs R5、R6)

### Assumptions

- A1. 模板扫描覆盖 `.vue` 的静态 `class` 字符串与 `:class` 字符串字面量；动态构造的类不独立检出（KTD2，编译 CSS 兜底）。
- A2. `naivi wasm` 仅 `--release` 检测；dev server（不带 `--release`）与 `naivi web` 不检测（R6 既有）。
- A3. 现有 demo 零命中是硬验收（R8）；若 Tailwind 产物触发误报，先微调规则表（KTD3）而非放宽严格失败。

### Sequencing

U1 → U2 → U3 → U4。U3 依赖 U1/U2 的 `runCssSubsetCheck` 入口；U4 是验收校准，依赖全部前置单元。

## Implementation Units

### U1. 规则表与编译 CSS 扫描器

- **Goal:** 建立可复用的 CSS 子集检测核心：kiln 规则表 + 基于 postcss 的编译 CSS 扫描，产出带 code/hint/行列/来源的命中。
- **Requirements:** R3、R7
- **Dependencies:** 无
- **Files:**
  - `js/naivi-cli/src/check.ts`（新建：规则表 + 扫描核心 + 报告渲染）
  - `js/naivi-cli/tests/check.test.ts`（新建：核心单测）
- **Approach:**
  1. 在 `check.ts` 移植 kiln 的规则表：`property_rule`（float/backdrop-filter/mix-blend-mode/writing-mode/contain/sticky/fixed/ellipsis/table/subgrid/3d）、`selector_rule`（`:has()`、整选择器 `::backdrop`）、`at_rule_rule`（`@container`、`@scope`），每条含稳定 code 与 hint。
  2. 用 `postcss.parse` 遍历编译 CSS：声明（`walkDecls`）、规则/选择器、at-rule；记录 `node.source.start.line/column` 与父选择器；声明按 `property: value` 匹配 `property_rule`。
  3. 3d 规则按 KTD3 区分来源：扫描器接受两个输入——合并编译后的最终作者 CSS（套全部规则）与原始收集的作者亲手写的 CSS（仅 3d 规则，KTD3 载体）。原始作者 CSS 由调用方用 `compileIfNeeded` 的收集逻辑（`findCSSFiles` + `extractSfcStyles`，`compile.ts`）重新收集。
  4. 报告渲染沿用 kiln 形态：`declarations` / `supported` / `percent(%)` + 每条 `×count code hint 文件:行:列 origin`；按 `(code, declaration)` 去重（KTD4）。
- **Patterns to follow:** `/Users/yq/private-repos/kiln/src/check.rs` 的规则表与报告形态（本地参考）；`js/naivi-cli/src/compile.ts` 的 `C` ANSI 日志约定。
- **Test scenarios:**
  - 命中 `float: left` → 报 KC1101，含行列。
  - 命中 `position: sticky` → KC1201；`position: fixed` → KC1202。
  - 选择器含 `:has(` → KC1002；整选择器 `::backdrop` → KC1003，但 `*, ::before, ::after, ::backdrop` 不报（非整选择器）。
  - `@container` → KC1401；`@scope` → KC1402。
  - 3d 规则：仅对第二输入（作者亲手写的 CSS）扫描——其中 `perspective`/含 `3d` 的 transform 报 KC1320；`translateZ(0)` 按 kiln 规则文本（`value.contains("3d") || value.contains("perspective")`）本身不触发，无需来源标记（KTD3 载体）。
  - 重复命中同一 `(code, declaration)` 只计一次；`percent()` 按去重后计数。
  - 空 CSS → 0 命中、percent 100；畸形/不可解析片段 → 警告不失败（KTD4）。
- **Verification:** 单测全绿；`pnpm -r typecheck` 通过；手工对一段含 float/sticky/:has 的 CSS 运行扫描函数，报告含正确 code/hint/行列。

### U2. 模板工具类归因与组合入口

- **Goal:** 在 `check.ts` 增加 `.vue` 模板扫描（归因）与 `runCssSubsetCheck(cwd)` 组合入口：读编译 CSS + 扫模板，命中即打印报告并抛出。
- **Requirements:** R2、R4、R5、R7
- **Dependencies:** U1
- **Files:**
  - `js/naivi-cli/src/check.ts`（扩展）
  - `js/naivi-cli/tests/check.test.ts`（扩展）
- **Approach:**
  1. 复用 `compile.ts` 的 `findVueFiles`（需将其导出，当前未导出）遍历 `.vue`；用 `@vue/compiler-sfc`（已是 `js/naivi-cli` 依赖）的 `parseSfc` 取 `descriptor.template.content`。
  2. 从模板提取静态 `class` 属性与 `:class` 字符串字面量；维护一个小型工具类→规则映射（`float-left/right`→KC1101、`sticky`→KC1201、`fixed`→KC1202、`table`→KC1102、`subgrid`→KC1103、`has-[...]`→KC1002、`container-[...]`→KC1401 等）；无法映射的字符串不构成命中（KTD2）。
  3. `runCssSubsetCheck(cwd)`：读取 `node_modules/.naive/styles.css`（缺失/空则 dim 提示跳过，KTD4），扫描 CSS；把 CSS 命中的工具类选择器（如 `.float-left`）与模板里出现的类匹配，命中时 origin 指向组件文件与行列，否则指向编译 CSS 位置；模板里映射到的工具类仅作为归因键（对应编译 CSS 的命中），不独立构成命中（KTD2）；打印报告，命中即 `throw`（KTD5）。
  4. 报告中的 `declarations`/`percent` 以编译 CSS 扫描为准（KTD4 去重后）。
- **Patterns to follow:** `compile.ts` 的 `findVueFiles` / `parseSfc` 用法；`js/naivi-compiler/src/sfc-parser.ts` 的 `descriptor.template` 访问先例；kiln `check.rs` 的 origin（utility）报告。
- **Test scenarios:**
  - 模板含 `class="float-left"` 且编译 CSS 含 `.float-left{float:left}` → 命中 KC1101，origin = 组件文件:行。
  - 模板 `:class="'fixed'"` 且编译 CSS 含 `.fixed{position:fixed}` → 命中 KC1202，origin 指向该 `.vue` 行列（Covers AE2）。
  - 模板含无法映射的类（如 `classList.add` 场景、任意业务类名）→ 不构成命中（KTD2）。
  - 无 `.vue` 文件 / 空模板 → 跳过模板归因，仅编译 CSS 扫描。
  - `styles.css` 缺失 → dim 提示跳过，不失败（KTD4）。
  - 命中时 `runCssSubsetCheck` 抛出，报告含 count/code/hint/行列/origin（Covers AE1）。
- **Verification:** 单测全绿；对一个含 `float-left` 的 fixture demo 运行 `runCssSubsetCheck`，抛出且报告指向组件文件行列。

### U3. 接入 wasm 与 desktop 构建门槛

- **Goal:** 在 `naivi wasm --release` 与 `naivi desktop` 构建流程中调用 `runCssSubsetCheck`，命中即非零退出，且不改变无命中时的行为。
- **Requirements:** R1、R5、R6
- **Dependencies:** U1、U2
- **Files:**
  - `js/naivi-cli/src/cli.ts`（`buildWasmSite`）
  - `js/naivi-cli/src/desktop.ts`（`cmdDesktopImpl`）
- **Approach:**
  1. `buildWasmSite`：把 `compileIfNeeded` 移到 Vite `build()` 之前（`cli.ts` 现顺序是 build → compileIfNeeded），在 `compileIfNeeded` 之后立即调用 `runCssSubsetCheck(cwd)`，命中即失败，避免浪费 Vite 构建；失败经 `main().catch` → `process.exit(1)`（KTD5）。
  2. `cmdDesktopImpl`：在 `compileIfNeeded` 之后、`buildDesktopMainBundle` / `buildDesktopBundle` 之前调用 `runCssSubsetCheck(cwd)`，命中即在窗口启动前中止。
  3. 无命中时打印一行 dim 确认（如 `CSS subset check: 100% supported`），不改变现有构建输出与退出码。
- **Patterns to follow:** `cli.ts` 的 `validateHostStyles` 预检先例；`cli.ts:95-96` 与 `desktop.ts:184` 的 `compileIfNeeded` 调用点；`cli.ts:176` 的 `main().catch(process.exit(1))`。
- **Test scenarios:**
  - wasm 集成：含命中 CSS 的 fixture demo 运行 `naivi wasm --release` → 非零退出、报告输出、不产出 guest（Covers AE1）。
  - desktop 集成：同 fixture 运行 `naivi desktop` → 非零退出、窗口不启动。
  - 干净 demo（无命中）→ 退出 0、构建照常完成（Covers AE3）。
- **Verification:** 用临时 fixture 与现有 demo 分别跑两个命令验证退出码；`pnpm -r typecheck` 绿。

### U4. Demo 校准与验收

- **Goal:** 对 counter / hello / todomvc 运行 wasm 与 desktop 构建，确认零命中通过（R8）；如 Tailwind 编译产物触发规则，按 KTD3 校准规则表并记录。
- **Requirements:** R8；落实 OQ2
- **Dependencies:** U1、U2、U3
- **Files:**
  - `js/naivi-cli/src/check.ts`（仅当需要校准规则表时）
  - 不改 demo CSS（除非确认 demo 自身确实使用了不支持特性）
- **Approach:**
  1. 对三个 demo 分别运行 `naivi wasm --release` 与 `naivi desktop`，收集零命中结果。
  2. 若 todomvc 的 Tailwind 编译产物（preflight `*, ::before, ::after, ::backdrop`、`translateZ`/transform 声明等）触发命中，核对是否属于 KTD3 的"作者 CSS 之外"而应豁免，必要时微调规则表或扫描来源标记。
  3. 记录校准结论到规则表注释（哪些规则、为何微调），作为引擎缺口的事实基线。
- **Patterns to follow:** 三个 demo 的 `naive.config.ts`（`main` 与 `pages` 配置）；`examples/naivi/todomvc/src/assets/main.css` 的 Tailwind 入口。
- **Test scenarios:**
  - counter / hello / todomvc 的 wasm `--release` 构建全部零命中、退出 0（Covers AE3）。
  - 三个 demo 的 `naivi desktop` 构建全部零命中、退出 0（Covers AE3）。
  - 若校准了规则表：现有单测仍全绿，且新增一条"Tailwind 产物豁免"断言。
- **Verification:** 六个命令（3 demo × 2 命令）零命中退出 0；校准记录写入规则表注释；`pnpm -r typecheck/test` 全绿。

## Verification Contract

- `pnpm -r typecheck` — 全部 TS 包类型检查通过（含新 `check.ts`）。
- `pnpm -r test` — naivi-cli 新增单测（`js/naivi-cli/tests/check.test.ts`）全绿；naivi-runtime / naivi-compiler 既有测试不回归。
- `cargo check --workspace` — 纯 TS 改动，不应受影响（回归确认）。
- 门槛验收：counter / hello / todomvc 各跑 `naivi wasm --release` 与 `naivi desktop`，均零命中退出 0（R8 / AE3）。
- 反例验收：临时 fixture（含 `float-left` / `position: sticky` / `:has()` 的模板或 CSS）跑两个命令，均非零退出且报告含 code / hint / 行列 / origin（AE1）。

## Definition of Done

- U1–U4 全部完成：规则表 + 编译 CSS 扫描 + 模板归因 + `runCssSubsetCheck` + wasm/desktop 接入 + demo 校准。
- `naivi wasm --release` 与 `naivi desktop` 对命中 CSS 严格失败（非零退出、完整报告），无豁免。
- 三个现有 demo 零命中通过两个构建通道。
- `pnpm -r typecheck/test` 与 `cargo check --workspace` 全绿；新增单测覆盖规则命中、归因、去重、边界（空/畸形 CSS）与 3d 规则来源区分。

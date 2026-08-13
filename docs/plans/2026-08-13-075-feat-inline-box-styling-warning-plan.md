---
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
title: Inline Box Styling Unsupported Warning - Plan
date: 2026-08-13
---

# Inline Box Styling Unsupported Warning - Plan

## Goal Capsule

- **Objective:** 为 blitz 引擎加一个开发者可见的警告：当非原子行内元素（`<a>`/`<span>`，含 `display:inline` 的任意标签）带有 blitz 暂不渲染的 box 样式（margin/padding/border）时，排版构造期通过 tracing 发出警告并提示 workaround。本 plan 不包含任何布局/绘制修复——引擎级修复完全等待上游 PR 530。
- **Product authority:** blitz 行内排版构造（`packages/blitz-dom/src/layout/construct.rs`）；上游引擎修复与 todomvc demo 改动不在本次范围。
- **Open blockers:** 无。
- **Execution profile:** 代码实现，单点改动（构造期检测 + 去重 + 警告）。

## Product Contract

_Product Contract preservation: changed: R5 — dedupe granularity moved from per-node to per-document lifetime (user-directed), with AE5, KD3-adjacent KTD1 and unit scenarios updated in place._

### Summary

在非原子行内元素被构造成文本 span 的位置，检测其 computed box 样式；对会被 blitz 静默丢弃的样式（非零 margin/padding、可见 border）发一条按节点去重的 tracing 警告，并提示把 box 样式移到块级包裹元素。引擎修复等上游 DioxusLabs/blitz#530（已覆盖间距预留，不含绘制）。

### Problem Frame

todomvc 的筛选按钮暴露出：inline `<a>` 上的 border/margin 在 wasm 里不渲染、与 web 不一致。根因是 blitz 把非原子行内元素当纯文本 span 处理，border/margin/padding 既不参与布局也不绘制（背景色与下划线/删除线除外）。上游 PR 530（draft，2026-08-13 核实）已实现间距预留半截、明确不含绘制半截，但合入时间不可控。等待期间的主要痛点是差异静默——开发者不知道页面为什么和浏览器不一致。本次把差异变成可见警告。

### Key Decisions

- KD1. 纯等待 + 本地警告。`(session-settled: user-directed — chosen over 本地完整修复 / 等上游后本地补绘制: 上游 PR 530 已覆盖间距预留，不重复造轮子)` Governs R1–R6。
- KD2. 引擎侧构造期检测，不做 CLI 静态检测。`(session-settled: user-directed — chosen over CLI/编译期检测: class 样式无法在编译期绑定到具体元素)` Governs R1, R2。
- KD3. 触发判定按 computed display（非原子行内），不按标签名。`(session-settled: user-directed — chosen over 标签名判定: display:inline 的 div 与 span 浏览器语义一致，应同样警告)` Governs R2, R3。

### Requirements

- R1. 对进入非原子行内构造路径的元素（computed display 为 inline flow，且非 replaced/input/textarea/button），检查其 computed style。
- R2. 触发条件：margin 或 padding 任一边非零，或 border 可见（border-style 任一边非 none 且对应宽度大于 0 且颜色非 transparent）。`border: 1px solid transparent`、`border-style: none` 不触发。
- R3. `display: inline-block`（原子行内盒路径）不触发；仅 background-color 不触发（blitz 已支持行内背景渲染）。
- R4. 警告经 `tracing::warn` 输出，通过既有日志设施可达：wasm 走浏览器 console（含运行时调试转发开关），desktop 走 stderr。
- R5. 每个文档在文档生命周期内至多警告一次（程序运行内每页一次），不按节点重复。
- R6. 警告文案包含"inline box styling（margin/padding/border）尚未支持"及 workaround 提示：把 box 样式移到块级包裹元素。

### Key Flows

- F1. 构造期检测
  - **Trigger:** 元素进入非原子行内 span 构造分支。
  - **Steps:** 读取 computed style → 按 R2 判定 → 命中且该节点未警告过 → 发 tracing 警告并标记节点。
  - **Covers:** R1, R2, R5
  - **Covered by:** AE1–AE5

### Acceptance Examples

- AE1. Given `div { display:inline }` 带 `padding: 4px`，Then 触发警告（与 span 同路径，按 computed display 判定）。Covers R3。
- AE2. Given 元素 `display:inline-block` 带 `margin: 3px`，Then 不触发。Covers R3。
- AE3. Given inline 元素仅 `background-color`，Then 不触发。Covers R3。
- AE4. Given inline 元素 `border: 1px solid transparent`，Then 不触发。Covers R2。
- AE5. Given 一个文档内有多个带 box 样式的行内元素，Then 整个文档生命周期仅一条警告。Covers R5。

### Scope Boundaries

- Deferred for later: 间距预留与 border 绘制的引擎修复——等待并跟踪上游 DioxusLabs/blitz#530（draft，2026-08-13 未合并；该 PR 明确不含绘制）。
- Deferred for later: 上游合入后的片段 border/背景绘制（本地补或贡献上游）——待上游合入后另行评估。
- Deferred for later: todomvc 的 `<li>` workaround 回退——保持现状不回退。

### How This Work Fits Together

<!-- ce-section: work-relationships -->

本 plan 拥有「开发者可见警告」这一件工作。更宽议题「行内元素 box 样式引擎级修复」当前的理解如下，仅为背景、非承诺路线图：

- 间距预留（水平 margin/padding/border 参与 inline space）
  - Depends on 上游 PR 530 合入并 sync 到本仓库；不在本 plan。
- 片段 border/背景绘制
  - Can proceed independently of 本 plan；待上游合入后评估（本地实现或贡献上游）。
- todomvc 还原 inline `<a>` 写法
  - Depends on 上述两件完成；本 plan 期间保持 `<li>` workaround。
- 本 plan 之前探讨的引擎修复方向（装饰 span / 原子盒提升）
  - Still to decide；已被上游 PR 530 的 no-fork strut 机制取代，若将来本地做修复应参考该 PR。

### Dependencies / Assumptions

- 上游 DioxusLabs/blitz#530 为 draft（2026-08-13 核实），合入时间不可控；本仓库 fork 当时距 upstream/main 仅 2 个 commit。
- 假设：警告仅覆盖当前被静默丢弃的属性集合（margin/padding/border）。若引擎后续支持某属性，R2 相应收窄。
- tracing 日志设施已存在（tracing_wasm + `js/naivi-runtime` 的调试转发开关）。

### Outstanding Questions

- Deferred to Planning: 警告文案的具体措辞与 tracing target 命名（去重标记位置已由 KTD1 决定）。

### Sources / Research

- `packages/blitz-dom/src/layout/construct.rs` — 行内 span 构造分支（~1096-1192）与原子行内盒分支（~1110-1125）
- `packages/blitz-dom/src/stylo_to_parley.rs` — span 仅映射字体/文本属性，无 border/margin/padding
- `packages/blitz-paint/src/text.rs` — 行内仅绘制背景与文字装饰，无 border
- `packages/blitz-dom/src/document.rs` — `inline_fragment_rects` 片段矩形基础设施（后续绘制工作的复用点）
- https://github.com/DioxusLabs/blitz/pull/530 — 间距预留 PR（draft；合成零高 edge strut 机制，明确不含绘制）

## Planning Contract

### Key Technical Decisions

- KTD1. 去重状态放 `BaseDocument` 的文档级 bool（`inline_box_styling_warned`），一次触发后整个文档不再警告。`(session-settled: user-directed — chosen over 按节点去重（ElementData bool）: 用户要求每个程序运行只打印一次，避免多节点刷屏)` Governs R5, U1。
- KTD2. 检测读构造分支已有的 `node.primary_styles()`（stylo `ComputedValues`，转 parley 之前——parley 子集不含 box 属性），按 R2 判定；非零百分比按触发处理（构造期无父宽度可解析，警告宁多勿漏）。Governs U1。
- KTD3. 测试不新增 tracing 断言依赖：blitz-tests 通过观测去重标记验证检测与去重逻辑；`warn!` 发射沿用 `construct.rs:411-419` 的 `#[cfg(feature = "tracing")]` + `#[cfg(not(feature = "tracing"))] let _ = ...;` 门控模式，不做断言（scope 确认时用户拍板）。Governs U2。

### Assumptions

- 构造分支处 `primary_styles()` 可用（该分支已在读取同一值，`construct.rs` ~1136-1138）。
- 警告只在构造路径触发；重复构造受 KTD1 的去重标记保护，符合 R5。

## Implementation Units

### U1. Inline box styling detection + warning + dedupe

- **Goal:** 在非原子行内 span 构造分支检测未支持的 box 样式，发出去重后的 tracing 警告。
- **Requirements:** R1, R2, R3, R4, R5, R6
- **Dependencies:** 无
- **Files:** `packages/blitz-dom/src/layout/construct.rs`, `packages/blitz-dom/src/document.rs`
- **Approach:**
  1. 在 `construct.rs` 的 `(DisplayOutside::Inline, DisplayInside::Flow)` else 分支（非 replaced/input/textarea/button/br），于读取 `primary_styles()` 处按 R2 判定触发条件。
  2. 命中且 KTD1 的文档级标记未置位时：置 `BaseDocument::inline_box_styling_warned`，发 gated `tracing::warn!`（结构化字段带 node id；消息满足 R6）。
  3. 警告调用复用 `construct.rs:411-419` 的门控与 `#[cfg(not(feature = "tracing"))]` 兜底模式。
- **Patterns to follow:** `construct.rs:411-419`（gated warn）；`document.rs` 既有文档级状态字段先例。
- **Test scenarios**（由 U2 落成用例）：
  - Covers AE1. inline `<a>` 带非零 padding → 文档标记置位。
  - Covers AE4. inline `<a>` 带可见 border → 文档标记置位。
  - Covers AE2. `display:inline-block` 带 margin → 标记不置位。
  - Covers AE3. 仅 background-color → 标记不置位。
  - Covers AE4. `border: 1px solid transparent` → 标记不置位。
  - Covers AE5. 文档内多个触发元素 → 标记置位且仅一次警告（文档级去重）。
- **Verification:** U2 用例全绿；`cargo check --workspace` 通过。

### U2. Regression tests in blitz-tests

- **Goal:** 用 blitz-tests 回归用例锁定 U1 的检测与去重行为。
- **Requirements:** R1, R2, R3, R5
- **Dependencies:** U1
- **Files:** `tests/blitz-tests/tests/inline_box_warning.rs`
- **Approach:**
  1. 仿 `tests/blitz-tests/tests/inline_fragment_rects.rs` 的 `HtmlDocument` + 内联 `<style>` + `resolve(0.0)` 模式构造文档。
  2. 经 `doc.base()` 访问 `BaseDocument`，观测文档级标记验证 U1 的场景（每个场景一个 `#[test]`）。
- **Patterns to follow:** `tests/blitz-tests/tests/inline_fragment_rects.rs`
- **Test scenarios:** U1 的六个场景逐一落成用例；另加一个多元素页面冒烟（触发与不触发元素并存）。
- **Verification:** `cargo test -p blitz-tests inline_box_warning` 全绿；既有 blitz-tests 与 blitz-dom 测试无回归。

## Verification Contract

- `cargo test -p blitz-tests inline_box_warning`（新增用例）
- `cargo test -p blitz-dom`（构造相关既有测试不回归）
- `cargo check --workspace` + `cargo fmt --all -- --check`
- 端到端冒烟（手动）：带 inline box 样式的测试页在 wasm console（或调试转发）与 desktop stderr 各出现一次警告；todomvc（`<li>` workaround）不产生新警告。

## Definition of Done

- U1 完成：检测、去重、警告落地，R1–R6 全部满足。
- U2 完成：新增用例全绿，既有 blitz-tests / blitz-dom 测试无回归。
- 全局：`cargo check --workspace` 通过；端到端冒烟满足 Verification Contract 最后一条。

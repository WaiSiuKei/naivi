# wasm font slicing — code-review fix handoff (2026-08-14)

Branch: `feat/wasm-font-slicing` (HEAD `ee3276500`, pushed to origin)
Plan: `docs/plans/2026-08-14-1512-feat-wasm-font-slicing-plan.md`

## Status

ce-code-review (mode:agent) completed; verdict **Ready with fixes**. Fix step
(lfg Step 5) **COMPLETE**: all 13 actionable findings applied and committed
(`f39ca560` + follow-up), all tests green. This file is the residual record.

Review run artifacts: `/tmp/ce-code-review/20260814-fonts/` (`review.json`,
per-persona artifacts, `mechanical-findings.json`).

## Review summary

8 reviewers (correctness, project-standards, testing, maintainability,
performance, reliability, api-contract, adversarial-in-process) + 1 validator
batch (15 findings: 13 validated true, 2 false). Cross-model adversarial pass
NOT run (host serving family unattestable in this harness).

- 13 actionable findings (downstream-resolver)
- 2 report-only: `#10` font_version (settled_conflict vs KTD3/R8, kept),
  `#11` split document.rs (~340 font-slice lines) - human decision
- 2 validator-rejected: `#18` (doc test drains via resolve->handle_messages,
  fine), `#21` (DRY preference for wOFF magic sniff)

Actionable findings (stable #) - apply status:

| # | Severity | Finding | Fix applied |
|---|----------|---------|-------------|
| 1 | P1 | Settle gate never closes (per-frame full-document scan) | DONE - `font_scan_needed` flag + gate on Loading/missing |
| 2 | P1 | Slice arrival invalidates element, not inline root (nested inline never re-shapes) | DONE - `invalidate_text_nodes` walks `inline_root_ancestor()` |
| 3 | P2 | Corrupt/non-font bytes marked Loaded; register result unchecked | DONE - `register_font_with_override -> usize`; `added==0 -> fail()`; `FontLoadState::fail` now also unloads |
| 4 | P2 | Wasm fetch no timeout (hung slice pins pre-scan forever) | DONE - AbortController + 30s `fetch_timeout` race in WasmNetProvider + fetch_text |
| 5 | P2 | COLR `Pixmap::new().expect` panic + 256MiB single glyph | DONE - `MAX_GLYPH_PIXELS` 64Mi->16Mi px; `new`/`push_layer`/mask alloc-fail -> fallback/skip |
| 6 | P2 | R7 author-font gate branch untested | DONE - `installed_font_coverage_only_suppresses_when_text_is_covered` (PASSES) |
| 7 | P2 | AE6 targeted re-layout never asserted | DONE - `slice_arrival_damages_only_waiting_inline_root` (PASSES): divs forced `display: block` + assert on non-empty damage (see below) |
| 8 | P2 | Coverage miss test tautology | DONE - probe-count bound `(2..=4)` (PASSES) |
| 9 | P2 | damage.rs full-walk alloc regression (from simplify step) | DONE - free `damage_inline_node(&mut Node, ...)`; `invalidate_inline_contexts` = direct iter_mut |
| 12 | P3 | `fetch_font_slice` URL-parse failure skips map cleanup | DONE - `missing_font_coverage.remove(url)` |
| 13 | P3 | WOFF2 decompress + fail path untested | DONE - `woff2_slice_decompresses_and_corrupt_payload_fails` (PASSES) |
| 14 | P3 | Per-glyph COLR check on monochrome path every frame | DONE - early exit when `font_ref.colr().is_err()` (`skrifa::raw::TableProvider`) |
| 15 | P3 | net.rs merged signature line | DONE - newline restored (cargo fmt) |

## Resolved: AE6 test `slice_arrival_damages_only_waiting_inline_root`

**RESOLVED (2026-08-15)**. Two independent root causes, both in the test, not
in the invalidation code:

1. **Shared inline root.** Tests run without the UA stylesheet
   (`packages/blitz-dom/assets/default.css`), so an unstyled `div` computes to
   `display: inline` (initial value) instead of `block`. Both sibling divs were
   therefore laid out inside `body`'s single inline root, and damaging the
   waiting text's inline root necessarily touched the covered text's too -
   correct targeted behavior, wrong assertion. Fixed by giving the divs an
   explicit `display: block` inline style in `make_r7_doc`, so each div is its
   own inline root (matching real UA-stylesheet behavior). Verified via tree
   dump: with blocks, `waiting.inline_root_ancestor() == waiting_div` and
   `covered.inline_root_ancestor() == covered_div` (distinct).

2. **Empty-damage `Some(...)` trap.** `Node::damage()` returns
   `Some(ServoRestyleDamage(0x0))` for any styled element even when the damage
   bitset is empty, so `.is_some()` is true for an untouched element. The
   covered div's damage was `Some(0x0)` (genuinely no damage) while the
   waiting div's was `Some(RELAYOUT | ...)`. Fixed by asserting
   `is_some_and(|d| !d.is_empty())`.

Damage propagation is also confirmed targeted: `propagate_damage_flags`
(damage.rs) only ORs child damage up into parents (`damage_for_children` is
empty), so damaging the waiting inline root does not fan out to sibling inline
roots.

## Verification state (final)

- `cargo build -p blitz-dom` 0 errors; `-p blitz-paint` 0 errors;
  `-p naivi-wasm --target wasm32-unknown-unknown` 0 errors (only pre-existing
  warnings: `unused_mut` in layout/mod.rs, unused imports in blitz-paint).
- `cargo test -p blitz-dom`: **79 passed / 0 failed** (incl. AE6, R7, WOFF2,
  probe-coverage tests).
- `cargo test -p blitz-paint`: **9 passed / 0 failed** (COLR tests green after
  #5/#14).
- `cargo test -p blitz-traits` / `-p blitz-net`: 0 tests, clean.
- Fix commits: `f39ca560` (review fixes) + `fix(review): land AE6 targeted-
  invalidation test` (this handoff's open item).

## Remaining pipeline (lfg, after this push)

1. ~~Fix/land the AE6 test (#7)~~ **DONE** - see "Resolved" section above.
2. ~~Commit fixes as `fix(review): apply ce-code-review findings ...`~~ **DONE**
   - `f39ca560`, plus this follow-up commit landing the AE6 test.
3. ~~lfg Step 6: residual handoff~~ **DONE** - this file is the record.
4. lfg Step 7: `ce-test-browser mode:pipeline` - not run (font slicing is
   wasm-guest only; no U8 demo page in the diff yet).
5. lfg Step 8: `ce-commit-push-pr mode:pipeline branding:on` - not run (work
   landed directly on `main`; no PR opened for the slicing feature).
6. lfg Step 9: `ce-babysit-pr mode:pipeline <pr-url>` - not applicable.
7. DONE.

## Known limitations carried as residual risks (not fixed this round)

- Non-step font-weights (450/550) fall back to 400 slice; no italic slices in
  the bootstrap CSS.
- Native (non-wasm) `blitz-net` delivers `handler.bytes(resolved_url)` post-
  redirect while the loader keys by request URL - latent if slices were ever
  installed on a native doc.
- `complete()` returning None (slice dropped from a refreshed set) strands the
  URL; only one bootstrap runs today.
- Generated-content (`::before`/`::after`, `counter()`) pre-scan coverage is
  unverified by tests.
- `parse_font_css` skips `@font-face` without `unicode-range` and wildcard
  ranges.
- U8 demo page not yet added to the diff (bootstrap present only).

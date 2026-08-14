# wasm font slicing — code-review fix handoff (2026-08-14)

Branch: `feat/wasm-font-slicing` (HEAD `ee3276500`, pushed to origin)
Plan: `docs/plans/2026-08-14-1512-feat-wasm-font-slicing-plan.md`

## Status

ce-code-review (mode:agent) completed; verdict **Ready with fixes**. The fix
step (lfg Step 5) is **in progress**: all code fixes are applied to the working
tree but **uncommitted** (9 modified files), and the review-fix tests are not
yet fully green. This file records the exact state so the work survives a push
and can be resumed.

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
| 7 | P2 | AE6 targeted re-layout never asserted | IN PROGRESS - `slice_arrival_damages_only_waiting_inline_root` FAILS: covered sibling's inline root is also damaged (see below) |
| 8 | P2 | Coverage miss test tautology | DONE - probe-count bound `(2..=4)` (PASSES) |
| 9 | P2 | damage.rs full-walk alloc regression (from simplify step) | DONE - free `damage_inline_node(&mut Node, ...)`; `invalidate_inline_contexts` = direct iter_mut |
| 12 | P3 | `fetch_font_slice` URL-parse failure skips map cleanup | DONE - `missing_font_coverage.remove(url)` |
| 13 | P3 | WOFF2 decompress + fail path untested | DONE - `woff2_slice_decompresses_and_corrupt_payload_fails` (PASSES) |
| 14 | P3 | Per-glyph COLR check on monochrome path every frame | DONE - early exit when `font_ref.colr().is_err()` (`skrifa::raw::TableProvider`) |
| 15 | P3 | net.rs merged signature line | DONE - newline restored (cargo fmt) |

## Open item: AE6 test `slice_arrival_damages_only_waiting_inline_root`

Fails at `covered sibling must not be re-damaged` (document.rs ~3596). The
covered div's inline root is also damaged after the waiting slice arrives.

Hypothesis: both sibling divs share the same inline root (e.g. `body`), so
damaging the waiting text's inline root necessarily damages the covered text's
inline root too - which is CORRECT targeted behavior, and the test assertion is
wrong. `IS_INLINE_ROOT` is set in construct.rs:635; a block div should be its
own inline root, but this needs verification (does `inline_root_ancestor`
return body/html for the divs?).

Next step: make the assertion robust - e.g. assert that a THIRD, unrelated
inline root elsewhere in the document (a separate block that establishes its
own inline context) is NOT damaged, proving invalidation is targeted rather
than a full-document walk; or relax to "waiting inline root damaged" only.

## Verification state (pre-push)

- `cargo build -p blitz-dom` 0 errors; `-p blitz-paint` 0 errors;
  `-p naivi-wasm --target wasm32-unknown-unknown` 0 errors.
- `cargo test -p blitz-dom`: 77 passed / 1 failed (the AE6 test above); the new
  R7 + WOFF2 + probe tests pass.
- `cargo test -p blitz-paint`: not yet re-run after #5/#14 changes (COLR tests
  must still pass).
- Working tree: 9 modified files (document.rs, fonts/coverage.rs, fonts/slice.rs,
  layout/damage.rs, mutator.rs, net.rs, blitz-paint/src/text_color.rs,
  naivi-wasm/Cargo.toml, naivi-wasm/src/net.rs). NOT committed.

## Remaining pipeline (lfg, after this push)

1. Fix/land the AE6 test (#7), re-run full test suite (`blitz-dom`,
   `blitz-paint`, `blitz-traits`, `blitz-net`) + wasm build.
2. Commit fixes as `fix(review): apply ce-code-review findings ...`.
3. lfg Step 6: residual handoff (this file is the record).
4. lfg Step 7: `ce-test-browser mode:pipeline`.
5. lfg Step 8: `ce-commit-push-pr mode:pipeline branding:on`.
6. lfg Step 9: `ce-babysit-pr mode:pipeline <pr-url>`.
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

# Residual Review Findings — feat/native-input-editing

Source: ce-code-review (9 personas: correctness, adversarial, testing, maintainability, performance, reliability, api-contract, project-standards, julik-frontend-races) on branch `feat/native-input-editing` (head `d5c598b9`, review fixes applied in `d5c598b9` + follow-up IME symmetry fix).

All P0/P1 and the applied P2/P3 findings are fixed in the branch (node-identity stale guard, wasm caret seed, macOS KTD8 key forwarding + password masking + caret preservation + leak fix + font stack, composition-commit mirror, IME-composition key guard, focus restore, R5 last_value sync, dead API removal). The following findings were reviewed, judged lower-risk or deliberately scoped out for this ship, and are tracked here as durable residuals.

## Residual findings (deferred)

- **P2 — EventDriver suppresses all document key/IME events while a session is active, not just the session element's** (`packages/blitz-dom/src/events/driver.rs:158`). `native_edit_active = doc.native_edit_session.is_some()` drops every winit KeyDown/KeyUp/Ime/AppleStandardKeybinding document-wide. Functionally equivalent while blitz focus == the session node (the normal case, since the native overlay owns focus), but a broad hammer if that invariant diverges (e.g. menu key-equivalents on macOS). Not applied: scoping to the focused node adds risk for an invariant that holds today; revisit if multi-element focus during a session becomes reachable.

- **P2 — Forwarded session KeyDown/KeyUp lose modifiers/repeat/is_composing metadata** (`packages/blitz-dom/src/document.rs` `push_native_key_event`, hardcodes `Modifiers::empty()`). Documented KTD8 tradeoff: guest `@keydown.*`/`@keyup.*` bindings that distinguish modifiers (e.g. `@keyup.ctrl.enter`) silently don't match during a session, and held-key repeats all arrive as fresh presses. The wasm backend has `ev.shift_key()/ctrl_key()/repeat()` available; threading a modifiers/repeat payload through `NativeEditEvent::KeyDown/KeyUp` would fix it (protocol change affecting both backends + tests).

- **P2 — wasm overlay is a page-lifetime process singleton** (`packages/naivi-wasm/src/native_input.rs` `init_dom` early-returns, `BACKEND` global). A SPA canvas re-mount or second window leaves the overlay attached to the old canvas and the backend routing to a stale `doc_id`; `create()` would still report success while `focus()` is a no-op on a detached node. Anchor 50 (no evidence a re-mount occurs in current demos). Fix if/when multi-window or re-mount support is added: key DOM/backend per window.

- **P3 — macOS backend uses a module-global PROXY and smuggles doc_id through a raw pointer ctx** (`packages/naivi-native/src/native_input/macos.rs`). Works for the current single-window host; a multi-window macOS host would route all callbacks through one proxy. Refactor (per-backend proxy pointer as ctx) deferred.

- **P3 — macOS `native_input_get_value` returns a pointer into a process-global `_textBuffer` that the next call frees** (`packages/naivi-native/src/native_input/macos_helper.m`). Safe today: single main thread, Rust copies immediately (`cstr_to_string`), and `get_value` has no engine caller (plan-contract method). Dangling-by-design if ever deferred/re-entrant.

- **P3 — macOS `native_input_set_editable` doesn't apply `enabled` to the multiline NSTextView** (`packages/naivi-native/src/native_input/macos_helper.m`). `disabled` inputs on macOS textarea keep the control enabled (R11 partially honored for multiline).

- **P3 — macOS R12: font weight ignored and generic families fall back to system font** (`packages/naivi-native/src/native_input/macos_helper.m` `native_input_set_font`). `weight` param unused; only the first named family is resolved. Acceptable baseline (wasm overlay applies weight); deep macOS font matching is future work.

- **P3 — macOS KTD8 covers command-selector keys only** (Enter/Tab/Escape/arrows/Backspace via `doCommandBySelector`); plain character keys go through `insertText:` and are not forwarded as KeyDown/KeyUp. Covers the todomvc bindings (`@keyup.enter`/`@keyup.escape`); a full view-level `keyDown:` interception subclass would forward all keys.

## Residual risks (noted, no action)

- Geometry re-push (R10) relies on a resolve pass after scroll/relayout; a future repaint-without-resolve scroll path would leave the overlay mispositioned.
- macOS runtime (KTD8 key path, password masking, caret preservation, control lifetime) is compile-verified + plan-AE-manual only — no headless `nv desktop` run available in CI.
- The `last_value` guard and `native_edit_mirror_in_progress` are per-document; safe while sessions are single-per-document.

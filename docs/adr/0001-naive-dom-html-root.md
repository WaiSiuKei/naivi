# naive-dom facade mirrors `<html>` as the document root

The naive-dom facade (the JS virtual DOM in `js/naivi-runtime/src/naive-dom.ts`)
used to attach a `<body>` element directly as the blitz document root. That
meant author-stylesheet root selectors — `html`, `html, :host`, `:root` — could
never match, so Tailwind v4 preflight defaults declared on `html, :host`
(`font-family: var(--default-font-family, …)`, `line-height`, …) were silently
lost and every text node fell back to stylo's initial `serif` family. We now
mirror a full document: an `<html>` element is the document root and `<body>`
is its child (both fill the viewport via UA width/height 100% props), so root
selectors match and preflight defaults apply.

**Status**: accepted

## Considered Options

- **Body-as-root (previous)**: simplest, but no `html`/`:host`/`:root`
  selector ever matched → preflight defaults lost (the observed serif bug).
- **CSS rewrite in naivi-cli** (rewrite `html, :host` → `body` in the compiled
  CSS): Tailwind-specific hack; leaves the general "no root element" gap for
  any other root-scoped styles.
- **`html > head + body`**: most "complete", but `head` is unused by the
  renderer and nothing consumes it today.
- **`html > body` (chosen)**: root selectors match; minimal shape; `head` can
  be added later when a head-level feature (title/viewport/meta) exists.

## Consequences

- naive-dom is shared by the wasm and desktop hosts, so both now get the
  `html` root.
- The runtime `[Generic(Serif)] → SystemUi` fallback added earlier in
  `stylo_to_parley.rs` was reverted as redundant: once `html` matches, stylo
  resolves the preflight's `var(--default-font-family, -apple-system, …)`
  fallback to the system UI stack (verified empirically).
- The naivi-cli preflight `var()`-resolution (resolving
  `--default-font-family: var(--font-sans)` to a literal) was considered and
  deliberately NOT implemented: stylo's `var()` fallback already yields the
  correct stack, and the custom-property definitions are otherwise harmless.

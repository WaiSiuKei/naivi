# Naivi

Naivi renders Vue Vapor apps through the blitz DOM engine onto native canvases
(desktop and wasm). The guest page runs against a JS DOM facade that mirrors a
real engine-side document tree.

## Language

**naive-dom facade**:
The JS virtual DOM in `js/naivi-runtime/src/naive-dom.ts` that presents a
DOM-like API (createElement, appendChild, …) to the Vue renderer and mirrors
every mutation to the engine as batched ops.
_Avoid_: fake DOM, mock DOM, naive document

**document root**:
The engine (blitz) root node that the facade attaches its top-level element
to. Blitz treats the document as "having DOM" only once this root has an
element child — attach it or nothing renders/hit-tests.
_Avoid_: root element, html element (the html element is a child of the root)

**author stylesheet**:
The compiled project CSS (`node_modules/.naive/styles.css`) injected as a stylo
author stylesheet; class / tag / `:hover` / `:root` selectors are matched
natively by the engine.
_Avoid_: author CSS (keep "stylesheet" to signal it goes through stylo)

**preflight**:
Tailwind's base reset. It declares root defaults on `html, :host`
(`font-family` via `var(--default-font-family, …)`, `line-height`,
`box-sizing`), so the facade's `html` root must exist for it to match.

**computed font family**:
The stylo-resolved `font-family` list handed to parley for shaping. It can
fall back to the initial `serif` when an author rule that should set it never
matches (see the naive-dom html-root ADR).

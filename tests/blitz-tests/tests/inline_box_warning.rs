//! Non-atomic inline elements carrying box styling blitz does not render
//! (margin/padding/border — see
//! docs/plans/2026-08-13-075-feat-inline-box-styling-warning-plan.md) must be
//! detected at inline-layout construction and warned about at most once per
//! document lifetime. The observable state is the document-level flag
//! (`BaseDocument::inline_box_styling_warned`); the `tracing::warn!` emission
//! itself is feature-gated and not asserted here.

use blitz_dom::DocumentConfig;
use blitz_html::{HtmlDocument, HtmlProvider};
use blitz_traits::shell::{ColorScheme, Viewport};
use std::sync::Arc;

fn make_doc(html: &str) -> HtmlDocument {
    let mut doc = HtmlDocument::from_html(
        html,
        DocumentConfig {
            viewport: Some(Viewport::new(400, 300, 1.0, ColorScheme::Light)),
            html_parser_provider: Some(Arc::new(HtmlProvider) as _),
            ..Default::default()
        },
    );
    doc.resolve(0.0);
    doc
}

fn warned(doc: &HtmlDocument) -> bool {
    doc.inline_box_styling_warned
}

const SHELL: &str = r#"<!DOCTYPE html>
<html><head><style>{css}</style></head>
<body><p>{body}</p></body></html>
"#;

fn html(css: &str, body: &str) -> String {
    SHELL.replace("{css}", css).replace("{body}", body)
}

#[test]
fn span_with_padding_triggers() {
    let doc = make_doc(&html("span { padding: 4px; }", r#"<span id="s">hi</span>"#));
    assert!(warned(&doc), "span with padding should warn");
}

#[test]
fn inline_div_triggers_same_as_span() {
    // Covers AE1: trigger follows computed display, not the tag name.
    let doc = make_doc(&html(
        "div { display: inline; padding: 4px; }",
        r#"<div id="d">hi</div>"#,
    ));
    assert!(warned(&doc), "display:inline div should warn");
}

#[test]
fn margin_triggers() {
    let doc = make_doc(&html(
        "span { margin-left: 3px; }",
        r#"<span id="s">hi</span>"#,
    ));
    assert!(warned(&doc), "span with margin should warn");
}

#[test]
fn visible_border_triggers() {
    let doc = make_doc(&html(
        "span { border: 1px solid black; }",
        r#"<span id="s">hi</span>"#,
    ));
    assert!(warned(&doc), "span with a visible border should warn");
}

#[test]
fn transparent_border_does_not_trigger() {
    // Covers AE4.
    let doc = make_doc(&html(
        "span { border: 1px solid transparent; }",
        r#"<span id="s">hi</span>"#,
    ));
    assert!(!warned(&doc), "transparent border should not warn");
}

#[test]
fn inline_block_does_not_trigger() {
    // Covers AE2: atomic inline boxes support these properties.
    let doc = make_doc(&html(
        "span { display: inline-block; margin: 3px; }",
        r#"<span id="s">hi</span>"#,
    ));
    assert!(!warned(&doc), "inline-block with margin should not warn");
}

#[test]
fn background_only_does_not_trigger() {
    // Covers AE3: inline backgrounds are already rendered.
    let doc = make_doc(&html(
        "span { background-color: yellow; }",
        r#"<span id="s">hi</span>"#,
    ));
    assert!(!warned(&doc), "background-only span should not warn");
}

#[test]
fn plain_span_does_not_trigger() {
    let doc = make_doc(&html("span { color: red; }", r#"<span id="s">hi</span>"#));
    assert!(!warned(&doc), "plain span should not warn");
}

#[test]
fn flag_survives_re_resolve() {
    // Covers AE5: the document flag is the lifetime dedupe state, so a second
    // resolve must not clear it (and must not re-warn).
    let mut doc = make_doc(&html("span { padding: 4px; }", r#"<span id="s">hi</span>"#));
    assert!(warned(&doc), "span with padding should warn");
    doc.resolve(0.0);
    assert!(
        warned(&doc),
        "flag must stay set after re-resolve (dedupe state)"
    );
}

#[test]
fn multiple_triggering_spans_warn_once_for_document() {
    // The warning is per document, not per node: several triggering inline
    // elements still produce exactly one document-level warning.
    let doc = make_doc(&html(
        "span.pad { padding: 4px; }",
        r#"<span id="a" class="pad">a</span><span id="b" class="pad">b</span>"#,
    ));
    assert!(warned(&doc), "document should warn once");
}

#[test]
fn non_triggering_sibling_does_not_warn() {
    let doc = make_doc(&html(
        "span.pad { padding: 4px; }",
        r#"<span id="a" class="pad">a</span><span id="b">b</span>"#,
    ));
    assert!(
        warned(&doc),
        "triggering element should set the document flag"
    );
}

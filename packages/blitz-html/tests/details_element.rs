//! The <details>/<summary> disclosure widget. Activating the first <summary>
//! child toggles the `open` attribute of its <details> ancestor, and the
//! user-agent stylesheet hides everything except that summary while closed.

use blitz_dom::{Document, DocumentConfig};
use blitz_html::{HtmlDocument, HtmlProvider};
use blitz_traits::{
    events::{
        BlitzPointerEvent, BlitzPointerId, MouseEventButton, MouseEventButtons, Point,
        PointerCoords, PointerDetails, UiEvent,
    },
    shell::{ColorScheme, Viewport},
};
use markup5ever::local_name;
use std::sync::Arc;

fn doc(html: &str) -> HtmlDocument {
    let mut doc = HtmlDocument::from_html(
        html,
        DocumentConfig {
            viewport: Some(Viewport::new(400, 400, 1.0, ColorScheme::Light)),
            html_parser_provider: Some(Arc::new(HtmlProvider) as _),
            ..Default::default()
        },
    );
    doc.resolve(0.0);
    doc
}

fn node_id(doc: &HtmlDocument, selector: &str) -> usize {
    doc.query_selector(selector).unwrap().expect(selector)
}

fn pointer_event(x: f32, y: f32) -> BlitzPointerEvent {
    BlitzPointerEvent {
        id: BlitzPointerId::Mouse,
        is_primary: true,
        coords: PointerCoords {
            page_x: x,
            page_y: y,
            screen_x: x,
            screen_y: y,
            client_x: x,
            client_y: y,
        },
        button: MouseEventButton::Main,
        buttons: MouseEventButtons::from(MouseEventButton::Main),
        mods: Default::default(),
        details: PointerDetails::default(),
        element: Point::default(),
        active_pointers: Default::default(),
    }
}

fn click(doc: &mut HtmlDocument, x: f32, y: f32) {
    let event = pointer_event(x, y);
    doc.handle_ui_event(UiEvent::PointerDown(event.clone()));
    doc.handle_ui_event(UiEvent::PointerUp(event));
    doc.resolve(0.0);
}

fn is_open(doc: &HtmlDocument, selector: &str) -> bool {
    let id = node_id(doc, selector);
    doc.get_node(id).unwrap().data.has_attr(local_name!("open"))
}

/// The content height of the details' body element. Zero when the details is
/// closed (the body is `display: none`), positive when open.
fn body_height(doc: &HtmlDocument, selector: &str) -> f32 {
    let id = node_id(doc, selector);
    doc.get_node(id).unwrap().final_layout.size.height
}

#[test]
fn clicking_summary_toggles_open() {
    let mut doc = doc(r#"<html><body style="margin:0">
        <details>
            <summary style="height:20px;">Summary</summary>
            <p id="body" style="height:40px;">Hidden content</p>
        </details>
    </body></html>"#);

    // Closed by default.
    assert!(!is_open(&doc, "details"));
    assert_eq!(body_height(&doc, "#body"), 0.0, "body hidden while closed");

    // Click on the summary (near the top-left, within the 20px summary row).
    click(&mut doc, 40.0, 10.0);
    assert!(is_open(&doc, "details"), "open after first click");
    assert!(body_height(&doc, "#body") > 0.0, "body visible while open");

    // Clicking again collapses it.
    click(&mut doc, 40.0, 10.0);
    assert!(!is_open(&doc, "details"), "closed after second click");
    assert_eq!(body_height(&doc, "#body"), 0.0, "body hidden again");
}

#[test]
fn details_starts_open_when_open_attribute_present() {
    let doc = doc(r#"<html><body style="margin:0">
        <details open>
            <summary style="height:20px;">Summary</summary>
            <p id="body" style="height:40px;">Visible content</p>
        </details>
    </body></html>"#);

    assert!(is_open(&doc, "details"));
    assert!(
        body_height(&doc, "#body") > 0.0,
        "body visible when initially open"
    );
}

#[test]
fn initially_open_details_can_be_closed() {
    // The `open` attribute created by the HTML parser lives in the empty
    // namespace. Toggling must remove that attribute (and not merely fail to
    // find a namespaced one).
    let mut doc = doc(r#"<html><body style="margin:0">
        <details open>
            <summary style="height:20px;">Summary</summary>
            <p id="body" style="height:40px;">Visible content</p>
        </details>
    </body></html>"#);

    assert!(is_open(&doc, "details"));

    // Click the summary to close it
    click(&mut doc, 40.0, 10.0);
    assert!(
        !is_open(&doc, "details"),
        "clicking the summary should close an initially-open details"
    );
    assert_eq!(body_height(&doc, "#body"), 0.0, "body hidden after closing");

    // And it can be re-opened
    click(&mut doc, 40.0, 10.0);
    assert!(is_open(&doc, "details"));
    assert!(body_height(&doc, "#body") > 0.0, "body visible again");
}

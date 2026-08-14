use anyrender::PaintScene;
use blitz_dom::{BaseDocument, NodeId, node::{RasterImageData, TextBrush}, util::ToColorColor};
use kurbo::{Affine, Rect, Stroke, Vec2};
use parley::{Affinity, Cursor, GlyphRun, Layout, Line, PositionedLayoutItem, Selection};
use peniko::{Fill, ImageAlphaType, ImageQuality};
use style::values::computed::TextDecorationLine;

#[cfg(target_os = "macos")]
use blitz_macos_text; // native CoreText glyph rasterization (naivi)
#[cfg(target_os = "macos")]
use crate::render::to_peniko_image;

use crate::color::{Color, ToColorColor as _};
use crate::{FONT_EMBOLDEN_ENABLED, SELECTION_COLOR};

/// Draw the backgrounds of inline elements (e.g. `<span style="background: ...">`).
///
/// Each glyph run carries the node id of the innermost inline element it belongs to
/// (via its brush). We look up that node's `background-color` and, if non-transparent,
/// fill a rectangle covering the run's advance and its font's ascent/descent so that the
/// background sits behind the text.
///
/// The inline root's own background is painted separately (as a normal block box), so
/// runs belonging to the root are skipped to avoid drawing it twice.
pub(crate) fn draw_inline_backgrounds<'a>(
    scene: &mut impl PaintScene,
    lines: impl Iterator<Item = Line<'a, TextBrush>>,
    doc: &BaseDocument,
    transform: Affine,
    inline_root_id: NodeId,
) {
    for line in lines {
        for item in line.items() {
            let PositionedLayoutItem::GlyphRun(glyph_run) = item else {
                continue;
            };

            let node_id = glyph_run.style().brush.id;
            if node_id == inline_root_id {
                continue;
            }

            let Some(styles) = doc.get_node(node_id).and_then(|node| node.primary_styles()) else {
                continue;
            };

            let current_color = styles.clone_color();
            let bg_color = styles
                .get_background()
                .background_color
                .resolve_to_absolute(&current_color)
                .as_srgb_color();
            if bg_color == Color::TRANSPARENT {
                continue;
            }

            let metrics = glyph_run.run().metrics();
            let x = glyph_run.offset() as f64;
            let w = glyph_run.advance() as f64;
            let baseline = glyph_run.baseline() as f64;
            let y0 = baseline - metrics.ascent as f64;
            let y1 = baseline + metrics.descent as f64;
            let rect = Rect::new(x, y0, x + w, y1);

            scene.fill(Fill::NonZero, transform, bg_color, None, &rect);
        }
    }
}

pub(crate) fn stroke_text<'a>(
    scene: &mut impl PaintScene,
    lines: impl Iterator<Item = Line<'a, TextBrush>>,
    doc: &BaseDocument,
    transform: Affine,
    scale: f64,
) {
    for line in lines {
        for item in line.items() {
            if let PositionedLayoutItem::GlyphRun(glyph_run) = item {
                // macOS CoreText backend: runs carrying a self-describing native
                // font key draw natively first (color-aware, e.g. Apple Color
                // Emoji). On macOS EVERY run is shaped by CoreText and carries a
                // native font (the harfrust path is unreachable there), so this
                // branch always handles runs on macOS; the anyrender monochrome
                // path handles everything else.
                #[cfg(target_os = "macos")]
                if draw_glyph_run_native(scene, &glyph_run, doc, transform) {
                    continue;
                }
                // COLRv1 color glyphs (e.g. Noto Color Emoji loaded through the
                // on-demand slice loader on wasm): rasterize color glyphs to
                // premultiplied RGBA bitmaps via tiny-skia and draw them as
                // images. Mixed runs keep their non-color glyphs on the
                // monochrome path. Returns true when the run contained any
                // color glyph (U7). Non-macOS only: CoreText already rasterizes
                // color natively, so this Rust path is never reached there.
                #[cfg(not(target_os = "macos"))]
                if crate::text_color::draw_glyph_run_color(scene, &glyph_run, doc, transform, scale) {
                    continue;
                }
                draw_glyphs_mono(scene, &glyph_run, doc, transform, scale, glyph_run.positioned_glyphs());

                draw_text_decorations(scene, &glyph_run, doc, transform);
            }
        }
    }
}

/// Draw a subset of a glyph run's glyphs through the anyrender monochrome
/// path. Shared by the plain fallback in [`stroke_text`] and the COLR
/// mixed-run path in `text_color.rs` (U7).
pub(crate) fn draw_glyphs_mono<'a>(
    scene: &mut impl PaintScene,
    glyph_run: &GlyphRun<'a, TextBrush>,
    doc: &BaseDocument,
    transform: Affine,
    scale: f64,
    glyphs: impl Iterator<Item = parley::layout::Glyph>,
) {
    let run = glyph_run.run();
    let font = run.font();
    let font_size = run.font_size();
    let style = glyph_run.style();
    let synthesis = run.synthesis();
    let glyph_xform = synthesis
        .skew()
        .map(|angle| Affine::skew(angle.to_radians().tan() as f64, 0.0));

    // Styles
    let styles = doc
        .get_node(style.brush.id)
        .unwrap()
        .primary_styles()
        .unwrap();
    let itext_styles = styles.get_inherited_text();
    let text_color = itext_styles.color.as_color_color();

    let embolden = if FONT_EMBOLDEN_ENABLED {
        let fs = font_size as f64 / scale;
        kurbo::Vec2::new((0.015125 * fs).min(0.3), (0.0121 * fs).min(0.3))
    } else {
        kurbo::Vec2::default()
    };

    // Collect so `draw_glyphs` receives a `Clone` iterator (required by the
    // anyrender signature) regardless of what the caller passed.
    let glyphs: Vec<parley::layout::Glyph> = glyphs.collect();

    scene.draw_glyphs(
        font,
        font_size,
        !FONT_EMBOLDEN_ENABLED, // hint
        run.normalized_coords(),
        embolden,
        Fill::NonZero,
        &anyrender::Paint::from(text_color),
        1.0, // alpha
        transform,
        glyph_xform,
        glyphs.iter().map(|glyph| anyrender::Glyph {
            id: glyph.id as _,
            x: glyph.x,
            y: glyph.y,
        }),
    );
}

/// Draw the underline / strikethrough of a glyph run, using the run's font
/// metrics for the line offsets and thicknesses. Shared with the COLR color
/// path (`text_color.rs`).
pub(crate) fn draw_text_decorations<'a>(
    scene: &mut impl PaintScene,
    glyph_run: &GlyphRun<'a, TextBrush>,
    doc: &BaseDocument,
    transform: Affine,
) {
    let metrics = glyph_run.run().metrics();
    let style = glyph_run.style();
    let styles = doc
        .get_node(style.brush.id)
        .unwrap()
        .primary_styles()
        .unwrap();
    let itext_styles = styles.get_inherited_text();
    let text_styles = styles.get_text();
    let text_color = itext_styles.color.as_color_color();
    let text_decoration_color = text_styles
        .text_decoration_color
        .as_absolute()
        .map(ToColorColor::as_color_color)
        .unwrap_or(text_color);
    let text_decoration_brush = anyrender::Paint::from(text_decoration_color);
    let text_decoration_line = text_styles.text_decoration_line;
    let has_underline = text_decoration_line.contains(TextDecorationLine::UNDERLINE);
    let has_strikethrough = text_decoration_line.contains(TextDecorationLine::LINE_THROUGH);

    let mut draw_decoration_line =
        |offset: f32, size: f32, brush: &anyrender::Paint| {
            let x = glyph_run.offset() as f64;
            let w = glyph_run.advance() as f64;
            let y = (glyph_run.baseline() - offset + size / 2.0) as f64;
            let line = kurbo::Line::new((x, y), (x + w, y));
            scene.stroke(&Stroke::new(size as f64), transform, brush, None, &line)
        };

    if has_underline {
        // TODO: intercept line when crossing an descending character like "gqy"
        draw_decoration_line(metrics.underline_offset, metrics.underline_size, &text_decoration_brush);
    }
    if has_strikethrough {
        draw_decoration_line(
            metrics.strikethrough_offset,
            metrics.strikethrough_size,
            &text_decoration_brush,
        );
    }
}

/// Draw selection highlight rectangles for the given byte range in a layout.
/// Uses Parley's Selection type for accurate geometry calculation.
pub(crate) fn draw_text_selection(
    scene: &mut impl PaintScene,
    layout: &Layout<TextBrush>,
    transform: Affine,
    selection_start: usize,
    selection_end: usize,
) {
    let anchor = Cursor::from_byte_index(layout, selection_start, Affinity::Downstream);
    let focus = Cursor::from_byte_index(layout, selection_end, Affinity::Downstream);
    let selection = Selection::new(anchor, focus);

    selection.geometry_with(layout, |rect, _line_idx| {
        let rect = kurbo::Rect::new(rect.x0, rect.y0, rect.x1, rect.y1);
        scene.fill(Fill::NonZero, transform, SELECTION_COLOR, None, &rect);
    });
}

/// macOS CoreText backend: draw one glyph run with native rasterization.
///
/// Runs carrying a self-describing native font key are rasterized to RGBA
/// bitmaps (color-aware, e.g. Apple Color Emoji) via CoreGraphics and drawn
/// into the scene as images. Returns `true` when it handled the run, so the
/// caller skips the anyrender monochrome path. All CoreText/CoreGraphics logic
/// lives in `blitz-macos-text` (R7); this is the only seam in this file.
#[cfg(target_os = "macos")]
fn draw_glyph_run_native<'a>(
    scene: &mut impl PaintScene,
    glyph_run: &GlyphRun<'a, TextBrush>,
    doc: &BaseDocument,
    transform: Affine,
) -> bool {
    let run = glyph_run.run();
    let Some(key) = run.native_font() else {
        return false;
    };
    let font = blitz_macos_text::resolve_font(key);

    // Rasterize in the run's CSS text color (the CoreGraphics path fills
    // with the context color; without this every glyph would render black).
    let style = glyph_run.style();
    let text_color = doc
        .get_node(style.brush.id)
        .unwrap()
        .primary_styles()
        .unwrap()
        .get_inherited_text()
        .color
        .as_color_color();
    let rgba = text_color.to_rgba8();

    for glyph in glyph_run.positioned_glyphs() {
        let Some(bmp) = blitz_macos_text::rasterize_glyph(&font, glyph.id, [rgba.r, rgba.g, rgba.b])
        else {
            continue;
        };
        let raster = RasterImageData::new(bmp.width, bmp.height, bmp.data.clone());
        let brush =
            to_peniko_image(&raster, ImageQuality::Medium, ImageAlphaType::AlphaPremultiplied);
        let x = (glyph.x + bmp.offset_x) as f64;
        let y = (glyph.y + bmp.offset_y) as f64;
        let t = transform.pre_translate(Vec2::new(x, y));
        scene.draw_image(brush.as_ref(), t);
    }

    draw_text_decorations(scene, glyph_run, doc, transform);
    true
}

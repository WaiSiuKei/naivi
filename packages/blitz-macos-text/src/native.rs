// Copyright 2026 the Blitz Authors
// SPDX-License-Identifier: Apache-2.0 OR MIT

//! CoreGraphics glyph rasterization for the naivi CoreText backend (macOS).
//!
//! Mirrors the naive project's proven rasterization strategy (1px dilation,
//! RGBA premultiplied bitmaps, pixel-based color detection) but takes glyph
//! bounds from CoreText (`CTFont::get_bounding_rects_for_glyphs`) instead of
//! font-kit, because the fork's native font key only resolves to a `CTFont`
//! (no font data for cascade fonts) — see the plan (U6).

use core_foundation::string::CFString;
use core_graphics::base::CGFloat;
use core_graphics::color_space::CGColorSpace;
use core_graphics::context::{CGContext, CGTextDrawingMode};
use core_graphics::display::CGPoint;
use core_graphics::geometry::{CGRect, CGSize};
use core_text::font::CTFont;
use core_text::font_descriptor::{kCTFontOrientationDefault, new_from_postscript_name};
use parley::MacNativeFont;

/// An RGBA (premultiplied) bitmap of one glyph, plus its pen offset.
#[derive(Clone, Debug)]
pub struct GlyphBitmap {
    /// RGBA premultiplied pixels, row-major, top-to-bottom.
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    /// Offset of the bitmap's left edge from the glyph's pen x (layout units).
    pub offset_x: f32,
    /// Offset of the bitmap's top edge from the baseline (layout units, y-down).
    pub offset_y: f32,
    /// Whether the bitmap contains color (non-grayscale) pixels.
    pub is_color: bool,
}

/// Resolve a fork-issued self-describing font key to a `CTFont` (KTD4).
pub fn resolve_font(key: &MacNativeFont) -> Option<CTFont> {
    let name = CFString::new(&key.postscript_name);
    let descriptor = new_from_postscript_name(&name);
    Some(core_text::font::new_from_descriptor(
        &descriptor,
        key.size as f64,
    ))
}

/// 1x1 fully transparent sentinel for blank glyphs (plan U6).
fn blank_glyph() -> GlyphBitmap {
    GlyphBitmap {
        data: vec![0, 0, 0, 0],
        width: 1,
        height: 1,
        offset_x: 0.0,
        offset_y: 0.0,
        is_color: false,
    }
}

/// Rasterize a single glyph into an RGBA bitmap via CoreGraphics.
///
/// Glyph bounds come from `CTFont::get_bounding_rects_for_glyphs` (glyph
/// space, y-up, origin at the pen/baseline). The bitmap is dilated by one
/// pixel on every side so antialiasing is not clipped; the returned offsets
/// place the bitmap's top-left relative to the pen position in layout space
/// (y-down), matching how naive offsets its dilated raster bounds.
pub fn rasterize_glyph(font: &CTFont, glyph: u32, size: f32) -> Option<GlyphBitmap> {
    let ct = font.clone_with_font_size(size as CGFloat);
    let bounds = ct.get_bounding_rects_for_glyphs(kCTFontOrientationDefault, &[glyph as u16]);
    if bounds.size.width <= 0.0 && bounds.size.height <= 0.0 {
        return Some(blank_glyph());
    }

    const DILATE: f32 = 1.0;
    let width = (bounds.size.width as f32 + DILATE * 2.0).ceil().max(1.0) as u32;
    let height = (bounds.size.height as f32 + DILATE * 2.0).ceil().max(1.0) as u32;
    // Bitmap's bottom-left in glyph space (y-up), after dilation.
    let origin_x = bounds.origin.x as f32 - DILATE;
    let origin_y = bounds.origin.y as f32 - DILATE;

    let mut bytes = vec![0u8; (width * height * 4) as usize];
    let ctx = CGContext::create_bitmap_context(
        Some(bytes.as_mut_ptr() as *mut _),
        width as usize,
        height as usize,
        8,
        (width * 4) as usize,
        &CGColorSpace::create_device_rgb(),
        core_graphics::base::kCGImageAlphaPremultipliedLast,
    );

    ctx.save();
    ctx.clear_rect(CGRect::new(
        &CGPoint::new(0.0, 0.0),
        &CGSize::new(width as f64, height as f64),
    ));
    // Map glyph space (y-up, origin at baseline) onto the bitmap: the glyph's
    // dilated bounds [origin_x, origin_y] .. [origin_x+w, origin_y+h] become
    // pixels [0,0]..[w,h]. CG bitmap contexts are y-up with origin at
    // bottom-left, so no vertical flip is needed.
    ctx.translate(-origin_x as CGFloat, -origin_y as CGFloat);
    ctx.set_text_drawing_mode(CGTextDrawingMode::CGTextFill);
    ctx.set_allows_antialiasing(true);
    ctx.set_should_antialias(true);
    ct.draw_glyphs(&[glyph as u16], &[CGPoint::new(0.0, 0.0)], ctx.clone());
    ctx.restore();

    let is_color = contains_non_grayscale_pixels(&bytes);

    // Bitmap top edge in glyph space (y-up) is `origin_y + height`; in layout
    // space (y-down) that is the negated value.
    let offset_x = origin_x;
    let offset_y = -(origin_y + height as f32);

    Some(GlyphBitmap {
        data: bytes,
        width,
        height,
        offset_x,
        offset_y,
        is_color,
    })
}

/// True if any pixel has alpha > 0 and non-equal color channels (color glyphs).
fn contains_non_grayscale_pixels(data: &[u8]) -> bool {
    data.chunks_exact(4).any(|p| {
        let [r, g, b, a] = [p[0], p[1], p[2], p[3]];
        a > 0 && (r != g || g != b)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blank_glyph_is_one_px_transparent() {
        let g = blank_glyph();
        assert_eq!(g.width, 1);
        assert_eq!(g.height, 1);
        assert_eq!(g.data, [0, 0, 0, 0]);
    }

    #[test]
    fn resolves_fork_native_font_key() {
        // "Helvetica" is present on every macOS system.
        let key = MacNativeFont {
            postscript_name: "Helvetica".to_string(),
            family_name: "Helvetica".to_string(),
            size: 16.0,
            color: false,
        };
        let font = resolve_font(&key).expect("must resolve Helvetica");
        assert_eq!(font.postscript_name(), "Helvetica");
    }

    #[test]
    fn rasterizes_latin_glyph() {
        let key = MacNativeFont {
            postscript_name: "Helvetica".to_string(),
            family_name: "Helvetica".to_string(),
            size: 16.0,
            color: false,
        };
        let font = resolve_font(&key).unwrap();
        // "A" = glyph 36 in Helvetica.
        let bmp = rasterize_glyph(&font, 36, 16.0).expect("must rasterize");
        assert!(bmp.width > 1 && bmp.height > 1);
        assert!(!bmp.is_color);
        assert!(bmp.data.iter().any(|&b| b != 0), "must have ink");
    }
}

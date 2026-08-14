// Copyright 2026 the Blitz Authors
// SPDX-License-Identifier: Apache-2.0 OR MIT

//! CoreGraphics glyph rasterization for the naivi CoreText backend (macOS).
//!
//! Mirrors the naive project's proven rasterization strategy (1px dilation,
//! RGBA premultiplied bitmaps) but takes glyph bounds from CoreText
//! (`CTFont::get_bounding_rects_for_glyphs`) instead of font-kit, because the
//! fork's native font key only resolves to a `CTFont` (no font data for
//! cascade fonts) — see the plan (U6). Bitmaps are memoized in a bounded LRU
//! keyed by (postscript name, size, glyph id): rasterization runs on every
//! paint frame, and a fresh CoreGraphics bitmap context per glyph per frame
//! would otherwise be the dominant cost.

use core_foundation::string::CFString;
use core_graphics::base::CGFloat;
use core_graphics::color_space::CGColorSpace;
use core_graphics::context::{CGContext, CGTextDrawingMode};
use core_graphics::display::CGPoint;
use core_graphics::geometry::{CGRect, CGSize};
use core_text::font::CTFont;
use core_text::font_descriptor::{kCTFontOrientationDefault, new_from_postscript_name};
use parley::MacNativeFont;
use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

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
}

/// Resolve a fork-issued self-describing font key to a `CTFont` (KTD4).
///
/// `new_from_descriptor` is infallible (the key's postscript name either
/// resolves or CoreText substitutes a fallback), so this returns the font
/// directly.
pub fn resolve_font(key: &MacNativeFont) -> CTFont {
    let name = CFString::new(&key.postscript_name);
    let descriptor = new_from_postscript_name(&name);
    core_text::font::new_from_descriptor(&descriptor, key.size as f64)
}

#[derive(Clone, PartialEq, Eq, Hash)]
struct CacheKey {
    postscript: String,
    size_bits: u32,
    glyph: u32,
}

/// Bounded LRU memoizing `rasterize_glyph` results: `(font, size, glyph) ->
/// bitmap` is deterministic and recomputed on every paint frame otherwise.
struct GlyphCache {
    map: HashMap<CacheKey, Arc<GlyphBitmap>>,
    order: VecDeque<CacheKey>,
    cap: usize,
}

impl GlyphCache {
    fn new(cap: usize) -> Self {
        Self {
            map: HashMap::new(),
            order: VecDeque::new(),
            cap,
        }
    }

    fn get(&mut self, key: &CacheKey) -> Option<Arc<GlyphBitmap>> {
        if let Some(pos) = self.order.iter().position(|k| k == key) {
            let key = self.order.remove(pos).unwrap();
            self.order.push_back(key);
        }
        self.map.get(key).cloned()
    }

    fn insert(&mut self, key: CacheKey, bmp: Arc<GlyphBitmap>) {
        if self.map.contains_key(&key) {
            return;
        }
        self.map.insert(key.clone(), bmp);
        self.order.push_back(key);
        while self.order.len() > self.cap {
            if let Some(evict) = self.order.pop_front() {
                self.map.remove(&evict);
            }
        }
    }
}

thread_local! {
    static GLYPH_CACHE: RefCell<GlyphCache> = RefCell::new(GlyphCache::new(256));
}

/// Rasterize a single glyph into an RGBA bitmap via CoreGraphics.
///
/// Glyph bounds come from `CTFont::get_bounding_rects_for_glyphs` (glyph
/// space, y-up, origin at the pen/baseline). The bitmap is dilated by one
/// pixel on every side so antialiasing is not clipped; the returned offsets
/// place the bitmap's top-left relative to the pen position in layout space
/// (y-down), matching how naive offsets its dilated raster bounds. Returns
/// `None` for blank glyphs (zero bounds).
pub fn rasterize_glyph(font: &CTFont, glyph: u32) -> Option<Arc<GlyphBitmap>> {
    // CoreText glyph ids are 16-bit; keep the full `u32` in the cache key so
    // distinct ids never collide, but make the truncation explicit.
    debug_assert!(glyph <= u16::MAX as u32);
    let key = CacheKey {
        postscript: font.postscript_name(),
        size_bits: (font.pt_size() as f32).to_bits(),
        glyph,
    };
    if let Some(bmp) = GLYPH_CACHE.with(|c| c.borrow_mut().get(&key)) {
        return Some(bmp);
    }

    let bounds = font.get_bounding_rects_for_glyphs(kCTFontOrientationDefault, &[glyph as u16]);
    if bounds.size.width <= 0.0 && bounds.size.height <= 0.0 {
        return None;
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
    font.draw_glyphs(&[glyph as u16], &[CGPoint::new(0.0, 0.0)], ctx.clone());
    ctx.restore();

    // Bitmap top edge in glyph space (y-up) is `origin_y + height`; in layout
    // space (y-down) that is the negated value.
    let bmp = Arc::new(GlyphBitmap {
        data: bytes,
        width,
        height,
        offset_x: origin_x,
        offset_y: -(origin_y + height as f32),
    });
    GLYPH_CACHE.with(|c| c.borrow_mut().insert(key, bmp.clone()));
    Some(bmp)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_fork_native_font_key() {
        // "Helvetica" is present on every macOS system.
        let key = MacNativeFont {
            postscript_name: "Helvetica".to_string(),
            family_name: "Helvetica".to_string(),
            size: 16.0,
            color: false,
        };
        let font = resolve_font(&key);
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
        let font = resolve_font(&key);
        // "A" = glyph 36 in Helvetica.
        let bmp = rasterize_glyph(&font, 36).expect("must rasterize");
        assert!(bmp.width > 1 && bmp.height > 1);
        assert!(bmp.data.iter().any(|&b| b != 0), "must have ink");
    }

    #[test]
    fn rasterize_is_memoized() {
        let key = MacNativeFont {
            postscript_name: "Helvetica".to_string(),
            family_name: "Helvetica".to_string(),
            size: 16.0,
            color: false,
        };
        let font = resolve_font(&key);
        let a = rasterize_glyph(&font, 36).expect("must rasterize");
        let b = rasterize_glyph(&font, 36).expect("must rasterize");
        assert!(Arc::ptr_eq(&a, &b), "second call must hit the cache");
    }
}

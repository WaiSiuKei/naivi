// Copyright 2026 the Blitz Authors
// SPDX-License-Identifier: Apache-2.0 OR MIT

//! CoreGraphics glyph rasterization for the naivi CoreText backend (macOS).
//!
//! Mirrors the naive project's proven rasterization strategy (1px dilation,
//! RGBA premultiplied bitmaps) but takes glyph bounds from CoreText
//! (`CTFont::get_bounding_rects_for_glyphs`) instead of font-kit, because the
//! fork's native font key only resolves to a `CTFont` (no font data for
//! cascade fonts) — see the plan (U6). Both font resolution and glyph
//! rasterization are memoized in bounded LRUs: they run on every paint frame,
//! and a fresh CoreGraphics bitmap context per glyph per frame would otherwise
//! be the dominant cost. Glyphs are rasterized in the run's CSS text color.

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
use std::collections::HashMap;
use std::sync::Arc;

/// An RGBA (premultiplied) bitmap of one glyph, plus its pen offset.
#[derive(Clone, Debug)]
pub struct GlyphBitmap {
    /// RGBA premultiplied pixels, row-major, top-to-bottom.
    pub data: Arc<Vec<u8>>,
    pub width: u32,
    pub height: u32,
    /// Offset of the bitmap's left edge from the glyph's pen x (layout units).
    pub offset_x: f32,
    /// Offset of the bitmap's top edge from the baseline (layout units, y-down).
    pub offset_y: f32,
}

/// Whether a postscript name belongs to a macOS system UI font (what
/// `-apple-system`/`system-ui` shape to). CoreText refuses to create these by
/// name and silently substitutes Times, so they must be rebuilt through the
/// UI-font API (or the public PingFang face), mirroring the fork's shaper.
fn is_system_ui_ps(name: &str) -> bool {
    name.starts_with(".SF")
        || name.starts_with(".AppleSystemUIFont")
        || name.starts_with(".PingFang")
}

/// Rebuild a PingFang face from its internal UIDisplay postscript name (e.g.
/// `".PingFangUIDisplaySC-Regular"`). CoreText refuses to create the
/// dot-prefixed system-UI names by name and substitutes Times, but the public
/// face (`"PingFangSC-Regular"`) is creatable normally and shares the same
/// glyph outlines, so the rasterizer reproduces the fork's Han-script
/// fallback font.
fn ping_fang_font(key: &MacNativeFont) -> CTFont {
    let public = key
        .postscript_name
        .strip_prefix('.')
        .map(|n| n.replace("UIDisplay", ""))
        .unwrap_or_else(|| key.postscript_name.clone());
    let name = CFString::new(&public);
    let descriptor = new_from_postscript_name(&name);
    core_text::font::new_from_descriptor(&descriptor, key.size as f64)
}

/// Rebuild a system UI font from its postscript name via the UI-font API.
///
/// The fork shapes regular weight with `kCTFontSystemFontType` and bold-ish
/// weights (>= 600) with `kCTFontEmphasizedSystemFontType`; the emitted
/// postscript names (".SFNS-Regular", ".SFNS-Bold", ".SFNS-RegularItalic")
/// encode which face was used, so the rasterizer reproduces the same font.
fn system_ui_font(key: &MacNativeFont) -> CTFont {
    let lower = key.postscript_name.to_lowercase();
    let ui_type = if lower.contains("bold")
        || lower.contains("semibold")
        || lower.contains("medium")
        || lower.contains("black")
        || lower.contains("heavy")
        || lower.contains("light")
    {
        core_text::font::kCTFontEmphasizedSystemFontType
    } else {
        core_text::font::kCTFontSystemFontType
    };
    let font = core_text::font::new_ui_font_for_language(ui_type, key.size as f64, None);
    if lower.contains("italic") {
        if let Some(italic) = font.clone_with_symbolic_traits(
            core_text::font_descriptor::kCTFontItalicTrait,
            core_text::font_descriptor::kCTFontItalicTrait,
        ) {
            return italic;
        }
    }
    font
}

#[derive(Clone, PartialEq, Eq, Hash)]
struct CacheKey {
    postscript: String,
    size_bits: u32,
    glyph: u32,
    color: [u8; 3],
}

/// Bounded least-recently-used cache with O(1) lookups (generation counters)
/// and a byte budget so a page with many large glyphs cannot exhaust memory.
struct GlyphCache {
    map: HashMap<CacheKey, (Arc<GlyphBitmap>, u64)>,
    cap: usize,
    bytes: usize,
    byte_budget: usize,
    next: u64,
}

impl GlyphCache {
    fn new() -> Self {
        Self {
            map: HashMap::new(),
            cap: 256,
            bytes: 0,
            byte_budget: 128 * 1024 * 1024,
            next: 0,
        }
    }

    fn get(&mut self, key: &CacheKey) -> Option<Arc<GlyphBitmap>> {
        let entry = self.map.get_mut(key)?;
        entry.1 = self.next;
        self.next += 1;
        Some(entry.0.clone())
    }

    fn insert(&mut self, key: CacheKey, bmp: Arc<GlyphBitmap>) {
        if self.map.contains_key(&key) {
            return;
        }
        self.bytes += bmp.data.len();
        self.map.insert(key.clone(), (bmp, self.next));
        self.next += 1;
        while self.map.len() > self.cap || self.bytes > self.byte_budget {
            let Some(evict) = self
                .map
                .iter()
                .min_by_key(|(_, e)| e.1)
                .map(|(k, _)| k.clone())
            else {
                break;
            };
            if let Some((bmp, _)) = self.map.remove(&evict) {
                self.bytes -= bmp.data.len();
            }
        }
    }
}

thread_local! {
    static GLYPH_CACHE: RefCell<GlyphCache> = RefCell::new(GlyphCache::new());
}

/// Bounded cache of resolved `CTFont`s keyed by (postscript name, size).
struct FontCache {
    map: HashMap<(String, u32), (CTFont, u64)>,
    cap: usize,
    next: u64,
}

impl FontCache {
    fn get(&mut self, key: &(String, u32)) -> Option<CTFont> {
        let entry = self.map.get_mut(key)?;
        entry.1 = self.next;
        self.next += 1;
        Some(entry.0.clone())
    }

    fn insert(&mut self, key: (String, u32), font: CTFont) {
        if self.map.contains_key(&key) {
            return;
        }
        self.map.insert(key.clone(), (font, self.next));
        self.next += 1;
        while self.map.len() > self.cap {
            let Some(evict) = self
                .map
                .iter()
                .min_by_key(|(_, e)| e.1)
                .map(|(k, _)| k.clone())
            else {
                break;
            };
            self.map.remove(&evict);
        }
    }
}

impl FontCache {
    fn new() -> Self {
        Self {
            map: HashMap::new(),
            cap: 128,
            next: 0,
        }
    }
}

thread_local! {
    static FONT_CACHE: RefCell<FontCache> = RefCell::new(FontCache::new());
}

/// Resolve a fork-issued self-describing font key to a `CTFont` (KTD4),
/// memoized in a bounded LRU. `new_from_descriptor` is infallible (unknown
/// names get a CoreText fallback); system UI names go through the UI-font API
/// so `-apple-system` runs rasterize with SF, not a Times substitution.
pub fn resolve_font(key: &MacNativeFont) -> CTFont {
    let cache_key = (key.postscript_name.clone(), key.size.to_bits());
    if let Some(font) = FONT_CACHE.with(|c| c.borrow_mut().get(&cache_key)) {
        return font;
    }
    let font = if is_system_ui_ps(&key.postscript_name) {
        if key.postscript_name.starts_with(".PingFang") {
            ping_fang_font(key)
        } else {
            system_ui_font(key)
        }
    } else {
        let name = CFString::new(&key.postscript_name);
        let descriptor = new_from_postscript_name(&name);
        core_text::font::new_from_descriptor(&descriptor, key.size as f64)
    };
    FONT_CACHE.with(|c| c.borrow_mut().insert(cache_key, font.clone()));
    font
}

/// Maximum single-glyph bitmap area in pixels; beyond this (pathological font
/// sizes) the glyph is skipped instead of allocating a huge buffer.
const MAX_GLYPH_PIXELS: u64 = 64 * 1024 * 1024;

/// Rasterize a single glyph into an RGBA bitmap via CoreGraphics.
///
/// Glyph bounds come from `CTFont::get_bounding_rects_for_glyphs` (glyph
/// space, y-up, origin at the pen/baseline). The bitmap is dilated by one
/// pixel on every side so antialiasing is not clipped; the returned offsets
/// place the bitmap's top-left relative to the pen position in layout space
/// (y-down), matching how naive offsets its dilated raster bounds. The glyph
/// is filled with `color` (premultiplied by CoreGraphics). Returns `None` for
/// blank glyphs (zero bounds) or glyphs too large to rasterize.
pub fn rasterize_glyph(font: &CTFont, glyph: u32, color: [u8; 3]) -> Option<Arc<GlyphBitmap>> {
    // CoreText glyph ids are 16-bit; keep the full `u32` in the cache key so
    // distinct ids never collide, but make the truncation explicit.
    debug_assert!(glyph <= u16::MAX as u32);
    let key = CacheKey {
        postscript: font.postscript_name(),
        size_bits: (font.pt_size() as f32).to_bits(),
        glyph,
        color,
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
    if width as u64 * height as u64 > MAX_GLYPH_PIXELS {
        return None;
    }
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
    // Fill with the run's CSS text color (CoreGraphics writes premultiplied
    // pixels into the buffer).
    ctx.set_rgb_fill_color(
        color[0] as f64 / 255.0,
        color[1] as f64 / 255.0,
        color[2] as f64 / 255.0,
        1.0,
    );
    ctx.set_text_drawing_mode(CGTextDrawingMode::CGTextFill);
    ctx.set_allows_antialiasing(true);
    ctx.set_should_antialias(true);
    font.draw_glyphs(&[glyph as u16], &[CGPoint::new(0.0, 0.0)], ctx.clone());
    ctx.restore();

    // Bitmap top edge in glyph space (y-up) is `origin_y + height`; in layout
    // space (y-down) that is the negated value.
    let bmp = Arc::new(GlyphBitmap {
        data: Arc::new(bytes),
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

    fn helvetica_key(size: f32) -> MacNativeFont {
        MacNativeFont {
            postscript_name: "Helvetica".to_string(),
            family_name: "Helvetica".to_string(),
            size,
            color: false,
        }
    }

    #[test]
    fn resolves_fork_native_font_key() {
        // "Helvetica" is present on every macOS system.
        let font = resolve_font(&helvetica_key(16.0));
        assert_eq!(font.postscript_name(), "Helvetica");
    }

    #[test]
    fn system_ui_key_resolves_to_sf_not_times() {
        // The fork shapes `-apple-system`/`system-ui` with the SF UI font and
        // emits ".SFNS-*" postscript names. Resolving those by name makes
        // CoreText substitute Times, so the rasterizer must use the UI-font
        // API and get SF back (same face the shaper used).
        for ps in [".SFNS-Regular", ".SFNS-Bold", ".SFNS-RegularItalic"] {
            let key = MacNativeFont {
                postscript_name: ps.to_string(),
                family_name: "System Font".to_string(),
                size: 32.0,
                color: false,
            };
            let resolved = resolve_font(&key).postscript_name();
            assert!(
                resolved.starts_with(".SF") || resolved.contains("SF"),
                "expected an SF face for {ps}, got {resolved}"
            );
        }
    }

    #[test]
    fn ping_fang_key_resolves_to_ping_fang_not_times() {
        // The fork's Han-script fallback returns the PingFang UI face
        // (".PingFangUIDisplaySC-Regular"); resolving it by name makes
        // CoreText substitute Times, so the rasterizer maps it to the public
        // face and must not get Times back.
        for ps in [".PingFangUIDisplaySC-Regular", ".PingFangUIDisplaySC-Semibold"] {
            let key = MacNativeFont {
                postscript_name: ps.to_string(),
                family_name: "PingFang SC".to_string(),
                size: 32.0,
                color: false,
            };
            let resolved = resolve_font(&key).postscript_name();
            assert!(
                resolved.contains("PingFang"),
                "expected a PingFang face for {ps}, got {resolved}"
            );
        }
    }

    #[test]
    fn rasterizes_latin_glyph_in_ink_color() {
        let font = resolve_font(&helvetica_key(16.0));
        // Resolve the glyph id from its name instead of hard-coding a font
        // table offset, which is fragile across system font versions.
        let glyph = font.get_glyph_with_name("A");
        let bmp = rasterize_glyph(&font, glyph as u32, [200, 30, 30])
            .expect("must rasterize");
        assert!(bmp.width > 1 && bmp.height > 1);
        let has_ink = bmp.data.chunks_exact(4).any(|p| p[3] > 0);
        assert!(has_ink, "must have ink");
        // The glyph must be drawn in the requested color: some opaque pixel
        // should have a red channel above its blue channel.
        let colored = bmp
            .data
            .chunks_exact(4)
            .any(|p| p[3] > 0 && p[0] > p[2] + 40);
        assert!(colored, "glyph must be rasterized in the requested color");
        // Offsets must be sane for a 16pt capital glyph (a few px on each side).
        assert!(
            bmp.offset_y < 0.0 && bmp.offset_y > -(bmp.height as f32),
            "offset_y={} must sit above the baseline within the bitmap",
            bmp.offset_y
        );
    }

    #[test]
    fn blank_glyph_returns_none() {
        // A space has no outline, so its bounds are empty and rasterization
        // must report None (the caller skips it) rather than a blank bitmap.
        let font = resolve_font(&helvetica_key(16.0));
        let glyph = font.get_glyph_with_name("space");
        assert!(
            rasterize_glyph(&font, glyph as u32, [0, 0, 0]).is_none(),
            "blank glyph must be skipped"
        );
    }

    #[test]
    fn rasterize_is_memoized_per_key() {
        let font = resolve_font(&helvetica_key(16.0));
        let a = rasterize_glyph(&font, 36, [0, 0, 0]).expect("must rasterize");
        let b = rasterize_glyph(&font, 36, [0, 0, 0]).expect("must rasterize");
        assert!(Arc::ptr_eq(&a, &b), "same key must hit the cache");
        // A different color is a different key: distinct bitmap, no collision.
        let c = rasterize_glyph(&font, 36, [10, 10, 10]).expect("must rasterize");
        assert!(!Arc::ptr_eq(&a, &c), "color must be part of the cache key");
    }

    #[test]
    fn glyph_cache_evicts_and_promotes() {
        let mut cache = GlyphCache::new();
        cache.cap = 2;
        let key_a = CacheKey { postscript: "A".into(), size_bits: 0, glyph: 1, color: [0, 0, 0] };
        let key_b = CacheKey { postscript: "B".into(), size_bits: 0, glyph: 2, color: [0, 0, 0] };
        let key_c = CacheKey { postscript: "C".into(), size_bits: 0, glyph: 3, color: [0, 0, 0] };
        let bmp = Arc::new(GlyphBitmap {
            data: Arc::new(vec![0; 4]),
            width: 1,
            height: 1,
            offset_x: 0.0,
            offset_y: 0.0,
        });
        cache.insert(key_a.clone(), bmp.clone());
        cache.insert(key_b.clone(), bmp.clone());
        // Touch A so it is most-recently-used.
        assert!(cache.get(&key_a).is_some());
        cache.insert(key_c.clone(), bmp.clone());
        assert!(cache.get(&key_b).is_none(), "B must have been evicted (LRU)");
        assert!(cache.get(&key_a).is_some(), "A was most recent, must survive");
        assert!(cache.get(&key_c).is_some());
    }
}

//! COLRv1 color glyph rasterization via tiny-skia (U7 / R10, R11).
//!
//! Maps skrifa's [`ColorPainter`] callbacks onto a [`tiny_skia::Pixmap`]:
//! transforms, glyph/box clips (an accumulated device-space [`Mask`] stack),
//! Solid / Linear / Radial / Sweep gradient fills, and blend-mode layers.
//! Output is a premultiplied RGBA [`RasterImageData`] that the caller draws
//! with `scene.draw_image` — mirroring the macOS CoreText bitmap seam
//! (`draw_glyph_run_native` in `text.rs`). When a font has no COLR data for a
//! glyph, or the paint graph fails, the caller falls back to the monochrome
//! outline path (U7, "无 COLR 时回退单色").
//!
//! Results are memoized in a bounded LRU keyed by (blob id, font index,
//! glyph id, size, normalized coords) with a byte budget mirroring the macOS
//! `GLYPH_CACHE` (128 MiB).

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

use anyrender::PaintScene;
use blitz_dom::node::{RasterImageData, TextBrush};
use blitz_dom::BaseDocument;
use font_types::BoundingBox;
use kurbo::{Affine, Vec2};
use parley::layout::Glyph;
use parley::GlyphRun;
use peniko::{ImageAlphaType, ImageQuality};
use skrifa::color::{
    Brush, ColorGlyphCollection, ColorGlyphFormat, ColorPainter, ColorPalettes, CompositeMode,
    Extend, Transform as SkrifaTransform,
};
use skrifa::instance::{LocationRef, NormalizedCoord, Size};
use skrifa::outline::{DrawSettings, OutlinePen};
use skrifa::{FontRef, GlyphId, MetadataProvider};
use tiny_skia::{
    BlendMode, Color, FillRule, FilterQuality, GradientStop, LinearGradient, Mask, Paint, Path,
    PathBuilder, Pixmap, PixmapPaint, Point, RadialGradient, Rect, Shader, SpreadMode,
    SweepGradient, Transform,
};

use crate::render::to_peniko_image;
use crate::text::{draw_glyphs_mono, draw_text_decorations};

/// Maximum single-glyph bitmap area in pixels (mirrors the macOS
/// `MAX_GLYPH_PIXELS`); beyond this the glyph is skipped, falling back to
/// monochrome.
const MAX_GLYPH_PIXELS: u64 = 64 * 1024 * 1024;

/// Byte budget for the color-glyph raster cache (mirrors the macOS
/// `GLYPH_CACHE`).
const GLYPH_CACHE_BUDGET: usize = 128 * 1024 * 1024;

thread_local! {
    static GLYPH_CACHE: RefCell<ColorGlyphCache> =
        RefCell::new(ColorGlyphCache::new(GLYPH_CACHE_BUDGET));
}

// ── bounded LRU cache ─────────────────────────────────────────────

#[derive(Clone, PartialEq, Eq, Hash)]
struct CacheKey {
    blob_id: u64,
    index: u32,
    glyph: u32,
    size_bits: u32,
    /// FNV-1a hash of the normalized variation coordinates (avoids a Vec
    /// allocation per glyph on the draw path).
    coords_hash: u64,
}

struct CachedGlyph {
    raster: Arc<RasterImageData>,
    offset_x: i32,
    offset_y: i32,
    bytes: usize,
    stamp: u64,
}

/// LRU of color glyph rasters with a byte budget, evicting least-recently
/// used entries (mirrors `GlyphCache` in blitz-macos-text).
struct ColorGlyphCache {
    map: HashMap<CacheKey, CachedGlyph>,
    bytes: usize,
    byte_budget: usize,
    next: u64,
}

impl ColorGlyphCache {
    fn new(byte_budget: usize) -> Self {
        Self {
            map: HashMap::new(),
            bytes: 0,
            byte_budget,
            next: 0,
        }
    }

    fn get(&mut self, key: &CacheKey) -> Option<(Arc<RasterImageData>, i32, i32)> {
        let entry = self.map.get_mut(key)?;
        entry.stamp = self.next;
        self.next += 1;
        Some((entry.raster.clone(), entry.offset_x, entry.offset_y))
    }

    fn insert(&mut self, key: CacheKey, raster: Arc<RasterImageData>, offset_x: i32, offset_y: i32) {
        if self.map.contains_key(&key) {
            return;
        }
        let bytes = (raster.width * raster.height * 4) as usize;
        self.bytes += bytes;
        self.map.insert(
            key,
            CachedGlyph {
                raster,
                offset_x,
                offset_y,
                bytes,
                stamp: self.next,
            },
        );
        self.next += 1;
        if self.bytes > self.byte_budget {
            // Evict least-recently-used entries in one pass (sorted by stamp)
            // rather than re-scanning the map once per eviction.
            let mut order: Vec<CacheKey> = self.map.keys().cloned().collect();
            order.sort_by_key(|k| self.map[k].stamp);
            for key in order {
                if self.bytes <= self.byte_budget {
                    break;
                }
                if let Some(entry) = self.map.remove(&key) {
                    self.bytes -= entry.bytes;
                }
            }
        }
    }

    #[cfg(test)]
    fn bytes(&self) -> usize {
        self.bytes
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.map.len()
    }
}

// ── rasterization entry point ─────────────────────────────────────

/// Rasterize one glyph's COLRv1 paint graph into a premultiplied RGBA
/// `RasterImageData` (cache-checked).
///
/// Returns `(raster, offset_x, offset_y)` where the offsets place the
/// bitmap's top-left relative to the pen position in layout space (y-down),
/// matching the macOS `GlyphBitmap` convention. `None` when the font has no
/// COLR data for the glyph or the paint graph fails — the caller falls back
/// to monochrome.
fn color_glyph(
    font_ref: &FontRef<'_>,
    blob_id: u64,
    index: u32,
    glyph: u32,
    font_size: f32,
    coords: &[i16],
) -> Option<(Arc<RasterImageData>, i32, i32)> {
    let key = CacheKey {
        blob_id,
        index,
        glyph,
        size_bits: font_size.to_bits(),
        coords_hash: hash_coords(coords),
    };
    if let Some(hit) = GLYPH_CACHE.with(|c| c.borrow_mut().get(&key)) {
        return Some(hit);
    }
    let (raster, offset_x, offset_y) = rasterize_color(font_ref, glyph, font_size, coords)?;
    let raster = Arc::new(raster);
    GLYPH_CACHE.with(|c| {
        c.borrow_mut()
            .insert(key, Arc::clone(&raster), offset_x, offset_y)
    });
    Some((raster, offset_x, offset_y))
}

/// FNV-1a hash of normalized variation coordinates for the cache key.
fn hash_coords(coords: &[i16]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &c in coords {
        h ^= c as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// Draw one glyph run's color glyphs as rasterized images (COLRv1).
///
/// Mirrors the macOS `draw_glyph_run_native` bitmap seam. Returns `true` when
/// the run contained at least one COLR glyph — the caller then skips the
/// monochrome path. Glyphs in the same run WITHOUT COLR data (mixed runs)
/// still go through the monochrome `draw_glyphs` path so nothing is dropped.
pub(crate) fn draw_glyph_run_color<'a>(
    scene: &mut impl PaintScene,
    glyph_run: &GlyphRun<'a, TextBrush>,
    doc: &BaseDocument,
    transform: Affine,
    scale: f64,
) -> bool {
    let run = glyph_run.run();
    let font = run.font();
    let data = font.data.data();
    let index = font.index;
    let Ok(font_ref) = FontRef::from_index(data, index) else {
        return false;
    };
    let font_size = run.font_size();
    let coords = run.normalized_coords().to_vec();
    let blob_id = font.data.id();

    let mut color_draws: Vec<(f32, f32, Arc<RasterImageData>, i32, i32)> = Vec::new();
    let mut mono_glyphs: Vec<Glyph> = Vec::new();

    for glyph in glyph_run.positioned_glyphs() {
        match color_glyph(&font_ref, blob_id, index, glyph.id as u32, font_size, &coords) {
            Some((raster, ox, oy)) => color_draws.push((glyph.x, glyph.y, raster, ox, oy)),
            None => mono_glyphs.push(glyph),
        }
    }

    if color_draws.is_empty() {
        return false;
    }

    for (x, y, raster, ox, oy) in color_draws {
        let brush =
            to_peniko_image(&raster, ImageQuality::Medium, ImageAlphaType::AlphaPremultiplied);
        let t = transform.pre_translate(Vec2::new(x as f64 + ox as f64, y as f64 + oy as f64));
        scene.draw_image(brush.as_ref(), t);
    }

    if !mono_glyphs.is_empty() {
        draw_glyphs_mono(scene, glyph_run, doc, transform, scale, mono_glyphs.into_iter());
    }
    draw_text_decorations(scene, glyph_run, doc, transform);
    true
}

/// Rasterize a COLRv1 glyph into premultiplied RGBA.
///
/// Returns `None` when the font has no COLR data for this glyph, or when the
/// paint graph fails — the caller then falls back to the monochrome outline
/// path (U7).
fn rasterize_color(
    font: &FontRef<'_>,
    glyph_id: u32,
    font_size: f32,
    coords: &[i16],
) -> Option<(RasterImageData, i32, i32)> {
    let gid = GlyphId::new(glyph_id);
    let collection = ColorGlyphCollection::new(font);
    let glyph = collection.get(gid)?;
    if !matches!(glyph.format(), ColorGlyphFormat::ColrV1) {
        return None;
    }
    let upem = font
        .metrics(Size::unscaled(), LocationRef::default())
        .units_per_em as f32;
    if upem <= 0.0 {
        return None;
    }
    let scale = font_size / upem;

    let coords: Vec<NormalizedCoord> =
        coords.iter().map(|&c| NormalizedCoord::from_bits(c)).collect();
    let location = LocationRef::new(&coords);

    // Bounding box in pixels (font units scaled by `size`). COLRv1 provides a
    // clip box; without one we fall back to a generous font-size box.
    let (x_min, y_max, width, height) = match glyph.bounding_box(location, Size::new(font_size)) {
        Some(bb) => {
            let x_min = bb.x_min.floor();
            let y_max = bb.y_max.ceil();
            let w = ((bb.x_max - bb.x_min).ceil()).max(1.0);
            let h = ((bb.y_max - bb.y_min).ceil()).max(1.0);
            (x_min, y_max, w, h)
        }
        None => {
            let s = (font_size * 1.5).ceil();
            (0.0f32, s, s, s)
        }
    };
    if width as u64 * height as u64 > MAX_GLYPH_PIXELS {
        return None;
    }
    let width = width as u32;
    let height = height as u32;

    let mut painter = TinySkiaColorPainter::new(font.clone(), width, height);
    // Font units (y-up) → canvas (y-down), scaled to font_size and translated
    // so the clip box top-left lands at the canvas origin.
    painter.transform = Transform::from_row(scale, 0.0, 0.0, -scale, -x_min, y_max);

    glyph.paint(location, &mut painter).ok()?;

    let bytes = painter.take_data()?;
    // Bearing convention matches `GlyphBitmap`: the offset is the bitmap
    // top-left relative to the glyph origin. The canvas origin (bitmap
    // top-left) sits at (x_min, -y_max) in glyph space, so the offset is
    // (x_min, -y_max).
    Some((
        RasterImageData::new(width, height, Arc::new(bytes)),
        x_min as i32,
        -(y_max as i32),
    ))
}

// ── ColorPainter → tiny-skia adapter ──────────────────────────────

/// Current drawing state: the target pixmap stack (top = active layer), the
/// accumulated device-space clip [`Mask`], and the canvas transform.
struct TinySkiaColorPainter<'a> {
    targets: Vec<Pixmap>,
    layer_modes: Vec<BlendMode>,
    palettes: ColorPalettes<'a>,
    font: FontRef<'a>,
    size: (u32, u32),
    transform: Transform,
    transform_stack: Vec<Transform>,
    clip: Option<Mask>,
    clip_stack: Vec<Option<Mask>>,
}

impl<'a> TinySkiaColorPainter<'a> {
    fn new(font: FontRef<'a>, width: u32, height: u32) -> Self {
        let mut pixmap = Pixmap::new(width, height).expect("color glyph pixmap allocation");
        pixmap.fill(Color::TRANSPARENT);
        let palettes = ColorPalettes::new(&font);
        Self {
            targets: vec![pixmap],
            layer_modes: Vec::new(),
            palettes,
            font,
            size: (width, height),
            transform: Transform::identity(),
            transform_stack: Vec::new(),
            clip: None,
            clip_stack: Vec::new(),
        }
    }

    /// Consume the top (base) target's raw premultiplied RGBA bytes.
    fn take_data(&mut self) -> Option<Vec<u8>> {
        let pixmap = self.targets.first_mut()?;
        Some(pixmap.data().to_vec())
    }

    fn pixmap(&mut self) -> &mut Pixmap {
        self.targets.last_mut().unwrap()
    }

    fn palette_color(&self, palette_index: u16, alpha: f32) -> Option<Color> {
        let rec = *self.palettes.get(0)?.colors().get(palette_index as usize)?;
        Color::from_rgba(
            rec.red as f32 / 255.0,
            rec.green as f32 / 255.0,
            rec.blue as f32 / 255.0,
            (rec.alpha as f32 * alpha).clamp(0.0, 1.0),
        )
    }

    fn resolve_stops(&self, stops: &[skrifa::color::ColorStop]) -> Option<Vec<GradientStop>> {
        stops
            .iter()
            .map(|stop| {
                let color = self.palette_color(stop.palette_index, stop.alpha)?;
                Some(GradientStop::new(stop.offset, color))
            })
            .collect()
    }

    fn brush_to_shader(&self, brush: Brush<'_>) -> Option<Shader<'static>> {
        match brush {
            Brush::Solid {
                palette_index,
                alpha,
            } => Some(Shader::SolidColor(self.palette_color(palette_index, alpha)?)),
            Brush::LinearGradient {
                p0,
                p1,
                color_stops,
                extend,
            } => {
                let stops = self.resolve_stops(color_stops)?;
                // tiny-skia 0.12: gradient factories return `Option<Shader>`
                // directly (degenerate gradients collapse to a solid).
                LinearGradient::new(
                    Point::from_xy(p0.x, p0.y),
                    Point::from_xy(p1.x, p1.y),
                    stops,
                    map_extend(extend),
                    Transform::identity(),
                )
            }
            Brush::RadialGradient {
                c0,
                r0,
                c1,
                r1,
                color_stops,
                extend,
            } => {
                let stops = self.resolve_stops(color_stops)?;
                RadialGradient::new(
                    Point::from_xy(c0.x, c0.y),
                    r0,
                    Point::from_xy(c1.x, c1.y),
                    r1,
                    stops,
                    map_extend(extend),
                    Transform::identity(),
                )
            }
            Brush::SweepGradient {
                c0,
                start_angle,
                end_angle,
                color_stops,
                extend,
            } => {
                let stops = self.resolve_stops(color_stops)?;
                SweepGradient::new(
                    Point::from_xy(c0.x, c0.y),
                    start_angle,
                    end_angle,
                    stops,
                    map_extend(extend),
                    Transform::identity(),
                )
            }
        }
    }

    /// Outline of `gid` in font units for use as a clip path.
    ///
    /// The paint tree (and thus this path) is in font units with y-up; the
    /// canvas transform already applies the y-flip + scale, so the outline is
    /// emitted **without** flipping y (flipping here too would double-flip and
    /// misplace the clip).
    fn glyph_outline_path(&self, gid: GlyphId) -> Option<Path> {
        let outline = self.font.outline_glyphs().get(gid)?;
        let mut builder = PathBuilder::new();
        {
            struct Pen<'p> {
                builder: &'p mut PathBuilder,
            }
            impl OutlinePen for Pen<'_> {
                fn move_to(&mut self, x: f32, y: f32) {
                    self.builder.move_to(x, y);
                }
                fn line_to(&mut self, x: f32, y: f32) {
                    self.builder.line_to(x, y);
                }
                fn quad_to(&mut self, cx0: f32, cy0: f32, x: f32, y: f32) {
                    self.builder.quad_to(cx0, cy0, x, y);
                }
                fn curve_to(&mut self, cx0: f32, cy0: f32, cx1: f32, cy1: f32, x: f32, y: f32) {
                    self.builder.cubic_to(cx0, cy0, cx1, cy1, x, y);
                }
                fn close(&mut self) {
                    self.builder.close();
                }
            }
            let settings =
                DrawSettings::unhinted(Size::unscaled(), LocationRef::default());
            outline.draw(settings, &mut Pen { builder: &mut builder }).ok()?;
        }
        builder.finish()
    }

    /// Push a clip path (font units) rasterized into a device-space mask and
    /// intersected with the current accumulated clip.
    fn push_clip_path(&mut self, path: &Path) {
        let (w, h) = self.size;
        let prev = self.clip.take();
        let mut mask = Mask::new(w, h).unwrap();
        mask.fill_path(path, FillRule::Winding, true, self.transform);
        if let Some(prev) = prev.as_ref() {
            for (d, s) in mask.data_mut().iter_mut().zip(prev.data()) {
                *d = ((*d as u32 * *s as u32) / 255) as u8;
            }
        }
        self.clip_stack.push(prev);
        self.clip = Some(mask);
    }
}

impl ColorPainter for TinySkiaColorPainter<'_> {
    fn push_transform(&mut self, transform: SkrifaTransform) {
        self.transform_stack.push(self.transform);
        self.transform = self.transform.pre_concat(skrifa_to_tiny(transform));
    }

    fn pop_transform(&mut self) {
        if let Some(prev) = self.transform_stack.pop() {
            self.transform = prev;
        }
    }

    fn push_clip_glyph(&mut self, glyph_id: GlyphId) {
        if let Some(path) = self.glyph_outline_path(glyph_id) {
            self.push_clip_path(&path);
        }
    }

    fn push_clip_box(&mut self, clip_box: BoundingBox<f32>) {
        if let Some(rect) = Rect::from_ltrb(
            clip_box.x_min,
            clip_box.y_min,
            clip_box.x_max,
            clip_box.y_max,
        ) {
            self.push_clip_path(&PathBuilder::from_rect(rect));
        }
    }

    fn pop_clip(&mut self) {
        self.clip = self.clip_stack.pop().unwrap_or(None);
    }

    fn fill(&mut self, brush: Brush<'_>) {
        let Some(shader) = self.brush_to_shader(brush) else {
            return;
        };
        let mut paint = Paint::default();
        paint.shader = shader;
        // Fill a huge cover rect: the accumulated clip mask decides the
        // painted area. Borrow `clip` and the target pixmap as disjoint
        // fields to satisfy the borrow checker.
        let rect = Rect::from_xywh(-100_000.0, -100_000.0, 200_000.0, 200_000.0).unwrap();
        let path = PathBuilder::from_rect(rect);
        let transform = self.transform;
        let clip = self.clip.as_ref();
        let target = self.targets.last_mut().unwrap();
        target.fill_path(&path, &paint, FillRule::Winding, transform, clip);
    }

    fn push_layer(&mut self, composite_mode: CompositeMode) {
        let (w, h) = self.size;
        let mut child = Pixmap::new(w, h).expect("color glyph layer allocation");
        child.fill(Color::TRANSPARENT);
        self.targets.push(child);
        self.layer_modes.push(map_composite_mode(composite_mode));
    }

    fn pop_layer(&mut self) {
        if let Some(mode) = self.layer_modes.pop() {
            let child = self.targets.pop().unwrap();
            let parent = self.pixmap();
            let pm = PixmapPaint {
                opacity: 1.0,
                blend_mode: mode,
                quality: FilterQuality::Nearest,
            };
            parent.draw_pixmap(0, 0, child.as_ref(), &pm, Transform::identity(), None);
        }
    }
}

// ── enum mappings ─────────────────────────────────────────────────

fn map_extend(extend: Extend) -> SpreadMode {
    match extend {
        Extend::Pad => SpreadMode::Pad,
        Extend::Repeat => SpreadMode::Repeat,
        Extend::Reflect => SpreadMode::Reflect,
        // Malformed font data: fall back to pad.
        Extend::Unknown => SpreadMode::Pad,
    }
}

fn map_composite_mode(mode: CompositeMode) -> BlendMode {
    use skrifa::color::CompositeMode as M;
    match mode {
        M::Clear => BlendMode::Clear,
        M::Src => BlendMode::Source,
        M::Dest => BlendMode::Destination,
        M::SrcOver => BlendMode::SourceOver,
        M::DestOver => BlendMode::DestinationOver,
        M::SrcIn => BlendMode::SourceIn,
        M::DestIn => BlendMode::DestinationIn,
        M::SrcOut => BlendMode::SourceOut,
        M::DestOut => BlendMode::DestinationOut,
        M::SrcAtop => BlendMode::SourceAtop,
        M::DestAtop => BlendMode::DestinationAtop,
        M::Xor => BlendMode::Xor,
        M::Plus => BlendMode::Plus,
        M::Screen => BlendMode::Screen,
        M::Overlay => BlendMode::Overlay,
        M::Darken => BlendMode::Darken,
        M::Lighten => BlendMode::Lighten,
        M::ColorDodge => BlendMode::ColorDodge,
        M::ColorBurn => BlendMode::ColorBurn,
        M::HardLight => BlendMode::HardLight,
        M::SoftLight => BlendMode::SoftLight,
        M::Difference => BlendMode::Difference,
        M::Exclusion => BlendMode::Exclusion,
        M::Multiply => BlendMode::Multiply,
        M::HslHue => BlendMode::Hue,
        M::HslSaturation => BlendMode::Saturation,
        M::HslColor => BlendMode::Color,
        M::HslLuminosity => BlendMode::Luminosity,
        // Malformed font data: fall back to source-over.
        M::Unknown => BlendMode::SourceOver,
    }
}

/// skrifa `Transform { xx, yx, xy, yy, dx, dy }` → tiny-skia `Transform::from_row`
/// (same row-major 2×3 layout).
fn skrifa_to_tiny(t: SkrifaTransform) -> Transform {
    Transform::from_row(t.xx, t.yx, t.xy, t.yy, t.dx, t.dy)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Decompress the bundled Noto Color Emoji woff2 slice into a `FontRef`.
    fn emoji_font() -> FontRef<'static> {
        let woff2 = include_bytes!("../assets/NotoColorEmoji-test.woff2");
        let ttf = wuff::decompress_woff2(woff2).expect("woff2 decompress");
        let leaked = Box::leak(ttf.into_boxed_slice());
        FontRef::from_index(leaked, 0).expect("font parse")
    }

    fn grin_glyph(font: &FontRef<'_>) -> u32 {
        font.charmap()
            .map('\u{1F600}')
            .expect("😀 in cmap")
            .to_u32()
    }

    #[test]
    fn rasterizes_grin_emoji_as_color() {
        let font = emoji_font();
        let gid = grin_glyph(&font);
        // Sanity: the glyph really is COLRv1.
        let collection = ColorGlyphCollection::new(&font);
        let glyph = collection.get(GlyphId::new(gid)).unwrap();
        assert!(matches!(glyph.format(), ColorGlyphFormat::ColrV1));

        let (raster, ox, oy) =
            rasterize_color(&font, gid, 32.0, &[]).expect("rasterized color glyph");
        assert!(raster.width > 0 && raster.height > 0);
        assert!(raster.data.len() >= (raster.width * raster.height * 4) as usize);
        let px = raster.data.as_ref();

        // The bitmap must contain actual colors (not a single monochrome
        // silhouette): count distinct RGB tuples among non-transparent pixels.
        let mut seen: Vec<(u8, u8, u8)> = Vec::new();
        for chunk in px.chunks_exact(4) {
            let a = chunk[3];
            if a == 0 {
                continue;
            }
            let rgb = (chunk[0], chunk[1], chunk[2]);
            if !seen.contains(&rgb) {
                seen.push(rgb);
            }
            if seen.len() >= 2 {
                break;
            }
        }
        assert!(
            seen.len() >= 2,
            "expected >=2 distinct colors in the emoji bitmap, got {seen:?}"
        );
        // Offsets are finite and sane for a 32px glyph.
        assert!(ox >= -128 && ox <= 128 && oy >= -128 && oy <= 128);
    }

    #[test]
    fn non_colr_glyph_falls_back_to_none() {
        // DejaVu Sans has no COLR table: every glyph must fall through to the
        // monochrome path (returns None).
        let woff2 = include_bytes!("../assets/DejaVuSans.woff2");
        let ttf = wuff::decompress_woff2(woff2).expect("woff2 decompress");
        let leaked = Box::leak(ttf.into_boxed_slice());
        let font = FontRef::from_index(leaked, 0).expect("font parse");
        let gid = font.charmap().map('A').expect("A in cmap").to_u32();
        assert!(
            ColorGlyphCollection::new(&font).get(GlyphId::new(gid)).is_none(),
            "DejaVu Sans should have no COLR glyphs"
        );
        assert!(rasterize_color(&font, gid, 32.0, &[]).is_none());
    }

    #[test]
    fn cache_evicts_over_byte_budget() {
        // Budget of 100 bytes holds one 4x4 RGBA entry (64 bytes) but not two.
        let mut cache = ColorGlyphCache::new(100);
        let key = CacheKey {
            blob_id: 1,
            index: 0,
            glyph: 1,
            size_bits: 32.0f32.to_bits(),
            coords_hash: 0,
        };
        let raster = Arc::new(RasterImageData::new(4, 4, Arc::new(vec![0u8; 4 * 4 * 4])));
        cache.insert(key.clone(), raster, 0, 0);
        assert_eq!(cache.len(), 1);
        // A second entry must evict the first (budget exceeded).
        let key2 = CacheKey {
            blob_id: 1,
            index: 0,
            glyph: 2,
            size_bits: 32.0f32.to_bits(),
            coords_hash: 0,
        };
        let raster2 = Arc::new(RasterImageData::new(4, 4, Arc::new(vec![1u8; 4 * 4 * 4])));
        cache.insert(key2.clone(), raster2, 0, 0);
        assert_eq!(cache.len(), 1);
        assert!(cache.bytes() <= 100);
        // The evicted entry is gone; the survivor is still fetchable.
        assert!(cache.get(&key).is_none());
        assert!(cache.get(&key2).is_some());
    }
}

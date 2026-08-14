//! On-demand font slicing subsystem for the wasm target.
//!
//! Ported from the naive project's `crates/naive-text` font stack: Google
//! Fonts `@font-face` CSS parsing ([`slice::parse_font_css`]), a grouped
//! coverage index ([`coverage::CoverageIndex`]), per-script resolution units
//! ([`resolution::resolution_units`]), and a URL-deduped load state machine
//! ([`loader::FontLoader`]).
//!
//! The loader is callback-driven through blitz's `NetProvider` abstraction
//! (KTD2): [`loader::FontLoader::scan_text`] runs synchronously at layout
//! time to decide which slices are missing, and [`loader::FontLoader::complete`]
//! / [`loader::FontLoader::fail`] are driven from the network completion
//! callback on the document's main thread.

pub mod coverage;
pub mod loader;
pub mod resolution;
pub mod selection;
pub mod slice;

pub use coverage::CoverageIndex;
pub use loader::FontLoader;
pub use resolution::{FontResolutionPolicy, ResolutionUnit, TextScript, resolution_units};
pub use selection::{
    FontSliceRequest, find_matching_slice, find_matching_slice_indexed, is_codepoint_covered,
};
pub use slice::{FontLoadState, FontSlice, FontSliceStatus, PendingFontData, parse_font_css};

/// Weight of a font, from 100 (Thin) to 900 (Black).
///
/// Mirrors naive's `FontWeight` so the coverage index can key on an
/// `Eq + Hash` enum instead of fontique's float wrapper.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum FontWeight {
    Thin = 100,
    ExtraLight = 200,
    Light = 300,
    Normal = 400,
    Medium = 500,
    SemiBold = 600,
    Bold = 700,
    ExtraBold = 800,
    Black = 900,
}

impl FontWeight {
    /// Parse a CSS `font-weight` integer (100–900) into a weight, if known.
    pub fn from_u16(w: u16) -> Option<Self> {
        Some(match w {
            100 => Self::Thin,
            200 => Self::ExtraLight,
            300 => Self::Light,
            400 => Self::Normal,
            500 => Self::Medium,
            600 => Self::SemiBold,
            700 => Self::Bold,
            800 => Self::ExtraBold,
            900 => Self::Black,
            _ => return None,
        })
    }

    /// Convert to fontique's float weight for `register_fonts`.
    pub fn to_fontique(self) -> parley::fontique::FontWeight {
        parley::fontique::FontWeight::new(self as i32 as f32)
    }
}

/// Style of a font. Mirrors naive's `FontStyle`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum FontStyle {
    Normal,
    Italic,
    Oblique,
}

impl FontStyle {
    /// Convert to fontique's style for `register_fonts`.
    pub fn to_fontique(self) -> parley::fontique::FontStyle {
        use parley::fontique::FontStyle as Fq;
        match self {
            Self::Normal => Fq::Normal,
            Self::Italic => Fq::Italic,
            Self::Oblique => Fq::Oblique(None),
        }
    }
}

/// A normalized family / weight / style request.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct FontDescriptor {
    pub family: String,
    pub weight: FontWeight,
    pub style: FontStyle,
}

impl FontDescriptor {
    /// Create a descriptor by family name with default weight and style.
    pub fn new(family: impl Into<String>) -> Self {
        Self {
            family: family.into(),
            weight: FontWeight::Normal,
            style: FontStyle::Normal,
        }
    }

    /// Set the weight.
    pub fn with_weight(mut self, weight: FontWeight) -> Self {
        self.weight = weight;
        self
    }

    /// Set the style.
    pub fn with_style(mut self, style: FontStyle) -> Self {
        self.style = style;
        self
    }
}

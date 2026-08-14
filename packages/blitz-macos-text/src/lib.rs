//! Native macOS text rasterization for the naivi CoreText backend.
//!
//! The parley fork shapes text on macOS through CoreText and attaches a
//! self-describing [`parley::MacNativeFont`] to every run (KTD4). This crate
//! resolves that key back to a `CTFont` and rasterizes glyphs through
//! CoreGraphics into RGBA bitmaps — including color glyphs (Apple Color Emoji).
//! `blitz-paint` draws the returned bitmaps into the anyrender scene.
//!
//! On non-macOS targets the crate body is empty: this file only exists as a
//! workspace stub so the member builds everywhere (R7).
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

#[cfg(target_os = "macos")]
mod native;

#[cfg(target_os = "macos")]
pub use native::{GlyphBitmap, resolve_font, rasterize_glyph};

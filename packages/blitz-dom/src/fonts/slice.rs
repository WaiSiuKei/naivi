//! Google Fonts CSS parsing and font slice definitions.
//!
//! Parses `@font-face` CSS rules (as provided by Google Fonts) into
//! [`FontSlice`]s, each of which describes one `unicode-range` subset and its
//! WOFF2 URL. Ported from naive's `crates/naive-text/src/font_slice.rs`.

use std::collections::HashMap;

use crate::fonts::{FontDescriptor, FontStyle, FontWeight};

/// A single `@font-face` rule from Google Fonts CSS.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FontSlice {
    /// The `font-family` value (e.g. "Noto Sans SC").
    pub family: String,
    /// Normalized family / style / weight request represented by this slice.
    pub font: FontDescriptor,
    /// The `unicode-range` value (e.g. "U+4E00-9FFF").
    pub unicode_range: String,
    /// Parsed Unicode ranges: `(start, end)` inclusive code point pairs.
    pub ranges: Vec<(u32, u32)>,
    /// The `src: url(...)` value pointing to the WOFF2 file on fonts.gstatic.com.
    pub url: String,
}

/// Parse Google Fonts `@font-face` CSS into a list of `FontSlice`s.
///
/// Handles the subset format used by Google Fonts CDN:
/// ```css
/// @font-face {
///   font-family: 'Noto Sans SC';
///   font-style: normal;
///   font-weight: 400;
///   src: url(https://fonts.gstatic.com/...) format('woff2');
///   unicode-range: U+4E00-9FFF, U+3400-4DBF;
/// }
/// ```
pub fn parse_font_css(css: &str) -> Vec<FontSlice> {
    let mut slices = Vec::new();
    let mut pos = 0;

    while let Some(start) = css[pos..].find("@font-face") {
        let block_start = pos + start;
        // Find the opening brace
        let brace_open = match css[block_start..].find('{') {
            Some(i) => block_start + i + 1,
            None => break,
        };
        // Find the closing brace (naive — doesn't handle nested braces)
        let brace_close = match css[brace_open..].find('}') {
            Some(i) => brace_open + i,
            None => break,
        };

        let block = &css[brace_open..brace_close];
        pos = brace_close + 1;

        let family = extract_css_value(block, "font-family");
        let font_style = extract_css_value(block, "font-style").unwrap_or_else(|| "normal".into());
        let font_weight = extract_css_value(block, "font-weight").unwrap_or_else(|| "400".into());
        let url = extract_url(block);
        let unicode_range = extract_css_value(block, "unicode-range");

        let Some(family) = family else { continue };
        let Some(url) = url else { continue };
        let Some(ref range_str) = unicode_range else {
            continue;
        };

        let style = match parse_font_style(&font_style) {
            Some(style) => style,
            None => continue,
        };
        let weight = match parse_font_weight(&font_weight) {
            Some(weight) => weight,
            None => continue,
        };

        let ranges = parse_unicode_ranges(range_str);

        slices.push(FontSlice {
            family: strip_quotes(&family),
            font: FontDescriptor::new(strip_quotes(&family))
                .with_style(style)
                .with_weight(weight),
            unicode_range: range_str.clone(),
            ranges,
            url,
        });
    }

    slices
}

fn parse_font_style(value: &str) -> Option<FontStyle> {
    match strip_quotes(value).as_str() {
        "normal" => Some(FontStyle::Normal),
        "italic" => Some(FontStyle::Italic),
        _ => None,
    }
}

fn parse_font_weight(value: &str) -> Option<FontWeight> {
    FontWeight::from_u16(strip_quotes(value).parse::<u16>().ok()?)
}

/// Check if a URL is a WOFF2 subset slice (contains the `.N.woff2` pattern
/// like `.4.woff2`).
pub fn is_subset_url(url: &str) -> bool {
    // Google Fonts subset format: .../fontname.N.woff2 where N is one or more digits
    if let Some(woff2_pos) = url.rfind(".woff2") {
        let before = &url[..woff2_pos];
        // The char before ".woff2" should be a digit (the N in .N.woff2)
        if let Some(last_byte) = before.bytes().last() {
            return last_byte.is_ascii_digit();
        }
    }
    false
}

/// Extract a CSS property value from a declaration block.
fn extract_css_value(block: &str, property: &str) -> Option<String> {
    let search = format!("{property}:");
    let start = block.find(&search)? + search.len();
    let value_part = block[start..].trim_start();
    // Find end of value (semicolon or end of block)
    let end = value_part.find(';').unwrap_or(value_part.len());
    Some(value_part[..end].trim().to_string())
}

/// Extract `url(...)` from a `src` declaration.
fn extract_url(block: &str) -> Option<String> {
    let src = extract_css_value(block, "src")?;
    let url_start = src.find("url(")? + 4;
    let url_part = &src[url_start..];
    let url_end = url_part.find(')')?;
    let url = url_part[..url_end].trim();
    // Strip quotes if present
    let url = url.trim_matches('"').trim_matches('\'');
    Some(url.to_string())
}

/// Strip leading/trailing quotes from a CSS value.
fn strip_quotes(s: &str) -> String {
    s.trim_matches('"').trim_matches('\'').to_string()
}

/// Parse `unicode-range` values like "U+4E00-9FFF, U+3400-4DBF, U+FF01-FF5E".
fn parse_unicode_ranges(range_str: &str) -> Vec<(u32, u32)> {
    let mut ranges = Vec::new();
    for part in range_str.split(',') {
        let part = part.trim();
        // Remove "U+" prefix
        let hex_part = part.strip_prefix("U+").unwrap_or(part);
        if let Some(dash_pos) = hex_part.find('-') {
            let start = u32::from_str_radix(&hex_part[..dash_pos], 16).ok();
            let end = u32::from_str_radix(&hex_part[dash_pos + 1..], 16).ok();
            if let (Some(s), Some(e)) = (start, end) {
                ranges.push((s, e));
            }
        } else if let Ok(cp) = u32::from_str_radix(hex_part, 16) {
            ranges.push((cp, cp));
        }
    }
    ranges
}

/// State for tracking loaded / loading / failed font slices.
#[derive(Default)]
pub struct FontLoadState {
    /// Set of font slice URLs that have been fully loaded.
    pub loaded: HashMap<String, ()>,
    /// Set of font slice URLs currently being fetched.
    pub loading: HashMap<String, ()>,
    /// Set of font slice URLs that failed to load.
    pub failed: HashMap<String, ()>,
}

/// Decoded font bytes plus the metadata required for registration.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingFontData {
    pub family: String,
    pub weight: FontWeight,
    pub style: FontStyle,
    pub source_url: String,
    pub bytes: Vec<u8>,
}

impl PendingFontData {
    pub fn font(&self) -> FontDescriptor {
        FontDescriptor::new(&self.family)
            .with_weight(self.weight)
            .with_style(self.style)
    }
}

impl FontLoadState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Check if a slice URL has been loaded, is loading, or has failed.
    pub fn status(&self, url: &str) -> FontSliceStatus {
        if self.loaded.contains_key(url) {
            FontSliceStatus::Loaded
        } else if self.loading.contains_key(url) {
            FontSliceStatus::Loading
        } else if self.failed.contains_key(url) {
            FontSliceStatus::Failed
        } else {
            FontSliceStatus::NotStarted
        }
    }

    /// Mark a URL as loading. Returns `false` if it was already started.
    pub fn begin(&mut self, url: &str) -> bool {
        if !matches!(self.status(url), FontSliceStatus::NotStarted) {
            return false;
        }
        self.loading.insert(url.to_owned(), ());
        true
    }

    pub fn complete(&mut self, url: &str) {
        self.loading.remove(url);
        self.loaded.insert(url.to_owned(), ());
    }

    pub fn fail(&mut self, url: &str) {
        self.loading.remove(url);
        self.loaded.remove(url);
        self.failed.insert(url.to_owned(), ());
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FontSliceStatus {
    NotStarted,
    Loading,
    Loaded,
    Failed,
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_CSS: &str = r#"
@font-face {
  font-family: 'Noto Sans SC';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/notosanssc/v37/k3kCo84MPvpLmixcA63oeAL7Iqp5IZJF9bmaG9_FnYxNbPzS5HE.ttf) format('truetype');
  unicode-range: U+4E00-9FFF, U+3400-4DBF;
}
@font-face {
  font-family: 'Noto Sans SC';
  font-style: normal;
  font-weight: 700;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/notosanssc/v37/k3kCo84MPvpLmixcA63oeAL7Iqp5IZJF9bmaG9_FnYxNbPzS5HE.0.woff2) format('woff2');
  unicode-range: U+FF01-FF5E;
}
"#;

    #[test]
    fn parses_realistic_google_fonts_css() {
        let slices = parse_font_css(SAMPLE_CSS);
        assert_eq!(slices.len(), 2);

        let first = &slices[0];
        assert_eq!(first.family, "Noto Sans SC");
        assert_eq!(first.font.weight, FontWeight::Normal);
        assert_eq!(first.font.style, FontStyle::Normal);
        assert!(first.url.contains("notosanssc"));
        assert_eq!(first.unicode_range, "U+4E00-9FFF, U+3400-4DBF");
        assert_eq!(first.ranges, vec![(0x4E00, 0x9FFF), (0x3400, 0x4DBF)]);

        let second = &slices[1];
        assert_eq!(second.font.weight, FontWeight::Bold);
        assert!(is_subset_url(&second.url));
        assert!(!is_subset_url(&first.url));
    }

    #[test]
    fn parses_unicode_range_edge_cases() {
        let css = r#"
@font-face {
  font-family: 'Test';
  src: url(https://example.com/test.woff2) format('woff2');
  unicode-range: U+0041, U+0025-00FF, U+4E00-?, U+ff01-ff5e;
}
"#;
        let slices = parse_font_css(css);
        assert_eq!(slices.len(), 1);
        // Single U+0041; range U+0025-00FF; wildcard U+4E00-? is skipped by
        // the parser (the trailing '?' fails u32 parse on the end); case is
        // normalized by u32::from_str_radix.
        assert_eq!(slices[0].ranges, vec![(0x41, 0x41), (0x25, 0xFF), (0xFF01, 0xFF5E)]);
    }

    #[test]
    fn whole_font_without_unicode_range_is_skipped() {
        let css = r#"
@font-face {
  font-family: 'NoSubset';
  src: url(https://example.com/nosubset.woff2) format('woff2');
}
"#;
        assert!(parse_font_css(css).is_empty());
    }

    #[test]
    fn subset_url_detection() {
        assert!(is_subset_url("https://fonts.gstatic.com/s/noto/v37/f.4.woff2"));
        assert!(is_subset_url("https://fonts.gstatic.com/s/noto/v37/f.14.woff2"));
        assert!(!is_subset_url("https://fonts.gstatic.com/s/noto/v37/f.woff2"));
        assert!(!is_subset_url("https://fonts.gstatic.com/s/noto/v37/f.ttf"));
    }

    #[test]
    fn load_state_dedup_and_transitions() {
        let mut state = FontLoadState::new();
        let url = "https://example.com/f.0.woff2";
        assert_eq!(state.status(url), FontSliceStatus::NotStarted);
        assert!(state.begin(url));
        assert_eq!(state.status(url), FontSliceStatus::Loading);
        // Re-begin while loading is refused
        assert!(!state.begin(url));
        state.complete(url);
        assert_eq!(state.status(url), FontSliceStatus::Loaded);
        assert!(!state.begin(url));

        // A failed URL never retries within the session
        let bad = "https://example.com/bad.woff2";
        state.begin(bad);
        state.fail(bad);
        assert_eq!(state.status(bad), FontSliceStatus::Failed);
        assert!(!state.begin(bad));
    }
}

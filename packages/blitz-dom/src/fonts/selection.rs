//! Font slice selection — linear reference and indexed lookup.
//!
//! `find_matching_slice` is the linear reference; `find_matching_slice_indexed`
//! is the coverage-index-backed production path. Both share the same metadata
//! + full-coverage predicate so their results are identical.
//!
//! Ported from naive's `crates/naive-text/src/font_selection.rs`, with one
//! delta: default-ignorable code points (ZWJ, VS16, bidi controls, …) are
//! exempt from the coverage check so emoji ZWJ/VS16 sequences resolve
//! against their visible code points only.

use crate::fonts::coverage::CoverageIndex;
use crate::fonts::resolution::ResolutionUnit;
use crate::fonts::slice::FontSlice;
use crate::fonts::{FontDescriptor, FontStyle, FontWeight};

/// Check if a code point is covered by any of the given Unicode ranges.
pub fn is_codepoint_covered(cp: u32, ranges: &[(u32, u32)]) -> bool {
    ranges.iter().any(|&(start, end)| cp >= start && cp <= end)
}

/// Whether a code point is default-ignorable and never requires coverage.
///
/// ZWJ (U+200D), ZWNJ (U+200C), variation selectors (U+FE00–U+FE0F), ZWSP,
/// bidi controls, word joiners, and similar format characters do not appear
/// in font unicode-range tables or cmaps. Requiring them to be covered would
/// make every emoji ZWJ sequence (👨‍👩‍👧‍👦) and VS16 form (❤️) a permanent miss.
pub fn is_default_ignorable(cp: u32) -> bool {
    matches!(cp,
        0x00AD |                // soft hyphen
        0x034F |                // combining grapheme joiner
        0x061C |                // arabic letter mark
        0x180B..=0x180D | 0x180F | // mongolian free variation selectors
        0x200B..=0x200F |       // ZWSP / ZWNJ / ZWJ / LRM / RLM
        0x202A..=0x202E |       // bidi embedding / override / isolate
        0x2060..=0x2064 | 0x2066..=0x206F | // word joiner + invisible ops
        0x3164 |                // hangul filler
        0xFE00..=0xFE0F |       // variation selectors 1-16
        0xFEFF |                // ZWNBSP
        0xFFA0 |                // halfwidth hangul filler
        0x1BCA0..=0x1BCA3 |     // shorthand format controls
        0x1D173..=0x1D17A       // musical format controls
    )
}

/// Request used to match a slice against a complete resolution unit.
#[derive(Clone, Debug)]
pub struct FontSliceRequest<'a> {
    pub font: FontDescriptor,
    pub style: FontStyle,
    pub weight: FontWeight,
    pub text: &'a str,
}

/// Whether `slice` matches the request metadata and completely covers `unit`.
///
/// Default-ignorable code points are exempt from the coverage requirement
/// (see [`is_default_ignorable`]).
fn slice_covers_unit(
    slice: &FontSlice,
    request: &FontSliceRequest<'_>,
    unit: &ResolutionUnit,
) -> bool {
    let text = unit.text(request.text);
    slice.font.family == request.font.family
        && slice.font.style == request.style
        && slice.font.weight == request.weight
        && text.chars().all(|ch| {
            let cp = ch as u32;
            is_default_ignorable(cp) || is_codepoint_covered(cp, &slice.ranges)
        })
}

/// Find the first slice matching metadata and complete unit coverage.
pub fn find_matching_slice<'a>(
    request: &FontSliceRequest<'_>,
    unit: &ResolutionUnit,
    slices: &'a [FontSlice],
) -> Option<&'a FontSlice> {
    slices
        .iter()
        .find(|slice| slice_covers_unit(slice, request, unit))
}

/// Indexed variant of [`find_matching_slice`].
///
/// Locates candidate slices via the coverage index using the unit's first
/// character (O(log n) candidate lookup), then runs the *same* full-coverage
/// check over candidates in original slice order. For an index that contains
/// the passed `slices`, the result is identical to [`find_matching_slice`]:
/// any slice that fully covers the unit also covers its first character, so
/// it is among the candidates. Empty units fall back to the linear scan so
/// the two paths agree in every case.
pub fn find_matching_slice_indexed<'a>(
    index: &mut CoverageIndex,
    request: &FontSliceRequest<'_>,
    unit: &ResolutionUnit,
    slices: &'a [FontSlice],
) -> Option<&'a FontSlice> {
    let text = unit.text(request.text);
    if text.is_empty() {
        return find_matching_slice(request, unit, slices);
    }
    let first = text.chars().next().unwrap() as u32;
    let candidates = index.lookup(&request.font.family, request.style, request.weight, first);
    candidates.into_iter().find_map(|i| {
        slices
            .get(i)
            .filter(|s| slice_covers_unit(s, request, unit))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fonts::slice::parse_font_css;
    use crate::fonts::resolution::resolution_units;

    const CSS: &str = r#"
@font-face {
  font-family: 'Noto Sans';
  font-style: normal;
  font-weight: 400;
  src: url(https://example.com/latin.woff2) format('woff2');
  unicode-range: U+0000-00FF;
}
@font-face {
  font-family: 'Noto Sans SC';
  font-style: normal;
  font-weight: 400;
  src: url(https://example.com/cjk.woff2) format('woff2');
  unicode-range: U+4E00-9FFF;
}
@font-face {
  font-family: 'Noto Color Emoji';
  font-style: normal;
  font-weight: 400;
  src: url(https://example.com/emoji.woff2) format('woff2');
  unicode-range: U+1F600-1F64F;
}
"#;

    fn request<'a>(text: &'a str, family: &'a str) -> FontSliceRequest<'a> {
        FontSliceRequest {
            font: FontDescriptor::new(family),
            style: FontStyle::Normal,
            weight: FontWeight::Normal,
            text,
        }
    }

    #[test]
    fn linear_and_indexed_agree() {
        let slices = parse_font_css(CSS);
        let mut index = CoverageIndex::new();
        for (i, s) in slices.iter().enumerate() {
            index.insert_slice(&s.family, s.font.style, s.font.weight, &s.ranges, i);
        }
        for text in ["abc", "中文", "😀", "a中😀", " "] {
            for unit in resolution_units(text) {
                for family in ["Noto Sans", "Noto Sans SC", "Noto Color Emoji"] {
                    let linear = find_matching_slice(&request(text, family), &unit, &slices);
                    let indexed = find_matching_slice_indexed(&mut index, &request(text, family), &unit, &slices);
                    assert_eq!(indexed, linear, "text={text:?} unit={:?} family={family}", unit.byte_range);
                }
            }
        }
    }

    #[test]
    fn partial_coverage_rejects_slice() {
        // "中文" is not fully covered by "Noto Sans" (latin only) nor by
        // "Noto Sans SC" if a CJK char falls outside its range — here 中/文
        // are both in U+4E00-9FFF, so SC matches and Sans does not.
        let slices = parse_font_css(CSS);
        let units = resolution_units("中文");
        let unit = &units[0];
        assert!(find_matching_slice(&request("中文", "Noto Sans"), unit, &slices).is_none());
        assert!(find_matching_slice(&request("中文", "Noto Sans SC"), unit, &slices).is_some());
    }

    #[test]
    fn default_ignorable_exempt_from_coverage() {
        let slices = parse_font_css(CSS);
        // "😀\u{fe0f}" = U+1F600 + VS16 (U+FE0F), one grapheme unit. The
        // emoji slice covers U+1F600; VS16 is default-ignorable so it must not
        // force a miss.
        let text = "\u{1F600}\u{FE0F}";
        let units = resolution_units(text);
        assert_eq!(units.len(), 1);
        assert!(
            find_matching_slice(&request(text, "Noto Color Emoji"), &units[0], &slices).is_some()
        );
        // A base emoji that is NOT covered still misses, VS16 or not.
        let text = "\u{2764}\u{FE0F}"; // ❤️ outside U+1F600-1F64F
        let units = resolution_units(text);
        assert!(
            find_matching_slice(&request(text, "Noto Color Emoji"), &units[0], &slices).is_none()
        );
    }

    #[test]
    fn zwj_sequence_uses_visible_codepoints() {
        // Family emoji "👨👩👧👦" = man ZWJ woman ZWJ girl ZWJ boy. With
        // default-ignorable exemption, a slice covering U+1F468..U+1F466 etc.
        // matches even though ZWJ (U+200D) is absent from the ranges.
        let css = r#"
@font-face {
  font-family: 'Noto Color Emoji';
  font-style: normal;
  font-weight: 400;
  src: url(https://example.com/emoji.woff2) format('woff2');
  unicode-range: U+1F466-1F469, U+1F468;
}
"#;
        let slices = parse_font_css(css);
        let text = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}";
        let units = resolution_units(text);
        assert!(units.len() == 1, "ZWJ sequence must be one grapheme unit");
        assert!(
            find_matching_slice(&request(text, "Noto Color Emoji"), &units[0], &slices).is_some()
        );
    }
}

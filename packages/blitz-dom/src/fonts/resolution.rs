//! Platform-neutral font resolution policy primitives.
//!
//! This module describes *which* font candidates should be tried. The
//! resolution policy maps a text script to the Noto family that covers it on
//! the Google Fonts pipeline (R6). Ported from naive's
//! `crates/naive-text/src/resolution.rs`, extended with Hebrew / Arabic
//! scripts for the RTL requirement (R2, AE4).

use std::collections::HashMap;
use std::ops::Range;

use unicode_segmentation::UnicodeSegmentation;

use crate::fonts::FontDescriptor;

/// Script categories used by the shared resolution policy.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TextScript {
    Latin,
    Cjk,
    Emoji,
    /// Hebrew block (RTL).
    Hebrew,
    /// Arabic script, incl. Arabic presentation forms (RTL).
    Arabic,
    Common,
    Unknown,
}

/// A grapheme-bounded unit that can be resolved as one shaping-sensitive
/// piece. The range indexes the original UTF-8 text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolutionUnit {
    pub byte_range: Range<usize>,
    pub script: TextScript,
}

impl ResolutionUnit {
    pub fn text<'a>(&self, source: &'a str) -> &'a str {
        &source[self.byte_range.clone()]
    }
}

/// Ordered font candidates grouped by their resolution role.
///
/// Consumed by the loader (U4/U5): when a CSS family cannot cover a unit, the
/// policy's `candidates_for(script)` list drives which Noto family the loader
/// schedules slices for.
#[derive(Clone, Debug, Default)]
pub struct FontResolutionPolicy {
    pub primary: Vec<FontDescriptor>,
    pub by_script: HashMap<TextScript, Vec<FontDescriptor>>,
    pub fallback: Vec<FontDescriptor>,
    pub generation: u64,
}

impl FontResolutionPolicy {
    pub fn new() -> Self {
        Self::default()
    }

    /// The default Noto policy for the Google Fonts wasm pipeline (R6).
    ///
    /// Scripts map to the Noto family that covers them; the fallback list
    /// keeps Latin text working when no CSS family applies.
    pub fn noto_default() -> Self {
        let mut by_script = HashMap::new();
        by_script.insert(TextScript::Latin, vec![FontDescriptor::new("Noto Sans")]);
        by_script.insert(TextScript::Cjk, vec![FontDescriptor::new("Noto Sans SC")]);
        by_script.insert(
            TextScript::Emoji,
            vec![FontDescriptor::new("Noto Color Emoji")],
        );
        by_script.insert(
            TextScript::Hebrew,
            vec![FontDescriptor::new("Noto Sans Hebrew")],
        );
        by_script.insert(
            TextScript::Arabic,
            vec![FontDescriptor::new("Noto Sans Arabic")],
        );
        Self {
            primary: Vec::new(),
            by_script,
            fallback: vec![FontDescriptor::new("Noto Sans")],
            generation: 0,
        }
    }

    /// Noto family names for every script present in `text`, in policy order,
    /// deduplicated. Used by the document pre-scan to add per-script fallback
    /// candidates when the CSS font-family has no coverage (R6).
    pub fn families_for_text(&self, text: &str) -> Vec<String> {
        let mut result: Vec<String> = Vec::new();
        for unit in resolution_units(text) {
            for font in self.candidates_for(unit.script) {
                if !result.contains(&font.family) {
                    result.push(font.family);
                }
            }
        }
        result
    }

    #[cfg(test)]
    pub fn with_primary(mut self, fonts: Vec<FontDescriptor>) -> Self {
        self.primary = fonts;
        self
    }

    #[cfg(test)]
    pub fn with_script_fonts(mut self, script: TextScript, fonts: Vec<FontDescriptor>) -> Self {
        self.by_script.insert(script, fonts);
        self
    }

    #[cfg(test)]
    pub fn with_fallback(mut self, fonts: Vec<FontDescriptor>) -> Self {
        self.fallback = fonts;
        self
    }

    /// Return candidates in policy order without duplicate font requests.
    pub fn candidates_for(&self, script: TextScript) -> Vec<FontDescriptor> {
        let mut result = Vec::new();
        for font in self
            .primary
            .iter()
            .chain(self.by_script.get(&script).into_iter().flatten())
            .chain(self.fallback.iter())
        {
            if !result.contains(font) {
                result.push(font.clone());
            }
        }
        result
    }
}

/// Split text into extended grapheme-bounded resolution units.
pub fn resolution_units(text: &str) -> Vec<ResolutionUnit> {
    let mut units = Vec::new();
    let mut byte_start = 0;
    let mut previous_script = TextScript::Unknown;

    for grapheme in text.graphemes(true) {
        let byte_end = byte_start + grapheme.len();
        let mut script = classify_grapheme(grapheme);
        if script == TextScript::Common {
            if previous_script != TextScript::Unknown && previous_script != TextScript::Common {
                script = previous_script;
            }
        } else {
            previous_script = script;
        }
        units.push(ResolutionUnit {
            byte_range: byte_start..byte_end,
            script,
        });
        byte_start = byte_end;
    }

    units
}

/// Classify a grapheme using the shared policy's script taxonomy.
pub fn classify_grapheme(grapheme: &str) -> TextScript {
    if grapheme.chars().any(is_emoji_scalar) {
        return TextScript::Emoji;
    }

    for ch in grapheme.chars() {
        let cp = ch as u32;
        let script = if is_latin(cp) {
            TextScript::Latin
        } else if is_cjk(cp) {
            TextScript::Cjk
        } else if is_hebrew(cp) {
            TextScript::Hebrew
        } else if is_arabic(cp) {
            TextScript::Arabic
        } else if ch.is_whitespace() || ch.is_ascii_punctuation() || is_common_unicode(cp) {
            TextScript::Common
        } else {
            TextScript::Unknown
        };
        if script != TextScript::Common {
            return script;
        }
    }

    TextScript::Common
}

fn is_latin(cp: u32) -> bool {
    matches!(cp,
        0x0041..=0x005A | 0x0061..=0x007A |
        0x00C0..=0x02AF | 0x1E00..=0x1EFF | 0x2C60..=0x2C7F | 0xA720..=0xA7FF
    )
}

fn is_cjk(cp: u32) -> bool {
    matches!(cp,
        0x2E80..=0x2FFF | 0x3000..=0x303F | 0x3040..=0x30FF |
        0x31F0..=0x31FF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF |
        0xF900..=0xFAFF | 0xFE30..=0xFE6F | 0xFF00..=0xFFEF
    )
}

fn is_hebrew(cp: u32) -> bool {
    matches!(cp, 0x0590..=0x05FF | 0xFB1D..=0xFB4F)
}

fn is_arabic(cp: u32) -> bool {
    matches!(cp,
        0x0600..=0x06FF | 0x0750..=0x077F | 0x08A0..=0x08FF |
        0xFB50..=0xFDFF | 0xFE70..=0xFEFF
    )
}

fn is_emoji_scalar(ch: char) -> bool {
    let cp = ch as u32;
    matches!(cp,
        0x1F000..=0x1FAFF | 0x1FC00..=0x1FFFD | 0x2600..=0x27BF |
        0x2300..=0x23FF | 0x2B00..=0x2BFF | 0xFE0F
    )
}

fn is_common_unicode(cp: u32) -> bool {
    matches!(cp, 0x2000..=0x206F | 0x20A0..=0x20CF | 0x2100..=0x214F | 0xFE00..=0xFE0F)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fonts::FontWeight;

    fn noto(script: TextScript, family: &str) -> FontDescriptor {
        let _ = script;
        FontDescriptor::new(family).with_weight(FontWeight::Normal)
    }

    #[test]
    fn script_detection_for_all_categories() {
        assert_eq!(classify_grapheme("A"), TextScript::Latin);
        assert_eq!(classify_grapheme("中"), TextScript::Cjk);
        assert_eq!(classify_grapheme("😀"), TextScript::Emoji);
        assert_eq!(classify_grapheme("א"), TextScript::Hebrew); // Hebrew alef
        assert_eq!(classify_grapheme("م"), TextScript::Arabic); // Arabic meem
        assert_eq!(classify_grapheme(" "), TextScript::Common);
        assert_eq!(classify_grapheme("."), TextScript::Common);
    }

    #[test]
    fn resolution_units_follow_grapheme_boundaries() {
        // "a中😀" => 3 units (a, 中, emoji), each single grapheme.
        let units = resolution_units("a中😀");
        let scripts: Vec<_> = units.iter().map(|u| u.script).collect();
        assert_eq!(scripts, vec![TextScript::Latin, TextScript::Cjk, TextScript::Emoji]);
        // Byte ranges are contiguous and cover the whole string.
        assert_eq!(units[0].byte_range.start, 0);
        assert_eq!(units.last().unwrap().byte_range.end, "a中😀".len());
    }

    #[test]
    fn common_punctuation_inherits_previous_script() {
        // "中。" — the '。' is CJK punctuation (is_cjk covers 0x3000-0x303F),
        // so both units are Cjk.
        let units = resolution_units("中。");
        assert!(units.iter().all(|u| u.script == TextScript::Cjk));
        // "a." — ASCII '.' is Common and follows Latin, so it inherits Latin.
        let units = resolution_units("a.");
        assert_eq!(units[0].script, TextScript::Latin);
        assert_eq!(units[1].script, TextScript::Latin);
    }

    #[test]
    fn script_families_maps_each_script_to_noto() {
        let policy = FontResolutionPolicy::noto_default();
        // Each script maps to its Noto family; the fallback (Noto Sans) is
        // appended after the by_script candidate.
        assert_eq!(policy.families_for_text("a"), vec!["Noto Sans".to_string()]);
        assert_eq!(
            policy.families_for_text("中"),
            vec!["Noto Sans SC".to_string(), "Noto Sans".to_string()]
        );
        assert_eq!(
            policy.families_for_text("😀"),
            vec!["Noto Color Emoji".to_string(), "Noto Sans".to_string()]
        );
        assert_eq!(
            policy.families_for_text("שלום"),
            vec!["Noto Sans Hebrew".to_string(), "Noto Sans".to_string()]
        );
        assert_eq!(
            policy.families_for_text("مرحبا"),
            vec!["Noto Sans Arabic".to_string(), "Noto Sans".to_string()]
        );
        // Mixed text yields each family once, in first-appearance order.
        assert_eq!(
            policy.families_for_text("a中😀"),
            vec![
                "Noto Sans".to_string(),
                "Noto Sans SC".to_string(),
                "Noto Color Emoji".to_string()
            ]
        );
    }

    #[test]
    fn policy_candidates_dedup_in_order() {
        let primary = FontDescriptor::new("Primary");
        let latin = noto(TextScript::Latin, "Noto Sans");
        let cjk = noto(TextScript::Cjk, "Noto Sans SC");
        let fallback = noto(TextScript::Latin, "Noto Sans");
        let policy = FontResolutionPolicy::new()
            .with_primary(vec![primary.clone()])
            .with_script_fonts(TextScript::Latin, vec![latin.clone()])
            .with_script_fonts(TextScript::Cjk, vec![cjk.clone()])
            .with_fallback(vec![fallback.clone()]);
        // Latin: primary, then by_script Latin, then fallback (deduped).
        assert_eq!(
            policy.candidates_for(TextScript::Latin),
            vec![primary.clone(), latin.clone()]
        );
        // CJK: primary, then by_script CJK, then fallback (Noto Sans is a
        // distinct descriptor from the Primary family, so it is kept).
        assert_eq!(
            policy.candidates_for(TextScript::Cjk),
            vec![primary.clone(), cjk.clone(), noto(TextScript::Latin, "Noto Sans")]
        );
    }
}

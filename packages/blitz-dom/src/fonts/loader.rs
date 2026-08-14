//! Platform-independent font slice loading state machine.
//!
//! Unlike naive's Future-based `FontBytesFetcher`, this loader is driven
//! through blitz's callback-style `NetProvider` (KTD2): [`FontLoader::scan_text`]
//! runs synchronously during the pre-layout coverage scan and returns the
//! slice URLs that must be fetched; the document issues those fetches and
//! drives [`FontLoader::complete`] / [`FontLoader::fail`] from the network
//! completion callback on the document's main thread.

use crate::fonts::coverage::CoverageIndex;
use crate::fonts::resolution::{resolution_units, ResolutionUnit};
use crate::fonts::selection::{find_matching_slice_indexed, FontSliceRequest};
use crate::fonts::slice::{FontLoadState, FontSlice, FontSliceStatus, PendingFontData};
use crate::fonts::{FontDescriptor, FontStyle, FontWeight};

/// Long-lived loader whose state is reused across text scans.
#[derive(Default)]
pub struct FontLoader {
    state: FontLoadState,
    /// Coverage index kept in sync with the current slice set.
    coverage: CoverageIndex,
    /// All parsed Google Fonts slices known to this loader.
    slices: Vec<FontSlice>,
    /// Whether `coverage` needs a full re-sync before the next scan. Only
    /// `set_slices` changes the slice set, so re-syncing on every scan would
    /// re-insert every range per text node per frame.
    coverage_dirty: bool,
}

impl FontLoader {
    pub fn new() -> Self {
        Self::default()
    }

    /// Replace the slice set (e.g. after a Google Fonts CSS fetch). The
    /// coverage index re-syncs once on the next scan.
    pub fn set_slices(&mut self, slices: Vec<FontSlice>) {
        self.slices = slices;
        self.coverage_dirty = true;
    }

    pub fn slices(&self) -> &[FontSlice] {
        &self.slices
    }

    pub fn state(&self) -> &FontLoadState {
        &self.state
    }

    pub fn status(&self, url: &str) -> FontSliceStatus {
        self.state.status(url)
    }

    /// Synchronous pre-scan of one text run.
    ///
    /// Keeps the coverage index in sync with the current slice set (insert is
    /// incremental and idempotent per `(range, index)`), walks the text's
    /// resolution units, and returns the URLs of slices this text still needs:
    /// newly begun (`NotStarted` → `Loading`) plus ones already in flight
    /// (`Loading`). Loaded / failed URLs are never returned (dedup). The
    /// caller dedupes fetches via its pending map and records the waiting
    /// nodes for targeted invalidation.
    pub fn scan_text(
        &mut self,
        text: &str,
        family: &str,
        style: FontStyle,
        weight: FontWeight,
    ) -> Vec<String> {
        let units = resolution_units(text);
        self.scan_text_units(text, &units, family, style, weight)
    }

    /// Pre-scan over already-computed resolution units (avoids re-segmenting
    /// the same text once per candidate family).
    pub fn scan_text_units(
        &mut self,
        text: &str,
        units: &[ResolutionUnit],
        family: &str,
        style: FontStyle,
        weight: FontWeight,
    ) -> Vec<String> {
        // Re-sync the coverage index only when the slice set changed, not on
        // every scan. Insert is incremental and idempotent per (range, index).
        if self.coverage_dirty {
            self.coverage.clear();
            for (i, slice) in self.slices.iter().enumerate() {
                self.coverage.insert_slice(
                    &slice.family,
                    slice.font.style,
                    slice.font.weight,
                    &slice.ranges,
                    i,
                );
            }
            self.coverage_dirty = false;
        }

        let font = FontDescriptor::new(family).with_style(style).with_weight(weight);
        let mut needed = Vec::new();
        for unit in units {
            let request = FontSliceRequest {
                font: font.clone(),
                style,
                weight,
                text,
            };
            let Some(slice) =
                find_matching_slice_indexed(&mut self.coverage, &request, unit, &self.slices)
            else {
                continue;
            };
            match self.state.status(&slice.url) {
                FontSliceStatus::Loaded | FontSliceStatus::Failed => continue,
                FontSliceStatus::Loading => {
                    if !needed.contains(&slice.url) {
                        needed.push(slice.url.clone());
                    }
                }
                FontSliceStatus::NotStarted => {
                    if self.state.begin(&slice.url) && !needed.contains(&slice.url) {
                        needed.push(slice.url.clone());
                    }
                }
            }
        }
        needed
    }

    /// Record a successful fetch for `url`. Returns the pending font data
    /// the document should decode and register, or `None` when the URL was
    /// never scheduled or is unknown.
    pub fn complete(&mut self, url: &str, bytes: Vec<u8>) -> Option<PendingFontData> {
        let slice = self.slices.iter().find(|s| s.url == url)?;
        let pending = PendingFontData {
            family: slice.family.clone(),
            weight: slice.font.weight,
            style: slice.font.style,
            source_url: url.to_owned(),
            bytes,
        };
        self.state.complete(url);
        Some(pending)
    }

    /// Record a failed fetch for `url`; the slice is never retried this
    /// session (R4 / AE5).
    pub fn fail(&mut self, url: &str) {
        self.state.fail(url);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fonts::slice::parse_font_css;

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
  src: url(https://example.com/cjk.0.woff2) format('woff2');
  unicode-range: U+4E00-4EFF;
}
@font-face {
  font-family: 'Noto Sans SC';
  font-style: normal;
  font-weight: 400;
  src: url(https://example.com/cjk.1.woff2) format('woff2');
  unicode-range: U+4F00-4FFF;
}
"#;

    fn loader_with_slices() -> FontLoader {
        let mut loader = FontLoader::new();
        loader.set_slices(parse_font_css(CSS));
        loader
    }

    #[test]
    fn scan_returns_missing_slice_urls_only() {
        let mut loader = loader_with_slices();
        // "中" is U+4E2D → cjk.0.woff2. "A" is covered by latin.
        let urls = loader.scan_text("A中", "Noto Sans SC", FontStyle::Normal, FontWeight::Normal);
        assert_eq!(urls, vec!["https://example.com/cjk.0.woff2".to_string()]);
        // Latin needs nothing from Noto Sans SC.
        let urls = loader.scan_text("A", "Noto Sans SC", FontStyle::Normal, FontWeight::Normal);
        assert!(urls.is_empty());
    }

    #[test]
    fn scan_reports_loading_urls_and_dedupes_fetch() {
        let mut loader = loader_with_slices();
        // Same CJK text scanned twice: first scan begins the URL and returns
        // it; while still loading a re-scan re-reports it (the caller dedupes
        // fetches via its pending map).
        let urls = loader.scan_text("中中", "Noto Sans SC", FontStyle::Normal, FontWeight::Normal);
        assert_eq!(urls.len(), 1);
        let again = loader.scan_text("中", "Noto Sans SC", FontStyle::Normal, FontWeight::Normal);
        assert_eq!(again, urls);
        // Once loaded, no longer reported.
        loader.complete(&urls[0], vec![1, 2, 3]);
        let done = loader.scan_text("中", "Noto Sans SC", FontStyle::Normal, FontWeight::Normal);
        assert!(done.is_empty());
    }

    #[test]
    fn multiple_units_schedule_multiple_slices() {
        let mut loader = loader_with_slices();
        // "中" (U+4E2D → cjk.0) and "企" (U+4F01 → cjk.1) are different slices.
        let urls = loader.scan_text("中企", "Noto Sans SC", FontStyle::Normal, FontWeight::Normal);
        assert_eq!(urls.len(), 2);
        assert!(urls.contains(&"https://example.com/cjk.0.woff2".to_string()));
        assert!(urls.contains(&"https://example.com/cjk.1.woff2".to_string()));
    }

    #[test]
    fn complete_yields_pending_font_data() {
        let mut loader = loader_with_slices();
        let urls = loader.scan_text("中", "Noto Sans SC", FontStyle::Normal, FontWeight::Normal);
        assert_eq!(urls.len(), 1);
        let url = &urls[0];
        let pending = loader.complete(url, vec![1, 2, 3]).expect("pending data");
        assert_eq!(pending.family, "Noto Sans SC");
        assert_eq!(pending.weight, FontWeight::Normal);
        assert_eq!(pending.source_url, *url);
        assert_eq!(loader.status(url), FontSliceStatus::Loaded);
        // A completed URL is never scheduled again.
        let again = loader.scan_text("中", "Noto Sans SC", FontStyle::Normal, FontWeight::Normal);
        assert!(again.is_empty());
    }

    #[test]
    fn fail_marks_url_and_never_retries() {
        let mut loader = loader_with_slices();
        let urls = loader.scan_text("中", "Noto Sans SC", FontStyle::Normal, FontWeight::Normal);
        let url = &urls[0];
        loader.fail(url);
        assert_eq!(loader.status(url), FontSliceStatus::Failed);
        let again = loader.scan_text("中", "Noto Sans SC", FontStyle::Normal, FontWeight::Normal);
        assert!(again.is_empty(), "failed slice must not be re-scheduled");
    }

    #[test]
    fn unknown_url_complete_is_none() {
        let mut loader = loader_with_slices();
        assert!(loader.complete("https://example.com/unknown.woff2", vec![]).is_none());
    }
}

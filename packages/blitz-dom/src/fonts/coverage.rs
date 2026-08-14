//! Coverage index for Google Fonts slices.
//!
//! A grouped, start-sorted interval index: `(family, style, weight)` →
//! intervals that map to slice positions. `lookup` locates candidate
//! intervals with bounded binary searches, then scans only the candidate
//! window — misses cost O(log n), hits cost O(log n + m) where `m` is the
//! number of candidates (overlapping ranges are tolerated).
//!
//! Ported from naive's `crates/naive-text/src/font_coverage.rs`.

use std::collections::HashMap;

use crate::fonts::{FontStyle, FontWeight};

/// One indexed interval for a `(family, style, weight)` group.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct IntervalEntry {
    /// Inclusive Unicode code-point range.
    range: (u32, u32),
    /// Position of the owning slice in the slice array.
    slice_index: usize,
}

/// Start-sorted intervals plus a per-prefix maximum end, which lets `lookup`
/// find the earliest possibly-covering entry with a second binary search.
#[derive(Clone, Debug, Default)]
struct Group {
    entries: Vec<IntervalEntry>,
    /// `prefix_max_end[i]` = max end among `entries[0..=i]`.
    prefix_max_end: Vec<u32>,
}

/// Grouped, start-sorted coverage index.
#[derive(Clone, Debug, Default)]
pub struct CoverageIndex {
    groups: HashMap<(String, FontStyle, FontWeight), Group>,
    /// Interval comparisons performed by the most recent `lookup`:
    /// both binary searches plus the bounded candidate scan.
    last_probes: usize,
}

impl CoverageIndex {
    pub fn new() -> Self {
        Self::default()
    }

    /// Drop all groups. Called by the loader when the slice set is replaced
    /// (`set_slices`), so stale ranges from a previous set are not queried.
    pub fn clear(&mut self) {
        self.groups.clear();
    }

    /// Incrementally insert one slice's unicode ranges into its
    /// `(family, style, weight)` group.
    ///
    /// Idempotent per `(range, slice_index)` — re-inserting the same slice
    /// (stable slice array) adds nothing and skips the re-sort. The group is
    /// kept sorted by range start and its prefix-max-end array rebuilt so
    /// `lookup` can binary-search both bounds.
    pub fn insert_slice(
        &mut self,
        family: &str,
        style: FontStyle,
        weight: FontWeight,
        ranges: &[(u32, u32)],
        slice_index: usize,
    ) {
        let group = self
            .groups
            .entry((family.to_string(), style, weight))
            .or_default();
        let mut pushed = false;
        for &range in ranges {
            let entry = IntervalEntry { range, slice_index };
            if !group.entries.contains(&entry) {
                group.entries.push(entry);
                pushed = true;
            }
        }
        if pushed {
            group.entries.sort_unstable_by_key(|e| e.range.0);
            group.prefix_max_end.clear();
            group.prefix_max_end.reserve(group.entries.len());
            let mut max_end = 0;
            for e in &group.entries {
                max_end = max_end.max(e.range.1);
                group.prefix_max_end.push(max_end);
            }
        }
    }

    /// Return candidate slice indices whose ranges contain `cp`, in ascending
    /// slice-index order (== original slice array order).
    ///
    /// Two bounded binary searches locate the candidate window (first index
    /// with range start > `cp`, then the earliest index whose prefix-max end
    /// still reaches `cp`), so a miss scans nothing. Only the true candidate
    /// window is enumerated; overlapping ranges yield multiple candidates and
    /// duplicate slice indices are collapsed.
    pub fn lookup(
        &mut self,
        family: &str,
        style: FontStyle,
        weight: FontWeight,
        cp: u32,
    ) -> Vec<usize> {
        self.last_probes = 0;
        let key = (family.to_string(), style, weight);
        let Some(group) = self.groups.get(&key) else {
            return Vec::new();
        };
        if group.entries.is_empty() {
            return Vec::new();
        }

        // Search 1: first index whose range start > cp.
        let (lo, p1) = Self::partition_point(&group.entries, |e| e.range.0 <= cp);
        // Search 2: earliest index in [0, lo) whose prefix-max end >= cp.
        let (j_min, p2) = Self::partition_point_prefix(&group.prefix_max_end, lo, cp);
        self.last_probes = p1 + p2;
        if j_min == lo {
            // No entry's end reaches cp — a miss scans nothing.
            return Vec::new();
        }

        // Bounded candidate scan over [j_min, lo).
        let mut scan_probes = 0;
        let mut seen: Vec<usize> = Vec::new();
        for i in j_min..lo {
            scan_probes += 1;
            let e = group.entries[i];
            if e.range.1 >= cp && !seen.contains(&e.slice_index) {
                seen.push(e.slice_index);
            }
        }
        self.last_probes += scan_probes;
        seen.sort_unstable();
        seen
    }

    /// Binary search for the first index where `pred` is false, returning
    /// `(partition index, comparisons performed)` — std `partition_point` with
    /// the probe count folded into the predicate.
    fn partition_point(
        entries: &[IntervalEntry],
        pred: impl Fn(&IntervalEntry) -> bool,
    ) -> (usize, usize) {
        let mut probes = 0usize;
        let lo = entries.partition_point(|e| {
            probes += 1;
            pred(e)
        });
        (lo, probes)
    }

    /// Binary search over `prefix_max_end[0..len]` for the first index with
    /// value >= `cp` (the earliest possibly-covering entry), returning
    /// `(index, comparisons performed)`.
    fn partition_point_prefix(prefix_max_end: &[u32], len: usize, cp: u32) -> (usize, usize) {
        let mut probes = 0usize;
        let lo = prefix_max_end[..len].partition_point(|&v| {
            probes += 1;
            v < cp
        });
        (lo, probes)
    }

    /// Interval comparisons the most recent `lookup` performed — both binary
    /// searches plus the bounded candidate scan. A miss is O(log n); a hit is
    /// O(log n) + the number of enumerated candidates.
    pub fn last_probes(&self) -> usize {
        self.last_probes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index_with_two_slices() -> (CoverageIndex, usize, usize) {
        let mut idx = CoverageIndex::new();
        // slice 0: latin (0x20-0x7E), slice 1: CJK (0x4E00-0x9FFF)
        idx.insert_slice("Noto Sans", FontStyle::Normal, FontWeight::Normal, &[(0x20, 0x7E)], 0);
        idx.insert_slice(
            "Noto Sans",
            FontStyle::Normal,
            FontWeight::Normal,
            &[(0x4E00, 0x9FFF)],
            1,
        );
        (idx, 0, 1)
    }

    #[test]
    fn lookup_hit_single_and_cross_interval() {
        let (mut idx, s0, s1) = index_with_two_slices();
        assert_eq!(
            idx.lookup("Noto Sans", FontStyle::Normal, FontWeight::Normal, 0x41),
            vec![s0]
        );
        assert_eq!(
            idx.lookup("Noto Sans", FontStyle::Normal, FontWeight::Normal, 0x4E01),
            vec![s1]
        );
    }

    #[test]
    fn lookup_miss_scans_nothing() {
        let (mut idx, _, _) = index_with_two_slices();
        // U+10000 is above every interval end; the miss must scan nothing.
        let found = idx.lookup("Noto Sans", FontStyle::Normal, FontWeight::Normal, 0x10000);
        assert!(found.is_empty());
        // A miss performs only the two O(log n) binary searches (start-sorted
        // entries + prefix-max-end), never the candidate scan. Each search is
        // at most ceil(log2(2)) + 1 = 2 comparisons on this fixture, so the
        // total stays tightly bounded - pinning the O(log n) miss claim
        // without coupling to a specific binary-search probe count.
        let probes = idx.last_probes();
        assert!(
            (2..=4).contains(&probes),
            "miss over 2 entries should cost ~2-4 comparisons, got {probes}"
        );
    }

    #[test]
    fn lookup_missing_group_is_empty() {
        let (mut idx, _, _) = index_with_two_slices();
        assert!(
            idx.lookup("Noto Sans SC", FontStyle::Normal, FontWeight::Normal, 0x41)
                .is_empty()
        );
    }

    #[test]
    fn overlapping_ranges_return_deduped_candidates() {
        let mut idx = CoverageIndex::new();
        // Two slices both cover U+41; third covers U+42 only.
        idx.insert_slice("F", FontStyle::Normal, FontWeight::Normal, &[(0x41, 0x5A)], 0);
        idx.insert_slice("F", FontStyle::Normal, FontWeight::Normal, &[(0x30, 0x50)], 1);
        idx.insert_slice("F", FontStyle::Normal, FontWeight::Normal, &[(0x41, 0x41)], 0);
        let mut got = idx.lookup("F", FontStyle::Normal, FontWeight::Normal, 0x41);
        got.sort_unstable();
        assert_eq!(got, vec![0, 1]);
        // Duplicate insert of the same (range, slice) is idempotent, and a
        // point only in slice 0 (0x51 > slice1's end 0x50) yields [0].
        let again = idx.lookup("F", FontStyle::Normal, FontWeight::Normal, 0x51);
        assert_eq!(again, vec![0]);
    }

    #[test]
    fn prefix_max_end_finds_early_covering_entry() {
        let mut idx = CoverageIndex::new();
        // Entry 0 starts at 0x30 and ends at 0x3F (does not reach 0x40);
        // entry 1 starts at 0x41 and ends at 0x50. Lookup of 0x45 must find
        // only entry 1 even though prefix-max-end of entry 0 is 0x3F.
        idx.insert_slice("F", FontStyle::Normal, FontWeight::Normal, &[(0x30, 0x3F)], 0);
        idx.insert_slice("F", FontStyle::Normal, FontWeight::Normal, &[(0x41, 0x50)], 1);
        assert_eq!(idx.lookup("F", FontStyle::Normal, FontWeight::Normal, 0x45), vec![1]);
        // A point in the gap between the intervals is a miss.
        assert!(idx.lookup("F", FontStyle::Normal, FontWeight::Normal, 0x40).is_empty());
    }
}

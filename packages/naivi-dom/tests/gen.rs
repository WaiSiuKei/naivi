//! Generated `NaiviEventKind` shape + cross-side drift guard (plan U2).
//!
//! The generated enum derives from `js/naivi-protocol/src/index.ts` (the SOT).
//! The hardcoded table below is the JS-side reference (the same values the
//! `@naivi/protocol` consumer uses); asserting the generated enum against it
//! catches a build.rs parser misread that a self-referential generated test
//! would miss (plan review fix F12).

use std::str::FromStr;

use naivi_dom::generated::NaiviEventKind;

/// The SOT table as the JS side sees it (event-type string → explicit u8).
/// Keep in sync with `js/naivi-protocol/src/index.ts` — this is the drift guard.
const EXPECTED: &[(&str, u8)] = &[
    ("click", 0),
    ("pointerdown", 1),
    ("pointerup", 2),
    ("pointermove", 3),
    ("wheel", 4),
    ("contextmenu", 5),
    ("mouseenter", 6),
    ("mouseleave", 7),
    ("dblclick", 8),
    ("keydown", 9),
    ("keyup", 10),
    ("input", 11),
];

#[test]
fn generated_enum_matches_sot_table() {
    // Cross-side drift guard: every expected (name, u8) pair agrees.
    assert_eq!(NaiviEventKind::ALL.len(), EXPECTED.len());
    for (i, (name, kind)) in EXPECTED.iter().enumerate() {
        let variant = NaiviEventKind::ALL[i];
        assert_eq!(variant.name(), *name, "name at index {i}");
        assert_eq!(variant.to_u8(), *kind, "u8 at index {i}");
        assert_eq!(NaiviEventKind::from_u8(*kind), Some(variant));
        assert_eq!(NaiviEventKind::from_str(name), Ok(variant));
    }
}

#[test]
fn from_u8_roundtrips_all_kinds() {
    for (i, (_, kind)) in EXPECTED.iter().enumerate() {
        let variant = NaiviEventKind::from_u8(*kind).expect("known kind");
        assert_eq!(variant.to_u8(), *kind);
        assert_eq!(NaiviEventKind::ALL[i], variant);
    }
    // Unknown kinds are rejected (never exposed to the guest).
    assert_eq!(NaiviEventKind::from_u8(255), None);
    assert_eq!(NaiviEventKind::from_u8(12), None);
}

#[test]
fn from_str_trims_on_prefix() {
    // Existing semantics: bind_event accepts the event type with or without
    // the `on` prefix.
    assert_eq!(NaiviEventKind::from_str("click"), Ok(NaiviEventKind::Click));
    assert_eq!(NaiviEventKind::from_str("onclick"), Ok(NaiviEventKind::Click));
    assert_eq!(NaiviEventKind::from_str("pointerdown"), Ok(NaiviEventKind::PointerDown));
    assert_eq!(NaiviEventKind::from_str("oninput"), Ok(NaiviEventKind::Input));
    assert!(NaiviEventKind::from_str("change").is_err());
    assert!(NaiviEventKind::from_str("bogus").is_err());
}

#[test]
fn all_is_exhaustive() {
    // ALL covers exactly the expected set, no more, no less.
    let names: Vec<&str> = NaiviEventKind::ALL.iter().map(|k| k.name()).collect();
    let expected_names: Vec<&str> = EXPECTED.iter().map(|(n, _)| *n).collect();
    assert_eq!(names, expected_names);
}

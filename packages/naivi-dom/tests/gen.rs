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

/// Frame opcode drift guard (stage 2): generated op constants vs the SOT `OP`
/// table reference. Same hardcoded-reference discipline as the event guard.
#[test]
fn generated_op_constants_match_sot() {
    use naivi_dom::generated::op;
    assert_eq!(op::CREATE_ELEMENT, 0x01);
    assert_eq!(op::CREATE_TEXT, 0x02);
    assert_eq!(op::SET_TEXT, 0x03);
    assert_eq!(op::SET_ATTR, 0x04);
    assert_eq!(op::SET_STYLE, 0x05);
    assert_eq!(op::APPEND_CHILD, 0x06);
    assert_eq!(op::ATTACH_ROOT, 0x07);
    assert_eq!(op::INSERT_BEFORE, 0x08);
    assert_eq!(op::INSERT_AFTER, 0x09);
    assert_eq!(op::REPLACE_NODE, 0x0a);
    assert_eq!(op::REMOVE_NODE, 0x0b);
    assert_eq!(op::BIND_EVENT, 0x0c);
    assert_eq!(op::UNBIND_EVENT, 0x0d);
    assert_eq!(op::ADD_STYLESHEET, 0x0e);
    assert_eq!(op::RESET, 0x0f);
}

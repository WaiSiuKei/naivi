//! Build-time protocol codegen for naivi-dom.
//!
//! Reads the single source of truth — `js/naivi-protocol/src/index.ts` (the
//! `@naivi/protocol` package) — with a hand-rolled naive parser (no TS
//! execution, no regex dependency), and emits `OUT_DIR/protocol_gen.rs`
//! containing the `NaiviEventKind` enum + `to_u8` / `from_u8` / `name` /
//! `FromStr` / `ALL`, which `src/gen.rs` `include!`s.
//!
//! - `cargo:rerun-if-changed` points at the SOT file, so editing the table
//!   regenerates on the next build (drift is impossible by construction).
//! - A missing / unparseable SOT file fails the build with a clear message.
//! - The explicit `u8` value in the table is authoritative; key order is only
//!   a test-time invariant (plan R1, review fix F15).

use std::env;
use std::fs;
use std::path::PathBuf;

const SOT_REL: &str = "../../js/naivi-protocol/src/index.ts";

#[derive(Debug)]
struct Entry {
    name: String,
    value: u8,
}

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let sot_path = manifest_dir.join(SOT_REL);
    if !sot_path.exists() {
        panic!(
            "naivi protocol SOT missing at {} — the naivi-dom build depends on \
             js/naivi-protocol/src/index.ts (repo-relative); keep the js/ tree in the checkout.",
            sot_path.display()
        );
    }
    println!("cargo:rerun-if-changed={}", sot_path.display());

    let source = fs::read_to_string(&sot_path).expect("read SOT file");
    let entries = parse_event_kinds(&source).unwrap_or_else(|e| {
        panic!(
            "naivi protocol SOT unparseable at {}: {e} — update the parser in \
             packages/naivi-dom/build.rs or fix the table.",
            sot_path.display()
        )
    });
    let ops = parse_op_table(&source).unwrap_or_else(|e| {
        panic!(
            "naivi protocol SOT op table unparseable at {}: {e} — update the parser \
             in packages/naivi-dom/build.rs or fix the table.",
            sot_path.display()
        )
    });

    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    let generated = emit(&entries, &ops);
    fs::write(out_dir.join("protocol_gen.rs"), generated).expect("write protocol_gen.rs");
}

/// Naive parse of the `export const EVENT_KINDS = { ... } as const;` block.
///
/// Pins the format contract also asserted in
/// `js/naivi-protocol/tests/event-kinds.test.ts` — keep both in sync.
fn parse_event_kinds(source: &str) -> Result<Vec<Entry>, String> {
    let start = source
        .find("const EVENT_KINDS = {")
        .ok_or("cannot find `const EVENT_KINDS = {`")?;
    let brace = source[start..]
        .find('{')
        .ok_or("no `{` after `const EVENT_KINDS`")?
        + start;
    let rest = &source[brace + 1..];
    let end = rest.find('}').ok_or("no closing `}` for EVENT_KINDS")?;
    let body = &rest[..end];

    let mut entries = Vec::new();
    for line in body.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let line = line.trim_end_matches(',');
        let (name, value) = line.split_once(':').ok_or_else(|| {
            format!("unparseable EVENT_KINDS line {line:?} (expected `name: value,`)")
        })?;
        let name = name.trim();
        if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return Err(format!("bad EVENT_KINDS key {name:?}"));
        }
        let value: u8 = value.trim().parse().map_err(|_| {
            format!("bad EVENT_KINDS u8 value {:?}", value.trim())
        })?;
        entries.push(Entry {
            name: name.to_string(),
            value,
        });
    }
    if entries.is_empty() {
        return Err("EVENT_KINDS table is empty".into());
    }
    Ok(entries)
}

/// Naive parse of the `export const OP = { ... } as const;` block (stage 2
/// frame opcode table). Keys are CamelCase; values hex or decimal.
fn parse_op_table(source: &str) -> Result<Vec<(String, u8)>, String> {
    let start = source.find("const OP = {").ok_or("cannot find `const OP = {`")?;
    let brace = source[start..].find('{').ok_or("no `{` after `const OP`")? + start;
    let rest = &source[brace + 1..];
    let end = rest.find('}').ok_or("no closing `}` for OP")?;
    let body = &rest[..end];

    let mut ops = Vec::new();
    for line in body.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let line = line.trim_end_matches(',');
        let (name, value) = line.split_once(':').ok_or_else(|| {
            format!("unparseable OP line {line:?} (expected `Name: value,`)")
        })?;
        let name = name.trim();
        if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return Err(format!("bad OP key {name:?}"));
        }
        let raw = value.trim();
        let value = if let Some(hex) = raw.strip_prefix("0x") {
            u8::from_str_radix(hex, 16)
                .map_err(|_| format!("bad OP hex value {raw:?}"))?
        } else {
            raw.parse::<u8>().map_err(|_| format!("bad OP value {raw:?}"))?
        };
        ops.push((name.to_string(), value));
    }
    if ops.is_empty() {
        return Err("OP table is empty".into());
    }
    Ok(ops)
}

/// CamelCase `CreateElement` → `CREATE_ELEMENT` (for generated const names).
fn screaming_snake(name: &str) -> String {
    let mut out = String::new();
    for (i, c) in name.chars().enumerate() {
        if c.is_ascii_uppercase() && i > 0 {
            out.push('_');
        }
        out.push(c.to_ascii_uppercase());
    }
    out
}
/// Lowercase snake/camel-ish key → CamelCase variant name, splitting on known
/// word boundaries (longest match wins). The drift-guard test in
/// `tests/gen.rs` pins every current key's variant, so an unsegmented key
/// fails loudly.
fn camelize(name: &str) -> String {
    const WORDS: &[&str] = &[
        "pointer",
        "context",
        "mouse",
        "dbl",
        "key",
        "click",
        "down",
        "up",
        "move",
        "menu",
        "enter",
        "leave",
        "wheel",
        "input",
    ];
    let mut out = String::new();
    let mut rest = name;
    while !rest.is_empty() {
        let mut matched = false;
        for w in WORDS {
            if let Some(tail) = rest.strip_prefix(w) {
                out.push_str(&w[..1].to_uppercase());
                out.push_str(&w[1..]);
                rest = tail;
                matched = true;
                break;
            }
        }
        if !matched {
            // Fallback: treat the remainder as one word.
            out.push_str(&rest[..1].to_uppercase());
            out.push_str(&rest[1..]);
            rest = "";
        }
    }
    out
}

fn emit(entries: &[Entry], ops: &[(String, u8)]) -> String {
    let header = "// AUTO-GENERATED by packages/naivi-dom/build.rs from \
                  js/naivi-protocol/src/index.ts.\n\
                  // Do not edit by hand — change the SOT table and rebuild.\n";
    let count = entries.len();

    let mut variants = Vec::new();
    let mut all = Vec::new();
    let mut names = Vec::new();
    let mut to_u8 = Vec::new();
    let mut from_u8 = Vec::new();
    let mut from_str = Vec::new();
    for e in entries {
        let v = camelize(&e.name);
        variants.push(format!("    {v},"));
        all.push(format!("        Self::{v},"));
        names.push(format!("            Self::{v} => \"{}\",", e.name));
        to_u8.push(format!("            Self::{v} => {},", e.value));
        from_u8.push(format!("            {} => Some(Self::{v}),", e.value));
        from_str.push(format!("            \"{}\" => Ok(Self::{v}),", e.name));
    }

    let mut op_consts = Vec::new();
    for (name, value) in ops {
        let const_name = screaming_snake(name);
        op_consts.push(format!("    pub const {const_name}: u8 = 0x{value:02x};"));
    }

    format!(
        "{header}
/// The bounded set of DOM event kinds that naivi can bind Vue `v-on` handlers to.
///
/// Generated from the `@naivi/protocol` SOT (`EVENT_KINDS`); wire `u8` order
/// shared with the guest (`click=0 … input=11`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum NaiviEventKind {{
{}
}}

impl NaiviEventKind {{
    /// All event kinds the guest can bind.
    pub const ALL: [NaiviEventKind; {count}] = [
{}
    ];

    /// The DOM event name (e.g. `\"click\"`), as used by the bridge protocol.
    pub fn name(self) -> &'static str {{
        match self {{
{}
        }}
    }}

    /// The protocol `u8` encoding (explicit values from the SOT table).
    pub fn to_u8(self) -> u8 {{
        match self {{
{}
        }}
    }}

    /// Decode a protocol `u8` kind; `None` for kinds naivi does not expose.
    pub fn from_u8(kind: u8) -> Option<Self> {{
        match kind {{
{}
            _ => None,
        }}
    }}
}}

impl std::str::FromStr for NaiviEventKind {{
    type Err = ();

    fn from_str(s: &str) -> Result<Self, Self::Err> {{
        match s.trim_start_matches(\"on\") {{
{}
            _ => Err(()),
        }}
    }}
}}

/// Frame opcodes (stage 2 — batched binary frame transport), generated from
/// the SOT `OP` table. Wire values are explicit; the TS writer and the Rust
/// frame decoder both drive off these.
pub mod op {{
{}
}}
",
        variants.join("\n"),
        all.join("\n"),
        names.join("\n"),
        to_u8.join("\n"),
        from_u8.join("\n"),
        from_str.join("\n"),
        op_consts.join("\n"),
    )
}

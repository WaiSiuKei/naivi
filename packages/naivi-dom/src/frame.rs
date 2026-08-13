//! Binary-frame decode/apply core for the U6 frame transport (KTD1/KTD3/KD8).
//!
//! Wire format (mirrors the `@naivi/protocol` `FrameWriter`, U4):
//!
//! ```text
//! [seq u32 LE][count u16 LE][op…]
//!   op = [opcode u8][operands]
//!   strings = [len u16][utf8] — except `AddStylesheet` uses [len u32][utf8]
//!   node operands are JS-assigned virtual u32 ids (`0` is never a node)
//! ```
//!
//! A frame is applied as a **whole transaction** (KTD3): one forward pass
//! validates every referenced id against the persistent virtual map ∪ the set
//! created earlier in the frame; on any failure the entire frame is rejected
//! (`frame_rejected(seq, reason)`), the DOM is left untouched, and nothing
//! panics. `reset` (self-heal start, R15) drops the whole scene.

use crate::events::NaiviEventKind;
use crate::generated::op;
use crate::ops::{OpsCore, RejectReason};
use std::collections::HashSet;

/// A single decoded frame op, addressed by JS-assigned virtual u32 ids (KD3).
#[derive(Debug, Clone, PartialEq)]
pub enum FrameOp {
    CreateElement { id: u32, tag: String },
    CreateTextNode { id: u32, text: String },
    SetText { node: u32, text: String },
    SetAttr { node: u32, name: String, value: String },
    SetStyle { node: u32, name: String, value: String },
    AppendChild { parent: u32, child: u32 },
    AttachRoot { node: u32 },
    InsertBefore { anchor: u32, node: u32 },
    InsertAfter { anchor: u32, node: u32 },
    ReplaceNode { anchor: u32, node: u32 },
    RemoveNode { node: u32 },
    BindEvent { node: u32, kind: NaiviEventKind },
    /// Unbind every kind bound on the node (the wire op carries no kind).
    UnbindEvent { node: u32 },
    AddStylesheet { css: String },
    Reset,
}

/// A decoded frame: its sequence number plus the op list, in wire order.
#[derive(Debug, Clone)]
pub struct DecodedFrame {
    pub seq: u32,
    pub ops: Vec<FrameOp>,
}

/// Single-pass, borrowing byte decoder (zero-copy strings are not possible
/// for owned `String` ops; allocation is limited to the op list itself).
pub struct FrameDecoder<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> FrameDecoder<'a> {
    /// Decode one frame. Returns `Err(MalformedFrame)` on truncation or an
    /// unknown opcode; decoding never mutates any state.
    pub fn decode(bytes: &'a [u8]) -> Result<DecodedFrame, RejectReason> {
        let mut d = FrameDecoder { bytes, pos: 0 };
        let seq = d.u32().ok_or(RejectReason::MalformedFrame)?;
        let count = d.u16().ok_or(RejectReason::MalformedFrame)? as usize;
        let mut ops = Vec::with_capacity(count);
        for _ in 0..count {
            ops.push(d.op().ok_or(RejectReason::MalformedFrame)?);
        }
        Ok(DecodedFrame { seq, ops })
    }

    fn u8(&mut self) -> Option<u8> {
        let v = *self.bytes.get(self.pos)?;
        self.pos += 1;
        Some(v)
    }

    fn u16(&mut self) -> Option<u16> {
        let b = self.bytes.get(self.pos..self.pos + 2)?;
        self.pos += 2;
        Some(u16::from_le_bytes([b[0], b[1]]))
    }

    fn u32(&mut self) -> Option<u32> {
        let b = self.bytes.get(self.pos..self.pos + 4)?;
        self.pos += 4;
        Some(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    fn str_u16(&mut self) -> Option<String> {
        let len = self.u16()? as usize;
        let b = self.bytes.get(self.pos..self.pos + len)?;
        self.pos += len;
        Some(String::from_utf8_lossy(b).into_owned())
    }

    fn str_u32(&mut self) -> Option<String> {
        let len = self.u32()? as usize;
        let b = self.bytes.get(self.pos..self.pos + len)?;
        self.pos += len;
        Some(String::from_utf8_lossy(b).into_owned())
    }

    fn op(&mut self) -> Option<FrameOp> {
        let code = self.u8()?;
        let mut node = || self.u32();
        match code {
            op::CREATE_ELEMENT => Some(FrameOp::CreateElement {
                id: node()?,
                tag: self.str_u16()?,
            }),
            op::CREATE_TEXT => Some(FrameOp::CreateTextNode {
                id: node()?,
                text: self.str_u16()?,
            }),
            op::SET_TEXT => Some(FrameOp::SetText {
                node: node()?,
                text: self.str_u16()?,
            }),
            op::SET_ATTR => Some(FrameOp::SetAttr {
                node: node()?,
                name: self.str_u16()?,
                value: self.str_u16()?,
            }),
            op::SET_STYLE => Some(FrameOp::SetStyle {
                node: node()?,
                name: self.str_u16()?,
                value: self.str_u16()?,
            }),
            op::APPEND_CHILD => Some(FrameOp::AppendChild {
                parent: node()?,
                child: node()?,
            }),
            op::ATTACH_ROOT => Some(FrameOp::AttachRoot { node: node()? }),
            op::INSERT_BEFORE => Some(FrameOp::InsertBefore {
                anchor: node()?,
                node: node()?,
            }),
            op::INSERT_AFTER => Some(FrameOp::InsertAfter {
                anchor: node()?,
                node: node()?,
            }),
            op::REPLACE_NODE => Some(FrameOp::ReplaceNode {
                anchor: node()?,
                node: node()?,
            }),
            op::REMOVE_NODE => Some(FrameOp::RemoveNode { node: node()? }),
            op::BIND_EVENT => Some(FrameOp::BindEvent {
                node: node()?,
                kind: NaiviEventKind::from_u8(self.u8()?)?,
            }),
            op::UNBIND_EVENT => Some(FrameOp::UnbindEvent { node: node()? }),            op::ADD_STYLESHEET => Some(FrameOp::AddStylesheet { css: self.str_u32()? }),
            op::RESET => Some(FrameOp::Reset),
            _ => None,
        }
    }
}

/// Order-aware single-pass validation + transactional apply (KTD3).
pub struct FrameApplier<'a> {
    core: &'a mut OpsCore,
}

impl<'a> FrameApplier<'a> {
    pub fn new(core: &'a mut OpsCore) -> Self {
        Self { core }
    }

    /// Validate and apply `frame` as one transaction.
    ///
    /// On any error the whole frame is rejected: no mutation has landed (all
    /// checks happen before any apply) and the caller surfaces
    /// `frame_rejected(seq, reason)`.
    pub fn apply_frame(&mut self, frame: DecodedFrame) -> Result<(), RejectReason> {
        self.validate(&frame)?;
        for op in &frame.ops {
            self.apply(op)?;
        }
        Ok(())
    }

    /// Forward single-pass validation: an id is live when it is in the
    /// persistent virtual map OR was created earlier in this frame.
    fn validate(&self, frame: &DecodedFrame) -> Result<(), RejectReason> {
        let mut created: HashSet<u32> = HashSet::default();
        for op in &frame.ops {
            match op {
                FrameOp::CreateElement { id, .. } | FrameOp::CreateTextNode { id, .. } => {
                    if created.contains(id) || self.core.resolve_virtual(*id).is_some() {
                        return Err(RejectReason::DuplicateId);
                    }
                    created.insert(*id);
                }
                FrameOp::SetText { node, .. }
                | FrameOp::SetAttr { node, .. }
                | FrameOp::SetStyle { node, .. }
                | FrameOp::AttachRoot { node }
                | FrameOp::RemoveNode { node }
                | FrameOp::BindEvent { node, .. }
                | FrameOp::UnbindEvent { node } => {
                    if !created.contains(node) && self.core.resolve_virtual(*node).is_none() {
                        return Err(RejectReason::UnknownId);
                    }
                }
                FrameOp::AppendChild { parent, child }
                | FrameOp::InsertBefore {
                    anchor: parent,
                    node: child,
                }
                | FrameOp::InsertAfter {
                    anchor: parent,
                    node: child,
                }
                | FrameOp::ReplaceNode {
                    anchor: parent,
                    node: child,
                } => {
                    if (!created.contains(parent) && self.core.resolve_virtual(*parent).is_none())
                        || (!created.contains(child) && self.core.resolve_virtual(*child).is_none())
                    {
                        return Err(RejectReason::UnknownId);
                    }
                }
                FrameOp::AddStylesheet { .. } | FrameOp::Reset => {}
            }
        }
        Ok(())
    }

    fn apply(&mut self, op: &FrameOp) -> Result<(), RejectReason> {
        match op {
            FrameOp::CreateElement { id, tag } => {
                self.core.create_element_v(*id, tag).map(|_| ())
            }
            FrameOp::CreateTextNode { id, text } => {
                self.core.create_text_node_v(*id, text).map(|_| ())
            }
            FrameOp::SetText { node, text } => self.core.set_text_v(*node, text),
            FrameOp::SetAttr { node, name, value } => self.core.set_attr_v(*node, name, value),
            FrameOp::SetStyle { node, name, value } => self.core.set_style_v(*node, name, value),
            FrameOp::AppendChild { parent, child } => self.core.append_child_v(*parent, *child),
            FrameOp::AttachRoot { node } => self.core.attach_root_v(*node),
            FrameOp::InsertBefore { anchor, node } => self.core.insert_before_v(*anchor, *node),
            FrameOp::InsertAfter { anchor, node } => self.core.insert_after_v(*anchor, *node),
            FrameOp::ReplaceNode { anchor, node } => self.core.replace_node_v(*anchor, *node),
            FrameOp::RemoveNode { node } => self.core.remove_node_v(*node),
            FrameOp::BindEvent { node, kind } => self.core.bind_event_v(*node, *kind),
            FrameOp::UnbindEvent { node } => self.core.unbind_all_v(*node),
            FrameOp::AddStylesheet { css } => {
                self.core.add_stylesheet(css);
                Ok(())
            }
            FrameOp::Reset => {
                self.core.reset();
                Ok(())
            }
        }
    }
}

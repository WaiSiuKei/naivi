//! Engine-neutral mutation ops core for naivi.
//!
//! Maps the naivi mutation-mirror protocol (build tree / change style / edit
//! attributes / edit text / bind events) onto a blitz [`BaseDocument`] via
//! [`DocumentMutator`]. Both naivi channels (wasm exports in U4, rquickjs FFI
//! in U5) are thin adapters over this core; nothing here is channel-specific.
//!
//! ## NodeId ownership
//!
//! Every node id is allocated by blitz (`DocumentMutator::create_element` /
//! `create_text_node` return the blitz [`NodeId`]). The guest receives the id
//! (as a `u64`) and must not self-assign. [`OpsCore::remove_node`] drops the
//! node and invalidates its id; using a removed id afterwards is a guest bug
//! and will panic.

use crate::events::NaiviEventKind;
use blitz_dom::{BaseDocument, LocalName, QualName, ns};
use blitz_traits::node_id::NodeId;
use rustc_hash::FxHashMap;
use std::cell::RefCell;
use std::rc::Rc;

/// The name of the attribute written by [`OpsCore::bind_event`] /
/// [`OpsCore::bind_event_v`].
pub const DATA_NAIVI_ID: &str = "data-naivi-id";

/// Wire reason code for a rejected frame (whole-frame transaction, KTD3).
/// Mirrors `FRAME_REJECTED = 0x01` in the `@naivi/protocol` SOT.
pub const FRAME_REJECTED: u8 = 0x01;

/// Why a frame was rejected (KD8 / R9). Every rejection leaves the DOM
/// untouched — the whole frame is discarded as one transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RejectReason {
    /// An op referenced a virtual id that is not live (never created, or
    /// already removed / reset).
    UnknownId,
    /// A create op reused a virtual id that is already live (guest/JS drift).
    DuplicateId,
    /// The frame bytes were malformed (truncated / unknown opcode).
    MalformedFrame,
}

impl RejectReason {
    /// The wire reason byte reported to the guest via `frame_rejected`.
    pub fn code(self) -> u8 {
        match self {
            Self::UnknownId | Self::DuplicateId | Self::MalformedFrame => FRAME_REJECTED,
        }
    }
}

/// Registry mapping node ids to the event kinds bound on them.
pub type NaiviBindings = FxHashMap<NodeId, Vec<NaiviEventKind>>;

/// The engine-neutral ops core shared by the wasm and rquickjs channels.
pub struct OpsCore {
    /// The underlying blitz document.
    pub doc: Rc<RefCell<BaseDocument>>,
    /// Shared event-binding registry (shared with
    /// [`NaiviDocument`](crate::document::NaiviDocument) so its event handler
    /// sees bindings made through this core).
    pub bindings: Rc<RefCell<NaiviBindings>>,
    /// Shared virtual-id map (KTD7): JS-assigned virtual u32 id → blitz
    /// [`NodeId`]. Shared with [`NaiviDocument`](crate::document::NaiviDocument)
    /// so the event handler can reverse-map via `data-naivi-id`.
    pub virtual_ids: Rc<RefCell<FxHashMap<u32, NodeId>>>,
}

impl OpsCore {
    /// Create a standalone core over the given document.
    ///
    /// Prefer [`NaiviDocument::ops_core`](crate::document::NaiviDocument::ops_core)
    /// when a [`NaiviDocument`](crate::document::NaiviDocument) is involved, so
    /// the event-binding registry is shared with the document's event handler.
    pub fn new(doc: Rc<RefCell<BaseDocument>>) -> Self {
        Self {
            doc,
            bindings: Rc::new(RefCell::new(FxHashMap::default())),
            virtual_ids: Rc::new(RefCell::new(FxHashMap::default())),
        }
    }

    /// Create a core sharing both the binding registry and the virtual-id map
    /// with a [`NaiviDocument`](crate::document::NaiviDocument) (KTD7).
    pub(crate) fn with_state(
        doc: Rc<RefCell<BaseDocument>>,
        bindings: Rc<RefCell<NaiviBindings>>,
        virtual_ids: Rc<RefCell<FxHashMap<u32, NodeId>>>,
    ) -> Self {
        Self {
            doc,
            bindings,
            virtual_ids,
        }
    }

    // ---- virtual-id helpers (KD3 / KTD7) ----

    /// Look up the blitz id for a live virtual id.
    pub fn resolve_virtual(&self, id: u32) -> Option<NodeId> {
        self.virtual_ids.borrow().get(&id).copied()
    }

    /// Resolve a virtual id, or reject the frame (KTD3).
    fn require_node(&self, id: u32) -> Result<NodeId, RejectReason> {
        self.resolve_virtual(id).ok_or(RejectReason::UnknownId)
    }

    // ---- tree ----

    /// Create an element and return its blitz-allocated [`NodeId`].
    pub fn create_element(&mut self, tag: &str) -> NodeId {
        let name = qual_name(tag);
        self.doc.borrow_mut().mutate().create_element(name, Vec::new())
    }

    /// Create a text node and return its blitz-allocated [`NodeId`].
    pub fn create_text_node(&mut self, text: &str) -> NodeId {
        self.doc.borrow_mut().mutate().create_text_node(text)
    }

    /// Append a single child to `parent`.
    pub fn append_child(&mut self, parent: NodeId, child: NodeId) {
        self.append_children(parent, &[child]);
    }

    /// Append several children to `parent` (in order).
    pub fn append_children(&mut self, parent: NodeId, children: &[NodeId]) {
        let mut doc = self.doc.borrow_mut();
        let mut mutr = doc.mutate();
        mutr.append_children(parent, children);
    }

    /// Insert `node` immediately before `anchor`.
    pub fn insert_before(&mut self, anchor: NodeId, node: NodeId) {
        let mut doc = self.doc.borrow_mut();
        let mut mutr = doc.mutate();
        mutr.insert_nodes_before(anchor, &[node]);
    }

    /// Insert `node` immediately after `anchor`.
    pub fn insert_after(&mut self, anchor: NodeId, node: NodeId) {
        let mut doc = self.doc.borrow_mut();
        let mut mutr = doc.mutate();
        mutr.insert_nodes_after(anchor, &[node]);
    }

    /// Replace `anchor` with `replacement` (which is inserted in its place).
    pub fn replace_node(&mut self, anchor: NodeId, replacement: NodeId) {
        let mut doc = self.doc.borrow_mut();
        let mut mutr = doc.mutate();
        mutr.replace_node_with(anchor, &[replacement]);
    }

    /// Attach `node_id` as a child of the document root node.
    ///
    /// blitz's resolve and hit-test treat the document as "having DOM" only
    /// once the root node has an element child; the guest facade must attach
    /// its top-level container (the body) for anything to render.
    pub fn attach_document_root(&mut self, node_id: NodeId) {
        let mut doc = self.doc.borrow_mut();
        let root = doc.root_node().id;
        let mut mutr = doc.mutate();
        mutr.append_children(root, &[node_id]);
    }

    /// Remove and drop a node (and its subtree) from the document.
    ///
    /// The node's id is invalidated: reusing it is a guest bug and will panic.
    /// Any event bindings on the removed subtree are dropped too.
    pub fn remove_node(&mut self, node_id: NodeId) {
        let mut doc = self.doc.borrow_mut();
        let mut mutr = doc.mutate();
        let bindings = Rc::clone(&self.bindings);
        mutr.remove_and_drop_node_with(node_id, &mut |dropped| {
            bindings.borrow_mut().remove(&dropped);
        });
    }

    // ---- text ----

    /// Set the text content of a text node.
    pub fn set_text(&mut self, node_id: NodeId, text: &str) {
        let mut doc = self.doc.borrow_mut();
        let mut mutr = doc.mutate();
        mutr.set_node_text(node_id, text);
    }

    // ---- attributes ----

    /// Set an attribute (e.g. `class`, `id`, `data-*`).
    pub fn set_attr(&mut self, node_id: NodeId, name: &str, value: &str) {
        let mut doc = self.doc.borrow_mut();
        let mut mutr = doc.mutate();
        mutr.set_attribute(node_id, qual_name(name), value);
    }

    /// Clear an attribute.
    pub fn clear_attr(&mut self, node_id: NodeId, name: &str) {
        let mut doc = self.doc.borrow_mut();
        let mut mutr = doc.mutate();
        mutr.clear_attribute(node_id, qual_name(name));
    }

    // ---- style ----

    /// Set an inline style property (routed to blitz's style-attribute block).
    pub fn set_style(&mut self, node_id: NodeId, name: &str, value: &str) {
        let mut doc = self.doc.borrow_mut();
        let mut mutr = doc.mutate();
        mutr.set_style_property(node_id, name, value);
    }

    /// Remove an inline style property.
    pub fn remove_style(&mut self, node_id: NodeId, name: &str) {
        let mut doc = self.doc.borrow_mut();
        let mut mutr = doc.mutate();
        mutr.remove_style_property(node_id, name);
    }

    /// Inject an author stylesheet (U6: SFC `<style>` / AOT CSS text) into
    /// stylo, attached to the document's root element (the facade body).
    ///
    /// Selectors match the whole document (`class` / tag / attribute /
    /// `:hover` / `:active` / `:checked` are handled natively by stylo);
    /// inline styles set via [`Self::set_style`] win the cascade (author
    /// inline > author rules).
    pub fn add_stylesheet(&mut self, css: &str) {
        let mut doc = self.doc.borrow_mut();
        let root = doc.root_element().id;
        let sheet = doc.make_stylesheet(css, style::stylesheets::Origin::Author);
        doc.add_stylesheet_for_node(sheet, root);
    }

    // ---- event bindings ----

    /// Bind `kind` on `node_id`.
    ///
    /// Writes the `data-naivi-id` attribute (so the node can be located when a
    /// DOM event arrives) and records the `(node, kind)` binding in the shared
    /// registry consulted by the event handler.
    pub fn bind_event(&mut self, node_id: NodeId, kind: NaiviEventKind) {
        self.set_attr(node_id, DATA_NAIVI_ID, &node_id.as_u64().to_string());
        let mut bindings = self.bindings.borrow_mut();
        let kinds = bindings.entry(node_id).or_default();
        if !kinds.contains(&kind) {
            kinds.push(kind);
        }
    }

    /// Remove `kind` from `node_id`.
    ///
    /// When the last binding on the node is removed, the `data-naivi-id`
    /// attribute is cleared as well.
    pub fn unbind_event(&mut self, node_id: NodeId, kind: NaiviEventKind) {
        let clear_attr = {
            let mut bindings = self.bindings.borrow_mut();
            let Some(kinds) = bindings.get_mut(&node_id) else {
                return;
            };
            kinds.retain(|k| *k != kind);
            if kinds.is_empty() {
                bindings.remove(&node_id);
                true
            } else {
                false
            }
        };
        if clear_attr {
            self.clear_attr(node_id, DATA_NAIVI_ID);
        }
    }

    /// The kinds currently bound on `node_id` (in bind order).
    pub fn bound_kinds(&self, node_id: NodeId) -> Vec<NaiviEventKind> {
        self.bindings
            .borrow()
            .get(&node_id)
            .cloned()
            .unwrap_or_default()
    }

    // ---- virtual-id ops (U6 frame transport, KD3/KTD7) ----
    //
    // Every frame op addresses nodes by the JS-assigned virtual u32 id; these
    // helpers resolve through the shared map and record create/remove so the
    // next frame (and the event handler's `data-naivi-id` reverse lookup)
    // sees the same identity.

    /// Create an element under virtual id `id` and record the mapping.
    pub fn create_element_v(&mut self, id: u32, tag: &str) -> Result<NodeId, RejectReason> {
        if self.virtual_ids.borrow().contains_key(&id) {
            return Err(RejectReason::DuplicateId);
        }
        let node = self.create_element(tag);
        self.virtual_ids.borrow_mut().insert(id, node);
        Ok(node)
    }

    /// Create a text node under virtual id `id` and record the mapping.
    pub fn create_text_node_v(&mut self, id: u32, text: &str) -> Result<NodeId, RejectReason> {
        if self.virtual_ids.borrow().contains_key(&id) {
            return Err(RejectReason::DuplicateId);
        }
        let node = self.create_text_node(text);
        self.virtual_ids.borrow_mut().insert(id, node);
        Ok(node)
    }

    /// Set text on the node addressed by a virtual id.
    pub fn set_text_v(&mut self, id: u32, text: &str) -> Result<(), RejectReason> {
        let node = self.require_node(id)?;
        self.set_text(node, text);
        Ok(())
    }

    /// Set an attribute on the node addressed by a virtual id.
    pub fn set_attr_v(&mut self, id: u32, name: &str, value: &str) -> Result<(), RejectReason> {
        let node = self.require_node(id)?;
        self.set_attr(node, name, value);
        Ok(())
    }

    /// Set an inline style on the node addressed by a virtual id.
    pub fn set_style_v(&mut self, id: u32, name: &str, value: &str) -> Result<(), RejectReason> {
        let node = self.require_node(id)?;
        self.set_style(node, name, value);
        Ok(())
    }

    /// Append `child` (virtual) under `parent` (virtual).
    pub fn append_child_v(&mut self, parent: u32, child: u32) -> Result<(), RejectReason> {
        let parent = self.require_node(parent)?;
        let child = self.require_node(child)?;
        self.append_child(parent, child);
        Ok(())
    }

    /// Insert `node` (virtual) before `anchor` (virtual).
    pub fn insert_before_v(&mut self, anchor: u32, node: u32) -> Result<(), RejectReason> {
        let anchor = self.require_node(anchor)?;
        let node = self.require_node(node)?;
        self.insert_before(anchor, node);
        Ok(())
    }

    /// Insert `node` (virtual) after `anchor` (virtual).
    pub fn insert_after_v(&mut self, anchor: u32, node: u32) -> Result<(), RejectReason> {
        let anchor = self.require_node(anchor)?;
        let node = self.require_node(node)?;
        self.insert_after(anchor, node);
        Ok(())
    }

    /// Replace `anchor` (virtual) with `node` (virtual).
    pub fn replace_node_v(&mut self, anchor: u32, node: u32) -> Result<(), RejectReason> {
        let anchor = self.require_node(anchor)?;
        let node = self.require_node(node)?;
        self.replace_node(anchor, node);
        Ok(())
    }

    /// Attach a virtual node as a child of the document root (facade body).
    pub fn attach_root_v(&mut self, node: u32) -> Result<(), RejectReason> {
        let node = self.require_node(node)?;
        self.attach_document_root(node);
        Ok(())
    }

    /// Remove and drop a virtual node (and its subtree), invalidating its id.
    pub fn remove_node_v(&mut self, id: u32) -> Result<(), RejectReason> {
        let node = self.require_node(id)?;
        self.virtual_ids.borrow_mut().remove(&id);
        self.remove_node(node);
        Ok(())
    }

    /// Bind `kind` on the node addressed by a virtual id.
    ///
    /// Writes `data-naivi-id` = the **virtual** id (KTD2: the event handler
    /// reverse-looks-up the guest node from this attribute at queue time) and
    /// records the `(node, kind)` binding in the shared registry.
    pub fn bind_event_v(&mut self, id: u32, kind: NaiviEventKind) -> Result<(), RejectReason> {
        let node = self.require_node(id)?;
        self.set_attr(node, DATA_NAIVI_ID, &id.to_string());
        let mut bindings = self.bindings.borrow_mut();
        let kinds = bindings.entry(node).or_default();
        if !kinds.contains(&kind) {
            kinds.push(kind);
        }
        Ok(())
    }

    /// Unbind `kind` from the node addressed by a virtual id.
    pub fn unbind_event_v(&mut self, id: u32, kind: NaiviEventKind) -> Result<(), RejectReason> {
        let node = self.require_node(id)?;
        self.unbind_event(node, kind);
        Ok(())
    }

    /// Unbind every kind from the node addressed by a virtual id (the wire
    /// `unbind_event` carries no kind — the guest unbinds the whole node).
    pub fn unbind_all_v(&mut self, id: u32) -> Result<(), RejectReason> {
        let node = self.require_node(id)?;
        self.bindings.borrow_mut().remove(&node);
        self.clear_attr(node, DATA_NAIVI_ID);
        Ok(())
    }

    /// Reset the whole scene (self-heal start, R15): drop every node under the
    /// document root, clear the virtual-id map and the event-binding registry,
    /// so the next frame builds from a clean slate.
    pub fn reset(&mut self) {
        let mut doc = self.doc.borrow_mut();
        let root = doc.root_node().id;
        let children: Vec<NodeId> = doc
            .get_node(root)
            .map(|n| n.children.iter().copied().collect())
            .unwrap_or_default();
        let bindings = Rc::clone(&self.bindings);
        {
            let mut mutr = doc.mutate();
            for child in children {
                mutr.remove_and_drop_node_with(child, &mut |dropped| {
                    bindings.borrow_mut().remove(&dropped);
                });
            }
        }
        drop(doc);
        self.virtual_ids.borrow_mut().clear();
    }

    // ---- batch ----

    /// Apply a batch of ops, returning `(op_index, node_id)` for every
    /// node-creating op (`CreateElement` / `CreateTextNode`), in batch order.
    ///
    /// The guest uses the returned ids to reference the created nodes in
    /// subsequent ops / batches.
    pub fn apply_ops(&mut self, ops: &[NaiviOp]) -> Vec<(usize, NodeId)> {
        let mut created = Vec::new();
        for (index, op) in ops.iter().enumerate() {
            match op {
                NaiviOp::CreateElement { tag } => {
                    created.push((index, self.create_element(tag)));
                }
                NaiviOp::CreateTextNode { text } => {
                    created.push((index, self.create_text_node(text)));
                }
                NaiviOp::SetText { node, text } => self.set_text(*node, text),
                NaiviOp::SetAttr { node, name, value } => self.set_attr(*node, name, value),
                NaiviOp::ClearAttr { node, name } => self.clear_attr(*node, name),
                NaiviOp::SetStyle { node, name, value } => self.set_style(*node, name, value),
                NaiviOp::RemoveStyle { node, name } => self.remove_style(*node, name),
                NaiviOp::AppendChild { parent, child } => self.append_child(*parent, *child),
                NaiviOp::InsertBefore { anchor, node } => self.insert_before(*anchor, *node),
                NaiviOp::InsertAfter { anchor, node } => self.insert_after(*anchor, *node),
                NaiviOp::ReplaceNode { anchor, node } => self.replace_node(*anchor, *node),
                NaiviOp::RemoveNode { node } => self.remove_node(*node),
                NaiviOp::BindEvent { node, kind } => self.bind_event(*node, *kind),
                NaiviOp::UnbindEvent { node, kind } => self.unbind_event(*node, *kind),
            }
        }
        created
    }
}

/// A single mutation-mirror operation, engine-neutral and id-based.
///
/// Node-creating ops do not take an id — the id is allocated by blitz and
/// returned from [`OpsCore::apply_ops`].
#[derive(Debug, Clone, PartialEq)]
pub enum NaiviOp {
    /// Create an element; its id is returned by `apply_ops`.
    CreateElement { tag: String },
    /// Create a text node; its id is returned by `apply_ops`.
    CreateTextNode { text: String },
    SetText { node: NodeId, text: String },
    SetAttr { node: NodeId, name: String, value: String },
    ClearAttr { node: NodeId, name: String },
    SetStyle { node: NodeId, name: String, value: String },
    RemoveStyle { node: NodeId, name: String },
    AppendChild { parent: NodeId, child: NodeId },
    InsertBefore { anchor: NodeId, node: NodeId },
    InsertAfter { anchor: NodeId, node: NodeId },
    ReplaceNode { anchor: NodeId, node: NodeId },
    RemoveNode { node: NodeId },
    BindEvent { node: NodeId, kind: NaiviEventKind },
    UnbindEvent { node: NodeId, kind: NaiviEventKind },
}

/// Build an HTML-namespace [`QualName`] from a tag/attribute name.
fn qual_name(name: &str) -> QualName {
    QualName {
        prefix: None,
        ns: ns!(html),
        local: LocalName::from(name),
    }
}

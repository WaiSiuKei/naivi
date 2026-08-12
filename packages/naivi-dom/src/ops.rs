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

/// The name of the attribute written by [`OpsCore::bind_event`].
pub const DATA_NAIVI_ID: &str = "data-naivi-id";

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
        }
    }

    /// Create a core sharing the given registry with a document.
    pub(crate) fn with_bindings(
        doc: Rc<RefCell<BaseDocument>>,
        bindings: Rc<RefCell<NaiviBindings>>,
    ) -> Self {
        Self { doc, bindings }
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

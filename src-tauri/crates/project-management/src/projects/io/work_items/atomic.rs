//! Atomic read-modify-write for work items.
//!
//! `update_work_item_atomic` opens a `BEGIN IMMEDIATE` transaction (which
//! takes a SQLite RESERVED lock right away, before any read), reads the
//! row, runs the caller's mutator on the deserialized
//! `WorkItemFrontmatter` + body, then writes back inside the same tx and
//! commits. The closure runs exactly once and concurrent writers queue
//! at the SQLite layer — same semantics as the legacy file-based flock,
//! but without a separate `.lock` sidecar file.
//!
//! Note: closures run synchronously inside the tx, so they must NOT call
//! into other DB code that opens its own write tx (deadlock risk on the
//! same DB file). Pure data mutations are the supported shape, matching
//! every existing caller.

mod closure_api;
mod diff;
mod engine;
mod partial;
mod row;
mod scope;

pub(in crate::projects::io::work_items) use closure_api::update_standalone_work_item_atomic_as;
pub use closure_api::{
    update_standalone_work_item_atomic, update_standalone_work_item_atomic_by,
    update_standalone_work_item_atomic_serviced, update_work_item_atomic,
    update_work_item_atomic_as, update_work_item_atomic_serviced,
    update_work_item_atomic_with_revisions,
};
pub(crate) use partial::update_standalone_work_item_partial_with_revisions;
pub use partial::{
    update_standalone_work_item_partial, update_work_item_partial,
    update_work_item_partial_with_revisions,
};
pub use scope::AtomicServiceOptions;

// `atomic_tests.rs` reaches these through `use super::*`; they are not
// needed by the facade itself.
#[cfg(test)]
use std::collections::HashMap;

#[cfg(test)]
use super::super::helpers::conn;
#[cfg(test)]
use crate::projects::types::WorkItemFrontmatter;

#[cfg(test)]
#[path = "atomic_tests.rs"]
mod tests;

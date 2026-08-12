//! SQLite-backed work item IO.
//!
//! Submodules, in roughly the order callers reach for them:
//!
//! - `mapping` (private) — frontmatter ↔ row helpers shared by reads.
//! - `extras` (private) — `ExtrasPayload` JSON blob shape.
//! - `crud` — single-row `read_*` / `write_work_item` / `delete_work_item`
//!   / `move_work_item` / `allocate_short_id`. The "blunt" upsert path.
//! - `atomic` — closure-based read-modify-write inside `BEGIN IMMEDIATE`,
//!   plus the wire-friendly `update_work_item_partial` patch wrapper.
//! - `enrichment` — resolves label/member IDs into full objects so the
//!   command layer can return `EnrichedWorkItem` in one round-trip.
//! - `views` — Kanban / Gantt / Calendar projections + status counts
//!   for the WorkItems page.
//! - `batch` — N-at-a-time delete + partial-update with per-item error
//!   collection (no short-circuit).
//!
//! # Frontmatter ↔ row mapping
//!
//! Hot columns on `workitems`:
//!   `id, short_id, title, body, status, priority, assignee, assignee_type,
//!    milestone, parent, start_date, target_date, created_at, updated_at`.
//!
//! `workitem_labels` holds the m:n label association (so query-by-label
//! is a fast index hit).
//!
//! Everything else from `WorkItemFrontmatter` — `starred`, `todos`,
//! `comments`, `history`, `delegations`, `proof_of_work`,
//! `orchestrator_config`, `follow_up_items`, `schedule`,
//! `linked_sessions`, `orchestrator_state` — round-trips through
//! `workitem_extras.extras_json`. We trade
//! queryability for write-once simplicity; nothing in the read path
//! filters on those fields today.
//!
//! # Project lookup
//!
//! All public functions take a `project_slug` for parity with the legacy
//! project-store work item surface. We resolve `slug → project_id`
//! once per call via `resolve_project_id`. The slug column has a unique
//! index, so this is a single-row probe.

mod atomic;
mod batch;
mod crud;
mod enrichment;
mod execution_lock;
mod extras;
mod handoff;
mod history;
mod mapping;
pub mod orchestrator_view;
pub mod sync_metadata;
mod views;
mod workspace;

pub(crate) use atomic::update_standalone_work_item_partial_with_revisions;
pub use atomic::{
    update_standalone_work_item_atomic, update_standalone_work_item_atomic_by,
    update_standalone_work_item_atomic_serviced, update_standalone_work_item_partial,
    update_work_item_atomic, update_work_item_atomic_as, update_work_item_atomic_serviced,
    update_work_item_atomic_with_revisions, update_work_item_partial,
    update_work_item_partial_with_revisions, AtomicServiceOptions,
};
pub use batch::{batch_delete_work_items, batch_update_work_items};
pub(crate) use crud::purge_work_item;
pub(crate) use crud::write_work_item_remote;
pub use crud::{
    allocate_short_id, allocate_standalone_short_id, delete_work_item, move_work_item,
    purge_expired_deleted_work_items, read_all_work_items, read_all_work_items_scoped,
    read_all_work_items_scoped_filtered, read_scheduled_work_item_candidates,
    read_standalone_work_item, read_standalone_work_items, read_standalone_work_items_filtered,
    read_work_item, read_work_item_by_row_id, read_work_item_scoped, restore_work_item,
    write_standalone_work_item, write_work_item,
};
pub(crate) use crud::{
    allocate_short_id_in_tx, resolve_project_scope_in_tx, write_work_item_in_tx,
};
pub use enrichment::{
    read_all_work_items_enriched, read_all_work_items_enriched_scoped,
    read_all_work_items_enriched_scoped_filtered, read_work_item_enriched,
    read_work_item_enriched_scoped, update_work_item_partial_enriched,
};
pub(crate) use execution_lock::apply_execution_claim;
pub use execution_lock::{acquire_execution_lock, release_execution_lock};
pub use handoff::{transition_standalone_work_item_handoff, transition_work_item_handoff};
pub(crate) use sync_metadata::read_standalone_sync_metadata;
pub use sync_metadata::{
    apply_remote_merge, find_by_external_ref, read_sync_metadata, FieldRevision, SyncMetadata,
    REVISION_SOURCE_LOCAL,
};
pub use views::{
    read_work_items_view_data, read_work_items_view_data_scoped,
    read_work_items_view_data_scoped_for_view,
};
pub use workspace::read_workspace_work_items_data;

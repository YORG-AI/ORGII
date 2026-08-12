//! TS-bridge for the `orgii_collab` sync provider (design §16.8).
//!
//! Shared projects / work items are **native local rows** (design §16.2):
//! they live in the same `projects` / `workitems` tables as everything
//! else, under a `project_orgs` row aliased to the collab org
//! (`source='collab'`, `sync_provider='orgii_collab'`). Local mutations
//! under such an org enqueue outbox rows exactly like the Linear/GitHub
//! adapters do — but with `outbox_entries.org_id` set, which routes them
//! to THIS bridge instead of the in-process worker (both worker claim
//! paths filter `org_id IS NULL`).
//!
//! Supabase HTTP and credentials never enter Rust: the TS
//! `CollabSyncEngine`'s ProjectSyncChannel drives three Tauri commands —
//!
//! - [`drain_outbox`]: claim pending org rows (oldest first), coalesce
//!   them per entity, and hydrate a full wire-shaped snapshot of the
//!   entity's CURRENT local state. Whole-row snapshots are correct here
//!   because the server upsert RPCs are whole-row OCC upserts (§16.4);
//!   the per-row `field_path` trail is still returned for the merge
//!   policy and observability.
//! - [`ack_outbox`]: mark pushed rows succeeded (recording the server
//!   row version into `collab_remote_version`), requeue OCC-conflicted
//!   rows immediately (the engine applies the fresh remote row and
//!   retries within the same cycle), or fail-with-backoff.
//! - [`apply_remote`]: apply pulled server rows into SQLite. Tombstones
//!   soft-delete; live rows merge per-field through the existing
//!   `FieldRevision` resolver with the same policy as the Linear
//!   adapter (remote wins unless the local watermark is newer). None of
//!   the apply paths emit outbox rows, so remote-applied changes can
//!   never echo back out.
//!
//! Version bookkeeping: `projects.collab_remote_version` /
//! `workitems.collab_remote_version` hold the last server version this
//! client acknowledged (push) or applied (pull). `apply_remote` skips
//! rows whose version is not newer — which is also what makes a client's
//! own pushes idempotent when they come back around in the pull delta.

mod apply;
mod outbox;
mod wire;

#[cfg(test)]
mod tests;

/// `project_orgs.sync_provider` value marking a collab-aliased org.
pub const COLLAB_SYNC_PROVIDER: &str = "orgii_collab";
/// `project_orgs.source` value for collab-aliased orgs (design §16.2).
pub const COLLAB_ORG_SOURCE: &str = "collab";

pub const KIND_PROJECT: &str = "project";
pub const KIND_WORK_ITEM: &str = "work_item";
pub const OP_UPSERT: &str = "upsert";
pub const OP_DELETE: &str = "delete";

pub use apply::{apply_remote, ensure_collab_project_org, CollabRemoteEntity};
pub use outbox::{
    ack_outbox, collab_org_for_project, drain_outbox, is_collab_org, outbox_pending_ids,
    record_project_work_item_update, record_project_write, record_work_item_payload_touch,
    record_work_item_write, CollabAckResult, CollabPendingEntity, CollabPushItem,
};
pub(crate) use outbox::{
    record_project_org_move_in_connection, record_property_definitions_touch,
    record_work_item_payload_touch_in_connection,
};

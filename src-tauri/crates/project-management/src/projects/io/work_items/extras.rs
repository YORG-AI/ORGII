//! Shared `ExtrasPayload` shape — the JSON blob persisted to
//! `workitem_extras.extras_json`.
//!
//! Both `crud` (write path) and `atomic` (RMW path) need to serialize
//! and deserialize the same set of low-cardinality work-item fields, so
//! the struct lives here as the single source of truth. Hot, queryable
//! columns stay on `workitems`; everything else round-trips through
//! this blob.
//!
//! The `flatten`-ed `other` map captures any field we don't model yet,
//! so a forward-compatible writer (e.g. a newer client) doesn't silently
//! lose data on a write→read cycle.
//!
//! Sync-related maps:
//! - `field_revisions` — per-field `(mtime_ms, source)` watermarks the
//!   sync resolver compares against incoming external changes.
//! - `external_refs` — per-adapter `external_id` so inbound pulls can
//!   identity-match a remote entity to the local work item without a
//!   separate side table.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

use crate::projects::types::{
    CommentEntry, DelegationEntry, FollowUpRef, LinkedSession, OrchestratorConfig,
    OrchestratorState, ProofOfWork, TodoEntry, WorkItemCloseOut, WorkItemExecutionLock,
    WorkItemFrontmatter, WorkItemHandoff, WorkItemHistoryEvent, WorkItemOriginSession,
    WorkItemRoutineSource, WorkItemSchedule, WorkItemWorkProduct,
};

/// Per-field watermark stamped by the sync framework. Used by the
/// resolver in `sync::conflict` to compare against
/// [`super::super::super::sync::adapter::ExternalChange::remote_updated_at`].
///
/// `mtime` is unix-epoch milliseconds. `source` is `"local"` for
/// user-driven mutations and the adapter id (`"linear"`, …) for
/// inbound merges.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FieldRevision {
    pub mtime: i64,
    pub source: String,
}

/// Source identifier used in [`FieldRevision::source`] for user-driven
/// mutations. Adapter-driven mutations use the adapter id instead.
pub const REVISION_SOURCE_LOCAL: &str = "local";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(super) struct ExtrasPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_session: Option<WorkItemOriginSession>,
    #[serde(default)]
    pub starred: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub todos: Vec<TodoEntry>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub comments: Vec<CommentEntry>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub history: Vec<WorkItemHistoryEvent>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub delegations: Vec<DelegationEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handoff: Option<WorkItemHandoff>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage: Option<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub linked_sessions: Vec<LinkedSession>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proof_of_work: Option<ProofOfWork>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orchestrator_config: Option<OrchestratorConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orchestrator_state: Option<OrchestratorState>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub follow_up_items: Vec<FollowUpRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule: Option<WorkItemSchedule>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub routine_source: Option<WorkItemRoutineSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_lock: Option<WorkItemExecutionLock>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub close_out: Option<WorkItemCloseOut>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub work_products: Vec<WorkItemWorkProduct>,
    /// Per-field revision watermarks the sync resolver consults. Keyed
    /// by the local field name (`"title"`, `"status"`, …; the same
    /// strings produced by [`super::super::super::sync::adapter::EntityField::as_local_name`]).
    /// Empty by default for items that were never touched by sync.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub field_revisions: HashMap<String, FieldRevision>,
    /// `adapter_id → external_id` map. Stamped by the worker on push
    /// success and on inbound merge; consulted by the resolver to
    /// identify which local item an inbound `merge_external` row
    /// corresponds to. Empty by default.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub external_refs: HashMap<String, String>,
    /// Catch-all for fields we don't model yet so a forward-compatible
    /// write doesn't silently drop them on a round trip.
    #[serde(default, flatten)]
    pub other: serde_json::Map<String, JsonValue>,
}

impl ExtrasPayload {
    pub(super) fn from_frontmatter(fm: &WorkItemFrontmatter) -> Self {
        Self {
            created_by: fm.created_by.clone(),
            origin_session: fm.origin_session.clone(),
            starred: fm.starred,
            todos: fm.todos.clone(),
            comments: fm.comments.clone(),
            history: fm.history.clone(),
            delegations: fm.delegations.clone(),
            handoff: fm.handoff.clone(),
            stage: fm.stage,
            linked_sessions: fm.linked_sessions.clone(),
            proof_of_work: fm.proof_of_work.clone(),
            orchestrator_config: fm.orchestrator_config.clone(),
            orchestrator_state: fm.orchestrator_state.clone(),
            follow_up_items: fm.follow_up_items.clone(),
            schedule: fm.schedule.clone(),
            routine_source: fm.routine_source.clone(),
            execution_lock: fm.execution_lock.clone(),
            close_out: fm.close_out.clone(),
            work_products: fm.work_products.clone(),
            // Sync metadata is not surfaced through the frontmatter
            // (not user-visible). The create path starts with empty
            // maps; existing items keep their watermarks via the
            // read→mutate→write loop in `update_work_item_atomic`.
            field_revisions: HashMap::new(),
            external_refs: HashMap::new(),
            other: serde_json::Map::new(),
        }
    }
}

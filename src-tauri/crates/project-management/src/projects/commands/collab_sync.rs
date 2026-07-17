//! Tauri commands bridging the orgii_collab outbox to the TS
//! CollabSyncEngine (design §16.8).
//!
//! Supabase HTTP and credentials live entirely in the TS collaboration
//! layer; these commands only move data between SQLite and the engine:
//! drain (claim + hydrate pending pushes), ack (persist push outcomes),
//! apply (write pulled server rows into the local domain, per-field
//! merged, echo-free).

use crate::sync::collab_bridge;
use crate::sync::collab_bridge::{
    CollabAckResult, CollabPendingEntity, CollabPushItem, CollabRemoteEntity,
};

use super::super::io;
use super::super::types::ProjectOrg;

/// Claim up to `max` pending orgii_collab outbox rows for one local
/// project org (oldest first), coalesced per entity and hydrated with a
/// full wire snapshot of current local state.
#[tauri::command]
pub async fn project_collab_outbox_drain(
    org_id: String,
    max: Option<u32>,
) -> Result<Vec<CollabPushItem>, String> {
    tokio::task::spawn_blocking(move || {
        collab_bridge::drain_outbox(&org_id, max.unwrap_or(50).clamp(1, 200))
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))?
}

#[tauri::command]
pub async fn project_collab_outbox_pending_ids(
    org_id: String,
) -> Result<Vec<CollabPendingEntity>, String> {
    tokio::task::spawn_blocking(move || collab_bridge::outbox_pending_ids(&org_id))
        .await
        .map_err(|err| format!("Task join error: {}", err))?
}

/// Persist push outcomes for previously drained rows: success records
/// the server row version, ORGII_CONFLICT requeues immediately for the
/// engine's in-cycle retry, other errors walk the standard backoff.
#[tauri::command]
pub async fn project_collab_outbox_ack(results: Vec<CollabAckResult>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || collab_bridge::ack_outbox(results))
        .await
        .map_err(|err| format!("Task join error: {}", err))?
}

/// Apply pulled server project / work-item rows into SQLite. Tombstones
/// soft-delete; live rows merge per-field through the FieldRevision
/// resolver. Never emits outbox rows (no echo). Returns how many
/// entities changed local state.
#[tauri::command]
pub async fn project_collab_apply_remote(
    org_id: String,
    org_name: Option<String>,
    entities: Vec<CollabRemoteEntity>,
) -> Result<usize, String> {
    tokio::task::spawn_blocking(move || {
        collab_bridge::apply_remote(&org_id, org_name.as_deref(), entities)
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))?
}

/// Mark a local project org as backed by the orgii collab plane
/// (`source='collab'`, `sync_provider='orgii_collab'`). Called by
/// `ensureProjectOrgForCollabOrg` after creating/locating the aliased
/// org row; `apply_remote` self-heals the same flag on pull.
#[tauri::command]
pub async fn project_configure_org_collab_sync(
    org_id: String,
    external_org_id: Option<String>,
) -> Result<ProjectOrg, String> {
    tokio::task::spawn_blocking(move || {
        io::configure_project_org_collab_sync(&org_id, external_org_id.as_deref())
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))?
}

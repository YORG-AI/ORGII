//! In-transaction audit + change-watermark helpers.
//!
//! Both helpers take the caller's open transaction so audit rows, the
//! `pm_change_seq` bump and the entity mutation commit atomically — the
//! frozen persistence invariant from the v1 design (§19). They are called
//! from the single atomic RMW choke point in
//! `projects::io::work_items::atomic`, which means every work-item
//! mutation (UI patch, agent tool, sync merge, future CLI) is audited and
//! watermarked without per-caller wiring.

use rusqlite::{params, Transaction};

use crate::projects::types::WorkItemMutationActor;

fn map_db<T>(result: rusqlite::Result<T>) -> Result<T, String> {
    result.map_err(|err| format!("pm audit: {}", err))
}

/// Bump the single-row cross-process change watermark and return the new
/// sequence value. Desktop hosts poll this cheaply (or watch the db file)
/// to learn that an external process — e.g. the PM CLI — committed a
/// mutation, then run incremental reconciliation.
pub(crate) fn bump_change_seq(tx: &Transaction<'_>) -> Result<i64, String> {
    map_db(tx.execute(
        "INSERT INTO pm_change_seq (id, seq) VALUES (1, 1)
         ON CONFLICT(id) DO UPDATE SET seq = seq + 1",
        [],
    ))?;
    map_db(tx.query_row("SELECT seq FROM pm_change_seq WHERE id = 1", [], |row| {
        row.get(0)
    }))
}

pub(crate) struct AuditEventRow<'a> {
    pub operation: &'a str,
    pub entity_type: &'a str,
    pub entity_id: &'a str,
    pub project_slug: Option<&'a str>,
    pub org_id: Option<&'a str>,
    pub actor: Option<&'a WorkItemMutationActor>,
    pub revision: i64,
    pub seq: i64,
    pub payload: serde_json::Value,
}

/// Append one row to the append-only `pm_audit_events` table.
///
/// `actor_kind` is reserved for the protocol ActorRef kind (human/agent/
/// service/team) that arrives with the Phase 3 CLI context; the legacy
/// `WorkItemMutationActor` only carries id + display name.
pub(crate) fn append_audit_event(
    tx: &Transaction<'_>,
    event: &AuditEventRow<'_>,
) -> Result<(), String> {
    let (actor_id, actor_name) = match event.actor {
        Some(actor) => (Some(actor.id.as_str()), Some(actor.name.as_str())),
        None => (None, None),
    };
    let payload_json = serde_json::to_string(&event.payload)
        .map_err(|err| format!("pm audit: serialize payload: {}", err))?;
    map_db(tx.execute(
        "INSERT INTO pm_audit_events (
            occurred_at, actor_kind, actor_id, actor_name, operation, entity_type,
            entity_id, project_slug, org_id, revision, seq, payload_json
         ) VALUES (?1, NULL, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            chrono::Utc::now().timestamp_millis(),
            actor_id,
            actor_name,
            event.operation,
            event.entity_type,
            event.entity_id,
            event.project_slug,
            event.org_id,
            event.revision,
            event.seq,
            payload_json,
        ],
    ))?;
    Ok(())
}

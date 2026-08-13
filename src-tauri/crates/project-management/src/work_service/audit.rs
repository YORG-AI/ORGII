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
    map_db(
        tx.query_row("SELECT seq FROM pm_change_seq WHERE id = 1", [], |row| {
            row.get(0)
        }),
    )
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

/// One work-item status crossing recorded in the audit stream.
#[derive(Debug, Clone)]
pub struct AuditStatusTransition {
    pub seq: i64,
    pub entity_id: String,
    pub project_slug: Option<String>,
    pub org_id: Option<String>,
    pub status_from: String,
    pub status_to: String,
}

/// Read work-item status transitions committed after `after_seq`.
///
/// Serves the desktop's cross-process bridge: CLI mutations audit their
/// `status_from`/`status_to` in the same transaction, so scanning the
/// stream is the reliable way to observe transitions made by other
/// processes (the in-process notifier cannot fire for them).
pub fn read_status_transitions_since(after_seq: i64) -> Result<Vec<AuditStatusTransition>, String> {
    let connection =
        database::db::get_projects_connection().map_err(|err| format!("pm audit: {}", err))?;
    let mut stmt = map_db(connection.prepare(
        "SELECT seq, entity_id, project_slug, org_id, payload_json
         FROM pm_audit_events
         WHERE entity_type = 'work_item' AND seq > ?1 AND payload_json LIKE '%status_to%'
         ORDER BY seq ASC",
    ))?;
    let rows = map_db(stmt.query_map(params![after_seq], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, String>(4)?,
        ))
    }))?;
    let mut transitions = Vec::new();
    for row in rows {
        let (seq, entity_id, project_slug, org_id, payload_json) = map_db(row)?;
        let Ok(payload) = serde_json::from_str::<serde_json::Value>(&payload_json) else {
            continue;
        };
        let (Some(status_from), Some(status_to)) = (
            payload.get("status_from").and_then(|value| value.as_str()),
            payload.get("status_to").and_then(|value| value.as_str()),
        ) else {
            continue;
        };
        transitions.push(AuditStatusTransition {
            seq,
            entity_id,
            project_slug,
            org_id,
            status_from: status_from.to_string(),
            status_to: status_to.to_string(),
        });
    }
    Ok(transitions)
}

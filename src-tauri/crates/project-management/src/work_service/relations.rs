use crate::projects::io as project_io;
use crate::projects::types::WorkItemMutationActor;

use super::{audit, error, read_project_work_item_revision};

const PORTABLE_RELATION_KINDS: &[&str] = &[
    "depends_on",
    "relates_to",
    "duplicates",
    "implements",
    "supersedes",
    "continued_by",
    "generated_by",
    "participated_in",
];

/// Canonical `work.relate` (`work.relation.add`): typed semantic edge in
/// the `pm_relations` table, audited + watermarked in one transaction.
pub fn relate_project_work_item(
    project_slug: &str,
    short_id: &str,
    kind: &str,
    target_ref: &str,
    actor: Option<&WorkItemMutationActor>,
) -> Result<(), String> {
    if !PORTABLE_RELATION_KINDS.contains(&kind) {
        return Err(format!(
            "{}:relation kind '{}' is not portable",
            error::PREFIX,
            kind
        ));
    }
    let _ = read_project_work_item_revision(project_slug, short_id)?;
    let mut connection = project_io::helpers::conn()?;
    let tx = connection
        .transaction()
        .map_err(|err| format!("pm relate tx: {}", err))?;
    tx.execute(
        "INSERT INTO pm_relations (entity_type, entity_id, kind, target_ref, created_at, actor_id)
         VALUES ('work_item', ?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![
            short_id,
            kind,
            target_ref,
            chrono::Utc::now().timestamp_millis(),
            actor.map(|a| a.id.as_str()),
        ],
    )
    .map_err(|err| format!("pm relate: {}", err))?;
    let seq = audit::bump_change_seq(&tx)?;
    audit::append_audit_event(
        &tx,
        &audit::AuditEventRow {
            operation: "work.relate",
            entity_type: "work_item",
            entity_id: short_id,
            project_slug: Some(project_slug),
            org_id: None,
            actor,
            revision: 0,
            seq,
            payload: serde_json::json!({ "kind": kind, "targetRef": target_ref }),
        },
    )?;
    tx.commit()
        .map_err(|err| format!("pm relate commit: {}", err))
}

/// Read the typed relations of a project-scoped item.
pub fn list_work_item_relations(short_id: &str) -> Result<Vec<serde_json::Value>, String> {
    let connection = project_io::helpers::conn()?;
    let mut statement = connection
        .prepare(
            "SELECT kind, target_ref, created_at FROM pm_relations
             WHERE entity_type = 'work_item' AND entity_id = ?1
             ORDER BY id",
        )
        .map_err(|err| format!("pm relations: {}", err))?;
    let rows = statement
        .query_map(rusqlite::params![short_id], |row| {
            Ok(serde_json::json!({
                "kind": row.get::<_, String>(0)?,
                "targetRef": row.get::<_, String>(1)?,
                "createdAt": row.get::<_, i64>(2)?,
            }))
        })
        .map_err(|err| format!("pm relations: {}", err))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("pm relations: {}", err))?;
    Ok(rows)
}

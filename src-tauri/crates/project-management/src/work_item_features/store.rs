use rusqlite::{params, Connection, OptionalExtension};

use super::WorkItemScope;

#[derive(Debug, Clone)]
pub(super) struct ResolvedWorkItem {
    pub row_id: String,
    pub scope_key: String,
    pub project_slug: Option<String>,
    pub org_id: String,
    pub short_id: String,
    pub title: String,
    pub body: String,
    pub status: String,
    pub revision: i64,
    pub created_by: Option<String>,
    pub assigned_human_id: Option<String>,
    pub extras: serde_json::Value,
}

pub(super) fn iso8601(epoch_ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(epoch_ms)
        .map(|value| value.to_rfc3339())
        .unwrap_or_else(|| epoch_ms.to_string())
}

pub(super) fn scope_key(project_slug: Option<&str>, org_id: &str) -> String {
    project_slug
        .map(|slug| format!("project:{slug}"))
        .unwrap_or_else(|| format!("org:{org_id}"))
}

pub(super) fn resolve_work_item(
    connection: &Connection,
    scope: &WorkItemScope,
) -> Result<ResolvedWorkItem, String> {
    let result = match scope.project_slug.as_deref() {
        Some(slug) => connection
            .query_row(
                "SELECT w.id, p.slug, w.org_id, w.short_id, w.title, w.body,
                        w.status, w.local_version,
                        json_extract(e.extras_json, '$.created_by'),
                        w.assigned_human_id, e.extras_json
                   FROM workitems w
                   JOIN projects p ON p.id = w.project_id
                   LEFT JOIN workitem_extras e ON e.work_item_id = w.id
                  WHERE p.slug = ?1 AND w.short_id = ?2 AND w.deleted_at IS NULL",
                params![slug, scope.work_item_id],
                row_to_resolved,
            )
            .optional(),
        None => connection
            .query_row(
                "SELECT w.id, NULL, w.org_id, w.short_id, w.title, w.body,
                        w.status, w.local_version,
                        json_extract(e.extras_json, '$.created_by'),
                        w.assigned_human_id, e.extras_json
                   FROM workitems w
                   LEFT JOIN workitem_extras e ON e.work_item_id = w.id
                  WHERE w.project_id IS NULL AND w.org_id = ?1
                    AND w.short_id = ?2 AND w.deleted_at IS NULL",
                params![scope.org_id, scope.work_item_id],
                row_to_resolved,
            )
            .optional(),
    }
    .map_err(|err| format!("work item feature store: {err}"))?
    .ok_or_else(|| format!("Work item '{}' not found", scope.work_item_id))?;
    Ok(result)
}

fn row_to_resolved(row: &rusqlite::Row<'_>) -> rusqlite::Result<ResolvedWorkItem> {
    let project_slug: Option<String> = row.get(1)?;
    let org_id: String = row.get(2)?;
    let raw_extras: Option<String> = row.get(10)?;
    Ok(ResolvedWorkItem {
        row_id: row.get(0)?,
        scope_key: scope_key(project_slug.as_deref(), &org_id),
        project_slug,
        org_id,
        short_id: row.get(3)?,
        title: row.get(4)?,
        body: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
        status: row.get(6)?,
        revision: row.get(7)?,
        created_by: row.get(8)?,
        assigned_human_id: row.get(9)?,
        extras: raw_extras
            .as_deref()
            .and_then(|raw| serde_json::from_str(raw).ok())
            .unwrap_or_else(|| serde_json::json!({})),
    })
}

pub(super) fn persist_extras(
    connection: &Connection,
    item: &ResolvedWorkItem,
    extras: &serde_json::Value,
    now: i64,
) -> Result<i64, String> {
    let raw = serde_json::to_string(extras)
        .map_err(|err| format!("work item extras serialization: {err}"))?;
    connection
        .execute(
            "INSERT INTO workitem_extras (work_item_id, extras_json)
             VALUES (?1, ?2)
             ON CONFLICT(work_item_id) DO UPDATE SET extras_json = excluded.extras_json",
            params![item.row_id, raw],
        )
        .map_err(|err| format!("work item feature store: {err}"))?;
    connection
        .execute(
            "UPDATE workitems
                SET local_version = local_version + 1, updated_at = ?2
              WHERE id = ?1",
            params![item.row_id, now],
        )
        .map_err(|err| format!("work item feature store: {err}"))?;
    Ok(item.revision.saturating_add(1))
}

pub(super) fn append_audit(
    tx: &rusqlite::Transaction<'_>,
    item: &ResolvedWorkItem,
    operation: &str,
    revision: i64,
    actor_id: Option<&str>,
    payload: serde_json::Value,
) -> Result<(), String> {
    let actor = actor_id.map(|id| crate::projects::types::WorkItemMutationActor {
        id: id.to_string(),
        name: id.to_string(),
    });
    let seq = crate::work_service::audit::bump_change_seq(tx)?;
    crate::work_service::audit::append_audit_event(
        tx,
        &crate::work_service::audit::AuditEventRow {
            operation,
            entity_type: "work_item",
            entity_id: &item.short_id,
            project_slug: item.project_slug.as_deref(),
            org_id: Some(&item.org_id),
            actor: actor.as_ref(),
            revision,
            seq,
            payload,
        },
    )
}

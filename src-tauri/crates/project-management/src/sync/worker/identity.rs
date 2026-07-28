//! Reconciles adapter-owned identifiers with local work-item short ids.
//!
//! A work item still has an internal `workitems.id` for relational storage,
//! but adapters may declare that their external id is also the canonical
//! user-facing short id. GitHub does this for issue numbers: issue `#210`
//! is stored with short id `210`, not a separately allocated `ORG-0210`.

use rusqlite::{params, OptionalExtension};
use serde_json::Value;
use tracing::warn;

use super::io;
use crate::sync::adapters;

/// Normalize adapter-owned short ids that predate the adapter capability.
///
/// This runs once when the sync worker starts. It is deliberately generic:
/// the adapter decides whether an external id should replace the local short
/// id, while this function only handles the relational rename.
pub(super) fn normalize_existing_external_short_ids() -> Result<usize, String> {
    let connection = io::conn()?;
    let candidates = {
        let mut statement = connection
            .prepare(
                "SELECT p.slug, p.sync_kind, w.short_id, e.extras_json
                   FROM workitems w
                   JOIN projects p ON p.id = w.project_id
                   JOIN workitem_extras e ON e.work_item_id = w.id
                  WHERE p.sync_kind IS NOT NULL AND p.sync_kind != 'none'",
            )
            .map_err(|err| format!("DB error (prepare external-id normalization): {err}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|err| format!("DB error (query external-id normalization): {err}"))?;
        let mut candidates = Vec::new();
        for row in rows {
            candidates
                .push(row.map_err(|err| format!("DB error (read external-id candidate): {err}"))?);
        }
        candidates
    };
    drop(connection);

    let mut normalized = 0;
    for (project_slug, adapter_id, current_short_id, extras_json) in candidates {
        let Some(adapter) = adapters::get(&adapter_id) else {
            continue;
        };
        let Ok(extras) = serde_json::from_str::<Value>(&extras_json) else {
            continue;
        };
        let Some(external_id) = extras
            .get("external_refs")
            .and_then(|refs| refs.get(&adapter_id))
            .and_then(Value::as_str)
        else {
            continue;
        };
        let Some(preferred_short_id) = adapter.preferred_work_item_short_id(external_id) else {
            continue;
        };
        if preferred_short_id == current_short_id {
            continue;
        }

        match rename_work_item_short_id(&project_slug, &current_short_id, &preferred_short_id) {
            Ok(_) => normalized += 1,
            Err(err) => warn!(
                "[sync::worker] could not normalize {} from '{}' to '{}': {}",
                project_slug, current_short_id, preferred_short_id, err
            ),
        }
    }
    Ok(normalized)
}

/// Rename one work item's short id and the local references that use it.
/// The stable `workitems.id` primary key is intentionally unchanged.
pub(super) fn rename_work_item_short_id(
    project_slug: &str,
    current_short_id: &str,
    preferred_short_id: &str,
) -> Result<String, String> {
    if current_short_id == preferred_short_id {
        return Ok(preferred_short_id.to_string());
    }

    let mut connection = io::conn()?;
    let transaction = connection
        .transaction()
        .map_err(|err| format!("DB error (begin short-id rename): {err}"))?;
    let project_id: String = transaction
        .query_row(
            "SELECT id FROM projects WHERE slug = ?1",
            params![project_slug],
            |row| row.get(0),
        )
        .map_err(|err| format!("Project '{project_slug}' not found for short-id rename: {err}"))?;

    let current_work_item_id: Option<String> = transaction
        .query_row(
            "SELECT id FROM workitems WHERE project_id = ?1 AND short_id = ?2",
            params![&project_id, current_short_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| format!("DB error (find current short id): {err}"))?;
    let preferred_work_item_id: Option<String> = transaction
        .query_row(
            "SELECT id FROM workitems WHERE project_id = ?1 AND short_id = ?2",
            params![&project_id, preferred_short_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| format!("DB error (check preferred short id): {err}"))?;

    let Some(current_work_item_id) = current_work_item_id else {
        if preferred_work_item_id.is_some() {
            return Ok(preferred_short_id.to_string());
        }
        return Err(format!(
            "work item '{}' no longer exists in project '{}'",
            current_short_id, project_slug
        ));
    };
    if let Some(existing_id) = preferred_work_item_id {
        if existing_id != current_work_item_id {
            return Err(format!(
                "preferred short id '{}' is already used by another work item",
                preferred_short_id
            ));
        }
    }

    transaction
        .execute(
            "UPDATE workitems SET short_id = ?1 WHERE id = ?2",
            params![preferred_short_id, &current_work_item_id],
        )
        .map_err(|err| format!("DB error (rename work item short id): {err}"))?;
    transaction
        .execute(
            "UPDATE workitems SET parent = ?1 WHERE project_id = ?2 AND parent = ?3",
            params![preferred_short_id, &project_id, current_short_id],
        )
        .map_err(|err| format!("DB error (rename parent short-id refs): {err}"))?;
    transaction
        .execute(
            "UPDATE outbox_entries
                SET entity_id = ?1
              WHERE project_slug = ?2 AND entity_type = 'work_item' AND entity_id = ?3",
            params![preferred_short_id, project_slug, current_short_id],
        )
        .map_err(|err| format!("DB error (rename outbox short-id refs): {err}"))?;
    transaction
        .execute(
            "UPDATE outbox_conflicts
                SET entity_id = ?1
              WHERE project_slug = ?2 AND entity_type = 'work_item' AND entity_id = ?3",
            params![preferred_short_id, project_slug, current_short_id],
        )
        .map_err(|err| format!("DB error (rename conflict short-id refs): {err}"))?;

    rewrite_follow_up_short_id_refs(
        &transaction,
        &project_id,
        current_short_id,
        preferred_short_id,
    )?;

    transaction
        .commit()
        .map_err(|err| format!("DB error (commit short-id rename): {err}"))?;
    Ok(preferred_short_id.to_string())
}

fn rewrite_follow_up_short_id_refs(
    transaction: &rusqlite::Transaction<'_>,
    project_id: &str,
    current_short_id: &str,
    preferred_short_id: &str,
) -> Result<(), String> {
    let extras_rows = {
        let mut statement = transaction
            .prepare(
                "SELECT e.work_item_id, e.extras_json
                   FROM workitem_extras e
                   JOIN workitems w ON w.id = e.work_item_id
                  WHERE w.project_id = ?1",
            )
            .map_err(|err| format!("DB error (prepare follow-up short-id refs): {err}"))?;
        let rows = statement
            .query_map(params![project_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|err| format!("DB error (query follow-up short-id refs): {err}"))?;
        let mut extras_rows = Vec::new();
        for row in rows {
            extras_rows.push(row.map_err(|err| format!("DB error (read follow-up ref): {err}"))?);
        }
        extras_rows
    };

    for (work_item_id, raw_json) in extras_rows {
        let Ok(mut extras) = serde_json::from_str::<Value>(&raw_json) else {
            continue;
        };
        let Some(follow_ups) = extras
            .get_mut("follow_up_items")
            .and_then(Value::as_array_mut)
        else {
            continue;
        };
        let mut changed = false;
        for follow_up in follow_ups {
            let Some(short_id) = follow_up.get_mut("short_id") else {
                continue;
            };
            if short_id.as_str() == Some(current_short_id) {
                *short_id = Value::String(preferred_short_id.to_string());
                changed = true;
            }
        }
        if !changed {
            continue;
        }
        let next_json = serde_json::to_string(&extras)
            .map_err(|err| format!("serialize renamed follow-up refs: {err}"))?;
        transaction
            .execute(
                "UPDATE workitem_extras SET extras_json = ?1 WHERE work_item_id = ?2",
                params![next_json, work_item_id],
            )
            .map_err(|err| format!("DB error (write renamed follow-up refs): {err}"))?;
    }
    Ok(())
}

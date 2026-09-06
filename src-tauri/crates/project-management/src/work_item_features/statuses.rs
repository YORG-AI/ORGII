//! Org-scoped custom work-item statuses.
//!
//! A custom status is a named alias over one of the built-in status
//! buckets (its `category`). `workitems.status` keeps storing the raw
//! key — no migration — and every surface that interprets a status
//! resolves it through its definition first, so a custom status inherits its
//! category's behavior (filters, counts, kanban columns, terminal archival)
//! wholesale. Archived definitions remain authoritative for historical rows,
//! while creation/selection surfaces expose only active definitions. Built-in
//! statuses are implicit and never stored as rows; their keys are reserved.

use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use crate::projects::io::helpers::{conn, now_ms};

const ORG_SCOPE_MISMATCH: &str = "PM_ERR:ORG_SCOPE_MISMATCH";

fn org_scope_mismatch(entity: &str, id: &str) -> String {
    format!("{ORG_SCOPE_MISMATCH}:{entity}:{id}")
}

/// The built-in buckets a custom status can map onto.
pub const STATUS_CATEGORIES: [&str; 7] = [
    "backlog",
    "planned",
    "in_progress",
    "in_review",
    "blocked",
    "completed",
    "cancelled",
];

/// Raw status vocabulary already interpreted by the app; reserved so a
/// custom key can never shadow a built-in.
const RESERVED_STATUS_KEYS: [&str; 13] = [
    "backlog",
    "planned",
    "todo",
    "open",
    "in_progress",
    "in_review",
    "blocked",
    "completed",
    "done",
    "closed",
    "cancelled",
    "canceled",
    "duplicate",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusDefinition {
    pub id: String,
    pub org_id: String,
    pub key: String,
    pub name: String,
    pub category: String,
    pub color: Option<String>,
    pub description: Option<String>,
    pub position: i64,
    pub archived_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertStatusDefinitionRequest {
    pub id: Option<String>,
    pub org_id: String,
    pub key: Option<String>,
    pub name: String,
    pub category: Option<String>,
    pub color: Option<String>,
    pub description: Option<String>,
    pub position: Option<i64>,
}

fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 32
        && key
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
        && key
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

fn validate_name(name: &str) -> Result<String, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Status name is required".to_string());
    }
    Ok(name)
}

fn validate_key_and_category(key: &str, category: &str) -> Result<String, String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("Status key is required".to_string());
    }
    if !valid_key(key) {
        return Err("PM_ERR:STATUS_KEY_INVALID".to_string());
    }
    if RESERVED_STATUS_KEYS.contains(&key) {
        return Err("PM_ERR:STATUS_KEY_RESERVED".to_string());
    }
    if !STATUS_CATEGORIES.contains(&category) {
        return Err("PM_ERR:STATUS_CATEGORY_INVALID".to_string());
    }
    Ok(key.to_string())
}

pub(crate) fn upsert_definition(
    request: UpsertStatusDefinitionRequest,
) -> Result<StatusDefinition, String> {
    let name = validate_name(&request.name)?;
    let mut connection = conn()?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| format!("status definition tx: {err}"))?;
    let now = now_ms();

    if let Some(id) = request.id.as_deref().filter(|id| !id.trim().is_empty()) {
        let existing_org: Option<String> = tx
            .query_row(
                "SELECT org_id FROM pm_status_definitions WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|err| format!("status definition store: {err}"))?;
        if existing_org
            .as_deref()
            .is_some_and(|stored_org| stored_org != request.org_id)
        {
            return Err(org_scope_mismatch("status_definition", id));
        }
        let existing = read_definition(&tx, &request.org_id, id)?;
        let requested_key = validate_key_and_category(
            request.key.as_deref().unwrap_or(&existing.key),
            request.category.as_deref().unwrap_or(&existing.category),
        )?;
        if requested_key != existing.key {
            return Err("PM_ERR:STATUS_KEY_IMMUTABLE".to_string());
        }
        if let Some(category) = request.category.as_deref() {
            if category != existing.category {
                return Err("PM_ERR:STATUS_CATEGORY_IMMUTABLE".to_string());
            }
        }
        tx.execute(
            "UPDATE pm_status_definitions
                    SET name = ?3, color = ?4, description = ?5,
                        position = ?6, updated_at = ?7
                  WHERE org_id = ?1 AND id = ?2",
            params![
                request.org_id,
                id,
                name,
                request.color,
                request.description,
                request.position.unwrap_or(existing.position),
                now
            ],
        )
        .map_err(|err| format!("status definition store: {err}"))?;
        crate::sync::collab_bridge::record_status_definitions_touch(&tx, &request.org_id, id)?;
        let definition = read_definition(&tx, &request.org_id, id)?;
        tx.commit()
            .map_err(|err| format!("status definition commit: {err}"))?;
        return Ok(definition);
    }

    let key = request
        .key
        .as_deref()
        .ok_or_else(|| "Status key is required".to_string())?;
    let category = request
        .category
        .as_deref()
        .ok_or_else(|| "Status category is required".to_string())?
        .to_string();
    let key = validate_key_and_category(key, &category)?;
    let id = format!("wis_{}", uuid::Uuid::new_v4().simple());
    tx.execute(
        "INSERT INTO pm_status_definitions (
                 id, org_id, key, name, category, color, description,
                 position, archived_at, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?9, ?9)",
        params![
            id,
            request.org_id,
            key,
            name,
            category,
            request.color,
            request.description,
            request.position.unwrap_or(0),
            now
        ],
    )
    .map_err(|err| {
        if err.to_string().contains("UNIQUE") {
            format!("PM_ERR:ALREADY_EXISTS:{key}")
        } else {
            format!("status definition store: {err}")
        }
    })?;
    crate::sync::collab_bridge::record_status_definitions_touch(&tx, &request.org_id, &id)?;
    let definition = read_definition(&tx, &request.org_id, &id)?;
    tx.commit()
        .map_err(|err| format!("status definition commit: {err}"))?;
    Ok(definition)
}

pub(crate) fn set_definition_archived(
    org_id: &str,
    id: &str,
    archived: bool,
) -> Result<StatusDefinition, String> {
    let mut connection = conn()?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| format!("status definition tx: {err}"))?;
    let now = now_ms();
    let changed = tx
        .execute(
            "UPDATE pm_status_definitions
                SET archived_at = CASE WHEN ?3 THEN COALESCE(archived_at, ?4) ELSE NULL END,
                    updated_at = ?4
              WHERE org_id = ?1 AND id = ?2",
            params![org_id, id, archived, now],
        )
        .map_err(|err| format!("status definition store: {err}"))?;
    if changed == 0 {
        return Err(format!("Status definition '{id}' not found"));
    }
    crate::sync::collab_bridge::record_status_definitions_touch(&tx, org_id, id)?;
    let definition = read_definition(&tx, org_id, id)?;
    tx.commit()
        .map_err(|err| format!("status definition commit: {err}"))?;
    Ok(definition)
}

pub(crate) fn list_definitions(
    org_id: &str,
    include_archived: bool,
) -> Result<Vec<StatusDefinition>, String> {
    let connection = conn()?;
    list_definitions_in(&connection, org_id, include_archived)
}

pub(crate) fn list_definitions_in(
    connection: &Connection,
    org_id: &str,
    include_archived: bool,
) -> Result<Vec<StatusDefinition>, String> {
    let archived_predicate = if include_archived {
        ""
    } else {
        "AND archived_at IS NULL"
    };
    let sql = format!(
        "SELECT id, org_id, key, name, category, color, description,
                position, archived_at, created_at, updated_at
           FROM pm_status_definitions
          WHERE org_id = ?1 {archived_predicate}
          ORDER BY position ASC, created_at ASC, id ASC"
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|err| format!("status definition store: {err}"))?;
    let definitions = statement
        .query_map(params![org_id], decode_definition)
        .map_err(|err| format!("status definition store: {err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("status definition store: {err}"))?;
    Ok(definitions)
}

fn read_definition(
    connection: &Connection,
    org_id: &str,
    id: &str,
) -> Result<StatusDefinition, String> {
    connection
        .query_row(
            "SELECT id, org_id, key, name, category, color, description,
                    position, archived_at, created_at, updated_at
               FROM pm_status_definitions
              WHERE org_id = ?1 AND id = ?2",
            params![org_id, id],
            decode_definition,
        )
        .map_err(|err| format!("status definition store: {err}"))
}

fn decode_definition(row: &rusqlite::Row<'_>) -> rusqlite::Result<StatusDefinition> {
    Ok(StatusDefinition {
        id: row.get(0)?,
        org_id: row.get(1)?,
        key: row.get(2)?,
        name: row.get(3)?,
        category: row.get(4)?,
        color: row.get(5)?,
        description: row.get(6)?,
        position: row.get(7)?,
        archived_at: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

/// Custom-status key → category, for one org.
///
/// Archived definitions deliberately remain in this resolver. Existing work
/// items keep their raw status key after a definition is retired, so dropping
/// archived rows here would silently change their filtering, board column, and
/// terminal behavior. Selection surfaces filter archived definitions instead.
pub(crate) fn category_map_in(connection: &Connection, org_id: &str) -> HashMap<String, String> {
    let Ok(mut statement) = connection.prepare(
        "SELECT key, category FROM pm_status_definitions
          WHERE org_id = ?1",
    ) else {
        return HashMap::new();
    };
    statement
        .query_map(params![org_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
}

/// Resolve a raw stored status to the bucket the app should interpret:
/// custom keys fold into their category, everything else passes through.
pub(crate) fn effective_status_in(connection: &Connection, org_id: &str, raw: &str) -> String {
    connection
        .query_row(
            "SELECT category FROM pm_status_definitions
              WHERE org_id = ?1 AND key = ?2",
            params![org_id, raw],
            |row| row.get::<_, String>(0),
        )
        .unwrap_or_else(|_| raw.to_string())
}

/// Reject a newly assigned archived custom status while preserving existing
/// historical rows that already carry the same raw key. Built-in and unknown
/// legacy values keep their existing compatibility behavior.
pub(crate) fn ensure_status_assignable_in(
    connection: &Connection,
    org_id: &str,
    raw: &str,
    previous_raw: Option<&str>,
) -> Result<(), String> {
    if previous_raw == Some(raw) {
        return Ok(());
    }
    let archived_at = connection
        .query_row(
            "SELECT archived_at FROM pm_status_definitions
              WHERE org_id = ?1 AND key = ?2",
            params![org_id, raw],
            |row| row.get::<_, Option<i64>>(0),
        )
        .optional()
        .map_err(|err| format!("status definition store: {err}"))?;
    if archived_at.flatten().is_some() {
        return Err(format!("PM_ERR:STATUS_ARCHIVED:{raw}"));
    }
    Ok(())
}

/// Every definition (archived included) so remote archives propagate.
pub(crate) fn export_definitions(
    connection: &Connection,
    org_id: &str,
) -> Result<Vec<StatusDefinition>, String> {
    list_definitions_in(connection, org_id, true)
}

/// Apply org-wide status definitions carried on a pulled entity snapshot.
/// Last-writer-wins per definition on `updated_at`; a definition with a
/// pending local push is left alone so the local edit is not clobbered.
pub(crate) fn validate_wire_definitions(
    org_id: &str,
    payload: &serde_json::Value,
) -> Result<(), String> {
    let Some(raw) = payload.get("statusDefinitions") else {
        return Ok(());
    };
    let definitions: Vec<StatusDefinition> = serde_json::from_value(raw.clone())
        .map_err(|err| format!("status wire definitions: {err}"))?;
    for definition in definitions.iter().filter(|item| item.org_id == org_id) {
        validate_name(&definition.name)?;
        validate_key_and_category(&definition.key, &definition.category)?;
    }
    Ok(())
}

pub(crate) fn apply_wire_definitions(
    connection: &Connection,
    org_id: &str,
    payload: &serde_json::Value,
) -> Result<(), String> {
    validate_wire_definitions(org_id, payload)?;
    let Some(raw) = payload.get("statusDefinitions") else {
        return Ok(());
    };
    let definitions: Vec<StatusDefinition> = serde_json::from_value(raw.clone())
        .map_err(|err| format!("status wire definitions: {err}"))?;
    for definition in definitions {
        if definition.org_id != org_id {
            continue;
        }
        let name = validate_name(&definition.name)?;
        let key = validate_key_and_category(&definition.key, &definition.category)?;
        let local: Option<(String, String, String, i64)> = connection
            .query_row(
                "SELECT org_id, key, category, updated_at
                   FROM pm_status_definitions WHERE id = ?1",
                params![definition.id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
            .map_err(|err| format!("status definition watermark: {err}"))?;
        if local
            .as_ref()
            .is_some_and(|(stored_org, _, _, _)| stored_org != org_id)
        {
            continue;
        }
        let local_updated_at = local.as_ref().map(|(_, _, _, updated_at)| *updated_at);
        if local_updated_at.is_some_and(|local| local >= definition.updated_at) {
            continue;
        }
        if crate::sync::collab_bridge::has_pending_collab_field_path(
            connection,
            org_id,
            &format!("statusDefinitions.{}", definition.id),
            "status definition pending-path probe",
        )? {
            continue;
        }
        if let Some((_, stored_key, stored_category, _)) = &local {
            if stored_key != &key {
                return Err("PM_ERR:STATUS_KEY_IMMUTABLE".to_string());
            }
            if stored_category != &definition.category {
                return Err("PM_ERR:STATUS_CATEGORY_IMMUTABLE".to_string());
            }
        }
        connection
            .execute(
                "INSERT INTO pm_status_definitions (
                     id, org_id, key, name, category, color, description,
                     position, archived_at, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                 ON CONFLICT(id) DO UPDATE SET
                     name = excluded.name,
                     color = excluded.color,
                     description = excluded.description,
                     position = excluded.position,
                     archived_at = excluded.archived_at,
                     updated_at = excluded.updated_at
                 WHERE pm_status_definitions.org_id = excluded.org_id
                   AND excluded.updated_at >= pm_status_definitions.updated_at",
                params![
                    definition.id,
                    definition.org_id,
                    key,
                    name,
                    definition.category,
                    definition.color,
                    definition.description,
                    definition.position,
                    definition.archived_at,
                    definition.created_at,
                    definition.updated_at,
                ],
            )
            .map_err(|err| format!("status definition apply: {err}"))?;
    }
    Ok(())
}

/// Category map for a project view read: the explicit org when given,
/// otherwise the project row's org. Failures degrade to "no custom
/// statuses" rather than failing the view.
pub(crate) fn category_map_for_project(
    project_slug: &str,
    org_id: Option<&str>,
) -> HashMap<String, String> {
    let Ok(connection) = conn() else {
        return HashMap::new();
    };
    let resolved_org = org_id.map(str::to_string).or_else(|| {
        connection
            .query_row(
                "SELECT org_id FROM projects WHERE slug = ?1",
                params![project_slug],
                |row| row.get::<_, String>(0),
            )
            .ok()
    });
    match resolved_org {
        Some(org) => category_map_in(&connection, &org),
        None => HashMap::new(),
    }
}

pub const STATUS_CATALOG_BRIEF_CAP: usize = 30;

/// Active custom definition for `key` in `org_id`, if one exists.
pub fn find_active_status_definition(
    org_id: Option<&str>,
    key: &str,
) -> Result<Option<StatusDefinition>, String> {
    let connection = conn()?;
    find_active_status_definition_in(
        &connection,
        org_id.unwrap_or(crate::projects::types::PERSONAL_ORG_ID),
        key,
    )
}

pub(crate) fn find_active_status_definition_in(
    connection: &Connection,
    org_id: &str,
    key: &str,
) -> Result<Option<StatusDefinition>, String> {
    connection
        .query_row(
            "SELECT id, org_id, key, name, category, color, description,
                    position, archived_at, created_at, updated_at
               FROM pm_status_definitions
              WHERE org_id = ?1 AND key = ?2 AND archived_at IS NULL",
            params![org_id, key],
            decode_definition,
        )
        .optional()
        .map_err(|err| format!("status definition store: {err}"))
}

/// Agent-facing catalog of the org's active custom statuses, grouped by
/// category in canonical order. `None` when the org defines none so briefs
/// that embed it stay byte-identical for orgs on built-in statuses only.
pub fn render_status_catalog(org_id: Option<&str>) -> Option<String> {
    let connection = conn().ok()?;
    render_status_catalog_in(
        &connection,
        org_id.unwrap_or(crate::projects::types::PERSONAL_ORG_ID),
    )
}

pub(crate) fn render_status_catalog_in(connection: &Connection, org_id: &str) -> Option<String> {
    let definitions = list_definitions_in(connection, org_id, false).ok()?;
    if definitions.is_empty() {
        return None;
    }
    let total = definitions.len();
    let mut lines = vec![
        "Custom statuses defined by this organization (pass the key to `work transition --to <key>`; each behaves as its category):".to_string(),
    ];
    let mut shown = 0usize;
    for category in STATUS_CATEGORIES {
        let entries = definitions
            .iter()
            .filter(|definition| definition.category == category)
            .take(STATUS_CATALOG_BRIEF_CAP.saturating_sub(shown))
            .map(|definition| format!("`{}` ({})", definition.key, definition.name))
            .collect::<Vec<_>>();
        if entries.is_empty() {
            continue;
        }
        shown += entries.len();
        lines.push(format!("- {category}: {}", entries.join(", ")));
        if shown >= STATUS_CATALOG_BRIEF_CAP {
            break;
        }
    }
    if total > shown {
        lines.push(format!("- … and {} more", total - shown));
    }
    Some(lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status_connection() -> Connection {
        let connection = Connection::open_in_memory().expect("in-memory status db");
        connection
            .execute_batch(
                "CREATE TABLE pm_status_definitions (
                     id TEXT PRIMARY KEY,
                     org_id TEXT NOT NULL,
                     key TEXT NOT NULL,
                     name TEXT NOT NULL,
                     category TEXT NOT NULL,
                     color TEXT,
                     description TEXT,
                     position INTEGER NOT NULL,
                     archived_at INTEGER,
                     created_at INTEGER NOT NULL,
                     updated_at INTEGER NOT NULL
                 );",
            )
            .expect("status schema");
        connection
    }

    fn insert_definition(
        connection: &Connection,
        key: &str,
        name: &str,
        category: &str,
        position: i64,
        archived_at: Option<i64>,
    ) {
        connection
            .execute(
                "INSERT INTO pm_status_definitions (
                     id, org_id, key, name, category, position,
                     archived_at, created_at, updated_at
                 ) VALUES (?1, 'org-1', ?2, ?3, ?4, ?5, ?6, 1, 1)",
                params![
                    format!("wis_{key}"),
                    key,
                    name,
                    category,
                    position,
                    archived_at
                ],
            )
            .expect("insert definition");
    }

    #[test]
    fn status_catalog_is_absent_without_custom_definitions() {
        let connection = status_connection();
        assert_eq!(render_status_catalog_in(&connection, "org-1"), None);
        insert_definition(&connection, "old", "Old", "completed", 0, Some(5));
        assert_eq!(render_status_catalog_in(&connection, "org-1"), None);
    }

    #[test]
    fn status_catalog_groups_active_keys_by_category_in_canonical_order() {
        let connection = status_connection();
        insert_definition(&connection, "shipped", "Shipped", "completed", 0, None);
        insert_definition(&connection, "qa", "QA", "in_progress", 1, None);
        insert_definition(&connection, "staging", "Staging", "in_progress", 2, None);
        insert_definition(&connection, "retired", "Retired", "cancelled", 3, Some(9));

        let catalog = render_status_catalog_in(&connection, "org-1").expect("catalog");
        let lines = catalog.lines().collect::<Vec<_>>();
        assert!(lines[0].contains("work transition --to <key>"));
        assert_eq!(lines[1], "- in_progress: `qa` (QA), `staging` (Staging)");
        assert_eq!(lines[2], "- completed: `shipped` (Shipped)");
        assert_eq!(lines.len(), 3);
        assert!(!catalog.contains("retired"));
        assert_eq!(render_status_catalog_in(&connection, "org-2"), None);
    }

    #[test]
    fn status_catalog_caps_the_listing_and_counts_the_rest() {
        let connection = status_connection();
        for index in 0..(STATUS_CATALOG_BRIEF_CAP + 4) {
            insert_definition(
                &connection,
                &format!("k{index}"),
                &format!("K{index}"),
                "planned",
                index as i64,
                None,
            );
        }
        let catalog = render_status_catalog_in(&connection, "org-1").expect("catalog");
        assert_eq!(catalog.matches("`k").count(), STATUS_CATALOG_BRIEF_CAP);
        assert!(catalog.ends_with("- … and 4 more"));
    }

    #[test]
    fn active_definition_lookup_ignores_archived_rows() {
        let connection = status_connection();
        insert_definition(&connection, "qa", "QA", "in_progress", 0, None);
        insert_definition(&connection, "old", "Old", "completed", 1, Some(5));
        let qa = find_active_status_definition_in(&connection, "org-1", "qa")
            .expect("lookup")
            .expect("active");
        assert_eq!(qa.category, "in_progress");
        assert!(
            find_active_status_definition_in(&connection, "org-1", "old")
                .expect("lookup")
                .is_none()
        );
        assert!(find_active_status_definition_in(&connection, "org-2", "qa")
            .expect("lookup")
            .is_none());
    }

    #[test]
    fn blocked_is_a_reserved_canonical_category() {
        assert!(STATUS_CATEGORIES.contains(&"blocked"));
        assert!(RESERVED_STATUS_KEYS.contains(&"blocked"));
    }

    #[test]
    fn archived_definitions_still_resolve_historical_statuses() {
        let connection = status_connection();
        connection
            .execute(
                "INSERT INTO pm_status_definitions (
                     id, org_id, key, name, category, position,
                     archived_at, created_at, updated_at
                 ) VALUES ('wis_waiting', 'org-1', 'waiting', 'Waiting',
                           'blocked', 0, 42, 1, 42)",
                [],
            )
            .expect("archived definition");

        assert_eq!(
            effective_status_in(&connection, "org-1", "waiting"),
            "blocked"
        );
        assert_eq!(
            category_map_in(&connection, "org-1").get("waiting"),
            Some(&"blocked".to_string())
        );
    }
}

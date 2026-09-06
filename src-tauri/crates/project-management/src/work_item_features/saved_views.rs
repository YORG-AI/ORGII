//! Org-shared saved views over the Work Items surface.
//!
//! A saved view's `query` (filters) is its shared identity; `display`
//! (view tab, grouping) only seeds the first open on another machine.
//! Views ride the same org-entity carrier as typed-property and status
//! definitions, so teammates receive them without a dedicated sync kind.
//! Deletion is archival so removals propagate through snapshots.

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use crate::projects::io::helpers::{conn, now_ms};

const ORG_SCOPE_MISMATCH: &str = "PM_ERR:ORG_SCOPE_MISMATCH";

fn org_scope_mismatch(entity: &str, id: &str) -> String {
    format!("{ORG_SCOPE_MISMATCH}:{entity}:{id}")
}

fn validate_name(name: &str) -> Result<String, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Saved view name is required".to_string());
    }
    Ok(name)
}

fn project_belongs_to_org(
    connection: &Connection,
    org_id: &str,
    project_slug: Option<&str>,
) -> Result<bool, String> {
    let Some(project_slug) = project_slug else {
        return Ok(true);
    };
    connection
        .query_row(
            "SELECT 1 FROM projects WHERE slug = ?1 AND org_id = ?2 LIMIT 1",
            params![project_slug, org_id],
            |_| Ok(true),
        )
        .optional()
        .map(|found| found.unwrap_or(false))
        .map_err(|err| format!("saved view project ownership: {err}"))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedView {
    pub id: String,
    pub org_id: String,
    pub project_slug: Option<String>,
    pub name: String,
    pub query: serde_json::Value,
    pub display: serde_json::Value,
    pub position: i64,
    pub created_by: Option<String>,
    pub archived_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertSavedViewRequest {
    pub id: Option<String>,
    pub org_id: String,
    pub project_slug: Option<String>,
    pub name: String,
    #[serde(default)]
    pub query: serde_json::Value,
    #[serde(default)]
    pub display: serde_json::Value,
    pub position: Option<i64>,
    pub created_by: Option<String>,
}

pub(crate) fn upsert_view(request: UpsertSavedViewRequest) -> Result<SavedView, String> {
    let name = validate_name(&request.name)?;
    let mut connection = conn()?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| format!("saved view tx: {err}"))?;
    let now = now_ms();
    let id = request
        .id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("wiv_{}", uuid::Uuid::new_v4().simple()));
    let existing_org: Option<String> = tx
        .query_row(
            "SELECT org_id FROM pm_saved_views WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| format!("saved view store: {err}"))?;
    if existing_org
        .as_deref()
        .is_some_and(|stored_org| stored_org != request.org_id)
    {
        return Err(org_scope_mismatch("saved_view", &id));
    }
    if !project_belongs_to_org(&tx, &request.org_id, request.project_slug.as_deref())? {
        return Err(org_scope_mismatch(
            "saved_view_project",
            request.project_slug.as_deref().unwrap_or_default(),
        ));
    }
    let query =
        serde_json::to_string(&request.query).map_err(|err| format!("saved view query: {err}"))?;
    let display = serde_json::to_string(&request.display)
        .map_err(|err| format!("saved view display: {err}"))?;
    tx.execute(
        "INSERT INTO pm_saved_views (
                 id, org_id, project_slug, name, query_json, display_json,
                 position, created_by, archived_at, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?9, ?9)
             ON CONFLICT(id) DO UPDATE SET
                 name = excluded.name,
                 query_json = excluded.query_json,
                 display_json = excluded.display_json,
                 position = excluded.position,
                 archived_at = NULL,
                 updated_at = excluded.updated_at
             WHERE pm_saved_views.org_id = excluded.org_id",
        params![
            id,
            request.org_id,
            request.project_slug,
            name,
            query,
            display,
            request.position.unwrap_or(0),
            request.created_by,
            now
        ],
    )
    .map_err(|err| format!("saved view store: {err}"))?;
    crate::sync::collab_bridge::record_saved_views_touch(&tx, &request.org_id, &id)?;
    let view = read_view(&tx, &request.org_id, &id)?;
    tx.commit()
        .map_err(|err| format!("saved view commit: {err}"))?;
    Ok(view)
}

pub(crate) fn archive_view(org_id: &str, id: &str) -> Result<SavedView, String> {
    let mut connection = conn()?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| format!("saved view tx: {err}"))?;
    let now = now_ms();
    let changed = tx
        .execute(
            "UPDATE pm_saved_views
                SET archived_at = COALESCE(archived_at, ?3), updated_at = ?3
              WHERE org_id = ?1 AND id = ?2",
            params![org_id, id, now],
        )
        .map_err(|err| format!("saved view store: {err}"))?;
    if changed == 0 {
        return Err(format!("Saved view '{id}' not found"));
    }
    crate::sync::collab_bridge::record_saved_views_touch(&tx, org_id, id)?;
    let view = read_view(&tx, org_id, id)?;
    tx.commit()
        .map_err(|err| format!("saved view commit: {err}"))?;
    Ok(view)
}

pub(crate) fn list_views(
    org_id: &str,
    project_slug: Option<&str>,
) -> Result<Vec<SavedView>, String> {
    let connection = conn()?;
    let mut statement = connection
        .prepare(
            "SELECT id, org_id, project_slug, name, query_json, display_json,
                    position, created_by, archived_at, created_at, updated_at
               FROM pm_saved_views
              WHERE org_id = ?1
                AND archived_at IS NULL
                AND (project_slug IS NULL OR project_slug = ?2)
              ORDER BY position ASC, created_at ASC, id ASC",
        )
        .map_err(|err| format!("saved view store: {err}"))?;
    let views = statement
        .query_map(params![org_id, project_slug], decode_view)
        .map_err(|err| format!("saved view store: {err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("saved view store: {err}"))?;
    Ok(views)
}

fn read_view(connection: &Connection, org_id: &str, id: &str) -> Result<SavedView, String> {
    connection
        .query_row(
            "SELECT id, org_id, project_slug, name, query_json, display_json,
                    position, created_by, archived_at, created_at, updated_at
               FROM pm_saved_views
              WHERE org_id = ?1 AND id = ?2",
            params![org_id, id],
            decode_view,
        )
        .map_err(|err| format!("saved view store: {err}"))
}

fn decode_view(row: &rusqlite::Row<'_>) -> rusqlite::Result<SavedView> {
    let query_raw: String = row.get(4)?;
    let display_raw: String = row.get(5)?;
    Ok(SavedView {
        id: row.get(0)?,
        org_id: row.get(1)?,
        project_slug: row.get(2)?,
        name: row.get(3)?,
        query: serde_json::from_str(&query_raw).unwrap_or(serde_json::Value::Null),
        display: serde_json::from_str(&display_raw).unwrap_or(serde_json::Value::Null),
        position: row.get(6)?,
        created_by: row.get(7)?,
        archived_at: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

/// Every view (archived included) so removals propagate.
pub(crate) fn export_views(
    connection: &Connection,
    org_id: &str,
) -> Result<Vec<SavedView>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, org_id, project_slug, name, query_json, display_json,
                    position, created_by, archived_at, created_at, updated_at
               FROM pm_saved_views
              WHERE org_id = ?1
              ORDER BY position ASC, created_at ASC, id ASC",
        )
        .map_err(|err| format!("saved view export: {err}"))?;
    let views = statement
        .query_map(params![org_id], decode_view)
        .map_err(|err| format!("saved view export: {err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("saved view export: {err}"))?;
    Ok(views)
}

/// Apply org-wide saved views carried on a pulled entity snapshot.
pub(crate) fn validate_wire_views(org_id: &str, payload: &serde_json::Value) -> Result<(), String> {
    let Some(raw) = payload.get("savedViews") else {
        return Ok(());
    };
    let views: Vec<SavedView> =
        serde_json::from_value(raw.clone()).map_err(|err| format!("saved view wire: {err}"))?;
    for view in views.iter().filter(|item| item.org_id == org_id) {
        validate_name(&view.name)?;
    }
    Ok(())
}

pub(crate) fn apply_wire_views(
    connection: &Connection,
    org_id: &str,
    payload: &serde_json::Value,
) -> Result<(), String> {
    validate_wire_views(org_id, payload)?;
    let Some(raw) = payload.get("savedViews") else {
        return Ok(());
    };
    let views: Vec<SavedView> =
        serde_json::from_value(raw.clone()).map_err(|err| format!("saved view wire: {err}"))?;
    for view in views {
        if view.org_id != org_id {
            continue;
        }
        let name = validate_name(&view.name)?;
        let local: Option<(String, i64)> = connection
            .query_row(
                "SELECT org_id, updated_at FROM pm_saved_views WHERE id = ?1",
                params![view.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|err| format!("saved view watermark: {err}"))?;
        if local
            .as_ref()
            .is_some_and(|(stored_org, _)| stored_org != org_id)
        {
            continue;
        }
        if !project_belongs_to_org(connection, org_id, view.project_slug.as_deref())? {
            return Err(org_scope_mismatch(
                "saved_view_project",
                view.project_slug.as_deref().unwrap_or_default(),
            ));
        }
        let local_updated_at = local.map(|(_, updated_at)| updated_at);
        if local_updated_at.is_some_and(|local| local >= view.updated_at) {
            continue;
        }
        if crate::sync::collab_bridge::has_pending_collab_field_path(
            connection,
            org_id,
            &format!("savedViews.{}", view.id),
            "saved view pending-path probe",
        )? {
            continue;
        }
        let query = serde_json::to_string(&view.query)
            .map_err(|err| format!("saved view wire query: {err}"))?;
        let display = serde_json::to_string(&view.display)
            .map_err(|err| format!("saved view wire display: {err}"))?;
        connection
            .execute(
                "INSERT INTO pm_saved_views (
                     id, org_id, project_slug, name, query_json, display_json,
                     position, created_by, archived_at, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                 ON CONFLICT(id) DO UPDATE SET
                     name = excluded.name,
                     query_json = excluded.query_json,
                     display_json = excluded.display_json,
                     position = excluded.position,
                     archived_at = excluded.archived_at,
                     updated_at = excluded.updated_at
                 WHERE pm_saved_views.org_id = excluded.org_id
                   AND excluded.updated_at >= pm_saved_views.updated_at",
                params![
                    view.id,
                    view.org_id,
                    view.project_slug,
                    name,
                    query,
                    display,
                    view.position,
                    view.created_by,
                    view.archived_at,
                    view.created_at,
                    view.updated_at,
                ],
            )
            .map_err(|err| format!("saved view apply: {err}"))?;
    }
    Ok(())
}

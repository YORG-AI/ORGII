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

use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::adapter::{EntityField, FieldMap, FieldMapping};
use super::conflict;
use super::io;
use super::types::{EntityType, OutboxOp, OutboxStatus};
use crate::projects::io::{
    apply_remote_merge, create_project_org, read_project_field_revisions, read_project_org,
    read_project_scoped, read_sync_metadata, read_work_item_by_row_id,
    update_work_item_partial_with_revisions, write_project_remote, write_work_item_remote,
    FieldRevision, PROJECT_SYNC_FIELDS,
};
use crate::projects::types::work_items::{default_priority, default_status};
use crate::projects::types::{
    CommentEntry, CreateProjectOrgRequest, LinkedSession, ProjectMeta, TodoEntry,
    WorkItemFrontmatter, WorkItemPartialUpdate, WorkItemWorkProduct,
};

/// `project_orgs.sync_provider` value marking a collab-aliased org.
pub const COLLAB_SYNC_PROVIDER: &str = "orgii_collab";
/// `project_orgs.source` value for collab-aliased orgs (design §16.2).
pub const COLLAB_ORG_SOURCE: &str = "collab";
/// `FieldRevision.source` stamped on remote-adopted fields.
const COLLAB_REVISION_SOURCE: &str = "orgii_collab";

/// In-flight rows older than this are considered orphaned by a dead TS
/// session and are demoted back to pending at the next drain.
const STALE_IN_FLIGHT_MS: i64 = 5 * 60 * 1000;

pub const KIND_PROJECT: &str = "project";
pub const KIND_WORK_ITEM: &str = "work_item";
pub const OP_UPSERT: &str = "upsert";
pub const OP_DELETE: &str = "delete";

/// Wire field map for the resolver: local names ARE the remote names
/// because [`work_item_fields_from_wire`] normalizes the camelCase wire
/// keys to local field names before resolution.
static COLLAB_FIELD_MAP: FieldMap = FieldMap {
    mappings: &[
        FieldMapping {
            local: EntityField::Title,
            remote: "title",
            writable: true,
        },
        FieldMapping {
            local: EntityField::Body,
            remote: "body",
            writable: true,
        },
        FieldMapping {
            local: EntityField::Status,
            remote: "status",
            writable: true,
        },
        FieldMapping {
            local: EntityField::Priority,
            remote: "priority",
            writable: true,
        },
        FieldMapping {
            local: EntityField::Assignee,
            remote: "assignee",
            writable: true,
        },
        FieldMapping {
            local: EntityField::Milestone,
            remote: "milestone",
            writable: true,
        },
        FieldMapping {
            local: EntityField::StartDate,
            remote: "start_date",
            writable: true,
        },
        FieldMapping {
            local: EntityField::TargetDate,
            remote: "target_date",
            writable: true,
        },
        FieldMapping {
            local: EntityField::Labels,
            remote: "labels",
            writable: true,
        },
    ],
};

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

/// Mirror of `projects::io::helpers::to_iso8601` (private there).
fn to_iso8601(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .unwrap_or_else(|| chrono::DateTime::from_timestamp_millis(0).expect("epoch"))
        .format("%Y-%m-%dT%H:%M:%SZ")
        .to_string()
}

fn iso_to_ms(value: Option<&str>) -> Option<i64> {
    let raw = value?.trim();
    if raw.is_empty() {
        return None;
    }
    chrono::DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|parsed| parsed.timestamp_millis())
}

fn string_field(payload: &Value, key: &str) -> Option<String> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|value| !value.is_empty())
}

// ============================================================================
// Gates
// ============================================================================

/// True when the org row exists and is collab-synced.
pub fn is_collab_org(conn: &Connection, org_id: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT 1 FROM project_orgs WHERE id = ?1 AND sync_provider = ?2",
        params![org_id, COLLAB_SYNC_PROVIDER],
        |_| Ok(true),
    )
    .optional()
    .map(|found| found.unwrap_or(false))
    .map_err(|err| format!("DB error (collab org gate): {}", err))
}

/// The collab org id owning `project_slug`, when the project's org is
/// collab-synced; `None` otherwise (including unknown slugs).
pub fn collab_org_for_project(
    conn: &Connection,
    project_slug: &str,
) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT o.id FROM projects p
           JOIN project_orgs o ON o.id = p.org_id
          WHERE p.slug = ?1 AND o.sync_provider = ?2",
        params![project_slug, COLLAB_SYNC_PROVIDER],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|err| format!("DB error (collab org for project): {}", err))
}

// ============================================================================
// Enqueue (local mutation → bridge outbox row)
// ============================================================================

/// Append one bridge row, skipping exact duplicates that are still
/// pending (typing bursts would otherwise pile up rows the drain
/// coalesces anyway).
fn append_collab_row(
    conn: &Connection,
    org_id: &str,
    project_slug: &str,
    entity_type: EntityType,
    entity_id: &str,
    op: OutboxOp,
    field_path: Option<&str>,
) -> Result<(), String> {
    let duplicate: Option<i64> = conn
        .query_row(
            "SELECT id FROM outbox_entries
              WHERE org_id = ?1 AND entity_type = ?2 AND entity_id = ?3
                AND op = ?4 AND status = ?5
                AND coalesce(field_path, '') = coalesce(?6, '')
              LIMIT 1",
            params![
                org_id,
                entity_type.as_db_str(),
                entity_id,
                op.as_db_str(),
                OutboxStatus::Pending.as_db_str(),
                field_path,
            ],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| format!("DB error (collab dedupe probe): {}", err))?;
    if duplicate.is_some() {
        return Ok(());
    }
    conn.execute(
        "INSERT INTO outbox_entries
            (project_slug, entity_type, entity_id, op, field_path,
             payload_json, created_at, retry_count, status, org_id)
         VALUES (?1, ?2, ?3, ?4, ?5, '{}', ?6, 0, ?7, ?8)",
        params![
            project_slug,
            entity_type.as_db_str(),
            entity_id,
            op.as_db_str(),
            field_path,
            now_ms(),
            OutboxStatus::Pending.as_db_str(),
            org_id,
        ],
    )
    .map_err(|err| format!("DB error (insert collab outbox): {}", err))?;
    crate::projects::events::notify_data_changed();
    Ok(())
}

/// Hook for the atomic work-item update path (called from
/// [`crate::sync::io::record_local_update`] when the project has no
/// adapter binding). No-op unless the project's org is collab-synced.
pub fn record_project_work_item_update(
    conn: &Connection,
    project_slug: &str,
    short_id: &str,
    changed_fields: &[&'static str],
) -> Result<(), String> {
    let Some(org_id) = collab_org_for_project(conn, project_slug)? else {
        return Ok(());
    };
    let work_item_id: Option<String> = conn
        .query_row(
            "SELECT w.id FROM workitems w
               JOIN projects p ON p.id = w.project_id
              WHERE p.slug = ?1 AND w.short_id = ?2",
            params![project_slug, short_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| format!("DB error (collab work item lookup): {}", err))?;
    let Some(work_item_id) = work_item_id else {
        return Ok(());
    };
    append_collab_row(
        conn,
        &org_id,
        project_slug,
        EntityType::WorkItem,
        &work_item_id,
        OutboxOp::Update,
        Some(&changed_fields.join(",")),
    )
}

/// Hook for full work-item writes (create / delete / restore / full
/// update). `deleted` selects the outbox op; the drain re-derives the
/// effective op from current row state anyway.
pub fn record_work_item_write(
    org_id: &str,
    project_slug: Option<&str>,
    work_item_id: &str,
    deleted: bool,
) -> Result<(), String> {
    let conn = io::conn()?;
    if !is_collab_org(&conn, org_id)? {
        return Ok(());
    }
    append_collab_row(
        &conn,
        org_id,
        project_slug.unwrap_or(""),
        EntityType::WorkItem,
        work_item_id,
        if deleted {
            OutboxOp::Delete
        } else {
            OutboxOp::Update
        },
        None,
    )
}

/// Hook for work-item partial updates that only touched payload-tail
/// fields (todos / comments / linked sessions / orchestrator state …)
/// — those are not sync-tracked fields, so the diff-based
/// `record_local_update` path never fires for them.
pub fn record_work_item_payload_touch(project_slug: &str, short_id: &str) -> Result<(), String> {
    let conn = io::conn()?;
    record_project_work_item_update(&conn, project_slug, short_id, &["payload"])
}

/// Hook for project writes (create / update / delete).
pub fn record_project_write(
    org_id: &str,
    project_id: &str,
    project_slug: &str,
    op: OutboxOp,
) -> Result<(), String> {
    let conn = io::conn()?;
    if !is_collab_org(&conn, org_id)? {
        return Ok(());
    }
    append_collab_row(
        &conn,
        org_id,
        project_slug,
        EntityType::Project,
        project_id,
        op,
        None,
    )
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CollabPendingEntity {
    pub kind: String,
    pub entity_id: String,
}

pub fn outbox_pending_ids(org_id: &str) -> Result<Vec<CollabPendingEntity>, String> {
    let conn = io::conn()?;
    if !is_collab_org(&conn, org_id)? {
        return Ok(Vec::new());
    }
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT entity_type, entity_id FROM outbox_entries
              WHERE org_id = ?1 AND status IN (?2, ?3)",
        )
        .map_err(|err| format!("DB error (prepare pending ids): {}", err))?;
    let rows = stmt
        .query_map(
            params![
                org_id,
                OutboxStatus::Pending.as_db_str(),
                OutboxStatus::InFlight.as_db_str(),
            ],
            |row| {
                Ok(CollabPendingEntity {
                    kind: row.get(0)?,
                    entity_id: row.get(1)?,
                })
            },
        )
        .map_err(|err| format!("DB error (query pending ids): {}", err))?;
    let mut entities = Vec::new();
    for entry in rows {
        entities.push(entry.map_err(|err| format!("DB error (collect pending ids): {}", err))?);
    }
    Ok(entities)
}

// ============================================================================
// Drain
// ============================================================================

/// One coalesced push unit handed to the TS ProjectSyncChannel.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollabPushItem {
    /// Every outbox row folded into this push; ack echoes them back.
    pub entry_ids: Vec<i64>,
    pub org_id: String,
    /// `"project"` | `"work_item"`.
    pub kind: String,
    /// `projects.id` / `workitems.id` — also the server row id.
    pub entity_id: String,
    /// `"upsert"` | `"delete"`, derived from CURRENT local state.
    pub op: String,
    /// Full wire snapshot for upserts; `None` for deletes.
    pub payload: Option<Value>,
    /// Last acknowledged server version (OCC base). `None` = never
    /// synced → the push creates the server row.
    pub base_version: Option<i64>,
    /// Union of the folded rows' field paths (observability + merge).
    pub field_paths: Vec<String>,
}

/// Claim up to `max` pending bridge rows for `org_id` (oldest first),
/// coalesced per entity and hydrated from current local state. Claimed
/// rows go `in_flight`; a dead TS session's claims are recovered here
/// after [`STALE_IN_FLIGHT_MS`] (and at process boot by the worker's
/// `reset_in_flight_to_pending`).
pub fn drain_outbox(org_id: &str, max: u32) -> Result<Vec<CollabPushItem>, String> {
    let conn = io::conn()?;
    if !is_collab_org(&conn, org_id)? {
        return Ok(Vec::new());
    }
    let now = now_ms();

    conn.execute(
        "UPDATE outbox_entries
            SET status = ?1, last_attempted_at = NULL
          WHERE org_id = ?2 AND status = ?3
            AND (last_attempted_at IS NULL OR last_attempted_at <= ?4)",
        params![
            OutboxStatus::Pending.as_db_str(),
            org_id,
            OutboxStatus::InFlight.as_db_str(),
            now - STALE_IN_FLIGHT_MS,
        ],
    )
    .map_err(|err| format!("DB error (recover stale in-flight): {}", err))?;

    let mut stmt = conn
        .prepare(
            "SELECT id, entity_type, entity_id, field_path FROM outbox_entries
              WHERE org_id = ?1 AND status = ?2
                AND (last_attempted_at IS NULL OR last_attempted_at <= ?3)
              ORDER BY created_at ASC, id ASC
              LIMIT ?4",
        )
        .map_err(|err| format!("DB error (prepare drain): {}", err))?;
    let rows = stmt
        .query_map(
            params![org_id, OutboxStatus::Pending.as_db_str(), now, max as i64],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .map_err(|err| format!("DB error (query drain): {}", err))?;

    // Coalesce per (entity_type, entity_id), preserving first-seen order.
    let mut order: Vec<(String, String)> = Vec::new();
    let mut groups: HashMap<(String, String), (Vec<i64>, Vec<String>)> = HashMap::new();
    for entry in rows {
        let (id, entity_type, entity_id, field_path) =
            entry.map_err(|err| format!("DB error (collect drain): {}", err))?;
        let key = (entity_type, entity_id);
        let slot = groups.entry(key.clone()).or_insert_with(|| {
            order.push(key.clone());
            (Vec::new(), Vec::new())
        });
        slot.0.push(id);
        if let Some(paths) = field_path {
            for path in paths.split(',').filter(|path| !path.is_empty()) {
                if !slot.1.iter().any(|existing| existing == path) {
                    slot.1.push(path.to_string());
                }
            }
        }
    }
    drop(stmt);

    // Claim everything we're about to hand out.
    for (ids, _) in groups.values() {
        for id in ids {
            conn.execute(
                "UPDATE outbox_entries SET status = ?1, last_attempted_at = ?2
                  WHERE id = ?3 AND status = ?4",
                params![
                    OutboxStatus::InFlight.as_db_str(),
                    now,
                    id,
                    OutboxStatus::Pending.as_db_str(),
                ],
            )
            .map_err(|err| format!("DB error (claim drain row): {}", err))?;
        }
    }

    let mut items = Vec::with_capacity(order.len());
    for key in order {
        let (entry_ids, field_paths) = groups.remove(&key).unwrap_or_default();
        let (entity_type, entity_id) = key;
        let item = match entity_type.as_str() {
            "project" => hydrate_project(&conn, org_id, &entity_id, entry_ids, field_paths)?,
            "work_item" => hydrate_work_item(&conn, org_id, &entity_id, entry_ids, field_paths)?,
            other => {
                let message = format!("unsupported collab entity_type: {other}");
                tracing::warn!(
                    "[collab_bridge] abandoning outbox rows with unsupported entity_type '{}'",
                    other
                );
                for id in entry_ids {
                    io::mark_failed_with_backoff(&conn, id, now, &message, true)?;
                }
                continue;
            }
        };
        items.push(item);
    }
    Ok(items)
}

fn hydrate_project(
    conn: &Connection,
    org_id: &str,
    project_id: &str,
    entry_ids: Vec<i64>,
    field_paths: Vec<String>,
) -> Result<CollabPushItem, String> {
    let row = conn
        .query_row(
            "SELECT slug, name, status, priority, health, lead, description,
                    short_id_prefix, start_date, target_date, created_at, updated_at,
                    collab_remote_version
               FROM projects WHERE id = ?1 AND org_id = ?2",
            params![project_id, org_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, Option<String>>(9)?,
                    row.get::<_, i64>(10)?,
                    row.get::<_, i64>(11)?,
                    row.get::<_, Option<i64>>(12)?,
                ))
            },
        )
        .optional()
        .map_err(|err| format!("DB error (hydrate project): {}", err))?;

    let Some((
        slug,
        name,
        status,
        priority,
        health,
        lead,
        description,
        prefix,
        start_date,
        target_date,
        created_at,
        updated_at,
        base_version,
    )) = row
    else {
        // Row gone (hard delete) → propagate a tombstone.
        return Ok(CollabPushItem {
            entry_ids,
            org_id: org_id.to_string(),
            kind: KIND_PROJECT.to_string(),
            entity_id: project_id.to_string(),
            op: OP_DELETE.to_string(),
            payload: None,
            base_version: read_project_remote_version(conn, project_id)?,
            field_paths,
        });
    };

    // { localFieldName: mtimeMs } — same wire contract as work items
    // (see work_item_wire): the puller compares each field against its
    // own remote mtime and keeps local for any field absent here.
    let field_mtimes: serde_json::Map<String, Value> = read_project_field_revisions(project_id)?
        .iter()
        .map(|(name, rev)| (name.clone(), json!(rev.mtime)))
        .collect();
    let payload = json!({
        "_fieldRevisions": field_mtimes,
        "id": project_id,
        "slug": slug,
        "name": name,
        "status": status,
        "priority": priority,
        "health": health,
        "leadMemberId": lead,
        "description": description.unwrap_or_default(),
        "startDate": start_date,
        "targetDate": target_date,
        "workItemPrefix": prefix,
        "createdAt": to_iso8601(created_at),
        "updatedAt": to_iso8601(updated_at),
    });

    Ok(CollabPushItem {
        entry_ids,
        org_id: org_id.to_string(),
        kind: KIND_PROJECT.to_string(),
        entity_id: project_id.to_string(),
        op: OP_UPSERT.to_string(),
        payload: Some(payload),
        base_version,
        field_paths,
    })
}

fn read_project_remote_version(conn: &Connection, project_id: &str) -> Result<Option<i64>, String> {
    conn.query_row(
        "SELECT collab_remote_version FROM projects WHERE id = ?1",
        params![project_id],
        |row| row.get::<_, Option<i64>>(0),
    )
    .optional()
    .map(|value| value.flatten())
    .map_err(|err| format!("DB error (project remote version): {}", err))
}

fn hydrate_work_item(
    conn: &Connection,
    org_id: &str,
    work_item_id: &str,
    entry_ids: Vec<i64>,
    field_paths: Vec<String>,
) -> Result<CollabPushItem, String> {
    let base_version: Option<i64> = conn
        .query_row(
            "SELECT collab_remote_version FROM workitems WHERE id = ?1 AND org_id = ?2",
            params![work_item_id, org_id],
            |row| row.get::<_, Option<i64>>(0),
        )
        .optional()
        .map_err(|err| format!("DB error (work item remote version): {}", err))?
        .flatten();

    let data = read_work_item_by_row_id(org_id, work_item_id)?;
    let (op, payload) = match data {
        None => (OP_DELETE.to_string(), None),
        Some(data) if data.frontmatter.deleted_at.is_some() => (OP_DELETE.to_string(), None),
        Some(data) => {
            // Per-field revision times ride the wire so the puller can merge
            // per field instead of against our whole-row updatedAt (which
            // would revert a teammate's edit to any field we didn't change).
            // Only project-scoped items carry them; standalone items use
            // whole-row semantics on both ends.
            let project_slug: Option<String> = conn
                .query_row(
                    "SELECT p.slug FROM workitems w
                       JOIN projects p ON w.project_id = p.id
                      WHERE w.id = ?1 AND w.org_id = ?2",
                    params![work_item_id, org_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|err| format!("DB error (work item slug): {}", err))?;
            let field_revisions = match &project_slug {
                Some(slug) => read_sync_metadata(slug, &data.frontmatter.short_id)?
                    .map(|m| m.field_revisions)
                    .unwrap_or_default(),
                None => Default::default(),
            };
            (
                OP_UPSERT.to_string(),
                Some(work_item_wire(
                    &data.frontmatter,
                    &data.body,
                    &field_revisions,
                )),
            )
        }
    };

    Ok(CollabPushItem {
        entry_ids,
        org_id: org_id.to_string(),
        kind: KIND_WORK_ITEM.to_string(),
        entity_id: work_item_id.to_string(),
        op,
        payload,
        base_version,
        field_paths,
    })
}

/// Full wire projection of a work item. Hot-field keys match the
/// server's `orgii_upsert_work_item` column extraction exactly; the
/// long tail rides in the same object and round-trips through
/// [`apply_work_item`]'s typed deserialization.
fn work_item_wire(
    frontmatter: &WorkItemFrontmatter,
    body: &str,
    field_revisions: &std::collections::HashMap<String, crate::projects::io::FieldRevision>,
) -> Value {
    fn to_value<T: Serialize>(value: &T) -> Value {
        serde_json::to_value(value).unwrap_or(Value::Null)
    }
    // { localFieldName: mtimeMs } — the puller compares each field against its
    // own remote mtime and keeps local for any field absent here.
    let field_mtimes: serde_json::Map<String, Value> = field_revisions
        .iter()
        .map(|(name, rev)| (name.clone(), json!(rev.mtime)))
        .collect();
    json!({
        "_fieldRevisions": field_mtimes,
        "id": frontmatter.id,
        "projectId": frontmatter.project,
        "shortId": frontmatter.short_id,
        "title": frontmatter.title,
        "body": body,
        "status": frontmatter.status,
        "priority": frontmatter.priority,
        "assigneeMemberId": frontmatter.assignee,
        "assigneeType": frontmatter.assignee_type,
        "milestone": frontmatter.milestone,
        "parentId": frontmatter.parent,
        "startDate": frontmatter.start_date,
        "targetDate": frontmatter.target_date,
        "labels": frontmatter.labels,
        "starred": frontmatter.starred,
        "createdBy": frontmatter.created_by,
        "createdAt": frontmatter.created_at,
        "updatedAt": frontmatter.updated_at,
        "todos": to_value(&frontmatter.todos),
        "comments": to_value(&frontmatter.comments),
        "history": to_value(&frontmatter.history),
        "linkedSessions": to_value(&frontmatter.linked_sessions),
        "proofOfWork": to_value(&frontmatter.proof_of_work),
        "orchestratorConfig": to_value(&frontmatter.orchestrator_config),
        "orchestratorState": to_value(&frontmatter.orchestrator_state),
        "schedule": to_value(&frontmatter.schedule),
        "executionLock": to_value(&frontmatter.execution_lock),
        "closeOut": to_value(&frontmatter.close_out),
        "workProducts": to_value(&frontmatter.work_products),
    })
}

// ============================================================================
// Ack
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollabAckResult {
    pub entry_ids: Vec<i64>,
    pub kind: String,
    pub entity_id: String,
    pub ok: bool,
    #[serde(default)]
    pub remote_version: Option<i64>,
    #[serde(default)]
    pub error: Option<String>,
}

/// Persist push outcomes. Success records the server version into the
/// row's `collab_remote_version`; an OCC conflict requeues immediately
/// (the engine has already applied the fresh remote row and re-drains
/// within the same cycle); anything else walks the standard backoff.
pub fn ack_outbox(results: Vec<CollabAckResult>) -> Result<(), String> {
    let conn = io::conn()?;
    let now = now_ms();
    for result in results {
        if result.ok {
            for id in &result.entry_ids {
                io::mark_succeeded(&conn, *id)?;
            }
            if let Some(version) = result.remote_version {
                store_remote_version(&conn, &result.kind, &result.entity_id, version)?;
            }
        } else if result
            .error
            .as_deref()
            .is_some_and(|error| error.contains("ORGII_CONFLICT"))
        {
            for id in &result.entry_ids {
                conn.execute(
                    "UPDATE outbox_entries SET status = ?1, last_attempted_at = NULL
                      WHERE id = ?2",
                    params![OutboxStatus::Pending.as_db_str(), id],
                )
                .map_err(|err| format!("DB error (requeue conflicted row): {}", err))?;
            }
        } else {
            let message = result.error.as_deref().unwrap_or("collab push failed");
            for id in &result.entry_ids {
                io::mark_failed_with_backoff(&conn, *id, now, message, false)?;
            }
        }
    }
    Ok(())
}

fn store_remote_version(
    conn: &Connection,
    kind: &str,
    entity_id: &str,
    version: i64,
) -> Result<(), String> {
    let table = match kind {
        KIND_PROJECT => "projects",
        KIND_WORK_ITEM => "workitems",
        other => return Err(format!("unknown collab entity kind: {}", other)),
    };
    conn.execute(
        &format!(
            "UPDATE {table} SET collab_remote_version = ?1
              WHERE id = ?2
                AND (collab_remote_version IS NULL OR collab_remote_version < ?1)"
        ),
        params![version, entity_id],
    )
    .map_err(|err| format!("DB error (store remote version): {}", err))?;
    Ok(())
}

// ============================================================================
// Apply remote (pull → SQLite)
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollabRemoteEntity {
    /// `"project"` | `"work_item"`.
    pub kind: String,
    /// The server row as pulled: payload jsonb merged with version /
    /// updatedByMemberId / deletedAt (see `orgii_list_org_state`).
    pub payload: Value,
    pub version: i64,
    #[serde(default)]
    pub updated_by: Option<String>,
    #[serde(default)]
    pub deleted_at: Option<String>,
}

/// Apply a pulled server delta. Projects apply before work items so a
/// freshly shared project exists by the time its items arrive. Returns
/// the number of entities that changed local state. NO apply path emits
/// outbox rows (no echo).
///
/// Each entity applies in isolation: one bad row (e.g. a `short_id`
/// unique-index collision with an unrelated local item, or a malformed
/// payload) must not abort the rest of the batch — it is logged and
/// skipped, and re-attempted on the next pull because its
/// `collab_remote_version` was never stored.
pub fn apply_remote(
    org_id: &str,
    org_name: Option<&str>,
    entities: Vec<CollabRemoteEntity>,
) -> Result<usize, String> {
    ensure_collab_project_org(org_id, org_name)?;
    let mut applied = 0;
    for entity in entities.iter().filter(|entity| entity.kind == KIND_PROJECT) {
        match apply_project(org_id, entity) {
            Ok(true) => applied += 1,
            Ok(false) => {}
            Err(err) => {
                tracing::warn!(
                    org_id,
                    entity_id = string_field(&entity.payload, "id").as_deref().unwrap_or("?"),
                    error = %err,
                    "[collab_bridge] skipping project that failed to apply"
                );
            }
        }
    }
    for entity in entities
        .iter()
        .filter(|entity| entity.kind == KIND_WORK_ITEM)
    {
        match apply_work_item(org_id, entity) {
            Ok(true) => applied += 1,
            Ok(false) => {}
            Err(err) => {
                tracing::warn!(
                    org_id,
                    entity_id = string_field(&entity.payload, "id").as_deref().unwrap_or("?"),
                    error = %err,
                    "[collab_bridge] skipping work item that failed to apply"
                );
            }
        }
    }
    Ok(applied)
}

/// Idempotently make sure the aliased `project_orgs` row exists and is
/// marked collab-synced. Self-healing: orgs created by an older client
/// (plain `source='local'`) are upgraded in place.
pub fn ensure_collab_project_org(org_id: &str, org_name: Option<&str>) -> Result<(), String> {
    if read_project_org(org_id).is_err() {
        let request = CreateProjectOrgRequest {
            name: org_name.unwrap_or(org_id).to_string(),
            id: Some(org_id.to_string()),
        };
        if create_project_org(&request).is_err() {
            // Name/slug collision with an unrelated org — retry with the
            // globally unique org id as the name.
            create_project_org(&CreateProjectOrgRequest {
                name: org_id.to_string(),
                id: Some(org_id.to_string()),
            })?;
        }
    }
    let conn = io::conn()?;
    conn.execute(
        "UPDATE project_orgs
            SET source = ?1, sync_provider = ?2, updated_at = ?3
          WHERE id = ?4 AND sync_provider != ?2",
        params![COLLAB_ORG_SOURCE, COLLAB_SYNC_PROVIDER, now_ms(), org_id],
    )
    .map_err(|err| format!("DB error (mark org collab-synced): {}", err))?;
    Ok(())
}

fn entity_deleted_at(entity: &CollabRemoteEntity) -> Option<&str> {
    entity
        .deleted_at
        .as_deref()
        .or_else(|| entity.payload.get("deletedAt").and_then(Value::as_str))
        .filter(|value| !value.is_empty())
}

/// Pending local field paths newer than `remote_ms` for one entity —
/// those fields keep their local value when the remote row lands.
/// (Cross-clock; legacy guard used only by [`apply_project`]'s
/// whole-row fallback, for peers whose project rows carry no
/// `_fieldRevisions` map. The per-field merge path never consults it —
/// local watermarks subsume it.)
fn newer_pending_fields(
    conn: &Connection,
    org_id: &str,
    entity_type: EntityType,
    entity_id: &str,
    remote_ms: i64,
) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT field_path, created_at FROM outbox_entries
              WHERE org_id = ?1 AND entity_type = ?2 AND entity_id = ?3
                AND status IN (?4, ?5)",
        )
        .map_err(|err| format!("DB error (prepare pending probe): {}", err))?;
    let rows = stmt
        .query_map(
            params![
                org_id,
                entity_type.as_db_str(),
                entity_id,
                OutboxStatus::Pending.as_db_str(),
                OutboxStatus::InFlight.as_db_str(),
            ],
            |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, i64>(1)?)),
        )
        .map_err(|err| format!("DB error (query pending probe): {}", err))?;
    let mut fields = Vec::new();
    for entry in rows {
        let (field_path, created_at) =
            entry.map_err(|err| format!("DB error (collect pending probe): {}", err))?;
        if created_at <= remote_ms {
            continue;
        }
        if let Some(paths) = field_path {
            for path in paths.split(',').filter(|path| !path.is_empty()) {
                if !fields.iter().any(|existing| existing == path) {
                    fields.push(path.to_string());
                }
            }
        }
    }
    Ok(fields)
}

/// True when ANY pending or in-flight outbox row exists for the entity.
/// Deliberately timestamp-free: comparing the local row's wall-clock
/// `created_at` against the remote row's `updatedAt` (a different
/// machine's clock) can mis-classify a local un-pushed edit as "older"
/// and let a whole-row remote snapshot clobber it. Presence of a
/// pending push is the only clock-safe signal that local state has
/// diverged.
fn has_pending_outbox_rows(
    conn: &Connection,
    org_id: &str,
    entity_type: EntityType,
    entity_id: &str,
) -> Result<bool, String> {
    conn.query_row(
        "SELECT 1 FROM outbox_entries
          WHERE org_id = ?1 AND entity_type = ?2 AND entity_id = ?3
            AND status IN (?4, ?5)
          LIMIT 1",
        params![
            org_id,
            entity_type.as_db_str(),
            entity_id,
            OutboxStatus::Pending.as_db_str(),
            OutboxStatus::InFlight.as_db_str(),
        ],
        |_| Ok(true),
    )
    .optional()
    .map(|found| found.unwrap_or(false))
    .map_err(|err| format!("DB error (pending presence probe): {}", err))
}

fn apply_project(org_id: &str, entity: &CollabRemoteEntity) -> Result<bool, String> {
    let Some(project_id) = string_field(&entity.payload, "id") else {
        return Ok(false);
    };
    let conn = io::conn()?;

    let existing = conn
        .query_row(
            "SELECT slug, collab_remote_version FROM projects WHERE id = ?1 AND org_id = ?2",
            params![&project_id, org_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<i64>>(1)?)),
        )
        .optional()
        .map_err(|err| format!("DB error (apply project probe): {}", err))?;

    if let Some((_, Some(known_version))) = &existing {
        if *known_version >= entity.version {
            return Ok(false); // Already applied / our own push echoing back.
        }
    }

    if entity_deleted_at(entity).is_some() {
        let Some((_slug, _)) = existing else {
            return Ok(false);
        };
        // Hard delete (local projects have no soft-delete); the server
        // tombstones the project's work items too and those arrive in the
        // same delta as individual soft-deletes.
        conn.execute(
            "DELETE FROM projects WHERE id = ?1 AND org_id = ?2",
            params![&project_id, org_id],
        )
        .map_err(|err| format!("DB error (apply project delete): {}", err))?;
        return Ok(true);
    }

    let remote_ms =
        iso_to_ms(entity.payload.get("updatedAt").and_then(Value::as_str)).unwrap_or_else(now_ms);
    // Per-field revision mtimes on the wire — parity with work items
    // (`_fieldRevisions`, see work_item_wire): when present, the merge
    // below compares each field against ITS OWN remote mtime, so a
    // whole-row snapshot never reverts a project field the remote
    // author didn't touch. Absent/empty map = legacy peer → whole-row
    // clock guarded by the cross-clock pending-edit probe (pre-fix
    // behavior, backward safe).
    let remote_field_mtimes = parse_wire_field_mtimes(&entity.payload);
    let protected_fields = if existing.is_some() && remote_field_mtimes.is_none() {
        newer_pending_fields(&conn, org_id, EntityType::Project, &project_id, remote_ms)?
    } else {
        Vec::new()
    };
    drop(conn);

    let wire_name = string_field(&entity.payload, "name");
    let wire_prefix = string_field(&entity.payload, "workItemPrefix");

    let (slug, mut meta, mut description) = match &existing {
        Some((slug, _)) => {
            let data = read_project_scoped(slug, Some(org_id))?;
            (slug.clone(), data.meta, data.description)
        }
        None => {
            let desired =
                string_field(&entity.payload, "slug").unwrap_or_else(|| project_id.clone());
            let slug = unique_project_slug(&desired, &project_id)?;
            let now_iso = chrono::Utc::now().to_rfc3339();
            let meta = ProjectMeta {
                id: project_id.clone(),
                name: wire_name.clone().unwrap_or_else(|| project_id.clone()),
                org_id: org_id.to_string(),
                status: "active".to_string(),
                priority: "none".to_string(),
                health: "on_track".to_string(),
                lead: None,
                members: vec![],
                labels: vec![],
                linked_repos: vec![],
                start_date: None,
                target_date: None,
                created_at: string_field(&entity.payload, "createdAt").unwrap_or(now_iso),
                updated_at: String::new(),
                next_work_item_id: 1,
                work_item_prefix: String::new(),
                work_item_prefix_custom: false,
                agent_defaults: None,
            };
            (slug, meta, String::new())
        }
    };

    meta.org_id = org_id.to_string();
    let adopted_revisions: HashMap<String, FieldRevision> =
        match (&existing, remote_field_mtimes.as_ref()) {
            (Some(_), Some(mtimes)) => {
                // Per-field merge — identical policy to apply_work_item's
                // FieldRevision resolver: a wire field applies only when
                // its own remote mtime beats the local watermark
                // (same-field latest-wins; ties adopt remote); fields
                // absent from the wire map are stale whole-row carry-overs
                // the remote author didn't change — keep local.
                let local_revisions = read_project_field_revisions(&project_id)?;
                let decision = conflict::resolve_named_fields(
                    PROJECT_SYNC_FIELDS,
                    &project_fields_from_wire(&entity.payload),
                    remote_ms,
                    &local_revisions,
                    COLLAB_REVISION_SOURCE,
                    Some(mtimes),
                );
                for (field, value) in &decision.adopted_fields {
                    apply_adopted_project_field(&mut meta, &mut description, field, value);
                }
                // The row's prefix is established either way (kept local
                // or wire-adopted just above); mark it custom so the
                // write path doesn't re-derive it from an adopted name.
                meta.work_item_prefix_custom = true;
                decision.new_revisions
            }
            _ => {
                // Whole-row apply: remote creation (nothing local to
                // protect) or a legacy peer without `_fieldRevisions`
                // (degrade to the pre-fix whole-row clock + pending-edit
                // guard). Applied fields are stamped at their remote
                // watermark so later per-field merges compare correctly
                // (mirrors apply_work_item's create path).
                let protected = |field: &str| protected_fields.iter().any(|entry| entry == field);
                let mut applied: Vec<&'static str> = Vec::new();
                if !protected("name") {
                    if let Some(name) = wire_name {
                        meta.name = name;
                        applied.push("name");
                    }
                }
                if !protected("status") {
                    if let Some(status) = string_field(&entity.payload, "status") {
                        meta.status = status;
                        applied.push("status");
                    }
                }
                if !protected("priority") {
                    if let Some(priority) = string_field(&entity.payload, "priority") {
                        meta.priority = priority;
                        applied.push("priority");
                    }
                }
                if !protected("health") {
                    if let Some(health) = string_field(&entity.payload, "health") {
                        meta.health = health;
                        applied.push("health");
                    }
                }
                if !protected("lead") {
                    meta.lead = string_field(&entity.payload, "leadMemberId");
                    applied.push("lead");
                }
                if !protected("start_date") {
                    meta.start_date = string_field(&entity.payload, "startDate");
                    applied.push("start_date");
                }
                if !protected("target_date") {
                    meta.target_date = string_field(&entity.payload, "targetDate");
                    applied.push("target_date");
                }
                if !protected("description") {
                    if let Some(body) = entity.payload.get("description").and_then(Value::as_str) {
                        description = body.to_string();
                        applied.push("description");
                    }
                }
                if let Some(prefix) = wire_prefix {
                    meta.work_item_prefix = prefix;
                    meta.work_item_prefix_custom = true;
                    applied.push("work_item_prefix");
                }
                applied
                    .into_iter()
                    .map(|field| {
                        let mtime = remote_field_mtimes
                            .as_ref()
                            .and_then(|map| map.get(field))
                            .copied()
                            .unwrap_or(remote_ms);
                        (
                            field.to_string(),
                            FieldRevision {
                                mtime,
                                source: COLLAB_REVISION_SOURCE.to_string(),
                            },
                        )
                    })
                    .collect()
            }
        };

    write_project_remote(&slug, &meta, &description, &adopted_revisions)?;

    let conn = io::conn()?;
    store_remote_version(&conn, KIND_PROJECT, &project_id, entity.version)?;
    Ok(true)
}

/// Normalize the camelCase project wire keys into the local field-name
/// JSON [`conflict::resolve_named_fields`] walks — the project
/// counterpart of [`work_item_fields_from_wire`]. Keys are always
/// present (nulls clear nullable fields when adopted).
fn project_fields_from_wire(payload: &Value) -> Value {
    json!({
        "name": payload.get("name").cloned().unwrap_or(Value::Null),
        "status": payload.get("status").cloned().unwrap_or(Value::Null),
        "priority": payload.get("priority").cloned().unwrap_or(Value::Null),
        "health": payload.get("health").cloned().unwrap_or(Value::Null),
        "lead": payload.get("leadMemberId").cloned().unwrap_or(Value::Null),
        "start_date": payload.get("startDate").cloned().unwrap_or(Value::Null),
        "target_date": payload.get("targetDate").cloned().unwrap_or(Value::Null),
        "description": payload.get("description").cloned().unwrap_or(Value::Null),
        "work_item_prefix": payload.get("workItemPrefix").cloned().unwrap_or(Value::Null),
    })
}

/// Write one resolver-adopted field into the project meta/description,
/// with the exact per-field value semantics of the whole-row apply
/// path: required strings only overwrite with non-empty values,
/// nullable fields clear on null/empty, an adopted prefix flips the
/// custom flag (`workItemPrefix` changes are admin-gated server-side,
/// so an adopted value is authoritative by the time it reaches a pull).
fn apply_adopted_project_field(
    meta: &mut ProjectMeta,
    description: &mut String,
    field: &str,
    value: &Value,
) {
    let non_empty = |value: &Value| {
        value
            .as_str()
            .filter(|text| !text.is_empty())
            .map(str::to_string)
    };
    match field {
        "name" => {
            if let Some(name) = non_empty(value) {
                meta.name = name;
            }
        }
        "status" => {
            if let Some(status) = non_empty(value) {
                meta.status = status;
            }
        }
        "priority" => {
            if let Some(priority) = non_empty(value) {
                meta.priority = priority;
            }
        }
        "health" => {
            if let Some(health) = non_empty(value) {
                meta.health = health;
            }
        }
        "lead" => meta.lead = non_empty(value),
        "start_date" => meta.start_date = non_empty(value),
        "target_date" => meta.target_date = non_empty(value),
        "description" => {
            if let Some(body) = value.as_str() {
                *description = body.to_string();
            }
        }
        "work_item_prefix" => {
            if let Some(prefix) = non_empty(value) {
                meta.work_item_prefix = prefix;
                meta.work_item_prefix_custom = true;
            }
        }
        other => {
            tracing::warn!(
                "[collab_bridge] resolver adopted unknown project field '{}'",
                other
            );
        }
    }
}

/// Pick a slug that doesn't collide with a different project (the slug
/// column is globally unique across orgs).
fn unique_project_slug(desired: &str, project_id: &str) -> Result<String, String> {
    let conn = io::conn()?;
    let mut candidate = desired.to_string();
    let mut round = 0;
    loop {
        let holder: Option<String> = conn
            .query_row(
                "SELECT id FROM projects WHERE slug = ?1",
                params![&candidate],
                |row| row.get(0),
            )
            .optional()
            .map_err(|err| format!("DB error (slug probe): {}", err))?;
        match holder {
            None => return Ok(candidate),
            Some(id) if id == project_id => return Ok(candidate),
            Some(_) => {
                round += 1;
                if round > 32 {
                    return Err(format!("could not derive a unique slug for '{}'", desired));
                }
                candidate = format!("{}-{}", desired, round + 1);
            }
        }
    }
}

/// Parse the `_fieldRevisions` map (local field name → mtime ms) a peer sends
/// alongside a whole-row snapshot. `None` when absent — the resolver then falls
/// back to the whole-row clock (legacy/pre-fix peers; not reachable post-M6a).
///
/// An EMPTY map is also treated as `None`: the wire contract says "field
/// absent from the map = the remote author didn't touch it, keep local",
/// so taking an empty map literally would mean "keep local for EVERY
/// field" and a pusher whose watermarks were wiped (or never stamped)
/// could never propagate anything. Degrading to the whole-row clock
/// restores pre-fix semantics for such peers.
fn parse_wire_field_mtimes(payload: &Value) -> Option<std::collections::HashMap<String, i64>> {
    let obj = payload.get("_fieldRevisions")?.as_object()?;
    let mut map = std::collections::HashMap::with_capacity(obj.len());
    for (name, value) in obj {
        if let Some(mtime) = value.as_i64() {
            map.insert(name.clone(), mtime);
        }
    }
    if map.is_empty() {
        return None;
    }
    Some(map)
}

/// Normalize the camelCase wire keys into the local field-name JSON the
/// resolver walks. Keys are always present (nulls clear the field).
fn work_item_fields_from_wire(payload: &Value) -> Value {
    json!({
        "title": payload.get("title").cloned().unwrap_or(Value::Null),
        "body": payload.get("body").cloned().unwrap_or(Value::Null),
        "status": payload.get("status").cloned().unwrap_or(Value::Null),
        "priority": payload.get("priority").cloned().unwrap_or(Value::Null),
        "assignee": payload.get("assigneeMemberId").cloned().unwrap_or(Value::Null),
        "milestone": payload.get("milestone").cloned().unwrap_or(Value::Null),
        "start_date": payload.get("startDate").cloned().unwrap_or(Value::Null),
        "target_date": payload.get("targetDate").cloned().unwrap_or(Value::Null),
        "labels": payload.get("labels").cloned().unwrap_or(Value::Null),
    })
}

fn frontmatter_from_wire(
    payload: &Value,
    work_item_id: &str,
    project_id: Option<String>,
) -> WorkItemFrontmatter {
    fn tail<T: serde::de::DeserializeOwned + Default>(payload: &Value, key: &str) -> T {
        payload
            .get(key)
            .cloned()
            .and_then(|value| serde_json::from_value(value).ok())
            .unwrap_or_default()
    }
    fn tail_opt<T: serde::de::DeserializeOwned>(payload: &Value, key: &str) -> Option<T> {
        payload
            .get(key)
            .cloned()
            .filter(|value| !value.is_null())
            .and_then(|value| serde_json::from_value(value).ok())
    }
    let now_iso = chrono::Utc::now().to_rfc3339();
    WorkItemFrontmatter {
        id: work_item_id.to_string(),
        short_id: string_field(payload, "shortId").unwrap_or_else(|| work_item_id.to_string()),
        title: string_field(payload, "title").unwrap_or_default(),
        project: project_id,
        status: string_field(payload, "status").unwrap_or_else(default_status),
        priority: string_field(payload, "priority").unwrap_or_else(default_priority),
        assignee: string_field(payload, "assigneeMemberId"),
        assignee_type: string_field(payload, "assigneeType"),
        labels: tail(payload, "labels"),
        milestone: string_field(payload, "milestone"),
        parent: string_field(payload, "parentId"),
        start_date: string_field(payload, "startDate"),
        target_date: string_field(payload, "targetDate"),
        created_by: string_field(payload, "createdBy"),
        created_at: string_field(payload, "createdAt").unwrap_or_else(|| now_iso.clone()),
        updated_at: string_field(payload, "updatedAt").unwrap_or(now_iso),
        deleted_at: None,
        starred: payload
            .get("starred")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        todos: tail(payload, "todos"),
        comments: tail(payload, "comments"),
        history: tail(payload, "history"),
        delegations: Vec::new(),
        linked_sessions: tail(payload, "linkedSessions"),
        proof_of_work: tail_opt(payload, "proofOfWork"),
        orchestrator_config: tail_opt(payload, "orchestratorConfig"),
        orchestrator_state: tail_opt(payload, "orchestratorState"),
        follow_up_items: Vec::new(),
        schedule: tail_opt(payload, "schedule"),
        routine_source: None,
        execution_lock: tail_opt(payload, "executionLock"),
        close_out: tail_opt(payload, "closeOut"),
        work_products: tail(payload, "workProducts"),
    }
}

fn apply_work_item(org_id: &str, entity: &CollabRemoteEntity) -> Result<bool, String> {
    let Some(work_item_id) = string_field(&entity.payload, "id") else {
        return Ok(false);
    };
    let conn = io::conn()?;

    let existing = conn
        .query_row(
            "SELECT project_id, short_id, deleted_at, collab_remote_version
               FROM workitems WHERE id = ?1 AND org_id = ?2",
            params![&work_item_id, org_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|err| format!("DB error (apply work item probe): {}", err))?;

    if let Some((_, _, _, Some(known_version))) = &existing {
        if *known_version >= entity.version {
            return Ok(false);
        }
    }

    if let Some(deleted_at) = entity_deleted_at(entity) {
        let Some(_) = existing else {
            return Ok(false); // Created and deleted before we ever saw it.
        };
        let deleted_ms = iso_to_ms(Some(deleted_at)).unwrap_or_else(now_ms);
        conn.execute(
            "UPDATE workitems
                SET deleted_at = ?1, updated_at = ?2,
                    local_version = local_version + 1,
                    collab_remote_version = ?3
              WHERE id = ?4 AND org_id = ?5",
            params![deleted_ms, now_ms(), entity.version, &work_item_id, org_id],
        )
        .map_err(|err| format!("DB error (apply work item delete): {}", err))?;
        return Ok(true);
    }

    let remote_ms =
        iso_to_ms(entity.payload.get("updatedAt").and_then(Value::as_str)).unwrap_or_else(now_ms);
    let has_pending = has_pending_outbox_rows(&conn, org_id, EntityType::WorkItem, &work_item_id)?;

    let wire_project_id = string_field(&entity.payload, "projectId");
    let project_slug: Option<String> = match wire_project_id.as_deref() {
        Some(project_id) => {
            let slug: Option<String> = conn
                .query_row(
                    "SELECT slug FROM projects WHERE id = ?1 AND org_id = ?2",
                    params![project_id, org_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|err| format!("DB error (apply work item project probe): {}", err))?;
            if slug.is_none() {
                tracing::warn!(
                    "[collab_bridge] skipping work item {}: project {} is not local yet",
                    work_item_id,
                    project_id
                );
                return Ok(false);
            }
            slug
        }
        None => None,
    };

    match existing {
        Some((local_project_id, short_id, local_deleted_at, _)) => {
            // Remote revival of a locally soft-deleted row: the server
            // upsert cleared deleted_at, mirror that first so the partial
            // update below operates on a live row.
            if local_deleted_at.is_some() {
                conn.execute(
                    "UPDATE workitems SET deleted_at = NULL WHERE id = ?1 AND org_id = ?2",
                    params![&work_item_id, org_id],
                )
                .map_err(|err| format!("DB error (apply work item revive): {}", err))?;
            }

            // The merge runs against the item's CURRENT local project;
            // a remote move to another project applies as a `project`
            // field update afterwards.
            let local_slug: Option<String> = match local_project_id.as_deref() {
                Some(project_id) => conn
                    .query_row(
                        "SELECT slug FROM projects WHERE id = ?1",
                        params![project_id],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(|err| format!("DB error (apply work item local slug): {}", err))?,
                None => None,
            };

            if let Some(slug) = local_slug {
                // Project-scoped: per-field merge via the FieldRevision
                // resolver — identical policy to the Linear adapter
                // (remote wins per field unless the local watermark is
                // newer; ties adopt remote).
                let metadata = read_sync_metadata(&slug, &short_id)?.unwrap_or_default();
                let remote_field_mtimes = parse_wire_field_mtimes(&entity.payload);
                let change = super::adapter::ExternalChange {
                    entity_type: EntityType::WorkItem,
                    external_id: work_item_id.clone(),
                    local_entity_id: Some(short_id.clone()),
                    fields: work_item_fields_from_wire(&entity.payload),
                    remote_updated_at: chrono::DateTime::from_timestamp_millis(remote_ms)
                        .unwrap_or_else(chrono::Utc::now),
                    deleted: false,
                };
                let decision = conflict::resolve_with_policy(
                    &change,
                    &metadata,
                    COLLAB_REVISION_SOURCE,
                    &COLLAB_FIELD_MAP,
                    remote_field_mtimes.as_ref(),
                    |_| super::adapter::ConflictResolution::UseRemote,
                );

                let adopted: serde_json::Map<String, Value> =
                    decision.adopted_fields.clone().into_iter().collect();
                let mut update = super::worker::partial_update_from_map(&adopted);
                if !has_pending {
                    apply_wire_tail(&mut update, &entity.payload);
                    if wire_project_id != local_project_id {
                        update.project = Some(wire_project_id.clone());
                    }
                } else {
                    // NOTE (collab tail residual): payload-tail fields have
                    // no per-field revision store, so a whole-row remote
                    // snapshot can't tell which tail field the remote
                    // author actually touched. While ANY local push is
                    // pending for this entity we therefore do NOT
                    // whole-row-apply the tail (scalars keep local;
                    // remote tail scalar changes — including an
                    // executionLock release — land on the next pull
                    // after our push resolves). List-shaped tail fields
                    // are union-merged by stable entry id instead, so a
                    // teammate's new comment/todo still arrives without
                    // clobbering the local un-pushed one; remote edits
                    // to / deletions of an entry both sides carry are
                    // deferred the same way scalars are.
                    if let Some(local) = read_work_item_by_row_id(org_id, &work_item_id)? {
                        apply_wire_tail_union(&mut update, &entity.payload, &local.frontmatter);
                    }
                }
                drop(conn);
                update_work_item_partial_with_revisions(
                    &slug,
                    &short_id,
                    decision.new_revisions,
                    &update,
                )?;
                let conn = io::conn()?;
                store_remote_version(&conn, KIND_WORK_ITEM, &work_item_id, entity.version)?;
            } else {
                // Standalone (or project mismatch): whole-row semantics.
                // With ANY local pending push we keep local (clock-safe
                // presence gate, same rationale as the tail above) — the
                // next push OCC-conflicts and merges against the then-
                // fresh remote row instead.
                if has_pending {
                    return Ok(false);
                }
                drop(conn);
                let frontmatter =
                    frontmatter_from_wire(&entity.payload, &work_item_id, wire_project_id.clone());
                let body = entity
                    .payload
                    .get("body")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                write_work_item_remote(
                    wire_project_id.clone(),
                    org_id,
                    &frontmatter.short_id.clone(),
                    &frontmatter,
                    body,
                )?;
                let conn = io::conn()?;
                store_remote_version(&conn, KIND_WORK_ITEM, &work_item_id, entity.version)?;
            }
        }
        None => {
            drop(conn);
            let frontmatter =
                frontmatter_from_wire(&entity.payload, &work_item_id, wire_project_id.clone());
            let body = entity
                .payload
                .get("body")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let short_id = frontmatter.short_id.clone();
            write_work_item_remote(
                wire_project_id.clone(),
                org_id,
                &short_id,
                &frontmatter,
                body,
            )?;

            // Stamp per-field watermarks at the remote mtime so a later
            // local edit is correctly "newer than remote" in the resolver.
            if let Some(slug) = project_slug.as_ref() {
                let fields = work_item_fields_from_wire(&entity.payload);
                let mut revisions = HashMap::new();
                if let Some(object) = fields.as_object() {
                    for key in object.keys() {
                        revisions.insert(
                            key.clone(),
                            crate::projects::io::FieldRevision {
                                mtime: remote_ms,
                                source: COLLAB_REVISION_SOURCE.to_string(),
                            },
                        );
                    }
                }
                apply_remote_merge(slug, &short_id, revisions, None)?;
            }
            let conn = io::conn()?;
            store_remote_version(&conn, KIND_WORK_ITEM, &work_item_id, entity.version)?;
        }
    }
    Ok(true)
}

/// Long-tail wire fields → partial update slots. Applied only when no
/// pending local outbox change is newer than the remote row (the hot
/// fields go through the per-field resolver instead).
fn apply_wire_tail(update: &mut WorkItemPartialUpdate, payload: &Value) {
    fn tail<T: serde::de::DeserializeOwned>(payload: &Value, key: &str) -> Option<T> {
        payload
            .get(key)
            .cloned()
            .and_then(|value| serde_json::from_value(value).ok())
    }
    if let Some(todos) = tail(payload, "todos") {
        update.todos = Some(todos);
    }
    if let Some(comments) = tail(payload, "comments") {
        update.comments = Some(comments);
    }
    if let Some(linked_sessions) = tail(payload, "linkedSessions") {
        update.linked_sessions = Some(linked_sessions);
    }
    if let Some(orchestrator_config) = tail(payload, "orchestratorConfig") {
        update.orchestrator_config = Some(orchestrator_config);
    }
    if let Some(orchestrator_state) = tail(payload, "orchestratorState") {
        update.orchestrator_state = Some(orchestrator_state);
    }
    if payload.get("schedule").is_some() {
        update.schedule = Some(tail(payload, "schedule"));
    }
    if payload.get("executionLock").is_some() {
        update.execution_lock = Some(tail(payload, "executionLock"));
    }
    if payload.get("closeOut").is_some() {
        update.close_out = Some(tail(payload, "closeOut"));
    }
    if let Some(work_products) = tail(payload, "workProducts") {
        update.work_products = Some(work_products);
    }
    if let Some(starred) = payload.get("starred").and_then(Value::as_bool) {
        update.starred = Some(starred);
    }
    if payload.get("assigneeType").is_some() {
        update.assignee_type = Some(
            payload
                .get("assigneeType")
                .and_then(Value::as_str)
                .map(str::to_string),
        );
    }
}

/// Union-merge applied to the list-shaped tail fields while a local
/// push is pending (see the residual note in [`apply_work_item`]):
/// every local entry survives (a pending local addition/edit must not
/// be clobbered), and remote entries whose stable id is unknown locally
/// are appended. Remote edits to entries both sides carry — and remote
/// deletions — do not apply here; they land via the whole-row tail on
/// the next pull once the local push has resolved.
fn apply_wire_tail_union(
    update: &mut WorkItemPartialUpdate,
    payload: &Value,
    local: &WorkItemFrontmatter,
) {
    fn tail<T: serde::de::DeserializeOwned>(payload: &Value, key: &str) -> Option<T> {
        payload
            .get(key)
            .cloned()
            .and_then(|value| serde_json::from_value(value).ok())
    }
    if let Some(todos) = tail::<Vec<TodoEntry>>(payload, "todos") {
        if let Some(merged) = union_by_key(&local.todos, todos, |entry| entry.id.clone()) {
            update.todos = Some(merged);
        }
    }
    if let Some(comments) = tail::<Vec<CommentEntry>>(payload, "comments") {
        if let Some(merged) = union_by_key(&local.comments, comments, |entry| entry.id.clone()) {
            update.comments = Some(merged);
        }
    }
    if let Some(sessions) = tail::<Vec<LinkedSession>>(payload, "linkedSessions") {
        if let Some(merged) = union_by_key(&local.linked_sessions, sessions, |entry| {
            entry.session_id.clone()
        }) {
            update.linked_sessions = Some(merged);
        }
    }
    if let Some(products) = tail::<Vec<WorkItemWorkProduct>>(payload, "workProducts") {
        if let Some(merged) = union_by_key(&local.work_products, products, |entry| entry.id.clone())
        {
            update.work_products = Some(merged);
        }
    }
}

/// Start from the local list, append remote entries with an unseen key.
/// Returns `None` when nothing was appended (no write needed).
fn union_by_key<T: Clone, K: PartialEq, F: Fn(&T) -> K>(
    local: &[T],
    remote: Vec<T>,
    key: F,
) -> Option<Vec<T>> {
    let mut merged: Vec<T> = local.to_vec();
    for entry in remote {
        if !local.iter().any(|existing| key(existing) == key(&entry)) {
            merged.push(entry);
        }
    }
    if merged.len() == local.len() {
        None
    } else {
        Some(merged)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::projects::io::{
        acquire_execution_lock, configure_project_org_collab_sync, read_project, read_work_item,
        release_execution_lock, update_work_item_partial, write_project, write_work_item,
    };
    use crate::projects::types::{ProjectData, WorkItemExecutionLockReason};
    use test_helpers::test_env;

    const ORG: &str = "org-collab-test";

    fn seed_collab_org() {
        create_project_org(&CreateProjectOrgRequest {
            name: "Collab Test Org".to_string(),
            id: Some(ORG.to_string()),
        })
        .expect("create org");
        configure_project_org_collab_sync(ORG, Some(ORG)).expect("configure collab sync");
    }

    fn project_meta(id: &str, name: &str) -> ProjectMeta {
        ProjectMeta {
            id: id.to_string(),
            name: name.to_string(),
            org_id: ORG.to_string(),
            status: "active".to_string(),
            priority: "none".to_string(),
            health: "on_track".to_string(),
            lead: None,
            members: vec![],
            labels: vec![],
            linked_repos: vec![],
            start_date: None,
            target_date: None,
            created_at: String::new(),
            updated_at: String::new(),
            next_work_item_id: 1,
            work_item_prefix: "AAA".to_string(),
            work_item_prefix_custom: true,
            agent_defaults: None,
        }
    }

    fn work_item_frontmatter(short_id: &str, title: &str) -> WorkItemFrontmatter {
        WorkItemFrontmatter {
            id: short_id.to_string(),
            short_id: short_id.to_string(),
            title: title.to_string(),
            project: None,
            status: "backlog".to_string(),
            priority: "none".to_string(),
            assignee: None,
            assignee_type: None,
            labels: vec![],
            milestone: None,
            parent: None,
            start_date: None,
            target_date: None,
            created_by: None,
            created_at: String::new(),
            updated_at: String::new(),
            deleted_at: None,
            starred: false,
            todos: vec![],
            comments: vec![],
            history: vec![],
            delegations: vec![],
            linked_sessions: vec![],
            proof_of_work: None,
            orchestrator_config: None,
            orchestrator_state: None,
            follow_up_items: vec![],
            schedule: None,
            routine_source: None,
            execution_lock: None,
            close_out: None,
            work_products: vec![],
        }
    }

    fn seed_project(slug: &str) -> ProjectData {
        write_project(slug, &project_meta(&format!("p-{slug}"), slug), "", true)
            .expect("seed project");
        read_project(slug).expect("read seeded project")
    }

    fn pending_org_rows() -> i64 {
        let conn = io::conn().expect("conn");
        conn.query_row(
            "SELECT COUNT(*) FROM outbox_entries WHERE org_id = ?1 AND status = 'pending'",
            params![ORG],
            |row| row.get(0),
        )
        .expect("count")
    }

    #[test]
    fn local_writes_enqueue_bridge_rows_the_worker_never_claims() {
        let _sandbox = test_env::sandbox();
        seed_collab_org();
        seed_project("alpha");
        write_work_item(
            "alpha",
            "AAA-0001",
            &work_item_frontmatter("AAA-0001", "T"),
            "b",
        )
        .expect("write item");

        assert!(pending_org_rows() >= 2, "project + work item rows expected");

        // The in-process worker must never claim bridge rows.
        let conn = io::conn().expect("conn");
        let claimed = io::claim_next_pending(&conn, now_ms() + 1).expect("claim");
        assert!(claimed.is_none(), "worker claimed a collab bridge row");
    }

    #[test]
    fn non_collab_org_writes_enqueue_nothing() {
        let _sandbox = test_env::sandbox();
        // personal-org exists by default and is not collab-synced.
        let mut meta = project_meta("p-solo", "solo");
        meta.org_id = "personal-org".to_string();
        write_project("solo", &meta, "", true).expect("write");
        let conn = io::conn().expect("conn");
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM outbox_entries", [], |row| row.get(0))
            .expect("count");
        assert_eq!(count, 0);
    }

    #[test]
    fn drain_coalesces_per_entity_and_ack_success_stores_version() {
        let _sandbox = test_env::sandbox();
        seed_collab_org();
        seed_project("alpha");
        write_work_item(
            "alpha",
            "AAA-0001",
            &work_item_frontmatter("AAA-0001", "T1"),
            "b",
        )
        .expect("write item");
        // Two partial updates → extra rows for the same entity.
        let mut update = WorkItemPartialUpdate::default();
        update.title = Some("T2".to_string());
        update_work_item_partial("alpha", "AAA-0001", &update).expect("update 1");
        let mut update = WorkItemPartialUpdate::default();
        update.status = Some("in_progress".to_string());
        update_work_item_partial("alpha", "AAA-0001", &update).expect("update 2");

        let items = drain_outbox(ORG, 50).expect("drain");
        let work_items: Vec<_> = items
            .iter()
            .filter(|item| item.kind == KIND_WORK_ITEM)
            .collect();
        assert_eq!(work_items.len(), 1, "coalesced into one push item");
        let item = work_items[0];
        assert_eq!(item.op, OP_UPSERT);
        assert!(item.entry_ids.len() >= 2);
        assert_eq!(item.base_version, None, "never synced yet");
        let payload = item.payload.as_ref().expect("payload");
        assert_eq!(payload["title"], "T2");
        assert_eq!(payload["status"], "in_progress");
        assert_eq!(payload["shortId"], "AAA-0001");

        // Nothing pending while in flight.
        assert_eq!(pending_org_rows(), 0);

        let acks: Vec<CollabAckResult> = items
            .iter()
            .map(|item| CollabAckResult {
                entry_ids: item.entry_ids.clone(),
                kind: item.kind.clone(),
                entity_id: item.entity_id.clone(),
                ok: true,
                remote_version: Some(7),
                error: None,
            })
            .collect();
        ack_outbox(acks).expect("ack");

        let conn = io::conn().expect("conn");
        let version: Option<i64> = conn
            .query_row(
                "SELECT collab_remote_version FROM workitems WHERE id = 'AAA-0001'",
                [],
                |row| row.get(0),
            )
            .expect("version");
        assert_eq!(version, Some(7));
        drop(conn);

        assert!(drain_outbox(ORG, 50).expect("drain again").is_empty());
    }

    #[test]
    fn drain_abandons_unsupported_entity_rows_instead_of_reclaiming_forever() {
        let _sandbox = test_env::sandbox();
        seed_collab_org();
        seed_project("alpha");
        let conn = io::conn().expect("conn");
        conn.execute(
            "INSERT INTO outbox_entries
                (project_slug, entity_type, entity_id, op, created_at, status, org_id)
             VALUES ('alpha', 'future_kind', 'future-1', 'update', 1, 'pending', ?1)",
            [ORG],
        )
        .expect("insert unsupported row");
        let row_id = conn.last_insert_rowid();
        drop(conn);

        let first_drain = drain_outbox(ORG, 50).expect("drain");
        assert!(
            first_drain.iter().all(|item| item.kind != "future_kind"),
            "unsupported rows must never reach the transport"
        );

        let conn = io::conn().expect("conn");
        let (status, error): (String, Option<String>) = conn
            .query_row(
                "SELECT status, last_error FROM outbox_entries WHERE id = ?1",
                [row_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("load terminal row");
        assert_eq!(status, OutboxStatus::Abandoned.as_db_str());
        assert_eq!(
            error.as_deref(),
            Some("unsupported collab entity_type: future_kind")
        );
        drop(conn);

        let second_drain = drain_outbox(ORG, 50).expect("drain again");
        assert!(
            second_drain.iter().all(|item| item.kind != "future_kind"),
            "abandoned rows must not be reclaimed"
        );
    }

    #[test]
    fn outbox_pending_ids_reports_pending_and_in_flight_until_ack() {
        let _sandbox = test_env::sandbox();
        seed_collab_org();
        let project = seed_project("alpha");
        write_work_item(
            "alpha",
            "AAA-0001",
            &work_item_frontmatter("AAA-0001", "T"),
            "b",
        )
        .expect("write item");

        let pending = outbox_pending_ids(ORG).expect("pending ids");
        assert!(pending.contains(&CollabPendingEntity {
            kind: KIND_PROJECT.to_string(),
            entity_id: project.meta.id.clone(),
        }));
        assert!(pending.contains(&CollabPendingEntity {
            kind: KIND_WORK_ITEM.to_string(),
            entity_id: "AAA-0001".to_string(),
        }));

        let items = drain_outbox(ORG, 50).expect("drain");
        assert_eq!(
            outbox_pending_ids(ORG).expect("in-flight ids").len(),
            2,
            "in-flight rows still count as pending for the UI"
        );

        let acks: Vec<CollabAckResult> = items
            .iter()
            .map(|item| CollabAckResult {
                entry_ids: item.entry_ids.clone(),
                kind: item.kind.clone(),
                entity_id: item.entity_id.clone(),
                ok: true,
                remote_version: Some(1),
                error: None,
            })
            .collect();
        ack_outbox(acks).expect("ack");
        assert!(outbox_pending_ids(ORG).expect("after ack").is_empty());

        assert!(outbox_pending_ids("personal-org")
            .expect("non-collab org")
            .is_empty());
    }

    #[test]
    fn ack_conflict_requeues_for_immediate_retry() {
        let _sandbox = test_env::sandbox();
        seed_collab_org();
        seed_project("alpha");

        let items = drain_outbox(ORG, 50).expect("drain");
        assert_eq!(items.len(), 1);
        ack_outbox(vec![CollabAckResult {
            entry_ids: items[0].entry_ids.clone(),
            kind: items[0].kind.clone(),
            entity_id: items[0].entity_id.clone(),
            ok: false,
            remote_version: None,
            error: Some("ORGII_CONFLICT".to_string()),
        }])
        .expect("ack conflict");

        let retried = drain_outbox(ORG, 50).expect("drain retry");
        assert_eq!(retried.len(), 1, "conflicted row re-drained immediately");
        assert_eq!(retried[0].entity_id, items[0].entity_id);
    }

    #[test]
    fn apply_remote_creates_entities_without_echo() {
        let _sandbox = test_env::sandbox();
        seed_collab_org();

        let applied = apply_remote(
            ORG,
            Some("Collab Test Org"),
            vec![
                CollabRemoteEntity {
                    kind: KIND_PROJECT.to_string(),
                    payload: json!({
                        "id": "proj-remote",
                        "slug": "remote-project",
                        "name": "Remote Project",
                        "status": "active",
                        "priority": "high",
                        "health": "on_track",
                        "workItemPrefix": "REM",
                        "description": "from teammate",
                        "updatedAt": "2026-07-01T00:00:00Z",
                    }),
                    version: 3,
                    updated_by: Some("member-b".to_string()),
                    deleted_at: None,
                },
                CollabRemoteEntity {
                    kind: KIND_WORK_ITEM.to_string(),
                    payload: json!({
                        "id": "REM-0001",
                        "projectId": "proj-remote",
                        "shortId": "REM-0001",
                        "title": "Remote item",
                        "body": "remote body",
                        "status": "backlog",
                        "priority": "none",
                        "labels": [],
                        "updatedAt": "2026-07-01T00:00:00Z",
                    }),
                    version: 2,
                    updated_by: Some("member-b".to_string()),
                    deleted_at: None,
                },
            ],
        )
        .expect("apply");
        assert_eq!(applied, 2);

        let project = read_project("remote-project").expect("project exists");
        assert_eq!(project.meta.id, "proj-remote");
        assert_eq!(project.meta.priority, "high");
        assert_eq!(project.description, "from teammate");
        let item = read_work_item("remote-project", "REM-0001").expect("item exists");
        assert_eq!(item.frontmatter.title, "Remote item");
        assert_eq!(item.body, "remote body");

        // No echo: remote application must not enqueue bridge rows.
        assert_eq!(pending_org_rows(), 0, "apply_remote echoed into the outbox");

        // Idempotence: same versions again → nothing applied.
        let reapplied = apply_remote(
            ORG,
            None,
            vec![CollabRemoteEntity {
                kind: KIND_WORK_ITEM.to_string(),
                payload: json!({
                    "id": "REM-0001",
                    "projectId": "proj-remote",
                    "shortId": "REM-0001",
                    "title": "Should not overwrite",
                    "updatedAt": "2026-07-01T00:00:01Z",
                }),
                version: 2,
                updated_by: None,
                deleted_at: None,
            }],
        )
        .expect("reapply");
        assert_eq!(reapplied, 0);
        let item = read_work_item("remote-project", "REM-0001").expect("item");
        assert_eq!(item.frontmatter.title, "Remote item");
    }

    #[test]
    fn apply_remote_merges_per_field_keeping_newer_local_edits() {
        let _sandbox = test_env::sandbox();
        seed_collab_org();
        // Remote-created item so per-field watermarks are stamped at the
        // remote mtime.
        apply_remote(
            ORG,
            None,
            vec![
                CollabRemoteEntity {
                    kind: KIND_PROJECT.to_string(),
                    payload: json!({
                        "id": "proj-remote",
                        "slug": "remote-project",
                        "name": "Remote Project",
                        "workItemPrefix": "REM",
                        "updatedAt": "2026-07-01T00:00:00Z",
                    }),
                    version: 1,
                    updated_by: None,
                    deleted_at: None,
                },
                CollabRemoteEntity {
                    kind: KIND_WORK_ITEM.to_string(),
                    payload: json!({
                        "id": "REM-0001",
                        "projectId": "proj-remote",
                        "shortId": "REM-0001",
                        "title": "Original title",
                        "body": "original",
                        "status": "backlog",
                        "updatedAt": "2026-07-01T00:00:00Z",
                    }),
                    version: 1,
                    updated_by: None,
                    deleted_at: None,
                },
            ],
        )
        .expect("seed remote");

        // Local edit AFTER the remote row's mtime → local title watermark
        // is newer than the incoming remote change below.
        let mut update = WorkItemPartialUpdate::default();
        update.title = Some("Local newer title".to_string());
        update_work_item_partial("remote-project", "REM-0001", &update).expect("local edit");

        // Teammate's row (version 2) carries an OLDER title mtime but a
        // status change; per-field: title keeps local, status adopts remote.
        let applied = apply_remote(
            ORG,
            None,
            vec![CollabRemoteEntity {
                kind: KIND_WORK_ITEM.to_string(),
                payload: json!({
                    "id": "REM-0001",
                    "projectId": "proj-remote",
                    "shortId": "REM-0001",
                    "title": "Teammate stale title",
                    "body": "original",
                    "status": "in_progress",
                    "updatedAt": "2026-07-01T00:00:30Z",
                }),
                version: 2,
                updated_by: Some("member-b".to_string()),
                deleted_at: None,
            }],
        )
        .expect("apply merge");
        assert_eq!(applied, 1);

        let item = read_work_item("remote-project", "REM-0001").expect("item");
        assert_eq!(
            item.frontmatter.title, "Local newer title",
            "newer local field must survive the remote row"
        );
        assert_eq!(
            item.frontmatter.status, "in_progress",
            "untouched field adopts remote"
        );

        // The pending local push (title edit) is still queued for the
        // retry push; the remote apply must not have consumed it.
        assert!(pending_org_rows() >= 1);
    }

    /// End-to-end wire contract for the critical field-merge fix: a peer sends
    /// a WHOLE-ROW snapshot with `_fieldRevisions` naming only the field it
    /// changed. A locally-edited field the remote did NOT touch must survive
    /// even though the remote's whole-row `updatedAt` is newer than the local
    /// edit — the exact case the old whole-row-clock merge got wrong.
    #[test]
    fn apply_remote_whole_row_snapshot_preserves_untouched_local_field() {
        let _sandbox = test_env::sandbox();
        seed_collab_org();
        apply_remote(
            ORG,
            None,
            vec![
                CollabRemoteEntity {
                    kind: KIND_PROJECT.to_string(),
                    payload: json!({
                        "id": "proj-remote",
                        "slug": "remote-project",
                        "name": "Remote Project",
                        "workItemPrefix": "REM",
                        "updatedAt": "2026-07-01T00:00:00Z",
                    }),
                    version: 1,
                    updated_by: None,
                    deleted_at: None,
                },
                CollabRemoteEntity {
                    kind: KIND_WORK_ITEM.to_string(),
                    payload: json!({
                        "id": "REM-0001",
                        "projectId": "proj-remote",
                        "shortId": "REM-0001",
                        "title": "Original title",
                        "status": "backlog",
                        "updatedAt": "2026-07-01T00:00:00Z",
                    }),
                    version: 1,
                    updated_by: None,
                    deleted_at: None,
                },
            ],
        )
        .expect("seed remote");

        // Local changes STATUS. Its per-field watermark is stamped at real now.
        let mut update = WorkItemPartialUpdate::default();
        update.status = Some("in_review".to_string());
        update_work_item_partial("remote-project", "REM-0001", &update).expect("local status edit");

        // Teammate pushes a WHOLE-ROW snapshot (v2): they changed only `title`.
        // `updatedAt` and title's mtime are far in the future (newer than the
        // local status edit), and `status` carries a STALE value the teammate
        // never touched — status is deliberately ABSENT from `_fieldRevisions`.
        let future_ms: i64 = 4_070_908_800_000; // 2099-01-01
        let applied = apply_remote(
            ORG,
            None,
            vec![CollabRemoteEntity {
                kind: KIND_WORK_ITEM.to_string(),
                payload: json!({
                    "id": "REM-0001",
                    "projectId": "proj-remote",
                    "shortId": "REM-0001",
                    "title": "Teammate new title",
                    "status": "backlog",
                    "updatedAt": "2099-01-01T00:00:00Z",
                    "_fieldRevisions": { "title": future_ms },
                }),
                version: 2,
                updated_by: Some("member-b".to_string()),
                deleted_at: None,
            }],
        )
        .expect("apply merge");
        assert_eq!(applied, 1);

        let item = read_work_item("remote-project", "REM-0001").expect("item");
        assert_eq!(
            item.frontmatter.status, "in_review",
            "a field the remote did not touch must not be reverted by its whole-row snapshot"
        );
        assert_eq!(
            item.frontmatter.title, "Teammate new title",
            "the field the remote genuinely changed is adopted"
        );
    }

    /// Seed a remote-owned project + one work item (both version 1,
    /// mtime 2026-07-01T00:00:00Z) via `apply_remote`, so no local
    /// outbox rows exist afterwards.
    fn seed_remote_project_and_item(item_payload_extra: Value) {
        let mut item_payload = json!({
            "id": "REM-0001",
            "projectId": "proj-remote",
            "shortId": "REM-0001",
            "title": "Original title",
            "body": "original",
            "status": "backlog",
            "updatedAt": "2026-07-01T00:00:00Z",
        });
        if let (Some(base), Some(extra)) =
            (item_payload.as_object_mut(), item_payload_extra.as_object())
        {
            for (key, value) in extra {
                base.insert(key.clone(), value.clone());
            }
        }
        apply_remote(
            ORG,
            None,
            vec![
                CollabRemoteEntity {
                    kind: KIND_PROJECT.to_string(),
                    payload: json!({
                        "id": "proj-remote",
                        "slug": "remote-project",
                        "name": "Remote Project",
                        "workItemPrefix": "REM",
                        "updatedAt": "2026-07-01T00:00:00Z",
                    }),
                    version: 1,
                    updated_by: None,
                    deleted_at: None,
                },
                CollabRemoteEntity {
                    kind: KIND_WORK_ITEM.to_string(),
                    payload: item_payload,
                    version: 1,
                    updated_by: None,
                    deleted_at: None,
                },
            ],
        )
        .expect("seed remote");
        assert_eq!(pending_org_rows(), 0, "seeding must not echo");
    }

    /// Finding: a pending local push must gate the whole-row tail apply
    /// by PRESENCE, not by comparing the local row's wall clock against
    /// the remote machine's `updatedAt`. Here the remote clock is far in
    /// the future — the old cross-clock gate would have judged the local
    /// pending comment "older" and clobbered it.
    #[test]
    fn pending_local_push_blocks_remote_tail_clobber_and_unions_lists() {
        let _sandbox = test_env::sandbox();
        seed_collab_org();
        seed_remote_project_and_item(json!({}));

        // Local un-pushed comment → pending outbox row.
        let mut update = WorkItemPartialUpdate::default();
        update.comments = Some(vec![CommentEntry {
            id: "local-c1".to_string(),
            author: "me".to_string(),
            content: "local pending comment".to_string(),
            created_at: "2026-07-01T00:01:00Z".to_string(),
        }]);
        update_work_item_partial("remote-project", "REM-0001", &update).expect("local comment");
        assert!(pending_org_rows() >= 1, "local comment should be pending");

        let applied = apply_remote(
            ORG,
            None,
            vec![CollabRemoteEntity {
                kind: KIND_WORK_ITEM.to_string(),
                payload: json!({
                    "id": "REM-0001",
                    "projectId": "proj-remote",
                    "shortId": "REM-0001",
                    "title": "Original title",
                    "status": "backlog",
                    "updatedAt": "2099-01-01T00:00:00Z",
                    "starred": true,
                    "comments": [{
                        "id": "remote-c1",
                        "author": "member-b",
                        "content": "remote comment",
                        "created_at": "2099-01-01T00:00:00Z",
                    }],
                }),
                version: 2,
                updated_by: Some("member-b".to_string()),
                deleted_at: None,
            }],
        )
        .expect("apply");
        assert_eq!(applied, 1);

        let item = read_work_item("remote-project", "REM-0001").expect("item");
        let comment_ids: Vec<&str> = item
            .frontmatter
            .comments
            .iter()
            .map(|comment| comment.id.as_str())
            .collect();
        assert!(
            comment_ids.contains(&"local-c1"),
            "pending local comment must survive the remote whole-row tail"
        );
        assert!(
            comment_ids.contains(&"remote-c1"),
            "remote list addition still lands via the id union"
        );
        assert!(
            !item.frontmatter.starred,
            "scalar tail fields are not whole-row-applied while a push is pending"
        );
        assert!(
            pending_org_rows() >= 1,
            "the pending local push must not be consumed by the apply"
        );
    }

    /// Finding: one bad entity (here a `(project_id, short_id)` unique
    /// violation against an unrelated local row) must not abort the
    /// whole pulled batch.
    #[test]
    fn apply_remote_skips_bad_entity_and_applies_the_rest() {
        let _sandbox = test_env::sandbox();
        seed_collab_org();
        apply_remote(
            ORG,
            None,
            vec![CollabRemoteEntity {
                kind: KIND_PROJECT.to_string(),
                payload: json!({
                    "id": "proj-remote",
                    "slug": "remote-project",
                    "name": "Remote Project",
                    "workItemPrefix": "REM",
                    "updatedAt": "2026-07-01T00:00:00Z",
                }),
                version: 1,
                updated_by: None,
                deleted_at: None,
            }],
        )
        .expect("seed project");

        // Unrelated local row already owns short id REM-0001.
        let mut local = work_item_frontmatter("REM-0001", "Local item");
        local.id = "local-wi".to_string();
        write_work_item("remote-project", "REM-0001", &local, "").expect("local item");

        let bad_then_good = vec![
            CollabRemoteEntity {
                kind: KIND_WORK_ITEM.to_string(),
                payload: json!({
                    "id": "wi-remote-dupe",
                    "projectId": "proj-remote",
                    "shortId": "REM-0001", // collides with the local row
                    "title": "Bad",
                    "updatedAt": "2026-07-01T00:00:10Z",
                }),
                version: 1,
                updated_by: None,
                deleted_at: None,
            },
            CollabRemoteEntity {
                kind: KIND_WORK_ITEM.to_string(),
                payload: json!({
                    "id": "wi-remote-ok",
                    "projectId": "proj-remote",
                    "shortId": "REM-0002",
                    "title": "Good",
                    "updatedAt": "2026-07-01T00:00:10Z",
                }),
                version: 1,
                updated_by: None,
                deleted_at: None,
            },
        ];
        let applied =
            apply_remote(ORG, None, bad_then_good).expect("batch must not abort on one bad row");
        assert_eq!(applied, 1, "only the good entity counts as applied");

        let good = read_work_item("remote-project", "REM-0002").expect("good entity applied");
        assert_eq!(good.frontmatter.title, "Good");
        let untouched = read_work_item("remote-project", "REM-0001").expect("local row");
        assert_eq!(untouched.frontmatter.title, "Local item");
        assert_eq!(untouched.frontmatter.id, "local-wi");
    }

    /// Finding: a local lock acquire/release runs through the
    /// closure-form `update_work_item_atomic` and touches only
    /// payload-tail fields — it must still enqueue a push, and the wire
    /// snapshot must carry `executionLock` as an explicit null (never a
    /// missing key) after release.
    #[test]
    fn lock_acquire_and_release_propagate_through_the_outbox() {
        let _sandbox = test_env::sandbox();
        seed_collab_org();
        seed_project("alpha");
        write_work_item(
            "alpha",
            "AAA-0001",
            &work_item_frontmatter("AAA-0001", "T"),
            "",
        )
        .expect("write item");

        let ack_all_ok = |items: &[CollabPushItem], version: i64| {
            ack_outbox(
                items
                    .iter()
                    .map(|item| CollabAckResult {
                        entry_ids: item.entry_ids.clone(),
                        kind: item.kind.clone(),
                        entity_id: item.entity_id.clone(),
                        ok: true,
                        remote_version: Some(version),
                        error: None,
                    })
                    .collect(),
            )
            .expect("ack");
        };

        // Flush the create traffic so the asserts below isolate the lock.
        let items = drain_outbox(ORG, 50).expect("drain create");
        ack_all_ok(&items, 1);
        assert_eq!(pending_org_rows(), 0);

        acquire_execution_lock(
            "alpha",
            "AAA-0001",
            "sess-1",
            Some("coding"),
            WorkItemExecutionLockReason::ManualStart,
        )
        .expect("acquire");
        assert!(pending_org_rows() >= 1, "acquire must enqueue a push");
        let items = drain_outbox(ORG, 50).expect("drain acquire");
        let item = items
            .iter()
            .find(|item| item.kind == KIND_WORK_ITEM)
            .expect("work item push");
        let payload = item.payload.as_ref().expect("payload");
        assert_eq!(payload["executionLock"]["activeSessionId"], "sess-1");
        ack_all_ok(&items, 2);
        assert_eq!(pending_org_rows(), 0);

        release_execution_lock("alpha", "AAA-0001", "sess-1").expect("release");
        assert!(pending_org_rows() >= 1, "release must enqueue a push");
        let items = drain_outbox(ORG, 50).expect("drain release");
        let item = items
            .iter()
            .find(|item| item.kind == KIND_WORK_ITEM)
            .expect("work item push");
        let payload = item.payload.as_ref().expect("payload");
        assert_eq!(
            payload.get("executionLock"),
            Some(&Value::Null),
            "released lock rides the wire as an explicit null, never a missing key"
        );
    }

    /// Finding: the pull side must APPLY an explicitly-null
    /// `executionLock` (teammate released) rather than ignore it.
    #[test]
    fn apply_remote_explicit_null_execution_lock_clears_local_lock() {
        let _sandbox = test_env::sandbox();
        seed_collab_org();
        seed_remote_project_and_item(json!({
            "executionLock": {
                "activeSessionId": "sess-remote",
                "lockedByMemberId": "member-b",
            },
        }));

        let item = read_work_item("remote-project", "REM-0001").expect("item");
        assert_eq!(
            item.frontmatter
                .execution_lock
                .as_ref()
                .and_then(|lock| lock.active_session_id.as_deref()),
            Some("sess-remote"),
            "remote lock landed locally"
        );

        let applied = apply_remote(
            ORG,
            None,
            vec![CollabRemoteEntity {
                kind: KIND_WORK_ITEM.to_string(),
                payload: json!({
                    "id": "REM-0001",
                    "projectId": "proj-remote",
                    "shortId": "REM-0001",
                    "title": "Original title",
                    "status": "backlog",
                    "updatedAt": "2026-07-01T00:05:00Z",
                    "executionLock": null,
                }),
                version: 2,
                updated_by: Some("member-b".to_string()),
                deleted_at: None,
            }],
        )
        .expect("apply release");
        assert_eq!(applied, 1);

        let item = read_work_item("remote-project", "REM-0001").expect("item");
        assert!(
            item.frontmatter.execution_lock.is_none(),
            "an explicitly-null executionLock must clear the local lock"
        );
    }

    /// Finding: an EMPTY `_fieldRevisions` object (wiped / never-stamped
    /// pusher) must degrade to the whole-row clock, not to "remote
    /// touched nothing" — otherwise such a peer could never propagate a
    /// change at all.
    #[test]
    fn empty_field_revisions_map_falls_back_to_whole_row_clock() {
        let _sandbox = test_env::sandbox();
        seed_collab_org();
        seed_remote_project_and_item(json!({}));

        // Local edit stamps a "local" watermark at real now.
        let mut update = WorkItemPartialUpdate::default();
        update.status = Some("in_review".to_string());
        update_work_item_partial("remote-project", "REM-0001", &update).expect("local edit");

        let applied = apply_remote(
            ORG,
            None,
            vec![CollabRemoteEntity {
                kind: KIND_WORK_ITEM.to_string(),
                payload: json!({
                    "id": "REM-0001",
                    "projectId": "proj-remote",
                    "shortId": "REM-0001",
                    "title": "Teammate new title",
                    "status": "backlog",
                    "updatedAt": "2099-01-01T00:00:00Z",
                    "_fieldRevisions": {},
                }),
                version: 2,
                updated_by: Some("member-b".to_string()),
                deleted_at: None,
            }],
        )
        .expect("apply");
        assert_eq!(applied, 1);

        let item = read_work_item("remote-project", "REM-0001").expect("item");
        assert_eq!(
            item.frontmatter.title, "Teammate new title",
            "with the whole-row fallback the newer remote row must win"
        );
        assert_eq!(
            item.frontmatter.status, "backlog",
            "pre-fix whole-row semantics: every field follows the row clock"
        );
    }

    /// Seed a remote-owned project (version 1, mtime
    /// 2026-07-01T00:00:00Z) via `apply_remote`, so no local outbox
    /// rows exist afterwards.
    fn seed_remote_project() {
        apply_remote(
            ORG,
            None,
            vec![CollabRemoteEntity {
                kind: KIND_PROJECT.to_string(),
                payload: json!({
                    "id": "proj-remote",
                    "slug": "remote-project",
                    "name": "Remote Project",
                    "status": "active",
                    "priority": "none",
                    "health": "on_track",
                    "workItemPrefix": "REM",
                    "description": "original description",
                    "updatedAt": "2026-07-01T00:00:00Z",
                }),
                version: 1,
                updated_by: None,
                deleted_at: None,
            }],
        )
        .expect("seed remote project");
        assert_eq!(pending_org_rows(), 0, "seeding must not echo");
    }

    /// Locally edit one field of `remote-project` through the normal
    /// local write path (stamps a `("local", now)` watermark and
    /// enqueues a bridge push).
    fn edit_remote_project_locally(mutate: impl FnOnce(&mut ProjectMeta)) {
        let mut data = read_project("remote-project").expect("read project");
        // Keep the stored prefix explicit so the write path doesn't
        // re-derive it from the name (reads surface custom=false).
        data.meta.work_item_prefix_custom = true;
        mutate(&mut data.meta);
        write_project("remote-project", &data.meta, &data.description, false)
            .expect("local project edit");
    }

    /// Project parity with the work-item field-merge fix: a peer sends
    /// a WHOLE-ROW project snapshot with `_fieldRevisions` naming only
    /// the field it changed. A locally-edited field the remote did NOT
    /// touch must survive even though the remote's whole-row
    /// `updatedAt` is newer than the local edit — the exact case the
    /// old whole-row-clock project merge got wrong (including after
    /// the local edit was already pushed and acked).
    #[test]
    fn apply_remote_whole_row_project_snapshot_preserves_untouched_local_field() {
        let _sandbox = test_env::sandbox();
        seed_collab_org();
        seed_remote_project();

        // Local changes STATUS; its watermark is stamped at real now.
        edit_remote_project_locally(|meta| meta.status = "paused".to_string());
        assert!(pending_org_rows() >= 1, "local edit should be pending");

        // Teammate pushes a WHOLE-ROW snapshot (v2): they renamed the
        // project. `updatedAt` and name's mtime are far in the future
        // (newer than the local status edit), and `status` carries a
        // STALE value the teammate never touched — status is
        // deliberately ABSENT from `_fieldRevisions`.
        let future_ms: i64 = 4_070_908_800_000; // 2099-01-01
        let applied = apply_remote(
            ORG,
            None,
            vec![CollabRemoteEntity {
                kind: KIND_PROJECT.to_string(),
                payload: json!({
                    "id": "proj-remote",
                    "slug": "remote-project",
                    "name": "Teammate rename",
                    "status": "active",
                    "workItemPrefix": "REM",
                    "updatedAt": "2099-01-01T00:00:00Z",
                    "_fieldRevisions": { "name": future_ms },
                }),
                version: 2,
                updated_by: Some("member-b".to_string()),
                deleted_at: None,
            }],
        )
        .expect("apply merge");
        assert_eq!(applied, 1);

        let project = read_project("remote-project").expect("project");
        assert_eq!(
            project.meta.status, "paused",
            "a project field the remote did not touch must not be reverted by its whole-row snapshot"
        );
        assert_eq!(
            project.meta.name, "Teammate rename",
            "the field the remote genuinely changed is adopted"
        );
        assert!(
            pending_org_rows() >= 1,
            "the pending local push must not be consumed by the apply"
        );
    }

    /// Same-field latest-wins still holds under per-field project
    /// mtimes: an OLDER remote watermark for a locally-edited field
    /// keeps local, a NEWER one adopts remote.
    #[test]
    fn apply_remote_project_same_field_resolves_by_per_field_mtime() {
        let _sandbox = test_env::sandbox();
        seed_collab_org();
        seed_remote_project();

        // Local rename stamps `name` at real now.
        edit_remote_project_locally(|meta| meta.name = "Local rename".to_string());

        // v2: teammate's name mtime is OLDER than the local edit → keep local.
        let applied = apply_remote(
            ORG,
            None,
            vec![CollabRemoteEntity {
                kind: KIND_PROJECT.to_string(),
                payload: json!({
                    "id": "proj-remote",
                    "slug": "remote-project",
                    "name": "Stale teammate rename",
                    "workItemPrefix": "REM",
                    "updatedAt": "2026-07-01T00:00:30Z",
                    "_fieldRevisions": { "name": 1_000_000_000_000_i64 }, // 2001
                }),
                version: 2,
                updated_by: Some("member-b".to_string()),
                deleted_at: None,
            }],
        )
        .expect("apply stale");
        assert_eq!(applied, 1);
        let project = read_project("remote-project").expect("project");
        assert_eq!(
            project.meta.name, "Local rename",
            "an older remote watermark must not beat the newer local edit"
        );

        // v3: teammate edits the SAME field with a NEWER mtime → adopt remote.
        let future_ms: i64 = 4_070_908_800_000; // 2099-01-01
        let applied = apply_remote(
            ORG,
            None,
            vec![CollabRemoteEntity {
                kind: KIND_PROJECT.to_string(),
                payload: json!({
                    "id": "proj-remote",
                    "slug": "remote-project",
                    "name": "Future teammate rename",
                    "workItemPrefix": "REM",
                    "updatedAt": "2099-01-01T00:00:00Z",
                    "_fieldRevisions": { "name": future_ms },
                }),
                version: 3,
                updated_by: Some("member-b".to_string()),
                deleted_at: None,
            }],
        )
        .expect("apply newer");
        assert_eq!(applied, 1);
        let project = read_project("remote-project").expect("project");
        assert_eq!(
            project.meta.name, "Future teammate rename",
            "same-field latest-wins: the newer remote edit is adopted"
        );
    }

    /// An EMPTY `_fieldRevisions` object on a project row (wiped /
    /// never-stamped pusher) must degrade to the pre-fix whole-row
    /// clock, not to "remote touched nothing" — otherwise such a peer
    /// could never propagate a project change at all.
    #[test]
    fn empty_project_field_revisions_falls_back_to_whole_row() {
        let _sandbox = test_env::sandbox();
        seed_collab_org();
        seed_remote_project();

        // Local edit stamps a "local" watermark at real now.
        edit_remote_project_locally(|meta| meta.status = "paused".to_string());

        let applied = apply_remote(
            ORG,
            None,
            vec![CollabRemoteEntity {
                kind: KIND_PROJECT.to_string(),
                payload: json!({
                    "id": "proj-remote",
                    "slug": "remote-project",
                    "name": "Teammate rename",
                    "status": "active",
                    "workItemPrefix": "REM",
                    "updatedAt": "2099-01-01T00:00:00Z",
                    "_fieldRevisions": {},
                }),
                version: 2,
                updated_by: Some("member-b".to_string()),
                deleted_at: None,
            }],
        )
        .expect("apply");
        assert_eq!(applied, 1);

        let project = read_project("remote-project").expect("project");
        assert_eq!(
            project.meta.name, "Teammate rename",
            "with the whole-row fallback the newer remote row must win"
        );
        assert_eq!(
            project.meta.status, "active",
            "pre-fix whole-row semantics: every field follows the row clock"
        );
    }

    /// Wire-builder side of the project parity fix: a drained project
    /// push carries `_fieldRevisions` naming exactly the locally-edited
    /// fields (untouched fields stay absent so peers keep their local
    /// values).
    #[test]
    fn drain_project_carries_per_field_revisions() {
        let _sandbox = test_env::sandbox();
        seed_collab_org();
        seed_project("alpha");

        let mut data = read_project("alpha").expect("read project");
        data.meta.work_item_prefix_custom = true;
        data.meta.priority = "high".to_string();
        write_project("alpha", &data.meta, &data.description, false).expect("local edit");

        let items = drain_outbox(ORG, 50).expect("drain");
        let project = items
            .iter()
            .find(|item| item.kind == KIND_PROJECT)
            .expect("project push");
        let payload = project.payload.as_ref().expect("payload");
        let revisions = payload["_fieldRevisions"]
            .as_object()
            .expect("_fieldRevisions map");
        assert!(
            revisions.get("priority").and_then(Value::as_i64).is_some(),
            "the locally-edited field must carry its watermark: {:?}",
            revisions
        );
        assert!(
            !revisions.contains_key("name"),
            "untouched fields must stay absent from the wire map: {:?}",
            revisions
        );
    }

    #[test]
    fn apply_remote_tombstone_soft_deletes() {
        let _sandbox = test_env::sandbox();
        seed_collab_org();
        seed_project("alpha");
        write_work_item(
            "alpha",
            "AAA-0001",
            &work_item_frontmatter("AAA-0001", "T"),
            "",
        )
        .expect("write item");
        // Simulate a prior sync so the tombstone version is newer.
        {
            let conn = io::conn().expect("conn");
            store_remote_version(&conn, KIND_WORK_ITEM, "AAA-0001", 1).expect("stamp");
        }

        let applied = apply_remote(
            ORG,
            None,
            vec![CollabRemoteEntity {
                kind: KIND_WORK_ITEM.to_string(),
                payload: json!({ "id": "AAA-0001" }),
                version: 2,
                updated_by: None,
                deleted_at: Some("2026-07-01T01:00:00Z".to_string()),
            }],
        )
        .expect("apply tombstone");
        assert_eq!(applied, 1);

        let item = read_work_item("alpha", "AAA-0001").expect("item");
        assert!(
            item.frontmatter.deleted_at.is_some(),
            "soft-deleted locally"
        );
    }
}

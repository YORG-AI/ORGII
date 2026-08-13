//! Outbound path (local -> remote): collab-org gates, local-mutation
//! hooks that enqueue bridge outbox rows, the drain that coalesces +
//! hydrates them into wire-shaped push items, and the ack that records
//! server versions / requeues conflicts. Also hosts the shared
//! `store_remote_version` version-bookkeeping helper.

use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::wire::{now_ms, to_iso8601};
use super::{COLLAB_SYNC_PROVIDER, KIND_PROJECT, KIND_WORK_ITEM, OP_DELETE, OP_UPSERT};
use crate::projects::io::{
    read_project_field_revisions, read_sync_metadata, read_work_item_by_row_id,
};
use crate::projects::types::WorkItemFrontmatter;
use crate::sync::io;
use crate::sync::types::{EntityType, OutboxOp, OutboxStatus};

/// In-flight rows older than this are considered orphaned by a dead TS
/// session and are demoted back to pending at the next drain.
const STALE_IN_FLIGHT_MS: i64 = 5 * 60 * 1000;

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

/// Transaction-aware payload-tail hook used by Work Item feature services.
/// The feature mutation and its collaboration outbox row commit together.
/// `project_slug` is absent for an org-scoped standalone Work Item.
pub(crate) fn record_work_item_payload_touch_in_connection(
    conn: &Connection,
    org_id: &str,
    project_slug: Option<&str>,
    work_item_id: &str,
    field_path: &str,
) -> Result<(), String> {
    if !is_collab_org(conn, org_id)? {
        return Ok(());
    }
    append_collab_row(
        conn,
        org_id,
        project_slug.unwrap_or(""),
        EntityType::WorkItem,
        work_item_id,
        OutboxOp::Update,
        Some(field_path),
    )
}

/// Enqueue one existing org entity as the carrier for org-wide typed-property
/// definitions. Project rows are preferred; an org-scoped standalone Work
/// Item is the fallback. If the org has no entity yet, the first future entity
/// write will carry the definitions in its full snapshot.
pub(crate) fn record_property_definitions_touch(
    conn: &Connection,
    org_id: &str,
    property_id: &str,
) -> Result<(), String> {
    if !is_collab_org(conn, org_id)? {
        return Ok(());
    }
    let project_anchor: Option<(EntityType, String, String)> = conn
        .query_row(
            "SELECT 'project', id, slug
               FROM projects
              WHERE org_id = ?1
              ORDER BY updated_at DESC, id ASC
              LIMIT 1",
            params![org_id],
            |row| {
                Ok((
                    EntityType::Project,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|err| format!("DB error (property definition project anchor): {err}"))?;
    let anchor = match project_anchor {
        Some(anchor) => Some(anchor),
        None => conn
            .query_row(
                "SELECT 'work_item', id, ''
                   FROM workitems
                  WHERE org_id = ?1 AND project_id IS NULL AND deleted_at IS NULL
                  ORDER BY updated_at DESC, id ASC
                  LIMIT 1",
                params![org_id],
                |row| {
                    Ok((
                        EntityType::WorkItem,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(|err| format!("DB error (property definition Work Item anchor): {err}"))?,
    };
    let Some((entity_type, entity_id, project_slug)) = anchor else {
        return Ok(());
    };
    append_collab_row(
        conn,
        org_id,
        &project_slug,
        entity_type,
        &entity_id,
        OutboxOp::Update,
        Some(&format!("propertyDefinitions.{property_id}")),
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

/// Enqueue the replication handoff for an atomic project organization move.
///
/// The source organization receives a project tombstone (the server cascades
/// it to child work items), while the destination receives fresh project and
/// work-item snapshots. This accepts the caller's transaction connection so
/// the ownership change and its outbox intent commit or roll back together.
pub(crate) fn record_project_org_move_in_connection(
    conn: &Connection,
    source_org_id: &str,
    destination_org_id: &str,
    project_id: &str,
    project_slug: &str,
    work_item_ids: &[String],
) -> Result<(), String> {
    if is_collab_org(conn, source_org_id)? {
        append_collab_row(
            conn,
            source_org_id,
            project_slug,
            EntityType::Project,
            project_id,
            OutboxOp::Delete,
            None,
        )?;
    }

    if !is_collab_org(conn, destination_org_id)? {
        return Ok(());
    }

    append_collab_row(
        conn,
        destination_org_id,
        project_slug,
        EntityType::Project,
        project_id,
        OutboxOp::Update,
        None,
    )?;
    for work_item_id in work_item_ids {
        append_collab_row(
            conn,
            destination_org_id,
            project_slug,
            EntityType::WorkItem,
            work_item_id,
            OutboxOp::Update,
            None,
        )?;
    }
    Ok(())
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

    if order.is_empty() {
        return Ok(Vec::new());
    }

    // Org-wide definitions are shared by every entity snapshot. Load them
    // once per non-empty bounded drain instead of once per Work Item.
    let property_definitions =
        crate::work_item_features::properties::export_definitions(&conn, org_id)?;

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
            "project" => hydrate_project(
                &conn,
                org_id,
                &entity_id,
                entry_ids,
                field_paths,
                &property_definitions,
            )?,
            "work_item" => hydrate_work_item(
                &conn,
                org_id,
                &entity_id,
                entry_ids,
                field_paths,
                &property_definitions,
            )?,
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
    property_definitions: &[crate::work_item_features::PropertyDefinition],
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
        "propertyDefinitions": property_definitions,
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
    property_definitions: &[crate::work_item_features::PropertyDefinition],
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
            let project_slug: Option<String> = conn
                .query_row(
                    "SELECT p.slug FROM workitems w
                       JOIN projects p ON w.project_id = p.id
                      WHERE w.id = ?1 AND w.org_id = ?2",
                    params![work_item_id, org_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|err| format!("DB error (work item slug): {err}"))?;
            // Project-scoped definitions ride on project rows, which the
            // puller applies first. Standalone items have no project carrier,
            // so their full snapshot includes the org definitions.
            let definitions = if project_slug.is_none() {
                property_definitions.to_vec()
            } else {
                Vec::new()
            };
            let property_snapshot =
                crate::work_item_features::properties::export_work_item_snapshot(
                    conn,
                    org_id,
                    work_item_id,
                    definitions,
                )?;
            // Per-field revision times ride the wire so the puller can merge
            // per field instead of against our whole-row updatedAt (which
            // would revert a teammate's edit to any field we didn't change).
            // Only project-scoped items carry them; standalone items use
            // whole-row semantics on both ends.
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
                    &property_snapshot,
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
    property_snapshot: &crate::work_item_features::TypedPropertyWireSnapshot,
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
        "originSession": to_value(&frontmatter.origin_session),
        "createdAt": frontmatter.created_at,
        "updatedAt": frontmatter.updated_at,
        "todos": to_value(&frontmatter.todos),
        "comments": to_value(&frontmatter.comments),
        "history": to_value(&frontmatter.history),
        "handoff": to_value(&frontmatter.handoff),
        "linkedSessions": to_value(&frontmatter.linked_sessions),
        "proofOfWork": to_value(&frontmatter.proof_of_work),
        "orchestratorConfig": to_value(&frontmatter.orchestrator_config),
        "orchestratorState": to_value(&frontmatter.orchestrator_state),
        "schedule": to_value(&frontmatter.schedule),
        "executionLock": to_value(&frontmatter.execution_lock),
        "closeOut": to_value(&frontmatter.close_out),
        "workProducts": to_value(&frontmatter.work_products),
        "propertyDefinitions": to_value(&property_snapshot.definitions),
        "propertyValues": to_value(&property_snapshot.values),
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

pub(super) fn store_remote_version(
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

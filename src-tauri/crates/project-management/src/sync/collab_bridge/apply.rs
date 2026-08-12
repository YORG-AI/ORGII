//! Inbound path (remote -> local): apply pulled server rows into SQLite.
//! Projects apply before work items; each entity applies in isolation
//! and no apply path emits outbox rows (no echo). Live rows merge per
//! field through the `FieldRevision` resolver, tombstones soft-delete.

use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::outbox::store_remote_version;
use super::wire::{iso_to_ms, now_ms, string_field};
use super::{COLLAB_ORG_SOURCE, COLLAB_SYNC_PROVIDER, KIND_PROJECT, KIND_WORK_ITEM};
use crate::projects::io::{
    apply_remote_merge, create_project_org, read_project_field_revisions, read_project_org,
    read_project_scoped, read_standalone_sync_metadata, read_sync_metadata,
    read_work_item_by_row_id, update_standalone_work_item_partial_with_revisions,
    update_work_item_partial_with_revisions, write_project_remote, write_work_item_remote,
    FieldRevision, PROJECT_SYNC_FIELDS,
};
use crate::projects::types::work_items::{default_priority, default_status};
use crate::projects::types::{
    CommentEntry, CreateProjectOrgRequest, LinkedSession, ProjectMeta, TodoEntry,
    WorkItemFrontmatter, WorkItemPartialUpdate, WorkItemWorkProduct,
};
use crate::sync::adapter::{EntityField, FieldMap, FieldMapping};
use crate::sync::conflict;
use crate::sync::io;
use crate::sync::types::{EntityType, OutboxStatus};

/// `FieldRevision.source` stamped on remote-adopted fields.
const COLLAB_REVISION_SOURCE: &str = "orgii_collab";

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
    crate::work_item_features::properties::apply_wire_definitions(&conn, org_id, &entity.payload)?;
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
        stage: payload
            .get("stage")
            .and_then(|value| value.as_u64())
            .map(|value| value as u32),
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
        handoff: tail_opt(payload, "handoff"),
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
        crate::projects::events::notify_work_item_schedule_changed();
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
                let change = crate::sync::adapter::ExternalChange {
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
                    |_| crate::sync::adapter::ConflictResolution::UseRemote,
                );

                let adopted: serde_json::Map<String, Value> =
                    decision.adopted_fields.clone().into_iter().collect();
                let mut update = crate::sync::worker::partial_update_from_map(&adopted);
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
            } else {
                // Standalone (or a standalone row moving into a project):
                // use the same per-field resolver as project-scoped items.
                // Crucially, record the pulled remote version even while a
                // local push is pending. The outbox retry then rebases onto
                // that version instead of conflicting forever.
                let metadata =
                    read_standalone_sync_metadata(org_id, &work_item_id)?.unwrap_or_default();
                let remote_field_mtimes = parse_wire_field_mtimes(&entity.payload);
                let change = crate::sync::adapter::ExternalChange {
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
                    |_| crate::sync::adapter::ConflictResolution::UseRemote,
                );
                let adopted: serde_json::Map<String, Value> =
                    decision.adopted_fields.clone().into_iter().collect();
                let mut update = crate::sync::worker::partial_update_from_map(&adopted);
                if !has_pending {
                    apply_wire_tail(&mut update, &entity.payload);
                } else if let Some(local) = read_work_item_by_row_id(org_id, &work_item_id)? {
                    apply_wire_tail_union(&mut update, &entity.payload, &local.frontmatter);
                }
                if wire_project_id != local_project_id {
                    update.project = Some(wire_project_id.clone());
                }
                drop(conn);
                update_standalone_work_item_partial_with_revisions(
                    org_id,
                    &short_id,
                    decision.new_revisions,
                    &update,
                )?;
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
        }
    }
    let conn = io::conn()?;
    crate::work_item_features::properties::apply_work_item_wire_snapshot(
        &conn,
        org_id,
        &work_item_id,
        &entity.payload,
    )?;
    store_remote_version(&conn, KIND_WORK_ITEM, &work_item_id, entity.version)?;
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
    if payload.get("handoff").is_some() {
        update.handoff = Some(tail(payload, "handoff"));
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

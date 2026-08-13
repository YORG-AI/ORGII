//! Single-row CRUD entry points against `projects.db`.
//!
//! Frontmatter ↔ row mapping helpers live in `super::mapping`; this
//! module is intentionally limited to the public CRUD surface plus the
//! two strictly CRUD-flavored helpers (`resolve_project_id` and
//! `max_existing_work_item_number`).

use std::collections::HashMap;

use rusqlite::{params, OptionalExtension};

use super::super::helpers::{conn, from_iso8601, map_db, now_ms, to_iso8601};
use super::extras::{ExtrasPayload, FieldRevision, REVISION_SOURCE_LOCAL};
use super::history::{append_deleted_event, append_restored_event, ensure_created_event};
use super::mapping::{
    assemble_work_item, parse_extras_json, read_extras_for, read_labels_for, row_to_core,
    ConnectionLike, WorkItemCore,
};
use crate::projects::types::{
    ScheduledWorkItemCandidate, WorkItemData, WorkItemFrontmatter, WorkItemReadBucket,
};

const WORK_ITEM_PREFIX_LENGTH: usize = 3;

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

/// Read every work item under a project, ordered by `updated_at` desc to
/// match the legacy file-layer behavior.
pub fn read_all_work_items(project_slug: &str) -> Result<Vec<WorkItemData>, String> {
    read_all_work_items_scoped(project_slug, None)
}

/// Read only work items that can affect the one-shot/start-date scheduler.
///
/// The filter and projection stay in SQLite so the executor does not perform
/// the old projects × work-items N+1 read or materialize bodies, labels,
/// comments, history, and other unrelated payloads on each idle pass.
pub fn read_scheduled_work_item_candidates() -> Result<Vec<ScheduledWorkItemCandidate>, String> {
    let connection = conn()?;
    let mut stmt = map_db(connection.prepare(
        "SELECT p.slug, w.short_id, w.title, w.status, w.start_date, e.extras_json
         FROM workitems w
         JOIN projects p ON p.id = w.project_id
         LEFT JOIN workitem_extras e ON e.work_item_id = w.id
         WHERE w.deleted_at IS NULL
           AND (
             (
               w.status IN ('backlog', 'planned', 'todo')
               AND w.start_date IS NOT NULL
               AND TRIM(w.start_date) <> ''
             )
             OR (
               CASE
                 WHEN json_valid(e.extras_json)
                 THEN json_extract(e.extras_json, '$.schedule.enabled')
                 ELSE 0
               END = 1
               AND CASE
                 WHEN json_valid(e.extras_json)
                 THEN json_extract(e.extras_json, '$.schedule.at')
                 ELSE NULL
               END IS NOT NULL
             )
           )
         ORDER BY p.slug, w.short_id",
    ))?;
    let rows = map_db(stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, Option<String>>(5)?,
        ))
    }))?;

    let mut candidates = Vec::new();
    for row in rows {
        let (project_slug, short_id, title, status, start_date, extras_json) = map_db(row)?;
        let extras = match extras_json.as_deref() {
            Some(json) => match serde_json::from_str::<ExtrasPayload>(json) {
                Ok(extras) => extras,
                Err(err) => {
                    tracing::warn!(
                        work_item = %short_id,
                        error = %err,
                        raw_len = json.len(),
                        "work_items::crud: skipping malformed scheduler extras"
                    );
                    ExtrasPayload::default()
                }
            },
            None => ExtrasPayload::default(),
        };
        candidates.push(ScheduledWorkItemCandidate {
            project_slug,
            short_id,
            title,
            status,
            start_date,
            orchestrator_config: extras.orchestrator_config,
            schedule: extras.schedule,
        });
    }
    Ok(candidates)
}

pub fn read_all_work_items_scoped(
    project_slug: &str,
    org_id: Option<&str>,
) -> Result<Vec<WorkItemData>, String> {
    read_all_work_items_scoped_filtered(project_slug, org_id, None)
}

pub fn read_all_work_items_scoped_filtered(
    project_slug: &str,
    org_id: Option<&str>,
    read_bucket: Option<WorkItemReadBucket>,
) -> Result<Vec<WorkItemData>, String> {
    let connection = conn()?;
    let project_id = resolve_project_id_scoped(&connection, project_slug, org_id)?;

    let rows = read_work_item_rows_with_extras(
        &connection,
        "WHERE w.project_id = ?1",
        params![&project_id],
    )?;
    let mut labels_by_work_item = read_project_labels(&connection, &project_id)?;
    let mut out = Vec::new();
    for (core, extras_json, _) in rows {
        if read_bucket
            .map(|bucket| !bucket.matches(&core.status))
            .unwrap_or(false)
        {
            continue;
        }
        let work_item_id = core.work_item_id.clone();
        let labels = labels_by_work_item
            .remove(&work_item_id)
            .unwrap_or_default();
        let extras = parse_extras_json(&work_item_id, extras_json.as_deref());
        out.push(assemble_work_item(core, labels, extras));
    }
    Ok(out)
}

/// Read one work item by short ID within the given project.
pub fn read_work_item(project_slug: &str, short_id: &str) -> Result<WorkItemData, String> {
    read_work_item_scoped(project_slug, short_id, None)
}

pub fn read_work_item_scoped(
    project_slug: &str,
    short_id: &str,
    org_id: Option<&str>,
) -> Result<WorkItemData, String> {
    let connection = conn()?;
    let project_id = resolve_project_id_scoped(&connection, project_slug, org_id)?;

    let core = map_db(
        connection
            .query_row(
                "SELECT id, project_id, short_id, title, body, status, priority, assignee, assignee_type,
                        milestone, parent, start_date, target_date, created_at, updated_at, deleted_at
                 FROM workitems
                 WHERE project_id = ?1 AND short_id = ?2",
                params![&project_id, short_id],
                row_to_core,
            )
            .optional(),
    )?
    .ok_or_else(|| format!("Work item '{}' not found", short_id))?;

    let labels = read_labels_for(&connection, &core.work_item_id)?;
    let extras = read_extras_for(&connection, &core.work_item_id)?;
    Ok(assemble_work_item(core, labels, extras))
}

pub fn read_standalone_work_items(org_id: Option<&str>) -> Result<Vec<WorkItemData>, String> {
    read_standalone_work_items_filtered(org_id, None)
}

pub fn read_standalone_work_items_filtered(
    org_id: Option<&str>,
    read_bucket: Option<WorkItemReadBucket>,
) -> Result<Vec<WorkItemData>, String> {
    let connection = conn()?;
    let org_id = org_id.unwrap_or("personal-org");
    let rows = read_work_item_rows_with_extras(
        &connection,
        "WHERE w.org_id = ?1 AND w.project_id IS NULL",
        params![org_id],
    )?;
    let mut labels_by_work_item = read_standalone_labels(&connection, org_id)?;
    let mut out = Vec::new();
    for (core, extras_json, _) in rows {
        if read_bucket
            .map(|bucket| !bucket.matches(&core.status))
            .unwrap_or(false)
        {
            continue;
        }
        let work_item_id = core.work_item_id.clone();
        let labels = labels_by_work_item
            .remove(&work_item_id)
            .unwrap_or_default();
        let extras = parse_extras_json(&work_item_id, extras_json.as_deref());
        out.push(assemble_work_item(core, labels, extras));
    }
    Ok(out)
}

pub(super) fn read_all_standalone_work_items_filtered(
    read_bucket: Option<WorkItemReadBucket>,
) -> Result<Vec<(String, WorkItemData)>, String> {
    let connection = conn()?;
    let rows =
        read_work_item_rows_with_extras(&connection, "WHERE w.project_id IS NULL", params![])?;
    let mut labels_by_work_item =
        read_label_map(&connection, "WHERE w.project_id IS NULL", params![])?;
    let mut out = Vec::new();
    for (core, extras_json, org_id) in rows {
        if read_bucket
            .map(|bucket| !bucket.matches(&core.status))
            .unwrap_or(false)
        {
            continue;
        }
        let work_item_id = core.work_item_id.clone();
        let labels = labels_by_work_item
            .remove(&work_item_id)
            .unwrap_or_default();
        let extras = parse_extras_json(&work_item_id, extras_json.as_deref());
        out.push((org_id, assemble_work_item(core, labels, extras)));
    }
    Ok(out)
}

fn read_work_item_rows_with_extras<P>(
    connection: &rusqlite::Connection,
    where_clause: &str,
    query_params: P,
) -> Result<Vec<(WorkItemCore, Option<String>, String)>, String>
where
    P: rusqlite::Params,
{
    let sql = format!(
        "SELECT w.id, w.project_id, w.short_id, w.title, w.body, w.status, w.priority,
                w.assignee, w.assignee_type, w.milestone, w.parent, w.start_date,
                w.target_date, w.created_at, w.updated_at, w.deleted_at, e.extras_json,
                w.org_id
         FROM workitems w
         LEFT JOIN workitem_extras e ON e.work_item_id = w.id
         {where_clause}
         ORDER BY COALESCE(w.deleted_at, w.updated_at) DESC, w.created_at DESC"
    );
    let mut stmt = map_db(connection.prepare(&sql))?;
    let rows = map_db(stmt.query_map(query_params, |row| {
        Ok((
            row_to_core(row)?,
            row.get::<_, Option<String>>(16)?,
            row.get::<_, String>(17)?,
        ))
    }))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(map_db(row)?);
    }
    Ok(out)
}

fn read_project_labels(
    connection: &rusqlite::Connection,
    project_id: &str,
) -> Result<HashMap<String, Vec<String>>, String> {
    read_label_map(connection, "WHERE w.project_id = ?1", params![project_id])
}

fn read_standalone_labels(
    connection: &rusqlite::Connection,
    org_id: &str,
) -> Result<HashMap<String, Vec<String>>, String> {
    read_label_map(
        connection,
        "WHERE w.org_id = ?1 AND w.project_id IS NULL",
        params![org_id],
    )
}

fn read_label_map<P>(
    connection: &rusqlite::Connection,
    where_clause: &str,
    query_params: P,
) -> Result<HashMap<String, Vec<String>>, String>
where
    P: rusqlite::Params,
{
    let sql = format!(
        "SELECT wl.work_item_id, wl.label_id
         FROM workitem_labels wl
         JOIN workitems w ON w.id = wl.work_item_id
         {where_clause}
         ORDER BY wl.work_item_id, wl.label_id"
    );
    let mut stmt = map_db(connection.prepare(&sql))?;
    let rows = map_db(stmt.query_map(query_params, |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    }))?;
    let mut labels_by_work_item: HashMap<String, Vec<String>> = HashMap::new();
    for row in rows {
        let (work_item_id, label_id) = map_db(row)?;
        labels_by_work_item
            .entry(work_item_id)
            .or_default()
            .push(label_id);
    }
    Ok(labels_by_work_item)
}

pub fn read_standalone_work_item(
    org_id: Option<&str>,
    short_id: &str,
) -> Result<WorkItemData, String> {
    let connection = conn()?;
    let org_id = org_id.unwrap_or("personal-org");
    let core = map_db(
        connection
            .query_row(
                "SELECT id, project_id, short_id, title, body, status, priority, assignee, assignee_type,
                        milestone, parent, start_date, target_date, created_at, updated_at, deleted_at
                 FROM workitems
                 WHERE org_id = ?1 AND project_id IS NULL AND short_id = ?2",
                params![org_id, short_id],
                row_to_core,
            )
            .optional(),
    )?
    .ok_or_else(|| format!("Standalone work item '{}' not found", short_id))?;

    let labels = read_labels_for(&connection, &core.work_item_id)?;
    let extras = read_extras_for(&connection, &core.work_item_id)?;
    Ok(assemble_work_item(core, labels, extras))
}

/// Create or update a work item.
///
/// Hot columns are written to `workitems`, the label set fully replaces
/// `workitem_labels`, and everything else lives in `workitem_extras`. The
/// whole write happens inside one transaction so partial failures cannot
/// leave the row, label join, and extras blob out of sync.
pub fn write_work_item(
    project_slug: &str,
    short_id: &str,
    frontmatter: &WorkItemFrontmatter,
    body: &str,
) -> Result<(), String> {
    let connection = conn()?;
    let project_id = resolve_project_id(&connection, project_slug)?;
    let org_id: String = map_db(connection.query_row(
        "SELECT org_id FROM projects WHERE id = ?1",
        params![&project_id],
        |row| row.get(0),
    ))?;
    drop(connection);

    write_work_item_with_scope(Some(project_id), &org_id, short_id, frontmatter, body, true)?;
    // orgii_collab bridge (design §16.8): full writes — create, delete,
    // restore, whole-row update — enqueue one bridge row when the org is
    // collab-synced. Remote-applied writes go through
    // `write_work_item_remote` instead and never enqueue (no echo).
    crate::sync::collab_bridge::record_work_item_write(
        &org_id,
        Some(project_slug),
        &frontmatter.id,
        frontmatter.deleted_at.is_some(),
    )
}

pub fn write_standalone_work_item(
    org_id: Option<&str>,
    short_id: &str,
    frontmatter: &WorkItemFrontmatter,
    body: &str,
) -> Result<(), String> {
    let org_id = org_id.unwrap_or("personal-org");
    write_work_item_with_scope(None, org_id, short_id, frontmatter, body, true)?;
    crate::sync::collab_bridge::record_work_item_write(
        org_id,
        None,
        &frontmatter.id,
        frontmatter.deleted_at.is_some(),
    )
}

/// Silent variant used exclusively by the collab bridge's remote-apply
/// path: identical write semantics, but never emits an outbox row —
/// applying a pulled change must not echo it back to the server — and
/// never stamps `("local", now)` field revisions (the bridge stamps
/// remote-sourced watermarks itself via `apply_remote_merge`).
pub(crate) fn write_work_item_remote(
    project_id: Option<String>,
    org_id: &str,
    short_id: &str,
    frontmatter: &WorkItemFrontmatter,
    body: &str,
) -> Result<(), String> {
    write_work_item_with_scope(project_id, org_id, short_id, frontmatter, body, false)
}

/// Read one work item by its `workitems.id` primary key, scoped to an
/// org. The collab bridge's outbox rows carry the row id (stable across
/// project moves) rather than a `(project, short_id)` pair.
pub fn read_work_item_by_row_id(
    org_id: &str,
    work_item_id: &str,
) -> Result<Option<WorkItemData>, String> {
    let connection = conn()?;
    let core = map_db(
        connection
            .query_row(
                "SELECT id, project_id, short_id, title, body, status, priority, assignee, assignee_type,
                        milestone, parent, start_date, target_date, created_at, updated_at, deleted_at
                 FROM workitems
                 WHERE id = ?1 AND org_id = ?2",
                params![work_item_id, org_id],
                row_to_core,
            )
            .optional(),
    )?;
    let Some(core) = core else {
        return Ok(None);
    };
    let labels = read_labels_for(&connection, &core.work_item_id)?;
    let extras = read_extras_for(&connection, &core.work_item_id)?;
    Ok(Some(assemble_work_item(core, labels, extras)))
}

fn write_work_item_with_scope(
    project_id: Option<String>,
    org_id: &str,
    short_id: &str,
    frontmatter: &WorkItemFrontmatter,
    body: &str,
    stamp_local_revisions: bool,
) -> Result<(), String> {
    let mut connection = conn()?;
    let tx = map_db(connection.transaction())?;
    write_work_item_in_tx(
        &tx,
        project_id,
        org_id,
        short_id,
        frontmatter,
        body,
        stamp_local_revisions,
    )?;
    map_db(tx.commit())?;
    crate::projects::events::notify_work_item_schedule_changed();
    Ok(())
}

pub(crate) fn write_work_item_in_tx(
    tx: &rusqlite::Transaction,
    project_id: Option<String>,
    org_id: &str,
    short_id: &str,
    frontmatter: &WorkItemFrontmatter,
    body: &str,
    stamp_local_revisions: bool,
) -> Result<(), String> {
    let now = now_ms();
    let mut next_frontmatter = frontmatter.clone();
    next_frontmatter.project = project_id.clone();
    let created_at = if next_frontmatter.created_at.is_empty() {
        now
    } else {
        from_iso8601(&next_frontmatter.created_at)
    };
    let updated_at = if next_frontmatter.updated_at.is_empty() {
        now
    } else {
        from_iso8601(&next_frontmatter.updated_at)
    };
    let deleted_at = next_frontmatter.deleted_at.as_deref().map(from_iso8601);
    let existing_item: Option<PriorSyncSnapshot> = map_db(
        tx.query_row(
            "SELECT id, title, body, status, priority, assignee, milestone,
                    start_date, target_date
             FROM workitems WHERE id = ?1",
            params![&next_frontmatter.id],
            |row| {
                Ok(PriorSyncSnapshot {
                    title: row.get(1)?,
                    body: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    status: row.get(3)?,
                    priority: row.get(4)?,
                    assignee: row.get(5)?,
                    milestone: row.get(6)?,
                    start_date: row.get(7)?,
                    target_date: row.get(8)?,
                    labels: Vec::new(),
                })
            },
        )
        .optional(),
    )?;
    let existing_item = match existing_item {
        Some(mut prior) => {
            let mut stmt =
                map_db(tx.prepare("SELECT label_id FROM workitem_labels WHERE work_item_id = ?1"))?;
            let rows = map_db(
                stmt.query_map(params![&next_frontmatter.id], |row| row.get::<_, String>(0)),
            )?;
            for entry in rows {
                prior.labels.push(map_db(entry)?);
            }
            Some(prior)
        }
        None => None,
    };
    if existing_item.is_none() {
        ensure_created_event(&mut next_frontmatter, &to_iso8601(created_at));
    }

    // Whole-row writes rebuild extras from the frontmatter, which does
    // not carry the sync-side metadata (`field_revisions` /
    // `external_refs`). Layer the pre-write watermarks back on top —
    // mirroring the atomic RMW path — so delete / restore / batch /
    // git-folder-sync rewrites can't silently wipe them. Local-driven
    // writes additionally stamp every sync-tracked field that actually
    // changed at `("local", now)` so whole-row edits propagate through
    // the per-field resolver on peers.
    let prior_extras: Option<ExtrasPayload> = if existing_item.is_some() {
        let raw: Option<String> = map_db(
            tx.query_row(
                "SELECT extras_json FROM workitem_extras WHERE work_item_id = ?1",
                params![&next_frontmatter.id],
                |row| row.get(0),
            )
            .optional(),
        )?;
        match raw.as_deref() {
            Some(json) => match serde_json::from_str::<ExtrasPayload>(json) {
                Ok(v) => Some(v),
                Err(err) => {
                    tracing::warn!(
                        work_item_id = %next_frontmatter.id,
                        error = %err,
                        raw_len = json.len(),
                        "work_items::crud: extras_json parse failed; whole-row write will OVERWRITE the corrupt row"
                    );
                    None
                }
            },
            None => None,
        }
    } else {
        None
    };

    let mut extras = ExtrasPayload::from_frontmatter(&next_frontmatter);
    if let Some(prior) = prior_extras {
        extras.field_revisions = prior.field_revisions;
        extras.external_refs = prior.external_refs;
    }
    if stamp_local_revisions {
        if let Some(prior) = existing_item.as_ref() {
            for field in prior.changed_sync_fields(&next_frontmatter, body) {
                extras.field_revisions.insert(
                    field.to_string(),
                    FieldRevision {
                        mtime: now,
                        source: REVISION_SOURCE_LOCAL.to_string(),
                    },
                );
            }
        }
    }
    let extras_json =
        serde_json::to_string(&extras).map_err(|err| format!("serialize extras: {}", err))?;

    map_db(tx.execute(
        "INSERT INTO workitems (
            id, org_id, project_id, short_id, title, body, status, priority,
            assignee, assignee_type, milestone, parent,
            start_date, target_date, created_at, updated_at, deleted_at
         ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
            ?9, ?10, ?11, ?12,
            ?13, ?14, ?15, ?16, ?17
         )
         ON CONFLICT(id) DO UPDATE SET
            org_id       = excluded.org_id,
            project_id   = excluded.project_id,
            short_id     = excluded.short_id,
            title        = excluded.title,
            body         = excluded.body,
            status       = excluded.status,
            priority     = excluded.priority,
            assignee     = excluded.assignee,
            assignee_type= excluded.assignee_type,
            milestone    = excluded.milestone,
            parent       = excluded.parent,
            start_date   = excluded.start_date,
            target_date  = excluded.target_date,
            updated_at   = excluded.updated_at,
            deleted_at   = excluded.deleted_at",
        params![
            &next_frontmatter.id,
            org_id,
            &project_id,
            short_id,
            &next_frontmatter.title,
            body,
            &next_frontmatter.status,
            &next_frontmatter.priority,
            &next_frontmatter.assignee,
            &next_frontmatter.assignee_type,
            &next_frontmatter.milestone,
            &next_frontmatter.parent,
            &next_frontmatter.start_date,
            &next_frontmatter.target_date,
            created_at,
            updated_at,
            deleted_at,
        ],
    ))?;

    map_db(tx.execute(
        "DELETE FROM workitem_labels WHERE work_item_id = ?1",
        params![&next_frontmatter.id],
    ))?;
    for label_id in &next_frontmatter.labels {
        map_db(tx.execute(
            "INSERT INTO workitem_labels (work_item_id, label_id) VALUES (?1, ?2)",
            params![&next_frontmatter.id, label_id],
        ))?;
    }

    map_db(tx.execute(
        "INSERT INTO workitem_extras (work_item_id, extras_json)
         VALUES (?1, ?2)
         ON CONFLICT(work_item_id) DO UPDATE SET extras_json = excluded.extras_json",
        params![&next_frontmatter.id, extras_json],
    ))?;

    Ok(())
}

/// Move a work item to the recoverable delete bin.
pub fn delete_work_item(project_slug: &str, short_id: &str) -> Result<(), String> {
    let existing = read_work_item(project_slug, short_id)?;
    if existing.frontmatter.deleted_at.is_some() {
        return Ok(());
    }
    super::atomic::update_work_item_atomic_serviced(
        project_slug,
        short_id,
        None,
        super::atomic::AtomicServiceOptions {
            operation: Some("work.delete"),
            ..Default::default()
        },
        |frontmatter, _body| {
            let deleted_at = chrono::Utc::now().to_rfc3339();
            append_deleted_event(frontmatter, &deleted_at);
            frontmatter.deleted_at = Some(deleted_at.clone());
            frontmatter.updated_at = deleted_at;
            Ok(())
        },
    )?;
    let connection = conn()?;
    let project_id = resolve_project_id(&connection, project_slug)?;
    let org_id: String = map_db(connection.query_row(
        "SELECT org_id FROM projects WHERE id = ?1",
        params![&project_id],
        |row| row.get(0),
    ))?;
    drop(connection);
    crate::sync::collab_bridge::record_work_item_write(
        &org_id,
        Some(project_slug),
        &existing.frontmatter.id,
        true,
    )
}

/// Permanently remove a work item and its dependent rows.
///
/// This is deliberately separate from [`delete_work_item`], whose user-facing
/// semantics are recoverable. External adapters call this only after the
/// upstream system has already deleted/archived the item; retaining a local
/// recoverable row there would keep its external identity bound forever.
pub(crate) fn purge_work_item(project_slug: &str, short_id: &str) -> Result<(), String> {
    let mut connection = conn()?;
    let tx = map_db(connection.transaction())?;
    let project_id = resolve_project_id(&tx, project_slug)?;
    let affected = map_db(tx.execute(
        "DELETE FROM workitems WHERE project_id = ?1 AND short_id = ?2",
        params![project_id, short_id],
    ))?;
    if affected == 0 {
        return Err(format!("Work item '{}' not found", short_id));
    }
    map_db(tx.commit())?;
    crate::projects::events::notify_work_item_schedule_changed();
    Ok(())
}

pub fn restore_work_item(project_slug: &str, short_id: &str) -> Result<WorkItemData, String> {
    let existing = read_work_item(project_slug, short_id)?;
    if existing.frontmatter.deleted_at.is_none() {
        return Ok(existing);
    }
    super::atomic::update_work_item_atomic_serviced(
        project_slug,
        short_id,
        None,
        super::atomic::AtomicServiceOptions {
            operation: Some("work.restore"),
            ..Default::default()
        },
        |frontmatter, _body| {
            let restored_at = chrono::Utc::now().to_rfc3339();
            append_restored_event(frontmatter, &restored_at);
            frontmatter.deleted_at = None;
            frontmatter.updated_at = restored_at;
            Ok(())
        },
    )?;
    let connection = conn()?;
    let project_id = resolve_project_id(&connection, project_slug)?;
    let org_id: String = map_db(connection.query_row(
        "SELECT org_id FROM projects WHERE id = ?1",
        params![&project_id],
        |row| row.get(0),
    ))?;
    drop(connection);
    crate::sync::collab_bridge::record_work_item_write(
        &org_id,
        Some(project_slug),
        &existing.frontmatter.id,
        false,
    )?;
    read_work_item(project_slug, short_id)
}

pub fn purge_expired_deleted_work_items(project_slug: &str) -> Result<usize, String> {
    let connection = conn()?;
    let project_id = resolve_project_id(&connection, project_slug)?;
    let expires_before = chrono::Utc::now()
        .checked_sub_signed(chrono::Duration::days(7))
        .ok_or_else(|| "Failed to compute delete bin expiration".to_string())?
        .timestamp_millis();

    let purged = map_db(connection.execute(
        "DELETE FROM workitems WHERE project_id = ?1 AND deleted_at IS NOT NULL AND deleted_at < ?2",
        params![&project_id, expires_before],
    ))?;
    if purged > 0 {
        crate::projects::events::notify_work_item_schedule_changed();
    }
    Ok(purged)
}

/// Allocate the next short ID for a work item under `project_slug`.
///
/// Reads the project's current `next_work_item_id`, scans `workitems`
/// for the highest existing numeric suffix on the same prefix (so a
/// hand-edited DB or an out-of-band insert won't collide), bumps the
/// counter, and writes it back — all inside one `IMMEDIATE` transaction
/// so two concurrent allocators can't hand out the same ID.
pub fn allocate_short_id(project_slug: &str) -> Result<String, String> {
    let mut connection = conn()?;
    let tx =
        map_db(connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate))?;
    let short_id = allocate_short_id_in_tx(&tx, project_slug)?;
    map_db(tx.commit())?;
    Ok(short_id)
}

pub(crate) fn allocate_short_id_in_tx(
    tx: &rusqlite::Transaction,
    project_slug: &str,
) -> Result<String, String> {
    let (project_id, org_id, prefix, mut next_id) = map_db(
        tx.query_row(
            "SELECT id, org_id, short_id_prefix, next_work_item_id
             FROM projects WHERE slug = ?1",
            params![project_slug],
            |row| {
                let id: String = row.get(0)?;
                let org_id: String = row.get(1)?;
                let prefix: String = row.get(2)?;
                let next_id: i64 = row.get(3)?;
                Ok((id, org_id, prefix, next_id))
            },
        )
        .optional(),
    )?
    .ok_or_else(|| format!("Project '{}' not found", project_slug))?;

    if let Some(max_existing) = max_existing_work_item_number(tx, &org_id, &prefix)? {
        let min_next = (max_existing as i64).saturating_add(1);
        if next_id < min_next {
            next_id = min_next;
        }
    }

    let short_id = format!("{}-{:04}", prefix, next_id);
    let bumped = next_id.saturating_add(1);

    map_db(tx.execute(
        "UPDATE projects SET next_work_item_id = ?1, updated_at = ?2 WHERE id = ?3",
        params![bumped, now_ms(), project_id],
    ))?;

    Ok(short_id)
}

pub fn allocate_standalone_short_id(org_id: Option<&str>) -> Result<String, String> {
    let mut connection = conn()?;
    let tx =
        map_db(connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate))?;
    let org_id = org_id.unwrap_or("personal-org");
    let prefix = "WI";
    let mut next_id = 1_i64;
    if let Some(max_existing) = max_existing_standalone_work_item_number(&tx, org_id, prefix)? {
        next_id = (max_existing as i64).saturating_add(1);
    }
    // `workitems.id` is a GLOBAL primary key (`id = short_id` until the
    // id migration), while the counter above is per-org: another org may
    // already own the candidate. Walk past global collisions so creation
    // never trips the work.create existence guard.
    let short_id = loop {
        let candidate = format!("{}-{:04}", prefix, next_id);
        let taken: bool = map_db(
            tx.query_row(
                "SELECT 1 FROM workitems WHERE id = ?1",
                params![&candidate],
                |_| Ok(true),
            )
            .optional(),
        )?
        .unwrap_or(false);
        if !taken {
            break candidate;
        }
        next_id = next_id.saturating_add(1);
    };
    map_db(tx.commit())?;
    Ok(short_id)
}

/// Move a work item from one project to another. The `short_id` does
/// NOT change; only the owning project UUID changes.
pub fn move_work_item(short_id: &str, from_project: &str, to_project: &str) -> Result<(), String> {
    let mut connection = conn()?;
    let tx =
        map_db(connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate))?;

    let from_id = resolve_project_id(&tx, from_project)?;
    let to_id = resolve_project_id(&tx, to_project)?;

    let exists_at_dest: bool = map_db(
        tx.query_row(
            "SELECT 1 FROM workitems WHERE project_id = ?1 AND short_id = ?2",
            params![&to_id, short_id],
            |_| Ok(true),
        )
        .optional(),
    )?
    .unwrap_or(false);
    if exists_at_dest {
        return Err(format!(
            "Work item '{}' already exists in project '{}'",
            short_id, to_project
        ));
    }

    let affected = map_db(tx.execute(
        "UPDATE workitems SET project_id = ?1, updated_at = ?2
         WHERE project_id = ?3 AND short_id = ?4",
        params![&to_id, now_ms(), &from_id, short_id],
    ))?;
    if affected == 0 {
        return Err(format!(
            "Work item '{}' not found in project '{}'",
            short_id, from_project
        ));
    }

    let moved: Option<(String, String)> = map_db(
        tx.query_row(
            "SELECT id, org_id FROM workitems WHERE project_id = ?1 AND short_id = ?2",
            params![&to_id, short_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional(),
    )?;

    map_db(tx.commit())?;
    crate::projects::events::notify_work_item_schedule_changed();
    if let Some((work_item_id, org_id)) = moved {
        crate::sync::collab_bridge::record_work_item_write(
            &org_id,
            Some(to_project),
            &work_item_id,
            false,
        )?;
    }
    Ok(())
}

// ---------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------

/// Pre-write values of every sync-tracked field (the same set as
/// `atomic::SYNC_TRACKED_FIELDS`), captured inside the write
/// transaction so whole-row writes can stamp `("local", now)` revisions
/// for the fields they actually changed.
struct PriorSyncSnapshot {
    title: String,
    body: String,
    status: String,
    priority: String,
    assignee: Option<String>,
    milestone: Option<String>,
    start_date: Option<String>,
    target_date: Option<String>,
    labels: Vec<String>,
}

impl PriorSyncSnapshot {
    /// Canonical names of sync-tracked fields whose incoming value
    /// differs from the stored row. Field names match
    /// [`crate::sync::adapter::EntityField::as_local_name`].
    fn changed_sync_fields(
        &self,
        next: &WorkItemFrontmatter,
        next_body: &str,
    ) -> Vec<&'static str> {
        let mut changed = Vec::new();
        if self.title != next.title {
            changed.push("title");
        }
        if self.body != next_body {
            changed.push("body");
        }
        if self.status != next.status {
            changed.push("status");
        }
        if self.priority != next.priority {
            changed.push("priority");
        }
        if self.assignee != next.assignee {
            changed.push("assignee");
        }
        if self.milestone != next.milestone {
            changed.push("milestone");
        }
        if self.start_date != next.start_date {
            changed.push("start_date");
        }
        if self.target_date != next.target_date {
            changed.push("target_date");
        }
        let mut prior_labels = self.labels.clone();
        let mut next_labels = next.labels.clone();
        prior_labels.sort();
        next_labels.sort();
        if prior_labels != next_labels {
            changed.push("labels");
        }
        changed
    }
}

/// Resolve `slug → project_id` against the `projects` table.
///
/// Generic over the connection type so it works inside both bare
/// `Connection` and an active `Transaction`.
pub(crate) fn resolve_project_scope_in_tx(
    tx: &rusqlite::Transaction,
    project_slug: &str,
) -> Result<(String, String), String> {
    let project_id = map_db(
        tx.query_row(
            "SELECT id FROM projects WHERE slug = ?1",
            params![project_slug],
            |row| row.get::<_, String>(0),
        )
        .optional(),
    )?
    .ok_or_else(|| format!("Project '{}' not found", project_slug))?;
    let org_id: String = map_db(tx.query_row(
        "SELECT org_id FROM projects WHERE id = ?1",
        params![&project_id],
        |row| row.get(0),
    ))?;
    Ok((project_id, org_id))
}

fn resolve_project_id<C>(connection: &C, slug: &str) -> Result<String, String>
where
    C: ConnectionLike,
{
    resolve_project_id_scoped(connection, slug, None)
}

fn resolve_project_id_scoped<C>(
    connection: &C,
    slug: &str,
    org_id: Option<&str>,
) -> Result<String, String>
where
    C: ConnectionLike,
{
    let project_id = if let Some(org_id) = org_id {
        connection.query_row_optional(
            "SELECT id FROM projects WHERE slug = ?1 AND org_id = ?2",
            params![slug, org_id],
            |row| row.get::<_, String>(0),
        )?
    } else {
        connection.query_row_optional(
            "SELECT id FROM projects WHERE slug = ?1",
            params![slug],
            |row| row.get::<_, String>(0),
        )?
    };

    project_id.ok_or_else(|| format!("Project '{}' not found", slug))
}

/// Count the largest numeric suffix used by an existing work item with
/// `prefix` inside the org. `workitems.id` is global and currently equals
/// `short_id`, so allocation must avoid collisions across projects that share
/// a prefix, not just inside one project.
fn max_existing_work_item_number<C>(
    connection: &C,
    org_id: &str,
    prefix: &str,
) -> Result<Option<u32>, String>
where
    C: ConnectionLike,
{
    if prefix.chars().count() != WORK_ITEM_PREFIX_LENGTH {
        return Ok(None);
    }

    let pattern = format!("{}-%", prefix);
    let rows = connection.query_string_rows(
        "SELECT short_id FROM workitems WHERE org_id = ?1 AND short_id LIKE ?2",
        params![org_id, pattern],
    )?;

    max_numeric_suffix(rows, prefix)
}

fn max_existing_standalone_work_item_number<C>(
    connection: &C,
    org_id: &str,
    prefix: &str,
) -> Result<Option<u32>, String>
where
    C: ConnectionLike,
{
    let pattern = format!("{}-%", prefix);
    let rows = connection.query_string_rows(
        "SELECT short_id FROM workitems WHERE org_id = ?1 AND project_id IS NULL AND short_id LIKE ?2",
        params![org_id, pattern],
    )?;

    max_numeric_suffix(rows, prefix)
}

fn max_numeric_suffix(rows: Vec<String>, prefix: &str) -> Result<Option<u32>, String> {
    let prefix_with_dash = format!("{}-", prefix);
    let max = rows
        .into_iter()
        .filter_map(|sid| {
            sid.strip_prefix(&prefix_with_dash)
                .and_then(|tail| tail.parse::<u32>().ok())
        })
        .max();
    Ok(max)
}

#[cfg(test)]
#[path = "crud_tests.rs"]
mod tests;

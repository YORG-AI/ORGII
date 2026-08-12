//! Project CRUD against the `projects` table.
//!
//! Rows are keyed by project ID alone; repo/workspace linkage lives in
//! `linked_repos_json`. The `slug` parameter is the human-readable
//! identifier; we look up by slug since the schema enforces a unique
//! slug index. New rows get a fresh ULID-style ID via the caller
//! (`ProjectMeta.id`); we never mint IDs here so callers stay in charge
//! of identifier strategy.

use std::collections::HashMap;

use rusqlite::{params, OptionalExtension, TransactionBehavior};

use super::helpers::{conn, from_iso8601, map_db, now_ms, to_iso8601};
use super::work_items::{FieldRevision, REVISION_SOURCE_LOCAL};
use crate::projects::types::{AgentDefaults, ProjectData, ProjectMeta};

const WORK_ITEM_PREFIX_LENGTH: usize = 3;
const DEFAULT_WORK_ITEM_PREFIX: &str = "STR";

/// Sync-tracked project fields, keyed by their local names — the same
/// strings stamped into `projects.field_revisions_json` and carried on
/// the collab wire as `_fieldRevisions` keys. The project counterpart
/// of the work-item sync-tracked field set.
pub(crate) const PROJECT_SYNC_FIELDS: &[&str] = &[
    "name",
    "status",
    "priority",
    "health",
    "lead",
    "start_date",
    "target_date",
    "description",
    "work_item_prefix",
];

pub fn derive_work_item_prefix(project_name: &str) -> String {
    let mut prefix = String::new();
    for character in project_name.chars() {
        if character.is_ascii_alphanumeric() {
            prefix.push(character.to_ascii_uppercase());
            if prefix.len() == WORK_ITEM_PREFIX_LENGTH {
                break;
            }
        }
    }

    if prefix.is_empty() {
        return DEFAULT_WORK_ITEM_PREFIX.to_string();
    }

    while prefix.len() < WORK_ITEM_PREFIX_LENGTH {
        prefix.push('X');
    }
    prefix
}

pub fn normalize_custom_work_item_prefix(prefix: &str) -> Result<String, String> {
    let normalized = prefix.trim().to_ascii_uppercase();
    let is_valid_length = normalized.chars().count() == WORK_ITEM_PREFIX_LENGTH;
    let is_valid_chars = normalized
        .chars()
        .all(|character| character.is_ascii_alphanumeric());

    if !is_valid_length || !is_valid_chars {
        return Err(format!(
            "Work item prefix must be exactly {} alphanumeric characters",
            WORK_ITEM_PREFIX_LENGTH
        ));
    }

    Ok(normalized)
}

/// Read every project in the store, ordered by `updated_at` desc.
pub fn read_all_projects() -> Result<Vec<ProjectData>, String> {
    read_all_projects_scoped(None)
}

pub fn read_all_projects_scoped(org_id: Option<&str>) -> Result<Vec<ProjectData>, String> {
    let connection = conn()?;
    let mut out = Vec::new();

    if let Some(org_id) = org_id {
        let mut stmt = map_db(connection.prepare(
            "SELECT id, name, slug, org_id, status, priority, health, lead, description,
                    short_id_prefix, next_work_item_id, start_date, target_date,
                    linked_repos_json, agent_defaults_json, created_at, updated_at, sync_kind
             FROM projects
             WHERE org_id = ?1
             ORDER BY updated_at DESC, created_at DESC",
        ))?;
        let rows = map_db(stmt.query_map(params![org_id], row_to_project_data))?;
        for entry in rows {
            out.push(map_db(entry)?);
        }
        return Ok(out);
    }

    let mut stmt = map_db(connection.prepare(
        "SELECT id, name, slug, org_id, status, priority, health, lead, description,
                short_id_prefix, next_work_item_id, start_date, target_date,
                linked_repos_json, agent_defaults_json, created_at, updated_at, sync_kind
         FROM projects
         ORDER BY updated_at DESC, created_at DESC",
    ))?;
    let rows = map_db(stmt.query_map([], row_to_project_data))?;
    for entry in rows {
        out.push(map_db(entry)?);
    }
    Ok(out)
}

/// Read one project by slug.
pub fn read_project(slug: &str) -> Result<ProjectData, String> {
    read_project_scoped(slug, None)
}

pub fn read_project_scoped(slug: &str, org_id: Option<&str>) -> Result<ProjectData, String> {
    let connection = conn()?;
    let row = if let Some(org_id) = org_id {
        map_db(
            connection
                .query_row(
                    "SELECT id, name, slug, org_id, status, priority, health, lead, description,
                            short_id_prefix, next_work_item_id, start_date, target_date,
                            linked_repos_json, agent_defaults_json, created_at, updated_at, sync_kind
                     FROM projects WHERE slug = ?1 AND org_id = ?2",
                    params![slug, org_id],
                    row_to_project_data,
                )
                .optional(),
        )?
    } else {
        map_db(
            connection
                .query_row(
                    "SELECT id, name, slug, org_id, status, priority, health, lead, description,
                            short_id_prefix, next_work_item_id, start_date, target_date,
                            linked_repos_json, agent_defaults_json, created_at, updated_at, sync_kind
                     FROM projects WHERE slug = ?1",
                    params![slug],
                    row_to_project_data,
                )
                .optional(),
        )?
    };
    row.ok_or_else(|| format!("Project '{}' not found", slug))
}

/// Create or update a project.
///
/// Slug-uniqueness is enforced by a `UNIQUE INDEX` on the column. When
/// `expect_new` is true, an existing row with the same slug is rejected
/// before we touch anything; this preserves the legacy "duplicate slug"
/// error contract.
pub fn write_project(
    slug: &str,
    meta: &ProjectMeta,
    description: &str,
    expect_new: bool,
) -> Result<(), String> {
    write_project_inner(slug, meta, description, expect_new, true, None)?;
    // orgii_collab bridge (design §16.8): project writes under a
    // collab-synced org enqueue one bridge row. Remote-applied writes go
    // through `write_project_remote` and never enqueue (no echo).
    crate::sync::collab_bridge::record_project_write(
        &meta.org_id,
        &meta.id,
        slug,
        crate::sync::types::OutboxOp::Update,
    )
}

/// Silent variant used exclusively by the collab bridge's remote-apply
/// path: no outbox emission (applying a pulled change must not echo it
/// back to the server) and no `("local", now)` stamping. Instead the
/// bridge passes the resolver's `adopted_revisions` — remote-sourced
/// watermarks for the fields it adopted — which are merged into
/// `field_revisions_json` in the same transaction as the row write.
pub(crate) fn write_project_remote(
    slug: &str,
    meta: &ProjectMeta,
    description: &str,
    adopted_revisions: &HashMap<String, FieldRevision>,
) -> Result<(), String> {
    write_project_inner(
        slug,
        meta,
        description,
        false,
        false,
        Some(adopted_revisions),
    )
}

fn write_project_inner(
    slug: &str,
    meta: &ProjectMeta,
    description: &str,
    expect_new: bool,
    stamp_local_revisions: bool,
    merge_revisions: Option<&HashMap<String, FieldRevision>>,
) -> Result<(), String> {
    let mut next_meta = meta.clone();
    if next_meta.work_item_prefix_custom {
        next_meta.work_item_prefix =
            normalize_custom_work_item_prefix(&next_meta.work_item_prefix)?;
    } else {
        next_meta.work_item_prefix = derive_work_item_prefix(&next_meta.name);
    }

    let mut connection = conn()?;
    // One transaction for the prior-state read + upsert so revision
    // stamping is atomic with the row write (mirrors the work-item
    // whole-row write path).
    let tx = map_db(connection.transaction_with_behavior(TransactionBehavior::Immediate))?;

    if expect_new {
        let exists: bool = map_db(
            tx.query_row(
                "SELECT 1 FROM projects WHERE slug = ?1",
                params![slug],
                |_| Ok(true),
            )
            .optional(),
        )?
        .unwrap_or(false);
        if exists {
            return Err(format!(
                "A project with slug '{}' already exists. Choose a different name.",
                slug
            ));
        }
    }

    let now = now_ms();
    let created_at = if next_meta.created_at.is_empty() {
        now
    } else {
        from_iso8601(&next_meta.created_at)
    };

    // Pre-write values of the sync-tracked fields plus the existing
    // revision store. Whole-row writes rebuild the row, so the prior
    // watermarks are layered back on top — a rewrite must never wipe
    // them. Local-driven writes additionally stamp every sync-tracked
    // field that actually changed at `("local", now)` so whole-row
    // project edits propagate through the per-field resolver on peers.
    let prior: Option<PriorProjectSnapshot> = map_db(
        tx.query_row(
            "SELECT org_id, name, status, priority, health, lead, description,
                    short_id_prefix, start_date, target_date, field_revisions_json
               FROM projects WHERE id = ?1",
            params![&next_meta.id],
            |row| {
                Ok(PriorProjectSnapshot {
                    org_id: row.get(0)?,
                    name: row.get(1)?,
                    status: row.get(2)?,
                    priority: row.get(3)?,
                    health: row.get(4)?,
                    lead: row.get(5)?,
                    description: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
                    short_id_prefix: row.get(7)?,
                    start_date: row.get(8)?,
                    target_date: row.get(9)?,
                    field_revisions_json: row.get(10)?,
                })
            },
        )
        .optional(),
    )?;

    if let Some(prior) = prior.as_ref() {
        if prior.org_id != next_meta.org_id {
            return Err(
                "Project organization changes must use the project move operation".to_string(),
            );
        }
    }

    let mut field_revisions: HashMap<String, FieldRevision> = prior
        .as_ref()
        .map(|snapshot| {
            parse_field_revisions_json(snapshot.field_revisions_json.as_deref(), &next_meta.id)
        })
        .unwrap_or_default();
    if stamp_local_revisions {
        if let Some(prior) = prior.as_ref() {
            for field in prior.changed_sync_fields(&next_meta, description) {
                field_revisions.insert(
                    field.to_string(),
                    FieldRevision {
                        mtime: now,
                        source: REVISION_SOURCE_LOCAL.to_string(),
                    },
                );
            }
        }
    }
    if let Some(adopted) = merge_revisions {
        for (field, revision) in adopted {
            field_revisions.insert(field.clone(), revision.clone());
        }
    }
    let field_revisions_json = serde_json::to_string(&field_revisions)
        .map_err(|err| format!("serialize field_revisions: {}", err))?;

    let linked_repos_json = serde_json::to_string(&next_meta.linked_repos)
        .map_err(|err| format!("serialize linked_repos: {}", err))?;
    let agent_defaults_json = next_meta
        .agent_defaults
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|err| format!("serialize agent_defaults: {}", err))?;

    map_db(tx.execute(
        "INSERT INTO projects (
            id, name, slug, org_id, status, priority, health, lead, description,
            short_id_prefix, next_work_item_id, start_date, target_date,
            linked_repos_json, agent_defaults_json, created_at, updated_at,
            field_revisions_json
         ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
            ?10, ?11, ?12, ?13,
            ?14, ?15, ?16, ?17,
            ?18
         )
         ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            slug = excluded.slug,
            org_id = excluded.org_id,
            status = excluded.status,
            priority = excluded.priority,
            health = excluded.health,
            lead = excluded.lead,
            description = excluded.description,
            short_id_prefix = excluded.short_id_prefix,
            next_work_item_id = excluded.next_work_item_id,
            start_date = excluded.start_date,
            target_date = excluded.target_date,
            linked_repos_json = excluded.linked_repos_json,
            agent_defaults_json = excluded.agent_defaults_json,
            updated_at = excluded.updated_at,
            field_revisions_json = excluded.field_revisions_json",
        params![
            next_meta.id,
            next_meta.name,
            slug,
            next_meta.org_id,
            next_meta.status,
            next_meta.priority,
            next_meta.health,
            next_meta.lead,
            description,
            next_meta.work_item_prefix,
            next_meta.next_work_item_id as i64,
            next_meta.start_date,
            next_meta.target_date,
            linked_repos_json,
            agent_defaults_json,
            created_at,
            now,
            field_revisions_json,
        ],
    ))?;

    map_db(tx.commit())
}

/// Per-field revision watermarks for one project — the project
/// counterpart of `read_sync_metadata().field_revisions` for work
/// items. Empty for projects that were never stamped (pre-migration
/// rows, or rows only ever written by peers without the per-field wire
/// map) and for unknown ids (callers gate on row existence).
pub(crate) fn read_project_field_revisions(
    project_id: &str,
) -> Result<HashMap<String, FieldRevision>, String> {
    let connection = conn()?;
    let raw: Option<Option<String>> = map_db(
        connection
            .query_row(
                "SELECT field_revisions_json FROM projects WHERE id = ?1",
                params![project_id],
                |row| row.get(0),
            )
            .optional(),
    )?;
    Ok(parse_field_revisions_json(
        raw.flatten().as_deref(),
        project_id,
    ))
}

/// Parse `projects.field_revisions_json`. A corrupt blob degrades to
/// "never stamped" (whole-row merge semantics) — warn so the data-loss
/// event surfaces, mirroring the work-item extras read path.
fn parse_field_revisions_json(
    raw: Option<&str>,
    project_id: &str,
) -> HashMap<String, FieldRevision> {
    let Some(json) = raw.filter(|value| !value.is_empty()) else {
        return HashMap::new();
    };
    match serde_json::from_str(json) {
        Ok(map) => map,
        Err(err) => {
            tracing::warn!(
                project_id,
                error = %err,
                raw_len = json.len(),
                "projects::io: field_revisions_json parse failed; treating project as unstamped"
            );
            HashMap::new()
        }
    }
}

/// Pre-write values of every sync-tracked project field (the same set
/// as [`PROJECT_SYNC_FIELDS`]), captured inside the write transaction
/// so whole-row writes can stamp `("local", now)` revisions for the
/// fields they actually changed. Mirrors the work-item
/// `PriorSyncSnapshot`.
struct PriorProjectSnapshot {
    org_id: String,
    name: String,
    status: String,
    priority: String,
    health: String,
    lead: Option<String>,
    description: String,
    short_id_prefix: String,
    start_date: Option<String>,
    target_date: Option<String>,
    field_revisions_json: Option<String>,
}

/// Move a project and every project-scoped work item to another organization.
///
/// Organization ownership is denormalized onto work items so standalone org
/// queries do not need to join through projects. Both tables and the cloud
/// replication handoff therefore change in one immediate transaction.
pub fn move_project_to_org(slug: &str, destination_org_id: &str) -> Result<ProjectData, String> {
    let destination_org_id = destination_org_id.trim();
    if destination_org_id.is_empty() {
        return Err("Destination organization is required".to_string());
    }

    let mut connection = conn()?;
    let tx = map_db(connection.transaction_with_behavior(TransactionBehavior::Immediate))?;
    let destination_exists = map_db(
        tx.query_row(
            "SELECT 1 FROM project_orgs WHERE id = ?1",
            params![destination_org_id],
            |_| Ok(true),
        )
        .optional(),
    )?
    .unwrap_or(false);
    if !destination_exists {
        return Err(format!("Organization '{}' not found", destination_org_id));
    }

    let project: Option<(String, String)> = map_db(
        tx.query_row(
            "SELECT id, org_id FROM projects WHERE slug = ?1",
            params![slug],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional(),
    )?;
    let Some((project_id, source_org_id)) = project else {
        return Err(format!("Project '{}' not found", slug));
    };
    if source_org_id == destination_org_id {
        drop(tx);
        return read_project(slug);
    }

    let work_item_ids = {
        let mut statement =
            map_db(tx.prepare("SELECT id FROM workitems WHERE project_id = ?1 ORDER BY id"))?;
        let rows = map_db(statement.query_map(params![&project_id], |row| row.get(0)))?;
        let mut ids = Vec::new();
        for row in rows {
            ids.push(map_db(row)?);
        }
        ids
    };

    crate::sync::collab_bridge::record_project_org_move_in_connection(
        &tx,
        &source_org_id,
        destination_org_id,
        &project_id,
        slug,
        &work_item_ids,
    )?;

    let now = now_ms();
    map_db(tx.execute(
        "UPDATE projects
            SET org_id = ?1, updated_at = ?2,
                local_version = local_version + 1,
                collab_remote_version = NULL
          WHERE id = ?3",
        params![destination_org_id, now, &project_id],
    ))?;
    map_db(tx.execute(
        "UPDATE workitems
            SET org_id = ?1, updated_at = ?2,
                local_version = local_version + 1,
                collab_remote_version = NULL
          WHERE project_id = ?3",
        params![destination_org_id, now, &project_id],
    ))?;
    map_db(tx.commit())?;
    crate::projects::events::notify_data_changed();
    read_project(slug)
}

impl PriorProjectSnapshot {
    /// Canonical names of sync-tracked fields whose incoming value
    /// differs from the stored row. Names match [`PROJECT_SYNC_FIELDS`].
    fn changed_sync_fields(&self, next: &ProjectMeta, next_description: &str) -> Vec<&'static str> {
        let mut changed = Vec::new();
        if self.name != next.name {
            changed.push("name");
        }
        if self.status != next.status {
            changed.push("status");
        }
        if self.priority != next.priority {
            changed.push("priority");
        }
        if self.health != next.health {
            changed.push("health");
        }
        if self.lead != next.lead {
            changed.push("lead");
        }
        if self.start_date != next.start_date {
            changed.push("start_date");
        }
        if self.target_date != next.target_date {
            changed.push("target_date");
        }
        if self.description != next_description {
            changed.push("description");
        }
        // `next.work_item_prefix` is the post-normalization value the
        // caller computed above, so derived-prefix drift (a rename
        // changing the derived prefix) stamps too.
        if self.short_id_prefix != next.work_item_prefix {
            changed.push("work_item_prefix");
        }
        changed
    }
}

/// Delete a project and its project-scoped children.
///
/// The schema intentionally keeps `workitems.project_id` as `ON DELETE SET
/// NULL` so a remotely-arriving project tombstone can be applied before the
/// matching work-item tombstones without destroying their replication rows.
/// A user-confirmed project deletion has stronger semantics, however: its
/// work items must disappear immediately, including while offline. Delete
/// those rows explicitly in the same transaction; their labels/extras then
/// cascade, while the server-side project delete supplies peer tombstones.
pub fn delete_project(slug: &str) -> Result<(), String> {
    let mut connection = conn()?;
    let tx = map_db(connection.transaction_with_behavior(TransactionBehavior::Immediate))?;
    let row: Option<(String, String)> = map_db(
        tx.query_row(
            "SELECT id, org_id FROM projects WHERE slug = ?1",
            params![slug],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional(),
    )?;
    let Some((project_id, org_id)) = row else {
        return Err(format!("Project '{}' not found", slug));
    };
    map_db(tx.execute(
        "DELETE FROM workitems WHERE project_id = ?1",
        params![&project_id],
    ))?;
    map_db(tx.execute("DELETE FROM projects WHERE id = ?1", params![&project_id]))?;
    map_db(tx.commit())?;
    crate::projects::events::notify_work_item_schedule_changed();

    // Collab orgs propagate one project tombstone; the server atomically
    // cascades it to the remote work-item rows.
    crate::sync::collab_bridge::record_project_write(
        &org_id,
        &project_id,
        slug,
        crate::sync::types::OutboxOp::Delete,
    )
}

// ---------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------

fn row_to_project_data(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProjectData> {
    let id: String = row.get(0)?;
    let name: String = row.get(1)?;
    let slug: String = row.get(2)?;
    let org_id: String = row.get(3)?;
    let status: String = row.get(4)?;
    let priority: String = row.get(5)?;
    let health: String = row.get(6)?;
    let lead: Option<String> = row.get(7)?;
    let description: String = row.get::<_, Option<String>>(8)?.unwrap_or_default();
    let short_id_prefix: String = row.get(9)?;
    let next_work_item_id: i64 = row.get(10)?;
    let start_date: Option<String> = row.get(11)?;
    let target_date: Option<String> = row.get(12)?;
    let linked_repos_json: String = row.get(13)?;
    let agent_defaults_json: Option<String> = row.get(14)?;
    let created_at_ms: i64 = row.get(15)?;
    let updated_at_ms: i64 = row.get(16)?;
    let sync_adapter_id = row
        .get::<_, Option<String>>(17)?
        .filter(|adapter_id| adapter_id != "none");

    // `linked_repos_json` is a DB-stored JSON array of repo paths. Silent
    // empty fallback would make a project's repo links disappear from the
    // UI without any signal — the user would re-add them and the corrupt
    // row would persist. Warn so DB corruption / schema drift is visible.
    let linked_repos: Vec<String> = match serde_json::from_str(&linked_repos_json) {
        Ok(v) => v,
        Err(err) => {
            tracing::warn!(
                project_id = %id,
                error = %err,
                raw_len = linked_repos_json.len(),
                "projects::io: linked_repos JSON parse failed; rendering project with no linked repos"
            );
            Vec::new()
        }
    };
    // `agent_defaults_json` is a DB-stored JSON blob holding the
    // project's default agent / model / key-source. A silent
    // `None` on a corrupt row would make the project look like
    // "no defaults configured", and the user's UI would silently
    // revert to global defaults. Warn so the corruption surfaces.
    let agent_defaults: Option<AgentDefaults> = match agent_defaults_json.as_deref() {
        Some(raw) => match serde_json::from_str::<AgentDefaults>(raw) {
            Ok(v) => Some(v),
            Err(err) => {
                tracing::warn!(
                    project_id = %id,
                    error = %err,
                    raw_len = raw.len(),
                    "projects::io: agent_defaults JSON parse failed; reverting to project-level no-defaults"
                );
                None
            }
        },
        None => None,
    };

    let meta = ProjectMeta {
        id,
        name,
        org_id,
        status,
        priority,
        health,
        lead,
        members: vec![],
        labels: vec![],
        linked_repos,
        start_date,
        target_date,
        created_at: to_iso8601(created_at_ms),
        updated_at: to_iso8601(updated_at_ms),
        next_work_item_id: next_work_item_id.max(1) as u32,
        work_item_prefix: short_id_prefix,
        work_item_prefix_custom: false,
        agent_defaults,
    };

    Ok(ProjectData {
        meta,
        description,
        slug,
        sync_adapter_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use test_helpers::test_env;

    fn insert_org(id: &str, sync_provider: &str) {
        let connection = conn().expect("project connection");
        connection
            .execute(
                "INSERT INTO project_orgs
                    (id, name, slug, org_key, source, sync_provider,
                     external_org_id, created_at, updated_at)
                 VALUES (?1, ?1, ?1, ?1, 'local', ?2,
                         CASE WHEN ?2 = 'orgii_collab' THEN ?1 ELSE NULL END, 0, 0)",
                params![id, sync_provider],
            )
            .expect("insert org");
    }

    fn fixture(meta_id: &str, name: &str, slug_hint: &str) -> (String, ProjectMeta) {
        let meta = ProjectMeta {
            id: meta_id.to_string(),
            name: name.to_string(),
            org_id: "personal-org".to_string(),
            status: "active".to_string(),
            priority: "none".to_string(),
            health: "no_updates".to_string(),
            lead: None,
            members: vec![],
            labels: vec![],
            linked_repos: vec!["github.com/example/repo".to_string()],
            start_date: None,
            target_date: None,
            created_at: String::new(),
            updated_at: String::new(),
            next_work_item_id: 1,
            work_item_prefix: String::new(),
            work_item_prefix_custom: false,
            agent_defaults: None,
        };
        (slug_hint.to_string(), meta)
    }

    #[test]
    fn write_then_read_round_trips_core_fields() {
        let _sandbox = test_env::sandbox();
        let (slug, meta) = fixture("s1", "Project One", "project-one");
        write_project(&slug, &meta, "Hello world", true).expect("write");

        let back = read_project("project-one").expect("read");
        assert_eq!(back.meta.id, "s1");
        assert_eq!(back.meta.name, "Project One");
        assert_eq!(back.description, "Hello world");
        assert_eq!(back.meta.linked_repos, vec!["github.com/example/repo"]);
        // Auto-derived prefix is the first three alphanumeric characters.
        assert_eq!(back.meta.work_item_prefix, "PRO");
    }

    #[test]
    fn read_unknown_project_returns_error() {
        let _sandbox = test_env::sandbox();
        let err = read_project("ghost").unwrap_err();
        assert!(err.contains("ghost"), "error should mention slug: {}", err);
    }

    #[test]
    fn read_all_orders_by_updated_at_desc() {
        let _sandbox = test_env::sandbox();

        let (s1, m1) = fixture("p1", "Alpha", "alpha");
        write_project(&s1, &m1, "", true).expect("p1");
        std::thread::sleep(std::time::Duration::from_millis(5));
        let (s2, m2) = fixture("p2", "Beta", "beta");
        write_project(&s2, &m2, "", true).expect("p2");

        let projects = read_all_projects().expect("list");
        assert_eq!(projects.len(), 2);
        assert_eq!(projects[0].meta.id, "p2", "newest first");
        assert_eq!(projects[1].meta.id, "p1");
    }

    #[test]
    fn reads_bound_sync_adapter_without_exposing_unbound_none() {
        let _sandbox = test_env::sandbox();
        let (slug, meta) = fixture("p1", "GitHub Project", "github-project");
        write_project(&slug, &meta, "", true).expect("project");

        assert_eq!(
            read_project(&slug)
                .expect("unbound project")
                .sync_adapter_id,
            None
        );

        let connection = crate::sync::io::conn().expect("sync connection");
        crate::sync::io::attach_adapter(&connection, &slug, "github", "{}", "github-connection")
            .expect("attach adapter");
        drop(connection);

        assert_eq!(
            read_project(&slug)
                .expect("bound project")
                .sync_adapter_id
                .as_deref(),
            Some("github")
        );

        let connection = crate::sync::io::conn().expect("sync connection");
        crate::sync::io::detach_adapter(&connection, &slug).expect("detach adapter");
        drop(connection);

        assert_eq!(
            read_project(&slug)
                .expect("detached project")
                .sync_adapter_id,
            None
        );
    }

    #[test]
    fn read_all_returns_every_project_regardless_of_repo_links() {
        let _sandbox = test_env::sandbox();

        let (s1, mut m1) = fixture("p1", "Alpha", "alpha");
        m1.linked_repos = vec!["github.com/foo/repo-a".to_string()];
        write_project(&s1, &m1, "", true).expect("p1");

        let (s2, mut m2) = fixture("p2", "Beta", "beta");
        m2.linked_repos = vec!["github.com/foo/repo-b".to_string()];
        write_project(&s2, &m2, "", true).expect("p2");

        let (s3, mut m3) = fixture("p3", "Gamma", "gamma");
        m3.linked_repos = vec![];
        write_project(&s3, &m3, "", true).expect("p3");

        let all = read_all_projects().expect("all");
        let mut ids: Vec<String> = all.iter().map(|project| project.meta.id.clone()).collect();
        ids.sort();
        assert_eq!(
            ids,
            vec!["p1".to_string(), "p2".to_string(), "p3".to_string()]
        );
    }

    #[test]
    fn duplicate_slug_with_expect_new_errors() {
        let _sandbox = test_env::sandbox();
        let (s1, m1) = fixture("p1", "Alpha", "alpha");
        write_project(&s1, &m1, "", true).expect("first");

        let (_, m2) = fixture("p2", "Alpha2", "alpha");
        let err = write_project("alpha", &m2, "", true).unwrap_err();
        assert!(err.contains("already exists"), "msg: {}", err);
    }

    #[test]
    fn upsert_overwrites_when_id_matches() {
        let _sandbox = test_env::sandbox();
        let (slug, mut meta) = fixture("p1", "Alpha", "alpha");
        write_project(&slug, &meta, "", true).expect("first");

        meta.name = "Alpha Renamed".to_string();
        meta.priority = "high".to_string();
        write_project(&slug, &meta, "v2", false).expect("update");

        let back = read_project(&slug).expect("read");
        assert_eq!(back.meta.name, "Alpha Renamed");
        assert_eq!(back.meta.priority, "high");
        assert_eq!(back.description, "v2");
    }

    #[test]
    fn generic_write_rejects_an_org_change() {
        let _sandbox = test_env::sandbox();
        insert_org("destination", "none");
        let (slug, mut meta) = fixture("p1", "Alpha", "alpha");
        write_project(&slug, &meta, "", true).expect("create");

        meta.org_id = "destination".to_string();
        let error = write_project(&slug, &meta, "", false).unwrap_err();

        assert!(error.contains("project move operation"), "error: {error}");
        assert_eq!(
            read_project(&slug).expect("read").meta.org_id,
            "personal-org"
        );
    }

    #[test]
    fn move_updates_project_and_children_as_one_org_invariant() {
        let _sandbox = test_env::sandbox();
        insert_org("destination", "none");
        let (slug, meta) = fixture("p1", "Alpha", "alpha");
        write_project(&slug, &meta, "", true).expect("create");
        let connection = conn().expect("project connection");
        connection
            .execute(
                "UPDATE projects
                    SET local_version = 2, collab_remote_version = 8
                  WHERE id = 'p1'",
                [],
            )
            .expect("seed project versions");
        connection
            .execute(
                "INSERT INTO workitems
                    (id, org_id, project_id, short_id, title, created_at, updated_at,
                     local_version, collab_remote_version)
                 VALUES ('w1', 'personal-org', 'p1', 'ALP-1', 'Child', 0, 0, 3, 9)",
                [],
            )
            .expect("insert work item");
        drop(connection);

        let moved = move_project_to_org(&slug, "destination").expect("move");
        assert_eq!(moved.meta.org_id, "destination");

        let connection = conn().expect("project connection");
        let project_versions: (String, i64, Option<i64>) = connection
            .query_row(
                "SELECT org_id, local_version, collab_remote_version
                   FROM projects WHERE id = 'p1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("project row");
        assert_eq!(project_versions, ("destination".to_string(), 3, None));
        let child: (String, i64, Option<i64>) = connection
            .query_row(
                "SELECT org_id, local_version, collab_remote_version
                   FROM workitems WHERE id = 'w1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("child row");
        assert_eq!(child, ("destination".to_string(), 4, None));
    }

    #[test]
    fn cloud_move_enqueues_source_delete_and_destination_snapshots() {
        let _sandbox = test_env::sandbox();
        insert_org("cloud-source", "orgii_collab");
        insert_org("cloud-destination", "orgii_collab");
        let (slug, mut meta) = fixture("p1", "Alpha", "alpha");
        meta.org_id = "cloud-source".to_string();
        write_project(&slug, &meta, "", true).expect("create");
        let connection = conn().expect("project connection");
        connection
            .execute("DELETE FROM outbox_entries", [])
            .expect("clear");
        connection
            .execute(
                "INSERT INTO workitems
                    (id, org_id, project_id, short_id, title, created_at, updated_at)
                 VALUES ('w1', 'cloud-source', 'p1', 'ALP-1', 'Child', 0, 0)",
                [],
            )
            .expect("insert work item");
        drop(connection);

        move_project_to_org(&slug, "cloud-destination").expect("move");

        let connection = conn().expect("project connection");
        let mut statement = connection
            .prepare(
                "SELECT org_id, entity_type, entity_id, op
                   FROM outbox_entries ORDER BY org_id, entity_type, entity_id",
            )
            .expect("prepare outbox");
        let rows: Vec<(String, String, String, String)> = statement
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .expect("query outbox")
            .map(|row| row.expect("outbox row"))
            .collect();
        assert_eq!(
            rows,
            vec![
                (
                    "cloud-destination".to_string(),
                    "project".to_string(),
                    "p1".to_string(),
                    "update".to_string(),
                ),
                (
                    "cloud-destination".to_string(),
                    "work_item".to_string(),
                    "w1".to_string(),
                    "update".to_string(),
                ),
                (
                    "cloud-source".to_string(),
                    "project".to_string(),
                    "p1".to_string(),
                    "delete".to_string(),
                ),
            ]
        );
    }

    #[test]
    fn delete_cascades_to_labels_and_members() {
        use crate::projects::io::labels::{read_labels, write_labels};
        use crate::projects::io::members::{read_members, write_members};
        use crate::projects::types::{LabelEntry, LabelsFile, MemberEntry, MembersFile};

        let _sandbox = test_env::sandbox();
        let (slug, meta) = fixture("p1", "Alpha", "alpha");
        write_project(&slug, &meta, "", true).expect("project");
        write_labels(
            "p1",
            &LabelsFile {
                labels: vec![LabelEntry {
                    id: "l1".into(),
                    name: "bug".into(),
                    color: "#f00".into(),
                }],
            },
        )
        .expect("labels");
        write_members(
            "p1",
            &MembersFile {
                members: vec![MemberEntry {
                    id: "u1".into(),
                    name: "Alice".into(),
                    email: None,
                    avatar: None,
                    github_username: None,
                    last_commit_date: None,
                    active: true,
                }],
            },
        )
        .expect("members");
        let connection = conn().expect("project connection");
        connection
            .execute(
                "INSERT INTO workitems
                    (id, project_id, short_id, title, created_at, updated_at)
                 VALUES ('w1', 'p1', 'ALP-0001', 'Child', 0, 0)",
                [],
            )
            .expect("work item");
        drop(connection);

        delete_project(&slug).expect("delete");

        // FK cascade should have wiped both child tables.
        let labels_after = read_labels("p1").expect("read labels");
        let members_after = read_members("p1").expect("read members");
        assert!(labels_after.labels.is_empty());
        assert!(members_after.members.is_empty());
        let connection = conn().expect("project connection");
        let work_item_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM workitems WHERE id = 'w1'",
                [],
                |row| row.get(0),
            )
            .expect("work item count");
        assert_eq!(work_item_count, 0, "project command must delete its items");
    }

    #[test]
    fn delete_project_errors_when_project_is_missing() {
        let _sandbox = test_env::sandbox();
        let error = delete_project("missing-project").unwrap_err();
        assert_eq!(error, "Project 'missing-project' not found");
    }

    #[test]
    fn derive_prefix_pads_short_names() {
        assert_eq!(derive_work_item_prefix("Hi"), "HIX");
        assert_eq!(derive_work_item_prefix("Project One"), "PRO");
        assert_eq!(derive_work_item_prefix(""), DEFAULT_WORK_ITEM_PREFIX);
    }

    #[test]
    fn normalize_custom_prefix_validates() {
        assert_eq!(
            normalize_custom_work_item_prefix(" abc ").unwrap(),
            "ABC".to_string()
        );
        assert!(normalize_custom_work_item_prefix("AB").is_err());
        assert!(normalize_custom_work_item_prefix("ABCD").is_err());
        assert!(normalize_custom_work_item_prefix("AB!").is_err());
    }
}

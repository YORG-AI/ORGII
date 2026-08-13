//! Public read/write surface for sync-side metadata stored in
//! `workitem_extras.extras_json`.
//!
//! The sync framework lives in `project_management::sync` and runs from
//! the worker thread. It needs typed access to the per-field revision
//! watermarks and the per-adapter external-id map without dragging the
//! entire `ExtrasPayload` into the public API. This module is the seam:
//! the resolver reads via [`read_sync_metadata`] / [`find_by_external_ref`]
//! and applies merges via [`apply_remote_merge`].
//!
//! All writes use the same `update_work_item_atomic` RMW path as the
//! user-driven update flow, so concurrent sync + user mutations queue
//! at the SQLite layer rather than racing.
//!
//! # Why not a side table?
//!
//! `workitem_extras.extras_json` already exists, has a `1:1` relationship
//! with `workitems`, and is GC'd via `ON DELETE CASCADE` on the parent
//! row. A separate `workitem_sync_metadata` table would duplicate that
//! relationship and double the write load on every sync apply. The
//! `flatten`-ed `other` map on `ExtrasPayload` already proves that
//! additive blob fields don't break forward compatibility.

use std::collections::HashMap;

use rusqlite::{params, OptionalExtension, TransactionBehavior};

use super::super::helpers::{conn, map_db};
use super::extras::ExtrasPayload;
pub use super::extras::{FieldRevision, REVISION_SOURCE_LOCAL};

/// One work item's sync-side state. Returned by [`read_sync_metadata`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SyncMetadata {
    /// Per-field revision watermarks. Empty for items the sync
    /// framework has never touched.
    pub field_revisions: HashMap<String, FieldRevision>,
    /// `adapter_id → external_id` map. Empty when the item isn't
    /// bound to any external system.
    pub external_refs: HashMap<String, String>,
}

/// Read sync metadata for one work item. Returns
/// [`SyncMetadata::default`] for items that exist but have never been
/// touched by sync, and `Ok(None)` when the item itself doesn't exist
/// — distinguishing the two so the resolver can decide between
/// "create-from-remote" and "merge into existing".
pub fn read_sync_metadata(
    project_slug: &str,
    short_id: &str,
) -> Result<Option<SyncMetadata>, String> {
    let connection = conn()?;
    let project_id: Option<String> = map_db(
        connection
            .query_row(
                "SELECT id FROM projects WHERE slug = ?1",
                params![project_slug],
                |row| row.get(0),
            )
            .optional(),
    )?;
    let Some(project_id) = project_id else {
        return Ok(None);
    };
    let work_item_id: Option<String> = map_db(
        connection
            .query_row(
                "SELECT id FROM workitems WHERE project_id = ?1 AND short_id = ?2",
                params![&project_id, short_id],
                |row| row.get(0),
            )
            .optional(),
    )?;
    let Some(work_item_id) = work_item_id else {
        return Ok(None);
    };
    read_sync_metadata_for_work_item_id(&connection, &work_item_id)
}

/// Standalone-org counterpart to [`read_sync_metadata`].
///
/// The collaboration bridge addresses standalone Work Items by their durable
/// row id. Reading metadata through that same identity avoids a short-id
/// ambiguity when different orgs use the same human-facing identifier.
pub(crate) fn read_standalone_sync_metadata(
    org_id: &str,
    work_item_id: &str,
) -> Result<Option<SyncMetadata>, String> {
    let connection = conn()?;
    let exists: bool = map_db(connection.query_row(
        "SELECT EXISTS(
                    SELECT 1 FROM workitems
                     WHERE id = ?1 AND org_id = ?2 AND project_id IS NULL
                )",
        params![work_item_id, org_id],
        |row| row.get(0),
    ))?;
    if !exists {
        return Ok(None);
    }
    read_sync_metadata_for_work_item_id(&connection, work_item_id)
}

fn read_sync_metadata_for_work_item_id(
    connection: &rusqlite::Connection,
    work_item_id: &str,
) -> Result<Option<SyncMetadata>, String> {
    let raw = map_db(
        connection
            .query_row(
                "SELECT extras_json FROM workitem_extras WHERE work_item_id = ?1",
                params![work_item_id],
                |row| row.get::<_, String>(0),
            )
            .optional(),
    )?;
    // Silent fallback would make sync_metadata see "no field
    // revisions, no external refs" for a corrupt row — the next sync
    // pass would treat the work item as if it had never been synced,
    // overwriting the corrupt row with the latest remote state and
    // permanently losing whatever local-pending-revision metadata
    // was in the corrupt JSON. Warn so the corruption surfaces.
    let extras = match raw.as_deref() {
        Some(json) => match serde_json::from_str::<ExtrasPayload>(json) {
            Ok(v) => v,
            Err(err) => {
                tracing::warn!(
                    work_item_id = %work_item_id,
                    error = %err,
                    raw_len = json.len(),
                    "work_items::sync_metadata::read: extras_json parse failed; treating as no-metadata"
                );
                ExtrasPayload::default()
            }
        },
        None => ExtrasPayload::default(),
    };
    Ok(Some(SyncMetadata {
        field_revisions: extras.field_revisions,
        external_refs: extras.external_refs,
    }))
}

/// Locate the work item bound to `(adapter_id, external_id)` within
/// `project_slug`. Returns the local `short_id` when matched, `None`
/// otherwise.
///
/// The query scans `workitem_extras` rows for the project — there's no
/// dedicated index on `extras_json` because SQLite's JSON1 extension
/// isn't enabled on every platform we ship to. Projects in practice
/// have hundreds, not millions, of work items; the linear scan is
/// fine for the sync cadence (one cycle every 5min).
pub fn find_by_external_ref(
    project_slug: &str,
    adapter_id: &str,
    external_id: &str,
) -> Result<Option<String>, String> {
    let connection = conn()?;
    let project_id: Option<String> = map_db(
        connection
            .query_row(
                "SELECT id FROM projects WHERE slug = ?1",
                params![project_slug],
                |row| row.get(0),
            )
            .optional(),
    )?;
    let Some(project_id) = project_id else {
        return Ok(None);
    };

    // Fast path: the relational binding table (Orgtrack Phase 6). Rows
    // are dual-written by apply_remote_merge and lazily backfilled below
    // when the legacy blob scan still finds a pre-migration binding.
    let indexed: Option<String> = map_db(
        connection
            .query_row(
                "SELECT w.short_id
                   FROM pm_provider_bindings b
                   JOIN workitems w ON w.id = b.work_item_id
                  WHERE b.provider = ?1 AND b.external_id = ?2 AND w.project_id = ?3",
                params![adapter_id, external_id, &project_id],
                |row| row.get(0),
            )
            .optional(),
    )?;
    if indexed.is_some() {
        return Ok(indexed);
    }

    let mut stmt = map_db(connection.prepare(
        "SELECT w.short_id, e.extras_json
           FROM workitems w
           JOIN workitem_extras e ON e.work_item_id = w.id
          WHERE w.project_id = ?1",
    ))?;
    let rows = map_db(stmt.query_map(params![&project_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    }))?;

    for entry in rows {
        let (short_id, json) = map_db(entry)?;
        let extras: ExtrasPayload = match serde_json::from_str(&json) {
            Ok(value) => value,
            // A malformed extras_json shouldn't break sync — log and
            // skip. The actively-used items will round-trip fine.
            Err(err) => {
                tracing::warn!(
                    "[work_items::sync_metadata] dropped malformed extras_json for {}: {}",
                    short_id,
                    err
                );
                continue;
            }
        };
        if extras.external_refs.get(adapter_id) == Some(&external_id.to_string()) {
            // Lazy backfill: promote the legacy blob binding into the
            // indexed table so the next lookup takes the fast path.
            let work_item_id: Option<String> = map_db(
                connection
                    .query_row(
                        "SELECT id FROM workitems WHERE project_id = ?1 AND short_id = ?2",
                        params![&project_id, &short_id],
                        |row| row.get(0),
                    )
                    .optional(),
            )?;
            if let Some(work_item_id) = work_item_id {
                let now = crate::projects::io::helpers::now_ms();
                let _ = connection.execute(
                    "INSERT OR IGNORE INTO pm_provider_bindings
                        (work_item_id, provider, external_id, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?4)",
                    params![&work_item_id, adapter_id, external_id, now],
                );
            }
            return Ok(Some(short_id));
        }
    }
    Ok(None)
}

/// Stamp `revisions` into `workitem_extras.extras_json` and (when set)
/// associate the work item with `(adapter_id, external_id)`.
///
/// Used by:
/// - The merge cycle, after the resolver picks a winner per field —
///   it stamps the adopted revisions plus, on first-merge,
///   `(adapter_id, external_id)`.
/// - The push success path on `process_entry`, to persist the
///   external id returned by the adapter (e.g. GitHub issue number)
///   so the next inbound merge can identity-match.
///
/// `revisions` is merged with the existing map — keys present in the
/// argument overwrite, keys absent are kept. Pass an empty map to
/// only update the external ref.
pub fn apply_remote_merge(
    project_slug: &str,
    short_id: &str,
    revisions: HashMap<String, FieldRevision>,
    external_ref: Option<(String, String)>,
) -> Result<(), String> {
    let mut connection = conn()?;
    let tx = map_db(connection.transaction_with_behavior(TransactionBehavior::Immediate))?;

    let project_id: String = map_db(
        tx.query_row(
            "SELECT id FROM projects WHERE slug = ?1",
            params![project_slug],
            |row| row.get(0),
        )
        .optional(),
    )?
    .ok_or_else(|| format!("Project '{}' not found", project_slug))?;

    let work_item_id: String = map_db(
        tx.query_row(
            "SELECT id FROM workitems WHERE project_id = ?1 AND short_id = ?2",
            params![&project_id, short_id],
            |row| row.get(0),
        )
        .optional(),
    )?
    .ok_or_else(|| {
        format!(
            "Work item '{}' not found in project '{}'",
            short_id, project_slug
        )
    })?;

    let raw: Option<String> = map_db(
        tx.query_row(
            "SELECT extras_json FROM workitem_extras WHERE work_item_id = ?1",
            params![&work_item_id],
            |row| row.get::<_, String>(0),
        )
        .optional(),
    )?;
    // This is the dangerous mutator path: a corrupt row silently
    // becomes `ExtrasPayload::default()`, then the next `serialize +
    // INSERT OR REPLACE` overwrites the corrupt row with the default
    // — permanently losing every other field revision / external ref
    // we hadn't touched in this update. Warn so the operator notices
    // the data-loss event.
    let mut extras: ExtrasPayload = match raw.as_deref() {
        Some(json) => match serde_json::from_str::<ExtrasPayload>(json) {
            Ok(v) => v,
            Err(err) => {
                tracing::warn!(
                    work_item_id = %work_item_id,
                    error = %err,
                    raw_len = json.len(),
                    "work_items::sync_metadata::write: extras_json parse failed; this UPDATE will OVERWRITE the corrupt row with empty extras + the new revisions"
                );
                ExtrasPayload::default()
            }
        },
        None => ExtrasPayload::default(),
    };

    for (field, revision) in revisions {
        extras.field_revisions.insert(field, revision);
    }
    if let Some((adapter_id, external_id)) = external_ref {
        // Dual-write: legacy blob (still read by exports/collab payloads)
        // plus the indexed relational binding (Orgtrack Phase 6) in the
        // SAME transaction, so identity can never split-brain.
        let now = crate::projects::io::helpers::now_ms();
        map_db(tx.execute(
            "INSERT INTO pm_provider_bindings
                (work_item_id, provider, external_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)
             ON CONFLICT(work_item_id, provider) DO UPDATE SET
                external_id = excluded.external_id,
                updated_at = excluded.updated_at",
            params![&work_item_id, &adapter_id, &external_id, now],
        ))?;
        extras.external_refs.insert(adapter_id, external_id);
    }

    let serialized = serde_json::to_string(&extras)
        .map_err(|err| format!("extras serialization failed: {}", err))?;

    map_db(tx.execute(
        "INSERT INTO workitem_extras (work_item_id, extras_json)
         VALUES (?1, ?2)
         ON CONFLICT(work_item_id) DO UPDATE SET extras_json = excluded.extras_json",
        params![&work_item_id, &serialized],
    ))?;

    map_db(tx.commit())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::projects::io::projects::write_project;
    use crate::projects::io::work_items::write_work_item;
    use crate::projects::types::{ProjectMeta, WorkItemFrontmatter};
    use test_helpers::test_env;

    fn project_fixture(slug: &str) -> ProjectMeta {
        ProjectMeta {
            id: format!("p_{}", slug),
            name: slug.to_string(),
            org_id: "personal-org".to_string(),
            status: "active".to_string(),
            priority: "none".to_string(),
            health: "no_updates".to_string(),
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

    fn work_item_fixture(short_id: &str, title: &str) -> WorkItemFrontmatter {
        WorkItemFrontmatter {
            id: format!("w_{}", short_id),
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
            stage: None,
            start_date: None,
            target_date: None,
            created_by: None,
            origin_session: None,
            created_at: String::new(),
            updated_at: String::new(),
            deleted_at: None,
            starred: false,
            todos: vec![],
            comments: vec![],
            history: vec![],
            delegations: vec![],
            linked_sessions: vec![],
            handoff: None,
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

    fn seed(slug: &str, items: &[&str]) {
        write_project(slug, &project_fixture(slug), "", true).expect("seed project");
        for short_id in items {
            write_work_item(slug, short_id, &work_item_fixture(short_id, "T"), "")
                .expect("seed wi");
        }
    }

    #[test]
    fn read_sync_metadata_returns_none_for_unknown_project() {
        let _sandbox = test_env::sandbox();
        assert!(read_sync_metadata("missing", "AAA-0001").unwrap().is_none());
    }

    #[test]
    fn read_sync_metadata_returns_none_for_unknown_short_id() {
        let _sandbox = test_env::sandbox();
        seed("alpha", &[]);
        assert!(read_sync_metadata("alpha", "AAA-9999").unwrap().is_none());
    }

    #[test]
    fn read_sync_metadata_returns_default_for_unsynced_item() {
        let _sandbox = test_env::sandbox();
        seed("alpha", &["AAA-0001"]);
        let metadata = read_sync_metadata("alpha", "AAA-0001").unwrap().unwrap();
        assert!(metadata.field_revisions.is_empty());
        assert!(metadata.external_refs.is_empty());
    }

    #[test]
    fn apply_then_read_round_trip() {
        let _sandbox = test_env::sandbox();
        seed("alpha", &["AAA-0001"]);
        let mut revisions = HashMap::new();
        revisions.insert(
            "title".to_string(),
            FieldRevision {
                mtime: 1_700_000_000_000,
                source: "linear".to_string(),
            },
        );
        apply_remote_merge(
            "alpha",
            "AAA-0001",
            revisions,
            Some(("linear".to_string(), "iss_42".to_string())),
        )
        .unwrap();

        let metadata = read_sync_metadata("alpha", "AAA-0001").unwrap().unwrap();
        assert_eq!(
            metadata.field_revisions.get("title").unwrap().source,
            "linear"
        );
        assert_eq!(
            metadata.field_revisions.get("title").unwrap().mtime,
            1_700_000_000_000
        );
        assert_eq!(
            metadata.external_refs.get("linear").map(String::as_str),
            Some("iss_42")
        );
    }

    #[test]
    fn apply_merges_revisions_keeping_existing() {
        let _sandbox = test_env::sandbox();
        seed("alpha", &["AAA-0001"]);

        let mut first = HashMap::new();
        first.insert(
            "title".to_string(),
            FieldRevision {
                mtime: 1_700_000_000_000,
                source: "linear".to_string(),
            },
        );
        apply_remote_merge("alpha", "AAA-0001", first, None).unwrap();

        let mut second = HashMap::new();
        second.insert(
            "status".to_string(),
            FieldRevision {
                mtime: 1_700_000_001_000,
                source: "linear".to_string(),
            },
        );
        apply_remote_merge("alpha", "AAA-0001", second, None).unwrap();

        let metadata = read_sync_metadata("alpha", "AAA-0001").unwrap().unwrap();
        assert!(metadata.field_revisions.contains_key("title"));
        assert!(metadata.field_revisions.contains_key("status"));
    }

    #[test]
    fn find_by_external_ref_returns_short_id() {
        let _sandbox = test_env::sandbox();
        seed("alpha", &["AAA-0001", "AAA-0002"]);
        apply_remote_merge(
            "alpha",
            "AAA-0002",
            HashMap::new(),
            Some(("github".to_string(), "42".to_string())),
        )
        .unwrap();
        assert_eq!(
            find_by_external_ref("alpha", "github", "42")
                .unwrap()
                .as_deref(),
            Some("AAA-0002")
        );
        assert!(find_by_external_ref("alpha", "github", "999")
            .unwrap()
            .is_none());
        assert!(find_by_external_ref("alpha", "linear", "42")
            .unwrap()
            .is_none());
    }
}

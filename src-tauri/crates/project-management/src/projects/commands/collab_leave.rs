//! Leave-org cleanup for collab-aliased project orgs (design §8.4).
//!
//! When a member leaves a collab org and opts to scrub the imported
//! copies, the client best-effort-deletes the org's projects. Because
//! the aliased `project_orgs` row is still marked
//! `sync_provider='orgii_collab'` at that point, every delete enqueues
//! an orgii_collab DELETE tombstone into `outbox_entries` — rows the
//! engine can never drain or ack again (the member credential is gone
//! and reconcile() drops the org). Left alone, those tombstones would
//! drain on a later RE-JOIN and push deletions of the org's shared
//! projects to the server for everyone; the stale collab marking would
//! also double-configure on rejoin.
//!
//! [`project_collab_leave_cleanup`] closes both gaps in one
//! transaction: purge every bridge outbox row for the org (worker rows
//! carry `org_id IS NULL` and are untouched) and reverse the marking
//! [`crate::projects::io::configure_project_org_collab_sync`] applied.
//! It deletes neither the `project_orgs` row nor its projects — the
//! frontend owns the scrub's project deletion.

use rusqlite::params;
use serde::Serialize;

use crate::sync::collab_bridge::COLLAB_SYNC_PROVIDER;
use crate::sync::io as sync_io;

/// Mirrors `projects::io::orgs::LOCAL_ORG_SOURCE` / `NO_SYNC_PROVIDER`
/// (private there): the pre-collab defaults `create_project_org` stamps.
const LOCAL_ORG_SOURCE: &str = "local";
const NO_SYNC_PROVIDER: &str = "none";

/// Outcome of [`project_collab_leave_cleanup`], for observability on
/// the TS side (the caller treats the whole command as best-effort).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollabLeaveCleanup {
    /// orgii_collab outbox rows purged for the org (any status).
    pub deleted_outbox_rows: usize,
    /// Whether the org row was collab-marked and got reset to a plain
    /// local org. `false` when the org is missing or was never (or is
    /// no longer) collab-synced — never an error, so a repeated or
    /// stray call stays harmless.
    pub org_unmarked: bool,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

/// Blocking core of [`project_collab_leave_cleanup`]; separated so the
/// unit tests can call it without a Tauri runtime.
pub(crate) fn run_collab_leave_cleanup(org_id: &str) -> Result<CollabLeaveCleanup, String> {
    let org_id = org_id.trim();
    if org_id.is_empty() {
        return Err("Org ID is required".to_string());
    }

    let mut conn = sync_io::conn()?;
    let tx = conn
        .transaction()
        .map_err(|err| format!("DB error (leave cleanup tx): {}", err))?;

    // (a) Purge the org's bridge outbox rows. `org_id` is only ever set
    // on orgii_collab bridge rows; the in-process worker's rows keep it
    // NULL, so they never match this filter.
    let deleted_outbox_rows = tx
        .execute(
            "DELETE FROM outbox_entries WHERE org_id = ?1",
            params![org_id],
        )
        .map_err(|err| format!("DB error (purge collab outbox): {}", err))?;

    // (b) Reverse `configure_project_org_collab_sync`. Guarded on the
    // collab provider so a non-collab org (e.g. git_folder) is never
    // clobbered by a stray call.
    let unmarked = tx
        .execute(
            "UPDATE project_orgs
                SET source = ?1,
                    sync_provider = ?2,
                    sync_config_json = NULL,
                    sync_connection_id = NULL,
                    external_org_id = NULL,
                    updated_at = ?3
              WHERE id = ?4 AND sync_provider = ?5",
            params![
                LOCAL_ORG_SOURCE,
                NO_SYNC_PROVIDER,
                now_ms(),
                org_id,
                COLLAB_SYNC_PROVIDER,
            ],
        )
        .map_err(|err| format!("DB error (unmark collab org): {}", err))?;

    tx.commit()
        .map_err(|err| format!("DB error (leave cleanup commit): {}", err))?;

    Ok(CollabLeaveCleanup {
        deleted_outbox_rows,
        org_unmarked: unmarked > 0,
    })
}

/// Purge the org's orgii_collab outbox rows and clear the collab
/// marking on its `project_orgs` row, in one transaction. Called by the
/// TS leave-org flow after self-removal succeeds (best-effort there);
/// see the module docs for why skipping this poisons a later rejoin.
#[tauri::command]
pub async fn project_collab_leave_cleanup(org_id: String) -> Result<CollabLeaveCleanup, String> {
    tokio::task::spawn_blocking(move || run_collab_leave_cleanup(&org_id))
        .await
        .map_err(|err| format!("Task join error: {}", err))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::projects::io::{
        configure_project_org_collab_sync, create_project_org, read_project_org,
    };
    use crate::projects::types::CreateProjectOrgRequest;
    use crate::sync::collab_bridge;
    use test_helpers::test_env;

    const ORG: &str = "org-collab-leave-test";

    fn seed_collab_org() {
        create_project_org(&CreateProjectOrgRequest {
            name: "Collab Leave Test Org".to_string(),
            id: Some(ORG.to_string()),
        })
        .expect("create org");
        configure_project_org_collab_sync(ORG, Some(ORG)).expect("configure collab sync");
    }

    /// Simulate a Linear-worker row: `org_id` stays NULL exactly like
    /// `sync::io::write::append` leaves it.
    fn seed_null_org_worker_row() {
        let conn = sync_io::conn().expect("conn");
        conn.execute(
            "INSERT INTO outbox_entries
                (project_slug, entity_type, entity_id, op, payload_json,
                 created_at, retry_count, status)
             VALUES ('linear-proj', 'work_item', 'ENG-1', 'update', '{}', 0, 0, 'pending')",
            [],
        )
        .expect("insert worker row");
    }

    fn outbox_count(filter_sql: &str) -> i64 {
        let conn = sync_io::conn().expect("conn");
        conn.query_row(
            &format!("SELECT COUNT(*) FROM outbox_entries WHERE {filter_sql}"),
            params![ORG],
            |row| row.get(0),
        )
        .expect("count")
    }

    #[test]
    fn leave_cleanup_purges_bridge_rows_and_unmarks_org() {
        let _sandbox = test_env::sandbox();
        seed_collab_org();

        // Real bridge enqueue hooks: an update row plus the DELETE
        // tombstone that motivated this command (leave-scrub purge).
        collab_bridge::record_work_item_write(ORG, Some("shared-proj"), "wi-1", false)
            .expect("enqueue update");
        collab_bridge::record_work_item_write(ORG, Some("shared-proj"), "wi-1", true)
            .expect("enqueue delete tombstone");
        seed_null_org_worker_row();
        assert_eq!(outbox_count("org_id = ?1"), 2, "bridge rows seeded");

        let result = run_collab_leave_cleanup(ORG).expect("cleanup");
        assert_eq!(result.deleted_outbox_rows, 2);
        assert!(result.org_unmarked);

        // Exactly the org's bridge rows are gone; the worker's NULL-org
        // row survives.
        assert_eq!(outbox_count("org_id = ?1"), 0);
        assert_eq!(
            outbox_count("org_id IS NULL AND ?1 = ?1"),
            1,
            "NULL-org worker rows must be untouched"
        );

        // The org row survives but is a plain local org again.
        let org = read_project_org(ORG).expect("org still exists");
        assert_eq!(org.source, LOCAL_ORG_SOURCE);
        assert_eq!(org.sync_provider, NO_SYNC_PROVIDER);
        assert!(org.external_org_id.is_none());
        assert!(org.sync_connection_id.is_none());

        let conn = sync_io::conn().expect("conn");
        assert!(
            !collab_bridge::is_collab_org(&conn, ORG).expect("collab gate"),
            "org must no longer pass the collab gate"
        );
        // And the enqueue hook goes back to a no-op (nothing new can
        // pile up between cleanup and the org row's eventual reuse).
        collab_bridge::record_work_item_write(ORG, Some("shared-proj"), "wi-2", true)
            .expect("post-cleanup write");
        assert_eq!(outbox_count("org_id = ?1"), 0);
    }

    #[test]
    fn leave_cleanup_never_clobbers_a_non_collab_org() {
        let _sandbox = test_env::sandbox();
        create_project_org(&CreateProjectOrgRequest {
            name: "Collab Leave Test Org".to_string(),
            id: Some(ORG.to_string()),
        })
        .expect("create org");

        let result = run_collab_leave_cleanup(ORG).expect("cleanup");
        assert_eq!(result.deleted_outbox_rows, 0);
        assert!(!result.org_unmarked, "plain local org is left alone");

        // Unknown org id: still best-effort, never an error.
        let missing = run_collab_leave_cleanup("org-does-not-exist").expect("cleanup");
        assert_eq!(missing.deleted_outbox_rows, 0);
        assert!(!missing.org_unmarked);
    }
}

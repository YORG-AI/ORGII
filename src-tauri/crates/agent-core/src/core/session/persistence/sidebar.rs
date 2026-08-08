//! Bounded native-session queries used by the sidebar roster.
//!
//! This module owns the question "which agent session rows belong to this
//! page?" Agent Org run metadata remains owned by
//! `coordination::agent_org_runs`.

use rusqlite::params;

use super::crud::{row_to_record, UNIFIED_SESSION_SELECT};
use super::{session_type, UnifiedSessionRecord};
use crate::session::SessionStatus;
use database::db::get_connection;

/// Persistence-level cursor that does not depend on the desktop wire crate.
/// Both values are required because `updated_at` is not unique.
pub type NativeSessionPageCursor<'a> = (&'a str, &'a str);

/// Return one bounded sidebar page of unpinned coding sessions that are not
/// roots of any persisted Agent Org run.
///
/// Pin state and root membership are applied before LIMIT, so pinned rows,
/// Agent Org roots, and worker rows cannot consume standalone page capacity.
pub fn list_standalone_coding_sessions_page(
    limit: usize,
    cursor: Option<NativeSessionPageCursor<'_>>,
) -> Result<Vec<UnifiedSessionRecord>, String> {
    list_agent_sessions_page(session_type::CODING, limit, cursor, Some(false))
}

/// Return one bounded sidebar page of distinct, unpinned coding sessions that
/// are roots of at least one persisted Agent Org run.
pub fn list_agent_org_root_sessions_page(
    limit: usize,
    cursor: Option<NativeSessionPageCursor<'_>>,
) -> Result<Vec<UnifiedSessionRecord>, String> {
    list_agent_sessions_page(session_type::CODING, limit, cursor, Some(true))
}

/// Return one bounded page of unpinned top-level sessions for a native
/// non-coding type (currently OS or Human).
pub fn list_unpinned_sessions_by_type_page(
    type_name: &str,
    limit: usize,
    cursor: Option<NativeSessionPageCursor<'_>>,
) -> Result<Vec<UnifiedSessionRecord>, String> {
    list_agent_sessions_page(type_name, limit, cursor, None)
}

fn list_agent_sessions_page(
    type_name: &str,
    limit: usize,
    cursor: Option<NativeSessionPageCursor<'_>>,
    agent_org_root: Option<bool>,
) -> Result<Vec<UnifiedSessionRecord>, String> {
    let conn = get_connection().map_err(|err| err.to_string())?;
    let root_predicate = match agent_org_root {
        Some(true) => {
            "AND EXISTS (
                SELECT 1
                FROM agent_org_runs r
                WHERE r.root_session_id = s.session_id
            )"
        }
        Some(false) => {
            "AND NOT EXISTS (
                SELECT 1
                FROM agent_org_runs r
                WHERE r.root_session_id = s.session_id
            )"
        }
        None => "",
    };
    let bounded_limit = limit.min(i64::MAX as usize) as i64;

    if let Some((updated_at, session_id)) = cursor {
        let sql = format!(
            "{UNIFIED_SESSION_SELECT}
             WHERE s.session_type = ?1
               AND s.status != ?2
               AND s.pinned = 0
               AND s.parent_session_id IS NULL
               {root_predicate}
               AND (
                 s.updated_at < ?3
                 OR (s.updated_at = ?3 AND s.session_id < ?4)
               )
             ORDER BY s.updated_at DESC, s.session_id DESC
             LIMIT ?5"
        );
        let mut stmt = conn.prepare(&sql).map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(
                params![
                    type_name,
                    SessionStatus::Archived.as_str(),
                    updated_at,
                    session_id,
                    bounded_limit,
                ],
                row_to_record,
            )
            .map_err(|err| err.to_string())?;
        return rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string());
    }

    let sql = format!(
        "{UNIFIED_SESSION_SELECT}
         WHERE s.session_type = ?1
           AND s.status != ?2
           AND s.pinned = 0
           AND s.parent_session_id IS NULL
           {root_predicate}
         ORDER BY s.updated_at DESC, s.session_id DESC
         LIMIT ?3"
    );
    let mut stmt = conn.prepare(&sql).map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(
            params![type_name, SessionStatus::Archived.as_str(), bounded_limit],
            row_to_record,
        )
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ensure_runtime_schemas() {
        let conn = database::db::get_connection().expect("test sqlite connection");
        crate::foundation::persistence::test_schema::ensure_agent_sessions_schema(&conn);
        crate::foundation::persistence::session_snapshots::ensure_tables_with(&conn)
            .expect("agent sessions schema");
        crate::session::persistence::init(&conn).expect("unified session schema");
        crate::coordination::agent_org_runs::init_schema(&conn).expect("Agent Org run schema");
    }

    fn upsert_sidebar_session(
        session_id: &str,
        updated_at: &str,
        status: &str,
        type_name: &str,
        parent_session_id: Option<&str>,
    ) {
        upsert_sidebar_session_with_pin(
            session_id,
            updated_at,
            status,
            type_name,
            parent_session_id,
            false,
        );
    }

    fn upsert_sidebar_session_with_pin(
        session_id: &str,
        updated_at: &str,
        status: &str,
        type_name: &str,
        parent_session_id: Option<&str>,
        pinned: bool,
    ) {
        ensure_runtime_schemas();
        super::super::upsert_session(&UnifiedSessionRecord {
            session_id: session_id.to_string(),
            name: format!("sidebar-{session_id}"),
            status: status.to_string(),
            session_type: type_name.to_string(),
            parent_session_id: parent_session_id.map(str::to_string),
            created_at: updated_at.to_string(),
            updated_at: updated_at.to_string(),
            pinned,
            ..Default::default()
        })
        .expect("upsert sidebar session");
    }

    fn insert_agent_org_run(run_id: &str, root_session_id: &str, updated_at: &str) {
        ensure_runtime_schemas();
        let conn = database::db::get_connection().expect("test sqlite connection");
        conn.execute(
            "INSERT INTO agent_org_runs (
                id,
                org_id,
                coordinator_agent_id,
                root_session_id,
                entry_mode,
                status,
                created_at,
                updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![
                run_id,
                format!("org-{run_id}"),
                "builtin:sde",
                root_session_id,
                "standalone_session",
                "running",
                updated_at,
            ],
        )
        .expect("insert Agent Org run");
    }

    #[test]
    fn native_sidebar_pages_split_standalone_sessions_from_agent_org_roots() {
        let _sandbox = test_helpers::test_env::sandbox();

        for (session_id, updated_at) in [
            ("standalone-a", "2026-07-29T10:00:00Z"),
            ("standalone-b", "2026-07-29T11:00:00Z"),
            ("standalone-c", "2026-07-29T12:00:00Z"),
        ] {
            upsert_sidebar_session(session_id, updated_at, "idle", session_type::CODING, None);
        }
        upsert_sidebar_session(
            "standalone-archived",
            "2026-07-29T13:00:00Z",
            SessionStatus::Archived.as_str(),
            session_type::CODING,
            None,
        );
        upsert_sidebar_session(
            "org-root-a",
            "2026-07-29T09:00:00Z",
            "idle",
            session_type::CODING,
            None,
        );
        upsert_sidebar_session(
            "org-root-b",
            "2026-07-29T14:00:00Z",
            "idle",
            session_type::CODING,
            None,
        );
        upsert_sidebar_session(
            "legacy-coding-worker",
            "2026-07-29T16:00:00Z",
            "running",
            session_type::CODING,
            Some("org-root-b"),
        );
        insert_agent_org_run("run-root-a-old", "org-root-a", "2026-07-29T09:00:00Z");
        insert_agent_org_run("run-root-b", "org-root-b", "2026-07-29T14:00:00Z");
        insert_agent_org_run("run-root-a-new", "org-root-a", "2026-07-29T10:00:00Z");
        upsert_sidebar_session(
            "newer-worker",
            "2026-07-29T15:00:00Z",
            "running",
            session_type::ORG_MEMBER,
            Some("org-root-b"),
        );

        let first = list_standalone_coding_sessions_page(2, None).expect("first standalone page");
        assert_eq!(
            first
                .iter()
                .map(|session| session.session_id.as_str())
                .collect::<Vec<_>>(),
            vec!["standalone-c", "standalone-b"]
        );
        let cursor = first.last().expect("first page cursor");
        let second =
            list_standalone_coding_sessions_page(2, Some((&cursor.updated_at, &cursor.session_id)))
                .expect("second standalone page");
        assert_eq!(
            second
                .iter()
                .map(|session| session.session_id.as_str())
                .collect::<Vec<_>>(),
            vec!["standalone-a"]
        );

        let roots = list_agent_org_root_sessions_page(10, None).expect("Agent Org root page");
        assert_eq!(
            roots
                .iter()
                .map(|session| session.session_id.as_str())
                .collect::<Vec<_>>(),
            vec!["org-root-b", "org-root-a"]
        );
    }

    #[test]
    fn native_sidebar_keyset_uses_session_id_for_ties() {
        let _sandbox = test_helpers::test_env::sandbox();
        let tied_at = "2026-07-29T10:00:00Z";
        for session_id in ["tie-a", "tie-m", "tie-z"] {
            upsert_sidebar_session(session_id, tied_at, "idle", session_type::CODING, None);
        }

        let first = list_standalone_coding_sessions_page(2, None).expect("first tied page");
        assert_eq!(
            first
                .iter()
                .map(|session| session.session_id.as_str())
                .collect::<Vec<_>>(),
            vec!["tie-z", "tie-m"]
        );
        let cursor = first.last().expect("tied cursor");
        let second =
            list_standalone_coding_sessions_page(2, Some((&cursor.updated_at, &cursor.session_id)))
                .expect("second tied page");
        assert_eq!(
            second
                .iter()
                .map(|session| session.session_id.as_str())
                .collect::<Vec<_>>(),
            vec!["tie-a"]
        );
    }

    #[test]
    fn pinned_rows_do_not_consume_standalone_page_capacity() {
        let _sandbox = test_helpers::test_env::sandbox();
        for index in 0..10 {
            upsert_sidebar_session_with_pin(
                &format!("pinned-{index:02}"),
                &format!("2026-07-29T12:{index:02}:00Z"),
                "idle",
                session_type::CODING,
                None,
                true,
            );
        }
        for index in 0..11 {
            upsert_sidebar_session(
                &format!("regular-{index:02}"),
                &format!("2026-07-29T11:{index:02}:00Z"),
                "idle",
                session_type::CODING,
                None,
            );
        }

        let first = list_standalone_coding_sessions_page(10, None).expect("first page");
        assert_eq!(first.len(), 10);
        assert!(first.iter().all(|session| !session.pinned));
        let cursor = first.last().expect("first page cursor");
        let second = list_standalone_coding_sessions_page(
            10,
            Some((&cursor.updated_at, &cursor.session_id)),
        )
        .expect("second page");
        assert_eq!(second.len(), 1);
        assert!(second.iter().all(|session| !session.pinned));
    }

    #[test]
    fn native_sidebar_query_uses_bounded_order_and_membership_indexes() {
        let _sandbox = test_helpers::test_env::sandbox();
        ensure_runtime_schemas();
        let conn = database::db::get_connection().expect("test sqlite connection");
        let mut stmt = conn
            .prepare(
                "EXPLAIN QUERY PLAN
                 SELECT s.session_id
                 FROM agent_sessions s
                 WHERE s.pinned = 0
                   AND s.session_type = 'sde'
                   AND s.status != 'archived'
                   AND s.parent_session_id IS NULL
                   AND NOT EXISTS (
                       SELECT 1
                       FROM agent_org_runs r
                       WHERE r.root_session_id = s.session_id
                   )
                 ORDER BY s.updated_at DESC, s.session_id DESC
                 LIMIT 11",
            )
            .expect("prepare native sidebar query plan");
        let details = stmt
            .query_map([], |row| row.get::<_, String>(3))
            .expect("read query plan")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect query plan")
            .join("\n");

        assert!(
            details.contains("idx_agent_sessions_sidebar"),
            "session page did not use ordered pin/type index:\n{details}"
        );
        assert!(
            details.contains("idx_agent_org_runs_root_session"),
            "root membership probe did not use root-session index:\n{details}"
        );
    }
}

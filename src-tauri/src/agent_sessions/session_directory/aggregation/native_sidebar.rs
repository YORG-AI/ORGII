//! Cursor-paginated native sidebar streams.
//!
//! One bounded page per stream (pinned, standalone agent, agent org root, OS
//! agent, CLI agent, human), plus the global pinned query that merges the agent
//! and CLI stores in one ordered SQL page.

use agent_core::session::persistence::{
    self as session_persistence, list_agent_org_root_sessions_page,
    list_standalone_coding_sessions_page, list_unpinned_sessions_by_type_page, session_type,
};
use agent_core::session::SessionStatus;
use database::db::get_connection;
use rusqlite::params;

use super::agent_org::annotate_agent_org_root_rows;
use crate::agent_sessions::cli::persistence as cli_session_persistence;
use crate::agent_sessions::session_directory::conversion::{
    cli_session_to_aggregate_record, human_session_to_aggregate_record,
    os_session_to_aggregate_record, sde_session_to_aggregate_record, AgentMetadataResolver,
};
use crate::agent_sessions::session_directory::types::{
    NativeSidebarSessionCursor, NativeSidebarSessionPageResponse, NativeSidebarSessionStream,
    SessionAggregateRecord,
};

pub const NATIVE_SIDEBAR_PAGE_MAX_LIMIT: usize = 50;

/// Load a bounded page for one native sidebar stream.
///
/// The store applies stream membership and pin state before LIMIT. We
/// over-fetch one row to compute `has_more`; continuation uses the final
/// `(updated_at, session_id)` key instead of a cache-derived offset.
pub fn list_native_sidebar_sessions(
    stream: NativeSidebarSessionStream,
    cursor: Option<&NativeSidebarSessionCursor>,
    limit: usize,
) -> Result<NativeSidebarSessionPageResponse, String> {
    if limit == 0 || limit > NATIVE_SIDEBAR_PAGE_MAX_LIMIT {
        return Err(format!(
            "Native sidebar page limit must be between 1 and {NATIVE_SIDEBAR_PAGE_MAX_LIMIT}"
        ));
    }
    let fetch_limit = limit
        .checked_add(1)
        .ok_or_else(|| "Native sidebar page limit overflow".to_string())?;
    let persistence_cursor =
        cursor.map(|cursor| (cursor.updated_at.as_str(), cursor.session_id.as_str()));

    let mut sessions = match stream {
        NativeSidebarSessionStream::PinnedNative => {
            list_pinned_native_sidebar_sessions(fetch_limit, cursor)?
        }
        NativeSidebarSessionStream::StandaloneAgent => {
            let page = list_standalone_coding_sessions_page(fetch_limit, persistence_cursor)?;
            let mut resolver = AgentMetadataResolver::new();
            page.into_iter()
                .map(|session| sde_session_to_aggregate_record(session, &mut resolver))
                .collect::<Vec<_>>()
        }
        NativeSidebarSessionStream::AgentOrgRoot => {
            let page = list_agent_org_root_sessions_page(fetch_limit, persistence_cursor)?;
            let mut resolver = AgentMetadataResolver::new();
            let mut sessions = page
                .into_iter()
                .map(|session| sde_session_to_aggregate_record(session, &mut resolver))
                .collect::<Vec<_>>();
            annotate_agent_org_root_rows(&mut sessions)?;
            sessions
        }
        NativeSidebarSessionStream::OsAgent => {
            let page = list_unpinned_sessions_by_type_page(
                session_type::DESKTOP,
                fetch_limit,
                persistence_cursor,
            )?;
            let mut resolver = AgentMetadataResolver::new();
            page.into_iter()
                .map(|session| os_session_to_aggregate_record(session, &mut resolver))
                .collect::<Vec<_>>()
        }
        NativeSidebarSessionStream::CliAgent => {
            let page = cli_session_persistence::list_unpinned_root_sessions_page(
                fetch_limit,
                persistence_cursor,
            )
            .map_err(|err| format!("Failed to load CLI sidebar page: {err}"))?;
            page.into_iter()
                .map(cli_session_to_aggregate_record)
                .collect::<Vec<_>>()
        }
        NativeSidebarSessionStream::HumanSession => {
            let page = list_unpinned_sessions_by_type_page(
                session_type::HUMAN,
                fetch_limit,
                persistence_cursor,
            )?;
            page.into_iter()
                .map(human_session_to_aggregate_record)
                .collect::<Vec<_>>()
        }
    };
    let has_more = sessions.len() > limit;
    sessions.truncate(limit);
    let next_cursor = sessions.last().map(|session| NativeSidebarSessionCursor {
        updated_at: session.updated_at.clone(),
        session_id: session.session_id.clone(),
    });

    Ok(NativeSidebarSessionPageResponse {
        sessions,
        next_cursor,
        has_more,
    })
}

#[derive(Debug, Clone, Copy)]
enum PinnedNativeSource {
    Agent,
    Cli,
}

struct PinnedNativeRow {
    source: PinnedNativeSource,
    session_id: String,
}

/// Query the global pinned stream in one ordered SQL page, then hydrate each
/// row from its owning native store. Imported history is intentionally absent:
/// those sources do not persist ORGII pin state.
fn list_pinned_native_sidebar_sessions(
    limit: usize,
    cursor: Option<&NativeSidebarSessionCursor>,
) -> Result<Vec<SessionAggregateRecord>, String> {
    let conn = get_connection().map_err(|err| format!("Failed to open session DB: {err}"))?;
    let bounded_limit = limit.min(i64::MAX as usize) as i64;
    let base = "
        SELECT s.session_id, s.updated_at, 'agent' AS source_kind
        FROM agent_sessions s
        WHERE s.pinned = 1
          AND s.status != ?1
          AND s.parent_session_id IS NULL
          AND s.session_type IN (?2, ?3, ?4)
        {agent_cursor}
        UNION ALL
        SELECT c.session_id, c.updated_at, 'cli' AS source_kind
        FROM code_sessions c
        WHERE c.pinned = 1
          AND c.parent_session_id IS NULL
        {cli_cursor}
        ORDER BY updated_at DESC, session_id DESC
        LIMIT {limit_parameter}";
    let rows = if let Some(cursor) = cursor {
        let cursor_predicate = "AND (updated_at < ?5 OR (updated_at = ?5 AND session_id < ?6))";
        let sql = base
            .replace("{agent_cursor}", cursor_predicate)
            .replace("{cli_cursor}", cursor_predicate)
            .replace("{limit_parameter}", "?7");
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|err| format!("Prepare pinned sidebar page: {err}"))?;
        let rows = stmt
            .query_map(
                params![
                    SessionStatus::Archived.as_str(),
                    session_type::CODING,
                    session_type::DESKTOP,
                    session_type::HUMAN,
                    cursor.updated_at.as_str(),
                    cursor.session_id.as_str(),
                    bounded_limit
                ],
                |row| {
                    let source = match row.get::<_, String>(2)?.as_str() {
                        "agent" => PinnedNativeSource::Agent,
                        "cli" => PinnedNativeSource::Cli,
                        _ => unreachable!("pinned source is a SQL literal"),
                    };
                    Ok(PinnedNativeRow {
                        session_id: row.get(0)?,
                        source,
                    })
                },
            )
            .map_err(|err| format!("Query pinned sidebar page: {err}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| format!("Read pinned sidebar page: {err}"))?;
        rows
    } else {
        let sql = base
            .replace("{agent_cursor}", "")
            .replace("{cli_cursor}", "")
            .replace("{limit_parameter}", "?5");
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|err| format!("Prepare pinned sidebar page: {err}"))?;
        let rows = stmt
            .query_map(
                params![
                    SessionStatus::Archived.as_str(),
                    session_type::CODING,
                    session_type::DESKTOP,
                    session_type::HUMAN,
                    bounded_limit
                ],
                |row| {
                    let source = match row.get::<_, String>(2)?.as_str() {
                        "agent" => PinnedNativeSource::Agent,
                        "cli" => PinnedNativeSource::Cli,
                        _ => unreachable!("pinned source is a SQL literal"),
                    };
                    Ok(PinnedNativeRow {
                        session_id: row.get(0)?,
                        source,
                    })
                },
            )
            .map_err(|err| format!("Query pinned sidebar page: {err}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| format!("Read pinned sidebar page: {err}"))?;
        rows
    };

    let mut resolver = AgentMetadataResolver::new();
    let mut sessions = Vec::with_capacity(rows.len());
    for row in rows {
        match row.source {
            PinnedNativeSource::Cli => {
                if let Some(session) = cli_session_persistence::get_session(&row.session_id)
                    .map_err(|err| format!("Hydrate pinned CLI session: {err}"))?
                {
                    sessions.push(cli_session_to_aggregate_record(session));
                }
            }
            PinnedNativeSource::Agent => {
                let Some(session) = session_persistence::get_session(&row.session_id)
                    .map_err(|err| format!("Hydrate pinned agent session: {err}"))?
                else {
                    continue;
                };
                match session.session_type.as_str() {
                    session_type::CODING => {
                        sessions.push(sde_session_to_aggregate_record(session, &mut resolver));
                    }
                    session_type::DESKTOP => {
                        sessions.push(os_session_to_aggregate_record(session, &mut resolver));
                    }
                    session_type::HUMAN => {
                        sessions.push(human_session_to_aggregate_record(session));
                    }
                    _ => {}
                }
            }
        }
    }
    annotate_agent_org_root_rows(&mut sessions)?;
    Ok(sessions)
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use agent_core::session::persistence::UnifiedSessionRecord;

    #[test]
    fn native_sidebar_page_rejects_unbounded_limits_before_querying() {
        for invalid_limit in [0, NATIVE_SIDEBAR_PAGE_MAX_LIMIT + 1] {
            let error = list_native_sidebar_sessions(
                NativeSidebarSessionStream::StandaloneAgent,
                None,
                invalid_limit,
            )
            .expect_err("invalid native sidebar limit must fail");
            assert!(error.contains("between 1 and 50"));
        }
    }

    #[test]
    fn pinned_native_page_merges_agent_and_cli_roots_in_stable_order() {
        let _sandbox = crate::test_utils::test_env::sandbox();
        let conn = get_connection().expect("sandbox database");

        for (session_id, session_type, updated_at, pinned, parent, status) in [
            (
                "sdeagent-pinned",
                session_type::CODING,
                "2026-07-30T14:00:00Z",
                true,
                None,
                "idle",
            ),
            (
                "osagent-pinned",
                session_type::DESKTOP,
                "2026-07-30T12:00:00Z",
                true,
                None,
                "idle",
            ),
            (
                "humansession-pinned",
                session_type::HUMAN,
                "2026-07-30T11:00:00Z",
                true,
                None,
                "completed",
            ),
            (
                "sdeagent-unpinned",
                session_type::CODING,
                "2026-07-30T16:00:00Z",
                false,
                None,
                "idle",
            ),
            (
                "sdeagent-worker",
                session_type::CODING,
                "2026-07-30T15:00:00Z",
                true,
                Some("sdeagent-pinned"),
                "running",
            ),
            (
                "sdeagent-archived",
                session_type::CODING,
                "2026-07-30T13:00:00Z",
                true,
                None,
                "archived",
            ),
        ] {
            session_persistence::upsert_session(&UnifiedSessionRecord {
                session_id: session_id.to_string(),
                name: session_id.to_string(),
                status: status.to_string(),
                session_type: session_type.to_string(),
                parent_session_id: parent.map(str::to_string),
                created_at: updated_at.to_string(),
                updated_at: updated_at.to_string(),
                pinned,
                ..Default::default()
            })
            .expect("seed native session");
        }

        for (session_id, updated_at, pinned, parent) in [
            ("cliagent-pinned", "2026-07-30T13:00:00Z", true, None),
            ("cliagent-unpinned", "2026-07-30T17:00:00Z", false, None),
            (
                "cliagent-worker",
                "2026-07-30T16:00:00Z",
                true,
                Some("cliagent-pinned"),
            ),
        ] {
            conn.execute(
                "INSERT INTO code_sessions (
                    session_id, cli_agent_type, created_at, updated_at,
                    pinned, parent_session_id
                 ) VALUES (?1, 'codex', ?2, ?2, ?3, ?4)",
                params![session_id, updated_at, pinned, parent],
            )
            .expect("seed CLI session");
        }

        let page = list_native_sidebar_sessions(NativeSidebarSessionStream::PinnedNative, None, 10)
            .expect("load global pinned page");

        assert_eq!(
            page.sessions
                .iter()
                .map(|session| session.session_id.as_str())
                .collect::<Vec<_>>(),
            vec![
                "sdeagent-pinned",
                "cliagent-pinned",
                "osagent-pinned",
                "humansession-pinned",
            ]
        );
        assert!(page.sessions.iter().all(|session| session.pinned));
        assert!(!page.has_more);
    }

    #[test]
    fn native_sidebar_wire_contract_is_camel_case_and_rejects_unknown_streams() {
        let response = NativeSidebarSessionPageResponse {
            sessions: Vec::new(),
            next_cursor: Some(NativeSidebarSessionCursor {
                updated_at: "2026-07-30T12:00:00Z".to_string(),
                session_id: "sdeagent-10".to_string(),
            }),
            has_more: true,
        };
        let value = serde_json::to_value(response).expect("serialize page");

        assert_eq!(value["nextCursor"]["updatedAt"], "2026-07-30T12:00:00Z");
        assert_eq!(value["nextCursor"]["sessionId"], "sdeagent-10");
        assert_eq!(value["hasMore"], true);
        assert!(
            serde_json::from_value::<NativeSidebarSessionStream>(serde_json::json!(
                "unknownStream"
            ))
            .is_err()
        );
    }
}

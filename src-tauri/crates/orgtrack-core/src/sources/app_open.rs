//! Native-app deep links for imported external sessions.
//!
//! [`cli_resume`](super::cli_resume) hands an imported session back to the
//! *CLI* that wrote it, inside ORGII's own terminal. This module answers the
//! neighbouring question: can the session be reopened in the vendor's own
//! **app**, showing the very same conversation in its native UI?
//!
//! Only sources whose app exposes a per-session deep link verified against
//! the shipped binary belong here:
//!
//! - `claude_code` — `claude://resume?session=<uuid>`. Claude Desktop's URL
//!   handler routes `resume`, validates the value as a uuid, and imports the
//!   matching CLI transcript from `~/.claude/projects`. The uuid it wants is
//!   the transcript file stem, which is exactly the imported
//!   `source_session_id`.
//! - `codex_app` — `codex://threads/<thread-uuid>`. Registered by the Codex
//!   app, keyed on the same thread uuid the rollout filename carries, so the
//!   stem extraction `cli_resume` already performs feeds it unchanged.
//!
//! Deliberately absent, having been checked and found to have no per-chat
//! route: `cursor_ide` / `cursor_cli` (`cursor://` exposes only file/folder
//! and automations links) and `warp`. The remaining app-bound sources
//! register a scheme but no verified conversation route; extend here once
//! one is confirmed against the real binary.
//!
//! Both links are private, undocumented vendor surfaces: a URL that no
//! longer routes fails silently at the OS level, so hosts must treat this
//! as a best-effort convenience next to the always-available CLI resume,
//! never as the only way back into a session.

use rusqlite::Connection;
use serde::Serialize;

use super::cli_resume::{codex_thread_uuid_from_stem, is_uuid_like};
use super::imported_history::cache::{
    query_cached_session_by_session_id_from_conn, ImportedHistoryCachedSession,
};
use super::imported_history::metadata::{SOURCE_CLAUDE_CODE, SOURCE_CODEX_APP};

/// How to reopen an imported external session in the app that owns it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppOpenPlan {
    /// Imported-history source id the plan derives from.
    pub source: &'static str,
    /// Name of the app the deep link opens, for labels and tooltips.
    pub app_display_name: &'static str,
    /// The deep link to hand to the OS. Every interpolated value is a
    /// validated uuid, so the URL needs no escaping and can carry nothing
    /// the session id did not already contain.
    pub deep_link: String,
    /// The session id the app itself addresses (bare thread uuid).
    pub native_session_id: String,
}

/// Build the deep-link plan for one imported session, or `None` when the
/// source has no per-session app link (or the id shape rules it out).
pub fn app_open_plan(source: &str, source_session_id: &str) -> Option<AppOpenPlan> {
    match source {
        // Claude Code transcripts are `<uuid>.jsonl` under the project slug;
        // the stem IS the id the desktop app resumes by. Non-uuid stems
        // (fixtures, sidecars) are rejected by the app's own regex, so they
        // must not produce a link here either.
        SOURCE_CLAUDE_CODE => {
            if !is_uuid_like(source_session_id) {
                return None;
            }
            Some(AppOpenPlan {
                source: SOURCE_CLAUDE_CODE,
                app_display_name: "Claude",
                deep_link: format!("claude://resume?session={source_session_id}"),
                native_session_id: source_session_id.to_string(),
            })
        }
        // Codex imports key on the rollout file stem
        // (`rollout-<timestamp>-<thread-uuid>`) while the app addresses the
        // bare thread uuid — the same suffix extraction `codex resume` and
        // the managed-mirror dedup use.
        SOURCE_CODEX_APP => {
            let thread_uuid = codex_thread_uuid_from_stem(source_session_id)?;
            Some(AppOpenPlan {
                source: SOURCE_CODEX_APP,
                app_display_name: "Codex",
                deep_link: format!("codex://threads/{thread_uuid}"),
                native_session_id: thread_uuid.to_string(),
            })
        }
        _ => None,
    }
}

/// Resolve a canonical (prefixed) session id against the imported-history
/// cache and plan its native-app deep link. Returns the cache row alongside
/// the plan so hosts can run the availability check (`source_path` still on
/// disk) without a second query — both apps resolve the conversation from
/// the transcript the import was built from, so a deleted transcript means
/// a link that lands on an error toast inside the app.
///
/// Subagent rows resolve to `None`: their transcripts are children of a
/// conversation the app opens as a whole.
pub fn app_open_plan_for_cached_session(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<(AppOpenPlan, ImportedHistoryCachedSession)>, String> {
    let Some((source, session)) = query_cached_session_by_session_id_from_conn(conn, session_id)?
    else {
        return Ok(None);
    };
    if session.parent_session_id.is_some() {
        return Ok(None);
    }
    let plan = app_open_plan(&source, &session.source_session_id);
    Ok(plan.map(|plan| (plan, session)))
}

#[cfg(test)]
mod tests {
    use super::*;

    const UUID: &str = "019f6e88-3bc8-77b3-9f21-30af8dd9a1cd";
    /// A second, distinct uuid: cache rows are keyed per source session, so a
    /// subagent child needs its own id to exist alongside its parent.
    const CHILD_UUID: &str = "019f6e88-3bc8-77b3-9f21-30af8dd9a1ce";

    #[test]
    fn claude_plan_addresses_the_transcript_uuid() {
        let plan = app_open_plan(SOURCE_CLAUDE_CODE, UUID).expect("plan");
        assert_eq!(plan.app_display_name, "Claude");
        assert_eq!(plan.deep_link, format!("claude://resume?session={UUID}"));
        assert_eq!(plan.native_session_id, UUID);
    }

    #[test]
    fn claude_rejects_non_uuid_stems() {
        // The desktop handler validates `?session` against a uuid regex and
        // drops anything else, so a link for these would silently no-op.
        assert!(app_open_plan(SOURCE_CLAUDE_CODE, "claude-meta").is_none());
        assert!(app_open_plan(SOURCE_CLAUDE_CODE, "").is_none());
    }

    #[test]
    fn codex_plan_extracts_thread_uuid_from_rollout_stem() {
        let stem = format!("rollout-2026-07-17T13-24-09-{UUID}");
        let plan = app_open_plan(SOURCE_CODEX_APP, &stem).expect("plan");
        assert_eq!(plan.app_display_name, "Codex");
        assert_eq!(plan.deep_link, format!("codex://threads/{UUID}"));
        assert_eq!(plan.native_session_id, UUID);
    }

    #[test]
    fn codex_plan_accepts_bare_uuid_and_rejects_boundaryless_suffix() {
        assert!(app_open_plan(SOURCE_CODEX_APP, UUID).is_some());
        let boundaryless = format!("rollout{UUID}");
        assert!(app_open_plan(SOURCE_CODEX_APP, &boundaryless).is_none());
    }

    #[test]
    fn deep_links_never_carry_unescaped_input() {
        // Both arms interpolate a uuid-validated value, so no plan can ever
        // emit a URL with a query/fragment/path separator the session id
        // smuggled in. Guard the invariant rather than the two call sites.
        for source in [SOURCE_CLAUDE_CODE, SOURCE_CODEX_APP] {
            for hostile in [
                "019f6e88-3bc8-77b3-9f21-30af8dd9a1cd&folder=/etc",
                "../../etc/passwd",
                "019f6e88-3bc8-77b3-9f21-30af8dd9a1cd#x",
                "a b",
            ] {
                assert!(
                    app_open_plan(source, hostile).is_none(),
                    "{source}/{hostile}"
                );
            }
        }
    }

    #[test]
    fn sources_without_a_verified_app_route_yield_no_plan() {
        for source in [
            "cursor_ide",
            "cursor_cli",
            "opencode",
            "warp",
            "windsurf",
            "definitely_not",
        ] {
            assert!(app_open_plan(source, UUID).is_none(), "{source}");
        }
    }

    #[test]
    fn cached_lookup_plans_only_linkable_rows() {
        use crate::sources::imported_history::metadata::{
            ImportedHistoryCacheInput, ImportedHistoryImpactStats,
        };

        let mut conn = Connection::open_in_memory().expect("open");
        crate::store::sqlite::SqliteRecordStore::init_tables(&conn).expect("init core tables");
        crate::store::sqlite::SqliteRecordStore::init_source_cache_tables(&conn)
            .expect("init source cache tables");

        let input = |source: &'static str,
                     source_session_id: &str,
                     session_id: &str,
                     parent_session_id: Option<String>| {
            ImportedHistoryCacheInput {
                source,
                source_session_id: source_session_id.to_string(),
                session_id: session_id.to_string(),
                source_path: "/tmp/source".to_string(),
                source_record_key: source_session_id.to_string(),
                source_mtime_ms: 1,
                source_size_bytes: 1,
                source_fingerprint: "fp".to_string(),
                parser_version: 1,
                name: "session".to_string(),
                created_at_ms: 1,
                updated_at_ms: 2,
                model: None,
                input_tokens: 0,
                output_tokens: 0,
                cache_read_tokens: 0,
                cache_write_tokens: 0,
                repo_path: Some("/tmp/project".to_string()),
                branch: None,
                impact: ImportedHistoryImpactStats::default(),
                listable: true,
                source_metadata_json: None,
                parent_session_id,
                client_origin: None,
                client_origin_raw: None,
            }
        };
        let claude_session_id = format!("claudecodeapp-{UUID}");
        let child_session_id = format!("claudecodeapp-{CHILD_UUID}");
        crate::sources::imported_history::cache::upsert_imported_session_cache_from_conn(
            &mut conn,
            &[
                input(SOURCE_CLAUDE_CODE, UUID, &claude_session_id, None),
                input(
                    SOURCE_CLAUDE_CODE,
                    CHILD_UUID,
                    &child_session_id,
                    Some(claude_session_id.clone()),
                ),
                input("opencode", "ses_123", "opencodeapp-ses_123", None),
            ],
        )
        .expect("upsert");

        let (plan, session) = app_open_plan_for_cached_session(&conn, &claude_session_id)
            .expect("query")
            .expect("plan");
        assert_eq!(plan.deep_link, format!("claude://resume?session={UUID}"));
        assert_eq!(session.source_path, "/tmp/source");

        // Subagent children reopen through their parent, never on their own —
        // and not because their own id would fail to plan.
        assert!(app_open_plan(SOURCE_CLAUDE_CODE, CHILD_UUID).is_some());
        assert!(app_open_plan_for_cached_session(&conn, &child_session_id)
            .expect("query")
            .is_none());
        // A CLI-resumable source is not automatically app-linkable.
        assert!(
            app_open_plan_for_cached_session(&conn, "opencodeapp-ses_123")
                .expect("query")
                .is_none()
        );
        assert!(app_open_plan_for_cached_session(&conn, "unknown-id")
            .expect("query")
            .is_none());
    }
}

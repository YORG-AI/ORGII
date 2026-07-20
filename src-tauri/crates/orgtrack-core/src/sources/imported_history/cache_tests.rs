use rusqlite::Connection;

use super::*;
use crate::sources::imported_history::metadata::{
    ImportedHistoryCacheInput, ImportedHistoryImpactStats, ImportedHistoryRecordSignature,
    SOURCE_CODEX_APP, SOURCE_OPENCODE, SOURCE_QODER,
};

fn fixture_conn() -> Connection {
    let conn = Connection::open_in_memory().expect("open in-memory db");
    crate::store::sqlite::SqliteRecordStore::init_tables(&conn).expect("init core tables");
    crate::store::sqlite::SqliteRecordStore::init_source_cache_tables(&conn)
        .expect("init source cache tables");
    conn
}

fn input(
    source: &'static str,
    source_session_id: &str,
    updated_at_ms: i64,
) -> ImportedHistoryCacheInput {
    ImportedHistoryCacheInput {
        source,
        source_session_id: source_session_id.to_string(),
        session_id: format!("{source}-{source_session_id}"),
        source_path: format!("/tmp/{source_session_id}.jsonl"),
        source_record_key: source_session_id.to_string(),
        source_mtime_ms: updated_at_ms,
        source_size_bytes: 100,
        source_fingerprint: updated_at_ms.to_string(),
        parser_version: 1,
        name: format!("Session {source_session_id}"),
        created_at_ms: updated_at_ms - 10,
        updated_at_ms,
        model: Some("model-a".to_string()),
        input_tokens: 3,
        output_tokens: 4,
        repo_path: Some(format!("/tmp/repo-{source_session_id}")),
        branch: Some("main".to_string()),
        impact: ImportedHistoryImpactStats::default(),
        listable: true,
        source_metadata_json: None,
        parent_session_id: None,
    }
}

#[test]
fn cache_query_paginates_newest_first() {
    let mut conn = fixture_conn();
    upsert_imported_session_cache_from_conn(
        &mut conn,
        &[
            input(SOURCE_CODEX_APP, "old", 100),
            input(SOURCE_CODEX_APP, "new", 300),
            input(SOURCE_CODEX_APP, "mid", 200),
        ],
    )
    .expect("upsert");

    let page = query_imported_session_page_from_conn(&conn, SOURCE_CODEX_APP, 2, 0).expect("page");

    assert!(page.has_more);
    assert_eq!(page.sessions.len(), 2);
    assert_eq!(page.sessions[0].session_id, "codex_app-new");
    assert_eq!(page.sessions[1].session_id, "codex_app-mid");
}

#[test]
fn sidebar_query_is_date_bounded_and_carries_impact_metadata() {
    let mut conn = fixture_conn();
    let mut inside = input(SOURCE_CODEX_APP, "inside", 250);
    inside.impact.files_changed = 1;
    inside.impact.lines_added = 7;
    inside.impact.lines_removed = 2;
    inside.impact.touched_files = vec!["large/path.rs".to_string()];
    let outside = input(SOURCE_CODEX_APP, "outside", 450);
    upsert_imported_session_cache_from_conn(&mut conn, &[inside, outside]).expect("upsert");

    let page =
        query_imported_sidebar_page_from_conn(&conn, SOURCE_CODEX_APP, Some(200), Some(300), 10, 0)
            .expect("sidebar page");

    assert!(!page.has_more);
    assert_eq!(page.sessions.len(), 1);
    let row = &page.sessions[0];
    assert_eq!(row.session_id, "codex_app-inside");
    assert_eq!(row.repo_path.as_deref(), Some("/tmp/repo-inside"));
    // The Kanban board and other card surfaces render these inline, so the
    // lightweight sidebar row must carry them (regression guard).
    assert_eq!(row.model.as_deref(), Some("model-a"));
    assert_eq!(row.total_tokens, 7); // input_tokens (3) + output_tokens (4)
    assert_eq!(row.files_changed, 1);
    assert_eq!(row.lines_added, 7);
    assert_eq!(row.lines_removed, 2);
    assert_eq!(row.touched_files, vec!["large/path.rs".to_string()]);
}

#[test]
fn sidebar_query_paginates_within_one_date_bucket() {
    let mut conn = fixture_conn();
    upsert_imported_session_cache_from_conn(
        &mut conn,
        &[
            input(SOURCE_CODEX_APP, "old", 210),
            input(SOURCE_CODEX_APP, "mid", 220),
            input(SOURCE_CODEX_APP, "new", 230),
        ],
    )
    .expect("upsert");

    let first =
        query_imported_sidebar_page_from_conn(&conn, SOURCE_CODEX_APP, Some(200), Some(300), 2, 0)
            .expect("first page");
    let second =
        query_imported_sidebar_page_from_conn(&conn, SOURCE_CODEX_APP, Some(200), Some(300), 2, 2)
            .expect("second page");

    assert!(first.has_more);
    assert_eq!(first.sessions[0].session_id, "codex_app-new");
    assert_eq!(first.sessions[1].session_id, "codex_app-mid");
    assert!(!second.has_more);
    assert_eq!(second.sessions[0].session_id, "codex_app-old");
}

#[test]
fn cache_pruning_is_source_scoped() {
    let mut conn = fixture_conn();
    upsert_imported_session_cache_from_conn(
        &mut conn,
        &[
            input(SOURCE_CODEX_APP, "keep", 300),
            input(SOURCE_CODEX_APP, "drop", 200),
            input(SOURCE_OPENCODE, "other", 100),
        ],
    )
    .expect("upsert");

    prune_missing_records_from_conn(&conn, SOURCE_CODEX_APP, &["keep".to_string()]).expect("prune");

    let codex =
        query_imported_session_page_from_conn(&conn, SOURCE_CODEX_APP, 10, 0).expect("codex");
    let opencode =
        query_imported_session_page_from_conn(&conn, SOURCE_OPENCODE, 10, 0).expect("opencode");

    assert_eq!(codex.sessions.len(), 1);
    assert_eq!(codex.sessions[0].session_id, "codex_app-keep");
    assert_eq!(opencode.sessions.len(), 1);
    assert_eq!(opencode.sessions[0].session_id, "opencode-other");
}

#[test]
fn qoder_clear_and_rescan_pruning_does_not_touch_other_sources() {
    let mut conn = fixture_conn();
    upsert_imported_session_cache_from_conn(
        &mut conn,
        &[
            input(SOURCE_QODER, "qoder-session", 300),
            input(SOURCE_OPENCODE, "other-session", 200),
        ],
    )
    .expect("upsert");

    prune_missing_records_from_conn(&conn, SOURCE_QODER, &[]).expect("clear Qoder");

    let qoder =
        query_imported_session_page_from_conn(&conn, SOURCE_QODER, 10, 0).expect("qoder page");
    let other =
        query_imported_session_page_from_conn(&conn, SOURCE_OPENCODE, 10, 0).expect("other page");

    assert!(qoder.sessions.is_empty());
    assert_eq!(other.sessions.len(), 1);
    assert_eq!(other.sessions[0].session_id, "opencode-other-session");
}

#[test]
fn cache_signature_comparison_detects_changed_records() {
    let cached = ImportedHistoryRecordSignature {
        source_session_id: "a".to_string(),
        source_path: "/tmp/a.jsonl".to_string(),
        source_mtime_ms: 1,
        source_size_bytes: 2,
        source_fingerprint: "fp".to_string(),
        parser_version: 1,
    };
    let mut changed = cached.clone();
    changed.source_mtime_ms = 2;

    assert!(record_matches_cached_signature(&cached, &cached));
    assert!(!record_matches_cached_signature(&cached, &changed));
}

#[test]
fn cache_recent_paths_are_deduped_and_limited() {
    let mut conn = fixture_conn();
    let mut older = input(SOURCE_CODEX_APP, "older", 100);
    older.repo_path = Some("/tmp/shared".to_string());
    let mut newer = input(SOURCE_CODEX_APP, "newer", 300);
    newer.repo_path = Some("/tmp/shared".to_string());
    upsert_imported_session_cache_from_conn(&mut conn, &[older, newer]).expect("upsert");

    let paths = query_imported_recent_paths_from_conn(&conn, SOURCE_CODEX_APP, 1).expect("paths");

    assert_eq!(paths.len(), 1);
    assert_eq!(paths[0].path, "/tmp/shared");
    assert_eq!(paths[0].session_count, 2);
}

#[test]
fn cache_single_session_lookup_returns_source_metadata() {
    let mut conn = fixture_conn();
    let mut cached = input(SOURCE_CODEX_APP, "with-metadata", 100);
    cached.source_metadata_json = Some(r#"{"status":"completed","mode":"agent"}"#.to_string());
    upsert_imported_session_cache_from_conn(&mut conn, &[cached]).expect("upsert");

    let session = query_cached_session_from_conn(&conn, SOURCE_CODEX_APP, "with-metadata")
        .expect("query")
        .expect("session");

    assert_eq!(session.source_session_id, "with-metadata");
    assert_eq!(
        session.source_metadata_json.as_deref(),
        Some(r#"{"status":"completed","mode":"agent"}"#)
    );
}

#[test]
fn cache_source_list_filters_unlistable_sessions() {
    let mut conn = fixture_conn();
    let listed = input(SOURCE_CODEX_APP, "listed", 300);
    let mut hidden = input(SOURCE_CODEX_APP, "hidden", 200);
    hidden.listable = false;
    upsert_imported_session_cache_from_conn(&mut conn, &[listed, hidden]).expect("upsert");

    let sessions = query_cached_sessions_for_source_from_conn(&conn, SOURCE_CODEX_APP)
        .expect("query source sessions");

    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].source_session_id, "listed");
}

#[test]
fn cache_session_page_filters_child_sessions() {
    let mut conn = fixture_conn();
    let parent = input(SOURCE_CODEX_APP, "parent", 200);
    let mut child = input(SOURCE_CODEX_APP, "child", 300);
    child.parent_session_id = Some("codex_app-parent".to_string());
    upsert_imported_session_cache_from_conn(&mut conn, &[parent, child]).expect("upsert");

    let page =
        query_imported_session_page_from_conn(&conn, SOURCE_CODEX_APP, 10, 0).expect("query page");
    let cached_child = query_cached_session_from_conn(&conn, SOURCE_CODEX_APP, "child")
        .expect("query child")
        .expect("cached child");

    assert_eq!(page.sessions.len(), 1);
    assert_eq!(page.sessions[0].session_id, "codex_app-parent");
    assert_eq!(
        cached_child.parent_session_id.as_deref(),
        Some("codex_app-parent")
    );
}

#[test]
fn cache_range_query_is_source_scoped_and_filters_unlistable_sessions() {
    let mut conn = fixture_conn();
    let inside = input(SOURCE_CODEX_APP, "inside", 200);
    let outside = input(SOURCE_CODEX_APP, "outside", 500);
    let other_source = input(SOURCE_OPENCODE, "other-source", 200);
    let mut hidden = input(SOURCE_CODEX_APP, "hidden", 220);
    hidden.listable = false;
    upsert_imported_session_cache_from_conn(&mut conn, &[inside, outside, other_source, hidden])
        .expect("upsert");

    let sessions = query_cached_sessions_in_range_from_conn(&conn, SOURCE_CODEX_APP, 100, 300)
        .expect("query range");

    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].source_session_id, "inside");
}

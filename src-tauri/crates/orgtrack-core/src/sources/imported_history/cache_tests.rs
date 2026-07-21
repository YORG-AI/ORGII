use rusqlite::Connection;

use super::*;
use crate::sources::imported_history::metadata::{
    ImportedHistoryCacheInput, ImportedHistoryImpactStats, ImportedHistoryRecordSignature,
    SOURCE_CODEX_APP, SOURCE_OPENCODE,
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
        cache_read_tokens: 0,
        cache_write_tokens: 0,
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
    // Imported sessions have no sessions.db copy — the hover card's storage
    // row can only point at the source app's own transcript file.
    assert_eq!(row.storage_path.as_deref(), Some("/tmp/inside.jsonl"));
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
fn cache_canonical_session_lookup_returns_source_and_hidden_rows() {
    let mut conn = fixture_conn();
    let mut cached = input(SOURCE_CODEX_APP, "child-source-id", 100);
    cached.session_id = "codexapp-child-canonical-id".to_string();
    cached.listable = false;
    upsert_imported_session_cache_from_conn(&mut conn, &[cached]).expect("upsert");

    let (source, session) =
        query_cached_session_by_session_id_from_conn(&conn, "codexapp-child-canonical-id")
            .expect("query")
            .expect("cached child");

    assert_eq!(source, SOURCE_CODEX_APP);
    assert_eq!(session.source_session_id, "child-source-id");
    assert!(!session.listable);
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
fn cache_repo_query_includes_hidden_child_with_inherited_parent_repo() {
    let mut conn = fixture_conn();
    let mut parent = input(SOURCE_CODEX_APP, "parent", 300);
    parent.repo_path = Some("/tmp/target-repo".to_string());
    let mut child = input(SOURCE_CODEX_APP, "child", 200);
    child.repo_path = None;
    child.listable = false;
    child.parent_session_id = Some(parent.session_id.clone());
    let outside = input(SOURCE_CODEX_APP, "outside", 100);
    upsert_imported_session_cache_from_conn(&mut conn, &[parent, child, outside]).expect("upsert");

    let sessions =
        query_cached_sessions_for_repo_from_conn(&conn, SOURCE_CODEX_APP, "/tmp/target-repo")
            .expect("query repo sessions");
    let ids = sessions
        .iter()
        .map(|session| session.source_session_id.as_str())
        .collect::<Vec<_>>();

    assert_eq!(ids, vec!["parent", "child"]);
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

fn listable_of(conn: &Connection, source: &str, source_session_id: &str) -> bool {
    conn.query_row(
        "SELECT listable FROM imported_history_session_cache
         WHERE source = ?1 AND source_session_id = ?2",
        rusqlite::params![source, source_session_id],
        |row| row.get::<_, i64>(0),
    )
    .expect("listable")
        != 0
}

#[test]
fn continuation_election_demotes_all_but_newest_sibling() {
    let mut conn = fixture_conn();
    let group = continuation_group_metadata_json(Some("first-user-uuid-1"));
    let mut oldest = input(SOURCE_CODEX_APP, "gen1", 100);
    oldest.source_metadata_json = group.clone();
    let mut middle = input(SOURCE_CODEX_APP, "gen2", 200);
    middle.source_metadata_json = group.clone();
    let mut newest = input(SOURCE_CODEX_APP, "gen3", 300);
    newest.source_metadata_json = group;
    // Unrelated session with its own group stays untouched.
    let mut loner = input(SOURCE_CODEX_APP, "solo", 150);
    loner.source_metadata_json = continuation_group_metadata_json(Some("other-uuid"));
    // Session with no group key is never part of an election.
    let keyless = input(SOURCE_CODEX_APP, "keyless", 50);
    upsert_imported_session_cache_from_conn(&mut conn, &[oldest, middle, newest, loner, keyless])
        .expect("upsert");

    let demoted =
        demote_superseded_continuations_from_conn(&conn, SOURCE_CODEX_APP).expect("election");

    assert_eq!(demoted, 2);
    assert!(!listable_of(&conn, SOURCE_CODEX_APP, "gen1"));
    assert!(!listable_of(&conn, SOURCE_CODEX_APP, "gen2"));
    assert!(listable_of(&conn, SOURCE_CODEX_APP, "gen3"));
    assert!(listable_of(&conn, SOURCE_CODEX_APP, "solo"));
    assert!(listable_of(&conn, SOURCE_CODEX_APP, "keyless"));
}

#[test]
fn continuation_election_never_promotes_and_skips_subagents() {
    let mut conn = fixture_conn();
    let group = continuation_group_metadata_json(Some("family-a"));
    // Newest sibling is itself unlistable (e.g. managed mirror): the older
    // listable sibling must still demote, and the winner must NOT be promoted.
    let mut older = input(SOURCE_OPENCODE, "old-fork", 100);
    older.source_metadata_json = group.clone();
    let mut newest_hidden = input(SOURCE_OPENCODE, "new-fork", 200);
    newest_hidden.source_metadata_json = group.clone();
    newest_hidden.listable = false;
    // Subagent rows are outside elections entirely.
    let mut subagent = input(SOURCE_OPENCODE, "child", 300);
    subagent.source_metadata_json = group;
    subagent.parent_session_id = Some("opencode-parent".to_string());
    upsert_imported_session_cache_from_conn(&mut conn, &[older, newest_hidden, subagent])
        .expect("upsert");

    let demoted =
        demote_superseded_continuations_from_conn(&conn, SOURCE_OPENCODE).expect("election");

    assert_eq!(demoted, 1);
    assert!(!listable_of(&conn, SOURCE_OPENCODE, "old-fork"));
    assert!(!listable_of(&conn, SOURCE_OPENCODE, "new-fork"));
}

#[test]
fn continuation_group_metadata_json_shapes() {
    assert_eq!(continuation_group_metadata_json(None), None);
    assert_eq!(continuation_group_metadata_json(Some("  ")), None);
    let json = continuation_group_metadata_json(Some("uuid-1")).expect("json");
    let parsed: serde_json::Value = serde_json::from_str(&json).expect("parse");
    assert_eq!(
        parsed
            .get(CONTINUATION_GROUP_KEY_FIELD)
            .and_then(|v| v.as_str()),
        Some("uuid-1")
    );
}

fn table_has_column(conn: &Connection, table: &str, column: &str) -> bool {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .expect("prepare table_info");
    let mut rows = stmt.query([]).expect("query table_info");
    while let Some(row) = rows.next().expect("row") {
        if row.get::<_, String>(1).expect("name") == column {
            return true;
        }
    }
    false
}

// Regression: a database created before `parent_session_id` / `listable` were
// added to `imported_history_session_cache` must still upgrade cleanly. The
// sidebar-order partial index filters on both columns, so creating it inside the
// initial `CREATE TABLE` batch used to abort with "no such column:
// parent_session_id" on every existing cache table, blocking session_launch.
#[test]
fn init_source_cache_tables_upgrades_legacy_table_missing_columns() {
    let conn = Connection::open_in_memory().expect("open in-memory db");
    // Simulate the real legacy on-disk schema: every base/older column is
    // present (so the plain `source_repo` / `source_path` indexes in the initial
    // batch resolve), but the two most-recently-added partial-index predicate
    // columns — `listable` and `parent_session_id` — are absent.
    conn.execute_batch(
        "CREATE TABLE imported_history_session_cache (
            source              TEXT NOT NULL,
            source_session_id   TEXT NOT NULL,
            session_id          TEXT NOT NULL,
            source_path         TEXT NOT NULL DEFAULT '',
            source_record_key   TEXT NOT NULL DEFAULT '',
            source_mtime_ms     INTEGER NOT NULL DEFAULT 0,
            source_size_bytes   INTEGER NOT NULL DEFAULT 0,
            source_fingerprint  TEXT NOT NULL DEFAULT '',
            parser_version      INTEGER NOT NULL DEFAULT 0,
            name                TEXT NOT NULL DEFAULT '',
            created_at_ms       INTEGER NOT NULL DEFAULT 0,
            updated_at_ms       INTEGER NOT NULL DEFAULT 0,
            model               TEXT NOT NULL DEFAULT '',
            input_tokens        INTEGER NOT NULL DEFAULT 0,
            output_tokens       INTEGER NOT NULL DEFAULT 0,
            repo_path           TEXT NOT NULL DEFAULT '',
            branch              TEXT NOT NULL DEFAULT '',
            updated_at          TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (source, source_session_id)
        );",
    )
    .expect("create legacy table");
    assert!(!table_has_column(
        &conn,
        "imported_history_session_cache",
        "parent_session_id"
    ));
    assert!(!table_has_column(
        &conn,
        "imported_history_session_cache",
        "listable"
    ));

    // This previously errored with "no such column: parent_session_id".
    crate::store::sqlite::SqliteRecordStore::init_source_cache_tables(&conn)
        .expect("init source cache tables on legacy schema");

    assert!(table_has_column(
        &conn,
        "imported_history_session_cache",
        "parent_session_id"
    ));
    assert!(table_has_column(
        &conn,
        "imported_history_session_cache",
        "listable"
    ));
    let index_exists: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type = 'index' AND name = 'idx_imported_history_sidebar_order'",
            [],
            |row| Ok(row.get::<_, i64>(0)? == 1),
        )
        .expect("query index presence");
    assert!(
        index_exists,
        "sidebar-order partial index should be created"
    );
}

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
        client_origin: None,
        client_origin_raw: None,
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
fn source_stats_batch_counts_roots_children_and_last_activity() {
    let mut conn = fixture_conn();
    let root = input(SOURCE_CODEX_APP, "root", 100);
    let mut child = input(SOURCE_CODEX_APP, "child", 300);
    child.parent_session_id = Some(root.session_id.clone());
    let other = input(SOURCE_OPENCODE, "other", 200);
    upsert_imported_session_cache_from_conn(&mut conn, &[root, child, other]).expect("upsert");

    let stats = all_source_stats_from_conn(&conn).expect("source stats");
    let codex = stats
        .iter()
        .find(|row| row.source == SOURCE_CODEX_APP)
        .expect("codex stats");
    assert_eq!(codex.session_count, 1);
    assert_eq!(codex.subagent_count, 1);
    assert_eq!(codex.last_used_at_ms, Some(300));

    let opencode = stats
        .iter()
        .find(|row| row.source == SOURCE_OPENCODE)
        .expect("opencode stats");
    assert_eq!(opencode.session_count, 1);
    assert_eq!(opencode.subagent_count, 0);
    assert_eq!(opencode.last_used_at_ms, Some(200));
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
    conn.execute(
        "INSERT INTO imported_history_repo_identity (
            working_path, repo_root_path, remote_urls_json, resolution_kind,
            checked_at_ms, next_refresh_at_ms
         ) VALUES (?1, ?2, ?3, 'git', 1, 2)",
        rusqlite::params![
            "/tmp/repo-inside",
            "/tmp",
            r#"["git@github.com:org2ai/org2.git"]"#
        ],
    )
    .expect("insert repo identity");

    let page =
        query_imported_sidebar_page_from_conn(&conn, SOURCE_CODEX_APP, Some(200), Some(300), 10, 0)
            .expect("sidebar page");

    assert!(!page.has_more);
    assert_eq!(page.sessions.len(), 1);
    let row = &page.sessions[0];
    assert_eq!(row.session_id, "codex_app-inside");
    assert_eq!(row.repo_path.as_deref(), Some("/tmp/repo-inside"));
    assert_eq!(row.repo_root_path.as_deref(), Some("/tmp"));
    assert_eq!(
        row.repo_remote_urls,
        vec!["git@github.com:org2ai/org2.git".to_string()]
    );
    // Imported sessions have no sessions.db copy — the hover card's storage
    // row can only point at the source app's own transcript file.
    assert_eq!(row.storage_path.as_deref(), Some("/tmp/inside.jsonl"));
    // The Kanban board and other card surfaces render these inline, so the
    // lightweight sidebar row must carry them (regression guard).
    assert_eq!(row.model.as_deref(), Some("model-a"));
    // The sidebar's git indicator reads this branch straight from the cache —
    // it is whatever the source app recorded, never a working-copy lookup.
    assert_eq!(row.branch.as_deref(), Some("main"));
    assert_eq!(row.total_tokens, 7); // input_tokens (3) + output_tokens (4)
    assert_eq!(row.files_changed, 1);
    assert_eq!(row.lines_added, 7);
    assert_eq!(row.lines_removed, 2);
    assert_eq!(row.touched_files, vec!["large/path.rs".to_string()]);
}

#[test]
fn upsert_stores_provider_scratch_dirs_as_no_workspace() {
    // The producing-boundary guard for the sidebar's "No Workspace" group: the
    // Codex desktop app reports its own per-conversation folder as the session
    // cwd, and persisting that as a workspace grew one group header per
    // conversation labelled with a bare date slug.
    let home = app_paths::external_history_home_dir();
    let scratch = home
        .join("Documents")
        .join("Codex")
        .join("2026-08-23")
        .join("do-a-quick-evaluation-of-users");
    let real = home.join("Documents").join("GitHub").join("ORGII");

    let mut conn = fixture_conn();
    let mut scratch_session = input(SOURCE_CODEX_APP, "scratch", 250);
    scratch_session.repo_path = Some(scratch.to_string_lossy().to_string());
    let mut real_session = input(SOURCE_CODEX_APP, "real", 260);
    real_session.repo_path = Some(real.to_string_lossy().to_string());
    upsert_imported_session_cache_from_conn(&mut conn, &[scratch_session, real_session])
        .expect("upsert");

    let cached = query_cached_session_from_conn(&conn, SOURCE_CODEX_APP, "scratch")
        .expect("query scratch")
        .expect("scratch row");
    assert_eq!(cached.repo_path, None);
    let cached_real = query_cached_session_from_conn(&conn, SOURCE_CODEX_APP, "real")
        .expect("query real")
        .expect("real row");
    assert_eq!(
        cached_real.repo_path.as_deref(),
        Some(real.to_string_lossy().as_ref())
    );

    // The canonical `sessions` row is written from the same input, so it must
    // agree — a divergence would re-introduce the phantom workspace in the
    // Data/Usage rollups that read the canonical table.
    let workspace_path: Option<String> = conn
        .query_row(
            "SELECT workspace_path FROM orgtrack_core_sessions WHERE session_id = ?1",
            rusqlite::params!["codex_app-scratch"],
            |row| row.get(0),
        )
        .expect("canonical session row");
    assert_eq!(workspace_path.as_deref().unwrap_or_default(), "");
}

#[test]
fn upsert_keeps_a_scratch_shaped_path_recorded_by_another_source() {
    // Same path, different app: the user really opened that directory in
    // OpenCode, so it stays a workspace.
    let path = app_paths::external_history_home_dir()
        .join("Documents")
        .join("Codex")
        .join("2026-08-23")
        .join("do-a-quick-evaluation-of-users");

    let mut conn = fixture_conn();
    let mut session = input(SOURCE_OPENCODE, "elsewhere", 250);
    session.repo_path = Some(path.to_string_lossy().to_string());
    upsert_imported_session_cache_from_conn(&mut conn, &[session]).expect("upsert");

    let cached = query_cached_session_from_conn(&conn, SOURCE_OPENCODE, "elsewhere")
        .expect("query")
        .expect("row");
    assert_eq!(
        cached.repo_path.as_deref(),
        Some(path.to_string_lossy().as_ref())
    );
}

#[test]
fn sidebar_query_reports_no_branch_for_sources_that_record_none() {
    let mut conn = fixture_conn();
    let mut branchless = input(SOURCE_CODEX_APP, "branchless", 250);
    branchless.branch = None;
    upsert_imported_session_cache_from_conn(&mut conn, &[branchless]).expect("upsert");

    let page =
        query_imported_sidebar_page_from_conn(&conn, SOURCE_CODEX_APP, Some(200), Some(300), 10, 0)
            .expect("sidebar page");

    // The upsert stores `None` as "", which must not reach the frontend as an
    // empty branch — that would render a git indicator with no branch at all.
    assert_eq!(page.sessions[0].branch, None);
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
fn continuation_election_connects_compaction_epochs_transitively() {
    let mut conn = fixture_conn();
    let mut root = input(SOURCE_CODEX_APP, "root", 100);
    root.source_metadata_json =
        continuation_metadata_json(Some("first-user-root"), &["compact-a".to_string()]);
    let mut middle = input(SOURCE_CODEX_APP, "middle", 200);
    middle.source_metadata_json = continuation_metadata_json(
        Some("first-user-middle"),
        &["compact-a".to_string(), "compact-b".to_string()],
    );
    let mut newest = input(SOURCE_CODEX_APP, "newest", 300);
    newest.source_metadata_json =
        continuation_metadata_json(Some("first-user-newest"), &["compact-b".to_string()]);
    upsert_imported_session_cache_from_conn(&mut conn, &[root, middle, newest]).expect("upsert");

    let demoted =
        demote_superseded_continuations_from_conn(&conn, SOURCE_CODEX_APP).expect("election");

    assert_eq!(demoted, 2);
    assert!(!listable_of(&conn, SOURCE_CODEX_APP, "root"));
    assert!(!listable_of(&conn, SOURCE_CODEX_APP, "middle"));
    assert!(listable_of(&conn, SOURCE_CODEX_APP, "newest"));
    for source_session_id in ["root", "middle", "newest"] {
        let metadata_json: String = conn
            .query_row(
                "SELECT source_metadata_json FROM imported_history_session_cache
                 WHERE source = ?1 AND source_session_id = ?2",
                rusqlite::params![SOURCE_CODEX_APP, source_session_id],
                |row| row.get(0),
            )
            .expect("metadata");
        assert_eq!(
            continuation_lineage_id_from_metadata_json(&metadata_json).as_deref(),
            Some("first-user-root")
        );
    }

    let page = query_imported_sidebar_page_from_conn(&conn, SOURCE_CODEX_APP, None, None, 10, 0)
        .expect("sidebar page");
    assert_eq!(page.sessions.len(), 1);
    assert_eq!(page.sessions[0].session_id, "codex_app-newest");
    assert_eq!(
        page.sessions[0].continuation_lineage_id.as_deref(),
        Some("first-user-root")
    );

    // A later continuation preserves the elected id even when its own group
    // key would sort before the original id.
    let mut later = input(SOURCE_CODEX_APP, "later", 400);
    later.source_metadata_json =
        continuation_metadata_json(Some("000-new-first-user"), &["compact-b".to_string()]);
    upsert_imported_session_cache_from_conn(&mut conn, &[later]).expect("upsert later");
    demote_superseded_continuations_from_conn(&conn, SOURCE_CODEX_APP).expect("second election");
    let later_metadata: String = conn
        .query_row(
            "SELECT source_metadata_json FROM imported_history_session_cache
             WHERE source = ?1 AND source_session_id = 'later'",
            [SOURCE_CODEX_APP],
            |row| row.get(0),
        )
        .expect("later metadata");
    assert_eq!(
        continuation_lineage_id_from_metadata_json(&later_metadata).as_deref(),
        Some("first-user-root")
    );
}

#[test]
fn continuation_election_survives_a_family_split_after_stamping() {
    // Deleting intermediate transcripts can disconnect a family's marker
    // graph AFTER the lineage was stamped. A later rescan reinserts an old
    // sibling as a fresh listable row with no stamp to inherit; only the
    // stamped lineage on the surviving member (whose value is the canonical
    // member's group key) reconnects the halves. Without lineage as a
    // connectivity key the election would list both halves' winners and the
    // duplicate row this feature removes would return.
    let mut conn = fixture_conn();
    let mut root = input(SOURCE_CODEX_APP, "root", 100);
    root.source_metadata_json =
        continuation_metadata_json(Some("first-user-root"), &["compact-a".to_string()]);
    let mut middle = input(SOURCE_CODEX_APP, "middle", 200);
    middle.source_metadata_json = continuation_metadata_json(
        Some("first-user-middle"),
        &["compact-a".to_string(), "compact-b".to_string()],
    );
    let mut newest = input(SOURCE_CODEX_APP, "newest", 300);
    newest.source_metadata_json =
        continuation_metadata_json(Some("first-user-newest"), &["compact-b".to_string()]);
    upsert_imported_session_cache_from_conn(&mut conn, &[root.clone(), middle, newest])
        .expect("upsert");
    demote_superseded_continuations_from_conn(&conn, SOURCE_CODEX_APP).expect("first election");

    // The intermediate transcript ages out and the old sibling's row is
    // dropped with it; a later rescan reinserts the old sibling from its
    // still-present file as a brand-new listable row without any stamp.
    for gone in ["middle", "root"] {
        conn.execute(
            "DELETE FROM imported_history_session_cache
             WHERE source = ?1 AND source_session_id = ?2",
            rusqlite::params![SOURCE_CODEX_APP, gone],
        )
        .expect("drop row");
    }
    upsert_imported_session_cache_from_conn(&mut conn, &[root]).expect("reinsert root");

    demote_superseded_continuations_from_conn(&conn, SOURCE_CODEX_APP).expect("second election");

    assert!(!listable_of(&conn, SOURCE_CODEX_APP, "root"));
    assert!(listable_of(&conn, SOURCE_CODEX_APP, "newest"));
    let root_metadata: String = conn
        .query_row(
            "SELECT source_metadata_json FROM imported_history_session_cache
             WHERE source = ?1 AND source_session_id = 'root'",
            [SOURCE_CODEX_APP],
            |row| row.get(0),
        )
        .expect("root metadata");
    assert_eq!(
        continuation_lineage_id_from_metadata_json(&root_metadata).as_deref(),
        Some("first-user-root")
    );
}

#[test]
fn rescan_upsert_preserves_a_stamped_lineage_id() {
    // A rescan replaces `source_metadata_json` with freshly parsed metadata
    // that never carries the elected lineage. The upsert must carry the stamp
    // over, or every rescan erodes the id the reveal/dedupe paths compare.
    let mut conn = fixture_conn();
    let mut row = input(SOURCE_CODEX_APP, "stamped", 100);
    row.source_metadata_json = Some(
        serde_json::json!({
            CONTINUATION_GROUP_KEY_FIELD: "first-user-a",
            CONTINUATION_MARKERS_FIELD: ["first-user-a", "compact-a"],
            CONTINUATION_LINEAGE_ID_FIELD: "elected-lineage",
        })
        .to_string(),
    );
    upsert_imported_session_cache_from_conn(&mut conn, &[row.clone()]).expect("initial upsert");

    row.source_metadata_json =
        continuation_metadata_json(Some("first-user-a"), &["compact-a".to_string()]);
    upsert_imported_session_cache_from_conn(&mut conn, &[row.clone()]).expect("rescan upsert");
    let metadata: String = conn
        .query_row(
            "SELECT source_metadata_json FROM imported_history_session_cache
             WHERE source = ?1 AND source_session_id = 'stamped'",
            [SOURCE_CODEX_APP],
            |row| row.get(0),
        )
        .expect("metadata");
    assert_eq!(
        continuation_lineage_id_from_metadata_json(&metadata).as_deref(),
        Some("elected-lineage")
    );

    // A rewrite that loses continuation identity drops the stamp with it.
    row.source_metadata_json = None;
    upsert_imported_session_cache_from_conn(&mut conn, &[row]).expect("keyless upsert");
    let metadata: String = conn
        .query_row(
            "SELECT source_metadata_json FROM imported_history_session_cache
             WHERE source = ?1 AND source_session_id = 'stamped'",
            [SOURCE_CODEX_APP],
            |row| row.get(0),
        )
        .expect("metadata");
    assert_eq!(metadata, "");
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
fn canonical_lookup_skips_continuation_superseded_siblings() {
    let mut conn = fixture_conn();
    let group = continuation_group_metadata_json(Some("family-uuid"));
    let mut older = input(SOURCE_CODEX_APP, "gen1", 100);
    older.source_metadata_json = group.clone();
    let mut newest = input(SOURCE_CODEX_APP, "gen2", 200);
    newest.source_metadata_json = group.clone();
    // A subagent in the same family must keep resolving: by-id resolution is
    // how the sidebar places children under their parent.
    let mut subagent = input(SOURCE_CODEX_APP, "child", 300);
    subagent.source_metadata_json = group;
    subagent.parent_session_id = Some("codex_app-gen2".to_string());
    upsert_imported_session_cache_from_conn(&mut conn, &[older, newest, subagent]).expect("upsert");

    // The superseded sibling resolves to None whether or not the election ran.
    assert!(
        query_cached_session_by_session_id_from_conn(&conn, "codex_app-gen1")
            .expect("query gen1")
            .is_none()
    );
    demote_superseded_continuations_from_conn(&conn, SOURCE_CODEX_APP).expect("election");
    assert!(
        query_cached_session_by_session_id_from_conn(&conn, "codex_app-gen1")
            .expect("query gen1 post-election")
            .is_none()
    );
    let (_, winner) = query_cached_session_by_session_id_from_conn(&conn, "codex_app-gen2")
        .expect("query gen2")
        .expect("winner resolves");
    assert_eq!(winner.source_session_id, "gen2");
    let (_, child) = query_cached_session_by_session_id_from_conn(&conn, "codex_app-child")
        .expect("query child")
        .expect("subagent resolves");
    assert_eq!(child.source_session_id, "child");
}

#[test]
fn including_superseded_lookup_resolves_demoted_continuation_siblings() {
    let mut conn = fixture_conn();
    let group = continuation_group_metadata_json(Some("family-uuid"));
    let mut older = input(SOURCE_CODEX_APP, "gen1", 100);
    older.source_metadata_json = group.clone();
    let mut newest = input(SOURCE_CODEX_APP, "gen2", 200);
    newest.source_metadata_json = group;
    upsert_imported_session_cache_from_conn(&mut conn, &[older, newest]).expect("upsert");
    demote_superseded_continuations_from_conn(&conn, SOURCE_CODEX_APP).expect("election");

    // The vanished-session sweep's existence check must see the demoted
    // sibling: it still exists locally and its shared cloud row must survive
    // a context-window continuation.
    let (_, demoted) =
        query_cached_session_by_session_id_including_superseded_from_conn(&conn, "codex_app-gen1")
            .expect("query gen1 including superseded")
            .expect("demoted sibling resolves");
    assert_eq!(demoted.source_session_id, "gen1");
    assert!(
        query_cached_session_by_session_id_from_conn(&conn, "codex_app-gen1")
            .expect("query gen1 default")
            .is_none()
    );
    // Truly absent ids stay absent on both paths.
    assert!(
        query_cached_session_by_session_id_including_superseded_from_conn(
            &conn,
            "codex_app-missing"
        )
        .expect("query missing")
        .is_none()
    );
}

#[test]
fn canonical_lookup_tolerates_legacy_non_json_metadata_rows() {
    let mut conn = fixture_conn();
    let group = continuation_group_metadata_json(Some("family-uuid"));
    let mut older = input(SOURCE_CODEX_APP, "gen1", 100);
    older.source_metadata_json = group.clone();
    let mut newest = input(SOURCE_CODEX_APP, "gen2", 200);
    newest.source_metadata_json = group;
    let keyless = input(SOURCE_CODEX_APP, "journal", 300);
    upsert_imported_session_cache_from_conn(&mut conn, &[older, newest, keyless]).expect("upsert");
    conn.execute(
        "UPDATE imported_history_session_cache SET source_metadata_json = 'not-json' \
         WHERE source = ?1 AND source_session_id = 'journal'",
        [SOURCE_CODEX_APP],
    )
    .expect("write corrupt metadata");
    let empty: String = conn
        .query_row(
            "SELECT source_metadata_json FROM imported_history_session_cache \
             WHERE source = ?1 AND source_session_id = 'gen1'",
            [SOURCE_CODEX_APP],
            |row| row.get(0),
        )
        .expect("read gen1 metadata");
    assert!(empty.starts_with('{'));
    let mut legacy_empty = input(SOURCE_CODEX_APP, "keyless", 50);
    legacy_empty.source_metadata_json = None;
    upsert_imported_session_cache_from_conn(&mut conn, &[legacy_empty])
        .expect("upsert legacy empty row");

    assert!(
        query_cached_session_by_session_id_from_conn(&conn, "codex_app-gen1")
            .expect("superseded lookup succeeds despite corrupt sibling rows")
            .is_none()
    );
    let (_, winner) = query_cached_session_by_session_id_from_conn(&conn, "codex_app-gen2")
        .expect("winner lookup succeeds despite corrupt sibling rows")
        .expect("winner resolves");
    assert_eq!(winner.source_session_id, "gen2");
    let (_, keyless_row) = query_cached_session_by_session_id_from_conn(&conn, "codex_app-journal")
        .expect("corrupt-metadata row still resolves by id")
        .expect("corrupt-metadata row present");
    assert_eq!(keyless_row.source_session_id, "journal");
}

#[test]
#[ignore]
fn real_db_copy_sibling_query_never_errors() {
    let path = std::env::var("ORGTRACK_REAL_DB_COPY").expect("set ORGTRACK_REAL_DB_COPY");
    let conn = Connection::open(&path).expect("open real db copy");
    let session_ids: Vec<String> = conn
        .prepare("SELECT session_id FROM imported_history_session_cache")
        .expect("prepare")
        .query_map([], |row| row.get(0))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("collect");
    let mut resolved = 0usize;
    let mut demoted = 0usize;
    for session_id in &session_ids {
        match query_cached_session_by_session_id_from_conn(&conn, session_id)
            .unwrap_or_else(|err| panic!("lookup failed for {session_id}: {err}"))
        {
            Some(_) => resolved += 1,
            None => demoted += 1,
        }
    }
    println!(
        "real-db-copy rows={} resolved={resolved} demoted={demoted}",
        session_ids.len()
    );
    assert_eq!(resolved + demoted, session_ids.len());
}

#[test]
fn source_cache_signature_tracks_upserts_demotions_and_prunes() {
    let mut conn = fixture_conn();
    let group = continuation_group_metadata_json(Some("family-uuid"));
    let mut older = input(SOURCE_CODEX_APP, "gen1", 100);
    older.source_metadata_json = group.clone();
    upsert_imported_session_cache_from_conn(&mut conn, &[older]).expect("upsert older");
    let after_first = query_source_cache_signature_from_conn(&conn, SOURCE_CODEX_APP)
        .expect("signature after first upsert");

    let mut newest = input(SOURCE_CODEX_APP, "gen2", 200);
    newest.source_metadata_json = group;
    upsert_imported_session_cache_from_conn(&mut conn, &[newest]).expect("upsert newest");
    let after_second = query_source_cache_signature_from_conn(&conn, SOURCE_CODEX_APP)
        .expect("signature after second upsert");
    assert_ne!(after_first, after_second);

    // A demotion flips listable without rewriting the row; the signature's
    // listable sum must still register it — this is exactly the change the
    // per-call "did my rescan write" reporting misses when another caller's
    // sync ran the election.
    demote_superseded_continuations_from_conn(&conn, SOURCE_CODEX_APP).expect("election");
    let after_demotion = query_source_cache_signature_from_conn(&conn, SOURCE_CODEX_APP)
        .expect("signature after demotion");
    assert_ne!(after_second, after_demotion);

    prune_missing_records_from_conn(&conn, SOURCE_CODEX_APP, &["gen2".to_string()]).expect("prune");
    let after_prune = query_source_cache_signature_from_conn(&conn, SOURCE_CODEX_APP)
        .expect("signature after prune");
    assert_ne!(after_demotion, after_prune);

    // Another source's rows never leak into this source's signature.
    upsert_imported_session_cache_from_conn(&mut conn, &[input(SOURCE_OPENCODE, "other", 400)])
        .expect("upsert other source");
    assert_eq!(
        after_prune,
        query_source_cache_signature_from_conn(&conn, SOURCE_CODEX_APP)
            .expect("signature after unrelated upsert")
    );
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

#[test]
fn continuation_metadata_bounds_and_deduplicates_markers() {
    let markers = (0..100)
        .map(|index| format!("marker-{index}"))
        .collect::<Vec<_>>();
    let json = continuation_metadata_json(Some("marker-0"), &markers).expect("metadata");
    let parsed: serde_json::Value = serde_json::from_str(&json).expect("parse");
    let stored = parsed
        .get(CONTINUATION_MARKERS_FIELD)
        .and_then(serde_json::Value::as_array)
        .expect("markers");
    assert_eq!(stored.len(), MAX_CONTINUATION_MARKERS);
    assert_eq!(stored[0].as_str(), Some("marker-0"));
    assert_eq!(
        stored
            .iter()
            .filter(|marker| marker.as_str() == Some("marker-0"))
            .count(),
        1
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
    for index_name in [
        "idx_imported_history_sidebar_order",
        "idx_imported_history_parent_created",
    ] {
        let index_exists: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'index' AND name = ?1",
                [index_name],
                |row| Ok(row.get::<_, i64>(0)? == 1),
            )
            .expect("query index presence");
        assert!(index_exists, "{index_name} should be created");
    }

    let query_plan: String = conn
        .query_row(
            "EXPLAIN QUERY PLAN
             SELECT session_id, source_session_id, created_at_ms, source_metadata_json
             FROM imported_history_session_cache
             WHERE source = ?1
               AND parent_session_id = ?2
               AND parent_session_id != ''
             ORDER BY created_at_ms ASC, source_session_id ASC",
            ["codex_app", "codexapp-parent"],
            |row| row.get(3),
        )
        .expect("query child-session lookup plan");
    assert!(
        query_plan.contains("idx_imported_history_parent_created"),
        "child-session lookup should use its parent index: {query_plan}"
    );
}

#[test]
fn imported_pins_round_trip_and_clear() {
    let conn = fixture_conn();
    let ids = super::pinned_imported_session_ids_from_conn(&conn).expect("read pins");
    assert!(ids.is_empty(), "a fresh store has no pins");

    super::set_imported_session_pinned_from_conn(
        &conn,
        "claudecodeapp-abc",
        true,
        "2026-08-03T12:00:00Z",
    )
    .expect("set pin");
    let ids = super::pinned_imported_session_ids_from_conn(&conn).expect("read pins");
    assert!(ids.contains("claudecodeapp-abc"));

    // Re-pinning must not duplicate the row (PRIMARY KEY + upsert).
    super::set_imported_session_pinned_from_conn(
        &conn,
        "claudecodeapp-abc",
        true,
        "2026-08-03T13:00:00Z",
    )
    .expect("re-pin");
    assert_eq!(
        super::pinned_imported_session_ids_from_conn(&conn)
            .expect("read pins")
            .len(),
        1
    );

    super::set_imported_session_pinned_from_conn(&conn, "claudecodeapp-abc", false, "")
        .expect("unpin");
    assert!(super::pinned_imported_session_ids_from_conn(&conn)
        .expect("read pins")
        .is_empty());
}

#[test]
fn a_source_wide_prune_does_not_erase_pins() {
    // The whole reason pins live in their own table: `prune_missing_records_from_conn`
    // deletes every cache row of a source whose store momentarily reads as empty
    // (unreadable directory, provider not installed yet). A `pinned` column on the
    // cache row would let that wipe the user's pins.
    let mut conn = fixture_conn();
    upsert_imported_session_cache_from_conn(&mut conn, &[input(SOURCE_CODEX_APP, "s1", 10)])
        .expect("seed cache row");
    super::set_imported_session_pinned_from_conn(
        &conn,
        "codexapp-s1",
        true,
        "2026-08-03T12:00:00Z",
    )
    .expect("pin");

    super::prune_missing_records_from_conn(&conn, SOURCE_CODEX_APP, &[])
        .expect("prune everything for the source");

    let pins = super::pinned_imported_session_ids_from_conn(&conn).expect("read pins");
    assert!(
        pins.contains("codexapp-s1"),
        "a prune of the rebuildable projection must not take user pin state with it"
    );
}

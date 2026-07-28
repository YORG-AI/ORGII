use super::*;
use crate::test_utils::test_env;
use core_types::key_source::KeySource;
use orgtrack_core::sources::imported_history::{
    cache::upsert_imported_session_cache_from_conn,
    metadata::{
        ImportedHistoryCacheInput, ImportedHistoryImpactStats, SOURCE_CODEX_APP, SOURCE_OPENCODE,
    },
};

fn seed_native(
    session_id: &str,
    name: &str,
    updated_at: &str,
    org_id: Option<&str>,
    workspace_path: Option<&str>,
    pinned: bool,
) {
    session_persistence::upsert_session(&session_persistence::UnifiedSessionRecord {
        session_id: session_id.to_string(),
        name: name.to_string(),
        status: agent_core::session::SessionStatus::Completed
            .as_str()
            .to_string(),
        created_at: updated_at.to_string(),
        updated_at: updated_at.to_string(),
        session_type: session_type::CODING.to_string(),
        org_id: org_id.map(str::to_string),
        workspace_path: workspace_path.map(str::to_string),
        pinned,
        key_source: KeySource::OwnKey,
        ..Default::default()
    })
    .expect("seed native sidebar discovery row");
}

fn seed_cli(session_id: &str, updated_at: &str) {
    let conn = get_connection().expect("open sandbox DB");
    conn.execute(
        "INSERT INTO code_sessions
                 (session_id, name, status, flow, runner, cli_agent_type,
                  created_at, updated_at)
             VALUES (?1, ?1, 'completed', 'quick', 'local', 'opencode', ?2, ?2)
             ON CONFLICT(session_id) DO UPDATE SET updated_at = excluded.updated_at",
        params![session_id, updated_at],
    )
    .expect("seed managed CLI sidebar row");
}

fn imported_input(
    source: &'static str,
    source_session_id: &str,
    name: &str,
    updated_at_ms: i64,
    repo_path: Option<&str>,
) -> ImportedHistoryCacheInput {
    ImportedHistoryCacheInput {
        source,
        source_session_id: source_session_id.to_string(),
        session_id: format!("{source}-{source_session_id}"),
        source_path: format!("/tmp/{source_session_id}.jsonl"),
        source_record_key: source_session_id.to_string(),
        source_mtime_ms: updated_at_ms,
        source_size_bytes: 1,
        source_fingerprint: format!("fingerprint-{source_session_id}"),
        parser_version: 1,
        name: name.to_string(),
        created_at_ms: updated_at_ms,
        updated_at_ms,
        model: None,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        repo_path: repo_path.map(str::to_string),
        branch: None,
        impact: ImportedHistoryImpactStats::default(),
        listable: true,
        source_metadata_json: None,
        parent_session_id: None,
    }
}

fn candidate_ids(rows: Vec<SidebarSessionCandidate>) -> Vec<String> {
    rows.into_iter().map(|row| row.session_id).collect()
}

#[test]
fn org_scope_normalizes_personal_and_accepts_cloud_aliases() {
    let _sandbox = test_env::sandbox();
    for (session_id, org_id) in [
        ("personal-null", None),
        ("personal-empty", Some("")),
        ("personal-explicit", Some(PERSONAL_ORG_ID)),
        ("cloud-namespaced", Some("cloud:alpha")),
        ("cloud-bare", Some("alpha")),
        ("cloud-other", Some("beta")),
    ] {
        seed_native(
            session_id,
            "scope needle",
            "2026-07-26T12:00:00Z",
            org_id,
            Some("/repo"),
            false,
        );
    }
    let conn = get_connection().expect("open sandbox DB");
    let query = |org_ids: Vec<String>| {
        candidate_ids(
            query_search_or_pinned_candidates(
                &conn,
                SearchOrPinnedRequest {
                    query: Some("scope needle"),
                    pinned_only: false,
                    org_ids: Some(&org_ids),
                    include_external: false,
                    disabled_sources: &[],
                    before: None,
                    limit: 50,
                    offset: 0,
                },
            )
            .expect("query scoped search"),
        )
    };

    let personal = query(vec![PERSONAL_ORG_ID.to_string()]);
    assert_eq!(
        personal.into_iter().collect::<BTreeSet<_>>(),
        [
            "personal-null".to_string(),
            "personal-empty".to_string(),
            "personal-explicit".to_string()
        ]
        .into_iter()
        .collect()
    );
    let cloud = query(vec!["cloud:alpha".to_string(), "alpha".to_string()]);
    assert_eq!(
        cloud.into_iter().collect::<BTreeSet<_>>(),
        ["cloud-namespaced".to_string(), "cloud-bare".to_string()]
            .into_iter()
            .collect()
    );
}

#[test]
fn search_and_pinned_predicates_run_before_the_page_limit() {
    let _sandbox = test_env::sandbox();
    for index in 0..60 {
        seed_native(
            &format!("newer-{index:02}"),
            "ordinary newer row",
            &format!("2026-07-26T12:{index:02}:00Z"),
            None,
            Some("/new"),
            false,
        );
    }
    seed_native(
        "old-unique-search",
        "uniquely searchable historical row",
        "2026-07-01T00:00:00Z",
        None,
        Some("/old"),
        false,
    );
    seed_native(
        "old-pinned",
        "old pinned row",
        "2026-06-03T00:00:00Z",
        None,
        Some("/old"),
        true,
    );
    seed_native(
        "older-pinned",
        "older pinned row",
        "2026-06-02T00:00:00Z",
        None,
        Some("/old"),
        true,
    );
    seed_native(
        "oldest-pinned",
        "oldest pinned row",
        "2026-06-01T00:00:00Z",
        None,
        Some("/old"),
        true,
    );
    let conn = get_connection().expect("open sandbox DB");
    let personal = vec![PERSONAL_ORG_ID.to_string()];

    let search = query_search_or_pinned_candidates(
        &conn,
        SearchOrPinnedRequest {
            query: Some("uniquely searchable"),
            pinned_only: false,
            org_ids: Some(&personal),
            include_external: false,
            disabled_sources: &[],
            before: None,
            limit: 50,
            offset: 0,
        },
    )
    .expect("search old row");
    assert_eq!(candidate_ids(search), vec!["old-unique-search"]);

    let pinned = query_search_or_pinned_candidates(
        &conn,
        SearchOrPinnedRequest {
            query: None,
            pinned_only: true,
            org_ids: Some(&personal),
            include_external: true,
            disabled_sources: &[],
            before: None,
            limit: 2,
            offset: 0,
        },
    )
    .expect("query old pinned row");
    assert_eq!(candidate_ids(pinned), vec!["old-pinned", "older-pinned"]);
    seed_native(
        "new-pinned",
        "new pinned row",
        "2026-07-27T00:00:00Z",
        None,
        Some("/new"),
        true,
    );
    let pinned_tail = query_search_or_pinned_candidates(
        &conn,
        SearchOrPinnedRequest {
            query: None,
            pinned_only: true,
            org_ids: Some(&personal),
            include_external: false,
            disabled_sources: &[],
            before: Some(SidebarSeekCursor {
                updated_at: "2026-06-02T00:00:00Z",
                session_id: "older-pinned",
            }),
            limit: 50,
            offset: 2,
        },
    )
    .expect("query stable pinned tail");
    assert_eq!(candidate_ids(pinned_tail), vec!["oldest-pinned"]);
}

#[test]
fn native_and_cli_seek_pages_ignore_newer_mutations_without_skipping_static_rows() {
    let _sandbox = test_env::sandbox();
    for (session_id, updated_at) in [
        ("sdeagent-four", "2026-07-26T04:00:00Z"),
        ("sdeagent-three", "2026-07-26T03:00:00Z"),
        ("sdeagent-two", "2026-07-26T02:00:00Z"),
        ("sdeagent-one", "2026-07-26T01:00:00Z"),
    ] {
        seed_native(session_id, session_id, updated_at, None, None, false);
    }
    let first = load_scoped_rust_agent_group_page(RustAgentGroupPageRequest {
        group: "sde",
        org_ids: None,
        repo_path: None,
        missing_repo_path: false,
        updated_after_ms: None,
        updated_before_ms: None,
        before: None,
        limit: 2,
        offset: 0,
    })
    .expect("first native seek page");
    assert_eq!(
        first
            .iter()
            .map(|session| session.session_id.as_str())
            .collect::<Vec<_>>(),
        ["sdeagent-four", "sdeagent-three"]
    );
    let cursor_updated_at = first[1].updated_at.clone();
    let cursor_session_id = first[1].session_id.clone();

    // A new top row and an already-consumed row moving to the top cannot
    // shift a descending seek boundary or make page two repeat them.
    seed_native(
        "sdeagent-new",
        "new",
        "2026-07-26T06:00:00Z",
        None,
        None,
        false,
    );
    seed_native(
        "sdeagent-four",
        "four",
        "2026-07-26T05:00:00Z",
        None,
        None,
        false,
    );
    let second = load_scoped_rust_agent_group_page(RustAgentGroupPageRequest {
        group: "sde",
        org_ids: None,
        repo_path: None,
        missing_repo_path: false,
        updated_after_ms: None,
        updated_before_ms: None,
        before: Some(SidebarSeekCursor {
            updated_at: &cursor_updated_at,
            session_id: &cursor_session_id,
        }),
        limit: 2,
        // A cursor must win over a stale compatibility offset.
        offset: 99,
    })
    .expect("second native seek page");
    assert_eq!(
        second
            .iter()
            .map(|session| session.session_id.as_str())
            .collect::<Vec<_>>(),
        ["sdeagent-two", "sdeagent-one"]
    );

    for (session_id, updated_at) in [
        ("cliagent-four", "2026-07-26T04:00:00Z"),
        ("cliagent-three", "2026-07-26T03:00:00Z"),
        ("cliagent-two", "2026-07-26T02:00:00Z"),
        ("cliagent-one", "2026-07-26T01:00:00Z"),
    ] {
        seed_cli(session_id, updated_at);
    }
    let first_cli = load_scoped_cli_page(CliPageRequest {
        org_ids: None,
        repo_path: None,
        missing_repo_path: false,
        updated_after_ms: None,
        updated_before_ms: None,
        before: None,
        limit: 2,
        offset: 0,
    })
    .expect("first CLI seek page");
    let cli_cursor_updated_at = first_cli[1].updated_at.clone();
    let cli_cursor_session_id = first_cli[1].session_id.clone();
    seed_cli("cliagent-new", "2026-07-26T06:00:00Z");
    seed_cli("cliagent-four", "2026-07-26T05:00:00Z");
    let second_cli = load_scoped_cli_page(CliPageRequest {
        org_ids: None,
        repo_path: None,
        missing_repo_path: false,
        updated_after_ms: None,
        updated_before_ms: None,
        before: Some(SidebarSeekCursor {
            updated_at: &cli_cursor_updated_at,
            session_id: &cli_cursor_session_id,
        }),
        limit: 2,
        offset: 99,
    })
    .expect("second CLI seek page");
    assert_eq!(
        second_cli
            .iter()
            .map(|session| session.session_id.as_str())
            .collect::<Vec<_>>(),
        ["cliagent-two", "cliagent-one"]
    );
}

#[test]
fn refreshed_first_page_surfaces_an_unconsumed_row_that_moves_above_the_cursor() {
    let _sandbox = test_env::sandbox();
    for (session_id, updated_at) in [
        ("sdeagent-three", "2026-07-26T03:00:00Z"),
        ("sdeagent-two", "2026-07-26T02:00:00Z"),
        ("sdeagent-one", "2026-07-26T01:00:00Z"),
    ] {
        seed_native(session_id, session_id, updated_at, None, None, false);
    }
    let first = load_scoped_rust_agent_group_page(RustAgentGroupPageRequest {
        group: "sde",
        org_ids: None,
        repo_path: None,
        missing_repo_path: false,
        updated_after_ms: None,
        updated_before_ms: None,
        before: None,
        limit: 1,
        offset: 0,
    })
    .expect("first page");
    let cursor_updated_at = first[0].updated_at.clone();
    let cursor_session_id = first[0].session_id.clone();

    // Keyset pagination is a stable walk of the old tail. A row that was
    // not consumed and then becomes newer than the cursor belongs to the
    // live/refresh head, not to the old-tail continuation.
    seed_native(
        "sdeagent-two",
        "two moved",
        "2026-07-26T04:00:00Z",
        None,
        None,
        false,
    );
    let tail = load_scoped_rust_agent_group_page(RustAgentGroupPageRequest {
        group: "sde",
        org_ids: None,
        repo_path: None,
        missing_repo_path: false,
        updated_after_ms: None,
        updated_before_ms: None,
        before: Some(SidebarSeekCursor {
            updated_at: &cursor_updated_at,
            session_id: &cursor_session_id,
        }),
        limit: 10,
        offset: 0,
    })
    .expect("stable old tail");
    assert_eq!(
        tail.iter()
            .map(|session| session.session_id.as_str())
            .collect::<Vec<_>>(),
        ["sdeagent-one"]
    );
    let refreshed = load_scoped_rust_agent_group_page(RustAgentGroupPageRequest {
        group: "sde",
        org_ids: None,
        repo_path: None,
        missing_repo_path: false,
        updated_after_ms: None,
        updated_before_ms: None,
        before: None,
        limit: 1,
        offset: 0,
    })
    .expect("refreshed head");
    assert_eq!(refreshed[0].session_id, "sdeagent-two");
}

#[test]
fn workspace_facets_include_old_only_and_no_workspace_groups() {
    let _sandbox = test_env::sandbox();
    seed_native(
        "new-main",
        "new main",
        "2026-07-26T12:00:00Z",
        None,
        Some("/repo/main"),
        false,
    );
    seed_native(
        "old-only",
        "old only",
        "2026-06-01T00:00:00Z",
        None,
        Some("/repo/old-only/"),
        false,
    );
    seed_native(
        "no-workspace",
        "no workspace",
        "2026-05-01T00:00:00Z",
        None,
        None,
        false,
    );
    seed_native(
        "pinned-only-workspace",
        "pinned only workspace",
        "2026-04-01T00:00:00Z",
        None,
        Some("/repo/pinned-only"),
        true,
    );
    let conn = get_connection().expect("open sandbox DB");
    let personal = vec![PERSONAL_ORG_ID.to_string()];
    let first = query_workspace_facets(
        &conn,
        WorkspaceFacetQuery {
            org_ids: &personal,
            include_external: false,
            disabled_sources: &[],
            before: None,
            limit: 2,
            offset: 0,
        },
    )
    .expect("query workspace facets");
    assert_eq!(
        first
            .iter()
            .map(|facet| facet.repo_path.as_deref())
            .collect::<Vec<_>>(),
        [Some("/repo/main"), Some("/repo/old-only")]
    );
    seed_native(
        "new-workspace",
        "new workspace",
        "2026-07-27T00:00:00Z",
        None,
        Some("/repo/new"),
        false,
    );
    let tail = query_workspace_facets(
        &conn,
        WorkspaceFacetQuery {
            org_ids: &personal,
            include_external: false,
            disabled_sources: &[],
            before: Some(WorkspaceFacetSeekCursor {
                last_updated_at_ms: first[1].last_updated_at_ms,
                repo_path: first[1].repo_path.as_deref(),
            }),
            limit: 50,
            offset: 2,
        },
    )
    .expect("query stable workspace tail");
    assert_eq!(tail.len(), 1);
    assert_eq!(tail[0].repo_path, None);
    assert!(
        first
            .iter()
            .chain(tail.iter())
            .all(|facet| facet.repo_path.as_deref() != Some("/repo/pinned-only")),
        "a workspace represented only by pinned rows belongs in Pinned, not an empty section"
    );
}

#[test]
fn imported_discovery_is_personal_listable_and_source_gated() {
    let _sandbox = test_env::sandbox();
    let mut conn = get_connection().expect("open sandbox DB");
    let mut hidden = imported_input(
        SOURCE_CODEX_APP,
        "hidden",
        "imported needle hidden",
        300,
        Some("/hidden"),
    );
    hidden.listable = false;
    let mut child = imported_input(
        SOURCE_CODEX_APP,
        "child",
        "imported needle child",
        250,
        Some("/child"),
    );
    child.parent_session_id = Some("codex_app-root".to_string());
    upsert_imported_session_cache_from_conn(
        &mut conn,
        &[
            imported_input(
                SOURCE_CODEX_APP,
                "visible",
                "imported needle visible",
                200,
                Some("/visible"),
            ),
            imported_input(
                SOURCE_OPENCODE,
                "disabled",
                "imported needle disabled",
                100,
                Some("/disabled"),
            ),
            hidden,
            child,
        ],
    )
    .expect("seed imported sidebar rows");

    let personal = vec![PERSONAL_ORG_ID.to_string()];
    let disabled = vec![SOURCE_OPENCODE.to_string()];
    let rows = query_search_or_pinned_candidates(
        &conn,
        SearchOrPinnedRequest {
            query: Some("imported needle"),
            pinned_only: false,
            org_ids: Some(&personal),
            include_external: true,
            disabled_sources: &disabled,
            before: None,
            limit: 50,
            offset: 0,
        },
    )
    .expect("query imported discovery");
    assert_eq!(candidate_ids(rows), vec!["codex_app-visible"]);

    let cloud = vec!["cloud:alpha".to_string(), "alpha".to_string()];
    let rows = query_search_or_pinned_candidates(
        &conn,
        SearchOrPinnedRequest {
            query: Some("imported needle"),
            pinned_only: false,
            org_ids: Some(&cloud),
            include_external: true,
            disabled_sources: &[],
            before: None,
            limit: 50,
            offset: 0,
        },
    )
    .expect("query cloud imported discovery");
    assert!(rows.is_empty());
}

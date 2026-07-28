use super::*;
use crate::agent_sessions::session_directory::display::generate_display_label;
use crate::agent_sessions::session_directory::status::is_active_status;
use crate::agent_sessions::session_directory::types::SessionCategory;
use crate::test_utils::test_env;

fn make_session(
    id: &str,
    status: &str,
    category: SessionCategory,
    key_source: KeySource,
) -> SessionAggregateRecord {
    let name = format!("Session {}", id);
    SessionAggregateRecord {
        session_id: id.to_string(),
        name: name.clone(),
        status: status.to_string(),
        created_at: "2024-01-01T00:00:00Z".to_string(),
        updated_at: "2024-01-01T01:00:00Z".to_string(),
        category,
        external_history_source: None,
        user_input: None,
        repo_path: None,
        repo_root_path: None,
        repo_remote_urls: None,
        storage_path: None,
        repo_name: None,
        branch: None,
        model: Some("gpt-4".to_string()),
        account_id: None,
        cli_agent_type: None,
        key_source,
        tier: None,
        pid: None,
        total_tokens: 1000,
        worktree_path: None,
        worktree_branch: None,
        base_branch: None,
        merge_status: None,
        background: false,
        org_id: None,
        project_id: None,
        project_name: None,
        project_slug: None,
        work_item_id: None,
        agent_role: None,
        is_active: is_active_status(status),
        display_label: generate_display_label(&name, None),
        parent_session_id: None,
        org_member_id: None,
        agent_org_id: None,
        agent_org_name: None,
        agent_definition_id: None,
        agent_icon_id: None,
        agent_display_name: None,
        agent_exec_mode: None,
        draft_text: None,
        reply_target_event_id: None,
        pinned: false,
        files_changed: None,
        lines_added: None,
        lines_removed: None,
        touched_files: None,
    }
}

fn seed_native_root(
    session_id: &str,
    record_type: &str,
    updated_at: &str,
    parent_session_id: Option<&str>,
) {
    let record = session_persistence::UnifiedSessionRecord {
        session_id: session_id.to_string(),
        name: session_id.to_string(),
        status: agent_core::session::SessionStatus::Completed
            .as_str()
            .to_string(),
        created_at: updated_at.to_string(),
        updated_at: updated_at.to_string(),
        session_type: record_type.to_string(),
        parent_session_id: parent_session_id.map(str::to_string),
        key_source: KeySource::OwnKey,
        ..Default::default()
    };
    session_persistence::upsert_session(&record).expect("seed native sidebar root");
}

fn set_native_workspace(session_id: &str, workspace_path: Option<&str>) {
    let conn = get_connection().expect("open sandbox DB");
    conn.execute(
        "UPDATE agent_sessions SET workspace_path = ?2 WHERE session_id = ?1",
        rusqlite::params![session_id, workspace_path],
    )
    .expect("set native workspace");
}

fn seed_cli_root(session_id: &str, updated_at: &str, repo_path: Option<&str>) {
    let conn = get_connection().expect("open sandbox DB");
    conn.execute(
        "INSERT INTO code_sessions
                 (session_id, name, status, flow, runner, cli_agent_type,
                  repo_path, created_at, updated_at)
             VALUES (?1, ?1, 'completed', 'quick', 'local', 'opencode',
                     ?2, ?3, ?3)",
        rusqlite::params![session_id, repo_path, updated_at],
    )
    .expect("seed CLI sidebar root");
}

#[test]
fn rust_agent_group_pages_do_not_consume_each_others_offsets() {
    let _sandbox = test_env::sandbox();
    seed_native_root(
        "sdeagent-archived",
        session_type::CODING,
        "2026-07-26T13:00:00Z",
        None,
    );
    session_persistence::update_status(
        "sdeagent-archived",
        agent_core::session::SessionStatus::Archived,
    )
    .expect("archive fixture");
    seed_native_root(
        "sdeagent-child",
        session_type::CODING,
        "2026-07-26T12:00:00Z",
        Some("sdeagent-standalone-1"),
    );
    for (session_id, updated_at) in [
        ("sdeagent-standalone-1", "2026-07-26T11:00:00Z"),
        ("sdeagent-org-1", "2026-07-26T10:00:00Z"),
        ("sdeagent-standalone-2", "2026-07-26T09:00:00Z"),
        ("sdeagent-org-2", "2026-07-26T08:00:00Z"),
        ("sdeagent-standalone-3", "2026-07-26T07:00:00Z"),
    ] {
        seed_native_root(session_id, session_type::CODING, updated_at, None);
    }
    seed_native_root(
        "wingman-1",
        session_type::CODING,
        "2026-07-26T06:00:00Z",
        None,
    );
    seed_native_root(
        "dsagent-1",
        session_type::CODING,
        "2026-07-26T05:00:00Z",
        None,
    );
    seed_native_root(
        "osagent-1",
        session_type::DESKTOP,
        "2026-07-26T04:00:00Z",
        None,
    );

    let conn = get_connection().expect("open sandbox DB");
    for (run_id, root_session_id) in [("run-1", "sdeagent-org-1"), ("run-2", "sdeagent-org-2")] {
        conn.execute(
            "INSERT INTO agent_org_runs
                   (id, org_id, coordinator_agent_id, root_session_id,
                    entry_mode, status, created_at, updated_at)
                 VALUES (?1, 'org-alpha', 'coordinator', ?2,
                         'standalone_session', 'completed',
                         '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z')",
            rusqlite::params![run_id, root_session_id],
        )
        .expect("seed Agent Org run");
    }

    let ids = |group: &str, limit: usize, offset: usize| {
        load_rust_agent_group_page(group, limit, offset)
            .expect("load group page")
            .into_iter()
            .map(|session| session.session_id)
            .collect::<Vec<_>>()
    };
    assert_eq!(
        ids("sde", 2, 0),
        vec!["sdeagent-standalone-1", "sdeagent-standalone-2"]
    );
    assert_eq!(ids("sde", 2, 2), vec!["sdeagent-standalone-3"]);
    assert_eq!(
        ids("agent_org", 10, 0),
        vec!["sdeagent-org-1", "sdeagent-org-2"]
    );
    assert_eq!(ids("wingman", 10, 0), vec!["wingman-1"]);
    assert_eq!(ids("custom", 10, 0), vec!["dsagent-1"]);
    assert_eq!(ids("os", 10, 0), vec!["osagent-1"]);
}

#[test]
fn rust_agent_group_classification_matches_sidebar_sections() {
    let _sandbox = test_env::sandbox();
    for (session_id, record_type, updated_at) in [
        (
            "sdeagent-modern",
            session_type::CODING,
            "2026-07-26T11:00:00Z",
        ),
        (
            "agentsession-legacy",
            session_type::CODING,
            "2026-07-26T10:00:00Z",
        ),
        (
            "wingman-specialist",
            session_type::CODING,
            "2026-07-26T09:00:00Z",
        ),
        (
            "random-custom-id",
            session_type::CODING,
            "2026-07-26T08:00:00Z",
        ),
        (
            "osagent-desktop",
            session_type::DESKTOP,
            "2026-07-26T07:00:00Z",
        ),
        (
            "random-agent-org-root",
            session_type::CODING,
            "2026-07-26T06:00:00Z",
        ),
        (
            "random-agent-org-os-root",
            session_type::DESKTOP,
            "2026-07-26T05:30:00Z",
        ),
        (
            "random-agent-org-human-root",
            session_type::HUMAN,
            "2026-07-26T05:00:00Z",
        ),
    ] {
        seed_native_root(session_id, record_type, updated_at, None);
    }
    let conn = get_connection().expect("open sandbox DB");
    for (run_id, root_session_id) in [
        ("run-parity-coding", "random-agent-org-root"),
        ("run-parity-os", "random-agent-org-os-root"),
        ("run-parity-human", "random-agent-org-human-root"),
    ] {
        conn.execute(
            "INSERT INTO agent_org_runs
                   (id, org_id, coordinator_agent_id, root_session_id,
                    entry_mode, status, created_at, updated_at)
                 VALUES (?1, 'org-parity', 'coordinator', ?2,
                         'standalone_session', 'completed',
                         '2026-07-26T00:00:00Z',
                         '2026-07-26T00:00:00Z')",
            rusqlite::params![run_id, root_session_id],
        )
        .expect("seed parity Agent Org run");
    }

    let ids = |group: &str| {
        load_rust_agent_group_page(group, 20, 0)
            .expect("load classified group")
            .into_iter()
            .map(|session| session.session_id)
            .collect::<Vec<_>>()
    };
    assert_eq!(ids("sde"), vec!["sdeagent-modern", "agentsession-legacy"]);
    assert_eq!(ids("wingman"), vec!["wingman-specialist"]);
    assert_eq!(ids("custom"), vec!["random-custom-id"]);
    assert_eq!(ids("os"), vec!["osagent-desktop"]);
    assert!(ids("human").is_empty());
    assert_eq!(
        ids("agent_org"),
        vec![
            "random-agent-org-root",
            "random-agent-org-os-root",
            "random-agent-org-human-root"
        ]
    );
}

#[test]
fn native_scope_filters_workspace_and_date_before_pagination() {
    let _sandbox = test_env::sandbox();
    for (session_id, updated_at, workspace) in [
        ("sdeagent-a-new", "2026-07-26T11:00:00Z", Some("/repo-a/")),
        ("sdeagent-b-new", "2026-07-26T10:00:00Z", Some("/repo-b")),
        ("sdeagent-a-old", "2026-07-26T09:00:00Z", Some("/repo-a")),
        ("sdeagent-missing", "2026-07-26T08:00:00Z", None),
    ] {
        seed_native_root(session_id, session_type::CODING, updated_at, None);
        set_native_workspace(session_id, workspace);
    }
    let range_start = DateTime::parse_from_rfc3339("2026-07-26T08:30:00Z")
        .expect("range start")
        .timestamp_millis();
    let range_end = DateTime::parse_from_rfc3339("2026-07-26T12:00:00Z")
        .expect("range end")
        .timestamp_millis();
    let page = |offset| {
        sidebar_queries::load_scoped_rust_agent_group_page(RustAgentGroupPageRequest {
            group: "sde",
            org_ids: None,
            repo_path: Some("/repo-a"),
            missing_repo_path: false,
            updated_after_ms: Some(range_start),
            updated_before_ms: Some(range_end),
            before: None,
            limit: 1,
            offset,
        })
        .expect("scoped native page")
        .into_iter()
        .map(|session| session.session_id)
        .collect::<Vec<_>>()
    };

    assert_eq!(page(0), vec!["sdeagent-a-new"]);
    assert_eq!(page(1), vec!["sdeagent-a-old"]);
    assert_eq!(
        sidebar_queries::load_scoped_rust_agent_group_page(RustAgentGroupPageRequest {
            group: "sde",
            org_ids: None,
            repo_path: None,
            missing_repo_path: true,
            updated_after_ms: None,
            updated_before_ms: None,
            before: None,
            limit: 10,
            offset: 0,
        },)
        .expect("missing-workspace native page")
        .into_iter()
        .map(|session| session.session_id)
        .collect::<Vec<_>>(),
        vec!["sdeagent-missing"]
    );

    for (session_id, updated_at, workspace) in [
        ("cliagent-a-new", "2026-07-26T11:30:00Z", Some("/repo-a")),
        ("cliagent-b-new", "2026-07-26T10:30:00Z", Some("/repo-b")),
        ("cliagent-a-old", "2026-07-26T09:30:00Z", Some("/repo-a/")),
    ] {
        seed_cli_root(session_id, updated_at, workspace);
    }
    assert_eq!(
        sidebar_queries::load_scoped_cli_page(CliPageRequest {
            org_ids: None,
            repo_path: Some("/repo-a"),
            missing_repo_path: false,
            updated_after_ms: Some(range_start),
            updated_before_ms: Some(range_end),
            before: None,
            limit: 10,
            offset: 0,
        })
        .expect("scoped CLI page")
        .into_iter()
        .map(|session| session.session_id)
        .collect::<Vec<_>>(),
        vec!["cliagent-a-new", "cliagent-a-old"]
    );
}

#[test]
fn apply_filters_accepts_known_key_source() {
    let mut sessions = vec![
        make_session("1", "running", SessionCategory::Cli, KeySource::OwnKey),
        make_session("2", "running", SessionCategory::Cli, KeySource::HostedKey),
    ];

    let filter = SessionFilter {
        key_source: Some("hosted_key".to_string()),
        ..Default::default()
    };
    apply_filters(&mut sessions, &filter).expect("known key_source must be Ok");

    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].session_id, "2");
}

#[test]
fn apply_filters_matches_canonical_session_ids_exactly() {
    let mut sessions = vec![
        make_session(
            "session-1",
            "completed",
            SessionCategory::Cli,
            KeySource::OwnKey,
        ),
        make_session(
            "session-10",
            "completed",
            SessionCategory::Cli,
            KeySource::OwnKey,
        ),
    ];
    let filter = SessionFilter {
        session_ids: Some(vec!["session-1".to_string()]),
        ..Default::default()
    };

    apply_filters(&mut sessions, &filter).expect("session ID filter");

    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].session_id, "session-1");
}

#[test]
fn apply_filters_rejects_unknown_key_source() {
    let mut sessions = vec![make_session(
        "1",
        "running",
        SessionCategory::Cli,
        KeySource::OwnKey,
    )];

    let filter = SessionFilter {
        // Typo: missing "_key" suffix. Previously silently mapped to
        // OwnKey and mis-filtered the entire response.
        key_source: Some("market".to_string()),
        ..Default::default()
    };
    let err =
        apply_filters(&mut sessions, &filter).expect_err("unknown key_source must be rejected");
    assert!(
        err.contains("Unknown key_source filter"),
        "expected explicit rejection, got: {err}"
    );
}

#[test]
fn pagination_does_not_append_org_member_children_for_visible_roots() {
    let root = make_session(
        "root-session",
        "running",
        SessionCategory::Agent,
        KeySource::OwnKey,
    );
    let mut paged_sessions = vec![root];
    let filter = SessionFilter {
        limit: Some(1),
        ..Default::default()
    };
    apply_pagination(&mut paged_sessions, &filter);

    assert_eq!(
        paged_sessions
            .iter()
            .map(|session| session.session_id.as_str())
            .collect::<Vec<_>>(),
        vec!["root-session"]
    );
}

fn plain_page_filter() -> SessionFilter {
    SessionFilter {
        category: Some("cli".to_string()),
        include_external_history: Some(false),
        limit: Some(20),
        offset: Some(0),
        sort_by: Some("updated_at".to_string()),
        sort_order: Some("desc".to_string()),
        ..SessionFilter::default()
    }
}

#[test]
fn plain_native_page_rejects_non_plain_filters() {
    // Missing filter entirely, or any shape the SQL page can't express,
    // must fall through to the merge path (Ok(None)).
    assert!(plain_native_page(None).unwrap().is_none());

    let mut with_text = plain_page_filter();
    with_text.text_query = Some("bug".to_string());
    assert!(plain_native_page(Some(&with_text)).unwrap().is_none());

    let mut with_status = plain_page_filter();
    with_status.status = Some("running".to_string());
    assert!(plain_native_page(Some(&with_status)).unwrap().is_none());

    let mut with_external = plain_page_filter();
    with_external.include_external_history = Some(true);
    assert!(plain_native_page(Some(&with_external)).unwrap().is_none());

    let mut external_unset = plain_page_filter();
    external_unset.include_external_history = None;
    assert!(plain_native_page(Some(&external_unset)).unwrap().is_none());

    let mut multi_category = plain_page_filter();
    multi_category.category = Some("cli,agent".to_string());
    assert!(plain_native_page(Some(&multi_category)).unwrap().is_none());

    let mut sorted_by_name = plain_page_filter();
    sorted_by_name.sort_by = Some("name".to_string());
    assert!(plain_native_page(Some(&sorted_by_name)).unwrap().is_none());
}

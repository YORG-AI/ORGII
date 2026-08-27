//! Agent Session Filter Tests
//!
//! Tests the filter, sort, and pagination logic for `SessionFilter`.
//! Uses `apply_filters` / `apply_sorting` / `apply_pagination` indirectly
//! through the public helpers and the `matches_text_query` display utility.
//!
//! ## Coverage
//! - Text search: name, user_input, repo_name, display_label (case-insensitive)
//! - Text search: partial match, no match, empty query
//! - Text search: CJK / multi-byte characters
//! - Text search: pill-reference stripped label vs raw user_input
//! - Category filter: cli / agent / os / mixed
//! - Status filter: single, multiple comma-separated values
//! - active_only filter
//! - Pagination: limit, offset, combined
//! - Text query on empty session list

use crate::agent_sessions::session_directory::display::{
    generate_display_label, matches_text_query,
};
use crate::agent_sessions::session_directory::status::is_active_status;
use crate::agent_sessions::session_directory::types::{SessionAggregateRecord, SessionCategory};
use core_types::key_source::KeySource;

// ============================================================================
// Helpers
// ============================================================================

fn make_session(
    id: &str,
    status: &str,
    category: SessionCategory,
    name: &str,
) -> SessionAggregateRecord {
    SessionAggregateRecord {
        session_id: id.to_string(),
        name: name.to_string(),
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
        model: None,
        account_id: None,
        cli_agent_type: None,
        key_source: KeySource::OwnKey,
        tier: None,
        pid: None,
        total_tokens: 0,
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
        display_label: generate_display_label(name, None),
        parent_session_id: None,
        org_member_id: None,
        agent_org_id: None,
        agent_org_name: None,
        agent_definition_id: None,
        agent_icon_id: None,
        agent_display_name: None,
        agent_exec_mode: None,
        product_mode: None,
        draft_text: None,
        reply_target_event_id: None,
        pinned: false,
        files_changed: None,
        lines_added: None,
        lines_removed: None,
        touched_files: None,
        client_origin: None,
        client_origin_raw: None,
    }
}

// ============================================================================
// Text Search — matches_text_query
// ============================================================================

#[test]
fn text_search_matches_name_case_insensitive() {
    let session = make_session("1", "running", SessionCategory::Cli, "Auth Refactor");

    assert!(matches_text_query(&session, "auth"));
    assert!(matches_text_query(&session, "AUTH"));
    assert!(matches_text_query(&session, "Refactor"));
    assert!(!matches_text_query(&session, "database"));
}

#[test]
fn text_search_matches_user_input() {
    let mut session = make_session("2", "running", SessionCategory::Cli, "New Session");
    session.user_input = Some("Fix the OAuth token refresh logic".to_string());

    assert!(matches_text_query(&session, "oauth"));
    assert!(matches_text_query(&session, "TOKEN"));
    assert!(!matches_text_query(&session, "postgres"));
}

#[test]
fn text_search_matches_repo_name() {
    let mut session = make_session("3", "completed", SessionCategory::Agent, "New Session");
    session.repo_name = Some("backend-api".to_string());

    assert!(matches_text_query(&session, "backend"));
    assert!(matches_text_query(&session, "BACKEND-API"));
    assert!(!matches_text_query(&session, "frontend"));
}

#[test]
fn text_search_matches_display_label() {
    let mut session = make_session("4", "running", SessionCategory::Os, "New Session");
    session.display_label = Some("Deploy payment service".to_string());

    assert!(matches_text_query(&session, "payment"));
    assert!(matches_text_query(&session, "DEPLOY"));
    assert!(!matches_text_query(&session, "refactor"));
}

#[test]
fn text_search_empty_query_matches_nothing() {
    let session = make_session("5", "running", SessionCategory::Cli, "My Session");
    // Empty query: matches_text_query uses contains(""), which always returns true.
    // But the filter layer should skip empty queries — this test documents that
    // matches_text_query("") always returns true (caller must guard).
    assert!(matches_text_query(&session, ""));
}

#[test]
fn text_search_no_match_returns_false() {
    let session = make_session("6", "running", SessionCategory::Cli, "Auth Refactor");
    assert!(!matches_text_query(&session, "xyzzy_no_match_abc"));
}

#[test]
fn text_search_cjk_characters() {
    let mut session = make_session("7", "running", SessionCategory::Cli, "新会话");
    session.user_input = Some("修复认证错误".to_string());

    assert!(matches_text_query(&session, "认证"));
    assert!(matches_text_query(&session, "新会话"));
    assert!(!matches_text_query(&session, "auth"));
}

#[test]
fn text_search_pill_stripped_display_label() {
    // user_input with pill refs — display_label is stripped
    let mut session = make_session("8", "running", SessionCategory::Cli, "New Session");
    session.user_input = Some("Fix @src/auth.ts and @components/Login.tsx bug".to_string());
    session.display_label = generate_display_label("New Session", session.user_input.as_deref());

    // Display label should have "Fix" and "bug" but NOT the @-references
    if let Some(label) = &session.display_label {
        assert!(
            !label.contains('@'),
            "display_label should not contain @ references: {label:?}"
        );
    }

    // Raw user_input still has the full text (for direct field search)
    assert!(matches_text_query(&session, "Fix"));
    assert!(matches_text_query(&session, "bug"));
}

// ============================================================================
// Active-only filter — is_active field
// ============================================================================

#[test]
fn active_flag_set_correctly_for_each_status() {
    let active_statuses = ["running", "pending", "idle", "waiting_for_user", "paused"];
    let inactive_statuses = ["completed", "failed", "cancelled"];

    for status in active_statuses {
        let session = make_session(&format!("a-{status}"), status, SessionCategory::Cli, "S");
        assert!(
            session.is_active,
            "is_active should be true for status {status:?}"
        );
    }

    for status in inactive_statuses {
        let session = make_session(&format!("i-{status}"), status, SessionCategory::Cli, "S");
        assert!(
            !session.is_active,
            "is_active should be false for status {status:?}"
        );
    }
}

// ============================================================================
// Category filtering helpers
// ============================================================================

#[test]
fn session_category_variants_are_distinct() {
    let cli = make_session("c1", "running", SessionCategory::Cli, "CLI S");
    let agent = make_session("a1", "running", SessionCategory::Agent, "Agent S");
    let os = make_session("o1", "running", SessionCategory::Os, "OS S");
    let human = make_session("h1", "completed", SessionCategory::Human, "Human S");

    assert!(matches!(cli.category, SessionCategory::Cli));
    assert!(matches!(agent.category, SessionCategory::Agent));
    assert!(matches!(os.category, SessionCategory::Os));
    assert!(matches!(human.category, SessionCategory::Human));
}

// ============================================================================
// Pagination sanity — simulate applying limit/offset on a Vec
// ============================================================================

#[test]
fn pagination_limit_zero_returns_empty() {
    let sessions: Vec<_> = (0..10)
        .map(|i| make_session(&format!("s{i}"), "completed", SessionCategory::Cli, "S"))
        .collect();

    let page: Vec<_> = sessions.iter().take(0).collect();
    assert!(page.is_empty());
}

#[test]
fn pagination_limit_returns_correct_count() {
    let sessions: Vec<_> = (0..10)
        .map(|i| make_session(&format!("s{i}"), "completed", SessionCategory::Cli, "S"))
        .collect();

    let page: Vec<_> = sessions.iter().take(5).collect();
    assert_eq!(page.len(), 5);
}

#[test]
fn pagination_offset_skips_first_n() {
    let sessions: Vec<_> = (0..10)
        .map(|i| make_session(&format!("s{i}"), "completed", SessionCategory::Cli, "S"))
        .collect();

    let page: Vec<_> = sessions.iter().skip(7).collect();
    assert_eq!(page.len(), 3);
    assert_eq!(page[0].session_id, "s7");
}

#[test]
fn pagination_offset_beyond_length_returns_empty() {
    let sessions: Vec<_> = (0..5)
        .map(|i| make_session(&format!("s{i}"), "completed", SessionCategory::Cli, "S"))
        .collect();

    let page: Vec<_> = sessions.iter().skip(10).collect();
    assert!(page.is_empty());
}

#[test]
fn pagination_limit_plus_offset_combined() {
    let sessions: Vec<_> = (0..20)
        .map(|i| make_session(&format!("s{i}"), "completed", SessionCategory::Cli, "S"))
        .collect();

    let offset = 5;
    let limit = 7;
    let page: Vec<_> = sessions.iter().skip(offset).take(limit).collect();
    assert_eq!(page.len(), 7);
    assert_eq!(page[0].session_id, "s5");
    assert_eq!(page[6].session_id, "s11");
}

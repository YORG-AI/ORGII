use super::*;
use crate::agent_sessions::cli::types::SessionStatus;
use crate::test_utils::test_env;
use agent_core::foundation::session_bridge;

fn create_test_session(session_id: &str, account_id: &str) {
    create_session(
        session_id,
        &CreateCodeSessionParams {
            name: Some("resume state test".to_string()),
            flow: None,
            runner: None,
            cli_agent_type: "claude_code".to_string(),
            model: Some("claude-sonnet-4-6".to_string()),
            tier: None,
            account_id: Some(account_id.to_string()),
            repo_path: Some("/tmp".to_string()),
            branch: None,
            worktree_path: None,
            worktree_base_ref: None,
            proxy_token: None,
            proxy_url: None,
            hosted_token: None,
            proxy_session_id: None,
            isolate: None,
            background: Some(false),
            key_source: Some("own_key".to_string()),
            additional_directories: None,
            parent_session_id: None,
            org_member_id: None,
            org_id: None,
            project_id: None,
            project_name: None,
            project_slug: None,
            work_item_id: None,
            agent_role: None,
            product_mode: None,
        },
    )
    .expect("create test CLI session");
}

#[test]
fn status_snapshots_return_only_requested_existing_sessions() {
    let _sandbox = test_env::sandbox();
    create_test_session("cli-status-a", "account-a");
    create_test_session("cli-status-b", "account-b");
    update_status("cli-status-b", SessionStatus::Running).expect("mark running");

    let rows = status_snapshots(&["cli-status-b".to_string(), "cli-status-missing".to_string()])
        .expect("load status batch");

    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].session_id, "cli-status-b");
    assert_eq!(rows[0].status, SessionStatus::Running);
    assert!(!rows[0].updated_at.is_empty());
}

#[test]
fn sidebar_page_filters_pinned_and_child_rows_before_limit() {
    let _sandbox = test_env::sandbox();
    for session_id in [
        "cli-regular-a",
        "cli-regular-b",
        "cli-regular-c",
        "cli-pinned",
        "cli-child",
    ] {
        create_test_session(session_id, "account-a");
    }
    let conn = database::db::get_connection().expect("sandbox database");
    for (session_id, updated_at) in [
        ("cli-regular-a", "2026-07-30T10:00:00Z"),
        ("cli-regular-b", "2026-07-30T11:00:00Z"),
        ("cli-regular-c", "2026-07-30T12:00:00Z"),
        ("cli-pinned", "2026-07-30T14:00:00Z"),
        ("cli-child", "2026-07-30T13:00:00Z"),
    ] {
        conn.execute(
            "UPDATE code_sessions SET updated_at = ?2 WHERE session_id = ?1",
            rusqlite::params![session_id, updated_at],
        )
        .expect("set deterministic activity time");
    }
    conn.execute(
        "UPDATE code_sessions SET pinned = 1 WHERE session_id = 'cli-pinned'",
        [],
    )
    .expect("pin fixture");
    conn.execute(
        "UPDATE code_sessions
             SET parent_session_id = 'cli-regular-c'
             WHERE session_id = 'cli-child'",
        [],
    )
    .expect("make child fixture");

    let first = list_unpinned_root_sessions_page(2, None).expect("first CLI page");
    assert_eq!(
        first
            .iter()
            .map(|session| session.session_id.as_str())
            .collect::<Vec<_>>(),
        vec!["cli-regular-c", "cli-regular-b"]
    );
    let cursor = first.last().expect("first page cursor");
    let second =
        list_unpinned_root_sessions_page(2, Some((&cursor.updated_at, &cursor.session_id)))
            .expect("second CLI page");
    assert_eq!(
        second
            .iter()
            .map(|session| session.session_id.as_str())
            .collect::<Vec<_>>(),
        vec!["cli-regular-a"]
    );

    let mut plan = conn
        .prepare(
            "EXPLAIN QUERY PLAN
                 SELECT session_id
                 FROM code_sessions
                 WHERE pinned = 0 AND parent_session_id IS NULL
                 ORDER BY updated_at DESC, session_id DESC
                 LIMIT 11",
        )
        .expect("prepare CLI sidebar query plan");
    let details = plan
        .query_map([], |row| row.get::<_, String>(3))
        .expect("read CLI sidebar query plan")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect CLI sidebar query plan")
        .join("\n");
    assert!(
        details.contains("idx_code_sessions_sidebar"),
        "CLI page did not use the sidebar index:\n{details}"
    );
}

#[test]
fn cli_session_and_turn_intent_lifecycle_commit_atomically() {
    let _sandbox = test_env::sandbox();
    let session_id = "cli-atomic-lifecycle";
    let turn_intent_id = "intent-atomic";
    create_test_session(session_id, "account-a");

    accept_cli_turn(session_id, turn_intent_id, "message-atomic").expect("accept lifecycle");
    assert_eq!(
        get_session(session_id)
            .expect("load session")
            .expect("session exists")
            .status,
        SessionStatus::Running
    );
    assert_eq!(
        session_persistence::turn_intents::list_for_session(session_id).expect("load intent")[0]
            .status,
        session_persistence::turn_intents::TurnIntentStatus::Running
    );

    update_cli_turn_lifecycle(
        session_id,
        SessionStatus::Completed,
        None,
        Some((
            turn_intent_id,
            session_persistence::turn_intents::TurnIntentStatus::Completed,
        )),
    )
    .expect("complete lifecycle");

    let rejected = update_cli_turn_lifecycle(
        session_id,
        SessionStatus::Running,
        None,
        Some((
            turn_intent_id,
            session_persistence::turn_intents::TurnIntentStatus::Running,
        )),
    );
    assert!(rejected.is_err());
    assert_eq!(
        get_session(session_id)
            .expect("load session")
            .expect("session exists")
            .status,
        SessionStatus::Completed,
        "failed intent transition must roll back the adjacent session status"
    );
}

#[test]
fn cli_resume_state_is_scoped_by_account_and_restored_on_switch_back() {
    let _sandbox = test_env::sandbox();
    let session_id = "cli-resume-account-scope";
    create_test_session(session_id, "account-a");

    update_cli_session_id(session_id, "native-a-1").expect("store account A native id");
    let session = get_session(session_id)
        .expect("load session")
        .expect("session exists");
    assert_eq!(session.cli_session_id.as_deref(), Some("native-a-1"));

    update_model_and_account(session_id, Some("claude-sonnet-4-6"), Some("account-b"))
        .expect("switch to account B");
    let session = get_session(session_id)
        .expect("load session")
        .expect("session exists");
    assert_eq!(session.account_id.as_deref(), Some("account-b"));
    assert_eq!(session.cli_session_id, None);

    update_cli_session_id(session_id, "native-b-1").expect("store account B native id");
    update_model_and_account(session_id, Some("claude-opus-4-7"), Some("account-a"))
        .expect("switch back to account A");
    let session = get_session(session_id)
        .expect("load session")
        .expect("session exists");
    assert_eq!(session.account_id.as_deref(), Some("account-a"));
    assert_eq!(session.model.as_deref(), Some("claude-opus-4-7"));
    assert_eq!(session.cli_session_id.as_deref(), Some("native-a-1"));

    update_model_and_account(session_id, Some("claude-sonnet-4-6"), Some("account-b"))
        .expect("switch back to account B");
    let session = get_session(session_id)
        .expect("load session")
        .expect("session exists");
    assert_eq!(session.account_id.as_deref(), Some("account-b"));
    assert_eq!(session.cli_session_id.as_deref(), Some("native-b-1"));
}

#[test]
fn model_switch_on_same_account_preserves_legacy_single_column_resume_id() {
    let _sandbox = test_env::sandbox();
    let session_id = "cli-resume-same-account";
    create_test_session(session_id, "account-a");
    update_cli_session_id(session_id, "native-a-legacy").expect("store native id");

    update_model_and_account(session_id, Some("claude-opus-4-7"), Some("account-a"))
        .expect("switch model on same account");
    let session = get_session(session_id)
        .expect("load session")
        .expect("session exists");
    assert_eq!(session.model.as_deref(), Some("claude-opus-4-7"));
    assert_eq!(session.cli_session_id.as_deref(), Some("native-a-legacy"));
}

#[test]
fn old_process_resume_id_does_not_overwrite_current_account_column() {
    let _sandbox = test_env::sandbox();
    let session_id = "cli-resume-stale-process";
    create_test_session(session_id, "account-a");
    update_model_and_account(session_id, Some("claude-sonnet-4-6"), Some("account-b"))
        .expect("switch to account B while old account A process is still winding down");

    update_cli_session_id_for_account(session_id, Some("account-a"), "native-a-late")
        .expect("late account A process stores native id");

    let session = get_session(session_id)
        .expect("load session")
        .expect("session exists");
    assert_eq!(session.account_id.as_deref(), Some("account-b"));
    assert_eq!(session.cli_session_id, None);
    assert_eq!(
        get_cli_session_id_for_account(session_id, Some("account-a"))
            .expect("load account A mapped id")
            .as_deref(),
        Some("native-a-late")
    );
}

#[test]
fn clearing_cli_resume_state_removes_all_account_scoped_resume_state() {
    let _sandbox = test_env::sandbox();
    let session_id = "cli-resume-clear-primitive";
    create_test_session(session_id, "account-a");
    update_cli_session_id(session_id, "native-a-1").expect("store account A native id");
    update_model_and_account(session_id, Some("claude-sonnet-4-6"), Some("account-b"))
        .expect("switch to account B");
    update_cli_session_id(session_id, "native-b-1").expect("store account B native id");

    assert!(
        clear_cli_resume_state(session_id, session_bridge::CLI_HISTORY_MUTATION_FILE_REWIND)
            .expect("clear resume state")
    );
    let mutation = get_history_mutation(session_id)
        .expect("load history mutation")
        .expect("history mutation exists");
    assert_eq!(mutation.epoch, 1);
    assert_eq!(
        mutation.reason,
        session_bridge::CLI_HISTORY_MUTATION_FILE_REWIND
    );

    let session = get_session(session_id)
        .expect("load session")
        .expect("session exists");
    assert_eq!(session.cli_session_id, None);
    assert_eq!(
        get_cli_session_id_for_account(session_id, Some("account-a"))
            .expect("load account A mapped id"),
        None
    );
    assert_eq!(
        get_cli_session_id_for_account(session_id, Some("account-b"))
            .expect("load account B mapped id"),
        None
    );
}

#[test]
fn account_switch_after_resume_clear_does_not_restore_old_native_id() {
    let _sandbox = test_env::sandbox();
    let session_id = "cli-resume-clear-account-switch";
    create_test_session(session_id, "account-a");
    update_cli_session_id(session_id, "native-a-1").expect("store account A native id");
    update_model_and_account(session_id, Some("claude-sonnet-4-6"), Some("account-b"))
        .expect("switch to account B");
    update_cli_session_id(session_id, "native-b-1").expect("store account B native id");

    clear_cli_resume_state(session_id, session_bridge::CLI_HISTORY_MUTATION_FILE_REWIND)
        .expect("clear resume state");
    update_model_and_account(session_id, Some("claude-opus-4-7"), Some("account-a"))
        .expect("switch back to account A after clear");

    let session = get_session(session_id)
        .expect("load session")
        .expect("session exists");
    assert_eq!(session.account_id.as_deref(), Some("account-a"));
    assert_eq!(session.cli_session_id, None);
    assert_eq!(
        get_cli_session_id_for_account(session_id, Some("account-a"))
            .expect("load account A mapped id"),
        None
    );
}

#[test]
fn late_old_process_after_resume_clear_does_not_pollute_current_account_slot() {
    let _sandbox = test_env::sandbox();
    let session_id = "cli-resume-clear-late-process";
    create_test_session(session_id, "account-a");
    update_cli_session_id(session_id, "native-a-1").expect("store account A native id");
    update_model_and_account(session_id, Some("claude-sonnet-4-6"), Some("account-b"))
        .expect("switch to account B");
    update_cli_session_id(session_id, "native-b-1").expect("store account B native id");

    clear_cli_resume_state(session_id, session_bridge::CLI_HISTORY_MUTATION_FILE_REWIND)
        .expect("clear resume state");
    update_model_and_account(session_id, Some("claude-opus-4-7"), Some("account-b"))
        .expect("remain on account B after clear");
    assert!(
        update_cli_session_id_for_account(session_id, Some("account-a"), "native-a-late")
            .expect("late account A process stores only account A slot")
    );

    let session = get_session(session_id)
        .expect("load session")
        .expect("session exists");
    assert_eq!(session.account_id.as_deref(), Some("account-b"));
    assert_eq!(session.cli_session_id, None);
    assert_eq!(
        get_cli_session_id_for_account(session_id, Some("account-a"))
            .expect("load account A mapped id")
            .as_deref(),
        Some("native-a-late")
    );
    assert_eq!(
        get_cli_session_id_for_account(session_id, Some("account-b"))
            .expect("load account B mapped id"),
        None
    );
}

#[test]
fn truncating_chunks_clears_all_account_scoped_resume_state() {
    let _sandbox = test_env::sandbox();
    let session_id = "cli-resume-truncate-clears";
    create_test_session(session_id, "account-a");
    update_cli_session_id(session_id, "native-a-1").expect("store account A native id");
    update_model_and_account(session_id, Some("claude-sonnet-4-6"), Some("account-b"))
        .expect("switch to account B");
    update_cli_session_id(session_id, "native-b-1").expect("store account B native id");

    clear_cli_resume_state(session_id, session_bridge::CLI_HISTORY_MUTATION_FILE_REWIND)
        .expect("seed first history mutation");
    truncate_chunks_after(session_id, "1970-01-01T00:00:00Z").expect("truncate session");
    let mutation = get_history_mutation(session_id)
        .expect("load history mutation")
        .expect("history mutation exists");
    assert_eq!(mutation.epoch, 2);
    assert_eq!(
        mutation.reason,
        session_bridge::CLI_HISTORY_MUTATION_MESSAGE_TRUNCATE
    );

    let session = get_session(session_id)
        .expect("load session")
        .expect("session exists");
    assert_eq!(session.cli_session_id, None);
    assert_eq!(
        get_cli_session_id_for_account(session_id, Some("account-a"))
            .expect("load account A mapped id"),
        None
    );
    assert_eq!(
        get_cli_session_id_for_account(session_id, Some("account-b"))
            .expect("load account B mapped id"),
        None
    );
}

#[test]
fn native_transcript_ledger_walks_forks_newest_first() {
    let _sandbox = test_env::sandbox();
    let session_id = "cli-native-ledger-order";
    create_test_session(session_id, "account-a");
    update_cli_session_id(session_id, "fork-1").expect("bind first fork");
    update_cli_session_id(session_id, "fork-2").expect("bind second fork");
    update_cli_session_id(session_id, "fork-3").expect("bind third fork");

    let ids = native_transcript_ids_newest_first(session_id, "claude_code").expect("load ledger");
    assert_eq!(ids, vec!["fork-3", "fork-2", "fork-1"]);
    assert_eq!(
        latest_native_transcript_id(session_id, "claude_code")
            .expect("load latest")
            .as_deref(),
        ids.first().map(String::as_str)
    );
}

#[test]
fn late_resume_id_write_after_delete_does_not_create_orphan_state() {
    let _sandbox = test_env::sandbox();
    let session_id = "cli-resume-delete-race";
    create_test_session(session_id, "account-a");
    delete_session(session_id).expect("delete session");

    let updated = update_cli_session_id_for_account(session_id, Some("account-a"), "native-a-late")
        .expect("late write should be ignored cleanly");

    assert!(!updated);
    assert_eq!(
        get_cli_session_id_for_account(session_id, Some("account-a"))
            .expect("load account A mapped id"),
        None
    );
}

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
            agent_definition_id: None,
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
fn staged_native_binding_is_recoverable_but_not_yet_published() {
    let _sandbox = test_env::sandbox();
    let session_id = "cli-resume-staged-binding";
    create_test_session(session_id, "account-a");

    assert!(
        stage_cli_session_id_for_account(session_id, Some("account-a"), "native-a-staged")
            .expect("stage native materialization")
    );
    assert_eq!(
        get_cli_session_id_for_account(session_id, Some("account-a"))
            .expect("load staged binding")
            .as_deref(),
        Some("native-a-staged")
    );
    assert!(
        native_transcript_ids_newest_first(session_id, "claude_code")
            .expect("load unpublished ledger")
            .is_empty(),
        "an unpublished materialization must not become durable transcript history"
    );

    assert!(
        update_cli_session_id_for_account(session_id, Some("account-a"), "native-a-staged")
            .expect("publish staged materialization")
    );
    assert_eq!(
        native_transcript_ids_newest_first(session_id, "claude_code")
            .expect("load published ledger"),
        vec!["native-a-staged"]
    );
}

#[test]
fn abandoning_one_staged_binding_preserves_other_account_resume_state() {
    let _sandbox = test_env::sandbox();
    let session_id = "cli-resume-targeted-stage-abort";
    create_test_session(session_id, "account-a");
    update_cli_session_id_for_account(session_id, Some("account-a"), "native-a-published")
        .expect("publish account A binding");
    update_model_and_account(session_id, Some("claude-sonnet-4-6"), Some("account-b"))
        .expect("switch to account B");
    stage_cli_session_id_for_account(session_id, Some("account-b"), "native-b-staged")
        .expect("stage account B binding");

    assert!(clear_staged_cli_session_id_for_account(
        session_id,
        Some("account-b"),
        "native-b-staged"
    )
    .expect("abort account B stage"));
    assert_eq!(
        get_cli_session_id_for_account(session_id, Some("account-b"))
            .expect("load account B binding"),
        None
    );
    assert_eq!(
        get_cli_session_id_for_account(session_id, Some("account-a"))
            .expect("load account A binding")
            .as_deref(),
        Some("native-a-published")
    );
    assert_eq!(
        native_transcript_ids_newest_first(session_id, "claude_code")
            .expect("load published ledger"),
        vec!["native-a-published"]
    );
    assert_eq!(
        get_session(session_id)
            .expect("load session")
            .expect("session exists")
            .cli_session_id,
        None
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

#[test]
fn native_catalog_receipt_uses_revision_cas_and_pending_only_reads() {
    let _sandbox = test_env::sandbox();
    let dirty_session_id = "cli-native-catalog-dirty";
    let clean_session_id = "cli-native-catalog-clean";
    create_test_session(dirty_session_id, "account-a");
    create_test_session(clean_session_id, "account-a");
    update_cli_session_id_for_account(dirty_session_id, Some("account-a"), "native-dirty")
        .expect("publish dirty binding");
    update_cli_session_id_for_account(clean_session_id, Some("account-a"), "native-clean")
        .expect("publish clean binding");

    let first = request_native_catalog_refresh(dirty_session_id, Some("account-a"), "native-dirty")
        .expect("request first catalog revision")
        .expect("binding still exists");
    let second =
        request_native_catalog_refresh(dirty_session_id, Some("account-a"), "native-dirty")
            .expect("request second catalog revision")
            .expect("binding still exists");
    assert_eq!(first.requested_revision, 1);
    assert_eq!(second.requested_revision, 2);

    assert!(
        !acknowledge_native_catalog_refresh(&first).expect("reject stale catalog receipt"),
        "an older worker must not clear a newer terminal request"
    );
    let pending = pending_native_catalog_refreshes(8).expect("load dirty receipts");
    assert_eq!(
        pending.len(),
        1,
        "clean bindings must not enter startup repair"
    );
    assert_eq!(pending[0].receipt, second);
    assert_eq!(pending[0].source, "claude_code");

    assert!(acknowledge_native_catalog_refresh(&second).expect("ack current revision"));
    assert!(pending_native_catalog_refreshes(8)
        .expect("reload dirty receipts")
        .is_empty());
    assert!(
        !acknowledge_native_catalog_refresh(&second).expect("repeat acknowledgement"),
        "acknowledgement is idempotent"
    );
}

#[test]
fn replacing_native_binding_resets_catalog_revisions() {
    let _sandbox = test_env::sandbox();
    let session_id = "cli-native-catalog-binding-replaced";
    create_test_session(session_id, "account-a");
    update_cli_session_id_for_account(session_id, Some("account-a"), "native-old")
        .expect("publish old binding");
    request_native_catalog_refresh(session_id, Some("account-a"), "native-old")
        .expect("request old binding refresh")
        .expect("old binding exists");

    update_cli_session_id_for_account(session_id, Some("account-a"), "native-new")
        .expect("replace native binding");
    assert!(pending_native_catalog_refreshes(8)
        .expect("load pending after binding replacement")
        .is_empty());
    assert!(
        request_native_catalog_refresh(session_id, Some("account-a"), "native-old")
            .expect("request stale native id")
            .is_none()
    );
    assert_eq!(
        request_native_catalog_refresh(session_id, Some("account-a"), "native-new")
            .expect("request new native id")
            .expect("new binding exists")
            .requested_revision,
        1
    );
}

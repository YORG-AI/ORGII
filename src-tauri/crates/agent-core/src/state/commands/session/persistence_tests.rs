use super::*;

fn ensure_test_schemas() {
    let conn = get_connection().expect("sandbox DB");
    crate::persistence::test_schema::ensure_agent_sessions_schema(&conn);
    crate::foundation::persistence::session_snapshots::ensure_tables_with(&conn)
        .expect("agent session tables");
    crate::session::persistence::init(&conn).expect("unified session schema");
    crate::interaction::plan_approval::persistence::init_schema(&conn)
        .expect("plan approval schema");
    crate::coordination::init_agent_org_schemas(&conn).expect("Agent Org schemas");
    project_management::lineage::schema::init_lineage_tables(&conn).expect("lineage schema");
    crate::memory::learnings::init_learnings_table(&conn).expect("learnings schema");
    database::init_shell_replay_tables(&conn).expect("shell replay schema");
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS events (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS code_sessions (
                session_id TEXT PRIMARY KEY,
                cli_agent_type TEXT NOT NULL,
                status TEXT NOT NULL,
                parent_session_id TEXT,
                org_member_id TEXT,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS session_turn_intents (
                session_id TEXT NOT NULL,
                turn_intent_id TEXT NOT NULL,
                client_message_id TEXT,
                org_run_id TEXT,
                source TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (session_id, turn_intent_id)
            );",
    )
    .expect("session runtime schemas");
}

fn seed_session_with_status(session_id: &str, parent_session_id: Option<&str>, status: &str) {
    let conn = get_connection().expect("sandbox DB");
    conn.execute(
        "INSERT INTO agent_sessions (
                 session_id, name, status, user_input, created_at, updated_at,
                 session_type, parent_session_id, workspace_additional_json,
                 key_source
             ) VALUES (?1, ?2, ?3, NULL, ?4, ?4, 'agent', ?5, '{}', 'own_key')",
        rusqlite::params![
            session_id,
            format!("session-{session_id}"),
            status,
            "2026-07-16T00:00:00Z",
            parent_session_id,
        ],
    )
    .expect("seed session");
}

fn seed_session(session_id: &str, parent_session_id: Option<&str>) {
    seed_session_with_status(session_id, parent_session_id, "idle");
}

fn seed_run_with_status(run_id: &str, root_session_id: &str, status: &str) {
    let conn = get_connection().expect("sandbox DB");
    conn.execute(
        "INSERT INTO agent_org_runs (
                 id, org_id, coordinator_agent_id, root_session_id,
                 entry_mode, status, created_at, updated_at
             ) VALUES (?1, 'org-delete-test', 'coordinator-agent', ?2,
                       'standalone_session', ?3, ?4, ?4)",
        rusqlite::params![run_id, root_session_id, status, "2026-07-16T00:00:00Z"],
    )
    .expect("seed run");
}

fn seed_run(run_id: &str, root_session_id: &str) {
    seed_run_with_status(run_id, root_session_id, "completed");
}

fn seed_session_owned_rows(session_id: &str) {
    let conn = get_connection().expect("sandbox DB");
    conn.execute(
        "INSERT INTO agent_messages (
                 id, session_id, role, content, sequence, created_at
             ) VALUES (?1, ?2, 'user', 'delete me', 0, ?3)",
        rusqlite::params![
            format!("message-{session_id}"),
            session_id,
            "2026-07-16T00:00:00Z"
        ],
    )
    .expect("seed message");
    conn.execute(
        "INSERT INTO agent_todos (session_id, content) VALUES (?1, 'delete me')",
        [session_id],
    )
    .expect("seed todo");
    conn.execute(
        "INSERT INTO events (id, session_id) VALUES (?1, ?2)",
        rusqlite::params![format!("event-{session_id}"), session_id],
    )
    .expect("seed event");
    conn.execute(
        "INSERT INTO session_token_usage (
                 session_id, session_type, total_tokens, created_at
             ) VALUES (?1, 'agent', 1, ?2)",
        rusqlite::params![session_id, "2026-07-16T00:00:00Z"],
    )
    .expect("seed usage");
}

fn seed_run_owned_rows(run_id: &str) {
    let conn = get_connection().expect("sandbox DB");
    conn.execute(
        "INSERT INTO agent_inbox (
                 recipient_agent_id, recipient_member_id, sender_agent_id,
                 org_run_id, payload_kind, payload_json, created_at
             ) VALUES ('worker-agent', 'worker', 'system', ?1,
                       'plain', '{\"summary\":\"run history\",\"text\":\"body\"}', ?2)",
        rusqlite::params![run_id, "2026-07-16T00:00:00Z"],
    )
    .expect("seed run inbox history");
    conn.execute(
        "INSERT INTO agent_org_tasks (
                 id, org_run_id, subject, status, created_at, updated_at
             ) VALUES (?1, ?2, 'delete me', 'completed', ?3, ?3)",
        rusqlite::params![format!("task-{run_id}"), run_id, "2026-07-16T00:00:00Z"],
    )
    .expect("seed run task history");
}

fn row_exists(table: &str, column: &str, value: &str) -> bool {
    get_connection()
        .expect("sandbox DB")
        .query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE {column}=?1)"),
            [value],
            |row| row.get(0),
        )
        .expect("inspect durable row")
}

#[test]
fn session_hierarchy_delete_removes_all_rust_descendants_and_run_history() {
    let _sandbox = test_helpers::test_env::sandbox();
    ensure_test_schemas();
    let root = "hierarchy-delete-root";
    let worker = "hierarchy-delete-worker";
    let grandchild = "hierarchy-delete-grandchild";
    let unrelated = "hierarchy-delete-unrelated";
    let unrelated_root = "hierarchy-delete-other-root";
    seed_session(root, None);
    seed_session_with_status(worker, Some(root), "completed");
    seed_session_with_status(grandchild, Some(worker), "failed");
    seed_session(unrelated, None);
    seed_session(unrelated_root, None);
    seed_run("hierarchy-delete-run", root);
    seed_run("hierarchy-delete-other-run", unrelated_root);
    for session_id in [root, worker, grandchild, unrelated] {
        seed_session_owned_rows(session_id);
    }
    seed_run_owned_rows("hierarchy-delete-run");
    seed_run_owned_rows("hierarchy-delete-other-run");

    let conn = get_connection().expect("sandbox DB");
    let plan = load_agent_org_session_delete_plan(&conn, root)
        .expect("plan hierarchy")
        .expect("root owns Agent Org run");
    drop(conn);
    let receipt = delete_agent_org_session_hierarchy(&plan, &HashSet::new())
        .expect("delete completed hierarchy");

    assert_eq!(
        receipt.deleted_session_ids,
        vec![grandchild.to_string(), worker.to_string(), root.to_string()]
    );
    for session_id in [root, worker, grandchild] {
        for table in [
            "agent_sessions",
            "agent_messages",
            "agent_todos",
            "events",
            "session_token_usage",
        ] {
            assert!(
                !row_exists(table, "session_id", session_id),
                "{table} still contains {session_id}"
            );
        }
    }
    assert!(!row_exists("agent_org_runs", "id", "hierarchy-delete-run"));
    assert!(!row_exists(
        "agent_inbox",
        "org_run_id",
        "hierarchy-delete-run"
    ));
    assert!(!row_exists(
        "agent_org_tasks",
        "org_run_id",
        "hierarchy-delete-run"
    ));
    assert!(row_exists("agent_sessions", "session_id", unrelated));
    assert!(row_exists("agent_messages", "session_id", unrelated));
    assert!(row_exists(
        "agent_org_runs",
        "id",
        "hierarchy-delete-other-run"
    ));
    assert!(row_exists(
        "agent_inbox",
        "org_run_id",
        "hierarchy-delete-other-run"
    ));
}

#[test]
fn session_hierarchy_delete_worker_keeps_root_and_run() {
    let _sandbox = test_helpers::test_env::sandbox();
    ensure_test_schemas();
    let root = "hierarchy-worker-root";
    let worker = "hierarchy-worker-direct-delete";
    seed_session(root, None);
    seed_session(worker, Some(root));
    seed_run("hierarchy-worker-run", root);
    seed_run_owned_rows("hierarchy-worker-run");

    let conn = get_connection().expect("sandbox DB");
    assert!(
        load_agent_org_session_delete_plan(&conn, worker)
            .expect("plan worker")
            .is_none(),
        "a worker must not be promoted to hierarchy root deletion"
    );
    drop(conn);
    session_persistence::delete_session(worker).expect("canonical single-session deletion");

    assert!(!row_exists("agent_sessions", "session_id", worker));
    assert!(row_exists("agent_sessions", "session_id", root));
    assert!(row_exists("agent_org_runs", "id", "hierarchy-worker-run"));
    assert!(row_exists(
        "agent_inbox",
        "org_run_id",
        "hierarchy-worker-run"
    ));
}

#[test]
fn session_hierarchy_delete_fences_active_run_and_requires_quiesced_sessions() {
    let _sandbox = test_helpers::test_env::sandbox();
    ensure_test_schemas();
    let root = "hierarchy-active-root";
    let worker = "hierarchy-active-worker";
    seed_session(root, None);
    seed_session_with_status(worker, Some(root), "running");
    seed_run_with_status("hierarchy-active-run", root, "running");

    let conn = get_connection().expect("sandbox DB");
    let plan = load_agent_org_session_delete_plan(&conn, root)
        .expect("load running hierarchy")
        .expect("root owns run");
    drop(conn);
    let fenced = establish_agent_org_delete_fence(&plan).expect("cancel run for deletion");
    assert_eq!(
        fenced.run_status,
        crate::coordination::agent_org_runs::AgentOrgRunStatus::Cancelled
    );
    assert_eq!(
        get_connection()
            .expect("sandbox DB")
            .query_row(
                "SELECT status FROM agent_org_runs WHERE id='hierarchy-active-run'",
                [],
                |row| row.get::<_, String>(0)
            )
            .expect("load fenced status"),
        "cancelled"
    );

    let error = validate_agent_org_delete_ready(&fenced, &HashSet::new())
        .expect_err("unobserved running worker must fail closed");
    assert!(error.contains(worker));
    assert!(error.contains("running"));

    let quiesced = HashSet::from([worker.to_string()]);
    validate_agent_org_delete_ready(&fenced, &quiesced)
        .expect("a stopped live runtime may retain a stale running row");
    assert!(row_exists("agent_sessions", "session_id", root));
    assert!(row_exists("agent_sessions", "session_id", worker));
    assert!(row_exists("agent_org_runs", "id", "hierarchy-active-run"));
}

#[test]
fn session_hierarchy_delete_blocks_resource_preflight_failures_before_database_changes() {
    let _sandbox = test_helpers::test_env::sandbox();
    ensure_test_schemas();
    let root = "hierarchy-replay-root";
    let worker = "hierarchy-replay-worker";
    seed_session(root, None);
    seed_session(worker, Some(root));
    seed_run("hierarchy-replay-run", root);
    let conn = get_connection().expect("sandbox DB");
    let plan = load_agent_org_session_delete_plan(&conn, root)
        .expect("plan hierarchy")
        .expect("root owns run");
    drop(conn);

    let replay_root = std::env::temp_dir().join(format!(
        "orgii-hierarchy-delete-replay-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&replay_root).expect("create replay root");
    let writer = crate::tools::impls::coding::exec::shell_replay::ShellReplayWriter::create(
        &replay_root,
        crate::tools::impls::coding::exec::shell_replay::ShellReplayTarget::new(
            worker,
            "active-call",
        ),
        "still running",
        &replay_root,
        None,
    )
    .expect("create active replay");

    let error = delete_agent_org_session_hierarchy(&plan, &HashSet::new())
        .expect_err("active replay must block hierarchy deletion");
    assert!(error.contains(worker));
    assert!(error.contains("shell replay calls are active"));
    assert!(row_exists("agent_sessions", "session_id", root));
    assert!(row_exists("agent_sessions", "session_id", worker));
    assert!(row_exists("agent_org_runs", "id", "hierarchy-replay-run"));

    writer
        .finalize(core_types::session_event::ShellReplayStatus::Complete, None)
        .expect("finalize replay");

    let worktree_path = replay_root.join("owned-worktree");
    let missing_repo_path = replay_root.join("missing-repository");
    std::fs::create_dir_all(&worktree_path).expect("create worktree fixture");
    get_connection()
        .expect("sandbox DB")
        .execute(
            "UPDATE agent_sessions
                 SET workspace_path=?1, worktree_path=?2, base_branch='develop'
                 WHERE session_id=?3",
            rusqlite::params![
                missing_repo_path.to_string_lossy(),
                worktree_path.to_string_lossy(),
                worker,
            ],
        )
        .expect("seed invalid worktree metadata");
    let error = delete_agent_org_session_hierarchy(&plan, &HashSet::new())
        .expect_err("worktree validation failure must block hierarchy deletion");
    assert!(error.contains(worker));
    assert!(error.contains("repository path no longer exists"));
    assert!(row_exists("agent_sessions", "session_id", root));
    assert!(row_exists("agent_sessions", "session_id", worker));
    assert!(row_exists("agent_org_runs", "id", "hierarchy-replay-run"));

    std::fs::remove_dir_all(replay_root).expect("remove replay fixture");
}

#[test]
fn session_hierarchy_delete_rejects_nested_agent_org_without_mutation() {
    let _sandbox = test_helpers::test_env::sandbox();
    ensure_test_schemas();
    let outer_root = "hierarchy-nested-outer-root";
    let inner_root = "hierarchy-nested-inner-root";
    let inner_worker = "hierarchy-nested-inner-worker";
    seed_session(outer_root, None);
    seed_session(inner_root, Some(outer_root));
    seed_session(inner_worker, Some(inner_root));
    seed_run("hierarchy-nested-outer-run", outer_root);
    seed_run("hierarchy-nested-inner-run", inner_root);

    let conn = get_connection().expect("sandbox DB");
    let error = load_agent_org_session_delete_plan(&conn, outer_root)
        .expect_err("nested Agent Org must fail closed");
    assert!(error.contains(inner_root));
    assert!(error.contains("hierarchy-nested-inner-run"));
    for session_id in [outer_root, inner_root, inner_worker] {
        assert!(row_exists("agent_sessions", "session_id", session_id));
    }
    assert!(row_exists(
        "agent_org_runs",
        "id",
        "hierarchy-nested-outer-run"
    ));
    assert!(row_exists(
        "agent_org_runs",
        "id",
        "hierarchy-nested-inner-run"
    ));
}

#[test]
fn session_hierarchy_delete_rejects_cycle_and_size_limit() {
    let _sandbox = test_helpers::test_env::sandbox();
    ensure_test_schemas();
    let cycle_root = "hierarchy-cycle-root";
    let cycle_worker = "hierarchy-cycle-worker";
    seed_session(cycle_root, Some(cycle_worker));
    seed_session(cycle_worker, Some(cycle_root));
    seed_run("hierarchy-cycle-run", cycle_root);

    let conn = get_connection().expect("sandbox DB");
    let error =
        load_agent_org_session_delete_plan(&conn, cycle_root).expect_err("cycle must fail closed");
    assert!(error.contains("cycle"));
    assert!(row_exists("agent_sessions", "session_id", cycle_root));
    assert!(row_exists("agent_sessions", "session_id", cycle_worker));
    drop(conn);

    let limit_root = "hierarchy-limit-root";
    seed_session(limit_root, None);
    seed_run("hierarchy-limit-run", limit_root);
    let mut conn = get_connection().expect("sandbox DB");
    let tx = conn.transaction().expect("seed oversized hierarchy");
    for index in 0..MAX_AGENT_ORG_DELETE_SESSIONS {
        let session_id = format!("hierarchy-limit-worker-{index:04}");
        tx.execute(
            "INSERT INTO agent_sessions (
                     session_id, name, status, created_at, updated_at,
                     session_type, parent_session_id, workspace_additional_json,
                     key_source
                 ) VALUES (?1, ?1, 'idle', ?2, ?2, 'agent', ?3, '{}', 'own_key')",
            rusqlite::params![session_id, "2026-07-16T00:00:00Z", limit_root],
        )
        .expect("seed worker");
    }
    tx.commit().expect("commit oversized hierarchy");
    let error = load_agent_org_session_delete_plan(&conn, limit_root)
        .expect_err("oversized hierarchy must fail closed");
    assert!(error.contains("exceeds"));
    assert!(row_exists("agent_sessions", "session_id", limit_root));
    assert!(row_exists("agent_org_runs", "id", "hierarchy-limit-run"));
}

#[test]
fn session_hierarchy_delete_rechecks_concurrent_structure_changes() {
    let _sandbox = test_helpers::test_env::sandbox();
    ensure_test_schemas();
    let root = "hierarchy-recheck-root";
    let worker = "hierarchy-recheck-worker";
    seed_session(root, None);
    seed_session(worker, Some(root));
    seed_run("hierarchy-recheck-run", root);

    let conn = get_connection().expect("sandbox DB");
    let plan = load_agent_org_session_delete_plan(&conn, root)
        .expect("initial plan")
        .expect("root owns run");
    drop(conn);
    seed_session("hierarchy-recheck-late-worker", Some(root));

    let error = delete_agent_org_session_hierarchy(&plan, &HashSet::new())
        .expect_err("changed hierarchy must fail closed");
    assert!(error.contains("changed before deletion"));
    for session_id in [root, worker, "hierarchy-recheck-late-worker"] {
        assert!(row_exists("agent_sessions", "session_id", session_id));
    }
    assert!(row_exists("agent_org_runs", "id", "hierarchy-recheck-run"));
}

#[test]
fn session_hierarchy_delete_rolls_back_on_midway_database_failure() {
    let _sandbox = test_helpers::test_env::sandbox();
    ensure_test_schemas();
    let root = "hierarchy-rollback-root";
    let worker = "hierarchy-rollback-worker";
    seed_session(root, None);
    seed_session(worker, Some(root));
    seed_session_owned_rows(root);
    seed_session_owned_rows(worker);
    seed_run("hierarchy-rollback-run", root);
    seed_run_owned_rows("hierarchy-rollback-run");

    let conn = get_connection().expect("sandbox DB");
    let plan = load_agent_org_session_delete_plan(&conn, root)
        .expect("plan hierarchy")
        .expect("root owns run");
    conn.execute_batch(
        "CREATE TRIGGER hierarchy_delete_abort_root
             BEFORE DELETE ON agent_sessions
             WHEN OLD.session_id='hierarchy-rollback-root'
             BEGIN
                 SELECT RAISE(ABORT, 'injected hierarchy delete failure');
             END;",
    )
    .expect("install failure trigger");
    drop(conn);

    let error = delete_agent_org_session_hierarchy(&plan, &HashSet::new())
        .expect_err("trigger must abort transaction");
    assert!(error.contains("injected hierarchy delete failure"));
    for session_id in [root, worker] {
        for table in [
            "agent_sessions",
            "agent_messages",
            "agent_todos",
            "events",
            "session_token_usage",
        ] {
            assert!(
                row_exists(table, "session_id", session_id),
                "{table} lost {session_id} despite rollback"
            );
        }
    }
    assert!(row_exists("agent_org_runs", "id", "hierarchy-rollback-run"));
    assert!(row_exists(
        "agent_inbox",
        "org_run_id",
        "hierarchy-rollback-run"
    ));
    assert!(row_exists(
        "agent_org_tasks",
        "org_run_id",
        "hierarchy-rollback-run"
    ));
}

#[test]
fn session_hierarchy_delete_rolls_back_transaction_time_structure_changes() {
    let _sandbox = test_helpers::test_env::sandbox();
    ensure_test_schemas();
    let root = "hierarchy-trigger-change-root";
    let worker = "hierarchy-trigger-change-worker";
    let injected = "hierarchy-trigger-change-injected";
    seed_session(root, None);
    seed_session(worker, Some(root));
    seed_run("hierarchy-trigger-change-run", root);

    let conn = get_connection().expect("sandbox DB");
    let plan = load_agent_org_session_delete_plan(&conn, root)
        .expect("plan hierarchy")
        .expect("root owns run");
    conn.execute_batch(
        "CREATE TRIGGER hierarchy_delete_insert_child
             AFTER DELETE ON agent_sessions
             WHEN OLD.session_id='hierarchy-trigger-change-root'
             BEGIN
                 INSERT INTO agent_sessions (
                     session_id, name, status, created_at, updated_at,
                     session_type, parent_session_id, workspace_additional_json,
                     key_source
                 ) VALUES (
                     'hierarchy-trigger-change-injected',
                     'injected',
                     'idle',
                     '2026-07-16T00:00:00Z',
                     '2026-07-16T00:00:00Z',
                     'agent',
                     'hierarchy-trigger-change-root',
                     '{}',
                     'own_key'
                 );
             END;",
    )
    .expect("install mutation trigger");
    drop(conn);

    let error = delete_agent_org_session_hierarchy(&plan, &HashSet::new())
        .expect_err("transaction-time hierarchy mutation must abort");
    assert!(error.contains("residual session hierarchy row"));
    assert!(row_exists("agent_sessions", "session_id", root));
    assert!(row_exists("agent_sessions", "session_id", worker));
    assert!(!row_exists("agent_sessions", "session_id", injected));
    assert!(row_exists(
        "agent_org_runs",
        "id",
        "hierarchy-trigger-change-run"
    ));
}

#[tokio::test]
async fn session_hierarchy_delete_stops_active_runtime_and_discards_pending_work() {
    let _sandbox = test_helpers::test_env::sandbox();
    ensure_test_schemas();
    let root = "hierarchy-runtime-root";
    let state = AgentAppState::new();
    let root_runtime = std::sync::Arc::new(crate::state::AgentSession::new(
        root.to_string(),
        crate::definitions::AgentDefinition::default(),
    ));
    let turn_started = std::sync::Arc::new(tokio::sync::Notify::new());
    let turn_started_for_job = std::sync::Arc::clone(&turn_started);
    let runtime_for_job = std::sync::Arc::clone(&root_runtime);
    root_runtime
        .scheduler
        .enqueue(crate::session::ScheduledMessage {
            kind: crate::session::ScheduledKind::Turn,
            message_id: "hierarchy-runtime-processing".to_string(),
            generation: 0,
            client_message_id: None,
            turn_intent_id: "hierarchy-runtime-processing-intent".to_string(),
            org_run_id: Some("hierarchy-runtime-run".to_string()),
            content: String::new(),
            execute: Box::new(move || {
                let runtime = std::sync::Arc::clone(&runtime_for_job);
                let started = std::sync::Arc::clone(&turn_started_for_job);
                Box::pin(async move {
                    runtime.begin_turn("still running".to_string()).await;
                    started.notify_one();
                    while !runtime
                        .cancel_flag
                        .load(std::sync::atomic::Ordering::SeqCst)
                    {
                        tokio::task::yield_now().await;
                    }
                    runtime
                        .end_turn(
                            crate::session::DialogTurnState::Cancelled,
                            crate::session::TurnStats::default(),
                        )
                        .await;
                    Err("cancelled for hierarchy deletion".to_string())
                })
            }),
        })
        .await
        .expect("enqueue processing work");
    tokio::time::timeout(std::time::Duration::from_secs(1), turn_started.notified())
        .await
        .expect("turn starts processing");
    let pending_executed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let pending_executed_for_job = std::sync::Arc::clone(&pending_executed);
    root_runtime
        .scheduler
        .enqueue(crate::session::ScheduledMessage {
            kind: crate::session::ScheduledKind::Turn,
            message_id: "hierarchy-runtime-pending".to_string(),
            generation: 0,
            client_message_id: None,
            turn_intent_id: "hierarchy-runtime-pending-intent".to_string(),
            org_run_id: Some("hierarchy-runtime-run".to_string()),
            content: String::new(),
            execute: Box::new(move || {
                let executed = std::sync::Arc::clone(&pending_executed_for_job);
                Box::pin(async move {
                    executed.store(true, std::sync::atomic::Ordering::SeqCst);
                    Ok(String::new())
                })
            }),
        })
        .await
        .expect("enqueue pending work");
    state
        .sessions
        .lock()
        .await
        .insert(root.to_string(), std::sync::Arc::clone(&root_runtime));
    let plan = AgentOrgSessionDeletePlan {
        run_id: "hierarchy-runtime-run".to_string(),
        root_session_id: root.to_string(),
        run_status: crate::coordination::agent_org_runs::AgentOrgRunStatus::Cancelled,
        sessions: vec![AgentOrgSessionDeleteNode {
            session_id: root.to_string(),
            parent_session_id: None,
            status: SessionStatus::Running,
            depth: 0,
        }],
    };

    let quiesced = stop_agent_org_runtime_sessions_with_timeout(
        &state,
        &plan,
        std::time::Duration::from_secs(1),
    )
    .await
    .expect("active Rust runtime stops");
    assert_eq!(quiesced, HashSet::from([root.to_string()]));
    assert_eq!(root_runtime.scheduler.pending_count(), 0);
    assert!(!root_runtime.scheduler.is_processing());
    assert!(root_runtime.active_turn.lock().await.is_none());
    assert!(!pending_executed.load(std::sync::atomic::Ordering::SeqCst));
    validate_agent_org_delete_ready(&plan, &quiesced)
        .expect("quiesced active status is safe behind cancelled fence");
}

#[tokio::test]
async fn session_hierarchy_delete_times_out_without_removing_runtime() {
    let _sandbox = test_helpers::test_env::sandbox();
    ensure_test_schemas();
    let root = "hierarchy-runtime-timeout-root";
    let state = AgentAppState::new();
    let runtime = std::sync::Arc::new(crate::state::AgentSession::new(
        root.to_string(),
        crate::definitions::AgentDefinition::default(),
    ));
    let release = std::sync::Arc::new(tokio::sync::Notify::new());
    let release_for_job = std::sync::Arc::clone(&release);
    runtime
        .scheduler
        .enqueue(crate::session::ScheduledMessage {
            kind: crate::session::ScheduledKind::Maintenance,
            message_id: "hierarchy-runtime-timeout".to_string(),
            generation: 0,
            client_message_id: None,
            turn_intent_id: "hierarchy-runtime-timeout-intent".to_string(),
            org_run_id: Some("hierarchy-runtime-timeout-run".to_string()),
            content: String::new(),
            execute: Box::new(move || {
                let release = std::sync::Arc::clone(&release_for_job);
                Box::pin(async move {
                    release.notified().await;
                    Ok(String::new())
                })
            }),
        })
        .await
        .expect("enqueue non-cooperative maintenance");
    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        while !runtime.scheduler.is_processing() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("maintenance starts");
    state
        .sessions
        .lock()
        .await
        .insert(root.to_string(), std::sync::Arc::clone(&runtime));
    let plan = AgentOrgSessionDeletePlan {
        run_id: "hierarchy-runtime-timeout-run".to_string(),
        root_session_id: root.to_string(),
        run_status: crate::coordination::agent_org_runs::AgentOrgRunStatus::Cancelled,
        sessions: vec![AgentOrgSessionDeleteNode {
            session_id: root.to_string(),
            parent_session_id: None,
            status: SessionStatus::Running,
            depth: 0,
        }],
    };

    let error = stop_agent_org_runtime_sessions_with_timeout(
        &state,
        &plan,
        std::time::Duration::from_millis(50),
    )
    .await
    .expect_err("non-cooperative work must time out");
    assert!(error.contains("Timed out stopping"));
    assert!(error.contains(root));
    assert!(state.get_session(root).await.is_some());
    release.notify_one();
    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        while runtime.scheduler.is_processing() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("maintenance finishes after the timeout assertion");
}

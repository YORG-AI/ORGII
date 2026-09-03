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
        );
        CREATE TABLE IF NOT EXISTS sessions (
            session_id TEXT PRIMARY KEY,
            event_count INTEGER NOT NULL DEFAULT 0,
            cached_at INTEGER NOT NULL,
            content_revision INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS session_turns (
            session_id TEXT NOT NULL,
            turn_id TEXT NOT NULL,
            start_sequence INTEGER NOT NULL,
            started_at TEXT NOT NULL,
            user_event_ids_json TEXT NOT NULL DEFAULT '[]',
            status TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (session_id, turn_id)
        );
        CREATE TABLE IF NOT EXISTS session_turn_index_state (
            session_id TEXT PRIMARY KEY,
            indexed_event_count INTEGER NOT NULL,
            rebuilt_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS orgtrack_core_activities (
            record_id TEXT PRIMARY KEY,
            source TEXT NOT NULL,
            session_id TEXT,
            timestamp TEXT NOT NULL,
            kind TEXT NOT NULL,
            payload_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS orgtrack_core_file_changes (
            record_id TEXT PRIMARY KEY,
            source TEXT NOT NULL,
            session_id TEXT NOT NULL,
            file_path TEXT NOT NULL,
            path_hash TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            payload_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS orgtrack_core_resources (
            resource_id TEXT PRIMARY KEY,
            resource_kind TEXT NOT NULL,
            canonical_locator TEXT NOT NULL,
            display_locator TEXT NOT NULL,
            payload_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS orgtrack_core_resource_interactions (
            interaction_id TEXT PRIMARY KEY,
            source TEXT NOT NULL,
            source_session_id TEXT,
            session_id TEXT NOT NULL,
            resource_id TEXT NOT NULL,
            action TEXT NOT NULL,
            outcome TEXT NOT NULL,
            occurred_at TEXT NOT NULL,
            capture_method TEXT NOT NULL,
            attribution_precision TEXT NOT NULL,
            payload_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS orgtrack_core_session_actors (
            actor_record_id TEXT PRIMARY KEY,
            source TEXT NOT NULL,
            source_session_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            actor_id TEXT NOT NULL,
            transcript_session_id TEXT,
            payload_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS orgtrack_core_edit_artifacts (
            record_id TEXT PRIMARY KEY,
            source TEXT NOT NULL,
            session_id TEXT NOT NULL,
            sequence_index INTEGER NOT NULL,
            file_path TEXT NOT NULL,
            path_hash TEXT NOT NULL,
            quality TEXT NOT NULL,
            payload_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS orgtrack_core_diff_chunks (
            record_id TEXT PRIMARY KEY,
            edit_record_id TEXT NOT NULL,
            source TEXT NOT NULL,
            session_id TEXT NOT NULL,
            sequence_index INTEGER NOT NULL,
            chunk_index INTEGER NOT NULL,
            file_path TEXT NOT NULL,
            quality TEXT NOT NULL,
            payload_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS orgtrack_core_final_diffs (
            record_id TEXT PRIMARY KEY,
            source TEXT NOT NULL,
            session_id TEXT NOT NULL,
            file_path TEXT NOT NULL,
            quality TEXT NOT NULL,
            computed_at TEXT NOT NULL,
            payload_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS orgtrack_core_session_checkpoints (
            checkpoint_id TEXT PRIMARY KEY,
            source TEXT NOT NULL,
            session_id TEXT NOT NULL,
            sequence_index INTEGER NOT NULL,
            checkpoint_kind TEXT NOT NULL,
            quality TEXT NOT NULL,
            undo_supported INTEGER NOT NULL,
            payload_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS orgtrack_core_checkpoint_file_states (
            record_id TEXT PRIMARY KEY,
            checkpoint_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            file_path TEXT NOT NULL,
            quality TEXT NOT NULL,
            payload_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS orgtrack_core_session_signals (
            session_id TEXT PRIMARY KEY,
            source TEXT NOT NULL,
            signals_version INTEGER NOT NULL,
            signals_json TEXT NOT NULL,
            computed_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS orgtrack_core_interaction_import_checkpoints (
            source TEXT NOT NULL,
            session_id TEXT NOT NULL,
            source_fingerprint TEXT NOT NULL,
            parser_version INTEGER NOT NULL,
            reconciled_at TEXT NOT NULL,
            PRIMARY KEY (source, session_id)
        );
        CREATE TABLE IF NOT EXISTS orgtrack_core_session_usage (
            session_id TEXT PRIMARY KEY,
            source TEXT NOT NULL,
            computed_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS orgtrack_core_sessions (
            session_id TEXT PRIMARY KEY,
            source TEXT NOT NULL,
            source_session_id TEXT NOT NULL,
            title TEXT NOT NULL,
            payload_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS orgtrack_core_commit_links (
            record_id TEXT PRIMARY KEY,
            commit_sha TEXT NOT NULL,
            linked_at TEXT NOT NULL,
            payload_json TEXT NOT NULL
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
    let now = "2026-07-16T00:00:00Z";
    if status == "archived" {
        let receipt_id = format!("archive-receipt-{run_id}");
        conn.execute(
            "INSERT INTO agent_org_runtime_runs (
                 id, org_id, coordinator_agent_id, root_session_id,
                 entry_mode, status, activation_generation, archived_at,
                 archive_receipt_id, created_at, updated_at
             ) VALUES (?1, 'org-delete-test', 'coordinator-agent', ?2,
                       'standalone_session', 'archived', 2, ?3, ?4, ?3, ?3)",
            rusqlite::params![run_id, root_session_id, now, &receipt_id],
        )
        .expect("seed archived run");
        conn.execute(
            "INSERT INTO agent_org_runtime_archive_episodes (
                 archive_receipt_id,org_run_id,archive_request_id,
                 archive_generation,teardown_status,teardown_attempt_count,
                 retained_runtime_count,deadline_at,archived_at,updated_at,quiesced_at
             ) VALUES (?1,?2,?3,2,'quiesced',1,0,?4,?5,?5,?5)",
            rusqlite::params![
                &receipt_id,
                run_id,
                format!("archive-request-{run_id}"),
                "2026-07-16T00:01:00Z",
                now,
            ],
        )
        .expect("seed quiesced Archive receipt");
    } else {
        conn.execute(
            "INSERT INTO agent_org_runtime_runs (
                 id, org_id, coordinator_agent_id, root_session_id,
                 entry_mode, status, created_at, updated_at
             ) VALUES (?1, 'org-delete-test', 'coordinator-agent', ?2,
                       'standalone_session', ?3, ?4, ?4)",
            rusqlite::params![run_id, root_session_id, status, now],
        )
        .expect("seed run");
    }
}

fn seed_run(run_id: &str, root_session_id: &str) {
    seed_run_with_status(run_id, root_session_id, "archived");
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
        "INSERT INTO sessions (
             session_id, event_count, cached_at, content_revision
         ) VALUES (?1, 1, 1, 1)",
        [session_id],
    )
    .expect("seed EventStore session metadata");
    conn.execute(
        "INSERT INTO session_turns (
             session_id, turn_id, start_sequence, started_at,
             user_event_ids_json, status, updated_at
         ) VALUES (?1, ?2, 0, ?3, '[]', 'completed', ?3)",
        rusqlite::params![
            session_id,
            format!("cached-turn-{session_id}"),
            "2026-07-16T00:00:00Z"
        ],
    )
    .expect("seed EventStore Turn index");
    conn.execute(
        "INSERT INTO session_turn_index_state (
             session_id, indexed_event_count, rebuilt_at
         ) VALUES (?1, 1, ?2)",
        rusqlite::params![session_id, "2026-07-16T00:00:00Z"],
    )
    .expect("seed EventStore Turn index state");
    conn.execute(
        "INSERT INTO session_turn_intents (
             session_id, turn_intent_id, source, status, created_at, updated_at
         ) VALUES (?1, ?2, 'user_submit', 'completed', ?3, ?3)",
        rusqlite::params![
            session_id,
            format!("intent-{session_id}"),
            "2026-07-16T00:00:00Z"
        ],
    )
    .expect("seed durable Turn intent");
    conn.execute(
        "INSERT INTO session_token_usage (
                 session_id, session_type, total_tokens, created_at
             ) VALUES (?1, 'agent', 1, ?2)",
        rusqlite::params![session_id, "2026-07-16T00:00:00Z"],
    )
    .expect("seed usage");
    let orgtrack_source = "orgii_rust_agents";
    let now = "2026-07-16T00:00:00Z";
    conn.execute(
        "INSERT INTO orgtrack_core_activities (
             record_id, source, session_id, timestamp, kind, payload_json
         ) VALUES (?1, ?2, ?3, ?4, 'tool', '{}')",
        rusqlite::params![
            format!("activity-{session_id}"),
            orgtrack_source,
            session_id,
            now
        ],
    )
    .expect("seed OrgTrack activity");
    conn.execute(
        "INSERT INTO orgtrack_core_file_changes (
             record_id, source, session_id, file_path, path_hash, timestamp, payload_json
         ) VALUES (?1, ?2, ?3, '/tmp/file', 'path-hash', 1, '{}')",
        rusqlite::params![
            format!("file-change-{session_id}"),
            orgtrack_source,
            session_id
        ],
    )
    .expect("seed OrgTrack file change");
    conn.execute(
        "INSERT INTO orgtrack_core_edit_artifacts (
             record_id, source, session_id, sequence_index, file_path,
             path_hash, quality, payload_json
         ) VALUES (?1, ?2, ?3, 1, '/tmp/file', 'path-hash', 'exact', '{}')",
        rusqlite::params![format!("edit-{session_id}"), orgtrack_source, session_id],
    )
    .expect("seed OrgTrack edit artifact");
    conn.execute(
        "INSERT INTO orgtrack_core_diff_chunks (
             record_id, edit_record_id, source, session_id, sequence_index,
             chunk_index, file_path, quality, payload_json
         ) VALUES (?1, ?2, ?3, ?4, 1, 0, '/tmp/file', 'exact', '{}')",
        rusqlite::params![
            format!("diff-{session_id}"),
            format!("edit-{session_id}"),
            orgtrack_source,
            session_id,
        ],
    )
    .expect("seed OrgTrack diff chunk");
    conn.execute(
        "INSERT INTO orgtrack_core_final_diffs (
             record_id, source, session_id, file_path, quality, computed_at, payload_json
         ) VALUES (?1, ?2, ?3, '/tmp/file', 'exact', ?4, '{}')",
        rusqlite::params![
            format!("final-diff-{session_id}"),
            orgtrack_source,
            session_id,
            now
        ],
    )
    .expect("seed OrgTrack final diff");
    conn.execute(
        "INSERT INTO orgtrack_core_session_checkpoints (
             checkpoint_id, source, session_id, sequence_index,
             checkpoint_kind, quality, undo_supported, payload_json
         ) VALUES (?1, ?2, ?3, 1, 'turn', 'exact', 1, '{}')",
        rusqlite::params![
            format!("checkpoint-{session_id}"),
            orgtrack_source,
            session_id
        ],
    )
    .expect("seed OrgTrack checkpoint");
    conn.execute(
        "INSERT INTO orgtrack_core_checkpoint_file_states (
             record_id, checkpoint_id, session_id, file_path, quality, payload_json
         ) VALUES (?1, ?2, ?3, '/tmp/file', 'exact', '{}')",
        rusqlite::params![
            format!("checkpoint-file-{session_id}"),
            format!("checkpoint-{session_id}"),
            session_id,
        ],
    )
    .expect("seed OrgTrack checkpoint file state");
    conn.execute(
        "INSERT INTO orgtrack_core_session_signals (
             session_id, source, signals_version, signals_json, computed_at
         ) VALUES (?1, ?2, 1, '{}', ?3)",
        rusqlite::params![session_id, orgtrack_source, now],
    )
    .expect("seed OrgTrack Session signals");
    conn.execute(
        "INSERT INTO orgtrack_core_interaction_import_checkpoints (
             source, session_id, source_fingerprint, parser_version, reconciled_at
         ) VALUES (?1, ?2, 'fingerprint', 1, ?3)",
        rusqlite::params![orgtrack_source, session_id, now],
    )
    .expect("seed OrgTrack import checkpoint");
    conn.execute(
        "INSERT INTO orgtrack_core_session_usage (
             session_id, source, computed_at
         ) VALUES (?1, ?2, ?3)",
        rusqlite::params![session_id, orgtrack_source, now],
    )
    .expect("seed OrgTrack Session usage");
    conn.execute(
        "INSERT OR IGNORE INTO orgtrack_core_resources (
             resource_id, resource_kind, canonical_locator, display_locator, payload_json
         ) VALUES (?1, 'file', ?2, ?2, '{}')",
        rusqlite::params![
            format!("resource-{session_id}"),
            format!("/tmp/{session_id}")
        ],
    )
    .expect("seed shared OrgTrack resource");
    conn.execute(
        "INSERT INTO orgtrack_core_resource_interactions (
             interaction_id, source, source_session_id, session_id, resource_id,
             action, outcome, occurred_at, capture_method,
             attribution_precision, payload_json
         ) VALUES (?1, ?2, ?3, ?3, ?4, 'write', 'success', ?5,
                   'test', 'exact', '{}')",
        rusqlite::params![
            format!("interaction-{session_id}"),
            orgtrack_source,
            session_id,
            format!("resource-{session_id}"),
            now,
        ],
    )
    .expect("seed OrgTrack resource interaction");
    conn.execute(
        "INSERT INTO orgtrack_core_session_actors (
             actor_record_id, source, source_session_id, session_id,
             actor_id, transcript_session_id, payload_json
         ) VALUES (?1, ?2, ?3, ?3, 'member', ?3, '{}')",
        rusqlite::params![format!("actor-{session_id}"), orgtrack_source, session_id],
    )
    .expect("seed OrgTrack Session actor");
    conn.execute(
        "INSERT INTO orgtrack_core_sessions (
             session_id, source, source_session_id, title, payload_json
         ) VALUES (?1, ?2, ?1, ?1, '{}')",
        rusqlite::params![session_id, orgtrack_source],
    )
    .expect("seed OrgTrack Session mirror");
    conn.execute(
        "INSERT INTO orgtrack_core_commit_links (
             record_id, commit_sha, linked_at, payload_json
         ) VALUES (?1, 'deadbeef', ?2, ?3)",
        rusqlite::params![
            format!("commit-link-{session_id}"),
            now,
            serde_json::json!({ "sessionIds": [session_id] }).to_string(),
        ],
    )
    .expect("seed OrgTrack commit link");
}

fn seed_run_owned_rows(run_id: &str) {
    let conn = get_connection().expect("sandbox DB");
    conn.execute(
        "INSERT INTO agent_org_runtime_inbox (
             recipient_agent_id, recipient_member_id, sender_agent_id,
             org_run_id, payload_kind, payload_json, created_at
         ) VALUES ('worker-agent', 'worker', 'system', ?1,
                   'plain', '{\"summary\":\"run history\",\"text\":\"body\"}', ?2)",
        rusqlite::params![run_id, "2026-07-16T00:00:00Z"],
    )
    .expect("seed run inbox history");
    conn.execute(
        r#"INSERT INTO agent_org_runtime_tasks (
             id, org_run_id, activation_generation, subject, description, owner, status,
             execution_mode, blocked_by_json, output_json,
             created_by_participant_id, source_turn_intent_id,
             created_at, updated_at
         ) VALUES (
             ?1, ?2, 1, 'delete me', '', 'worker', 'completed',
             'build', '[]',
             '{"summary":"delete me","content":null,"artifactIds":[],"producedByMemberId":"worker","producedAt":"2026-07-16T00:00:00Z"}',
             'coordinator', 'delete-test-fixture', ?3, ?3
         )"#,
        rusqlite::params![format!("task-{run_id}"), run_id, "2026-07-16T00:00:00Z"],
    )
    .expect("seed run task history");
    conn.execute(
        "INSERT INTO agent_org_runtime_task_execution_handoffs (
             id,org_run_id,activation_generation,request_id,request_digest,
             old_task_id,old_owner_member_id,state,requested_at,updated_at
         ) VALUES (?1,?2,1,?3,?4,?5,'worker','unknown',?6,?6)",
        rusqlite::params![
            format!("handoff-{run_id}"),
            run_id,
            format!("handoff-request-{run_id}"),
            "d".repeat(64),
            format!("task-{run_id}"),
            "2026-07-16T00:00:00Z",
        ],
    )
    .expect("seed run handoff history");
}

fn seed_active_session_registry(session_id: &str) {
    crate::session::file_registry::register_session(
        &crate::session::file_registry::SessionRegistryEntry {
            session_id: session_id.to_string(),
            agent_type: "SDE Agent".to_string(),
            model: "test-model".to_string(),
            workspace_path: Some("/tmp/agent-org-delete-test".to_string()),
            status: "running".to_string(),
            started_at: "2026-07-16T00:00:00Z".to_string(),
            last_updated_at: "2026-07-16T00:00:00Z".to_string(),
        },
    )
    .expect("seed active-session registry");
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
        seed_active_session_registry(session_id);
    }
    seed_run_owned_rows("hierarchy-delete-run");
    seed_run_owned_rows("hierarchy-delete-other-run");

    let conn = get_connection().expect("sandbox DB");
    let plan = load_agent_org_session_delete_plan(&conn, root)
        .expect("plan hierarchy")
        .expect("root owns Agent Org run");
    drop(conn);
    let receipt = delete_agent_org_session_hierarchy(&plan).expect("delete completed hierarchy");

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
            "sessions",
            "session_turns",
            "session_turn_index_state",
            "session_turn_intents",
            "session_token_usage",
            "orgtrack_core_activities",
            "orgtrack_core_file_changes",
            "orgtrack_core_edit_artifacts",
            "orgtrack_core_diff_chunks",
            "orgtrack_core_final_diffs",
            "orgtrack_core_session_checkpoints",
            "orgtrack_core_checkpoint_file_states",
            "orgtrack_core_session_signals",
            "orgtrack_core_interaction_import_checkpoints",
            "orgtrack_core_session_usage",
            "orgtrack_core_resource_interactions",
            "orgtrack_core_session_actors",
            "orgtrack_core_sessions",
        ] {
            assert!(
                !row_exists(table, "session_id", session_id),
                "{table} still contains {session_id}"
            );
        }
        assert!(!row_exists(
            "orgtrack_core_commit_links",
            "record_id",
            &format!("commit-link-{session_id}")
        ));
    }
    assert!(!row_exists(
        "agent_org_runtime_runs",
        "id",
        "hierarchy-delete-run"
    ));
    assert!(!row_exists(
        "agent_org_runtime_inbox",
        "org_run_id",
        "hierarchy-delete-run"
    ));
    assert!(!row_exists(
        "agent_org_runtime_tasks",
        "org_run_id",
        "hierarchy-delete-run"
    ));
    assert!(!row_exists(
        "agent_org_runtime_task_execution_handoffs",
        "org_run_id",
        "hierarchy-delete-run"
    ));
    assert!(row_exists("agent_sessions", "session_id", unrelated));
    assert!(row_exists("agent_messages", "session_id", unrelated));
    assert!(row_exists(
        "orgtrack_core_edit_artifacts",
        "session_id",
        unrelated
    ));
    assert!(row_exists(
        "orgtrack_core_commit_links",
        "record_id",
        &format!("commit-link-{unrelated}")
    ));
    assert!(row_exists(
        "agent_org_runtime_runs",
        "id",
        "hierarchy-delete-other-run"
    ));
    assert!(row_exists(
        "agent_org_runtime_inbox",
        "org_run_id",
        "hierarchy-delete-other-run"
    ));
    assert!(row_exists(
        "agent_org_runtime_task_execution_handoffs",
        "org_run_id",
        "hierarchy-delete-other-run"
    ));
    let mut registered_session_ids = crate::session::file_registry::list_registered_sessions()
        .into_iter()
        .map(|entry| entry.session_id)
        .collect::<Vec<_>>();
    registered_session_ids.sort();
    assert_eq!(registered_session_ids, vec![unrelated.to_string()]);
}

#[test]
fn team_ownership_resolver_maps_worker_to_root_and_run() {
    let _sandbox = test_helpers::test_env::sandbox();
    ensure_test_schemas();
    let root = "hierarchy-worker-root";
    let worker = "hierarchy-worker-direct-delete";
    seed_session(root, None);
    seed_session(worker, Some(root));
    seed_run("hierarchy-worker-run", root);
    seed_run_owned_rows("hierarchy-worker-run");

    let conn = get_connection().expect("sandbox DB");
    let plan = load_agent_org_session_delete_plan(&conn, worker)
        .expect("plan worker")
        .expect("worker must resolve to its Team");
    assert_eq!(plan.root_session_id, root);
    assert_eq!(plan.run_id, "hierarchy-worker-run");
    drop(conn);

    assert!(row_exists("agent_sessions", "session_id", worker));
    assert!(row_exists("agent_sessions", "session_id", root));
    assert!(row_exists(
        "agent_org_runtime_runs",
        "id",
        "hierarchy-worker-run"
    ));
    assert!(row_exists(
        "agent_org_runtime_inbox",
        "org_run_id",
        "hierarchy-worker-run"
    ));
}

#[test]
fn session_hierarchy_delete_requires_archived_without_mutating_active_run() {
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
    let error = validate_agent_org_delete_ready(&plan)
        .expect_err("Delete must fail closed before the Archive transition exists");
    assert!(error.contains("team_delete_requires_archived"));
    assert_eq!(
        get_connection()
            .expect("sandbox DB")
            .query_row(
                "SELECT status FROM agent_org_runtime_runs WHERE id='hierarchy-active-run'",
                [],
                |row| row.get::<_, String>(0)
            )
            .expect("load unchanged status"),
        "running"
    );
    assert!(row_exists("agent_sessions", "session_id", root));
    assert!(row_exists("agent_sessions", "session_id", worker));
    assert!(row_exists(
        "agent_org_runtime_runs",
        "id",
        "hierarchy-active-run"
    ));
}

#[test]
fn session_hierarchy_delete_rejects_retained_runtime_receipt() {
    let _sandbox = test_helpers::test_env::sandbox();
    ensure_test_schemas();
    let root = "hierarchy-retained-root";
    let run_id = "hierarchy-retained-run";
    seed_session(root, None);
    seed_run(run_id, root);
    let conn = get_connection().expect("sandbox DB");
    conn.execute(
        "UPDATE agent_org_runtime_archive_episodes
         SET teardown_status='retained_runtime',teardown_attempt_count=3,
             retained_runtime_count=1,quiesced_at=NULL,
             last_error='archive_runtime_stop_timeout'
         WHERE org_run_id=?1",
        [run_id],
    )
    .expect("mark retained runtime");
    let plan = load_agent_org_session_delete_plan(&conn, root)
        .expect("load Team")
        .expect("Team plan");
    let error = validate_agent_org_delete_ready_with_connection(&conn, &plan)
        .expect_err("retained runtime must block Team Delete");
    assert!(error.starts_with("team_runtime_not_quiesced:"));
    assert!(row_exists("agent_sessions", "session_id", root));
    assert!(row_exists("agent_org_runtime_runs", "id", run_id));
}

#[test]
fn orphaned_agent_org_member_marker_never_falls_back_to_generic_delete() {
    let _sandbox = test_helpers::test_env::sandbox();
    ensure_test_schemas();
    let session_id = "hierarchy-orphaned-member";
    seed_session(session_id, None);
    let conn = get_connection().expect("sandbox DB");
    conn.execute(
        "UPDATE agent_sessions SET org_member_id='worker' WHERE session_id=?1",
        [session_id],
    )
    .expect("seed orphaned Agent Org marker");
    let error = load_agent_org_session_delete_plan(&conn, session_id)
        .expect_err("orphaned Agent Org ownership must fail closed");
    assert!(error.starts_with("agent_org_ownership_ambiguous:"));
    assert!(row_exists("agent_sessions", "session_id", session_id));
}

#[test]
fn orphaned_agent_org_root_with_marked_member_never_falls_back_to_generic_delete() {
    let _sandbox = test_helpers::test_env::sandbox();
    ensure_test_schemas();
    let root = "hierarchy-orphaned-root";
    let member = "hierarchy-orphaned-root-member";
    seed_session(root, None);
    seed_session(member, Some(root));
    let conn = get_connection().expect("sandbox DB");
    conn.execute(
        "UPDATE agent_sessions SET org_member_id='worker' WHERE session_id=?1",
        [member],
    )
    .expect("seed orphaned Agent Org descendant marker");

    let error = load_agent_org_session_delete_plan(&conn, root)
        .expect_err("orphaned Agent Org root ownership must fail closed");
    assert!(error.starts_with("agent_org_ownership_ambiguous:"));
    assert!(row_exists("agent_sessions", "session_id", root));
    assert!(row_exists("agent_sessions", "session_id", member));
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

    let error = delete_agent_org_session_hierarchy(&plan)
        .expect_err("active replay must block hierarchy deletion");
    assert!(error.contains(worker));
    assert!(error.contains("shell replay calls are active"));
    assert!(row_exists("agent_sessions", "session_id", root));
    assert!(row_exists("agent_sessions", "session_id", worker));
    assert!(row_exists(
        "agent_org_runtime_runs",
        "id",
        "hierarchy-replay-run"
    ));

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
    let error = delete_agent_org_session_hierarchy(&plan)
        .expect_err("worktree validation failure must block hierarchy deletion");
    assert!(error.contains(worker));
    assert!(error.contains("repository path no longer exists"));
    assert!(row_exists("agent_sessions", "session_id", root));
    assert!(row_exists("agent_sessions", "session_id", worker));
    assert!(row_exists(
        "agent_org_runtime_runs",
        "id",
        "hierarchy-replay-run"
    ));

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
        "agent_org_runtime_runs",
        "id",
        "hierarchy-nested-outer-run"
    ));
    assert!(row_exists(
        "agent_org_runtime_runs",
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
    for index in 0..crate::coordination::agent_org_ownership::MAX_AGENT_ORG_OWNED_SESSIONS {
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
    assert!(row_exists(
        "agent_org_runtime_runs",
        "id",
        "hierarchy-limit-run"
    ));
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

    let error =
        delete_agent_org_session_hierarchy(&plan).expect_err("changed hierarchy must fail closed");
    assert!(error.contains("changed before deletion"));
    for session_id in [root, worker, "hierarchy-recheck-late-worker"] {
        assert!(row_exists("agent_sessions", "session_id", session_id));
    }
    assert!(row_exists(
        "agent_org_runtime_runs",
        "id",
        "hierarchy-recheck-run"
    ));
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

    let error =
        delete_agent_org_session_hierarchy(&plan).expect_err("trigger must abort transaction");
    assert!(error.contains("injected hierarchy delete failure"));
    for session_id in [root, worker] {
        for table in [
            "agent_sessions",
            "agent_messages",
            "agent_todos",
            "events",
            "sessions",
            "session_turns",
            "session_turn_index_state",
            "session_turn_intents",
            "session_token_usage",
            "orgtrack_core_activities",
            "orgtrack_core_file_changes",
            "orgtrack_core_edit_artifacts",
            "orgtrack_core_diff_chunks",
            "orgtrack_core_final_diffs",
            "orgtrack_core_session_checkpoints",
            "orgtrack_core_checkpoint_file_states",
            "orgtrack_core_session_signals",
            "orgtrack_core_interaction_import_checkpoints",
            "orgtrack_core_session_usage",
            "orgtrack_core_resource_interactions",
            "orgtrack_core_session_actors",
            "orgtrack_core_sessions",
        ] {
            assert!(
                row_exists(table, "session_id", session_id),
                "{table} lost {session_id} despite rollback"
            );
        }
        assert!(row_exists(
            "orgtrack_core_commit_links",
            "record_id",
            &format!("commit-link-{session_id}")
        ));
    }
    assert!(row_exists(
        "agent_org_runtime_runs",
        "id",
        "hierarchy-rollback-run"
    ));
    assert!(row_exists(
        "agent_org_runtime_inbox",
        "org_run_id",
        "hierarchy-rollback-run"
    ));
    assert!(row_exists(
        "agent_org_runtime_tasks",
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

    let error = delete_agent_org_session_hierarchy(&plan)
        .expect_err("transaction-time hierarchy mutation must abort");
    assert!(error.contains("residual session hierarchy row"));
    assert!(row_exists("agent_sessions", "session_id", root));
    assert!(row_exists("agent_sessions", "session_id", worker));
    assert!(!row_exists("agent_sessions", "session_id", injected));
    assert!(row_exists(
        "agent_org_runtime_runs",
        "id",
        "hierarchy-trigger-change-run"
    ));
}

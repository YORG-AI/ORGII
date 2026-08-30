use database::db::get_connection;
use rusqlite::{params, OptionalExtension};

use super::*;

const RUN_ID: &str = "task-store-contract-run";
const ROOT_SESSION: &str = "task-store-contract-root-session";
const COORDINATOR_TURN: &str = "task-store-contract-coordinator-turn";
const MEMBER_A: &str = "member-a";
const MEMBER_B: &str = "member-b";
const MEMBER_A_SESSION: &str = "task-store-contract-member-a-session";
const MEMBER_B_SESSION: &str = "task-store-contract-member-b-session";

struct Fixture {
    _sandbox: test_helpers::test_env::SandboxGuard,
}

fn fixture() -> Fixture {
    let sandbox = test_helpers::test_env::sandbox();
    let conn = get_connection().expect("Task Store contract test database");
    conn.execute_batch(
        "CREATE TABLE agent_sessions (
            session_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            agent_definition_id TEXT,
            org_member_id TEXT
        );
        CREATE TABLE session_turn_intents (
            session_id TEXT NOT NULL,
            turn_intent_id TEXT NOT NULL,
            client_message_id TEXT,
            org_run_id TEXT,
            source TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(session_id,turn_intent_id)
        );
        CREATE TABLE events (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            function_name TEXT,
            args_json TEXT NOT NULL DEFAULT '{}',
            result_json TEXT NOT NULL DEFAULT '{}',
            content TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            meta_json TEXT
        );",
    )
    .expect("base Turn table");
    crate::coordination::agent_org_runs::init_schema(&conn).expect("run schema");
    crate::coordination::agent_org_turn_contexts::create_schema(&conn)
        .expect("Turn context schema");
    crate::coordination::agent_inbox::create_schema(&conn).expect("Agent Inbox schema");
    crate::coordination::agent_org_user_directed_work::create_schema(&conn)
        .expect("UserDirectedWork authority schema");
    crate::coordination::agent_org_watchdog::init_schema(&conn).expect("recovery schema");
    init_schema(&conn).expect("Task schema");
    crate::coordination::agent_org_task_handoffs::create_schema(&conn)
        .expect("Task execution handoff schema");
    let now = chrono::Utc::now().to_rfc3339();
    let snapshot = serde_json::json!({
        "schemaVersion": 1,
        "orgId": "task-store-contract-org",
        "orgName": "Task Store Contract Team",
        "coordinatorRole": "Lead",
        "coordinatorAgentId": "agent-coordinator",
        "planApprovalPolicy": "coordinator",
        "members": [
            {"memberId": MEMBER_A, "name": "A", "role": "Builder", "agentId": "agent-a"},
            {"memberId": MEMBER_B, "name": "B", "role": "Reviewer", "agentId": "agent-b"}
        ],
        "additionalTaskGraphWriterMemberIds": [],
        "memberCommunicationLinks": [],
    })
    .to_string();
    conn.execute(
        "INSERT INTO agent_org_runtime_runs(
            id,org_id,coordinator_agent_id,root_session_id,org_snapshot_json,
            entry_mode,status,activation_generation,created_at,updated_at
         ) VALUES (?1,'task-store-contract-org','agent-coordinator',?2,?3,
                   'standalone_session','running',1,?4,?4)",
        params![RUN_ID, ROOT_SESSION, snapshot, now],
    )
    .expect("running Team");
    for (session_id, member_id, agent_id) in [
        (MEMBER_A_SESSION, MEMBER_A, "agent-a"),
        (MEMBER_B_SESSION, MEMBER_B, "agent-b"),
    ] {
        insert_member_session(&conn, member_id, agent_id, session_id, 1);
    }
    insert_coordinator_context(&conn, COORDINATOR_TURN, 1);
    Fixture { _sandbox: sandbox }
}

fn insert_member_session(
    conn: &rusqlite::Connection,
    member_id: &str,
    agent_id: &str,
    session_id: &str,
    generation: i64,
) {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO agent_sessions(
            session_id,name,status,created_at,updated_at,
            agent_definition_id,org_member_id
         ) VALUES (?1,?2,'idle',?3,?3,?4,?2)",
        params![session_id, member_id, now, agent_id],
    )
    .expect("canonical Member session");
    insert_member_materialization(conn, member_id, agent_id, session_id, generation);
}

fn insert_member_materialization(
    conn: &rusqlite::Connection,
    member_id: &str,
    agent_id: &str,
    session_id: &str,
    generation: i64,
) {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO agent_org_runtime_member_materializations(
            org_run_id,member_id,agent_id,generation,session_id,
            authority_class,status,created_at,updated_at
         ) VALUES (?1,?2,?3,?4,?5,'formal','succeeded',?6,?6)",
        params![RUN_ID, member_id, agent_id, generation, session_id, now],
    )
    .expect("canonical Member materialization");
}

fn insert_base_turn(conn: &rusqlite::Connection, session_id: &str, turn_id: &str) {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO session_turn_intents(
            session_id,turn_intent_id,org_run_id,source,status,created_at,updated_at
         ) VALUES (?1,?2,?3,'agent_org','running',?4,?4)",
        params![session_id, turn_id, RUN_ID, now],
    )
    .expect("base Turn");
}

fn insert_coordinator_context(conn: &rusqlite::Connection, turn_id: &str, generation: i64) {
    insert_base_turn(conn, ROOT_SESSION, turn_id);
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO agent_org_runtime_turn_contexts(
            session_id,turn_intent_id,org_run_id,participant_id,turn_kind,
            source_kind,source_id,activation_generation,created_at
         ) VALUES (?1,?2,?3,'coordinator','coordinator','root_turn',?2,?4,?5)",
        params![ROOT_SESSION, turn_id, RUN_ID, generation, now],
    )
    .expect("Coordinator context");
}

fn insert_user_coordinator_context(conn: &rusqlite::Connection, turn_id: &str, generation: i64) {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO session_turn_intents(
            session_id,turn_intent_id,org_run_id,source,status,created_at,updated_at
         ) VALUES (?1,?2,?3,'user_submit','running',?4,?4)",
        params![ROOT_SESSION, turn_id, RUN_ID, now],
    )
    .expect("user Coordinator Turn");
    conn.execute(
        "INSERT INTO agent_org_runtime_turn_contexts(
            session_id,turn_intent_id,org_run_id,participant_id,turn_kind,
            source_kind,source_id,activation_generation,created_at
         ) VALUES (?1,?2,?3,'coordinator','coordinator','root_turn',?2,?4,?5)",
        params![ROOT_SESSION, turn_id, RUN_ID, generation, now],
    )
    .expect("user Coordinator context");
}

fn insert_owner_context(
    conn: &rusqlite::Connection,
    member_id: &str,
    session_id: &str,
    turn_id: &str,
    task_id: &str,
    generation: i64,
) {
    insert_base_turn(conn, session_id, turn_id);
    let sequence: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(member_dispatch_sequence),0)+1
             FROM agent_org_runtime_turn_contexts
             WHERE org_run_id=?1 AND dispatch_member_id=?2",
            params![RUN_ID, member_id],
            |row| row.get(0),
        )
        .expect("next sequence");
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO agent_org_runtime_turn_contexts(
            session_id,turn_intent_id,org_run_id,participant_id,turn_kind,
            task_id,owner_member_id,dispatch_member_id,member_dispatch_sequence,
            source_kind,source_id,activation_generation,created_at
         ) VALUES (?1,?2,?3,?4,'task_execution',?5,?4,?4,?6,
                   'task',?5,?7,?8)",
        params![session_id, turn_id, RUN_ID, member_id, task_id, sequence, generation, now],
    )
    .expect("Owner TaskExecution context");
}

fn grant_additional_writer(conn: &rusqlite::Connection, member_id: &str) {
    let snapshot: String = conn
        .query_row(
            "SELECT org_snapshot_json FROM agent_org_runtime_runs WHERE id=?1",
            [RUN_ID],
            |row| row.get(0),
        )
        .expect("read launch snapshot");
    let mut snapshot: serde_json::Value =
        serde_json::from_str(&snapshot).expect("decode launch snapshot");
    snapshot["additionalTaskGraphWriterMemberIds"] = serde_json::json!([member_id]);
    conn.execute(
        "UPDATE agent_org_runtime_runs SET org_snapshot_json=?2 WHERE id=?1",
        params![RUN_ID, snapshot.to_string()],
    )
    .expect("grant additional Writer in immutable test snapshot");
}

fn insert_direct_context(
    conn: &rusqlite::Connection,
    member_id: &str,
    session_id: &str,
    turn_id: &str,
) {
    insert_base_turn(conn, session_id, turn_id);
    let source_event_id = format!("event-{turn_id}");
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO events(
             id,session_id,event_type,function_name,result_json,created_at,meta_json
         ) VALUES (?1,?2,'raw','user_message',?3,?4,?5)",
        params![
            &source_event_id,
            session_id,
            serde_json::json!({
                "message": {"content": "direct graph work", "role": "user"},
                "syntheticUserInput": true,
                "agentOrgDirectSource": true,
                "turnIntentId": turn_id,
            })
            .to_string(),
            &now,
            serde_json::json!({"source": "user"}).to_string(),
        ],
    )
    .expect("direct EventStore source");
    let sequence: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(member_dispatch_sequence),0)+1
             FROM agent_org_runtime_turn_contexts
             WHERE org_run_id=?1 AND dispatch_member_id=?2",
            params![RUN_ID, member_id],
            |row| row.get(0),
        )
        .expect("next direct sequence");
    conn.execute(
        "INSERT INTO agent_org_runtime_turn_contexts(
             session_id,turn_intent_id,org_run_id,participant_id,turn_kind,
             dispatch_member_id,member_dispatch_sequence,source_kind,source_id,
             root_authority_turn_id,actor_version,created_at
         ) VALUES (?1,?2,?3,?4,'user_directed_work',?4,?5,
                   'direct_member',?6,?2,1,?7)",
        params![
            session_id,
            turn_id,
            RUN_ID,
            member_id,
            sequence,
            source_event_id,
            now,
        ],
    )
    .expect("direct UserDirectedWork context");
    crate::coordination::agent_org_user_directed_work::insert_root_delivery_with_connection(
        conn,
        &crate::coordination::agent_org_user_directed_work::NewUserDirectedDelivery {
            org_run_id: RUN_ID,
            session_id,
            turn_intent_id: turn_id,
            root_authority_turn_id: turn_id,
            parent_delivery_id: None,
            parent_inbox_id: None,
            source_kind: crate::coordination::agent_org_user_directed_work::UserDirectedSourceKind::DirectMember,
            source_event_id: Some(&source_event_id),
            source_inbox_id: None,
            dispatch_member_id: member_id,
            member_dispatch_sequence: sequence,
            depth: 0,
            delivery_ordinal: 1,
            dispatch_content: "direct graph work",
            display_content: "direct graph work",
            images: None,
        },
    )
    .expect("direct UserDirectedWork authority");
}

fn graph_actor() -> TaskGraphWriterAdmin {
    TaskGraphWriterAdmin::new(ROOT_SESSION, COORDINATOR_TURN).expect("graph actor")
}

fn direct_graph_actor(session_id: &str, turn_id: &str) -> TaskGraphWriterAdmin {
    TaskGraphWriterAdmin::new(session_id, turn_id).expect("direct graph actor")
}

fn owner_actor(session_id: &str, turn_id: &str) -> TaskOwnerExecution {
    TaskOwnerExecution::new(session_id, turn_id).expect("Owner actor")
}

fn pending(id: &str, owner: Option<&str>, blocked_by: Vec<&str>) -> CreatePendingTaskParams {
    let eligible = owner
        .map(|owner| vec![owner.to_string()])
        .unwrap_or_else(|| vec![MEMBER_A.to_string(), MEMBER_B.to_string()]);
    CreatePendingTaskParams {
        id: id.to_string(),
        org_run_id: RUN_ID.to_string(),
        subject: format!("Task {id}"),
        description: format!("Description for {id}"),
        active_form: None,
        owner: owner.map(str::to_string),
        execution_mode: TaskExecutionMode::Build,
        blocked_by: blocked_by.into_iter().map(str::to_string).collect(),
        metadata: Some(serde_json::json!({
            TASK_METADATA_ELIGIBLE_MEMBER_IDS: eligible,
        })),
        originating_message_id: Some(format!("message-{id}")),
        replaces_task_id: None,
    }
}

fn create(params: CreatePendingTaskParams) -> Task {
    AgentOrgTaskStore::create_pending_with_transactional_effects(
        graph_actor(),
        params,
        TaskCreateSchedulingPolicy {
            allow_parallel_with_unlisted_open_tasks: true,
        },
        |_tx, _task, _tasks| Ok(()),
    )
    .expect("create pending Task")
    .0
}

fn start(task_id: &str, session_id: &str, turn_id: &str) -> TaskMutationOutcome {
    AgentOrgTaskStore::owner_start_with_transactional_effects(
        owner_actor(session_id, turn_id),
        RUN_ID,
        task_id,
        |_tx, _outcome, _tasks| Ok(()),
    )
    .expect("start Task")
    .0
}

fn assign_pending(task_id: &str, owner_member_id: &str) -> Task {
    AgentOrgTaskStore::patch_pending_with_transactional_effects(
        graph_actor(),
        RUN_ID,
        task_id,
        PendingTaskGraphPatch {
            owner: Some(Some(owner_member_id.to_string())),
            ..Default::default()
        },
        |_tx, _outcome, _tasks| Ok(()),
    )
    .expect("assign pending Task")
    .0
    .current
}

#[test]
fn sparse_graph_patches_merge_latest_fields_and_metadata_subkeys() {
    let _fixture = fixture();
    let mut task = pending("sparse-lww", Some(MEMBER_A), vec![]);
    task.metadata = Some(serde_json::json!({
        TASK_METADATA_ELIGIBLE_MEMBER_IDS: [MEMBER_A],
        "retained": "keep",
        "removed": "old"
    }));
    create(task);

    AgentOrgTaskStore::patch_pending_with_transactional_effects(
        graph_actor(),
        RUN_ID,
        "sparse-lww",
        PendingTaskGraphPatch {
            description: Some("first description".to_string()),
            metadata_merge_patch: Some(serde_json::json!({
                "first": 1,
                "removed": null
            })),
            ..Default::default()
        },
        |_tx, _outcome, _tasks| Ok(()),
    )
    .expect("first sparse patch");
    AgentOrgTaskStore::patch_pending_with_transactional_effects(
        graph_actor(),
        RUN_ID,
        "sparse-lww",
        PendingTaskGraphPatch {
            subject: Some("latest subject".to_string()),
            metadata_merge_patch: Some(serde_json::json!({"second": 2})),
            ..Default::default()
        },
        |_tx, _outcome, _tasks| Ok(()),
    )
    .expect("second sparse patch");
    AgentOrgTaskStore::patch_pending_with_transactional_effects(
        graph_actor(),
        RUN_ID,
        "sparse-lww",
        PendingTaskGraphPatch {
            description: Some("last description".to_string()),
            ..Default::default()
        },
        |_tx, _outcome, _tasks| Ok(()),
    )
    .expect("same field uses last legal commit");

    let stored = AgentOrgTaskStore::get(RUN_ID, "sparse-lww")
        .unwrap()
        .unwrap();
    assert_eq!(stored.subject, "latest subject");
    assert_eq!(stored.description, "last description");
    let metadata = stored.metadata.unwrap();
    assert_eq!(metadata["retained"], "keep");
    assert_eq!(metadata["first"], 1);
    assert_eq!(metadata["second"], 2);
    assert!(metadata.get("removed").is_none());
    assert_eq!(
        metadata[TASK_METADATA_ELIGIBLE_MEMBER_IDS],
        serde_json::json!([MEMBER_A])
    );
}

#[test]
fn active_episode_semantic_duplicate_is_rejected_across_turns_and_terminal_history() {
    let _fixture = fixture();
    let mut first = pending("duplicate-first", Some(MEMBER_A), vec![]);
    first.subject = "Verify Texas Hold'em UI!".to_string();
    first.description = "Run the packaged-app smoke test.".to_string();
    create(first);
    let conn = get_connection().unwrap();
    insert_owner_context(
        &conn,
        MEMBER_A,
        MEMBER_A_SESSION,
        "turn-duplicate-first",
        "duplicate-first",
        1,
    );
    start("duplicate-first", MEMBER_A_SESSION, "turn-duplicate-first");
    AgentOrgTaskStore::owner_complete_with_transactional_effects(
        owner_actor(MEMBER_A_SESSION, "turn-duplicate-first"),
        RUN_ID,
        "duplicate-first",
        TaskOutputInput {
            summary: "packaged smoke passed".to_string(),
            content: None,
            artifact_ids: Vec::new(),
        },
        |_tx, _outcome, _tasks| Ok(()),
    )
    .expect("first Task reaches terminal history");

    const RESUME_TURN: &str = "task-store-contract-member-idle-resume";
    insert_coordinator_context(&conn, RESUME_TURN, 1);
    let resume_actor = TaskGraphWriterAdmin::new(ROOT_SESSION, RESUME_TURN).unwrap();

    let mut duplicate = pending("duplicate-second", Some(MEMBER_A), vec![]);
    duplicate.subject = "  verify texas hold em ui  ".to_string();
    duplicate.description = "Run the packaged app smoke test".to_string();
    let error = AgentOrgTaskStore::create_pending_with_transactional_effects(
        resume_actor.clone(),
        duplicate,
        TaskCreateSchedulingPolicy {
            allow_parallel_with_unlisted_open_tasks: true,
        },
        |_tx, _task, _tasks| Ok(()),
    )
    .expect_err("cross-Turn duplicate of terminal episode work must be rejected");
    assert_eq!(
        error,
        format!("{TASK_ACTIVE_EPISODE_DUPLICATE_ERROR}:duplicate-first")
    );
    assert!(AgentOrgTaskStore::get(RUN_ID, "duplicate-second")
        .unwrap()
        .is_none());

    let mut near_duplicate = pending("duplicate-third", Some(MEMBER_A), vec![]);
    near_duplicate.subject = "Verify Texas Hold'em table UI".to_string();
    near_duplicate.description = "Run the packaged-app smoke test".to_string();
    let error = AgentOrgTaskStore::create_pending_with_transactional_effects(
        resume_actor.clone(),
        near_duplicate,
        TaskCreateSchedulingPolicy {
            allow_parallel_with_unlisted_open_tasks: true,
        },
        |_tx, _task, _tasks| Ok(()),
    )
    .expect_err("cross-Turn near-duplicate responsibility must be rejected");
    assert_eq!(
        error,
        format!("{TASK_ACTIVE_EPISODE_DUPLICATE_ERROR}:duplicate-first")
    );

    let mut distinct = pending("distinct-test", Some(MEMBER_A), vec![]);
    distinct.subject = "Verify Texas Hold'em UI".to_string();
    distinct.description = "Run the accessibility scenario instead".to_string();
    AgentOrgTaskStore::create_pending_with_transactional_effects(
        resume_actor,
        distinct,
        TaskCreateSchedulingPolicy {
            allow_parallel_with_unlisted_open_tasks: true,
        },
        |_tx, _task, _tasks| Ok(()),
    )
    .expect("a genuinely distinct goal remains legal");
}

#[test]
fn unresolved_episode_rejection_is_pre_write_even_when_the_caller_commits_guidance() {
    let _fixture = fixture();
    create(pending("active-episode-task", Some(MEMBER_A), vec![]));

    const FOLLOWUP_TURN: &str = "task-store-contract-user-followup";
    let conn = get_connection().expect("Task Store contract test database");
    insert_user_coordinator_context(&conn, FOLLOWUP_TURN, 1);
    let tx = database::db::begin_immediate(&conn).expect("guidance transaction");
    let error = AgentOrgTaskStore::create_pending_in_tx(
        &tx,
        TaskGraphWriterAdmin::new(ROOT_SESSION, FOLLOWUP_TURN).unwrap(),
        pending("must-not-leak", Some(MEMBER_A), vec![]),
        TaskCreateSchedulingPolicy {
            allow_parallel_with_unlisted_open_tasks: true,
        },
        |_tx, _task, _tasks| Ok(()),
    )
    .expect_err("new user work must be rejected before any Task write");
    assert!(error.starts_with(
        crate::coordination::agent_org_work_episodes::UNRESOLVED_EPISODE_NEW_MISSION_ERROR
    ));

    // Tool receipts intentionally commit structured guidance. The producing
    // boundary must therefore reject before writing, not rely on rollback.
    tx.commit().expect("commit guidance receipt transaction");
    assert!(AgentOrgTaskStore::get(RUN_ID, "must-not-leak")
        .unwrap()
        .is_none());
    assert_eq!(
        crate::coordination::agent_org_work_episodes::unassociated_task_count_with_connection(
            &conn, RUN_ID
        )
        .unwrap(),
        0
    );
}

#[test]
fn current_generation_certificate_freezes_every_task_write_path() {
    let _fixture = fixture();
    create(pending("certified", Some(MEMBER_A), vec![]));
    create(pending("certified-terminal", Some(MEMBER_A), vec![]));
    AgentOrgTaskStore::cancel_with_transactional_effects(
        graph_actor(),
        RUN_ID,
        "certified-terminal",
        TaskTerminalReason {
            code: "scope.changed".to_string(),
            message: "terminal before certification".to_string(),
            source_event_id: None,
        },
        |_tx, _outcome, _tasks| Ok(()),
    )
    .unwrap();
    let conn = get_connection().unwrap();
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO agent_org_runtime_run_completion_certificates(
             id,org_run_id,activation_generation,work_revision,request_id,request_digest,
             outcome,summary,coordinator_session_id,coordinator_turn_intent_id,
             evidence_task_ids_json,closure_task_ids_json,task_output_refs_json,
             resolution_links_json,validator_version,created_at
         ) VALUES ('certificate',?1,1,0,'request',?2,'cancelled','stopped',?3,?4,
                   '[]','[]','[]','[]',1,?5)",
        params![RUN_ID, "a".repeat(64), ROOT_SESSION, COORDINATOR_TURN, now],
    )
    .unwrap();

    let expected = "agent_org_task_mutation_after_completion_certificate";
    let patch_error = AgentOrgTaskStore::patch_pending_with_transactional_effects(
        graph_actor(),
        RUN_ID,
        "certified",
        PendingTaskGraphPatch {
            subject: Some("must not change".to_string()),
            ..Default::default()
        },
        |_tx, _outcome, _tasks| Ok(()),
    )
    .unwrap_err();
    assert_eq!(patch_error, expected);

    let create_error = AgentOrgTaskStore::create_pending_with_transactional_effects(
        graph_actor(),
        pending("late-task", Some(MEMBER_A), vec![]),
        TaskCreateSchedulingPolicy {
            allow_parallel_with_unlisted_open_tasks: true,
        },
        |_tx, _task, _tasks| Ok(()),
    )
    .unwrap_err();
    assert_eq!(create_error, expected);

    let lifecycle_error = AgentOrgTaskStore::cancel_with_transactional_effects(
        graph_actor(),
        RUN_ID,
        "certified",
        TaskTerminalReason {
            code: "scope.changed".to_string(),
            message: "must not cancel after certification".to_string(),
            source_event_id: None,
        },
        |_tx, _outcome, _tasks| Ok(()),
    )
    .unwrap_err();
    assert_eq!(lifecycle_error, expected);

    let annotation_error = AgentOrgTaskStore::append_audit_annotation(
        graph_actor(),
        RUN_ID,
        "certified-terminal",
        "must not revise certified evidence".to_string(),
    )
    .unwrap_err();
    assert_eq!(annotation_error, expected);

    assert_eq!(
        AgentOrgTaskStore::delete(RUN_ID, "certified").unwrap_err(),
        expected
    );
    assert_eq!(
        AgentOrgTaskStore::get(RUN_ID, "certified")
            .unwrap()
            .unwrap()
            .subject,
        "Task certified"
    );
    assert!(AgentOrgTaskStore::get(RUN_ID, "late-task")
        .unwrap()
        .is_none());
}

fn recovery_attempts(task_id: &str) -> i64 {
    get_connection()
        .unwrap()
        .query_row(
            "SELECT attempts FROM agent_org_runtime_recovery_attempts
             WHERE org_run_id=?1 AND action_kind='task_failure_recovery'
               AND target_key=?2",
            params![RUN_ID, task_id],
            |row| row.get(0),
        )
        .optional()
        .unwrap()
        .unwrap_or(0)
}

fn recovery_event_count() -> i64 {
    get_connection()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM agent_org_runtime_recovery_attempts
             WHERE org_run_id=?1 AND action_kind='task_failure_recovery_event'",
            [RUN_ID],
            |row| row.get(0),
        )
        .unwrap()
}

fn fail_turn(session_id: &str, turn_id: &str) -> Vec<Task> {
    AgentOrgTaskStore::recover_task_execution_failure(session_id, turn_id)
        .expect("recover exact failed TaskExecution")
}

fn bind_and_start(
    conn: &rusqlite::Connection,
    member_id: &str,
    session_id: &str,
    task_id: &str,
    turn_id: &str,
    generation: i64,
) {
    insert_owner_context(conn, member_id, session_id, turn_id, task_id, generation);
    start(task_id, session_id, turn_id);
}

fn bind_start_and_fail(
    conn: &rusqlite::Connection,
    member_id: &str,
    session_id: &str,
    task_id: &str,
    turn_id: &str,
    generation: i64,
) -> Vec<Task> {
    bind_and_start(conn, member_id, session_id, task_id, turn_id, generation);
    fail_turn(session_id, turn_id)
}

#[test]
fn canonical_schema_and_five_state_semantics_are_frozen() {
    let _fixture = fixture();
    let conn = get_connection().unwrap();
    let columns = conn
        .prepare("PRAGMA table_info(agent_org_runtime_tasks)")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert!(columns.contains(&"output_json".to_string()));
    assert!(columns.contains(&"failure_reason_json".to_string()));
    assert!(columns.contains(&"cancel_reason_json".to_string()));
    assert!(columns.contains(&"execution_mode".to_string()));
    assert!(!columns.contains(&"blocks_json".to_string()));
    assert!(!columns.contains(&"status_migration".to_string()));
    let migration_table: Option<String> = conn
        .query_row(
            "SELECT name FROM sqlite_master WHERE name='agent_org_runtime_task_schema_migrations'",
            [],
            |row| row.get(0),
        )
        .optional()
        .unwrap();
    assert!(migration_table.is_none());

    assert!(TaskStatus::Pending.is_open());
    assert!(TaskStatus::InProgress.is_open());
    assert!(TaskStatus::Completed.is_terminal());
    assert!(TaskStatus::Failed.is_terminal());
    assert!(TaskStatus::Cancelled.is_terminal());
    assert!(TaskStatus::Completed.satisfies_dependency());
    assert!(!TaskStatus::Failed.satisfies_dependency());
    assert!(!TaskStatus::Cancelled.satisfies_dependency());
}

#[test]
fn graph_create_forces_pending_and_injects_provenance() {
    let _fixture = fixture();
    let task = create(pending("created", Some(MEMBER_A), vec![]));
    assert_eq!(task.status, TaskStatus::Pending);
    assert_eq!(task.created_by_participant_id, "coordinator");
    assert_eq!(task.source_turn_intent_id, COORDINATOR_TURN);
    assert_eq!(
        task.originating_message_id.as_deref(),
        Some("message-created")
    );

    let error = AgentOrgTaskStore::create_pending_with_transactional_effects(
        graph_actor(),
        pending("bad-owner", Some("coordinator"), vec![]),
        TaskCreateSchedulingPolicy {
            allow_parallel_with_unlisted_open_tasks: true,
        },
        |_tx, _task, _tasks| Ok(()),
    )
    .expect_err("Coordinator cannot own formal Task");
    assert!(error.contains("coordinator"), "{error}");
    assert!(AgentOrgTaskStore::get(RUN_ID, "bad-owner")
        .unwrap()
        .is_none());
}

#[test]
fn user_directed_graph_authority_is_denied_for_workers_allowed_for_writer_and_paused_safe() {
    let _fixture = fixture();
    let conn = get_connection().expect("test sqlite connection");
    insert_direct_context(&conn, MEMBER_B, MEMBER_B_SESSION, "direct-worker-denied");
    let denied = AgentOrgTaskStore::create_pending_with_transactional_effects(
        direct_graph_actor(MEMBER_B_SESSION, "direct-worker-denied"),
        pending("direct-worker-task", Some(MEMBER_B), vec![]),
        TaskCreateSchedulingPolicy {
            allow_parallel_with_unlisted_open_tasks: true,
        },
        |_tx, _task, _tasks| Ok(()),
    )
    .expect_err("ordinary Member must fail at the Store actor boundary");
    assert!(denied.contains("task_graph_writer_context_mismatch"));
    assert!(AgentOrgTaskStore::get(RUN_ID, "direct-worker-task")
        .expect("read denied task")
        .is_none());

    grant_additional_writer(&conn, MEMBER_A);
    insert_direct_context(&conn, MEMBER_A, MEMBER_A_SESSION, "direct-writer-allowed");
    let written = AgentOrgTaskStore::create_pending_with_transactional_effects(
        direct_graph_actor(MEMBER_A_SESSION, "direct-writer-allowed"),
        pending("direct-writer-task", Some(MEMBER_A), vec![]),
        TaskCreateSchedulingPolicy {
            allow_parallel_with_unlisted_open_tasks: true,
        },
        |_tx, _task, _tasks| Ok(()),
    )
    .expect("Writer direct Turn may mutate the formal graph")
    .0;
    assert_eq!(written.created_by_participant_id, MEMBER_A);
    assert_eq!(written.source_turn_intent_id, "direct-writer-allowed");

    conn.execute(
        "UPDATE agent_org_runtime_runs SET status='paused' WHERE id=?1",
        [RUN_ID],
    )
    .expect("pause Team");
    insert_direct_context(&conn, MEMBER_A, MEMBER_A_SESSION, "direct-writer-paused");
    let paused = AgentOrgTaskStore::create_pending_with_transactional_effects(
        direct_graph_actor(MEMBER_A_SESSION, "direct-writer-paused"),
        pending("direct-writer-paused-task", Some(MEMBER_A), vec![]),
        TaskCreateSchedulingPolicy {
            allow_parallel_with_unlisted_open_tasks: true,
        },
        |_tx, _task, _tasks| Ok(()),
    )
    .expect_err("Paused Writer must not mutate formal work");
    assert!(paused.contains("team_paused_resume_required"));
    assert!(AgentOrgTaskStore::get(RUN_ID, "direct-writer-paused-task")
        .expect("read paused denied task")
        .is_none());
}

#[test]
fn idle_user_directed_writer_activates_team_and_task_atomically() {
    let _fixture = fixture();
    let conn = get_connection().expect("test sqlite connection");
    grant_additional_writer(&conn, MEMBER_A);
    conn.execute(
        "UPDATE agent_org_runtime_runs SET status='idle' WHERE id=?1",
        [RUN_ID],
    )
    .expect("idle Team");
    insert_direct_context(&conn, MEMBER_A, MEMBER_A_SESSION, "direct-writer-idle");

    AgentOrgTaskStore::create_pending_with_transactional_effects(
        direct_graph_actor(MEMBER_A_SESSION, "direct-writer-idle"),
        pending("direct-idle-activation", Some(MEMBER_A), vec![]),
        TaskCreateSchedulingPolicy {
            allow_parallel_with_unlisted_open_tasks: true,
        },
        |tx, _task, _tasks| {
            crate::coordination::agent_org_runs::AgentOrgRunStore::activate_idle_for_task_graph_in_tx(
                tx,
                RUN_ID,
                MEMBER_A_SESSION,
                "direct-writer-idle",
            )?;
            Ok(())
        },
    )
    .expect("Idle Writer activation");

    let (status, generation, task_count): (String, i64, i64) = conn
        .query_row(
            "SELECT run.status,run.activation_generation,
                    (SELECT COUNT(*) FROM agent_org_runtime_tasks task
                     WHERE task.org_run_id=run.id AND task.id='direct-idle-activation')
             FROM agent_org_runtime_runs run WHERE run.id=?1",
            [RUN_ID],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("read atomic Idle activation");
    assert_eq!(status, "running");
    assert_eq!(generation, 2);
    assert_eq!(task_count, 1);
}

#[test]
fn owner_fsm_stamps_output_and_freezes_terminal_task() {
    let _fixture = fixture();
    create(pending("owned", Some(MEMBER_A), vec![]));
    let conn = get_connection().unwrap();
    insert_owner_context(&conn, MEMBER_A, MEMBER_A_SESSION, "turn-owned", "owned", 1);
    start("owned", MEMBER_A_SESSION, "turn-owned");

    let wrong = TaskOwnerExecution::new(MEMBER_B_SESSION, "turn-wrong").unwrap();
    insert_owner_context(&conn, MEMBER_B, MEMBER_B_SESSION, "turn-wrong", "owned", 1);
    let error = AgentOrgTaskStore::owner_complete_with_transactional_effects(
        wrong,
        RUN_ID,
        "owned",
        TaskOutputInput {
            summary: "forged".to_string(),
            content: None,
            artifact_ids: Vec::new(),
        },
        |_tx, _outcome, _tasks| Ok(()),
    )
    .expect_err("non-Owner output must be rejected");
    assert!(error.contains("owner"), "{error}");

    let completed = AgentOrgTaskStore::owner_complete_with_transactional_effects(
        owner_actor(MEMBER_A_SESSION, "turn-owned"),
        RUN_ID,
        "owned",
        TaskOutputInput {
            summary: "done".to_string(),
            content: Some("full result".to_string()),
            artifact_ids: vec!["artifact-1".to_string()],
        },
        |_tx, _outcome, _tasks| Ok(()),
    )
    .unwrap()
    .0
    .current;
    assert_eq!(completed.status, TaskStatus::Completed);
    let output = completed.output.unwrap();
    assert_eq!(output.produced_by_member_id, MEMBER_A);
    assert!(chrono::DateTime::parse_from_rfc3339(&output.produced_at).is_ok());

    let late_progress = AgentOrgTaskStore::append_owner_annotation(
        owner_actor(MEMBER_A_SESSION, "turn-owned"),
        RUN_ID,
        "owned",
        TaskAnnotationKind::Progress,
        "too late".to_string(),
    )
    .expect_err("Owner progress freezes with the terminal Task");
    assert!(late_progress.contains("in-progress"), "{late_progress}");
    AgentOrgTaskStore::append_audit_annotation(
        graph_actor(),
        RUN_ID,
        "owned",
        "terminal audit remains append-only".to_string(),
    )
    .expect("graph admin may append a terminal audit note");

    let error = AgentOrgTaskStore::cancel_with_transactional_effects(
        graph_actor(),
        RUN_ID,
        "owned",
        TaskTerminalReason {
            code: "scope.changed".to_string(),
            message: "cannot rewrite terminal work".to_string(),
            source_event_id: None,
        },
        |_tx, _outcome, _tasks| Ok(()),
    )
    .expect_err("terminal Task must be frozen");
    assert!(error.contains(TASK_TERMINAL_IMMUTABLE_ERROR), "{error}");
}

#[test]
fn ordinary_owner_completion_cannot_finish_a_planning_task() {
    let _fixture = fixture();
    let mut planning = pending("planning", Some(MEMBER_A), vec![]);
    planning.execution_mode = TaskExecutionMode::Plan;
    create(planning);
    let conn = get_connection().unwrap();
    insert_owner_context(
        &conn,
        MEMBER_A,
        MEMBER_A_SESSION,
        "turn-planning",
        "planning",
        1,
    );
    start("planning", MEMBER_A_SESSION, "turn-planning");

    let error = AgentOrgTaskStore::owner_complete_with_transactional_effects(
        owner_actor(MEMBER_A_SESSION, "turn-planning"),
        RUN_ID,
        "planning",
        TaskOutputInput {
            summary: "fake plan completion".to_string(),
            content: None,
            artifact_ids: Vec::new(),
        },
        |_tx, _outcome, _tasks| Ok(()),
    )
    .expect_err("planning Task completion must be owned by a formal PlanRevision decision");

    assert!(
        error.contains("plan_task_requires_formal_plan_revision"),
        "{error}"
    );
    let stored = AgentOrgTaskStore::get(RUN_ID, "planning")
        .expect("read planning Task")
        .expect("planning Task exists");
    assert_eq!(stored.status, TaskStatus::InProgress);
    assert!(stored.output.is_none());
}

#[test]
fn only_completed_dependencies_unlock_owner_start() {
    let _fixture = fixture();
    create(pending("failed-blocker", Some(MEMBER_A), vec![]));
    create(pending(
        "blocked-on-failure",
        Some(MEMBER_B),
        vec!["failed-blocker"],
    ));
    let conn = get_connection().unwrap();
    insert_owner_context(
        &conn,
        MEMBER_A,
        MEMBER_A_SESSION,
        "turn-failed-blocker",
        "failed-blocker",
        1,
    );
    insert_owner_context(
        &conn,
        MEMBER_B,
        MEMBER_B_SESSION,
        "turn-blocked",
        "blocked-on-failure",
        1,
    );
    start("failed-blocker", MEMBER_A_SESSION, "turn-failed-blocker");
    AgentOrgTaskStore::owner_fail_with_transactional_effects(
        owner_actor(MEMBER_A_SESSION, "turn-failed-blocker"),
        RUN_ID,
        "failed-blocker",
        TaskTerminalReason {
            code: "execution.failed".to_string(),
            message: "failed normally".to_string(),
            source_event_id: None,
        },
        |_tx, _outcome, _tasks| Ok(()),
    )
    .unwrap();
    let error = AgentOrgTaskStore::owner_start_with_transactional_effects(
        owner_actor(MEMBER_B_SESSION, "turn-blocked"),
        RUN_ID,
        "blocked-on-failure",
        |_tx, _outcome, _tasks| Ok(()),
    )
    .expect_err("failed dependency cannot unlock downstream");
    assert_eq!(error, "task_dependencies_not_completed");
}

#[test]
fn repeated_owner_start_acknowledges_the_running_task_without_a_second_event() {
    let _fixture = fixture();
    create(pending("idempotent-start", Some(MEMBER_A), vec![]));
    let conn = get_connection().unwrap();
    insert_owner_context(
        &conn,
        MEMBER_A,
        MEMBER_A_SESSION,
        "turn-idempotent-start",
        "idempotent-start",
        1,
    );
    let first = start(
        "idempotent-start",
        MEMBER_A_SESSION,
        "turn-idempotent-start",
    );
    assert!(first.status_changed);
    let event_count_before: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM agent_org_runtime_task_events
             WHERE org_run_id=?1 AND task_id=?2",
            rusqlite::params![RUN_ID, "idempotent-start"],
            |row| row.get(0),
        )
        .unwrap();
    let work_revision_before: i64 = conn
        .query_row(
            "SELECT work_revision FROM agent_org_runtime_run_progress
             WHERE org_run_id=?1",
            [RUN_ID],
            |row| row.get(0),
        )
        .unwrap();

    let acknowledged = start(
        "idempotent-start",
        MEMBER_A_SESSION,
        "turn-idempotent-start",
    );
    assert!(!acknowledged.status_changed);
    assert_eq!(acknowledged.current.status, TaskStatus::InProgress);
    let event_count_after: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM agent_org_runtime_task_events
             WHERE org_run_id=?1 AND task_id=?2",
            rusqlite::params![RUN_ID, "idempotent-start"],
            |row| row.get(0),
        )
        .unwrap();
    let work_revision_after: i64 = conn
        .query_row(
            "SELECT work_revision FROM agent_org_runtime_run_progress
             WHERE org_run_id=?1",
            [RUN_ID],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(event_count_after, event_count_before);
    assert_eq!(work_revision_after, work_revision_before);
}

#[tokio::test(flavor = "current_thread")]
async fn cancel_and_replace_is_atomic_and_rejects_late_owner_callback() {
    let _fixture = fixture();
    create(pending("old", Some(MEMBER_A), vec![]));
    let conn = get_connection().unwrap();
    insert_owner_context(&conn, MEMBER_A, MEMBER_A_SESSION, "turn-old", "old", 1);
    start("old", MEMBER_A_SESSION, "turn-old");
    let reason = TaskTerminalReason {
        code: "scope.changed".to_string(),
        message: "replace the goal".to_string(),
        source_event_id: None,
    };
    let direct_error = AgentOrgTaskStore::cancel_and_replace_with_transactional_effects(
        graph_actor(),
        RUN_ID,
        "old",
        reason.clone(),
        pending("replacement", Some(MEMBER_B), vec![]),
        |_tx, _outcome, _replacement, _tasks| Ok(()),
    )
    .expect_err("a running Task requires the exclusive handoff fence");
    assert_eq!(direct_error, "task_in_progress_requires_execution_handoff");
    assert_eq!(
        AgentOrgTaskStore::get(RUN_ID, "old")
            .unwrap()
            .unwrap()
            .status,
        TaskStatus::InProgress
    );
    assert!(AgentOrgTaskStore::get(RUN_ID, "replacement")
        .unwrap()
        .is_none());

    let fence =
        crate::coordination::agent_org_task_execution_fence::acquire_handoff(RUN_ID, "old").await;
    let authority = fence.authority();
    let (_outcome, replacement, ()) = database::db::with_sessions_writer(|| {
        let conn = get_connection().map_err(|error| error.to_string())?;
        let tx = database::db::begin_immediate(&conn).map_err(|error| error.to_string())?;
        let result = AgentOrgTaskStore::cancel_and_replace_with_handoff_in_tx(
            &tx,
            graph_actor(),
            RUN_ID,
            "old",
            TaskCancelAndReplaceInput {
                reason,
                replacement: pending("replacement", Some(MEMBER_B), vec![]),
                handoff: Some(&authority),
            },
            |_tx, _outcome, _replacement, _tasks| Ok(()),
        )?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok::<(TaskMutationOutcome, Task, ()), String>(result)
    })
    .unwrap();
    drop(fence);
    assert_eq!(replacement.status, TaskStatus::Pending);
    assert_eq!(replacement.replaces_task_id.as_deref(), Some("old"));
    assert_eq!(
        AgentOrgTaskStore::get(RUN_ID, "old")
            .unwrap()
            .unwrap()
            .status,
        TaskStatus::Cancelled
    );
    let late = AgentOrgTaskStore::owner_complete_with_transactional_effects(
        owner_actor(MEMBER_A_SESSION, "turn-old"),
        RUN_ID,
        "old",
        TaskOutputInput {
            summary: "late".to_string(),
            content: None,
            artifact_ids: Vec::new(),
        },
        |_tx, _outcome, _tasks| Ok(()),
    )
    .expect_err("cancelled Task rejects late callback");
    assert!(late.contains("requires_in_progress"), "{late}");

    create(pending("fault-old", Some(MEMBER_A), vec![]));
    let error = AgentOrgTaskStore::cancel_and_replace_with_transactional_effects(
        graph_actor(),
        RUN_ID,
        "fault-old",
        TaskTerminalReason {
            code: "scope.changed".to_string(),
            message: "fault injection".to_string(),
            source_event_id: None,
        },
        pending("fault-replacement", Some(MEMBER_B), vec![]),
        |_tx, _outcome, _replacement, _tasks| {
            Err::<(), String>("injected outbox failure".to_string())
        },
    )
    .expect_err("fault must roll back both rows");
    assert_eq!(error, "injected outbox failure");
    assert_eq!(
        AgentOrgTaskStore::get(RUN_ID, "fault-old")
            .unwrap()
            .unwrap()
            .status,
        TaskStatus::Pending
    );
    assert!(AgentOrgTaskStore::get(RUN_ID, "fault-replacement")
        .unwrap()
        .is_none());
}

#[tokio::test(flavor = "current_thread")]
async fn unresolved_handoff_blocks_replacement_at_the_task_store() {
    let _fixture = fixture();
    let conn = get_connection().unwrap();
    crate::coordination::agent_org_task_handoffs::create_schema(&conn).expect("handoff schema");
    create(pending("blocked-old", Some(MEMBER_A), vec![]));
    insert_owner_context(
        &conn,
        MEMBER_A,
        MEMBER_A_SESSION,
        "turn-blocked-old",
        "blocked-old",
        1,
    );
    start("blocked-old", MEMBER_A_SESSION, "turn-blocked-old");

    let fence =
        crate::coordination::agent_org_task_execution_fence::acquire_handoff(RUN_ID, "blocked-old")
            .await;
    let authority = fence.authority();
    let (outcome, replacement, ()) = database::db::with_sessions_writer(|| {
        let conn = get_connection().map_err(|error| error.to_string())?;
        let tx = database::db::begin_immediate(&conn).map_err(|error| error.to_string())?;
        let result = AgentOrgTaskStore::cancel_and_replace_with_handoff_in_tx(
            &tx,
            graph_actor(),
            RUN_ID,
            "blocked-old",
            TaskCancelAndReplaceInput {
                reason: TaskTerminalReason {
                    code: "scope.changed".to_string(),
                    message: "replace after exact release".to_string(),
                    source_event_id: None,
                },
                replacement: pending("blocked-replacement", Some(MEMBER_B), vec![]),
                handoff: Some(&authority),
            },
            |_tx, _outcome, _replacement, _tasks| Ok(()),
        )?;
        crate::coordination::agent_org_task_handoffs::create_in_tx(
            &tx,
            crate::coordination::agent_org_task_handoffs::CreateTaskExecutionHandoff {
                request_id: "blocked-request",
                request_digest: &"d".repeat(64),
                old_task: &result.0.previous,
                replacement_task: Some(&result.1),
                runtime_evidence: Some(
                    &crate::coordination::agent_org_task_handoffs::HandoffRuntimeEvidence {
                        old_session_id: MEMBER_A_SESSION.to_string(),
                        old_turn_intent_id: "turn-blocked-old".to_string(),
                        runtime_lease_id: "blocked-lease".to_string(),
                        dialog_turn_generation: "blocked-dialog".to_string(),
                    },
                ),
                external_effect_unknown: false,
            },
        )?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok::<_, String>(result)
    })
    .expect("create blocked replacement and receipt atomically");
    drop(fence);
    assert_eq!(outcome.current.status, TaskStatus::Cancelled);

    insert_owner_context(
        &conn,
        MEMBER_B,
        MEMBER_B_SESSION,
        "turn-blocked-replacement",
        &replacement.id,
        1,
    );
    let error = AgentOrgTaskStore::owner_start_with_transactional_effects(
        owner_actor(MEMBER_B_SESSION, "turn-blocked-replacement"),
        RUN_ID,
        &replacement.id,
        |_tx, _outcome, _tasks| Ok(()),
    )
    .expect_err("an unreleased receipt must block even a directly constructed Owner start");
    assert_eq!(error, "task_execution_handoff_replacement_not_released");
    assert_eq!(
        AgentOrgTaskStore::get(RUN_ID, &replacement.id)
            .unwrap()
            .unwrap()
            .status,
        TaskStatus::Pending
    );
}

#[tokio::test(flavor = "current_thread")]
async fn user_handoff_replacement_uses_stable_user_intent_provenance() {
    let _fixture = fixture();
    create(pending("user-old", Some(MEMBER_A), vec![]));
    let conn = get_connection().unwrap();
    insert_owner_context(
        &conn,
        MEMBER_A,
        MEMBER_A_SESSION,
        "turn-user-old",
        "user-old",
        1,
    );
    start("user-old", MEMBER_A_SESSION, "turn-user-old");

    let fence =
        crate::coordination::agent_org_task_execution_fence::acquire_handoff(RUN_ID, "user-old")
            .await;
    let authority = fence.authority();
    let (_outcome, replacement, ()) = database::db::with_sessions_writer(|| {
        let conn = get_connection().map_err(|error| error.to_string())?;
        let tx = database::db::begin_immediate(&conn).map_err(|error| error.to_string())?;
        let result = AgentOrgTaskStore::cancel_and_replace_with_user_handoff_in_tx(
            &tx,
            UserTaskHandoffAdmin::new(ROOT_SESSION, "ui-request-1")?,
            RUN_ID,
            "user-old",
            TaskCancelAndReplaceInput {
                reason: TaskTerminalReason {
                    code: "user_reassigned".to_string(),
                    message: "User reassigned this Task from the Run View.".to_string(),
                    source_event_id: None,
                },
                replacement: pending("user-replacement", Some(MEMBER_B), vec![]),
                handoff: Some(&authority),
            },
            |_tx, _outcome, _replacement, _tasks| Ok(()),
        )?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok::<(TaskMutationOutcome, Task, ()), String>(result)
    })
    .expect("trusted user handoff creates the replacement atomically");
    drop(fence);

    assert_eq!(replacement.status, TaskStatus::Pending);
    assert_eq!(replacement.replaces_task_id.as_deref(), Some("user-old"));
    assert_eq!(
        replacement.source_turn_intent_id,
        "user_task_handoff:ui-request-1"
    );
}

#[test]
fn run_view_cancel_records_user_scope_removal_with_exact_request_audit() {
    let _fixture = fixture();
    create(pending("user-cancelled", Some(MEMBER_A), vec![]));

    database::db::with_sessions_writer(|| {
        let conn = get_connection().map_err(|error| error.to_string())?;
        let tx = database::db::begin_immediate(&conn).map_err(|error| error.to_string())?;
        AgentOrgTaskStore::cancel_with_user_handoff_in_tx(
            &tx,
            UserTaskHandoffAdmin::new(ROOT_SESSION, "ui-cancel-request-1")?,
            RUN_ID,
            "user-cancelled",
            TaskTerminalReason {
                code: "user_scope_removed".to_string(),
                message: "User cancelled this Task from Run View".to_string(),
                source_event_id: Some("ui-cancel-request-1".to_string()),
            },
            None,
            |_tx, _outcome, _tasks| Ok(()),
        )?;
        tx.commit().map_err(|error| error.to_string())
    })
    .expect("Run View cancel commits with its exact user request identity");

    let cancelled = AgentOrgTaskStore::get(RUN_ID, "user-cancelled")
        .unwrap()
        .unwrap();
    assert_eq!(cancelled.status, TaskStatus::Cancelled);
    assert_eq!(
        cancelled
            .cancel_reason
            .as_ref()
            .map(|reason| (reason.code.as_str(), reason.source_event_id.as_deref())),
        Some(("user_scope_removed", Some("ui-cancel-request-1")))
    );
    let conn = get_connection().unwrap();
    let audit_exists: bool = conn
        .query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM agent_org_runtime_task_events
                 WHERE org_run_id=?1 AND task_id='user-cancelled'
                   AND next_status='cancelled' AND actor_kind='system'
                   AND actor_member_id='user:task_handoff:ui-cancel-request-1'
                   AND source_turn_intent_id='user_task_handoff:ui-cancel-request-1'
             )",
            [RUN_ID],
            |row| row.get(0),
        )
        .unwrap();
    assert!(audit_exists);
}

#[test]
fn external_effect_marker_is_exact_and_unknown_is_sticky_across_later_success() {
    let _fixture = fixture();
    create(pending("external-effect", Some(MEMBER_A), vec![]));
    let conn = get_connection().unwrap();
    insert_owner_context(
        &conn,
        MEMBER_A,
        MEMBER_A_SESSION,
        "turn-external-effect",
        "external-effect",
        1,
    );
    start("external-effect", MEMBER_A_SESSION, "turn-external-effect");
    let identity =
        crate::coordination::agent_org_task_execution_fence::TaskExecutionEffectIdentity {
            org_run_id: RUN_ID.to_string(),
            task_id: "external-effect".to_string(),
            session_id: MEMBER_A_SESSION.to_string(),
            turn_intent_id: "turn-external-effect".to_string(),
            owner_member_id: MEMBER_A.to_string(),
            activation_generation: 1,
        };

    let previous =
        crate::coordination::agent_org_task_execution_fence::begin_external_effect(&identity)
            .unwrap();
    assert!(!previous);
    assert!(
        crate::coordination::agent_org_task_execution_fence::external_effect_unknown_with_connection(
            &get_connection().unwrap(),
            RUN_ID,
            "external-effect",
        )
        .unwrap()
    );
    crate::coordination::agent_org_task_execution_fence::restore_external_effect_after_success(
        &identity, previous,
    )
    .unwrap();
    assert!(
        !crate::coordination::agent_org_task_execution_fence::external_effect_unknown_with_connection(
            &get_connection().unwrap(),
            RUN_ID,
            "external-effect",
        )
        .unwrap()
    );

    // Simulate a transport error by beginning an effect and intentionally not
    // restoring it. A later successful call observes the prior sticky state
    // and must restore `true`, not erase the earlier unknown outcome.
    assert!(
        !crate::coordination::agent_org_task_execution_fence::begin_external_effect(&identity)
            .unwrap()
    );
    let prior_unknown =
        crate::coordination::agent_org_task_execution_fence::begin_external_effect(&identity)
            .unwrap();
    assert!(prior_unknown);
    crate::coordination::agent_org_task_execution_fence::restore_external_effect_after_success(
        &identity,
        prior_unknown,
    )
    .unwrap();
    assert!(
        crate::coordination::agent_org_task_execution_fence::external_effect_unknown_with_connection(
            &get_connection().unwrap(),
            RUN_ID,
            "external-effect",
        )
        .unwrap()
    );

    let mut stale = identity;
    stale.turn_intent_id = "different-turn".to_string();
    assert_eq!(
        crate::coordination::agent_org_task_execution_fence::begin_external_effect(&stale)
            .unwrap_err(),
        "task_execution_external_effect_authority_stale"
    );
}

#[test]
fn stale_generation_and_wrong_turn_binding_fail_without_partial_write() {
    let _fixture = fixture();
    create(pending("generation", Some(MEMBER_A), vec![]));
    let conn = get_connection().unwrap();
    insert_owner_context(
        &conn,
        MEMBER_A,
        MEMBER_A_SESSION,
        "turn-generation",
        "generation",
        1,
    );
    conn.execute(
        "UPDATE agent_org_runtime_runs SET activation_generation=2 WHERE id=?1",
        [RUN_ID],
    )
    .unwrap();
    let error = AgentOrgTaskStore::owner_start_with_transactional_effects(
        owner_actor(MEMBER_A_SESSION, "turn-generation"),
        RUN_ID,
        "generation",
        |_tx, _outcome, _tasks| Ok(()),
    )
    .expect_err("old generation must be rejected");
    assert_eq!(error, "task_actor_generation_mismatch");
    assert_eq!(
        AgentOrgTaskStore::get(RUN_ID, "generation")
            .unwrap()
            .unwrap()
            .status,
        TaskStatus::Pending
    );
}

#[test]
fn current_history_detail_and_annotations_are_demand_driven() {
    let _fixture = fixture();
    create(pending("current", Some(MEMBER_B), vec![]));
    create(pending("history", Some(MEMBER_A), vec![]));
    let conn = get_connection().unwrap();
    insert_owner_context(
        &conn,
        MEMBER_A,
        MEMBER_A_SESSION,
        "turn-history",
        "history",
        1,
    );
    start("history", MEMBER_A_SESSION, "turn-history");
    AgentOrgTaskStore::append_owner_annotation(
        owner_actor(MEMBER_A_SESSION, "turn-history"),
        RUN_ID,
        "history",
        TaskAnnotationKind::Progress,
        "halfway".to_string(),
    )
    .unwrap();
    for index in 0..24 {
        AgentOrgTaskStore::append_owner_annotation(
            owner_actor(MEMBER_A_SESSION, "turn-history"),
            RUN_ID,
            "history",
            TaskAnnotationKind::Evidence,
            format!("evidence-{index:02}-{}", "测".repeat(7_900)),
        )
        .unwrap();
    }
    AgentOrgTaskStore::owner_complete_with_transactional_effects(
        owner_actor(MEMBER_A_SESSION, "turn-history"),
        RUN_ID,
        "history",
        TaskOutputInput {
            summary: "summary".to_string(),
            content: Some("large detail remains on demand".to_string()),
            artifact_ids: Vec::new(),
        },
        |_tx, _outcome, _tasks| Ok(()),
    )
    .unwrap();
    create(pending("downstream", Some(MEMBER_B), vec!["history"]));

    let current = AgentOrgTaskStore::list_task_page(
        RUN_ID,
        TaskPageBucket::Current,
        None,
        None,
        TaskPageDirection::Forward,
        50,
    )
    .unwrap();
    assert_eq!(current.tasks.len(), 2);
    assert!(current.tasks.iter().all(|task| task.output.is_none()));
    assert!(
        current
            .tasks
            .iter()
            .find(|task| task.id == "downstream")
            .is_some_and(|task| task.dependencies_satisfied),
        "a completed dependency outside the Current page must still make the task ready"
    );

    let history = AgentOrgTaskStore::list_task_page(
        RUN_ID,
        TaskPageBucket::History,
        Some(TaskStatus::Completed),
        None,
        TaskPageDirection::Forward,
        50,
    )
    .unwrap();
    assert_eq!(history.tasks.len(), 1);
    assert_eq!(history.tasks[0].output.as_ref().unwrap().summary, "summary");
    assert!(history.tasks[0].output.as_ref().unwrap().has_content);
    let detail = AgentOrgTaskStore::get(RUN_ID, "history").unwrap().unwrap();
    assert_eq!(detail.blocks, vec!["downstream"]);
    assert_eq!(
        detail.output.unwrap().content.as_deref(),
        Some("large detail remains on demand")
    );
    let annotations = AgentOrgTaskStore::list_annotation_page(RUN_ID, "history", None, 50).unwrap();
    assert!(annotations.has_more);
    assert_eq!(annotations.annotations[0].body, "halfway");
    assert!(
        serde_json::to_vec(&annotations.annotations).unwrap().len()
            <= crate::coordination::agent_org_payload_limits::TASK_ANNOTATION_PAGE_MAX_BYTES
    );
    let next = AgentOrgTaskStore::list_annotation_page(
        RUN_ID,
        "history",
        annotations.next_cursor.as_deref(),
        50,
    )
    .unwrap();
    assert!(!next.annotations.is_empty());
    assert_ne!(next.annotations[0].id, annotations.annotations[0].id);
}

#[test]
fn task_pages_keep_current_graph_order_and_show_recent_history_first() {
    let _fixture = fixture();
    let conn = get_connection().unwrap();
    let output = serde_json::json!({
        "summary": "done",
        "content": "detail",
        "artifactIds": [],
        "producedByMemberId": MEMBER_A,
        "producedAt": "2026-08-30T00:00:00Z",
    })
    .to_string();
    let insert =
        |id: &str, status: &str, created_at: &str, updated_at: &str, output_json: Option<&str>| {
            conn.execute(
                "INSERT INTO agent_org_runtime_tasks(
                id,org_run_id,activation_generation,subject,description,owner,status,execution_mode,
                blocked_by_json,metadata_json,output_json,
                created_by_participant_id,source_turn_intent_id,created_at,updated_at
             ) VALUES (?1,?2,1,?1,'detail',?3,?4,'build','[]','{}',?5,
                       'coordinator',?6,?7,?8)",
                params![
                    id,
                    RUN_ID,
                    MEMBER_A,
                    status,
                    output_json,
                    COORDINATOR_TURN,
                    created_at,
                    updated_at
                ],
            )
            .unwrap();
        };

    insert(
        "current-old",
        "pending",
        "2026-08-30T01:00:00Z",
        "2026-08-30T04:00:00Z",
        None,
    );
    insert(
        "current-new",
        "pending",
        "2026-08-30T02:00:00Z",
        "2026-08-30T03:00:00Z",
        None,
    );
    insert(
        "history-created-late",
        "completed",
        "2026-08-30T06:00:00Z",
        "2026-08-30T07:00:00Z",
        Some(&output),
    );
    insert(
        "history-updated-late",
        "completed",
        "2026-08-30T05:00:00Z",
        "2026-08-30T09:00:00Z",
        Some(&output),
    );
    insert(
        "history-updated-middle",
        "completed",
        "2026-08-30T08:00:00Z",
        "2026-08-30T08:00:00Z",
        Some(&output),
    );

    let current = AgentOrgTaskStore::list_task_page(
        RUN_ID,
        TaskPageBucket::Current,
        None,
        None,
        TaskPageDirection::Forward,
        10,
    )
    .unwrap();
    assert_eq!(
        current
            .tasks
            .iter()
            .map(|task| task.id.as_str())
            .collect::<Vec<_>>(),
        vec!["current-old", "current-new"]
    );

    let first = AgentOrgTaskStore::list_task_page(
        RUN_ID,
        TaskPageBucket::History,
        Some(TaskStatus::Completed),
        None,
        TaskPageDirection::Forward,
        2,
    )
    .unwrap();
    assert_eq!(
        first
            .tasks
            .iter()
            .map(|task| task.id.as_str())
            .collect::<Vec<_>>(),
        vec!["history-updated-late", "history-updated-middle"]
    );
    let second = AgentOrgTaskStore::list_task_page(
        RUN_ID,
        TaskPageBucket::History,
        Some(TaskStatus::Completed),
        first.next_cursor.as_deref(),
        TaskPageDirection::Forward,
        2,
    )
    .unwrap();
    assert_eq!(second.tasks[0].id, "history-created-late");
    let back = AgentOrgTaskStore::list_task_page(
        RUN_ID,
        TaskPageBucket::History,
        Some(TaskStatus::Completed),
        second.previous_cursor.as_deref(),
        TaskPageDirection::Backward,
        2,
    )
    .unwrap();
    assert_eq!(
        back.tasks
            .iter()
            .map(|task| task.id.as_str())
            .collect::<Vec<_>>(),
        vec!["history-updated-late", "history-updated-middle"]
    );
}

#[test]
fn ten_thousand_task_history_uses_bounded_keyset_pages() {
    let _fixture = fixture();
    let mut conn = get_connection().unwrap();
    let tx = conn.transaction().unwrap();
    {
        let mut insert = tx
            .prepare(
                "INSERT INTO agent_org_runtime_tasks(
                    id,org_run_id,activation_generation,subject,description,owner,status,execution_mode,
                    blocked_by_json,metadata_json,output_json,
                    created_by_participant_id,source_turn_intent_id,created_at,updated_at
                 ) VALUES (?1,?2,1,?3,'history detail',?4,'completed','build',
                           '[]','{}',?5,'coordinator',?6,?7,?7)",
            )
            .unwrap();
        for index in 0..10_000 {
            let id = format!("history-{index:05}");
            let created_at = format!(
                "2026-01-01T00:{:02}:{:02}.{:03}Z",
                (index / 60) % 60,
                index % 60,
                index % 1_000
            );
            let output = serde_json::json!({
                "summary": format!("result {index}"),
                "content": "detail remains behind task_detail",
                "artifactIds": [],
                "producedByMemberId": MEMBER_A,
                "producedAt": "2026-01-01T00:00:00Z",
            })
            .to_string();
            insert
                .execute(params![
                    id,
                    RUN_ID,
                    format!("History {index}"),
                    MEMBER_A,
                    output,
                    COORDINATOR_TURN,
                    created_at,
                ])
                .unwrap();
        }
    }
    tx.commit().unwrap();

    let first = AgentOrgTaskStore::list_task_page(
        RUN_ID,
        TaskPageBucket::History,
        Some(TaskStatus::Completed),
        None,
        TaskPageDirection::Forward,
        50,
    )
    .unwrap();
    assert_eq!(first.tasks.len(), 50);
    assert!(first.has_more);
    assert!(first.tasks.iter().all(|task| {
        task.output
            .as_ref()
            .is_some_and(|output| output.has_content)
            && task.blocks.is_empty()
            && task.blocks_truncated
    }));
    assert!(
        serde_json::to_vec(&first.tasks).unwrap().len()
            <= crate::coordination::agent_org_payload_limits::TASK_SUMMARY_PAGE_MAX_BYTES
    );

    let second = AgentOrgTaskStore::list_task_page(
        RUN_ID,
        TaskPageBucket::History,
        Some(TaskStatus::Completed),
        first.next_cursor.as_deref(),
        TaskPageDirection::Forward,
        50,
    )
    .unwrap();
    assert_eq!(second.tasks.len(), 50);
    assert_ne!(first.tasks[0].id, second.tasks[0].id);
    let back = AgentOrgTaskStore::list_task_page(
        RUN_ID,
        TaskPageBucket::History,
        Some(TaskStatus::Completed),
        second.previous_cursor.as_deref(),
        TaskPageDirection::Backward,
        50,
    )
    .unwrap();
    assert_eq!(
        back.tasks.iter().map(|task| &task.id).collect::<Vec<_>>(),
        first.tasks.iter().map(|task| &task.id).collect::<Vec<_>>()
    );
    let mismatch = AgentOrgTaskStore::list_task_page(
        RUN_ID,
        TaskPageBucket::History,
        Some(TaskStatus::Failed),
        first.next_cursor.as_deref(),
        TaskPageDirection::Forward,
        50,
    )
    .expect_err("a cursor cannot be reused with another status filter");
    assert_eq!(mismatch, "task_page_cursor_filter_mismatch");

    let artifact_ids = (0..16)
        .map(|index| format!("artifact-{index:02}-{}", "x".repeat(980)))
        .collect::<Vec<_>>();
    for index in 0..100 {
        let output = serde_json::json!({
            "summary": format!("large result {index}"),
            "content": "detail remains behind task_detail",
            "artifactIds": artifact_ids,
            "producedByMemberId": MEMBER_A,
            "producedAt": "2026-01-01T00:00:00Z",
        })
        .to_string();
        conn.execute(
            "UPDATE agent_org_runtime_tasks
             SET output_json=?1, updated_at=?2
             WHERE org_run_id=?3 AND id=?4",
            params![
                output,
                format!("2030-01-01T00:00:{:02}.{:03}Z", index / 1_000, index),
                RUN_ID,
                format!("history-{index:05}")
            ],
        )
        .unwrap();
    }
    let byte_bounded = AgentOrgTaskStore::list_task_page(
        RUN_ID,
        TaskPageBucket::History,
        Some(TaskStatus::Completed),
        None,
        TaskPageDirection::Forward,
        200,
    )
    .unwrap();
    assert!(byte_bounded.tasks.len() < 200);
    assert!(byte_bounded.has_more);
    assert!(
        serde_json::to_vec(&byte_bounded.tasks).unwrap().len()
            <= crate::coordination::agent_org_payload_limits::TASK_SUMMARY_PAGE_MAX_BYTES
    );

    let plan = conn
        .prepare(
            "EXPLAIN QUERY PLAN
             SELECT id FROM agent_org_runtime_tasks
             WHERE org_run_id=?1 AND status='completed'
               AND (updated_at<?2 OR (updated_at=?2 AND id<?3))
             ORDER BY updated_at DESC,id DESC LIMIT 51",
        )
        .unwrap()
        .query_map(params![RUN_ID, "9999", "~"], |row| row.get::<_, String>(3))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
        .join("\n");
    assert!(
        plan.contains("idx_agent_org_runtime_tasks_history_page"),
        "query plan must use the keyset page index:\n{plan}"
    );
    assert!(!plan.contains("SCAN agent_org_runtime_tasks"), "{plan}");

    let after_history = create(pending("after-long-history", Some(MEMBER_B), vec![]));
    assert_eq!(after_history.status, TaskStatus::Pending);
    let operational = AgentOrgTaskStore::list_operational(RUN_ID).unwrap();
    assert_eq!(
        operational
            .iter()
            .map(|task| task.id.as_str())
            .collect::<Vec<_>>(),
        vec!["after-long-history"],
        "operational polling must not materialize unrelated terminal history"
    );
}

#[test]
fn recovery_budget_is_per_task_and_never_resets_on_owner_generation_or_reopen() {
    let _fixture = fixture();
    let conn = get_connection().unwrap();
    create(pending("task-a", None, vec![]));
    create(pending("task-b", None, vec![]));
    assign_pending("task-a", MEMBER_A);
    assign_pending("task-b", MEMBER_A);

    for (task_id, turn_id) in [("task-a", "turn-a-1"), ("task-b", "turn-b-1")] {
        assert_eq!(
            bind_start_and_fail(&conn, MEMBER_A, MEMBER_A_SESSION, task_id, turn_id, 1)[0].status,
            TaskStatus::Pending
        );
    }
    assert_eq!(recovery_attempts("task-a"), 1);
    assert_eq!(recovery_attempts("task-b"), 1);

    crate::coordination::agent_org_watchdog::init_schema(&conn).unwrap();
    assign_pending("task-a", MEMBER_B);
    bind_start_and_fail(&conn, MEMBER_B, MEMBER_B_SESSION, "task-a", "turn-a-2", 1);
    assert_eq!(recovery_attempts("task-a"), 2);

    assign_pending("task-a", MEMBER_A);
    conn.execute(
        "UPDATE agent_org_runtime_runs SET activation_generation=2 WHERE id=?1",
        [RUN_ID],
    )
    .unwrap();
    let restarted_session = "task-store-contract-member-a-session-gen2";
    insert_member_session(&conn, MEMBER_A, "agent-a", restarted_session, 2);
    bind_start_and_fail(&conn, MEMBER_A, restarted_session, "task-a", "turn-a-3", 2);
    assert_eq!(recovery_attempts("task-a"), 3);
    assert_eq!(recovery_attempts("task-b"), 1);
}

#[test]
fn first_three_runtime_failures_requeue_and_fourth_is_terminal() {
    let _fixture = fixture();
    let conn = get_connection().unwrap();
    create(pending("recover", None, vec![]));

    for attempt in 1..=4 {
        assign_pending("recover", MEMBER_A);
        let turn_id = format!("turn-recover-{attempt}");
        let recovered =
            bind_start_and_fail(&conn, MEMBER_A, MEMBER_A_SESSION, "recover", &turn_id, 1);
        assert_eq!(recovery_attempts("recover"), attempt);
        if attempt <= 3 {
            assert_eq!(recovered[0].status, TaskStatus::Pending);
            assert_eq!(recovered[0].owner, None);
            assert!(eligible_member_ids(&recovered[0]).contains(&MEMBER_A.to_string()));
        } else {
            assert_eq!(recovered[0].status, TaskStatus::Failed);
            assert_eq!(recovered[0].owner.as_deref(), Some(MEMBER_A));
            assert_eq!(
                recovered[0].failure_reason.as_ref().unwrap().code,
                "system.recovery_budget_exhausted"
            );
        }
    }
}

#[tokio::test(flavor = "current_thread")]
async fn replacement_and_explicit_owner_failure_do_not_share_or_consume_budget() {
    let _fixture = fixture();
    let conn = get_connection().unwrap();
    create(pending("original", None, vec![]));
    assign_pending("original", MEMBER_A);
    bind_start_and_fail(
        &conn,
        MEMBER_A,
        MEMBER_A_SESSION,
        "original",
        "turn-original-1",
        1,
    );
    assign_pending("original", MEMBER_A);
    bind_and_start(
        &conn,
        MEMBER_A,
        MEMBER_A_SESSION,
        "original",
        "turn-original-2",
        1,
    );
    let fence =
        crate::coordination::agent_org_task_execution_fence::acquire_handoff(RUN_ID, "original")
            .await;
    let authority = fence.authority();
    database::db::with_sessions_writer(|| {
        let conn = get_connection().map_err(|error| error.to_string())?;
        let tx = database::db::begin_immediate(&conn).map_err(|error| error.to_string())?;
        AgentOrgTaskStore::cancel_and_replace_with_handoff_in_tx(
            &tx,
            graph_actor(),
            RUN_ID,
            "original",
            TaskCancelAndReplaceInput {
                reason: TaskTerminalReason {
                    code: "scope.changed".to_string(),
                    message: "replace failed work".to_string(),
                    source_event_id: None,
                },
                replacement: pending("replacement", Some(MEMBER_B), vec![]),
                handoff: Some(&authority),
            },
            |_tx, _outcome, _replacement, _tasks| Ok(()),
        )?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok::<(), String>(())
    })
    .unwrap();
    drop(fence);
    bind_start_and_fail(
        &conn,
        MEMBER_B,
        MEMBER_B_SESSION,
        "replacement",
        "turn-replacement-1",
        1,
    );
    assert_eq!(recovery_attempts("original"), 1);
    assert_eq!(recovery_attempts("replacement"), 1);

    create(pending("explicit-failure", Some(MEMBER_A), vec![]));
    bind_and_start(
        &conn,
        MEMBER_A,
        MEMBER_A_SESSION,
        "explicit-failure",
        "turn-explicit-failure",
        1,
    );
    AgentOrgTaskStore::owner_fail_with_transactional_effects(
        owner_actor(MEMBER_A_SESSION, "turn-explicit-failure"),
        RUN_ID,
        "explicit-failure",
        TaskTerminalReason {
            code: "execution.failed".to_string(),
            message: "Owner reported a terminal failure".to_string(),
            source_event_id: None,
        },
        |_tx, _outcome, _tasks| Ok(()),
    )
    .unwrap();
    assert_eq!(recovery_attempts("explicit-failure"), 0);
    crate::coordination::agent_org_watchdog::clear_rewake_budget(RUN_ID, MEMBER_A).unwrap();
    assert_eq!(recovery_attempts("original"), 1);
    assert_eq!(recovery_attempts("replacement"), 1);
}

#[test]
fn recovery_replay_is_idempotent_and_only_mutates_the_bound_task() {
    let _fixture = fixture();
    let conn = get_connection().unwrap();
    for (task_id, turn_id) in [("exact", "turn-exact"), ("sibling", "turn-sibling")] {
        create(pending(task_id, Some(MEMBER_A), vec![]));
        bind_and_start(&conn, MEMBER_A, MEMBER_A_SESSION, task_id, turn_id, 1);
    }
    let ambiguous = crate::coordination::agent_org_turn_contexts::unique_running_task_execution_turn_for_recovery(
        &conn,
        RUN_ID,
        MEMBER_A_SESSION,
        MEMBER_A,
    )
    .expect_err("startup must refuse an ambiguous session-level recovery target");
    assert!(
        ambiguous.contains("multiple running TaskExecution"),
        "{ambiguous}"
    );

    assert_eq!(fail_turn(MEMBER_A_SESSION, "turn-exact").len(), 1);
    assert!(fail_turn(MEMBER_A_SESSION, "turn-exact").is_empty());
    assert_eq!(recovery_attempts("exact"), 1);
    assert_eq!(recovery_event_count(), 1);
    assert_eq!(
        AgentOrgTaskStore::get(RUN_ID, "sibling")
            .unwrap()
            .unwrap()
            .status,
        TaskStatus::InProgress
    );

    let missing =
        AgentOrgTaskStore::recover_task_execution_failure(MEMBER_A_SESSION, "missing-turn")
            .expect_err("a session without the exact failed Turn cannot consume budget");
    assert!(missing.contains("missing companion context"), "{missing}");
    assert_eq!(recovery_event_count(), 1);

    conn.execute(
        "UPDATE agent_org_runtime_runs SET activation_generation=2 WHERE id=?1",
        [RUN_ID],
    )
    .unwrap();
    insert_member_session(
        &conn,
        MEMBER_A,
        "agent-a",
        "task-store-contract-member-a-session-gen2",
        2,
    );
    let stale = AgentOrgTaskStore::recover_task_execution_failure(MEMBER_A_SESSION, "turn-sibling")
        .expect_err("an old activation generation must fail closed");
    assert!(stale.contains("generation"), "{stale}");
    assert_eq!(recovery_attempts("sibling"), 0);
    assert_eq!(recovery_event_count(), 1);
}

#[test]
fn an_unprocessed_old_turn_cannot_recover_a_new_execution_of_the_same_task() {
    let _fixture = fixture();
    let conn = get_connection().unwrap();
    create(pending("restarted", Some(MEMBER_A), vec![]));
    bind_and_start(
        &conn,
        MEMBER_A,
        MEMBER_A_SESSION,
        "restarted",
        "turn-restarted-old",
        1,
    );
    AgentOrgTaskStore::dispose_open_tasks_for_shutdown(RUN_ID, MEMBER_A).unwrap();
    assign_pending("restarted", MEMBER_A);
    bind_and_start(
        &conn,
        MEMBER_A,
        MEMBER_A_SESSION,
        "restarted",
        "turn-restarted-new",
        1,
    );

    let stale =
        AgentOrgTaskStore::recover_task_execution_failure(MEMBER_A_SESSION, "turn-restarted-old")
            .expect_err("an old unprocessed Turn cannot recover the current execution");
    assert!(stale.contains("turn_or_target_changed"), "{stale}");
    assert_eq!(recovery_attempts("restarted"), 0);
    assert_eq!(recovery_event_count(), 0);
    assert_eq!(
        fail_turn(MEMBER_A_SESSION, "turn-restarted-new")[0].status,
        TaskStatus::Pending
    );
    assert_eq!(recovery_attempts("restarted"), 1);
}

#[test]
fn recovery_mutation_failure_rolls_back_budget_and_concurrent_replay_counts_once() {
    let _fixture = fixture();
    let conn = get_connection().unwrap();
    create(pending("corrupt", Some(MEMBER_B), vec![]));
    bind_and_start(
        &conn,
        MEMBER_B,
        MEMBER_B_SESSION,
        "corrupt",
        "turn-corrupt",
        1,
    );
    conn.execute(
        "UPDATE agent_org_runtime_tasks
         SET metadata_json='{\"eligible_member_ids\":\"member-b\"}'
         WHERE org_run_id=?1 AND id='corrupt'",
        [RUN_ID],
    )
    .unwrap();
    let error = AgentOrgTaskStore::recover_task_execution_failure(MEMBER_B_SESSION, "turn-corrupt")
        .expect_err("Task mutation failure must roll back receipt and budget");
    assert_eq!(error, "eligible_member_ids must be an array");
    assert_eq!(recovery_attempts("corrupt"), 0);
    assert_eq!(recovery_event_count(), 0);
    assert_eq!(
        AgentOrgTaskStore::get(RUN_ID, "corrupt")
            .unwrap()
            .unwrap()
            .status,
        TaskStatus::InProgress
    );

    create(pending("concurrent", Some(MEMBER_A), vec![]));
    bind_and_start(
        &conn,
        MEMBER_A,
        MEMBER_A_SESSION,
        "concurrent",
        "turn-concurrent",
        1,
    );
    let workers = (0..2)
        .map(|_| {
            std::thread::spawn(|| {
                AgentOrgTaskStore::recover_task_execution_failure(
                    MEMBER_A_SESSION,
                    "turn-concurrent",
                )
                .unwrap()
                .len()
            })
        })
        .collect::<Vec<_>>();
    let mut mutation_counts = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect::<Vec<_>>();
    mutation_counts.sort_unstable();
    assert_eq!(mutation_counts, vec![0, 1]);
    assert_eq!(recovery_attempts("concurrent"), 1);
    assert_eq!(recovery_event_count(), 1);
}

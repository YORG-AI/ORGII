use super::*;
use crate::coordination::agent_inbox::{AgentMessage, MemberIdleReason};
use crate::coordination::agent_org_runs::{
    AgentOrgRunEntryMode, AgentOrgRunStatus, AgentOrgRunStore, CreateAgentOrgRunParams,
};
use crate::coordination::agent_org_tasks::{
    AgentOrgTaskStore, CreateTaskParams, TaskStatus, TASK_METADATA_ELIGIBLE_MEMBER_IDS,
    TASK_METADATA_REQUIRED_ROLE,
};
use crate::definitions::orgs::{FlatOrgMember, OrgDefinition};
use crate::session::persistence::{session_type, UnifiedSessionRecord};
use crate::session::turn::member_idle::{MemberIdleHook, MemberIdleHookGuard};
use std::sync::{Arc, Mutex};

static TEST_SERIAL: Mutex<()> = Mutex::new(());

fn test_serial_guard() -> std::sync::MutexGuard<'static, ()> {
    TEST_SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Debug, Clone)]
struct IdleCall {
    org_run_id: String,
    coordinator_agent_id: String,
    member_id: String,
    member_agent_id: String,
    member_name: String,
    reason: MemberIdleReason,
    current_mode: Option<crate::session::AgentExecMode>,
    failure_reason: Option<String>,
    unfinished_task_ids: Vec<String>,
}

#[derive(Default)]
struct RecordingMemberIdleHook {
    calls: Mutex<Vec<IdleCall>>,
}

impl RecordingMemberIdleHook {
    fn snapshot(&self) -> Vec<IdleCall> {
        self.calls.lock().unwrap().clone()
    }
}

impl MemberIdleHook for RecordingMemberIdleHook {
    #[allow(clippy::too_many_arguments)]
    fn post_member_idle(
        &self,
        org_run_id: &str,
        coordinator_agent_id: &str,
        member_id: &str,
        member_agent_id: &str,
        member_name: &str,
        reason: MemberIdleReason,
        current_mode: Option<crate::session::AgentExecMode>,
        _summary: Option<String>,
        failure_reason: Option<String>,
        unfinished_task_ids: Vec<String>,
    ) {
        self.calls.lock().unwrap().push(IdleCall {
            org_run_id: org_run_id.to_string(),
            coordinator_agent_id: coordinator_agent_id.to_string(),
            member_id: member_id.to_string(),
            member_agent_id: member_agent_id.to_string(),
            member_name: member_name.to_string(),
            reason,
            current_mode,
            failure_reason,
            unfinished_task_ids,
        });
    }
}

fn ensure_runtime_schemas() {
    let conn = database::db::get_connection().expect("test sqlite connection");
    crate::persistence::test_schema::ensure_agent_sessions_schema(&conn);
    crate::coordination::init_agent_org_schemas(&conn).expect("complete Agent Org runtime schema");
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS code_sessions (
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
    .expect("turn lifecycle schemas");
}

#[test]
fn unread_race_guard_defers_during_direct_user_intervention() {
    let _serial = test_serial_guard();
    let _sandbox = test_helpers::test_env::sandbox();
    let run_id = seed_run("builtin:sde");
    let member_id = "member-worker";
    crate::coordination::agent_inbox::AgentInboxStore::insert(
        crate::coordination::agent_inbox::InsertInboxParams {
            recipient_agent_id: "builtin:sde".to_string(),
            recipient_member_id: Some(member_id.to_string()),
            sender_agent_id: crate::coordination::agent_inbox::SYSTEM_SENDER_ID.to_string(),
            sender_member_id: None,
            org_run_id: Some(run_id.clone()),
            message: AgentMessage::Plain {
                summary: "deferred work".to_string(),
                text: "read this after direct user chat".to_string(),
            },
        },
    )
    .expect("insert unread row");
    crate::coordination::agent_member_interventions::AgentMemberInterventionStore::enter(
        crate::coordination::agent_member_interventions::EnterMemberInterventionParams {
            org_run_id: run_id.clone(),
            member_id: member_id.to_string(),
            agent_id: "builtin:sde".to_string(),
            session_id: "member-session".to_string(),
        },
    )
    .expect("enter intervention");

    assert!(!should_rewake_agent_org_member_after_turn(&run_id, member_id).expect("deferred gate"));

    crate::coordination::agent_member_interventions::AgentMemberInterventionStore::clear(
        &run_id, member_id,
    )
    .expect("clear intervention");
    assert!(should_rewake_agent_org_member_after_turn(&run_id, member_id).expect("wakeable gate"));
}

fn org_definition(member_agent_id: &str) -> OrgDefinition {
    OrgDefinition {
        id: "org-lifecycle".to_string(),
        name: "Lifecycle Org".to_string(),
        role: "coordinator".to_string(),
        agent_id: "builtin:coord".to_string(),
        description: None,
        plan_approval_policy: crate::definitions::orgs::PlanApprovalPolicy::Coordinator,
        members: vec![
            FlatOrgMember {
                member_id: "member-worker".to_string(),
                name: "Worker".to_string(),
                role: "builder".to_string(),
                agent_id: member_agent_id.to_string(),
                runtime_config: None,
            },
            FlatOrgMember {
                member_id: "member-peer".to_string(),
                name: "Peer".to_string(),
                role: "builder".to_string(),
                agent_id: "builtin:sde".to_string(),
                runtime_config: None,
            },
        ],
        additional_task_graph_writer_member_ids: Vec::new(),
        member_communication_links: Vec::new(),
    }
}

fn seed_run(member_agent_id: &str) -> String {
    ensure_runtime_schemas();
    let now = chrono::Utc::now().to_rfc3339();
    crate::session::persistence::upsert_session(&UnifiedSessionRecord {
        session_id: "root-session".to_string(),
        name: "root".to_string(),
        status: crate::session::SessionStatus::Running.as_str().to_string(),
        session_type: session_type::GENERIC.to_string(),
        created_at: now.clone(),
        updated_at: now.clone(),
        agent_definition_id: Some("builtin:coord".to_string()),
        ..Default::default()
    })
    .expect("upsert root session");
    crate::session::persistence::upsert_session(&UnifiedSessionRecord {
        session_id: "member-session".to_string(),
        name: "member".to_string(),
        status: crate::session::SessionStatus::Running.as_str().to_string(),
        session_type: session_type::ORG_MEMBER.to_string(),
        created_at: now.clone(),
        updated_at: now.clone(),
        agent_definition_id: Some(member_agent_id.to_string()),
        org_member_id: Some("member-worker".to_string()),
        parent_session_id: Some("root-session".to_string()),
        agent_exec_mode: Some(crate::session::AgentExecMode::Ask.as_str().to_string()),
        ..Default::default()
    })
    .expect("upsert member session");
    let run = AgentOrgRunStore::create(CreateAgentOrgRunParams {
        org_id: "org-lifecycle".to_string(),
        coordinator_agent_id: "builtin:coord".to_string(),
        root_session_id: Some("root-session".to_string()),
        org_snapshot: (&org_definition(member_agent_id)).into(),
        entry_mode: AgentOrgRunEntryMode::StandaloneSession,
        status: AgentOrgRunStatus::Running,
        work_item_id: None,
        project_slug: None,
        routine_fire_id: None,
    })
    .expect("create run");
    let conn = database::db::get_connection().expect("test sqlite connection");
    conn.execute(
        "INSERT INTO agent_org_runtime_member_materializations(
            org_run_id,member_id,agent_id,generation,session_id,
            authority_class,status,created_at,updated_at
         ) VALUES (?1,'member-worker',?2,1,'member-session',
                   'formal','succeeded',?3,?3)
         ON CONFLICT(org_run_id,member_id,generation) DO UPDATE SET
            agent_id=excluded.agent_id,
            session_id=excluded.session_id,
            authority_class=excluded.authority_class,
            status=excluded.status,
            updated_at=excluded.updated_at",
        rusqlite::params![&run.id, member_agent_id, now],
    )
    .expect("seed canonical Member materialization");
    run.id
}

fn seed_in_progress_task(run_id: &str, task_id: &str) {
    seed_in_progress_task_with_metadata(run_id, task_id, None);
}

fn seed_in_progress_task_with_metadata(
    run_id: &str,
    task_id: &str,
    metadata: Option<serde_json::Value>,
) {
    AgentOrgTaskStore::create(CreateTaskParams {
        id: task_id.to_string(),
        org_run_id: run_id.to_string(),
        subject: task_id.to_string(),
        description: String::new(),
        active_form: None,
        owner: Some("member-worker".to_string()),
        status: TaskStatus::InProgress,
        blocks: Vec::new(),
        blocked_by: Vec::new(),
        metadata,
    })
    .expect("create in-progress task");
}

fn seed_task_execution_turn(run_id: &str, task_id: &str, turn_id: &str) {
    let conn = database::db::get_connection().expect("test sqlite connection");
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO session_turn_intents(
            session_id,turn_intent_id,org_run_id,source,status,created_at,updated_at
         ) VALUES ('member-session',?1,?2,'agent_org','running',?3,?3)",
        rusqlite::params![turn_id, run_id, now],
    )
    .expect("seed failed base Turn");
    conn.execute(
        "INSERT INTO agent_org_runtime_turn_contexts(
            session_id,turn_intent_id,org_run_id,participant_id,turn_kind,
            task_id,owner_member_id,dispatch_member_id,member_dispatch_sequence,
            source_kind,source_id,activation_generation,created_at
         ) VALUES ('member-session',?1,?2,'member-worker','task_execution',
                   ?3,'member-worker','member-worker',1,
                   'task',?3,1,?4)",
        rusqlite::params![turn_id, run_id, task_id, now],
    )
    .expect("seed exact TaskExecution context");
    conn.execute(
        "INSERT INTO agent_org_runtime_task_events(
            id,org_run_id,task_id,event_type,previous_owner,next_owner,
            previous_status,next_status,actor_member_id,actor_kind,
            source_turn_intent_id,created_at
         ) SELECT ?1,task.org_run_id,task.id,'updated',task.owner,task.owner,
                  'pending','in_progress','member-worker','owner_execution',?2,task.updated_at
           FROM agent_org_runtime_tasks task
          WHERE task.org_run_id=?3 AND task.id=?4 AND task.status='in_progress'",
        rusqlite::params![uuid::Uuid::new_v4().to_string(), turn_id, run_id, task_id],
    )
    .expect("seed owning Task start event");
}

#[test]
fn successful_empty_coordinator_finalize_does_not_observe_staged_work() {
    let _serial = test_serial_guard();
    let _sandbox = test_helpers::test_env::sandbox();
    let run_id = seed_run("builtin:sde");
    let conn = database::db::get_connection().expect("test sqlite connection");
    conn.execute(
        "UPDATE agent_sessions
             SET org_member_id=?2, agent_exec_mode='ask'
             WHERE session_id=?1",
        rusqlite::params![
            "root-session",
            crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID
        ],
    )
    .expect("mark root as coordinator member session");

    let presented_revision = AgentOrgRunStore::stage_coordinator_work_revision(&run_id)
        .expect("stage coordinator work revision")
        .expect("running run has a work revision");
    assert_eq!(
        AgentOrgRunStore::progress(&run_id)
            .expect("load progress")
            .expect("progress exists")
            .coordinator_observed_work_revision,
        None
    );

    // This is the lifecycle shape of WakeNoop: processing returned Ok,
    // but no provider turn ran. Finalization must not promote a staged
    // revision merely because the outer scheduler call succeeded.
    finalize_agent_org_member_turn(None, "root-session", None, &Ok(String::new()));

    let progress = AgentOrgRunStore::progress(&run_id)
        .expect("load progress after no-op")
        .expect("progress exists after no-op");
    assert_eq!(
        progress.coordinator_presented_work_revision,
        Some(presented_revision)
    );
    assert_eq!(progress.coordinator_observed_work_revision, None);
}

#[test]
fn requeue_member_work_uses_context_agent_reference_without_self_wake() {
    let _serial = test_serial_guard();
    let _sandbox = test_helpers::test_env::sandbox();
    let run_id = seed_run("claude_code");
    seed_in_progress_task(&run_id, "cli-task");
    seed_task_execution_turn(&run_id, "cli-task", "turn-cli-task");

    let snapshot =
        requeue_agent_org_member_in_progress_work("member-session", Some("turn-cli-task"), true)
            .expect("requeue succeeds")
            .expect("member snapshot");

    assert_eq!(snapshot.member_agent_id, "claude_code");
    assert_eq!(snapshot.requeued_tasks.len(), 1);
    let task = AgentOrgTaskStore::get(&run_id, "cli-task")
        .unwrap()
        .expect("task exists");
    assert_eq!(task.status, TaskStatus::Pending);
    assert_eq!(task.owner, None);
    let inbox = crate::coordination::agent_inbox::AgentInboxStore::list_unread_for_member(
        "member-worker",
        &run_id,
    )
    .expect("list member inbox");
    assert!(
        inbox.is_empty(),
        "released work waits for coordinator assignment"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn successful_member_finalize_keeps_in_progress_work_owned() {
    let _serial = test_serial_guard();
    let _sandbox = test_helpers::test_env::sandbox();
    let run_id = seed_run("builtin:sde");
    seed_in_progress_task(&run_id, "active-task");
    let conn = database::db::get_connection().expect("test sqlite connection");
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO agent_org_runtime_recovery_attempts(
            org_run_id,action_kind,target_key,reason_fingerprint,attempts,
            next_allowed_at,updated_at,reservation_token
         ) VALUES (?1,'task_failure_recovery','active-task','historical',2,?2,?2,NULL)",
        rusqlite::params![&run_id, now],
    )
    .expect("seed historical Task recovery budget");

    assert!(
        crate::coordination::agent_org_watchdog::test_only_mark_failed_rewake_attempt(
            &run_id,
            "member-worker"
        )
        .expect("attempt")
    );
    assert!(
        !crate::coordination::agent_org_watchdog::test_only_mark_failed_rewake_attempt(
            &run_id,
            "member-worker"
        )
        .expect("attempt")
    );

    let ok = Ok("done with this turn".to_string());
    finalize_agent_org_member_turn(None, "member-session", None, &ok);
    assert!(
        crate::coordination::agent_org_watchdog::test_only_mark_failed_rewake_attempt(
            &run_id,
            "member-worker"
        )
        .expect("attempt")
    );

    let task = AgentOrgTaskStore::get(&run_id, "active-task")
        .unwrap()
        .expect("task exists");
    assert_eq!(task.status, TaskStatus::InProgress);
    assert_eq!(task.owner.as_deref(), Some("member-worker"));
    let inbox = crate::coordination::agent_inbox::AgentInboxStore::list_unread_for_member(
        "member-worker",
        &run_id,
    )
    .expect("list member inbox");
    assert!(
        inbox.is_empty(),
        "success finalize must not self-assign the same task"
    );
    let release_events = AgentOrgTaskStore::list_history(&run_id)
        .unwrap()
        .into_iter()
        .filter(|event| event.event_type == "released")
        .collect::<Vec<_>>();
    assert!(release_events.is_empty());
    let task_recovery_attempts: i64 = conn
        .query_row(
            "SELECT attempts FROM agent_org_runtime_recovery_attempts
             WHERE org_run_id=?1 AND action_kind='task_failure_recovery'
               AND target_key='active-task'",
            [&run_id],
            |row| row.get(0),
        )
        .expect("Task recovery budget survives a successful Turn");
    assert_eq!(task_recovery_attempts, 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn user_directed_finalize_never_mutates_formal_task_lifecycle() {
    let _serial = test_serial_guard();
    let _sandbox = test_helpers::test_env::sandbox();
    let hook = Arc::new(RecordingMemberIdleHook::default());
    let _guard = MemberIdleHookGuard::install(hook.clone());
    let run_id = seed_run("builtin:sde");
    seed_in_progress_task(&run_id, "formal-task");

    let turn_intent_id = "turn-user-directed-finalizer";
    let conn = database::db::get_connection().expect("test sqlite connection");
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO session_turn_intents(
            session_id,turn_intent_id,client_message_id,org_run_id,source,status,
            created_at,updated_at
         ) VALUES ('member-session',?1,'direct:member-session:test',?2,
                   'agent_org','running',?3,?3)",
        rusqlite::params![turn_intent_id, &run_id, &now],
    )
    .expect("seed admitted direct Turn intent");
    conn.execute(
        "INSERT INTO agent_org_runtime_turn_contexts(
            session_id,turn_intent_id,org_run_id,participant_id,turn_kind,
            dispatch_member_id,member_dispatch_sequence,source_kind,source_id,
            root_authority_turn_id,actor_version,created_at
         ) VALUES ('member-session',?1,?2,'member-worker','user_directed_work',
                   'member-worker',1,'direct_member',?3,?1,1,?4)",
        rusqlite::params![
            turn_intent_id,
            &run_id,
            "event-user-directed-finalizer",
            &now
        ],
    )
    .expect("seed admitted direct Member Turn context");

    let status = tokio::task::block_in_place(|| {
        tokio::runtime::Handle::current().block_on(finalize_session(
            "member-session",
            &Err("provider failed during direct work".to_string()),
            None,
            None,
            false,
            Some(TerminalTurnSignal {
                turn_id: "dialog-user-directed-finalizer".to_string(),
                turn_intent_id: Some(turn_intent_id.to_string()),
                status: TurnTerminalStatus::Failed,
                completed_at: chrono::Utc::now().to_rfc3339(),
            }),
        ))
    });

    assert_eq!(status, AgentSessionStatus::Idle);
    let task = AgentOrgTaskStore::get(&run_id, "formal-task")
        .expect("load formal Task")
        .expect("formal Task exists");
    assert_eq!(task.status, TaskStatus::InProgress);
    assert_eq!(task.owner.as_deref(), Some("member-worker"));
    assert!(
        hook.snapshot().is_empty(),
        "UserDirectedWork must not emit formal MemberIdle lifecycle output"
    );
}

#[test]
fn successful_cancelled_turn_resolves_undrainable_formal_rows_once() {
    let _serial = test_serial_guard();
    let _sandbox = test_helpers::test_env::sandbox();
    let run_id = seed_run("builtin:sde");
    seed_in_progress_task(&run_id, "cancelled-task");
    let conn = database::db::get_connection().expect("test sqlite connection");
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        r#"UPDATE agent_org_runtime_tasks
         SET status='cancelled',
             cancel_reason_json='{"code":"writer_cancelled","message":"replaced"}',
             updated_at=?3
         WHERE org_run_id=?1 AND id=?2"#,
        rusqlite::params![&run_id, "cancelled-task", &now],
    )
    .expect("cancel exact Task while its old Turn winds down");

    let insert = |message| {
        crate::coordination::agent_inbox::AgentInboxStore::insert(
            crate::coordination::agent_inbox::InsertInboxParams {
                recipient_agent_id: "builtin:sde".to_string(),
                recipient_member_id: Some("member-worker".to_string()),
                sender_agent_id: "builtin:coord".to_string(),
                sender_member_id: Some("coordinator".to_string()),
                org_run_id: Some(run_id.clone()),
                message,
            },
        )
        .expect("insert formal row queued behind old Turn");
    };
    insert(AgentMessage::TaskAssigned {
        task_id: "cancelled-task".to_string(),
        subject: "cancelled task".to_string(),
        description: "old assignment".to_string(),
        assigned_by: "Coordinator".to_string(),
        execution_mode: crate::coordination::agent_org_tasks::TaskExecutionMode::Build,
        dependency_outputs: Vec::new(),
    });
    insert(AgentMessage::Plain {
        summary: "stale reminder".to_string(),
        text: "finish the cancelled task".to_string(),
    });
    insert(AgentMessage::ShutdownRequest {
        request_id: crate::coordination::agent_inbox::RequestId::new(),
        reason: Some("no work remains".to_string()),
    });

    let ok = Ok("the old Provider Turn ended naturally".to_string());
    finalize_agent_org_member_turn(None, "member-session", None, &ok);
    finalize_agent_org_member_turn(None, "member-session", None, &ok);

    let (unread_rows, resolutions): (i64, i64) = conn
        .query_row(
            "SELECT
                 (SELECT COUNT(*) FROM agent_org_runtime_inbox
                  WHERE org_run_id=?1 AND recipient_member_id='member-worker'
                    AND read_at IS NULL),
                 (SELECT COUNT(*)
                  FROM agent_org_runtime_inbox_delivery_resolutions
                  WHERE org_run_id=?1
                    AND reason='member_turn_finished_without_owned_formal_work')",
            [&run_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("load preserved audit rows and lifecycle resolutions");
    assert_eq!(
        unread_rows, 3,
        "original Inbox rows remain unread for audit"
    );
    assert_eq!(
        resolutions, 3,
        "repeat finalization must not duplicate resolutions"
    );
    assert!(
        !crate::coordination::agent_inbox::AgentInboxStore::has_unread_for_member(
            "member-worker",
            &run_id,
        )
        .expect("probe unresolved rows"),
        "resolved stale formal input must not trigger an impossible wake"
    );
}

#[test]
fn successful_turn_keeps_formal_rows_pending_when_member_still_owns_work() {
    let _serial = test_serial_guard();
    let _sandbox = test_helpers::test_env::sandbox();
    let run_id = seed_run("builtin:sde");
    seed_in_progress_task(&run_id, "still-open-task");
    crate::coordination::agent_inbox::AgentInboxStore::insert(
        crate::coordination::agent_inbox::InsertInboxParams {
            recipient_agent_id: "builtin:sde".to_string(),
            recipient_member_id: Some("member-worker".to_string()),
            sender_agent_id: "builtin:coord".to_string(),
            sender_member_id: Some("coordinator".to_string()),
            org_run_id: Some(run_id.clone()),
            message: AgentMessage::Plain {
                summary: "continue".to_string(),
                text: "the owned task is still open".to_string(),
            },
        },
    )
    .expect("insert actionable formal row");

    finalize_agent_org_member_turn(
        None,
        "member-session",
        None,
        &Ok("turn boundary".to_string()),
    );

    assert!(
        crate::coordination::agent_inbox::AgentInboxStore::has_unread_for_member(
            "member-worker",
            &run_id,
        )
        .expect("probe actionable row"),
        "lifecycle cleanup must not discard input while owned work remains"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn failed_member_finalize_releases_task_for_coordinator_assignment() {
    let _serial = test_serial_guard();
    let _sandbox = test_helpers::test_env::sandbox();
    let hook = Arc::new(RecordingMemberIdleHook::default());
    let _guard = MemberIdleHookGuard::install(hook.clone());
    let run_id = seed_run("builtin:sde");
    seed_in_progress_task_with_metadata(
        &run_id,
        "failed-task",
        Some(serde_json::json!({
            TASK_METADATA_ELIGIBLE_MEMBER_IDS: ["member-worker", "member-peer"],
            TASK_METADATA_REQUIRED_ROLE: "implement",
        })),
    );
    seed_task_execution_turn(&run_id, "failed-task", "turn-failed-task");

    let error = Err("HTTP 429: rate limit exceeded".to_string());
    finalize_agent_org_member_turn(None, "member-session", Some("turn-failed-task"), &error);

    let task = AgentOrgTaskStore::get(&run_id, "failed-task")
        .unwrap()
        .expect("task exists");
    assert_eq!(task.status, TaskStatus::Pending);
    assert_eq!(
        task.owner, None,
        "failed work becomes ownerless so the coordinator can choose the next owner"
    );
    assert_eq!(
        crate::coordination::agent_org_tasks::eligible_member_ids(&task),
        vec!["member-worker".to_string(), "member-peer".to_string()]
    );
    assert_eq!(
        task.metadata
            .as_ref()
            .and_then(|metadata| metadata.get(TASK_METADATA_REQUIRED_ROLE))
            .and_then(serde_json::Value::as_str),
        Some("implement")
    );

    let calls = hook.snapshot();
    assert_eq!(calls.len(), 1);
    let call = &calls[0];
    assert_eq!(call.org_run_id, run_id);
    assert_eq!(call.coordinator_agent_id, "builtin:coord");
    assert_eq!(call.member_id, "member-worker");
    assert_eq!(call.member_agent_id, "builtin:sde");
    assert_eq!(call.member_name, "Worker");
    assert_eq!(call.reason, MemberIdleReason::Failed);
    assert_eq!(call.current_mode, Some(crate::session::AgentExecMode::Ask));
    let failure_reason = call.failure_reason.as_deref().unwrap_or_default();
    assert!(failure_reason.contains("HTTP 429: rate limit exceeded"));
    assert!(failure_reason.contains("Requeued tasks from the failed member"));
    assert!(failure_reason.contains("failed-task"));
    assert!(failure_reason.contains("awaiting_coordinator_assignment"));
    assert!(failure_reason.contains("eligible_member_ids: [member-worker, member-peer]"));
    assert!(failure_reason.contains("required_role: implement"));
    assert!(failure_reason.contains("task_update operation=patch_pending owner_member_id"));
    assert_eq!(call.unfinished_task_ids, vec!["failed-task"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn failed_member_finalize_releases_even_when_only_failed_member_is_eligible() {
    let _serial = test_serial_guard();
    let _sandbox = test_helpers::test_env::sandbox();
    let hook = Arc::new(RecordingMemberIdleHook::default());
    let _guard = MemberIdleHookGuard::install(hook.clone());
    let run_id = seed_run("builtin:sde");
    seed_in_progress_task_with_metadata(
        &run_id,
        "solo-task",
        Some(serde_json::json!({
            TASK_METADATA_ELIGIBLE_MEMBER_IDS: ["member-worker"],
        })),
    );
    seed_task_execution_turn(&run_id, "solo-task", "turn-solo-task");

    let error = Err("HTTP 500: provider exploded".to_string());
    finalize_agent_org_member_turn(None, "member-session", Some("turn-solo-task"), &error);

    let task = AgentOrgTaskStore::get(&run_id, "solo-task")
        .unwrap()
        .expect("task exists");
    assert_eq!(task.status, TaskStatus::Pending);
    assert_eq!(task.owner, None);

    let calls = hook.snapshot();
    assert_eq!(calls.len(), 1);
    let failure_reason = calls[0].failure_reason.as_deref().unwrap_or_default();
    assert!(failure_reason.contains("awaiting_coordinator_assignment"));
    assert!(failure_reason.contains("eligible_member_ids: [member-worker]"));
}

#[test]
fn startup_recovery_requeues_only_the_uniquely_bound_task_and_is_idempotent() {
    let _serial = test_serial_guard();
    let _sandbox = test_helpers::test_env::sandbox();
    let run_id = seed_run("builtin:sde");
    seed_in_progress_task(&run_id, "crashed-task");
    seed_in_progress_task(&run_id, "unbound-sibling");
    seed_task_execution_turn(&run_id, "crashed-task", "turn-crashed-task");
    crate::session::persistence::update_status(
        "member-session",
        crate::session::SessionStatus::Abandoned,
    )
    .expect("mark stale Member session abandoned");

    assert_eq!(
        AgentOrgRunStore::requeue_abandoned_member_tasks_on_startup()
            .expect("recover exact abandoned TaskExecution"),
        1
    );
    assert_eq!(
        AgentOrgTaskStore::get(&run_id, "crashed-task")
            .unwrap()
            .unwrap()
            .status,
        TaskStatus::Pending
    );
    assert_eq!(
        AgentOrgTaskStore::get(&run_id, "unbound-sibling")
            .unwrap()
            .unwrap()
            .status,
        TaskStatus::InProgress,
        "startup must not batch-recover every Task owned by the Member"
    );
    assert_eq!(
        AgentOrgRunStore::requeue_abandoned_member_tasks_on_startup()
            .expect("startup replay is a no-op"),
        0
    );
}

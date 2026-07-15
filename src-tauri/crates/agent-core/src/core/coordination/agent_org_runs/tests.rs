use super::helpers::load_by_id;
use super::*;
use crate::core::session::persistence::{upsert_session, UnifiedSessionRecord};
use crate::core::session::SessionStatus;
use crate::definitions::orgs::{
    AgentOrgsStore, HierarchyMode, OrgDefinition, OrgMember, PlanApprovalPolicy,
};
use rusqlite::params;

#[test]
fn enum_values_round_trip() {
    assert_eq!(
        AgentOrgRunEntryMode::parse(AgentOrgRunEntryMode::StandaloneSession.as_str()),
        Some(AgentOrgRunEntryMode::StandaloneSession)
    );
    assert_eq!(
        AgentOrgRunStatus::parse(AgentOrgRunStatus::Running.as_str()),
        Some(AgentOrgRunStatus::Running)
    );
    assert_eq!(AgentOrgRunStatus::parse("idle"), None);
}

/// Build an `AgentOrgsStore` pre-loaded with a single org definition.
/// Bypasses the disk loader so tests stay hermetic — the sandbox
/// already isolates `~/.orgii`, but we don't need to touch disk at
/// all to validate the resolver.
fn store_with_org(org: OrgDefinition) -> AgentOrgsStore {
    let store = AgentOrgsStore::default();
    store.orgs.lock().unwrap().push(org);
    store
}

fn sample_org() -> OrgDefinition {
    OrgDefinition {
        id: "org-walk-test".to_string(),
        name: "WalkTest Org".to_string(),
        role: "lead".to_string(),
        agent_id: "agent-coord".to_string(),
        description: None,
        hierarchy_mode: Default::default(),
        plan_approval_policy: PlanApprovalPolicy::Coordinator,
        children: vec![OrgMember {
            id: "member-w1".to_string(),
            name: "Worker One".to_string(),
            role: "ic".to_string(),
            agent_id: "agent-w1".to_string(),
            runtime_config: None,
            children: Vec::new(),
        }],
    }
}

fn ensure_runtime_schemas() {
    let conn = database::db::get_connection().expect("test sqlite connection");
    crate::foundation::persistence::session_snapshots::ensure_tables_with(&conn)
        .expect("agent sessions schema");
    crate::session::persistence::init(&conn).expect("unified session schema");
    init_schema(&conn).expect("agent org runs schema");
    crate::coordination::agent_member_interventions::init_schema(&conn)
        .expect("member intervention schema");
    crate::coordination::agent_inbox::init_schema(&conn).expect("agent inbox schema");
    crate::coordination::agent_org_tasks::init_schema(&conn).expect("agent team tasks schema");
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
            source TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (session_id, turn_intent_id)
        );",
    )
    .expect("cli session schema");
}

fn create_run_for_root(org: &OrgDefinition, root_session_id: &str) -> AgentOrgRunRecord {
    ensure_runtime_schemas();
    AgentOrgRunStore::create(CreateAgentOrgRunParams {
        org_id: org.id.clone(),
        coordinator_agent_id: "agent-coord".to_string(),
        root_session_id: Some(root_session_id.to_string()),
        org_snapshot: org.clone(),
        entry_mode: AgentOrgRunEntryMode::StandaloneSession,
        status: AgentOrgRunStatus::Running,
        work_item_id: None,
        project_slug: None,
        routine_fire_id: None,
    })
    .expect("create run")
}

fn upsert_session_row(session_id: &str, parent_session_id: Option<&str>) {
    upsert_session_row_full(session_id, parent_session_id, None, "running");
}

fn upsert_session_row_full(
    session_id: &str,
    parent_session_id: Option<&str>,
    agent_definition_id: Option<&str>,
    status: &str,
) {
    upsert_session_row_for_member(
        session_id,
        parent_session_id,
        agent_definition_id,
        None,
        status,
    );
}

fn upsert_session_row_for_member(
    session_id: &str,
    parent_session_id: Option<&str>,
    agent_definition_id: Option<&str>,
    org_member_id: Option<&str>,
    status: &str,
) {
    ensure_runtime_schemas();
    let record = UnifiedSessionRecord {
        session_id: session_id.to_string(),
        name: format!("test-{session_id}"),
        status: status.to_string(),
        session_type: if parent_session_id.is_some() {
            crate::core::session::persistence::session_type::ORG_MEMBER.to_string()
        } else {
            "agent".to_string()
        },
        parent_session_id: parent_session_id.map(str::to_string),
        agent_definition_id: agent_definition_id.map(str::to_string),
        org_member_id: org_member_id.map(str::to_string),
        created_at: chrono::Utc::now().to_rfc3339(),
        updated_at: chrono::Utc::now().to_rfc3339(),
        ..Default::default()
    };
    upsert_session(&record).expect("upsert session row");
}

fn stamp_coordinator_terminal_turn(session_id: &str) {
    let conn = database::db::get_connection().expect("test sqlite connection");
    conn.execute(
        "UPDATE agent_sessions
         SET last_terminal_turn_at=?2, last_terminal_turn_status='completed'
         WHERE session_id=?1",
        params![session_id, chrono::Utc::now().to_rfc3339()],
    )
    .expect("stamp coordinator terminal turn");
}

fn upsert_cli_session_row_for_member(
    session_id: &str,
    parent_session_id: &str,
    cli_agent_type: &str,
    org_member_id: &str,
    status: &str,
) {
    ensure_runtime_schemas();
    let now = chrono::Utc::now().to_rfc3339();
    let conn = database::db::get_connection().expect("test sqlite connection");
    conn.execute(
        "INSERT INTO code_sessions (
            session_id,
            cli_agent_type,
            status,
            parent_session_id,
            org_member_id,
            updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(session_id) DO UPDATE SET
            cli_agent_type = excluded.cli_agent_type,
            status = excluded.status,
            parent_session_id = excluded.parent_session_id,
            org_member_id = excluded.org_member_id,
            updated_at = excluded.updated_at",
        params![
            session_id,
            cli_agent_type,
            status,
            parent_session_id,
            org_member_id,
            now
        ],
    )
    .expect("upsert test CLI session");
}

#[test]
fn context_for_session_with_parent_walk_root_session_direct_hit() {
    let _sandbox = test_helpers::test_env::sandbox();
    let org = sample_org();
    let store = store_with_org(org.clone());
    let _run = create_run_for_root(&org, "root-session-1");
    upsert_session_row("root-session-1", None);

    let ctx = AgentOrgRunStore::context_for_session_with_parent_walk("root-session-1", &store)
        .expect("walk ok")
        .expect("context resolved");
    assert_eq!(ctx.coordinator_agent_id, "agent-coord");
    assert_eq!(ctx.members.len(), 1);
    assert_eq!(ctx.members[0].agent_id, "agent-w1");
}

#[test]
fn context_for_run_uses_launch_snapshot_after_live_org_changes() {
    let _sandbox = test_helpers::test_env::sandbox();
    let org = sample_org();
    let store = store_with_org(org.clone());
    let run = create_run_for_root(&org, "root-session-snapshot");
    upsert_session_row("root-session-snapshot", None);

    {
        let mut orgs = store.orgs.lock().expect("org store lock");
        orgs[0].name = "Edited Live Org".to_string();
        orgs[0].role = "edited lead".to_string();
        orgs[0].children[0].id = "member-edited".to_string();
        orgs[0].children[0].agent_id = "agent-edited".to_string();
    }

    let ctx = AgentOrgRunStore::context_for_run(&run.id, &store)
        .expect("context lookup ok")
        .expect("context resolved");
    assert_eq!(ctx.org_name, "WalkTest Org");
    assert_eq!(ctx.coordinator_role, "lead");
    assert_eq!(ctx.members.len(), 1);
    assert_eq!(ctx.members[0].member_id, "member-w1");
    assert_eq!(ctx.members[0].agent_id, "agent-w1");
}

#[test]
fn context_for_session_preserves_org_hierarchy_mode() {
    for hierarchy_mode in [
        HierarchyMode::Flat,
        HierarchyMode::Soft,
        HierarchyMode::Strict,
    ] {
        let _sandbox = test_helpers::test_env::sandbox();
        let mode_label = match hierarchy_mode {
            HierarchyMode::Flat => "flat",
            HierarchyMode::Soft => "soft",
            HierarchyMode::Strict => "strict",
        };
        let mut org = sample_org();
        org.id = format!("org-mode-{mode_label}");
        org.hierarchy_mode = hierarchy_mode;
        let store = store_with_org(org.clone());
        let root_session_id = format!("root-session-{mode_label}");
        let _run = create_run_for_root(&org, &root_session_id);
        upsert_session_row(&root_session_id, None);

        let ctx = AgentOrgRunStore::context_for_session_with_parent_walk(&root_session_id, &store)
            .expect("walk ok")
            .expect("context resolved");
        assert_eq!(ctx.hierarchy_mode, hierarchy_mode);
    }
}

#[test]
fn context_for_session_with_parent_walk_one_hop_subagent() {
    let _sandbox = test_helpers::test_env::sandbox();
    let org = sample_org();
    let store = store_with_org(org.clone());
    let _run = create_run_for_root(&org, "root-session-2");
    upsert_session_row("root-session-2", None);
    upsert_session_row("worker-session-2", Some("root-session-2"));

    let ctx = AgentOrgRunStore::context_for_session_with_parent_walk("worker-session-2", &store)
        .expect("walk ok")
        .expect("context resolved via parent walk");
    assert_eq!(ctx.run_id, _run.id);
    assert_eq!(ctx.coordinator_agent_id, "agent-coord");
}

#[test]
fn context_for_session_with_parent_walk_cli_member_session() {
    let _sandbox = test_helpers::test_env::sandbox();
    let org = sample_org();
    let store = store_with_org(org.clone());
    let _run = create_run_for_root(&org, "root-session-cli-walk");
    upsert_session_row("root-session-cli-walk", None);
    upsert_cli_session_row_for_member(
        "cli-worker-session-walk",
        "root-session-cli-walk",
        "claude_code",
        "member-w1",
        "running",
    );

    let ctx =
        AgentOrgRunStore::context_for_session_with_parent_walk("cli-worker-session-walk", &store)
            .expect("walk ok")
            .expect("context resolved via CLI parent walk");
    assert_eq!(ctx.run_id, _run.id);
    assert_eq!(ctx.coordinator_agent_id, "agent-coord");
}

#[test]
fn context_for_session_with_parent_walk_two_hop_chain() {
    let _sandbox = test_helpers::test_env::sandbox();
    let org = sample_org();
    let store = store_with_org(org.clone());
    let _run = create_run_for_root(&org, "root-session-3");
    upsert_session_row("root-session-3", None);
    upsert_session_row("mid-session-3", Some("root-session-3"));
    upsert_session_row("leaf-session-3", Some("mid-session-3"));

    let ctx = AgentOrgRunStore::context_for_session_with_parent_walk("leaf-session-3", &store)
        .expect("walk ok")
        .expect("context resolved via 2-hop walk");
    assert_eq!(ctx.run_id, _run.id);
}

#[test]
fn context_for_session_with_parent_walk_unrelated_session_returns_none() {
    let _sandbox = test_helpers::test_env::sandbox();
    let org = sample_org();
    let store = store_with_org(org);
    upsert_session_row("orphan-session", None);

    let ctx = AgentOrgRunStore::context_for_session_with_parent_walk("orphan-session", &store)
        .expect("walk ok");
    assert!(
        ctx.is_none(),
        "session with no matching org_run should resolve to None"
    );
}

#[test]
fn context_for_session_with_parent_walk_unknown_session_returns_none() {
    // A `session_id` that doesn't even have a row in `agent_sessions`
    // (e.g. wire from a stale event) should terminate the walk
    // cleanly, not panic and not error.
    let _sandbox = test_helpers::test_env::sandbox();
    let org = sample_org();
    let store = store_with_org(org);
    ensure_runtime_schemas();

    let ctx = AgentOrgRunStore::context_for_session_with_parent_walk("ghost-session", &store)
        .expect("walk ok");
    assert!(ctx.is_none());
}

#[test]
fn context_for_session_with_parent_walk_breaks_on_cycle() {
    // Synthetic cycle: A → B → A. Should bail out cleanly with None
    // (and a warn log; we don't assert on logs here).
    let _sandbox = test_helpers::test_env::sandbox();
    let org = sample_org();
    let store = store_with_org(org);
    upsert_session_row("cycle-a", Some("cycle-b"));
    upsert_session_row("cycle-b", Some("cycle-a"));

    let ctx = AgentOrgRunStore::context_for_session_with_parent_walk("cycle-a", &store)
        .expect("walk ok despite cycle");
    assert!(
        ctx.is_none(),
        "cyclic parent chain must short-circuit instead of looping forever"
    );
}

#[test]
fn find_worker_session_by_member_id_returns_descendant_with_matching_member_id() {
    let _sandbox = test_helpers::test_env::sandbox();
    let org = sample_org();
    let _store = store_with_org(org.clone());
    let run = create_run_for_root(&org, "coord-root-active");
    upsert_session_row_full("coord-root-active", None, Some("agent-coord"), "running");
    upsert_session_row_for_member(
        "coord-w-active",
        Some("coord-root-active"),
        Some("agent-w1"),
        Some("member-w1"),
        "completed",
    );

    let info = AgentOrgRunStore::find_worker_session_by_member_id(&run.id, "member-w1")
        .expect("query ok")
        .expect("worker found");
    assert_eq!(info.session_id, "coord-w-active");
    assert_eq!(info.status, crate::core::session::SessionStatus::Completed);
}

#[test]
fn find_worker_session_by_member_id_returns_cli_member_session() {
    let _sandbox = test_helpers::test_env::sandbox();
    let org = sample_org();
    let _store = store_with_org(org.clone());
    let run = create_run_for_root(&org, "coord-root-cli-active");
    upsert_session_row_full(
        "coord-root-cli-active",
        None,
        Some("agent-coord"),
        "running",
    );
    upsert_cli_session_row_for_member(
        "cli-worker-active",
        "coord-root-cli-active",
        "claude_code",
        "member-w1",
        "running",
    );

    let sessions =
        AgentOrgRunStore::list_worker_sessions_by_member_ids(&run.id, &["member-w1".to_string()])
            .expect("query ok");
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].session_id, "cli-worker-active");
    assert_eq!(sessions[0].agent_definition_id, None);
    assert_eq!(sessions[0].cli_agent_type.as_deref(), Some("claude_code"));

    let info = AgentOrgRunStore::find_worker_session_by_member_id(&run.id, "member-w1")
        .expect("query ok")
        .expect("CLI worker found");
    assert_eq!(info.session_id, "cli-worker-active");
    assert_eq!(info.status, crate::core::session::SessionStatus::Running);
}

#[test]
fn find_worker_session_by_member_id_picks_most_recent_when_multi_instance() {
    let _sandbox = test_helpers::test_env::sandbox();
    let org = sample_org();
    let _store = store_with_org(org.clone());
    let run = create_run_for_root(&org, "coord-root-rotation");
    upsert_session_row_full("coord-root-rotation", None, Some("agent-coord"), "running");
    upsert_session_row_for_member(
        "coord-w-old",
        Some("coord-root-rotation"),
        Some("agent-w1"),
        Some("member-w1"),
        "completed",
    );
    std::thread::sleep(std::time::Duration::from_millis(2));
    upsert_session_row_for_member(
        "coord-w-new",
        Some("coord-root-rotation"),
        Some("agent-w1"),
        Some("member-w1"),
        "completed",
    );
    upsert_session_row_for_member(
        "coord-shared-other-member",
        Some("coord-root-rotation"),
        Some("agent-w1"),
        Some("member-other"),
        "completed",
    );

    let info = AgentOrgRunStore::find_worker_session_by_member_id(&run.id, "member-w1")
        .expect("query ok")
        .expect("worker found");
    assert_eq!(info.session_id, "coord-w-new");
}

#[test]
fn find_worker_session_by_member_id_returns_none_when_materialized_session_missing() {
    let _sandbox = test_helpers::test_env::sandbox();
    let org = sample_org();
    let _store = store_with_org(org.clone());
    let run = create_run_for_root(&org, "coord-root-no-active");
    upsert_session_row_full("coord-root-no-active", None, Some("agent-coord"), "running");
    let info =
        AgentOrgRunStore::find_worker_session_by_member_id(&run.id, "member-w1").expect("query ok");
    assert!(info.is_none());
}

#[test]
fn find_worker_session_by_member_id_returns_none_for_unknown_run() {
    let _sandbox = test_helpers::test_env::sandbox();
    ensure_runtime_schemas();
    let info = AgentOrgRunStore::find_worker_session_by_member_id("nope-run", "member-w1")
        .expect("query ok on unknown run");
    assert!(info.is_none());
}

#[test]
fn reconcile_run_finality_completes_run_when_all_tasks_completed() {
    use crate::coordination::agent_org_tasks::{AgentOrgTaskStore, CreateTaskParams, TaskStatus};

    let _sandbox = test_helpers::test_env::sandbox();
    let org = sample_org();
    let run = create_run_for_root(&org, "coord-root-final-complete");
    upsert_session_row_full(
        "coord-root-final-complete",
        None,
        Some("agent-coord"),
        "completed",
    );
    upsert_session(&UnifiedSessionRecord {
        session_id: "worker-final-complete".to_string(),
        name: "worker final complete".to_string(),
        status: crate::core::session::SessionStatus::Completed
            .as_str()
            .to_string(),
        session_type: crate::core::session::persistence::session_type::ORG_MEMBER.to_string(),
        parent_session_id: Some("coord-root-final-complete".to_string()),
        agent_definition_id: Some("agent-w1".to_string()),
        org_member_id: Some("member-w1".to_string()),
        created_at: chrono::Utc::now().to_rfc3339(),
        updated_at: chrono::Utc::now().to_rfc3339(),
        ..Default::default()
    })
    .expect("upsert completed worker");
    AgentOrgTaskStore::create(CreateTaskParams {
        id: "done-task".to_string(),
        org_run_id: run.id.clone(),
        subject: "done".to_string(),
        description: String::new(),
        active_form: None,
        owner: Some("member-w1".to_string()),
        status: TaskStatus::Completed,
        blocks: Vec::new(),
        blocked_by: Vec::new(),
        metadata: Some(serde_json::json!({
            crate::coordination::agent_org_tasks::TASK_METADATA_ELIGIBLE_MEMBER_IDS:
                ["member-w1"],
        })),
    })
    .expect("create completed task");
    stamp_coordinator_terminal_turn("coord-root-final-complete");

    let conn = database::db::get_connection().expect("test sqlite connection");
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO session_turn_intents (
             session_id, turn_intent_id, source, status, created_at, updated_at
         ) VALUES (?1, 'final-turn', 'agent_org', 'optimistic', ?2, ?2)",
        params!["coord-root-final-complete", &now],
    )
    .expect("seed pending turn intent");
    for pending_status in ["optimistic", "queued", "running"] {
        conn.execute(
            "UPDATE session_turn_intents SET status=?2 WHERE session_id=?1",
            params!["coord-root-final-complete", pending_status],
        )
        .expect("advance pending turn intent");
        assert_eq!(
            AgentOrgRunStore::reconcile_run_finality(&run.id).expect("reconcile pending intent"),
            Some(AgentOrgRunStatus::Running),
            "a {pending_status} turn intent must keep the run open"
        );
    }
    for terminal_status in [
        "completed",
        "failed",
        "cancelled",
        "stale",
        "coalesced",
        "rejected",
    ] {
        conn.execute(
            "UPDATE session_turn_intents SET status=?2 WHERE session_id=?1",
            params!["coord-root-final-complete", terminal_status],
        )
        .expect("set terminal turn intent");
        assert_eq!(
            AgentOrgRunStore::reconcile_run_finality(&run.id).expect("reconcile terminal intent"),
            Some(AgentOrgRunStatus::Completed),
            "a {terminal_status} turn intent must not keep the run open"
        );
        conn.execute(
            "UPDATE agent_org_runs SET status='running', completed_at=NULL WHERE id=?1",
            params![&run.id],
        )
        .expect("reset run for next terminal status");
    }
    let legacy_resume_after = (chrono::Utc::now() + chrono::Duration::minutes(3)).to_rfc3339();
    conn.execute(
        "INSERT INTO agent_member_interventions (
             org_run_id, member_id, agent_id, session_id, status, reason,
             entered_at, last_user_activity_at, resume_after, cleared_at
         ) VALUES (?1, ?2, 'agent-coord', ?3, 'user_intervention',
                   'direct_user_chat', ?4, ?4, ?5, NULL)",
        params![
            &run.id,
            COORDINATOR_MEMBER_ID,
            "coord-root-final-complete",
            &now,
            &legacy_resume_after,
        ],
    )
    .expect("seed legacy coordinator intervention");

    assert_eq!(
        AgentOrgRunStore::reconcile_resolved_running_runs_on_startup()
            .expect("startup reconcile ok"),
        1
    );
    let reloaded = load_by_id(&run.id).expect("load run").expect("run exists");
    assert_eq!(reloaded.status, AgentOrgRunStatus::Completed);
    assert!(reloaded.completed_at.is_some());
    let legacy_cleared_at: Option<String> = conn
        .query_row(
            "SELECT cleared_at FROM agent_member_interventions
             WHERE org_run_id=?1 AND member_id=?2",
            params![&run.id, COORDINATOR_MEMBER_ID],
            |row| row.get(0),
        )
        .expect("read repaired legacy intervention");
    assert!(legacy_cleared_at.is_some());
}

#[test]
fn reconcile_completes_normal_idle_run_only_after_inbox_is_drained() {
    use crate::coordination::agent_inbox::{
        AgentInboxStore, AgentMessage, InsertInboxParams, SYSTEM_SENDER_ID,
    };
    use crate::coordination::agent_org_tasks::{AgentOrgTaskStore, CreateTaskParams, TaskStatus};

    let _sandbox = test_helpers::test_env::sandbox();
    let org = sample_org();
    let run = create_run_for_root(&org, "coord-root-idle-complete");
    upsert_session_row_full(
        "coord-root-idle-complete",
        None,
        Some("agent-coord"),
        "idle",
    );
    upsert_session(&UnifiedSessionRecord {
        session_id: "worker-idle-complete".to_string(),
        name: "worker idle complete".to_string(),
        status: SessionStatus::Idle.as_str().to_string(),
        session_type: crate::core::session::persistence::session_type::ORG_MEMBER.to_string(),
        parent_session_id: Some("coord-root-idle-complete".to_string()),
        agent_definition_id: Some("agent-w1".to_string()),
        org_member_id: Some("member-w1".to_string()),
        created_at: chrono::Utc::now().to_rfc3339(),
        updated_at: chrono::Utc::now().to_rfc3339(),
        ..Default::default()
    })
    .unwrap();
    AgentOrgTaskStore::create(CreateTaskParams {
        id: "idle-done".to_string(),
        org_run_id: run.id.clone(),
        subject: "done".to_string(),
        description: String::new(),
        active_form: None,
        owner: Some("member-w1".to_string()),
        status: TaskStatus::Completed,
        blocks: Vec::new(),
        blocked_by: Vec::new(),
        metadata: None,
    })
    .unwrap();
    let row = AgentInboxStore::insert(InsertInboxParams {
        recipient_agent_id: "agent-coord".to_string(),
        recipient_member_id: Some(COORDINATOR_MEMBER_ID.to_string()),
        sender_agent_id: SYSTEM_SENDER_ID.to_string(),
        sender_member_id: None,
        org_run_id: Some(run.id.clone()),
        message: AgentMessage::Plain {
            summary: "finalize".to_string(),
            text: "Coordinator still needs to deliver the final result".to_string(),
        },
    })
    .unwrap();
    stamp_coordinator_terminal_turn("coord-root-idle-complete");

    assert_eq!(
        AgentOrgRunStore::reconcile_run_finality(&run.id).unwrap(),
        Some(AgentOrgRunStatus::Running),
        "unread completion facts must be delivered before finality"
    );
    AgentInboxStore::mark_many_read(&[row.id]).unwrap();
    assert_eq!(
        AgentOrgRunStore::reconcile_run_finality(&run.id).unwrap(),
        Some(AgentOrgRunStatus::Completed),
        "normal successful members settle to Idle and must still allow run completion"
    );
}

#[test]
fn reconcile_run_finality_abandons_run_with_open_work_after_all_sessions_terminal() {
    use crate::coordination::agent_org_tasks::{AgentOrgTaskStore, CreateTaskParams, TaskStatus};

    let _sandbox = test_helpers::test_env::sandbox();
    let org = sample_org();
    let run = create_run_for_root(&org, "coord-root-final-abandoned");
    upsert_session_row_full(
        "coord-root-final-abandoned",
        None,
        Some("agent-coord"),
        "completed",
    );
    upsert_session(&UnifiedSessionRecord {
        session_id: "worker-final-abandoned".to_string(),
        name: "worker final abandoned".to_string(),
        status: crate::core::session::SessionStatus::Completed
            .as_str()
            .to_string(),
        session_type: crate::core::session::persistence::session_type::ORG_MEMBER.to_string(),
        parent_session_id: Some("coord-root-final-abandoned".to_string()),
        agent_definition_id: Some("agent-w1".to_string()),
        org_member_id: Some("member-w1".to_string()),
        created_at: chrono::Utc::now().to_rfc3339(),
        updated_at: chrono::Utc::now().to_rfc3339(),
        ..Default::default()
    })
    .expect("upsert completed worker");
    for (id, status) in [
        ("done-a", TaskStatus::Completed),
        ("done-b", TaskStatus::Completed),
        ("done-c", TaskStatus::Completed),
        ("done-d", TaskStatus::Completed),
    ] {
        AgentOrgTaskStore::create(CreateTaskParams {
            id: id.to_string(),
            org_run_id: run.id.clone(),
            subject: id.to_string(),
            description: String::new(),
            active_form: None,
            owner: Some("member-w1".to_string()),
            status,
            blocks: Vec::new(),
            blocked_by: Vec::new(),
            metadata: None,
        })
        .expect("create completed task");
    }
    AgentOrgTaskStore::create(CreateTaskParams {
        id: "ownerless-pending".to_string(),
        org_run_id: run.id.clone(),
        subject: "open task".to_string(),
        description: String::new(),
        active_form: None,
        owner: None,
        status: TaskStatus::Pending,
        blocks: Vec::new(),
        blocked_by: Vec::new(),
        metadata: Some(serde_json::json!({
            crate::coordination::agent_org_tasks::TASK_METADATA_ELIGIBLE_MEMBER_IDS:
                ["member-w1"],
        })),
    })
    .expect("create open task");

    let status = AgentOrgRunStore::reconcile_run_finality(&run.id).expect("reconcile ok");
    assert_eq!(status, Some(AgentOrgRunStatus::Abandoned));
    let reloaded = load_by_id(&run.id).expect("load run").expect("run exists");
    assert_eq!(reloaded.status, AgentOrgRunStatus::Abandoned);
    assert!(reloaded.completed_at.is_some());
}

#[test]
fn reconcile_and_task_create_have_one_serializable_outcome() {
    use std::sync::{Arc, Barrier};

    use crate::coordination::agent_org_tasks::{AgentOrgTaskStore, CreateTaskParams, TaskStatus};

    let _sandbox = test_helpers::test_env::sandbox();
    let org = sample_org();
    let run = create_run_for_root(&org, "coord-root-finality-race");
    upsert_session_row_full(
        "coord-root-finality-race",
        None,
        Some("agent-coord"),
        SessionStatus::Completed.as_str(),
    );
    upsert_session(&UnifiedSessionRecord {
        session_id: "worker-finality-race".to_string(),
        name: "worker".to_string(),
        status: SessionStatus::Completed.as_str().to_string(),
        session_type: crate::core::session::persistence::session_type::ORG_MEMBER.to_string(),
        parent_session_id: Some("coord-root-finality-race".to_string()),
        agent_definition_id: Some("agent-w1".to_string()),
        org_member_id: Some("member-w1".to_string()),
        created_at: chrono::Utc::now().to_rfc3339(),
        updated_at: chrono::Utc::now().to_rfc3339(),
        ..Default::default()
    })
    .unwrap();
    AgentOrgTaskStore::create(CreateTaskParams {
        id: "preexisting-completed".to_string(),
        org_run_id: run.id.clone(),
        subject: "preexisting completed".to_string(),
        description: String::new(),
        active_form: None,
        owner: Some("member-w1".to_string()),
        status: TaskStatus::Completed,
        blocks: Vec::new(),
        blocked_by: Vec::new(),
        metadata: None,
    })
    .unwrap();
    stamp_coordinator_terminal_turn("coord-root-finality-race");

    let barrier = Arc::new(Barrier::new(2));
    let reconcile_barrier = Arc::clone(&barrier);
    let reconcile_run_id = run.id.clone();
    let reconcile = std::thread::spawn(move || {
        reconcile_barrier.wait();
        AgentOrgRunStore::reconcile_run_finality(&reconcile_run_id)
    });
    let create_barrier = Arc::clone(&barrier);
    let create_run_id = run.id.clone();
    let create = std::thread::spawn(move || {
        create_barrier.wait();
        AgentOrgTaskStore::create(CreateTaskParams {
            id: "racing-task".to_string(),
            org_run_id: create_run_id,
            subject: "racing task".to_string(),
            description: String::new(),
            active_form: None,
            owner: None,
            status: TaskStatus::Pending,
            blocks: Vec::new(),
            blocked_by: Vec::new(),
            metadata: Some(serde_json::json!({
                crate::coordination::agent_org_tasks::TASK_METADATA_ELIGIBLE_MEMBER_IDS:
                    ["member-w1"],
            })),
        })
    });

    let status = reconcile.join().unwrap().unwrap().unwrap();
    let created = create.join().unwrap();
    match (status, created) {
        (AgentOrgRunStatus::Completed, Err(error)) => {
            assert!(error.contains("agent_org_run_not_mutable"), "got {error}");
        }
        (AgentOrgRunStatus::Abandoned, Ok(task)) => assert_eq!(task.id, "racing-task"),
        (status, result) => panic!("non-serializable finality result: {status:?}, {result:?}"),
    }
}

// ── HierarchyMode routing checks ────────────────────────────────
//
// Pure-function coverage for `AgentOrgRunContext::check_routing`.
// The fixture mirrors a real two-branch org so cross-branch hops
// and the coordinator escape hatch can be exercised independently.
//
//     coordinator
//     ├── lead-a (member-a, agent-a)
//     │     └── ic-a   (member-a-ic, agent-a-ic)
//     └── lead-b (member-b, agent-b)
//           └── ic-b   (member-b-ic, agent-b-ic)
fn routing_ctx(mode: HierarchyMode) -> AgentOrgRunContext {
    AgentOrgRunContext {
        run_id: "run-routing".into(),
        org_id: "org-routing".into(),
        org_name: "RoutingOrg".into(),
        org_role: "lead".into(),
        coordinator_agent_id: "agent-coord".into(),
        coordinator_name: "RoutingOrg".into(),
        coordinator_role: "lead".into(),
        members: vec![
            AgentOrgContextMember {
                member_id: "member-a".into(),
                name: "lead-a".into(),
                role: "lead".into(),
                agent_id: "agent-a".into(),
                parent_member_id: None,
            },
            AgentOrgContextMember {
                member_id: "member-a-ic".into(),
                name: "ic-a".into(),
                role: "ic".into(),
                agent_id: "agent-a-ic".into(),
                parent_member_id: Some("member-a".into()),
            },
            AgentOrgContextMember {
                member_id: "member-b".into(),
                name: "lead-b".into(),
                role: "lead".into(),
                agent_id: "agent-b".into(),
                parent_member_id: None,
            },
            AgentOrgContextMember {
                member_id: "member-b-ic".into(),
                name: "ic-b".into(),
                role: "ic".into(),
                agent_id: "agent-b-ic".into(),
                parent_member_id: Some("member-b".into()),
            },
        ],
        hierarchy_mode: mode,
        plan_approval_policy: PlanApprovalPolicy::Coordinator,
        root_session_id: None,
    }
}

#[test]
fn routing_flat_allows_anything() {
    let ctx = routing_ctx(HierarchyMode::Flat);
    assert_eq!(
        ctx.check_routing("member-a-ic", "member-b-ic"),
        RoutingDecision::Allowed,
    );
    assert_eq!(
        ctx.check_routing("member-b", "member-a"),
        RoutingDecision::Allowed,
    );
}

#[test]
fn routing_soft_allows_anything() {
    // Soft mode renders reports-to in the prompt as a hint but
    // never enforces — same outcome as Flat for the runtime layer.
    let ctx = routing_ctx(HierarchyMode::Soft);
    assert_eq!(
        ctx.check_routing("member-a-ic", "member-b-ic"),
        RoutingDecision::Allowed,
    );
}

#[test]
fn task_authority_is_not_peer_message_reachability() {
    let soft = routing_ctx(HierarchyMode::Soft);
    assert_eq!(
        soft.allowed_task_target_member_ids_for("member-a"),
        vec!["member-a".to_string(), "member-a-ic".to_string()]
    );
    assert!(soft.can_assign_task_to("member-a", "member-a-ic"));
    assert!(
        !soft.can_assign_task_to("member-a", "member-b"),
        "Soft permits peer discussion, not peer task assignment"
    );

    let strict = routing_ctx(HierarchyMode::Strict);
    assert!(strict.can_assign_task_to("member-a", "member-a-ic"));
    assert!(!strict.can_assign_task_to("member-a", "member-b"));

    let flat = routing_ctx(HierarchyMode::Flat);
    assert_eq!(
        flat.allowed_task_target_member_ids_for("member-a"),
        vec!["member-a".to_string()],
        "Flat drops reports-to authority for non-coordinator members"
    );
}

#[test]
fn task_authority_coordinator_can_manage_every_participant() {
    let ctx = routing_ctx(HierarchyMode::Strict);
    let allowed = ctx.allowed_task_target_member_ids_for(COORDINATOR_MEMBER_ID);
    assert_eq!(allowed.len(), ctx.members.len() + 1);
    assert!(allowed.contains(&COORDINATOR_MEMBER_ID.to_string()));
    assert!(ctx
        .members
        .iter()
        .all(|member| allowed.contains(&member.member_id)));
}

#[test]
fn routing_strict_allows_send_to_coordinator() {
    let ctx = routing_ctx(HierarchyMode::Strict);
    assert_eq!(
        ctx.check_routing("member-a-ic", COORDINATOR_MEMBER_ID),
        RoutingDecision::Allowed,
        "anyone may escalate to the coordinator",
    );
}

#[test]
fn routing_strict_allows_coordinator_to_anyone() {
    let ctx = routing_ctx(HierarchyMode::Strict);
    assert_eq!(
        ctx.check_routing(COORDINATOR_MEMBER_ID, "member-a-ic"),
        RoutingDecision::Allowed,
        "coordinator escape hatch — may reach any member",
    );
}

#[test]
fn routing_strict_allows_send_to_direct_manager() {
    let ctx = routing_ctx(HierarchyMode::Strict);
    assert_eq!(
        ctx.check_routing("member-a-ic", "member-a"),
        RoutingDecision::Allowed,
    );
}

#[test]
fn routing_strict_allows_send_to_direct_report() {
    let ctx = routing_ctx(HierarchyMode::Strict);
    assert_eq!(
        ctx.check_routing("member-a", "member-a-ic"),
        RoutingDecision::Allowed,
    );
}

#[test]
fn routing_strict_blocks_cross_branch() {
    let ctx = routing_ctx(HierarchyMode::Strict);
    let RoutingDecision::Blocked(hint) = ctx.check_routing("member-a-ic", "member-b-ic") else {
        panic!("expected cross-branch send to be blocked");
    };
    assert!(
        hint.contains("sender_member_id 'member-a-ic'"),
        "hint should name the sender member id (got: {hint})",
    );
    assert!(
        hint.contains("recipient_member_id 'member-b-ic'"),
        "hint should name the recipient member id (got: {hint})",
    );
    assert!(
        hint.contains("Allowed recipient_member_id values: coordinator, member-a"),
        "hint should expose the canonical member-id allow-list (got: {hint})",
    );
}

#[test]
fn routing_strict_blocks_skip_level_up() {
    // ic-a sending to its grand-manager (the coordinator's other
    // direct report) is also a violation — only direct manager is
    // allowed.
    let ctx = routing_ctx(HierarchyMode::Strict);
    assert!(matches!(
        ctx.check_routing("member-a-ic", "member-b"),
        RoutingDecision::Blocked(_)
    ));
}

#[test]
fn routing_strict_blocks_peer_to_peer_lead() {
    let ctx = routing_ctx(HierarchyMode::Strict);
    let RoutingDecision::Blocked(hint) = ctx.check_routing("member-a", "member-b") else {
        panic!("peer leads must not contact each other directly");
    };
    assert!(
        hint.contains("Allowed recipient_member_id values: coordinator"),
        "top-level lead should only be allowed to route through coordinator (got: {hint})",
    );
}

#[test]
fn routing_strict_blocks_unknown_sender_with_useful_hint() {
    // A sender that isn't in the roster (shouldn't happen in
    // practice, but the function must not panic): the message
    // should still surface a Blocked decision rather than silently
    // letting it through.
    let ctx = routing_ctx(HierarchyMode::Strict);
    assert!(matches!(
        ctx.check_routing("member-stranger", "member-a-ic"),
        RoutingDecision::Blocked(_)
    ));
}

use super::events::{build_plan_approval_event, PlanApprovalCardStatus};
use super::persistence::test_support::{lock_and_prepare, temp_home};
use super::persistence::{PendingPlanRow, PlanApprovalStore};
use super::repair::repair_orphaned_create_plan_submissions_sync;
use super::*;
use std::path::Path;

// Every manager test now hits the real sqlite DB via `mark_ready`, so
// they all serialize on `lock_and_prepare()` — no exceptions. The lock
// guard also clears the `pending_plan_approvals` table so each test
// starts from a clean slate.

async fn wait_for_pending_row(session_id: &str) {
    for _ in 0..20 {
        if PlanApprovalStore::load_by_session(session_id)
            .unwrap()
            .is_some()
        {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("pending plan row was not persisted for {session_id}");
}

#[tokio::test]
async fn mark_ready_then_take_returns_snapshot() {
    let _lock = lock_and_prepare();
    let plan_path = temp_home().join("snapshot.plan.md");
    std::fs::write(&plan_path, "body").unwrap();
    let mgr = PlanApprovalManager::new();
    mgr.mark_ready(
        "s1",
        plan_path.to_str().unwrap(),
        "Title",
        "body",
        Some("call_1"),
    )
    .await;
    assert!(mgr.is_pending().await);
    let snap = mgr.take_pending().await.unwrap();
    assert_eq!(snap.session_id, "s1");
    assert_eq!(snap.tool_call_id.as_deref(), Some("call_1"));
    assert_eq!(snap.origin_tool_call_id.as_deref(), Some("call_1"));
    assert!(!mgr.is_pending().await);
}

#[tokio::test]
async fn second_mark_ready_archives_first() {
    let _lock = lock_and_prepare();
    let plan_a = temp_home().join("a.plan.md");
    let plan_b = temp_home().join("b.plan.md");
    std::fs::write(&plan_a, "body").unwrap();
    std::fs::write(&plan_b, "body2").unwrap();
    let mgr = PlanApprovalManager::new();
    mgr.mark_ready("s1", plan_a.to_str().unwrap(), "A", "body", None)
        .await;
    mgr.mark_ready("s1", plan_b.to_str().unwrap(), "B", "body2", None)
        .await;
    let snap = mgr.pending_snapshot().await.unwrap();
    assert_eq!(snap.plan_path, plan_b.to_str().unwrap());
}

#[test]
fn lifecycle_events_keep_plan_revision_creation_timestamp() {
    let snapshot = PendingPlanApproval {
        session_id: "s1".into(),
        tool_call_id: Some("call_1".into()),
        plan_id: "plan-1".into(),
        plan_revision_id: "call_1".into(),
        origin_tool_call_id: Some("call_1".into()),
        plan_path: "/tmp/plan.md".into(),
        plan_title: "Plan".into(),
        plan_content: "body".into(),
        created_at_ms: 1_700_000_000_000,
    };

    let archived =
        build_plan_approval_event(&snapshot, "archive", PlanApprovalCardStatus::Archived);
    let approved =
        build_plan_approval_event(&snapshot, "approval", PlanApprovalCardStatus::Approved);
    let rejected =
        build_plan_approval_event(&snapshot, "rejection", PlanApprovalCardStatus::Cancelled);

    assert_eq!(archived.created_at, "2023-11-14T22:13:20+00:00");
    assert_eq!(approved.created_at, archived.created_at);
    assert_eq!(rejected.created_at, archived.created_at);
    assert_eq!(archived.result["status"], "archived");
    assert_eq!(rejected.result["status"], "cancelled");
}

#[tokio::test]
async fn reject_pending_drops_pending_snapshot() {
    let _lock = lock_and_prepare();
    let plan_path = temp_home().join("reject.plan.md");
    std::fs::write(&plan_path, "body").unwrap();
    let mgr = PlanApprovalManager::new();
    mgr.mark_ready("s1", plan_path.to_str().unwrap(), "T", "body", None)
        .await;
    let rejected = mgr.reject_pending().await.expect("pending plan");
    assert_eq!(rejected.plan_path, plan_path.to_str().unwrap());
    assert!(!mgr.is_pending().await);
    assert!(mgr.reject_pending().await.is_none());
}

#[tokio::test]
async fn clear_silently_drops_without_panic() {
    let _lock = lock_and_prepare();
    let plan_path = temp_home().join("clear.plan.md");
    std::fs::write(&plan_path, "body").unwrap();
    let mgr = PlanApprovalManager::new();
    mgr.mark_ready("s1", plan_path.to_str().unwrap(), "T", "body", None)
        .await;
    mgr.clear_silently().await;
    assert!(!mgr.is_pending().await);
    mgr.clear_silently().await;
}

#[tokio::test]
async fn mark_ready_persists_and_rehydrate_round_trip() {
    let _lock = lock_and_prepare();
    let plan_path = temp_home().join("persist.plan.md");
    std::fs::write(&plan_path, "body content").unwrap();

    let session_id = "s_persist";
    {
        let mgr = PlanApprovalManager::new();
        mgr.mark_ready(
            session_id,
            plan_path.to_str().unwrap(),
            "Title",
            "body content",
            Some("call_9"),
        )
        .await;
        let persisted = PlanApprovalStore::load_by_session(session_id)
            .unwrap()
            .expect("mark_ready must persist before it returns");
        assert_eq!(persisted.plan_revision_id, "call_9");
        assert!(mgr.is_pending().await);
    }

    let fresh = PlanApprovalManager::new();
    assert!(!fresh.is_pending().await);
    fresh.rehydrate_from_db(session_id).await.unwrap();
    let snap = fresh.pending_snapshot().await.expect("rehydrated");
    assert_eq!(snap.session_id, session_id);
    assert_eq!(snap.plan_path, plan_path.to_str().unwrap());
    assert_eq!(snap.tool_call_id.as_deref(), Some("call_9"));
    assert_eq!(snap.origin_tool_call_id.as_deref(), Some("call_9"));
}

#[tokio::test]
async fn take_pending_deletes_row_so_rehydrate_is_empty() {
    let _lock = lock_and_prepare();
    let plan_path = temp_home().join("take.plan.md");
    std::fs::write(&plan_path, "body").unwrap();

    let session_id = "s_take";
    let mgr = PlanApprovalManager::new();
    mgr.mark_ready(session_id, plan_path.to_str().unwrap(), "T", "body", None)
        .await;
    wait_for_pending_row(session_id).await;
    let _ = mgr.take_pending().await;

    let fresh = PlanApprovalManager::new();
    fresh.rehydrate_from_db(session_id).await.unwrap();
    assert!(!fresh.is_pending().await, "row must be deleted after take");
}

#[tokio::test]
async fn clear_silently_keeps_row_so_rehydrate_restores_pending() {
    let _lock = lock_and_prepare();
    let plan_path = temp_home().join("clear_rehydrate.plan.md");
    std::fs::write(&plan_path, "body").unwrap();

    let session_id = "s_clear";
    let mgr = PlanApprovalManager::new();
    mgr.mark_ready(session_id, plan_path.to_str().unwrap(), "T", "body", None)
        .await;
    wait_for_pending_row(session_id).await;
    mgr.clear_silently().await;
    assert!(!mgr.is_pending().await, "memory slot must be dropped");

    // Stop / eviction is not a decision about the plan: the DB row
    // survives and the next rehydrate restores the Build card.
    let fresh = PlanApprovalManager::new();
    fresh.rehydrate_from_db(session_id).await.unwrap();
    assert!(
        fresh.is_pending().await,
        "DB row must survive clear_silently"
    );
}

#[tokio::test]
async fn rehydrate_missing_plan_file_drops_row_silently() {
    let _lock = lock_and_prepare();
    let plan_path = temp_home().join("missing.plan.md");
    std::fs::write(&plan_path, "body").unwrap();

    let session_id = "s_missing";
    let mgr = PlanApprovalManager::new();
    mgr.mark_ready(session_id, plan_path.to_str().unwrap(), "T", "body", None)
        .await;
    wait_for_pending_row(session_id).await;

    std::fs::remove_file(&plan_path).unwrap();

    let fresh = PlanApprovalManager::new();
    fresh.rehydrate_from_db(session_id).await.unwrap();
    assert!(
        !fresh.is_pending().await,
        "missing file ⇒ no rehydrated snapshot"
    );

    let fresh2 = PlanApprovalManager::new();
    fresh2.rehydrate_from_db(session_id).await.unwrap();
    assert!(!fresh2.is_pending().await);
}

#[tokio::test]
async fn load_snapshot_returns_row_when_file_exists() {
    let _lock = lock_and_prepare();
    let plan_path = temp_home().join("load_ok.plan.md");
    std::fs::write(&plan_path, "body").unwrap();

    let session_id = "s_load_ok";
    let mgr = PlanApprovalManager::new();
    mgr.mark_ready(
        session_id,
        plan_path.to_str().unwrap(),
        "T",
        "body",
        Some("call_x"),
    )
    .await;
    wait_for_pending_row(session_id).await;

    let snap = super::load_snapshot_for_session(session_id)
        .await
        .unwrap()
        .expect("snapshot present");
    assert_eq!(snap.session_id, session_id);
    assert_eq!(snap.tool_call_id.as_deref(), Some("call_x"));
    assert_eq!(snap.origin_tool_call_id.as_deref(), Some("call_x"));
}

#[tokio::test]
async fn load_snapshot_drops_row_when_file_missing() {
    let _lock = lock_and_prepare();
    let plan_path = temp_home().join("load_missing.plan.md");
    std::fs::write(&plan_path, "body").unwrap();

    let session_id = "s_load_missing";
    let mgr = PlanApprovalManager::new();
    mgr.mark_ready(session_id, plan_path.to_str().unwrap(), "T", "body", None)
        .await;
    wait_for_pending_row(session_id).await;
    std::fs::remove_file(&plan_path).unwrap();

    assert!(super::load_snapshot_for_session(session_id)
        .await
        .unwrap()
        .is_none());

    // Second call must still return None (row was deleted, not just
    // hidden) — this is the restart-convergence invariant the Build
    // button relies on.
    assert!(super::load_snapshot_for_session(session_id)
        .await
        .unwrap()
        .is_none());
}

fn seed_orphan_create_plan_event(
    session_id: &str,
    call_id: &str,
    title: &str,
    content: &str,
    workspace_path: &Path,
    sequence: i64,
    created_at: &str,
) {
    let conn = database::db::get_connection().expect("test sqlite connection");
    conn.execute_batch(
        r#"
            CREATE TABLE IF NOT EXISTS events (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                function_name TEXT,
                thread_id TEXT,
                args_json TEXT NOT NULL DEFAULT '{}',
                result_json TEXT NOT NULL DEFAULT '{}',
                content TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                meta_json TEXT,
                history_sequence INTEGER,
                UNIQUE(id, session_id)
            );
            CREATE TABLE IF NOT EXISTS session_turns (
                session_id TEXT NOT NULL,
                turn_id TEXT NOT NULL,
                start_sequence INTEGER NOT NULL,
                end_sequence INTEGER,
                next_turn_id TEXT,
                started_at TEXT NOT NULL,
                ended_at TEXT,
                duration_ms INTEGER,
                user_event_ids_json TEXT NOT NULL DEFAULT '[]',
                user_preview TEXT NOT NULL DEFAULT '',
                event_count INTEGER NOT NULL DEFAULT 0,
                body_event_count INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL,
                interrupted INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL,
                modified_files_json TEXT NOT NULL DEFAULT '[]',
                PRIMARY KEY (session_id, turn_id)
            );
            "#,
    )
    .expect("session event schema");
    let args_json = serde_json::json!({
        "title": title,
        "content": content,
    })
    .to_string();
    let meta_json = serde_json::json!({
        "callId": call_id,
    })
    .to_string();

    conn.execute(
        "INSERT OR REPLACE INTO events
             (id, session_id, event_type, function_name, args_json, result_json,
              content, created_at, meta_json, history_sequence)
             VALUES (?1, ?2, 'tool_call', 'create_plan', ?3, '{}', '', ?4, ?5, ?6)",
        rusqlite::params![
            format!("tool-call-{call_id}"),
            session_id,
            args_json,
            created_at,
            meta_json,
            sequence,
        ],
    )
    .expect("seed create_plan event");

    conn.execute(
        "INSERT OR REPLACE INTO session_turns
             (session_id, turn_id, start_sequence, end_sequence, started_at, status, updated_at,
              user_preview, event_count, body_event_count)
             VALUES (?1, ?2, ?3, NULL, ?4, 'pending', ?4, '', 1, 1)",
        rusqlite::params![session_id, format!("turn-{call_id}"), sequence, created_at,],
    )
    .expect("seed pending turn");

    seed_session_row_with_workspace(session_id, "plan", workspace_path);
}

fn seed_session_row(session_id: &str, exec_mode: &str) {
    seed_session_row_with_workspace(session_id, exec_mode, &temp_home());
}

fn seed_session_row_with_workspace(session_id: &str, exec_mode: &str, workspace_path: &Path) {
    use crate::session::persistence::{upsert_session, UnifiedSessionRecord};
    let conn = database::db::get_connection().expect("test sqlite connection");
    crate::persistence::test_schema::ensure_agent_sessions_schema(&conn);
    crate::session::persistence::init(&conn).expect("session persistence migrations");

    let now = chrono::Utc::now().to_rfc3339();
    upsert_session(&UnifiedSessionRecord {
        session_id: session_id.to_string(),
        name: format!("{session_id} session"),
        status: "idle".to_string(),
        agent_exec_mode: Some(exec_mode.to_string()),
        workspace_path: Some(workspace_path.to_string_lossy().into_owned()),
        created_at: now.clone(),
        updated_at: now,
        ..Default::default()
    })
    .expect("seed session row");
    crate::session::persistence::update_agent_exec_mode(session_id, exec_mode)
        .expect("seed exec mode");
}

#[tokio::test]
async fn repair_orphaned_create_plan_keeps_latest_submission_per_session() {
    let _lock = lock_and_prepare();
    let session_id = "s_repair_latest";
    let workspace = temp_home().join("repair-latest-workspace");
    let plans_dir = workspace.join(".orgii").join("plans");
    std::fs::create_dir_all(&plans_dir).unwrap();

    let old_content = "old orphan body";
    let new_content = "new orphan body";
    let old_plan_path = plans_dir.join("old-plan_aaaaaaaa.plan.md");
    let new_plan_path = plans_dir.join("new-plan_bbbbbbbb.plan.md");
    std::fs::write(&old_plan_path, old_content).unwrap();
    std::fs::write(&new_plan_path, new_content).unwrap();

    PlanApprovalStore::upsert(&PendingPlanRow {
        session_id: session_id.to_string(),
        tool_call_id: Some("call_old".to_string()),
        plan_id: "plan-old".to_string(),
        plan_revision_id: "call_old".to_string(),
        origin_tool_call_id: Some("call_old".to_string()),
        plan_path: old_plan_path.to_string_lossy().into_owned(),
        plan_title: "Old Plan".to_string(),
        plan_content: old_content.to_string(),
        created_at_ms: 1_700_000_000_000,
    })
    .unwrap();

    seed_orphan_create_plan_event(
        session_id,
        "call_old",
        "Old Plan",
        old_content,
        &workspace,
        10,
        "2023-11-14T22:13:20+00:00",
    );
    seed_orphan_create_plan_event(
        session_id,
        "call_new",
        "New Plan",
        new_content,
        &workspace,
        20,
        "2023-11-14T22:14:20+00:00",
    );

    assert_eq!(repair_orphaned_create_plan_submissions_sync().unwrap(), 1);

    let loaded = PlanApprovalStore::load_by_session(session_id)
        .unwrap()
        .expect("pending row");
    assert_eq!(loaded.tool_call_id.as_deref(), Some("call_new"));
    assert_eq!(loaded.origin_tool_call_id.as_deref(), Some("call_new"));
    assert_eq!(loaded.plan_title, "New Plan");
    assert_eq!(loaded.plan_content, new_content);
    assert_eq!(loaded.plan_path, new_plan_path.to_string_lossy());
}

#[tokio::test]
async fn resolve_pending_orphaned_deletes_row_without_manager() {
    let _lock = lock_and_prepare();
    let plan_path = temp_home().join("abandon.plan.md");
    std::fs::write(&plan_path, "body").unwrap();

    let session_id = "s_abandon";
    let mgr = PlanApprovalManager::new();
    mgr.mark_ready(session_id, plan_path.to_str().unwrap(), "T", "body", None)
        .await;
    wait_for_pending_row(session_id).await;

    let snap = resolve_pending(session_id, PlanResolution::Orphaned, None)
        .await
        .expect("pending resolved");
    assert_eq!(snap.session_id, session_id);

    // Row gone — second resolve is a no-op, rehydrate finds nothing.
    assert!(resolve_pending(session_id, PlanResolution::Orphaned, None)
        .await
        .is_none());
    assert!(super::load_snapshot_for_session(session_id)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn resolve_pending_approved_with_edits_writes_plan_file() {
    let _lock = lock_and_prepare();
    let plan_path = temp_home().join("edit.plan.md");
    std::fs::write(&plan_path, "original").unwrap();

    let session_id = "s_edit";
    let mgr = PlanApprovalManager::new();
    mgr.mark_ready(
        session_id,
        plan_path.to_str().unwrap(),
        "T",
        "original",
        None,
    )
    .await;

    let snap = resolve_pending(
        session_id,
        PlanResolution::Approved {
            edited: Some("edited body".to_string()),
        },
        Some(&mgr),
    )
    .await
    .expect("approved");
    assert_eq!(snap.session_id, session_id);
    assert_eq!(std::fs::read_to_string(&plan_path).unwrap(), "edited body");
    assert!(!mgr.is_pending().await);
}

#[tokio::test]
async fn rehydrate_keeps_row_when_session_left_plan_mode() {
    let _lock = lock_and_prepare();
    let plan_path = temp_home().join("left_plan_mode.plan.md");
    std::fs::write(&plan_path, "body").unwrap();

    let session_id = "s_left_plan";
    seed_session_row(session_id, "build");
    let mgr = PlanApprovalManager::new();
    mgr.mark_ready(session_id, plan_path.to_str().unwrap(), "T", "body", None)
        .await;
    wait_for_pending_row(session_id).await;

    // Pending plans are session-level state decoupled from the exec
    // mode: a session that switched to Build keeps its Build card.
    let fresh = PlanApprovalManager::new();
    fresh.rehydrate_from_db(session_id).await.unwrap();
    assert!(
        fresh.is_pending().await,
        "pending plan must survive the session leaving plan mode"
    );
    assert!(super::load_snapshot_for_session(session_id)
        .await
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn rehydrate_keeps_row_when_session_still_in_plan_mode() {
    let _lock = lock_and_prepare();
    let plan_path = temp_home().join("still_plan_mode.plan.md");
    std::fs::write(&plan_path, "body").unwrap();

    let session_id = "s_still_plan";
    seed_session_row(session_id, "plan");
    let mgr = PlanApprovalManager::new();
    mgr.mark_ready(session_id, plan_path.to_str().unwrap(), "T", "body", None)
        .await;
    wait_for_pending_row(session_id).await;

    let fresh = PlanApprovalManager::new();
    fresh.rehydrate_from_db(session_id).await.unwrap();
    assert!(fresh.is_pending().await);
}

#[tokio::test]
async fn gc_collects_orphans_and_keeps_rows_regardless_of_mode() {
    let _lock = lock_and_prepare();

    // Live: session in plan mode, file exists → must survive GC.
    // One manager per session — mirrors production (PlanApprovalManager
    // is per-session; mark_ready's supersede path assumes same-session).
    let live_path = temp_home().join("gc_live.plan.md");
    std::fs::write(&live_path, "body").unwrap();
    seed_session_row("s_gc_live", "plan");
    PlanApprovalManager::new()
        .mark_ready("s_gc_live", live_path.to_str().unwrap(), "T", "body", None)
        .await;
    wait_for_pending_row("s_gc_live").await;

    // Orphan A: file deleted.
    let gone_path = temp_home().join("gc_gone.plan.md");
    std::fs::write(&gone_path, "body").unwrap();
    seed_session_row("s_gc_gone", "plan");
    PlanApprovalManager::new()
        .mark_ready("s_gc_gone", gone_path.to_str().unwrap(), "T", "body", None)
        .await;
    wait_for_pending_row("s_gc_gone").await;
    std::fs::remove_file(&gone_path).unwrap();

    // NOT an orphan: session left plan mode but still exists — the
    // pending plan must survive GC (mode-decoupled lifecycle).
    let stale_path = temp_home().join("gc_stale.plan.md");
    std::fs::write(&stale_path, "body").unwrap();
    seed_session_row("s_gc_left_mode", "build");
    PlanApprovalManager::new()
        .mark_ready(
            "s_gc_left_mode",
            stale_path.to_str().unwrap(),
            "T",
            "body",
            None,
        )
        .await;
    wait_for_pending_row("s_gc_left_mode").await;

    // Orphan C: session row does not exist at all.
    let no_session_path = temp_home().join("gc_no_session.plan.md");
    std::fs::write(&no_session_path, "body").unwrap();
    PlanApprovalManager::new()
        .mark_ready(
            "s_gc_no_session",
            no_session_path.to_str().unwrap(),
            "T",
            "body",
            None,
        )
        .await;
    wait_for_pending_row("s_gc_no_session").await;

    gc_orphaned_pending_plans().await;

    let remaining = PlanApprovalStore::list_all().unwrap();
    let mut remaining_ids: Vec<&str> = remaining
        .iter()
        .map(|row| row.session_id.as_str())
        .collect();
    remaining_ids.sort_unstable();
    assert_eq!(remaining_ids, vec!["s_gc_left_mode", "s_gc_live"]);
}

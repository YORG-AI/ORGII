//! Root-conversation deletion for Rust Agent Org runs.
//!
//! The protocol is intentionally split into durable phases: plan and preflight,
//! establish the Root fence, quiesce runtimes, then remove all SQLite-owned
//! state in one transaction. A committed fence survives every later failure.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use crate::coordination::agent_org_runs::{
    agent_org_submission_in_progress, ensure_session_conversation_writable_with_connection,
    establish_conversation_delete_fence, remove_conversation_delete_fence_with_connection,
    AgentOrgRunDeleteOutcome, AgentOrgRunStatus, AgentOrgRunStore, COORDINATOR_MEMBER_ID,
};
use crate::definitions::orgs::{parse_cli_agent_org_reference, OrgDefinition, OrgMember};
use crate::session::persistence::{self as session_persistence, session_type};
use crate::session::SessionStatus;
use crate::state::control_flow::CancelReason;
use crate::state::{AgentAppState, AgentSession};
use database::db::{get_connection, with_sessions_writer};
use rusqlite::{params, Connection, OptionalExtension};

use super::persistence::DeleteSessionReceipt;

pub(super) const MAX_AGENT_ORG_DELETE_RUNS: usize = 1_024;
pub(super) const MAX_AGENT_ORG_DELETE_SESSIONS: usize = 1_024;
const AGENT_ORG_DELETE_STOP_TIMEOUT: Duration = Duration::from_secs(10);
const AGENT_ORG_DELETE_STOP_POLL_INTERVAL: Duration = Duration::from_millis(50);
const SESSION_STATE_TABLES: &[&str] = &[
    "session_turns",
    "session_turn_index_state",
    "sessions",
    "goal_loop_state",
    "housekeeper_context_compaction",
];

fn root_refusal(root: &str, reason: impl std::fmt::Display) -> String {
    format!("Refusing to delete Agent Org root {root}: {reason}")
}

fn run_refusal(run: &str, reason: impl std::fmt::Display) -> String {
    format!("Refusing to delete Agent Org run {run}: {reason}")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct AgentOrgSessionDeleteNode {
    pub(super) session_id: String,
    pub(super) parent_session_id: Option<String>,
    pub(super) status: SessionStatus,
    pub(super) owning_run_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct AgentOrgRunDeletePlan {
    pub(super) run_id: String,
    pub(super) status: AgentOrgRunStatus,
    pub(super) worker_session_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct AgentOrgSessionDeletePlan {
    pub(super) root_session_id: String,
    pub(super) runs: Vec<AgentOrgRunDeletePlan>,
    pub(super) sessions: Vec<AgentOrgSessionDeleteNode>,
}

#[derive(Debug)]
struct FencedAgentOrgDeletePlan(AgentOrgSessionDeletePlan);

#[derive(Debug)]
struct QuiescedAgentOrgDeletePlan {
    plan: AgentOrgSessionDeletePlan,
    safe_inflight_session_ids: HashSet<String>,
}

#[derive(Debug)]
struct AgentOrgSessionPostCommitCleanup {
    session_id: String,
    workspace_path: Option<PathBuf>,
    managed_worktree: bool,
}

struct AgentOrgCommittedDelete {
    receipt: DeleteSessionReceipt,
    run_cleanup: Vec<(String, AgentOrgRunDeleteOutcome)>,
    session_cleanup: Vec<AgentOrgSessionPostCommitCleanup>,
}

impl AgentOrgCommittedDelete {
    fn already_completed(receipt: DeleteSessionReceipt) -> Self {
        Self {
            receipt,
            run_cleanup: Vec::new(),
            session_cleanup: Vec::new(),
        }
    }
}

#[derive(Debug)]
enum ReloadedAgentOrgDeletePlan {
    Present(AgentOrgSessionDeletePlan),
    ConcurrentlyCompleted(DeleteSessionReceipt),
}

async fn reload_agent_org_delete_plan(
    root_session_id: String,
    expected: AgentOrgSessionDeletePlan,
    disappearance: &'static str,
) -> Result<ReloadedAgentOrgDeletePlan, String> {
    tokio::task::spawn_blocking(move || {
        let conn = get_connection().map_err(|err| err.to_string())?;
        match load_agent_org_session_delete_plan(&conn, &root_session_id)? {
            Some(plan) => Ok(ReloadedAgentOrgDeletePlan::Present(plan)),
            None => completed_agent_org_delete_receipt(&conn, &expected)?
                .map(ReloadedAgentOrgDeletePlan::ConcurrentlyCompleted)
                .ok_or_else(|| {
                    root_refusal(
                        &root_session_id,
                        format!("ownership disappeared {disappearance}"),
                    )
                }),
        }
    })
    .await
    .map_err(|err| format!("Agent Org deletion planning worker failed: {err}"))?
}

pub(super) async fn delete_session(
    state: &AgentAppState,
    session_id: String,
) -> Result<DeleteSessionReceipt, String> {
    let planned_session_id = session_id.clone();
    let initial_plan = tokio::task::spawn_blocking(move || {
        let conn = get_connection().map_err(|err| err.to_string())?;
        load_agent_org_session_delete_plan(&conn, &planned_session_id)
    })
    .await
    .map_err(|err| format!("session deletion planning worker failed: {err}"))??;

    let Some(initial_plan) = initial_plan else {
        let deleted_session_id = session_id.clone();
        tokio::task::spawn_blocking(move || {
            session_persistence::delete_session(&deleted_session_id).map_err(|err| err.to_string())
        })
        .await
        .map_err(|err| format!("session deletion worker failed: {err}"))??;
        return Ok(DeleteSessionReceipt {
            deleted_session_ids: vec![session_id],
        });
    };

    preflight_agent_org_delete_resources(&initial_plan)?;

    let root_session_id = initial_plan.root_session_id.clone();
    tokio::task::spawn_blocking(move || establish_conversation_delete_fence(&root_session_id))
        .await
        .map_err(|err| format!("Agent Org deletion fence worker failed: {err}"))??;

    let root_session_id = initial_plan.root_session_id.clone();
    let completion_plan = initial_plan.clone();
    let fenced_plan =
        reload_agent_org_delete_plan(root_session_id, completion_plan, "after fencing").await?;

    let fenced_plan = match fenced_plan {
        ReloadedAgentOrgDeletePlan::Present(plan) => plan,
        ReloadedAgentOrgDeletePlan::ConcurrentlyCompleted(receipt) => {
            return finish_agent_org_delete(
                state,
                AgentOrgCommittedDelete::already_completed(receipt),
            )
            .await;
        }
    };

    preflight_agent_org_delete_resources(&fenced_plan)?;
    let fenced_plan = FencedAgentOrgDeletePlan(fenced_plan);
    let safe_inflight_session_ids = stop_agent_org_runtime_sessions(state, &fenced_plan.0).await?;

    let root_session_id = fenced_plan.0.root_session_id.clone();
    let completion_plan = fenced_plan.0.clone();
    let current_plan =
        reload_agent_org_delete_plan(root_session_id, completion_plan, "while stopping").await?;
    let current_plan = match current_plan {
        ReloadedAgentOrgDeletePlan::Present(plan) => plan,
        ReloadedAgentOrgDeletePlan::ConcurrentlyCompleted(receipt) => {
            return finish_agent_org_delete(
                state,
                AgentOrgCommittedDelete::already_completed(receipt),
            )
            .await;
        }
    };
    if !agent_org_delete_topology_matches(&fenced_plan.0, &current_plan) {
        return Err(root_refusal(
            &fenced_plan.0.root_session_id,
            "ownership changed while stopping",
        ));
    }

    validate_agent_org_delete_ready(&current_plan, &safe_inflight_session_ids)?;
    ensure_agent_org_runtime_sessions_idle(state, &current_plan).await?;
    let quiesced_plan = QuiescedAgentOrgDeletePlan {
        plan: current_plan,
        safe_inflight_session_ids,
    };

    let committed_delete = tokio::task::spawn_blocking(move || {
        commit_agent_org_session_hierarchy(
            &quiesced_plan.plan,
            &quiesced_plan.safe_inflight_session_ids,
        )
    })
    .await
    .map_err(|err| format!("Agent Org session deletion worker failed: {err}"))??;

    finish_agent_org_delete(state, committed_delete).await
}

async fn finish_agent_org_delete(
    state: &AgentAppState,
    committed_delete: AgentOrgCommittedDelete,
) -> Result<DeleteSessionReceipt, String> {
    let AgentOrgCommittedDelete {
        receipt,
        run_cleanup,
        session_cleanup,
    } = committed_delete;
    // Remove in-memory entry points immediately after the durable commit.
    // Filesystem cleanup can be slower (notably Git worktree pruning) and
    // must not leave a deleted runtime addressable during that interval.
    state.remove_sessions(&receipt.deleted_session_ids).await;
    if let Some(app_handle) = state.app_handle.as_ref() {
        for deleted_session_id in &receipt.deleted_session_ids {
            crate::bus::event_pipeline_bridge::evict_session(app_handle, deleted_session_id);
        }
    }
    if !run_cleanup.is_empty() || !session_cleanup.is_empty() {
        if let Err(error) = tokio::task::spawn_blocking(move || {
            finish_agent_org_post_commit_resources(run_cleanup, session_cleanup)
        })
        .await
        {
            tracing::warn!(
                error = %error,
                "Agent Org deletion committed, but post-commit resource cleanup worker failed"
            );
        }
    }
    Ok(receipt)
}

fn completed_agent_org_delete_receipt(
    conn: &Connection,
    expected_plan: &AgentOrgSessionDeletePlan,
) -> Result<Option<DeleteSessionReceipt>, String> {
    let fence_or_run_exists = conn
        .query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM agent_org_conversation_delete_fences
                 WHERE root_session_id=?1
             ) OR EXISTS(
                 SELECT 1 FROM agent_org_runs WHERE root_session_id=?1
             )",
            [&expected_plan.root_session_id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|err| err.to_string())?;
    if fence_or_run_exists {
        return Ok(None);
    }
    for node in &expected_plan.sessions {
        let exists = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM agent_sessions WHERE session_id=?1)",
                [&node.session_id],
                |row| row.get::<_, bool>(0),
            )
            .map_err(|err| err.to_string())?;
        if exists {
            return Ok(None);
        }
    }
    Ok(Some(DeleteSessionReceipt {
        deleted_session_ids: expected_plan
            .sessions
            .iter()
            .map(|node| node.session_id.clone())
            .collect(),
    }))
}

fn preflight_agent_org_delete_resources(plan: &AgentOrgSessionDeletePlan) -> Result<(), String> {
    for node in &plan.sessions {
        crate::tools::impls::coding::exec::shell_replay::ensure_session_replays_deletable(
            &node.session_id,
        )?;
    }
    Ok(())
}

pub(super) fn load_agent_org_session_delete_plan(
    conn: &Connection,
    root_session_id: &str,
) -> Result<Option<AgentOrgSessionDeletePlan>, String> {
    let run_rows = load_root_runs(conn, root_session_id)?;
    if run_rows.is_empty() {
        // A retained fence means an earlier deletion reached its durable
        // boundary but did not finish. Treating this as an ordinary Session
        // would strand the fence and bypass the Agent Org retry protocol.
        ensure_session_conversation_writable_with_connection(conn, root_session_id)?;
        return Ok(None);
    }

    let (root_parent_session_id, root_status_raw): (Option<String>, String) = conn
        .query_row(
            "SELECT parent_session_id, status
             FROM agent_sessions
             WHERE session_id=?1",
            [root_session_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|err| err.to_string())?
        .ok_or_else(|| root_refusal(root_session_id, "root session is missing"))?;
    let root_status = parse_session_status(root_session_id, &root_status_raw)?;

    validate_descendant_shape(conn, root_session_id)?;
    reject_historical_cli_descendants(conn, root_session_id)?;

    let run_ids = run_rows
        .iter()
        .map(|(run_id, _)| run_id.clone())
        .collect::<HashSet<_>>();
    let mut coordinator_runs = HashSet::new();
    let mut worker_ids = HashSet::new();
    let mut workers_by_run = HashMap::<String, Vec<String>>::new();
    let mut worker_nodes = Vec::new();
    let mut mapping_count = 0usize;

    let mut stmt = conn
        .prepare(
            "SELECT mapping.org_run_id,
                    mapping.member_id,
                    mapping.session_id,
                    mapping.role,
                    session.parent_session_id,
                    session.status,
                    session.agent_definition_id,
                    session.org_member_id
             FROM agent_org_run_sessions mapping
             JOIN agent_org_runs run ON run.id=mapping.org_run_id
             LEFT JOIN agent_sessions session ON session.session_id=mapping.session_id
             WHERE run.root_session_id=?1
             ORDER BY mapping.org_run_id, mapping.role, mapping.member_id
             LIMIT ?2",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(
            params![
                root_session_id,
                (MAX_AGENT_ORG_DELETE_RUNS + MAX_AGENT_ORG_DELETE_SESSIONS + 1) as i64
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                ))
            },
        )
        .map_err(|err| err.to_string())?;

    for row in rows {
        let (
            run_id,
            member_id,
            session_id,
            role,
            parent_session_id,
            status_raw,
            agent_definition_id,
            org_member_id,
        ) = row.map_err(|err| err.to_string())?;
        mapping_count += 1;
        if mapping_count > MAX_AGENT_ORG_DELETE_RUNS + MAX_AGENT_ORG_DELETE_SESSIONS {
            return Err(root_refusal(
                root_session_id,
                "ownership exceeds the bounded deletion limit",
            ));
        }
        if !run_ids.contains(&run_id) {
            return Err(root_refusal(
                root_session_id,
                format!("mapping references unexpected run {run_id}"),
            ));
        }
        match role.as_str() {
            "coordinator" => {
                if member_id != COORDINATOR_MEMBER_ID || session_id != root_session_id {
                    return Err(run_refusal(&run_id, "invalid Coordinator mapping"));
                }
                if !coordinator_runs.insert(run_id.clone()) {
                    return Err(run_refusal(&run_id, "duplicate Coordinator mapping"));
                }
            }
            "worker" => {
                let status_raw = status_raw.ok_or_else(|| {
                    run_refusal(
                        &run_id,
                        format!("mapped Worker session {session_id} is missing"),
                    )
                })?;
                if member_id == COORDINATOR_MEMBER_ID
                    || parent_session_id.as_deref() != Some(root_session_id)
                    || agent_definition_id.as_deref().is_none_or(str::is_empty)
                    || org_member_id.as_deref() != Some(member_id.as_str())
                {
                    return Err(run_refusal(
                        &run_id,
                        format!("mapped Worker session {session_id} has inconsistent identity"),
                    ));
                }
                if !worker_ids.insert(session_id.clone()) {
                    return Err(root_refusal(
                        root_session_id,
                        format!("Worker session {session_id} has duplicate ownership"),
                    ));
                }
                let status = parse_session_status(&session_id, &status_raw)?;
                workers_by_run
                    .entry(run_id.clone())
                    .or_default()
                    .push(session_id.clone());
                worker_nodes.push(AgentOrgSessionDeleteNode {
                    session_id,
                    parent_session_id,
                    status,
                    owning_run_id: Some(run_id),
                });
            }
            _ => {
                return Err(run_refusal(
                    &run_id,
                    format!("unknown ownership role {role:?}"),
                ));
            }
        }
    }

    for (run_id, _) in &run_rows {
        if !coordinator_runs.contains(run_id) {
            return Err(run_refusal(run_id, "Coordinator mapping is missing"));
        }
    }
    if worker_nodes.len() + 1 > MAX_AGENT_ORG_DELETE_SESSIONS {
        return Err(root_refusal(
            root_session_id,
            format!("exact Session ownership exceeds {MAX_AGENT_ORG_DELETE_SESSIONS} nodes"),
        ));
    }
    reject_unmapped_rust_workers(conn, root_session_id)?;

    worker_nodes.sort_by(|left, right| left.session_id.cmp(&right.session_id));
    let mut runs = run_rows
        .into_iter()
        .map(|(run_id, status)| {
            let mut worker_session_ids = workers_by_run.remove(&run_id).unwrap_or_default();
            worker_session_ids.sort();
            AgentOrgRunDeletePlan {
                run_id,
                status,
                worker_session_ids,
            }
        })
        .collect::<Vec<_>>();
    runs.sort_by(|left, right| left.run_id.cmp(&right.run_id));
    worker_nodes.push(AgentOrgSessionDeleteNode {
        session_id: root_session_id.to_string(),
        parent_session_id: root_parent_session_id,
        status: root_status,
        owning_run_id: None,
    });

    Ok(Some(AgentOrgSessionDeletePlan {
        root_session_id: root_session_id.to_string(),
        runs,
        sessions: worker_nodes,
    }))
}

fn load_root_runs(
    conn: &Connection,
    root_session_id: &str,
) -> Result<Vec<(String, AgentOrgRunStatus)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, status, org_snapshot_json
             FROM agent_org_runs
             WHERE root_session_id=?1
             ORDER BY id
             LIMIT ?2",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(
            params![root_session_id, (MAX_AGENT_ORG_DELETE_RUNS + 1) as i64],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .map_err(|err| err.to_string())?;
    let rows = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;
    if rows.len() > MAX_AGENT_ORG_DELETE_RUNS {
        return Err(root_refusal(
            root_session_id,
            format!("Run ownership exceeds {MAX_AGENT_ORG_DELETE_RUNS} rows"),
        ));
    }
    rows.into_iter()
        .map(|(run_id, status_raw, snapshot_json)| {
            if snapshot_json
                .as_deref()
                .map(run_snapshot_contains_cli)
                .transpose()?
                .unwrap_or(false)
            {
                return Err(run_refusal(&run_id, "CLI members are unsupported"));
            }
            let status = AgentOrgRunStatus::parse(&status_raw).ok_or_else(|| {
                run_refusal(&run_id, format!("unknown run status {status_raw:?}"))
            })?;
            Ok((run_id, status))
        })
        .collect()
}

fn run_snapshot_contains_cli(snapshot_json: &str) -> Result<bool, String> {
    fn members_contain_cli(members: &[OrgMember]) -> bool {
        members.iter().any(|member| {
            parse_cli_agent_org_reference(&member.agent_id).is_some()
                || members_contain_cli(&member.children)
        })
    }

    let snapshot: OrgDefinition = serde_json::from_str(snapshot_json)
        .map_err(|err| format!("invalid Agent Org launch snapshot: {err}"))?;
    Ok(parse_cli_agent_org_reference(&snapshot.agent_id).is_some()
        || members_contain_cli(&snapshot.children))
}

fn parse_session_status(session_id: &str, raw: &str) -> Result<SessionStatus, String> {
    SessionStatus::parse(raw).ok_or_else(|| {
        format!("Refusing to delete Agent Org: session {session_id} has unknown status {raw:?}")
    })
}

fn validate_descendant_shape(conn: &Connection, root_session_id: &str) -> Result<(), String> {
    let diagnostic = conn
        .query_row(
            "WITH RECURSIVE descendants(session_id, depth, path, cycle) AS (
                 SELECT session_id, 0, '/' || hex(session_id) || '/', 0
                 FROM agent_sessions
                 WHERE session_id=?1
                 UNION ALL
                 SELECT child.session_id,
                        parent.depth + 1,
                        parent.path || hex(child.session_id) || '/',
                        instr(parent.path, '/' || hex(child.session_id) || '/') > 0
                 FROM agent_sessions child
                 JOIN descendants parent ON child.parent_session_id=parent.session_id
                 WHERE parent.cycle=0 AND parent.depth < ?2
                 LIMIT ?2 + 1
             )
             SELECT descendant.session_id,
                    descendant.depth,
                    descendant.cycle,
                    (
                        SELECT nested.id
                        FROM agent_org_runs nested
                        WHERE nested.root_session_id=descendant.session_id
                          AND descendant.session_id<>?1
                        ORDER BY nested.id
                        LIMIT 1
                    ),
                    EXISTS(
                        SELECT 1 FROM agent_sessions child
                        WHERE child.parent_session_id=descendant.session_id
                    ),
                    (SELECT COUNT(*) FROM descendants) > ?2
             FROM descendants descendant
             WHERE descendant.cycle=1
                OR descendant.depth>=?2
                OR EXISTS(
                    SELECT 1 FROM agent_org_runs nested
                    WHERE nested.root_session_id=descendant.session_id
                      AND descendant.session_id<>?1
                )
                OR (SELECT COUNT(*) FROM descendants) > ?2
             ORDER BY descendant.depth, descendant.session_id
             LIMIT 1",
            params![root_session_id, MAX_AGENT_ORG_DELETE_SESSIONS as i64],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, bool>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, bool>(4)?,
                    row.get::<_, bool>(5)?,
                ))
            },
        )
        .optional()
        .map_err(|err| err.to_string())?;
    if let Some((session_id, depth, cycle, nested_run_id, has_children, overflow)) = diagnostic {
        if overflow {
            return Err(root_refusal(
                root_session_id,
                "descendant diagnostics exceed the bounded limit",
            ));
        }
        if cycle {
            return Err(root_refusal(
                root_session_id,
                format!("descendant ancestry contains a cycle at {session_id}"),
            ));
        }
        if let Some(nested_run_id) = nested_run_id {
            return Err(root_refusal(
                root_session_id,
                format!(
                    "descendant session {session_id} owns unsupported nested run {nested_run_id}"
                ),
            ));
        }
        if depth >= MAX_AGENT_ORG_DELETE_SESSIONS as i64 && has_children {
            return Err(root_refusal(
                root_session_id,
                "descendant diagnostics exceed the bounded limit",
            ));
        }
    }
    Ok(())
}

fn reject_unmapped_rust_workers(conn: &Connection, root_session_id: &str) -> Result<(), String> {
    let unmapped_worker: Option<String> = conn
        .query_row(
            "WITH RECURSIVE descendants(session_id, depth) AS (
                 SELECT session_id, 1
                 FROM agent_sessions
                 WHERE parent_session_id=?1
                 UNION ALL
                 SELECT child.session_id, parent.depth + 1
                 FROM agent_sessions child
                 JOIN descendants parent ON child.parent_session_id=parent.session_id
                 WHERE parent.depth < ?3
                 LIMIT ?3 + 1
             )
             SELECT child.session_id
             FROM descendants descendant
             JOIN agent_sessions child ON child.session_id=descendant.session_id
             WHERE (
                    child.session_type=?2
                    OR (
                        child.org_member_id IS NOT NULL
                        AND child.org_member_id<>?4
                        AND child.agent_definition_id IS NOT NULL
                    )
               )
               AND NOT EXISTS (
                   SELECT 1
                   FROM agent_org_run_sessions mapping
                   JOIN agent_org_runs run ON run.id=mapping.org_run_id
                   WHERE mapping.session_id=child.session_id
                     AND mapping.role='worker'
                     AND run.root_session_id=?1
               )
             ORDER BY child.session_id
             LIMIT 1",
            params![
                root_session_id,
                session_type::ORG_MEMBER,
                MAX_AGENT_ORG_DELETE_SESSIONS as i64,
                COORDINATOR_MEMBER_ID,
            ],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| err.to_string())?;
    if let Some(session_id) = unmapped_worker {
        return Err(root_refusal(
            root_session_id,
            format!("Rust Worker session {session_id} has no exact Run ownership"),
        ));
    }
    Ok(())
}

fn reject_historical_cli_descendants(
    conn: &Connection,
    root_session_id: &str,
) -> Result<(), String> {
    let cli_session_id = conn
        .query_row(
            "SELECT cli.session_id
             FROM code_sessions cli
             WHERE cli.parent_session_id=?1
                OR EXISTS (
                    SELECT 1
                    FROM agent_org_run_sessions mapping
                    JOIN agent_org_runs run ON run.id=mapping.org_run_id
                    WHERE run.root_session_id=?1
                      AND mapping.role='worker'
                      AND mapping.session_id=cli.parent_session_id
                )
             ORDER BY cli.session_id
             LIMIT 1",
            [root_session_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|err| err.to_string())?;
    if let Some(cli_session_id) = cli_session_id {
        return Err(root_refusal(
            root_session_id,
            format!("unsupported historical CLI session {cli_session_id} is attached"),
        ));
    }
    Ok(())
}

pub(super) fn agent_org_delete_topology_matches(
    expected: &AgentOrgSessionDeletePlan,
    current: &AgentOrgSessionDeletePlan,
) -> bool {
    expected.root_session_id == current.root_session_id
        && expected.runs.len() == current.runs.len()
        && expected
            .runs
            .iter()
            .zip(&current.runs)
            .all(|(left, right)| {
                left.run_id == right.run_id && left.worker_session_ids == right.worker_session_ids
            })
        && expected.sessions.len() == current.sessions.len()
        && expected
            .sessions
            .iter()
            .zip(&current.sessions)
            .all(|(left, right)| {
                left.session_id == right.session_id
                    && left.parent_session_id == right.parent_session_id
                    && left.owning_run_id == right.owning_run_id
            })
}

pub(super) fn validate_agent_org_delete_ready(
    plan: &AgentOrgSessionDeletePlan,
    safe_inflight_session_ids: &HashSet<String>,
) -> Result<(), String> {
    for run in &plan.runs {
        if !run.status.is_terminal() {
            return Err(format!(
                "Refusing to delete Agent Org run {}: run status is {}",
                run.run_id,
                run.status.as_str()
            ));
        }
    }
    for node in &plan.sessions {
        let allowed = node.status == SessionStatus::Idle
            || node.status.is_terminal()
            || matches!(node.status, SessionStatus::Pending | SessionStatus::Paused)
            || (node.status.is_in_flight() && safe_inflight_session_ids.contains(&node.session_id));
        if !allowed {
            return Err(format!(
                "Refusing to delete Agent Org root {}: session {} status is {}",
                plan.root_session_id,
                node.session_id,
                node.status.as_str()
            ));
        }
    }
    Ok(())
}

async fn agent_org_runtime_sessions(
    state: &AgentAppState,
    plan: &AgentOrgSessionDeletePlan,
) -> Vec<(String, Arc<AgentSession>)> {
    let sessions = state.sessions.lock().await;
    plan.sessions
        .iter()
        .filter_map(|node| {
            sessions
                .get(&node.session_id)
                .cloned()
                .map(|session| (node.session_id.clone(), session))
        })
        .collect()
}

async fn agent_org_runtime_blockers(
    plan: &AgentOrgSessionDeletePlan,
    runtime_sessions: &[(String, Arc<AgentSession>)],
) -> Vec<String> {
    let mut blockers = Vec::new();
    for node in &plan.sessions {
        if agent_org_submission_in_progress(&node.session_id) {
            blockers.push(format!("{}(submission_in_progress=true)", node.session_id));
        }
    }
    for (session_id, session) in runtime_sessions {
        let scheduler_processing = session.scheduler.is_processing();
        let pending_count = session.scheduler.pending_count();
        let active_turn = session.active_turn.lock().await.is_some();
        if active_turn || scheduler_processing || pending_count > 0 {
            blockers.push(format!(
                "{session_id}(active_turn={active_turn},scheduler_processing={scheduler_processing},pending={pending_count})"
            ));
        }
    }
    blockers
}

fn blocker_summary(blockers: &[String]) -> String {
    const MAX_SAMPLES: usize = 8;
    let mut summary = blockers
        .iter()
        .take(MAX_SAMPLES)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    if blockers.len() > MAX_SAMPLES {
        summary.push_str(&format!(", … {} more", blockers.len() - MAX_SAMPLES));
    }
    summary
}

async fn stop_agent_org_runtime_sessions(
    state: &AgentAppState,
    plan: &AgentOrgSessionDeletePlan,
) -> Result<HashSet<String>, String> {
    stop_agent_org_runtime_sessions_with_timeout(state, plan, AGENT_ORG_DELETE_STOP_TIMEOUT).await
}

pub(super) async fn stop_agent_org_runtime_sessions_with_timeout(
    state: &AgentAppState,
    plan: &AgentOrgSessionDeletePlan,
    timeout: Duration,
) -> Result<HashSet<String>, String> {
    let deadline = tokio::time::Instant::now() + timeout;
    let mut delete_cancelled_runtimes = HashMap::<String, Arc<AgentSession>>::new();
    loop {
        // A stale submission may have crossed its pre-init check before the
        // fence. Re-snapshot on every pass so a late runtime is cancelled and
        // observed rather than escaping the initial registry snapshot.
        let runtime_sessions = agent_org_runtime_sessions(state, plan).await;
        for (session_id, session) in &runtime_sessions {
            // Resume may have committed immediately before the fence and can
            // still clear the in-memory flag afterwards. A true flag alone is
            // not enough: OrgPause uses the same flag without discarding
            // queued work. Apply the delete reason once per runtime instance,
            // and re-apply it if that instance later clears the flag.
            let needs_delete_cancel =
                delete_cancelled_runtimes
                    .get(session_id)
                    .is_none_or(|previous| {
                        !Arc::ptr_eq(previous, session)
                            || !session.cancel_flag.load(Ordering::SeqCst)
                    });
            if needs_delete_cancel {
                session
                    .cancel_active_turn(CancelReason::AgentOrgDelete)
                    .await;
                delete_cancelled_runtimes.insert(session_id.clone(), Arc::clone(session));
            }
        }
        let blockers = agent_org_runtime_blockers(plan, &runtime_sessions).await;
        if blockers.is_empty() {
            // Once the durable fence exists, the guarded create/wake/recovery
            // paths cannot register a replacement runtime. Rows with no
            // in-memory runtime are therefore safe after a process restart.
            return Ok(plan.session_ids());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(format!(
                "Timed out stopping Agent Org root {} before deletion: {}",
                plan.root_session_id,
                blocker_summary(&blockers)
            ));
        }
        tokio::time::sleep(AGENT_ORG_DELETE_STOP_POLL_INTERVAL).await;
    }
}

async fn ensure_agent_org_runtime_sessions_idle(
    state: &AgentAppState,
    plan: &AgentOrgSessionDeletePlan,
) -> Result<(), String> {
    let runtime_sessions = agent_org_runtime_sessions(state, plan).await;
    let blockers = agent_org_runtime_blockers(plan, &runtime_sessions).await;
    if blockers.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Refusing to delete Agent Org root {}: active Rust runtime sessions: {}",
            plan.root_session_id,
            blocker_summary(&blockers)
        ))
    }
}

#[cfg(test)]
pub(super) fn delete_agent_org_session_hierarchy(
    expected_plan: &AgentOrgSessionDeletePlan,
    safe_inflight_session_ids: &HashSet<String>,
) -> Result<DeleteSessionReceipt, String> {
    let committed_delete =
        commit_agent_org_session_hierarchy(expected_plan, safe_inflight_session_ids)?;
    finish_agent_org_post_commit_resources(
        committed_delete.run_cleanup,
        committed_delete.session_cleanup,
    );
    Ok(committed_delete.receipt)
}

fn commit_agent_org_session_hierarchy(
    expected_plan: &AgentOrgSessionDeletePlan,
    safe_inflight_session_ids: &HashSet<String>,
) -> Result<AgentOrgCommittedDelete, String> {
    preflight_agent_org_delete_resources(expected_plan)?;
    let (run_outcomes, deleted_session_ids, post_commit_cleanup, committed_delete) =
        with_sessions_writer(|| {
            let mut conn = get_connection().map_err(|err| err.to_string())?;
            let tx = conn
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .map_err(|err| err.to_string())?;
            let current_plan = match load_agent_org_session_delete_plan(
                &tx,
                &expected_plan.root_session_id,
            )? {
                Some(plan) => plan,
                None => {
                    let receipt = completed_agent_org_delete_receipt(&tx, expected_plan)?
                    .ok_or_else(|| {
                        format!(
                            "Refusing to delete Agent Org root {}: ownership changed before deletion",
                            expected_plan.root_session_id
                        )
                    })?;
                    tx.commit().map_err(|err| err.to_string())?;
                    return Ok::<_, String>((
                        Vec::new(),
                        receipt.deleted_session_ids,
                        Vec::new(),
                        false,
                    ));
                }
            };
            if !agent_org_delete_topology_matches(expected_plan, &current_plan) {
                return Err(format!(
                    "Refusing to delete Agent Org root {}: ownership changed before deletion",
                    expected_plan.root_session_id
                ));
            }
            validate_agent_org_delete_ready(&current_plan, safe_inflight_session_ids)?;
            if let Some(node) = current_plan
                .sessions
                .iter()
                .find(|node| agent_org_submission_in_progress(&node.session_id))
            {
                return Err(format!(
                "Refusing to delete Agent Org root {}: session {} submission is still initializing",
                current_plan.root_session_id, node.session_id
            ));
            }

            let mut post_commit_cleanup = Vec::with_capacity(current_plan.sessions.len());
            for node in &current_plan.sessions {
                let (workspace_path, base_branch): (Option<String>, Option<String>) = tx
                    .query_row(
                        "SELECT workspace_path, base_branch
                     FROM agent_sessions
                     WHERE session_id=?1",
                        [&node.session_id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .map_err(|err| {
                        format!("load cleanup context for {}: {err}", node.session_id)
                    })?;
                post_commit_cleanup.push(AgentOrgSessionPostCommitCleanup {
                    session_id: node.session_id.clone(),
                    workspace_path: workspace_path.map(PathBuf::from),
                    managed_worktree: base_branch.is_some(),
                });
                for table in SESSION_STATE_TABLES {
                    tx.execute(
                        &format!("DELETE FROM {table} WHERE session_id=?1"),
                        [&node.session_id],
                    )
                    .map_err(|err| {
                        format!("delete {table} for session {}: {err}", node.session_id)
                    })?;
                }
                tx.execute(
                    "DELETE FROM session_turn_intents WHERE session_id=?1",
                    [&node.session_id],
                )
                .map_err(|err| {
                    format!("delete Turn Intents for session {}: {err}", node.session_id)
                })?;
                session_persistence::delete_session_with_connection(&tx, &node.session_id)
                    .map_err(|err| format!("delete session {}: {err}", node.session_id))?;
            }

            let mut outcomes = Vec::with_capacity(current_plan.runs.len());
            for run in &current_plan.runs {
                let outcome = AgentOrgRunStore::delete_by_id_with_connection(&tx, &run.run_id)?;
                if !outcome.deleted() {
                    return Err(format!(
                    "Refusing to commit Agent Org run {} deletion: run row disappeared during deletion",
                    run.run_id
                ));
                }
                outcomes.push((run.run_id.clone(), outcome));
            }
            if !remove_conversation_delete_fence_with_connection(
                &tx,
                &current_plan.root_session_id,
            )? {
                return Err(format!(
                    "Refusing to commit Agent Org root {} deletion: deletion fence disappeared",
                    current_plan.root_session_id
                ));
            }
            ensure_agent_org_sessions_absent(&tx, &current_plan)?;
            let deleted_session_ids = current_plan
                .sessions
                .iter()
                .map(|node| node.session_id.clone())
                .collect::<Vec<_>>();
            tx.commit().map_err(|err| err.to_string())?;
            Ok::<_, String>((outcomes, deleted_session_ids, post_commit_cleanup, true))
        })?;

    Ok(AgentOrgCommittedDelete {
        receipt: DeleteSessionReceipt {
            deleted_session_ids,
        },
        run_cleanup: if committed_delete {
            run_outcomes
        } else {
            Vec::new()
        },
        session_cleanup: post_commit_cleanup,
    })
}

fn finish_agent_org_post_commit_resources(
    run_cleanup: Vec<(String, AgentOrgRunDeleteOutcome)>,
    session_cleanup: Vec<AgentOrgSessionPostCommitCleanup>,
) {
    for (run_id, outcome) in run_cleanup {
        AgentOrgRunStore::finish_delete(&run_id, outcome);
    }
    for cleanup in session_cleanup {
        session_persistence::finish_session_delete(&cleanup.session_id);
        cleanup_agent_org_scratchpad(&cleanup.session_id);
        if cleanup.managed_worktree {
            if let Some(workspace_path) = cleanup.workspace_path {
                if let Err(error) = git::worktree::remove_session_worktree(
                    &workspace_path,
                    &cleanup.session_id,
                    true,
                ) {
                    tracing::warn!(
                        session_id = %cleanup.session_id,
                        error = %error,
                        "Agent Org Session committed deleted, but managed worktree cleanup failed"
                    );
                }
            }
        }
    }
}

fn cleanup_agent_org_scratchpad(session_id: &str) {
    app_paths::cleanup_scratchpad_by_session_id(session_id);
    let root = app_paths::orgii_temp_root();
    if !root.exists() {
        return;
    }
    let entries = match std::fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(error) => {
            tracing::warn!(session_id, %error, "Agent Org scratchpad cleanup could not be verified");
            return;
        }
    };
    for entry in entries.flatten() {
        let is_dir = entry.file_type().is_ok_and(|file_type| file_type.is_dir());
        let session_dir = entry.path().join(session_id);
        if is_dir && session_dir.exists() {
            tracing::warn!(
                session_id,
                path = %session_dir.display(),
                "Agent Org Session committed deleted, but scratchpad cleanup failed"
            );
        }
    }
}

fn ensure_agent_org_sessions_absent(
    conn: &Connection,
    plan: &AgentOrgSessionDeletePlan,
) -> Result<(), String> {
    for node in &plan.sessions {
        let exists = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM agent_sessions WHERE session_id=?1)",
                [&node.session_id],
                |row| row.get::<_, bool>(0),
            )
            .map_err(|err| err.to_string())?;
        if exists {
            return Err(format!(
                "Refusing to commit Agent Org root {} deletion: residual session {}",
                plan.root_session_id, node.session_id
            ));
        }
    }
    Ok(())
}

impl AgentOrgSessionDeletePlan {
    fn session_ids(&self) -> HashSet<String> {
        self.sessions
            .iter()
            .map(|node| node.session_id.clone())
            .collect()
    }
}

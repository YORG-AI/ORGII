//! Durable Root deletion fencing and runtime-submission admission.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use parking_lot::RwLock;
use rusqlite::{params, Connection, OptionalExtension};

use database::db::{get_connection, with_sessions_writer};

use super::AgentOrgRunStatus;

pub(super) const CONVERSATION_DELETING_ERROR_CODE: &str = "conversation_deleting";

/// `Unknown` is resolved once from PR1's exact mapping. Fence state is never cached.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AgentOrgSubmissionScope {
    Unknown,
    Ordinary,
    Run { run_id: String },
}

const SCOPE_UNKNOWN: u8 = 0;
const SCOPE_ORDINARY: u8 = 1;
const SCOPE_RUN: u8 = 2;

/// Shared identity policy whose ordinary hot path is one atomic read.
pub(crate) struct AgentOrgSubmissionPolicy {
    kind: AtomicU8,
    run_id: RwLock<Option<String>>,
    resolve_lock: tokio::sync::Mutex<()>,
}

impl AgentOrgSubmissionPolicy {
    pub(crate) fn new(scope: AgentOrgSubmissionScope) -> Self {
        let policy = Self {
            kind: AtomicU8::new(SCOPE_UNKNOWN),
            run_id: RwLock::new(None),
            resolve_lock: tokio::sync::Mutex::new(()),
        };
        policy.store(scope);
        policy
    }

    pub(crate) fn snapshot(&self) -> AgentOrgSubmissionScope {
        match self.kind.load(Ordering::Acquire) {
            SCOPE_ORDINARY => AgentOrgSubmissionScope::Ordinary,
            SCOPE_RUN => AgentOrgSubmissionScope::Run {
                run_id: self
                    .run_id
                    .read()
                    .clone()
                    .expect("Run scope requires Run id"),
            },
            _ => AgentOrgSubmissionScope::Unknown,
        }
    }

    pub(crate) fn store(&self, scope: AgentOrgSubmissionScope) {
        if self.kind.load(Ordering::Acquire) == SCOPE_RUN
            && !matches!(&scope, AgentOrgSubmissionScope::Run { .. })
        {
            return;
        }
        let (kind, run_id) = match scope {
            AgentOrgSubmissionScope::Unknown => (SCOPE_UNKNOWN, None),
            AgentOrgSubmissionScope::Ordinary => (SCOPE_ORDINARY, None),
            AgentOrgSubmissionScope::Run { run_id } => (SCOPE_RUN, Some(run_id)),
        };
        *self.run_id.write() = run_id;
        self.kind.store(kind, Ordering::Release);
    }
}

pub(crate) type SharedAgentOrgSubmissionScope = Arc<AgentOrgSubmissionPolicy>;

static ACTIVE_AGENT_ORG_SUBMISSIONS: OnceLock<Mutex<HashMap<String, usize>>> = OnceLock::new();

#[cfg(any(test, debug_assertions))]
static AGENT_ORG_SUBMISSION_QUERIES: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);
#[cfg(any(test, debug_assertions))]
static AGENT_ORG_LEASE_MUTATIONS: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

/// In-memory lifetime guard used only by known Agent Org sessions.
#[derive(Debug)]
pub(crate) struct AgentOrgSubmissionLease(String);

impl AgentOrgSubmissionLease {
    pub(crate) fn begin(session_id: &str) -> Self {
        let mut active = ACTIVE_AGENT_ORG_SUBMISSIONS
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *active.entry(session_id.to_string()).or_default() += 1;
        #[cfg(any(test, debug_assertions))]
        AGENT_ORG_LEASE_MUTATIONS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        Self(session_id.to_string())
    }
}

impl Drop for AgentOrgSubmissionLease {
    fn drop(&mut self) {
        let Some(active) = ACTIVE_AGENT_ORG_SUBMISSIONS.get() else {
            return;
        };
        let mut active = active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(count) = active.get_mut(&self.0) {
            *count -= 1;
            if *count == 0 {
                active.remove(&self.0);
            }
            #[cfg(any(test, debug_assertions))]
            AGENT_ORG_LEASE_MUTATIONS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
    }
}

pub(crate) fn agent_org_submission_in_progress(session_id: &str) -> bool {
    ACTIVE_AGENT_ORG_SUBMISSIONS
        .get()
        .and_then(|active| {
            active
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .get(session_id)
                .copied()
        })
        .unwrap_or_default()
        > 0
}

fn exact_submission_scope_with_connection(
    conn: &Connection,
    session_id: &str,
) -> Result<AgentOrgSubmissionScope, String> {
    #[cfg(any(test, debug_assertions))]
    AGENT_ORG_SUBMISSION_QUERIES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut stmt = conn
        .prepare(
            "SELECT mapping.org_run_id
             FROM agent_org_run_sessions mapping
             JOIN agent_org_runs run ON run.id=mapping.org_run_id
             WHERE mapping.session_id=?1
             ORDER BY mapping.org_run_id
             LIMIT 2",
        )
        .map_err(|err| err.to_string())?;
    let run_ids = stmt
        .query_map([session_id], |row| row.get::<_, String>(0))
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;
    match run_ids.as_slice() {
        [] => Ok(AgentOrgSubmissionScope::Ordinary),
        [run_id] => Ok(AgentOrgSubmissionScope::Run {
            run_id: run_id.clone(),
        }),
        _ => Err(format!(
            "Agent Org submission ownership is ambiguous for session {session_id}"
        )),
    }
}

pub(crate) fn exact_submission_scope(session_id: &str) -> Result<AgentOrgSubmissionScope, String> {
    let conn = get_connection().map_err(|err| err.to_string())?;
    exact_submission_scope_with_connection(&conn, session_id)
}

pub(crate) fn submission_scope_for_loaded_session(
    session: &crate::session::persistence::UnifiedSessionRecord,
) -> Result<AgentOrgSubmissionScope, String> {
    let is_agent_org = session.session_type
        == crate::session::persistence::session_type::ORG_MEMBER
        || session.org_member_id.is_some();
    if !is_agent_org {
        return Ok(AgentOrgSubmissionScope::Ordinary);
    }
    let conn = get_connection().map_err(|err| err.to_string())?;
    let scope = exact_submission_scope_with_connection(&conn, &session.session_id)?;
    if matches!(scope, AgentOrgSubmissionScope::Ordinary) {
        return Err(format!(
            "Agent Org session {} has no exact Run mapping",
            session.session_id
        ));
    }
    Ok(scope)
}

async fn ensure_submission_scope_writable(scope: &AgentOrgSubmissionScope) -> Result<(), String> {
    let AgentOrgSubmissionScope::Run { run_id } = scope else {
        return Ok(());
    };
    let run_id = run_id.clone();
    #[cfg(any(test, debug_assertions))]
    AGENT_ORG_SUBMISSION_QUERIES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    tokio::task::spawn_blocking(move || {
        let conn = get_connection().map_err(|err| err.to_string())?;
        ensure_run_conversation_writable_with_connection(&conn, &run_id)
    })
    .await
    .map_err(|err| format!("Agent Org submission fence worker failed: {err}"))?
}

/// Resolve transient unknown ownership once, then acquire a lease and read the
/// durable fence. The ordinary branch returns before either operation.
pub(crate) async fn admit_agent_org_submission(
    scope: &SharedAgentOrgSubmissionScope,
    session_id: &str,
) -> Result<Option<AgentOrgSubmissionLease>, String> {
    let mut resolved = scope.snapshot();
    if resolved == AgentOrgSubmissionScope::Unknown {
        let _resolver = scope.resolve_lock.lock().await;
        resolved = scope.snapshot();
        if resolved == AgentOrgSubmissionScope::Unknown {
            let session_id = session_id.to_string();
            resolved = tokio::task::spawn_blocking(move || {
                let conn = get_connection().map_err(|err| err.to_string())?;
                exact_submission_scope_with_connection(&conn, &session_id)
            })
            .await
            .map_err(|err| format!("Agent Org ownership worker failed: {err}"))??;
            scope.store(resolved.clone());
        }
    }
    if resolved == AgentOrgSubmissionScope::Ordinary {
        return Ok(None);
    }
    let lease = AgentOrgSubmissionLease::begin(session_id);
    ensure_submission_scope_writable(&resolved).await?;
    Ok(Some(lease))
}

pub(crate) async fn admit_known_agent_org_submission(
    session_id: &str,
    run_id: &str,
) -> Result<AgentOrgSubmissionLease, String> {
    let lease = AgentOrgSubmissionLease::begin(session_id);
    recheck_known_agent_org_submission(run_id).await?;
    Ok(lease)
}

pub(crate) async fn recheck_agent_org_submission(
    scope: &SharedAgentOrgSubmissionScope,
) -> Result<(), String> {
    ensure_submission_scope_writable(&scope.snapshot()).await
}

pub(crate) async fn recheck_known_agent_org_submission(run_id: &str) -> Result<(), String> {
    ensure_submission_scope_writable(&AgentOrgSubmissionScope::Run {
        run_id: run_id.to_string(),
    })
    .await
}

#[cfg(any(test, debug_assertions))]
pub fn reset_submission_metrics() {
    AGENT_ORG_SUBMISSION_QUERIES.store(0, std::sync::atomic::Ordering::Relaxed);
    AGENT_ORG_LEASE_MUTATIONS.store(0, std::sync::atomic::Ordering::Relaxed);
}

#[cfg(any(test, debug_assertions))]
pub fn submission_metrics() -> (usize, usize) {
    (
        AGENT_ORG_SUBMISSION_QUERIES.load(std::sync::atomic::Ordering::Relaxed),
        AGENT_ORG_LEASE_MUTATIONS.load(std::sync::atomic::Ordering::Relaxed),
    )
}

#[cfg(any(test, debug_assertions))]
pub(super) fn record_submission_query() {
    AGENT_ORG_SUBMISSION_QUERIES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
}

pub(super) fn is_conversation_deleting_with_connection(
    conn: &Connection,
    root_session_id: &str,
) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(
             SELECT 1
             FROM agent_org_conversation_delete_fences
             WHERE root_session_id=?1
         )",
        [root_session_id],
        |row| row.get(0),
    )
    .map_err(|err| err.to_string())
}

pub(crate) fn ensure_conversation_writable_with_connection(
    conn: &Connection,
    root_session_id: &str,
) -> Result<(), String> {
    if is_conversation_deleting_with_connection(conn, root_session_id)? {
        return Err(format!(
            "{CONVERSATION_DELETING_ERROR_CODE}: Agent Org root {root_session_id} is being deleted"
        ));
    }
    Ok(())
}

pub(crate) fn ensure_run_conversation_writable_with_connection(
    conn: &Connection,
    run_id: &str,
) -> Result<(), String> {
    let root_session_id = conn
        .query_row(
            "SELECT root_session_id FROM agent_org_runs WHERE id=?1",
            [run_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|err| err.to_string())?
        .flatten()
        .ok_or_else(|| format!("agent_org_run_not_found: run {run_id} has no Root"))?;
    ensure_conversation_writable_with_connection(conn, &root_session_id)
}

/// A Run is writable only while it is running and its root conversation is
/// not fenced. Callers that scanned earlier must repeat this check in the
/// transaction that performs their durable write.
pub(crate) fn is_run_writable_with_connection(
    conn: &Connection,
    run_id: &str,
) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(
             SELECT 1
             FROM agent_org_runs run
             WHERE run.id=?1
               AND run.status='running'
               AND run.root_session_id IS NOT NULL
               AND NOT EXISTS (
                   SELECT 1
                   FROM agent_org_conversation_delete_fences fence
                   WHERE fence.root_session_id=run.root_session_id
               )
         )",
        [run_id],
        |row| row.get(0),
    )
    .map_err(|err| err.to_string())
}

/// Establish the root fence and cancel every live Run in one caller-owned
/// SQLite transaction. `conn` may be a `Transaction` coerced to `Connection`.
pub(crate) fn establish_conversation_delete_fence_with_connection(
    conn: &Connection,
    root_session_id: &str,
) -> Result<Vec<String>, String> {
    let run_rows = {
        let mut stmt = conn
            .prepare(
                "SELECT id, status
                 FROM agent_org_runs
                 WHERE root_session_id=?1
                 ORDER BY id",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map([root_session_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|err| err.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())?
    };
    if run_rows.is_empty() {
        // A concurrent deletion may commit after this caller planned but
        // before it acquires the writer transaction. Do not recreate an
        // orphan fence for an already-removed conversation.
        return Ok(Vec::new());
    }

    let mut cancelled_run_ids = Vec::new();
    for (run_id, status_raw) in &run_rows {
        let status = AgentOrgRunStatus::parse(status_raw).ok_or_else(|| {
            format!("unknown Agent Org run status {status_raw:?} for run {run_id}")
        })?;
        if matches!(
            status,
            AgentOrgRunStatus::Starting | AgentOrgRunStatus::Running | AgentOrgRunStatus::Paused
        ) {
            cancelled_run_ids.push(run_id.clone());
        }
    }

    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO agent_org_conversation_delete_fences (
             root_session_id, created_at, updated_at
         ) VALUES (?1, ?2, ?2)
         ON CONFLICT(root_session_id) DO UPDATE SET updated_at=excluded.updated_at",
        params![root_session_id, &now],
    )
    .map_err(|err| err.to_string())?;
    conn.execute(
        "UPDATE agent_org_runs
         SET status='cancelled',
             updated_at=?2,
             completed_at=COALESCE(completed_at, ?2)
         WHERE root_session_id=?1
           AND status IN ('starting', 'running', 'paused')",
        params![root_session_id, &now],
    )
    .map_err(|err| err.to_string())?;
    conn.execute(
        "UPDATE agent_org_plan_approvals
         SET status='cancelled', decision_by='system', resolved_at=?2
         WHERE status='pending'
           AND org_run_id IN (
               SELECT id FROM agent_org_runs WHERE root_session_id=?1
           )",
        params![root_session_id, &now],
    )
    .map_err(|err| err.to_string())?;

    Ok(cancelled_run_ids)
}

/// Own the short, serialized transaction used to establish a deletion fence.
/// Callers that must compare topology inside the same snapshot should instead
/// use [`establish_conversation_delete_fence_with_connection`].
#[cfg(test)]
pub(crate) fn establish_conversation_delete_fence(root_session_id: &str) -> Result<(), String> {
    let root_session_id = root_session_id.to_string();
    let outcome = with_sessions_writer(|| -> Result<_, String> {
        let mut conn = get_connection().map_err(|err| err.to_string())?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|err| err.to_string())?;
        let outcome = establish_conversation_delete_fence_with_connection(&tx, &root_session_id)?;
        tx.commit().map_err(|err| err.to_string())?;
        Ok(outcome)
    })?;
    for run_id in &outcome {
        crate::coordination::agent_org_run_events::notify_agent_org_run_changed(run_id);
    }
    Ok(())
}

#[cfg(debug_assertions)]
pub fn debug_establish_e2e_conversation_delete_fence(root_session_id: &str) -> Result<(), String> {
    if !root_session_id.contains("e2e-agent-org-fixture:") {
        return Err("debug fence is restricted to disposable E2E fixtures".to_string());
    }
    let root_session_id = root_session_id.to_string();
    with_sessions_writer(|| {
        let mut conn = get_connection().map_err(|err| err.to_string())?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|err| err.to_string())?;
        establish_conversation_delete_fence_with_connection(&tx, &root_session_id)?;
        tx.commit().map_err(|err| err.to_string())
    })
}

pub(crate) fn remove_conversation_delete_fence_with_connection(
    conn: &Connection,
    root_session_id: &str,
) -> Result<bool, String> {
    conn.execute(
        "DELETE FROM agent_org_conversation_delete_fences WHERE root_session_id=?1",
        [root_session_id],
    )
    .map(|changed| changed > 0)
    .map_err(|err| err.to_string())
}

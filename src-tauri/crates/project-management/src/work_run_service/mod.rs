//! Durable Work Item Run application service.
//!
//! This module is the single persistence boundary for execution episodes and
//! dispatch delivery. Enqueue writes the Run and outbox row atomically;
//! workers claim with expiring leases; every acknowledgement checks the lease
//! token. Run terminal state never completes product intent; a successful Run
//! only projects the Work Item to `in_review` for explicit human acceptance.

use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use sha2::{Digest, Sha256};

use crate::projects::io::helpers::{conn, now_ms};
use crate::projects::types::{
    EnqueueWorkItemRunRequest, WorkItemDispatchLease, WorkItemRun, WorkItemRunFailure,
    WorkItemRunFailureClass, WorkItemRunRetryDisposition, WorkItemRunStatus, WorkItemRunTarget,
    WorkItemRunUsage, PERSONAL_ORG_ID,
};
use crate::work_service;

#[cfg(test)]
#[path = "tests.rs"]
mod tests;

pub mod error {
    pub const PREFIX: &str = "PM_RUN_ERR:";
    pub const INVALID_REQUEST: &str = "PM_RUN_ERR:INVALID_REQUEST";
    pub const NOT_FOUND: &str = "PM_RUN_ERR:NOT_FOUND";
    pub const IDEMPOTENCY_CONFLICT: &str = "PM_RUN_ERR:IDEMPOTENCY_CONFLICT";
    pub const STALE_LEASE: &str = "PM_RUN_ERR:STALE_LEASE";
    pub const INVALID_TRANSITION: &str = "PM_RUN_ERR:INVALID_TRANSITION";
    pub const RETRY_NOT_ALLOWED: &str = "PM_RUN_ERR:RETRY_NOT_ALLOWED";
    pub const PATH_LOCKED: &str = "PM_RUN_ERR:PATH_LOCKED";
}

const RUN_COLUMNS: &str = "id, project_slug, org_id, work_item_id, trigger_json,
    target_json, input_json, status, attempt, max_attempts, parent_run_id,
    session_id, failure_json, usage_json, idempotency_key, generation,
    created_at, updated_at, started_at, completed_at";
const DEFAULT_LEASE_MS: i64 = 30_000;
const MAX_LEASE_MS: i64 = 5 * 60_000;
const MAX_RUN_ATTEMPTS: u32 = 10;
const PATH_LOCK_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1_000;
const REVIEW_PROJECTION_SETTLED_OPERATION: &str = "work_run.review_projection_settled";

#[derive(Debug)]
struct WorkItemExecutionContext {
    org_id: String,
    revision: i64,
    title: String,
    body: String,
    project_description: Option<String>,
    linked_repositories: Vec<String>,
    configured_workspace_path: Option<String>,
    configured_workspace_mode: Option<crate::projects::types::WorkspaceExecutionMode>,
    agent_definition_id: Option<String>,
    agent_org_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkItemRunTerminalOutcome {
    Succeeded,
    Failed,
    Cancelled,
}

fn db<T>(result: rusqlite::Result<T>) -> Result<T, String> {
    result.map_err(|err| format!("work run store: {err}"))
}

fn iso8601(epoch_ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(epoch_ms)
        .map(|value| value.to_rfc3339())
        .unwrap_or_else(|| epoch_ms.to_string())
}

fn scope_key(project_slug: Option<&str>, org_id: &str) -> String {
    match project_slug {
        Some(slug) => format!("project:{slug}"),
        None => format!("org:{org_id}"),
    }
}

/// Session-plane org scopes may arrive as `cloud:<uuid>`, while the PM store
/// persists the local project-org id without that transport prefix. Unknown
/// scopes follow the same contract as standalone Work Item bootstrap and land
/// in the personal org rather than creating an unreadable split scope.
fn canonical_standalone_org_id(
    connection: &Connection,
    raw_org_id: &str,
) -> Result<String, String> {
    let bare = raw_org_id
        .trim()
        .strip_prefix("cloud:")
        .unwrap_or(raw_org_id.trim());
    if bare.is_empty() || bare == PERSONAL_ORG_ID {
        return Ok(PERSONAL_ORG_ID.to_string());
    }
    let exists = db(connection
        .query_row(
            "SELECT 1 FROM project_orgs WHERE id = ?1",
            params![bare],
            |_| Ok(()),
        )
        .optional())?
    .is_some();
    Ok(if exists {
        bare.to_string()
    } else {
        PERSONAL_ORG_ID.to_string()
    })
}

fn canonical_hash(request: &EnqueueWorkItemRunRequest) -> Result<String, String> {
    let json = serde_json::to_vec(request)
        .map_err(|err| format!("work run request serialization: {err}"))?;
    Ok(hex::encode(Sha256::digest(json)))
}

#[allow(clippy::type_complexity)]
fn query_stored_run(
    connection: &Connection,
    run_id: &str,
) -> Result<
    Option<(
        String,
        Option<String>,
        String,
        String,
        String,
        String,
        String,
        String,
        i64,
        i64,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        String,
        i64,
        i64,
        i64,
        Option<i64>,
        Option<i64>,
    )>,
    String,
> {
    let sql = format!("SELECT {RUN_COLUMNS} FROM pm_work_item_runs WHERE id = ?1");
    db(connection
        .query_row(&sql, params![run_id], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
                row.get(7)?,
                row.get(8)?,
                row.get(9)?,
                row.get(10)?,
                row.get(11)?,
                row.get(12)?,
                row.get(13)?,
                row.get(14)?,
                row.get(15)?,
                row.get(16)?,
                row.get(17)?,
                row.get(18)?,
                row.get(19)?,
            ))
        })
        .optional())
}

fn decode_run(connection: &Connection, run_id: &str) -> Result<Option<WorkItemRun>, String> {
    let Some((
        id,
        project_slug,
        org_id,
        work_item_id,
        trigger_json,
        target_json,
        input_json,
        status,
        attempt,
        max_attempts,
        parent_run_id,
        session_id,
        failure_json,
        usage_json,
        idempotency_key,
        generation,
        created_at,
        updated_at,
        started_at,
        completed_at,
    )) = query_stored_run(connection, run_id)?
    else {
        return Ok(None);
    };

    let trigger = serde_json::from_str(&trigger_json)
        .map_err(|err| format!("work run {id}: invalid trigger snapshot: {err}"))?;
    let target_snapshot = serde_json::from_str(&target_json)
        .map_err(|err| format!("work run {id}: invalid target snapshot: {err}"))?;
    let input = serde_json::from_str(&input_json)
        .map_err(|err| format!("work run {id}: invalid input snapshot: {err}"))?;
    let failure = failure_json
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(|err| format!("work run {id}: invalid failure snapshot: {err}"))?;
    let usage = usage_json
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(|err| format!("work run {id}: invalid usage snapshot: {err}"))?
        .unwrap_or_default();

    Ok(Some(WorkItemRun {
        id,
        project_slug,
        org_id,
        work_item_id,
        trigger,
        target_snapshot,
        input,
        status: WorkItemRunStatus::try_from(status.as_str())?,
        attempt: u32::try_from(attempt)
            .map_err(|_| format!("work run attempt out of range: {attempt}"))?,
        max_attempts: u32::try_from(max_attempts)
            .map_err(|_| format!("work run max_attempts out of range: {max_attempts}"))?,
        parent_run_id,
        session_id,
        failure,
        usage,
        idempotency_key,
        generation: u64::try_from(generation)
            .map_err(|_| format!("work run generation out of range: {generation}"))?,
        created_at: iso8601(created_at),
        updated_at: iso8601(updated_at),
        started_at: started_at.map(iso8601),
        completed_at: completed_at.map(iso8601),
    }))
}

fn require_run(connection: &Connection, run_id: &str) -> Result<WorkItemRun, String> {
    decode_run(connection, run_id)?.ok_or_else(|| format!("{}:{}", error::NOT_FOUND, run_id))
}

fn resolve_work_item_scope(
    tx: &Transaction<'_>,
    request: &EnqueueWorkItemRunRequest,
) -> Result<WorkItemExecutionContext, String> {
    match request.project_slug.as_deref() {
        Some(slug) if !slug.trim().is_empty() => db(tx
            .query_row(
                "SELECT p.org_id, w.local_version, w.title, w.body,
                        NULLIF(TRIM(p.description), ''), p.linked_repos_json,
                        json_extract(e.extras_json, '$.orchestrator_config.worktree_path'),
                        json_extract(e.extras_json, '$.orchestrator_config.workspace_mode'),
                        json_extract(e.extras_json, '$.orchestrator_config.agent_definition_id'),
                        json_extract(e.extras_json, '$.orchestrator_config.org_id')
                 FROM workitems w
                 JOIN projects p ON p.id = w.project_id
                 LEFT JOIN workitem_extras e ON e.work_item_id = w.id
                 WHERE p.slug = ?1 AND w.short_id = ?2 AND w.deleted_at IS NULL",
                params![slug, request.work_item_id],
                |row| {
                    let linked_json: String = row.get(5)?;
                    Ok(WorkItemExecutionContext {
                        org_id: row.get(0)?,
                        revision: row.get(1)?,
                        title: row.get(2)?,
                        body: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                        project_description: row.get(4)?,
                        linked_repositories: serde_json::from_str(&linked_json).unwrap_or_default(),
                        configured_workspace_path: row.get(6)?,
                        configured_workspace_mode: row.get::<_, Option<String>>(7)?.and_then(
                            |value| serde_json::from_value(serde_json::Value::String(value)).ok(),
                        ),
                        agent_definition_id: row.get(8)?,
                        agent_org_id: row.get(9)?,
                    })
                },
            )
            .optional())?
        .ok_or_else(|| {
            format!(
                "{}:work item {}/{} not found",
                error::INVALID_REQUEST,
                slug,
                request.work_item_id
            )
        }),
        Some(_) => Err(format!(
            "{}:project_slug cannot be blank",
            error::INVALID_REQUEST
        )),
        None => {
            let org_id = canonical_standalone_org_id(tx, &request.org_id)?;
            db(tx
                .query_row(
                    "SELECT w.org_id, w.local_version, w.title, w.body,
                        json_extract(e.extras_json, '$.orchestrator_config.worktree_path'),
                        json_extract(e.extras_json, '$.orchestrator_config.workspace_mode'),
                        json_extract(e.extras_json, '$.orchestrator_config.agent_definition_id'),
                        json_extract(e.extras_json, '$.orchestrator_config.org_id')
                 FROM workitems w
                 LEFT JOIN workitem_extras e ON e.work_item_id = w.id
                 WHERE w.project_id IS NULL AND w.org_id = ?1 AND w.short_id = ?2
                   AND w.deleted_at IS NULL",
                    params![org_id, request.work_item_id],
                    |row| {
                        Ok(WorkItemExecutionContext {
                            org_id: row.get(0)?,
                            revision: row.get(1)?,
                            title: row.get(2)?,
                            body: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                            project_description: None,
                            linked_repositories: Vec::new(),
                            configured_workspace_path: row.get(4)?,
                            configured_workspace_mode: row.get::<_, Option<String>>(5)?.and_then(
                                |value| {
                                    serde_json::from_value(serde_json::Value::String(value)).ok()
                                },
                            ),
                            agent_definition_id: row.get(6)?,
                            agent_org_id: row.get(7)?,
                        })
                    },
                )
                .optional())?
            .ok_or_else(|| {
                format!(
                    "{}:standalone work item {}/{} not found",
                    error::INVALID_REQUEST,
                    org_id,
                    request.work_item_id
                )
            })
        }
    }
}

fn git_value(workspace_path: &str, args: &[&str]) -> Option<String> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(workspace_path)
        .args(args)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8(output.stdout).ok()?.trim().to_string();
    (!value.is_empty()).then_some(value)
}

fn hydrate_target_snapshot(
    request: &mut EnqueueWorkItemRunRequest,
    context: WorkItemExecutionContext,
) {
    request.org_id = context.org_id;
    let snapshot = &mut request.target_snapshot;
    snapshot.work_item_revision = context.revision;
    snapshot.work_item_title = Some(context.title);
    snapshot.work_item_body = Some(context.body);
    snapshot.project_description = context.project_description;
    if snapshot.linked_repositories.is_empty() {
        snapshot.linked_repositories = context
            .linked_repositories
            .into_iter()
            .filter(|value| !value.trim().is_empty())
            .collect();
    }
    let has_configured_workspace = context
        .configured_workspace_path
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty());
    if snapshot.workspace_path.as_deref().is_none_or(str::is_empty) {
        snapshot.workspace_path = context
            .configured_workspace_path
            .filter(|value| !value.trim().is_empty())
            .or_else(|| snapshot.linked_repositories.first().cloned());
    }
    if snapshot.workspace_mode.is_none() {
        snapshot.workspace_mode = context.configured_workspace_mode.or_else(|| {
            // A path inherited from a project's linked repositories is the
            // primary checkout unless the Work Item explicitly says it is a
            // registered worktree.
            (!has_configured_workspace)
                .then_some(crate::projects::types::WorkspaceExecutionMode::LocalWorkspace)
        });
    }
    if let Some(workspace_path) = snapshot.workspace_path.as_mut() {
        if let Ok(canonical) = std::fs::canonicalize(&*workspace_path) {
            *workspace_path = canonical.to_string_lossy().into_owned();
        }
        snapshot.repository = git_value(workspace_path, &["remote", "get-url", "origin"])
            .or_else(|| Some(workspace_path.clone()));
        snapshot.repository_ref = git_value(workspace_path, &["rev-parse", "HEAD"]);
        snapshot.default_branch = git_value(
            workspace_path,
            &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        )
        .and_then(|value| {
            value
                .strip_prefix("origin/")
                .map(str::to_string)
                .or(Some(value))
        });
    }
    if snapshot.agent_definition_id.is_none() {
        snapshot.agent_definition_id = context.agent_definition_id;
    }
    if snapshot.agent_org_id.is_none() {
        snapshot.agent_org_id = context.agent_org_id;
    }
}

fn append_audit(
    tx: &Transaction<'_>,
    run_id: &str,
    operation: &str,
    revision: i64,
    project_slug: Option<&str>,
    org_id: &str,
    payload: serde_json::Value,
) -> Result<(), String> {
    let seq = work_service::audit::bump_change_seq(tx)?;
    work_service::audit::append_audit_event(
        tx,
        &work_service::audit::AuditEventRow {
            operation,
            entity_type: "work_item_run",
            entity_id: run_id,
            project_slug,
            org_id: Some(org_id),
            actor: None,
            revision,
            seq,
            payload,
        },
    )
}

/// Atomically create one Work Item Run and its first dispatch row.
///
/// Replaying the same idempotency key with an identical canonical request
/// returns the existing Run. Reusing the key with different content is a
/// typed conflict.
pub fn enqueue(request: EnqueueWorkItemRunRequest) -> Result<WorkItemRun, String> {
    enqueue_with_initial_delay(request, 0)
}

/// Persist a Run for a caller that will deliver it synchronously.
///
/// The outbox row is committed with a short future `available_at`, which
/// gives the caller time to claim this exact Run without racing the desktop
/// worker. If the process dies before that claim, the ordinary worker picks
/// it up after the delay, preserving crash recovery.
pub fn enqueue_for_inline_dispatch(
    request: EnqueueWorkItemRunRequest,
) -> Result<WorkItemRun, String> {
    enqueue_with_initial_delay(request, DEFAULT_LEASE_MS)
}

fn enqueue_with_initial_delay(
    request: EnqueueWorkItemRunRequest,
    initial_delay_ms: i64,
) -> Result<WorkItemRun, String> {
    let mut connection = conn()?;
    let tx = db(connection.transaction_with_behavior(TransactionBehavior::Immediate))?;
    let run = enqueue_in_transaction(&tx, request, initial_delay_ms)?;
    db(tx.commit())?;
    crate::projects::events::notify_work_item_dispatch_ready();
    Ok(run)
}

/// Internal composition point for producers that must commit domain state and
/// its execution dispatch atomically (for example, a Discussion comment).
/// The caller owns the surrounding `IMMEDIATE` transaction.
pub(crate) fn enqueue_in_transaction(
    tx: &Transaction<'_>,
    mut request: EnqueueWorkItemRunRequest,
    initial_delay_ms: i64,
) -> Result<WorkItemRun, String> {
    if request.work_item_id.trim().is_empty() || request.idempotency_key.trim().is_empty() {
        return Err(format!(
            "{}:work_item_id and idempotency_key are required",
            error::INVALID_REQUEST
        ));
    }
    if request.max_attempts == 0 || request.max_attempts > MAX_RUN_ATTEMPTS {
        return Err(format!(
            "{}:max_attempts must be between 1 and {MAX_RUN_ATTEMPTS}",
            error::INVALID_REQUEST
        ));
    }

    let execution_context = resolve_work_item_scope(tx, &request)?;
    hydrate_target_snapshot(&mut request, execution_context);
    let revision = request.target_snapshot.work_item_revision;

    let scope = scope_key(request.project_slug.as_deref(), &request.org_id);
    let request_hash = canonical_hash(&request)?;
    let existing: Option<(String, String)> = db(tx
        .query_row(
            "SELECT id, request_hash FROM pm_work_item_runs
             WHERE scope_key = ?1 AND work_item_id = ?2 AND idempotency_key = ?3",
            params![scope, request.work_item_id, request.idempotency_key],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional())?;
    if let Some((run_id, stored_hash)) = existing {
        if stored_hash != request_hash {
            return Err(format!(
                "{}:{}",
                error::IDEMPOTENCY_CONFLICT,
                request.idempotency_key
            ));
        }
        return require_run(tx, &run_id);
    }

    let attempt = if let Some(parent_run_id) = request.parent_run_id.as_deref() {
        let parent = require_run(tx, parent_run_id)?;
        if parent.project_slug != request.project_slug
            || parent.org_id != request.org_id
            || parent.work_item_id != request.work_item_id
        {
            return Err(format!(
                "{}:parent Run belongs to another Work Item",
                error::INVALID_REQUEST
            ));
        }
        parent.attempt.saturating_add(1)
    } else {
        1
    };
    if attempt > request.max_attempts {
        return Err(format!(
            "{}:attempt {attempt} exceeds max_attempts {}",
            error::RETRY_NOT_ALLOWED,
            request.max_attempts
        ));
    }

    let run_id = format!("wir_{}", uuid::Uuid::new_v4().simple());
    let dispatch_id = format!("wid_{}", uuid::Uuid::new_v4().simple());
    let now = now_ms();
    let available_at = now.saturating_add(initial_delay_ms.max(0));
    let trigger_json = serde_json::to_string(&request.trigger)
        .map_err(|err| format!("work run trigger serialization: {err}"))?;
    let target_json = serde_json::to_string(&request.target_snapshot)
        .map_err(|err| format!("work run target serialization: {err}"))?;
    let input_json = serde_json::to_string(&request.input)
        .map_err(|err| format!("work run input serialization: {err}"))?;
    let usage_json = serde_json::to_string(&WorkItemRunUsage::default())
        .map_err(|err| format!("work run usage serialization: {err}"))?;

    db(tx.execute(
        "INSERT INTO pm_work_item_runs (
            id, scope_key, project_slug, org_id, work_item_id,
            work_item_revision, trigger_kind, trigger_json, target_json,
            input_json, status, attempt, max_attempts, parent_run_id,
            session_id, failure_json, usage_json, idempotency_key,
            request_hash, generation, created_at, updated_at
         ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
            'queued', ?11, ?12, ?13, NULL, NULL, ?14, ?15, ?16, 1, ?17, ?17
         )",
        params![
            run_id,
            scope,
            request.project_slug,
            request.org_id,
            request.work_item_id,
            revision,
            request.trigger.kind(),
            trigger_json,
            target_json,
            input_json,
            attempt,
            request.max_attempts,
            request.parent_run_id,
            usage_json,
            request.idempotency_key,
            request_hash,
            now,
        ],
    ))?;
    db(tx.execute(
        "INSERT INTO pm_dispatch_outbox (
            id, run_id, generation, status, delivery_attempt, available_at,
            created_at, updated_at
         ) VALUES (?1, ?2, 1, 'pending', 0, ?3, ?4, ?4)",
        params![dispatch_id, run_id, available_at, now],
    ))?;
    append_audit(
        tx,
        &run_id,
        "work_run.enqueue",
        1,
        request.project_slug.as_deref(),
        &request.org_id,
        serde_json::json!({
            "workItemId": request.work_item_id,
            "trigger": request.trigger.kind(),
            "dispatchId": dispatch_id,
            "attempt": attempt,
        }),
    )?;
    require_run(tx, &run_id)
}

pub fn read(run_id: &str) -> Result<WorkItemRun, String> {
    let connection = conn()?;
    require_run(&connection, run_id)
}

/// List execution episodes whose dispatch already owns a Session but whose
/// Run has not reached a durable terminal state yet.
///
/// Startup recovery uses this projection after the Session store has marked
/// process-interrupted sessions as abandoned. Keeping the query in the Run
/// service preserves the package boundary: agent-core never reaches into PM
/// tables directly.
pub fn list_active_session_runs() -> Result<Vec<WorkItemRun>, String> {
    let connection = conn()?;
    let ids = {
        let mut statement = db(connection.prepare(
            "SELECT id FROM pm_work_item_runs
             WHERE session_id IS NOT NULL
               AND status IN ('dispatching', 'running', 'waiting')
             ORDER BY COALESCE(started_at, created_at) ASC, created_at ASC, id ASC",
        ))?;
        let rows = db(statement.query_map([], |row| row.get::<_, String>(0)))?;
        db(rows.collect::<rusqlite::Result<Vec<_>>>())?
    };
    ids.into_iter()
        .map(|run_id| require_run(&connection, &run_id))
        .collect()
}

pub fn list_for_work_item(
    project_slug: Option<&str>,
    org_id: &str,
    work_item_id: &str,
    limit: usize,
) -> Result<Vec<WorkItemRun>, String> {
    let connection = conn()?;
    let canonical_org_id = match project_slug {
        Some(slug) => db(connection
            .query_row(
                "SELECT org_id FROM projects WHERE slug = ?1",
                params![slug],
                |row| row.get::<_, String>(0),
            )
            .optional())?
        .unwrap_or_else(|| org_id.to_string()),
        None => canonical_standalone_org_id(&connection, org_id)?,
    };
    let scope = scope_key(project_slug, &canonical_org_id);
    let bounded_limit = limit.clamp(1, 200) as i64;
    let mut statement = db(connection.prepare(
        "SELECT id FROM pm_work_item_runs
         WHERE scope_key = ?1 AND work_item_id = ?2
         ORDER BY created_at DESC, id DESC LIMIT ?3",
    ))?;
    let ids = db(
        statement.query_map(params![scope, work_item_id, bounded_limit], |row| {
            row.get::<_, String>(0)
        }),
    )?;
    let mut runs = Vec::new();
    for id in ids {
        runs.push(require_run(&connection, &db(id)?)?);
    }
    Ok(runs)
}

/// Newest execution episode attached to a Session, regardless of terminal
/// state. Used to attribute automatic goal-loop continuations as follow-ups
/// without conflating them with a fresh manual start.
pub fn latest_for_session(session_id: &str) -> Result<Option<WorkItemRun>, String> {
    if session_id.trim().is_empty() {
        return Err(format!("{}:session_id is required", error::INVALID_REQUEST));
    }
    let connection = conn()?;
    let run_id: Option<String> = db(connection
        .query_row(
            "SELECT id FROM pm_work_item_runs
             WHERE session_id = ?1
             ORDER BY COALESCE(started_at, created_at) DESC, created_at DESC, id DESC
             LIMIT 1",
            params![session_id],
            |row| row.get(0),
        )
        .optional())?;
    run_id
        .map(|run_id| require_run(&connection, &run_id))
        .transpose()
}

/// Resolve the Routine that owns a Run, following typed retry ancestry.
///
/// Retry episodes intentionally keep `trigger = retry` for auditability, so
/// consumers that project execution back onto a Routine fire must consult the
/// immutable parent chain rather than treating the newest trigger as the
/// whole provenance record.
pub fn routine_origin(run_id: &str) -> Result<Option<(String, String)>, String> {
    let mut current_id = run_id.to_string();
    for _ in 0..=MAX_RUN_ATTEMPTS {
        let run = read(&current_id)?;
        if let crate::projects::types::WorkItemRunTrigger::Routine {
            routine_id,
            fire_id,
        } = run.trigger
        {
            return Ok(Some((routine_id, fire_id)));
        }
        let Some(parent_run_id) = run.parent_run_id else {
            return Ok(None);
        };
        current_id = parent_run_id;
    }
    Err(format!(
        "{}:{} has a retry ancestry deeper than {MAX_RUN_ATTEMPTS}",
        error::INVALID_REQUEST,
        run_id
    ))
}

/// Create a durable audit consumer cursor on first use and return its current
/// position. New consumers start at the caller-provided watermark so enabling
/// a feature does not replay an unbounded historical stream.
pub fn initialize_consumer_cursor(consumer_id: &str, initial_seq: i64) -> Result<i64, String> {
    if consumer_id.trim().is_empty() || initial_seq < 0 {
        return Err(format!(
            "{}:consumer_id and a non-negative initial_seq are required",
            error::INVALID_REQUEST
        ));
    }
    let connection = conn()?;
    let now = now_ms();
    db(connection.execute(
        "INSERT OR IGNORE INTO pm_event_consumers (consumer_id, last_seq, updated_at)
         VALUES (?1, ?2, ?3)",
        params![consumer_id, initial_seq, now],
    ))?;
    db(connection.query_row(
        "SELECT last_seq FROM pm_event_consumers WHERE consumer_id = ?1",
        params![consumer_id],
        |row| row.get(0),
    ))
}

/// Monotonically advance a durable audit consumer after all side effects for
/// the covered window have themselves become durable.
pub fn advance_consumer_cursor(consumer_id: &str, through_seq: i64) -> Result<i64, String> {
    if consumer_id.trim().is_empty() || through_seq < 0 {
        return Err(format!(
            "{}:consumer_id and a non-negative through_seq are required",
            error::INVALID_REQUEST
        ));
    }
    let connection = conn()?;
    let now = now_ms();
    let changed = db(connection.execute(
        "UPDATE pm_event_consumers
         SET last_seq = MAX(last_seq, ?2), updated_at = ?3
         WHERE consumer_id = ?1",
        params![consumer_id, through_seq, now],
    ))?;
    if changed != 1 {
        return Err(format!("{}:{consumer_id}", error::NOT_FOUND));
    }
    db(connection.query_row(
        "SELECT last_seq FROM pm_event_consumers WHERE consumer_id = ?1",
        params![consumer_id],
        |row| row.get(0),
    ))
}

fn acquire_path_lock(tx: &Transaction<'_>, run: &WorkItemRun, now: i64) -> Result<(), String> {
    if run.target_snapshot.allow_shared_checkout {
        return Ok(());
    }
    let Some(workspace_path) = run
        .target_snapshot
        .workspace_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(());
    };

    db(tx.execute(
        "DELETE FROM pm_work_item_path_locks WHERE lease_expires_at <= ?1",
        params![now],
    ))?;
    let expires_at = now.saturating_add(PATH_LOCK_TTL_MS);
    let changed = db(tx.execute(
        "INSERT INTO pm_work_item_path_locks (
             workspace_path, run_id, work_item_id, acquired_at,
             lease_expires_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?4)
         ON CONFLICT(workspace_path) DO UPDATE SET
             run_id = excluded.run_id,
             work_item_id = excluded.work_item_id,
             acquired_at = excluded.acquired_at,
             lease_expires_at = excluded.lease_expires_at,
             updated_at = excluded.updated_at
         WHERE pm_work_item_path_locks.run_id = excluded.run_id
            OR pm_work_item_path_locks.lease_expires_at <= excluded.acquired_at",
        params![workspace_path, run.id, run.work_item_id, now, expires_at],
    ))?;
    if changed == 0 {
        let owner: Option<(String, String)> = db(tx
            .query_row(
                "SELECT run_id, work_item_id FROM pm_work_item_path_locks
                 WHERE workspace_path = ?1",
                params![workspace_path],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional())?;
        let detail = owner
            .map(|(owner_run, owner_item)| format!("{owner_run}:{owner_item}"))
            .unwrap_or_else(|| "unknown".to_string());
        return Err(format!(
            "{}:{}:{}",
            error::PATH_LOCKED,
            workspace_path,
            detail
        ));
    }
    Ok(())
}

fn release_path_lock(tx: &Transaction<'_>, run_id: &str) -> Result<(), String> {
    db(tx.execute(
        "DELETE FROM pm_work_item_path_locks WHERE run_id = ?1",
        params![run_id],
    ))?;
    Ok(())
}

/// Lease the oldest ready dispatch. Expired leases are reclaimed by the same
/// query, so process death cannot strand a Run in `dispatching` forever.
pub fn claim_dispatch_for_run(
    run_id: &str,
    worker_id: &str,
    requested_lease_ms: i64,
) -> Result<WorkItemDispatchLease, String> {
    if run_id.trim().is_empty() || worker_id.trim().is_empty() {
        return Err(format!(
            "{}:run_id and worker_id are required",
            error::INVALID_REQUEST
        ));
    }
    let lease_ms = if requested_lease_ms <= 0 {
        DEFAULT_LEASE_MS
    } else {
        requested_lease_ms.min(MAX_LEASE_MS)
    };
    let mut connection = conn()?;
    let tx = db(connection.transaction_with_behavior(TransactionBehavior::Immediate))?;
    let now = now_ms();
    let candidate: Option<(String, i64)> = db(tx
        .query_row(
            "SELECT d.id, d.delivery_attempt
             FROM pm_dispatch_outbox d
             JOIN pm_work_item_runs r ON r.id = d.run_id
             WHERE d.run_id = ?1
               AND (
                   d.status IN ('pending', 'retry_wait')
                   OR (d.status = 'leased' AND d.lease_expires_at <= ?2)
               )
               AND r.status IN ('queued', 'deferred', 'dispatching')
             ORDER BY d.generation DESC
             LIMIT 1",
            params![run_id, now],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional())?;
    let Some((dispatch_id, previous_attempts)) = candidate else {
        return Err(format!(
            "{}:{run_id} has no claimable dispatch",
            error::INVALID_TRANSITION
        ));
    };
    let mut run = require_run(&tx, run_id)?;
    acquire_path_lock(&tx, &run, now)?;

    let lease_token = format!("lease_{}", uuid::Uuid::new_v4().simple());
    let lease_expires_at = now.saturating_add(lease_ms);
    let delivery_attempt = previous_attempts.saturating_add(1);
    db(tx.execute(
        "UPDATE pm_dispatch_outbox
         SET status = 'leased', delivery_attempt = ?2, lease_token = ?3,
             lease_owner = ?4, lease_expires_at = ?5, updated_at = ?1
         WHERE id = ?6",
        params![
            now,
            delivery_attempt,
            lease_token,
            worker_id,
            lease_expires_at,
            dispatch_id
        ],
    ))?;
    db(tx.execute(
        "UPDATE pm_work_item_runs
         SET status = 'dispatching', updated_at = ?2
         WHERE id = ?1 AND status IN ('queued', 'deferred', 'dispatching')",
        params![run_id, now],
    ))?;
    run.status = WorkItemRunStatus::Dispatching;
    run.updated_at = iso8601(now);
    append_audit(
        &tx,
        run_id,
        "work_run.dispatch_claimed",
        run.generation as i64,
        run.project_slug.as_deref(),
        &run.org_id,
        serde_json::json!({
            "dispatchId": dispatch_id,
            "workerId": worker_id,
            "deliveryAttempt": delivery_attempt,
            "leaseExpiresAt": lease_expires_at,
            "inline": true,
        }),
    )?;
    db(tx.commit())?;

    Ok(WorkItemDispatchLease {
        dispatch_id,
        lease_token,
        lease_owner: worker_id.to_string(),
        lease_expires_at: iso8601(lease_expires_at),
        delivery_attempt: u32::try_from(delivery_attempt)
            .map_err(|_| "dispatch delivery_attempt out of range".to_string())?,
        run,
    })
}

fn select_claimable_dispatch(
    connection: &Connection,
    now: i64,
) -> Result<Option<(String, String, i64)>, String> {
    db(connection
        .query_row(
            "SELECT d.id, d.run_id, d.delivery_attempt
             FROM pm_dispatch_outbox d
             JOIN pm_work_item_runs r ON r.id = d.run_id
             WHERE (
                 (d.status IN ('pending', 'retry_wait') AND d.available_at <= ?1)
                 OR (d.status = 'leased' AND d.lease_expires_at <= ?1)
               )
               AND r.status IN ('queued', 'deferred', 'dispatching')
               AND (
                   COALESCE(json_extract(r.target_json, '$.allowSharedCheckout'), 0) = 1
                   OR NULLIF(TRIM(json_extract(r.target_json, '$.workspacePath')), '') IS NULL
                   OR NOT EXISTS (
                       SELECT 1 FROM pm_work_item_path_locks path_lock
                        WHERE path_lock.workspace_path = json_extract(r.target_json, '$.workspacePath')
                          AND path_lock.run_id <> r.id
                          AND path_lock.lease_expires_at > ?1
                   )
               )
             ORDER BY d.available_at ASC, d.created_at ASC, d.id ASC
             LIMIT 1",
            params![now],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional())
}

/// Cheap read-only readiness probe used before entering an `IMMEDIATE`
/// transaction. An idle dispatcher therefore never takes SQLite's writer
/// reservation merely to discover an empty queue.
fn has_claimable_dispatch_on(connection: &Connection) -> Result<bool, String> {
    Ok(select_claimable_dispatch(connection, now_ms())?.is_some())
}

pub fn has_claimable_dispatch() -> Result<bool, String> {
    let connection = conn()?;
    has_claimable_dispatch_on(&connection)
}

/// Earliest persisted dispatch/lease deadline. The dispatcher sleeps until
/// this instant (bounded by its crash-recovery interval) and can still be
/// interrupted immediately by an in-process outbox commit or the
/// cross-process PM watermark.
pub fn next_dispatch_due_at_ms() -> Result<Option<i64>, String> {
    let connection = conn()?;
    db(connection.query_row(
        "SELECT MIN(
             CASE
               WHEN d.status IN ('pending', 'retry_wait') THEN d.available_at
               WHEN d.status = 'leased' THEN d.lease_expires_at
               ELSE NULL
             END
         )
         FROM pm_dispatch_outbox d
         JOIN pm_work_item_runs r ON r.id = d.run_id
         WHERE d.status IN ('pending', 'retry_wait', 'leased')
           AND r.status IN ('queued', 'deferred', 'dispatching')",
        [],
        |row| row.get(0),
    ))
}

/// Lease the oldest ready dispatch. Expired leases are reclaimed by the same
/// query, so process death cannot strand a Run in `dispatching` forever.
pub fn claim_next_dispatch(
    worker_id: &str,
    requested_lease_ms: i64,
) -> Result<Option<WorkItemDispatchLease>, String> {
    if worker_id.trim().is_empty() {
        return Err(format!("{}:worker_id is required", error::INVALID_REQUEST));
    }
    let lease_ms = if requested_lease_ms <= 0 {
        DEFAULT_LEASE_MS
    } else {
        requested_lease_ms.min(MAX_LEASE_MS)
    };
    let mut connection = conn()?;
    let tx = db(connection.transaction_with_behavior(TransactionBehavior::Immediate))?;
    let now = now_ms();
    let candidate = select_claimable_dispatch(&tx, now)?;
    let Some((dispatch_id, run_id, previous_attempts)) = candidate else {
        db(tx.commit())?;
        return Ok(None);
    };
    let mut run = require_run(&tx, &run_id)?;
    acquire_path_lock(&tx, &run, now)?;

    let lease_token = format!("lease_{}", uuid::Uuid::new_v4().simple());
    let lease_expires_at = now.saturating_add(lease_ms);
    let delivery_attempt = previous_attempts.saturating_add(1);
    db(tx.execute(
        "UPDATE pm_dispatch_outbox
         SET status = 'leased', delivery_attempt = ?2, lease_token = ?3,
             lease_owner = ?4, lease_expires_at = ?5, updated_at = ?1
         WHERE id = ?6",
        params![
            now,
            delivery_attempt,
            lease_token,
            worker_id,
            lease_expires_at,
            dispatch_id
        ],
    ))?;
    db(tx.execute(
        "UPDATE pm_work_item_runs
         SET status = 'dispatching', updated_at = ?2
         WHERE id = ?1 AND status IN ('queued', 'deferred', 'dispatching')",
        params![run_id, now],
    ))?;
    run.status = WorkItemRunStatus::Dispatching;
    run.updated_at = iso8601(now);
    append_audit(
        &tx,
        &run_id,
        "work_run.dispatch_claimed",
        run.generation as i64,
        run.project_slug.as_deref(),
        &run.org_id,
        serde_json::json!({
            "dispatchId": dispatch_id,
            "workerId": worker_id,
            "deliveryAttempt": delivery_attempt,
            "leaseExpiresAt": lease_expires_at,
        }),
    )?;
    db(tx.commit())?;

    Ok(Some(WorkItemDispatchLease {
        dispatch_id,
        lease_token,
        lease_owner: worker_id.to_string(),
        lease_expires_at: iso8601(lease_expires_at),
        delivery_attempt: u32::try_from(delivery_attempt)
            .map_err(|_| "dispatch delivery_attempt out of range".to_string())?,
        run,
    }))
}

fn leased_run_id(
    tx: &Transaction<'_>,
    dispatch_id: &str,
    lease_token: &str,
) -> Result<String, String> {
    db(tx
        .query_row(
            "SELECT run_id FROM pm_dispatch_outbox
             WHERE id = ?1 AND status = 'leased' AND lease_token = ?2",
            params![dispatch_id, lease_token],
            |row| row.get(0),
        )
        .optional())?
    .ok_or_else(|| format!("{}:{}", error::STALE_LEASE, dispatch_id))
}

/// Acknowledge that the runtime accepted the dispatch and materialized a
/// Session. This is a Run transition only; Work Item status is untouched.
pub fn acknowledge_dispatch_started(
    dispatch_id: &str,
    lease_token: &str,
    session_id: &str,
) -> Result<WorkItemRun, String> {
    if session_id.trim().is_empty() {
        return Err(format!("{}:session_id is required", error::INVALID_REQUEST));
    }
    let mut connection = conn()?;
    let tx = db(connection.transaction_with_behavior(TransactionBehavior::Immediate))?;
    let run_id = leased_run_id(&tx, dispatch_id, lease_token)?;
    let now = now_ms();
    db(tx.execute(
        "UPDATE pm_dispatch_outbox
         SET status = 'delivered', delivered_at = ?3, updated_at = ?3,
             lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL
         WHERE id = ?1 AND lease_token = ?2",
        params![dispatch_id, lease_token, now],
    ))?;
    let changed = db(tx.execute(
        "UPDATE pm_work_item_runs
         SET status = CASE WHEN status = 'dispatching' THEN 'running' ELSE status END,
             session_id = COALESCE(session_id, ?2),
             failure_json = CASE WHEN status = 'dispatching' THEN NULL ELSE failure_json END,
             started_at = COALESCE(started_at, ?3), updated_at = ?3
         WHERE id = ?1
           AND status IN ('dispatching', 'running', 'waiting', 'succeeded', 'failed', 'cancelled')
           AND (session_id IS NULL OR session_id = ?2)",
        params![run_id, session_id, now],
    ))?;
    if changed != 1 {
        return Err(format!(
            "{}:{} cannot acknowledge from current state",
            error::INVALID_TRANSITION,
            run_id
        ));
    }
    let run = require_run(&tx, &run_id)?;
    append_audit(
        &tx,
        &run_id,
        "work_run.started",
        run.generation as i64,
        run.project_slug.as_deref(),
        &run.org_id,
        serde_json::json!({
            "dispatchId": dispatch_id,
            "sessionId": session_id,
        }),
    )?;
    db(tx.commit())?;
    read(&run_id)
}

fn retry_delay_ms(delivery_attempt: i64) -> i64 {
    let exponent = delivery_attempt.saturating_sub(1).clamp(0, 6) as u32;
    (1_000_i64.saturating_mul(2_i64.saturating_pow(exponent))).min(60_000)
}

/// Convert an untyped runtime/provider error into a stable product category
/// and retry disposition. Matching is intentionally conservative: unknown,
/// auth, quota and configuration failures never auto-retry.
pub fn classify_failure(message: &str, has_session: bool) -> WorkItemRunFailure {
    let normalized = message.to_ascii_lowercase();
    let (class, code, retryable, retry_disposition) =
        if normalized.contains("cancelled") || normalized.contains("canceled") {
            (
                WorkItemRunFailureClass::Cancelled,
                "cancelled",
                false,
                WorkItemRunRetryDisposition::DoNotRetry,
            )
        } else if normalized.contains("context length")
            || normalized.contains("context window")
            || normalized.contains("too many tokens")
            || normalized.contains("maximum context")
        {
            (
                WorkItemRunFailureClass::ContextOverflow,
                "context_overflow",
                false,
                WorkItemRunRetryDisposition::ManualReview,
            )
        } else if normalized.contains("unauthorized")
            || normalized.contains("authentication")
            || normalized.contains("invalid api key")
            || normalized.contains("status 401")
        {
            (
                WorkItemRunFailureClass::Authentication,
                "authentication_failed",
                false,
                WorkItemRunRetryDisposition::DoNotRetry,
            )
        } else if normalized.contains("forbidden")
            || normalized.contains("permission denied")
            || normalized.contains("status 403")
        {
            (
                WorkItemRunFailureClass::Authorization,
                "authorization_failed",
                false,
                WorkItemRunRetryDisposition::DoNotRetry,
            )
        } else if normalized.contains("rate limit")
            || normalized.contains("quota")
            || normalized.contains("insufficient credit")
            || normalized.contains("status 429")
        {
            (
                WorkItemRunFailureClass::Quota,
                "quota_exhausted",
                false,
                WorkItemRunRetryDisposition::ManualReview,
            )
        } else if normalized.contains("timed out")
            || normalized.contains("timeout")
            || normalized.contains("deadline exceeded")
        {
            (
                WorkItemRunFailureClass::Timeout,
                "timeout",
                true,
                if has_session {
                    WorkItemRunRetryDisposition::ResumeSession
                } else {
                    WorkItemRunRetryDisposition::StartNewSession
                },
            )
        } else if normalized.contains("connection reset")
            || normalized.contains("connection refused")
            || normalized.contains("network")
            || normalized.contains("dns")
            || normalized.contains("tls")
        {
            (
                WorkItemRunFailureClass::TransientNetwork,
                "network_unavailable",
                true,
                if has_session {
                    WorkItemRunRetryDisposition::ResumeSession
                } else {
                    WorkItemRunRetryDisposition::StartNewSession
                },
            )
        } else if normalized.contains("status 502")
            || normalized.contains("status 503")
            || normalized.contains("status 504")
            || normalized.contains("provider unavailable")
            || normalized.contains("service unavailable")
        {
            (
                WorkItemRunFailureClass::ProviderUnavailable,
                "provider_unavailable",
                true,
                if has_session {
                    WorkItemRunRetryDisposition::ResumeSession
                } else {
                    WorkItemRunRetryDisposition::StartNewSession
                },
            )
        } else if normalized.contains("no selected")
            || normalized.contains("not configured")
            || normalized.contains("no host repo")
            || normalized.contains("missing configuration")
        {
            (
                WorkItemRunFailureClass::Configuration,
                "configuration_invalid",
                false,
                WorkItemRunRetryDisposition::DoNotRetry,
            )
        } else if normalized.contains("model not found")
            || normalized.contains("unknown model")
            || normalized.contains("unsupported model")
        {
            (
                WorkItemRunFailureClass::Model,
                "model_invalid",
                false,
                WorkItemRunRetryDisposition::ManualReview,
            )
        } else if normalized.contains("invalid request")
            || normalized.contains("invalid input")
            || normalized.contains("malformed")
        {
            (
                WorkItemRunFailureClass::InvalidInput,
                "invalid_input",
                false,
                WorkItemRunRetryDisposition::DoNotRetry,
            )
        } else if normalized.contains("runtime crashed")
            || normalized.contains("process exited")
            || normalized.contains("worker died")
        {
            (
                WorkItemRunFailureClass::Runtime,
                "runtime_failed",
                true,
                WorkItemRunRetryDisposition::StartNewSession,
            )
        } else {
            (
                WorkItemRunFailureClass::Unknown,
                "unknown",
                false,
                WorkItemRunRetryDisposition::ManualReview,
            )
        };
    WorkItemRunFailure {
        class,
        code: code.to_string(),
        message: message.to_string(),
        retryable,
        retry_disposition,
        occurred_at: chrono::Utc::now().to_rfc3339(),
    }
}

/// Nack a leased dispatch. Safe transient failures are delayed and retried;
/// permanent or exhausted failures move both dispatch and Run terminal.
pub fn record_dispatch_failure(
    dispatch_id: &str,
    lease_token: &str,
    message: &str,
) -> Result<WorkItemRun, String> {
    let mut connection = conn()?;
    let tx = db(connection.transaction_with_behavior(TransactionBehavior::Immediate))?;
    let run_id = leased_run_id(&tx, dispatch_id, lease_token)?;
    let run = require_run(&tx, &run_id)?;
    let delivery_attempt: i64 = db(tx.query_row(
        "SELECT delivery_attempt FROM pm_dispatch_outbox WHERE id = ?1",
        params![dispatch_id],
        |row| row.get(0),
    ))?;
    let failure = classify_failure(message, false);
    let failure_json = serde_json::to_string(&failure)
        .map_err(|err| format!("work run failure serialization: {err}"))?;
    let retry = failure.retryable && delivery_attempt < i64::from(run.max_attempts);
    let now = now_ms();

    if retry {
        let available_at = now.saturating_add(retry_delay_ms(delivery_attempt));
        db(tx.execute(
            "UPDATE pm_dispatch_outbox
             SET status = 'retry_wait', available_at = ?3,
                 lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL,
                 last_error_json = ?4, updated_at = ?5
             WHERE id = ?1 AND lease_token = ?2",
            params![dispatch_id, lease_token, available_at, failure_json, now],
        ))?;
        db(tx.execute(
            "UPDATE pm_work_item_runs
             SET status = 'deferred', failure_json = ?2, updated_at = ?3
             WHERE id = ?1 AND status = 'dispatching'",
            params![run_id, failure_json, now],
        ))?;
    } else {
        db(tx.execute(
            "UPDATE pm_dispatch_outbox
             SET status = 'dead_letter', lease_token = NULL, lease_owner = NULL,
                 lease_expires_at = NULL, last_error_json = ?3, updated_at = ?4
             WHERE id = ?1 AND lease_token = ?2",
            params![dispatch_id, lease_token, failure_json, now],
        ))?;
        db(tx.execute(
            "UPDATE pm_work_item_runs
             SET status = 'failed', failure_json = ?2, completed_at = ?3,
                 updated_at = ?3
             WHERE id = ?1 AND status = 'dispatching'",
            params![run_id, failure_json, now],
        ))?;
    }
    release_path_lock(&tx, &run_id)?;
    let updated = require_run(&tx, &run_id)?;
    append_audit(
        &tx,
        &run_id,
        if retry {
            "work_run.dispatch_deferred"
        } else {
            "work_run.dispatch_failed"
        },
        updated.generation as i64,
        updated.project_slug.as_deref(),
        &updated.org_id,
        serde_json::json!({
            "dispatchId": dispatch_id,
            "failure": failure,
            "deliveryAttempt": delivery_attempt,
            "willRetry": retry,
        }),
    )?;
    db(tx.commit())?;
    crate::projects::events::notify_work_item_dispatch_ready();
    let persisted = read(&run_id)?;
    if let Err(err) = crate::work_item_features::subscriptions::notify_run_terminal(&persisted) {
        tracing::warn!(run_id = %persisted.id, error = %err, "failed to project Run failure into Inbox");
    }
    Ok(persisted)
}

/// Reconcile a turn terminal into the exact owning Run.
///
/// `expected_session_id` guards against a stale completion from an earlier
/// Session being applied after a retry has attached the Run elsewhere. Run
/// finality is deliberately independent from Work Item completion.
pub fn record_run_terminal(
    run_id: &str,
    expected_session_id: Option<&str>,
    outcome: WorkItemRunTerminalOutcome,
    usage: WorkItemRunUsage,
    error_message: Option<&str>,
) -> Result<WorkItemRun, String> {
    let mut connection = conn()?;
    let tx = db(connection.transaction_with_behavior(TransactionBehavior::Immediate))?;
    let existing = require_run(&tx, run_id)?;
    if let Some(expected) = expected_session_id {
        if existing
            .session_id
            .as_deref()
            .is_some_and(|actual| actual != expected)
        {
            return Err(format!(
                "{}:{} expected session {}, found {}",
                error::INVALID_TRANSITION,
                run_id,
                expected,
                existing.session_id.as_deref().unwrap_or("none")
            ));
        }
    }
    if existing.status.is_terminal() {
        release_path_lock(&tx, run_id)?;
        db(tx.commit())?;
        crate::projects::events::notify_work_item_dispatch_ready();
        if existing.status == WorkItemRunStatus::Succeeded {
            match review_projection_is_settled(run_id) {
                Ok(false) => project_succeeded_run_for_review(&existing),
                Ok(true) => {}
                Err(error) => tracing::warn!(
                    run_id,
                    error = %error,
                    "failed to read Work Item review projection receipt"
                ),
            }
        }
        return Ok(existing);
    }

    let (status, failure) = match outcome {
        WorkItemRunTerminalOutcome::Succeeded => (WorkItemRunStatus::Succeeded, None),
        WorkItemRunTerminalOutcome::Failed => (
            WorkItemRunStatus::Failed,
            Some(classify_failure(
                error_message.unwrap_or("session failed without an error message"),
                true,
            )),
        ),
        WorkItemRunTerminalOutcome::Cancelled => (
            WorkItemRunStatus::Cancelled,
            Some(classify_failure(
                error_message.unwrap_or("session cancelled"),
                true,
            )),
        ),
    };
    let failure_json = failure
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|err| format!("work run failure serialization: {err}"))?;
    let usage_json = serde_json::to_string(&usage)
        .map_err(|err| format!("work run usage serialization: {err}"))?;
    let now = now_ms();
    db(tx.execute(
        "UPDATE pm_work_item_runs
         SET status = ?2, failure_json = ?3, usage_json = ?4,
             session_id = COALESCE(session_id, ?6),
             completed_at = ?5, updated_at = ?5
         WHERE id = ?1 AND status IN ('running', 'waiting', 'dispatching')",
        params![
            run_id,
            status.as_str(),
            failure_json,
            usage_json,
            now,
            expected_session_id
        ],
    ))?;
    release_path_lock(&tx, run_id)?;
    let updated = require_run(&tx, run_id)?;
    append_audit(
        &tx,
        run_id,
        "work_run.terminal",
        updated.generation as i64,
        updated.project_slug.as_deref(),
        &updated.org_id,
        serde_json::json!({
            "sessionId": expected_session_id.or(existing.session_id.as_deref()),
            "status": status.as_str(),
            "failure": failure,
            "usage": usage,
        }),
    )?;
    db(tx.commit())?;
    crate::projects::events::notify_work_item_dispatch_ready();
    let persisted = read(run_id)?;
    if persisted.status == WorkItemRunStatus::Succeeded {
        project_succeeded_run_for_review(&persisted);
    }
    if let Err(err) = crate::work_item_features::subscriptions::notify_run_terminal(&persisted) {
        tracing::warn!(run_id = %persisted.id, error = %err, "failed to project Run terminal into Inbox");
    }
    Ok(persisted)
}

fn project_succeeded_run_for_review(run: &WorkItemRun) {
    let projection = match work_service::project_run_success_to_review(
        run.project_slug.as_deref(),
        &run.org_id,
        &run.work_item_id,
        run.session_id.as_deref(),
    ) {
        Ok(projection) => projection,
        Err(error) => {
            // Run finality is authoritative and must not be rolled back when
            // its human-lifecycle projection temporarily fails. A repeated
            // terminal reconciliation can retry until a receipt is written.
            tracing::warn!(
                run_id = %run.id,
                work_item_id = %run.work_item_id,
                error = %error,
                "failed to move successful Work Item Run into review"
            );
            return;
        }
    };
    match projection {
        work_service::RunSuccessReviewProjection::Transitioned => {
            tracing::info!(
                run_id = %run.id,
                work_item_id = %run.work_item_id,
                "successful Work Item Run is awaiting review"
            );
        }
        work_service::RunSuccessReviewProjection::AlreadyInReview
        | work_service::RunSuccessReviewProjection::PreservedStatus
        | work_service::RunSuccessReviewProjection::Superseded => {}
    }

    if let Err(error) = mark_review_projection_settled(run, projection) {
        tracing::warn!(
            run_id = %run.id,
            error = %error,
            "failed to persist Work Item review projection receipt"
        );
    }
}

fn review_projection_is_settled(run_id: &str) -> Result<bool, String> {
    let connection = conn()?;
    Ok(db(connection
        .query_row(
            "SELECT 1 FROM pm_audit_events
             WHERE entity_type = 'work_item_run' AND entity_id = ?1 AND operation = ?2
             LIMIT 1",
            params![run_id, REVIEW_PROJECTION_SETTLED_OPERATION],
            |_| Ok(()),
        )
        .optional())?
    .is_some())
}

fn mark_review_projection_settled(
    run: &WorkItemRun,
    projection: work_service::RunSuccessReviewProjection,
) -> Result<(), String> {
    let mut connection = conn()?;
    let tx = db(connection.transaction_with_behavior(TransactionBehavior::Immediate))?;
    let exists = db(tx
        .query_row(
            "SELECT 1 FROM pm_audit_events
             WHERE entity_type = 'work_item_run' AND entity_id = ?1 AND operation = ?2
             LIMIT 1",
            params![&run.id, REVIEW_PROJECTION_SETTLED_OPERATION],
            |_| Ok(()),
        )
        .optional())?
    .is_some();
    if !exists {
        let outcome = match projection {
            work_service::RunSuccessReviewProjection::Transitioned => "transitioned",
            work_service::RunSuccessReviewProjection::AlreadyInReview => "already_in_review",
            work_service::RunSuccessReviewProjection::PreservedStatus => "preserved_status",
            work_service::RunSuccessReviewProjection::Superseded => "superseded",
        };
        append_audit(
            &tx,
            &run.id,
            REVIEW_PROJECTION_SETTLED_OPERATION,
            run.generation as i64,
            run.project_slug.as_deref(),
            &run.org_id,
            serde_json::json!({
                "workItemId": run.work_item_id,
                "outcome": outcome,
            }),
        )?;
    }
    db(tx.commit())
}

/// Compatibility lookup for legacy Session-terminal callers. Multiple Runs
/// may resume one Session, so only the newest non-terminal episode is chosen.
/// New code should use [`record_run_terminal`] with the durable turn intent id.
pub fn record_session_terminal(
    session_id: &str,
    outcome: WorkItemRunTerminalOutcome,
    usage: WorkItemRunUsage,
    error_message: Option<&str>,
) -> Result<Option<WorkItemRun>, String> {
    let connection = conn()?;
    let run_id: Option<String> = db(connection
        .query_row(
            "SELECT id FROM pm_work_item_runs
             WHERE session_id = ?1
               AND status IN ('dispatching', 'running', 'waiting')
             ORDER BY COALESCE(started_at, created_at) DESC, created_at DESC
             LIMIT 1",
            params![session_id],
            |row| row.get(0),
        )
        .optional())?;
    drop(connection);
    let Some(run_id) = run_id else {
        return Ok(None);
    };
    record_run_terminal(&run_id, Some(session_id), outcome, usage, error_message).map(Some)
}

pub fn mark_waiting(run_id: &str) -> Result<WorkItemRun, String> {
    let mut connection = conn()?;
    let tx = db(connection.transaction_with_behavior(TransactionBehavior::Immediate))?;
    let now = now_ms();
    let changed = db(tx.execute(
        "UPDATE pm_work_item_runs SET status = 'waiting', updated_at = ?2
         WHERE id = ?1 AND status = 'running'",
        params![run_id, now],
    ))?;
    if changed != 1 {
        return Err(format!(
            "{}:{} -> waiting",
            error::INVALID_TRANSITION,
            run_id
        ));
    }
    let run = require_run(&tx, run_id)?;
    append_audit(
        &tx,
        run_id,
        "work_run.waiting",
        run.generation as i64,
        run.project_slug.as_deref(),
        &run.org_id,
        serde_json::json!({}),
    )?;
    db(tx.commit())?;
    read(run_id)
}

/// Create the next execution episode from a failed Run according to the
/// typed failure policy. This never mutates or reopens the previous Run.
pub fn retry(run_id: &str, idempotency_key: &str) -> Result<WorkItemRun, String> {
    let previous = read(run_id)?;
    if previous.status != WorkItemRunStatus::Failed {
        return Err(format!(
            "{}:{} is not failed",
            error::RETRY_NOT_ALLOWED,
            run_id
        ));
    }
    let failure = previous.failure.as_ref().ok_or_else(|| {
        format!(
            "{}:{} has no typed failure",
            error::RETRY_NOT_ALLOWED,
            run_id
        )
    })?;
    if !failure.retryable {
        return Err(format!(
            "{}:{}:{}",
            error::RETRY_NOT_ALLOWED,
            run_id,
            failure.code
        ));
    }
    if previous.attempt >= previous.max_attempts {
        return Err(format!(
            "{}:{} exhausted attempt budget ({}/{})",
            error::RETRY_NOT_ALLOWED,
            run_id,
            previous.attempt,
            previous.max_attempts
        ));
    }

    let mut target_snapshot = previous.target_snapshot.clone();
    if failure.retry_disposition == WorkItemRunRetryDisposition::ResumeSession {
        let session_id = previous.session_id.clone().ok_or_else(|| {
            format!(
                "{}:{} requires a Session to resume",
                error::RETRY_NOT_ALLOWED,
                run_id
            )
        })?;
        target_snapshot.target = WorkItemRunTarget::ResumeSession { session_id };
    }
    enqueue(EnqueueWorkItemRunRequest {
        project_slug: previous.project_slug,
        org_id: previous.org_id,
        work_item_id: previous.work_item_id,
        trigger: crate::projects::types::WorkItemRunTrigger::Retry {
            previous_run_id: previous.id.clone(),
        },
        target_snapshot,
        input: previous.input,
        idempotency_key: idempotency_key.to_string(),
        max_attempts: previous.max_attempts,
        parent_run_id: Some(previous.id),
    })
}

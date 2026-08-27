use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
use sha2::{Digest, Sha256};

use crate::projects::io::helpers::{conn, now_ms};
use crate::projects::types::{EnqueueWorkItemRunRequest, WorkItemRun, WorkItemRunUsage};

use super::store::{append_audit, canonical_standalone_org_id, db, require_run, scope_key};
use super::{error, DEFAULT_LEASE_MS, MAX_RUN_ATTEMPTS};

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

fn canonical_hash(request: &EnqueueWorkItemRunRequest) -> Result<String, String> {
    let json = serde_json::to_vec(request)
        .map_err(|err| format!("work run request serialization: {err}"))?;
    Ok(hex::encode(Sha256::digest(json)))
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

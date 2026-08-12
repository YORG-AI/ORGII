//! Work application service (`orgtrack/v1` Phase 2a).
//!
//! Single business layer above the atomic store choke point. Every entry
//! point (Tauri commands, agent tools, the future PM CLI, schedulers,
//! sync adapters) is expected to mutate work items through here — not by
//! assembling `WorkItemFrontmatter` rows directly.
//!
//! What lands in 2a:
//! - the portable [`state::WorkItemState`] FSM with legacy-status mapping;
//! - append-only audit + `pm_change_seq` watermark on EVERY atomic
//!   mutation (wired inside `projects::io::work_items::atomic`);
//! - optimistic concurrency (`expected_revision` against `local_version`)
//!   and strict-FSM transitions via [`transition_project_work_item`].
//!
//! Error contract: typed sentinels with the `PM_ERR:` prefix
//! ([`error::REVISION_CONFLICT`], [`error::INVALID_TRANSITION`]) so the
//! Phase 3 CLI layer can map them onto the stable wire error codes
//! without string-guessing. Everything else is an opaque store error.

pub mod audit;
pub mod state;

#[cfg(test)]
#[path = "tests.rs"]
mod tests;

/// Shared seeding helpers for sibling service test modules.
#[cfg(test)]
pub mod tests_support {
    use crate::projects::io::write_project;
    use crate::projects::types::ProjectMeta;

    pub fn seed_project(slug: &str, id: &str) {
        let meta = ProjectMeta {
            id: id.to_string(),
            name: "Demo".to_string(),
            org_id: "personal-org".to_string(),
            status: "active".to_string(),
            priority: "none".to_string(),
            health: "no_updates".to_string(),
            lead: None,
            members: vec![],
            labels: vec![],
            linked_repos: vec![],
            start_date: None,
            target_date: None,
            created_at: String::new(),
            updated_at: String::new(),
            next_work_item_id: 1,
            work_item_prefix: "AAA".to_string(),
            work_item_prefix_custom: true,
            agent_defaults: None,
        };
        write_project(slug, &meta, "", true).expect("seed project");
    }
}

pub use state::WorkItemState;

use crate::projects::io as project_io;
use crate::projects::types::{
    LinkedSession, OrchestratorConfig, TodoEntry, WorkItemData, WorkItemFrontmatter,
    WorkItemHandoff, WorkItemMutationActor, WorkItemSchedule,
};

/// Result of projecting a successful execution episode onto the human-owned
/// Work Item lifecycle. A successful Run is ready for verification, not
/// automatically accepted as completed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunSuccessReviewProjection {
    Transitioned,
    AlreadyInReview,
    PreservedStatus,
    Superseded,
}

const RUN_REVIEW_ALREADY: &str = "PM_RUN_REVIEW:ALREADY_IN_REVIEW";
const RUN_REVIEW_PRESERVE: &str = "PM_RUN_REVIEW:PRESERVE_STATUS";
const RUN_REVIEW_SUPERSEDED: &str = "PM_RUN_REVIEW:SUPERSEDED";

fn apply_run_success_review_projection(
    frontmatter: &mut WorkItemFrontmatter,
    terminal_session_id: Option<&str>,
) -> Result<(), String> {
    if let Some(lock) = frontmatter.execution_lock.as_ref() {
        match (lock.active_session_id.as_deref(), terminal_session_id) {
            (Some(active), Some(terminal)) if active == terminal => {}
            // A newer Session or an Agent Org still owns execution. A stale
            // terminal must not move the Work Item out from under it.
            _ => return Err(RUN_REVIEW_SUPERSEDED.to_string()),
        }
    }

    match frontmatter.status.as_str() {
        "backlog" | "planned" | "in_progress" => {
            frontmatter.status = "in_review".to_string();
            frontmatter.execution_lock = None;
            frontmatter.updated_at = chrono::Utc::now().to_rfc3339();
            Ok(())
        }
        "in_review" => Err(RUN_REVIEW_ALREADY.to_string()),
        // Completed/cancelled items are explicit human decisions. Provider
        // statuses (`open`/`closed`) and custom workflow states also retain
        // their native semantics rather than being rewritten to an ORGII
        // status by a background execution callback.
        _ => Err(RUN_REVIEW_PRESERVE.to_string()),
    }
}

fn review_projection_outcome(error: String) -> Result<RunSuccessReviewProjection, String> {
    match error.as_str() {
        RUN_REVIEW_ALREADY => Ok(RunSuccessReviewProjection::AlreadyInReview),
        RUN_REVIEW_PRESERVE => Ok(RunSuccessReviewProjection::PreservedStatus),
        RUN_REVIEW_SUPERSEDED => Ok(RunSuccessReviewProjection::Superseded),
        _ => Err(error),
    }
}

/// Move a successfully executed native Work Item into `in_review` through
/// the canonical atomic mutation path. This keeps Run finality separate from
/// product acceptance: success requests review, while only an explicit work
/// transition may mark the item completed.
///
/// The terminal Session id is checked against the execution lock so a late
/// callback from an older Run cannot overwrite a newer active execution.
pub fn project_run_success_to_review(
    project_slug: Option<&str>,
    org_id: &str,
    short_id: &str,
    terminal_session_id: Option<&str>,
) -> Result<RunSuccessReviewProjection, String> {
    let terminal_session_id = terminal_session_id.map(str::to_string);
    let mutation = match project_slug {
        Some(project_slug) => project_io::update_work_item_atomic_serviced(
            project_slug,
            short_id,
            None,
            project_io::AtomicServiceOptions {
                operation: Some("work.run_succeeded"),
                strict_fsm: true,
                reason: Some("execution succeeded; awaiting review".to_string()),
                ..Default::default()
            },
            move |frontmatter, _body| {
                apply_run_success_review_projection(frontmatter, terminal_session_id.as_deref())
            },
        ),
        None => project_io::update_standalone_work_item_atomic_serviced(
            Some(org_id),
            None,
            project_io::AtomicServiceOptions {
                operation: Some("work.run_succeeded"),
                strict_fsm: true,
                reason: Some("execution succeeded; awaiting review".to_string()),
                ..Default::default()
            },
            short_id,
            move |frontmatter, _body| {
                apply_run_success_review_projection(frontmatter, terminal_session_id.as_deref())
            },
        ),
    };

    match mutation {
        Ok(()) => {
            crate::projects::events::notify_data_changed();
            Ok(RunSuccessReviewProjection::Transitioned)
        }
        Err(error) => review_projection_outcome(error),
    }
}

/// Typed error sentinels understood by upper layers.
pub mod error {
    pub const PREFIX: &str = "PM_ERR:";
    pub const REVISION_CONFLICT: &str = "PM_ERR:REVISION_CONFLICT";
    pub const INVALID_TRANSITION: &str = "PM_ERR:INVALID_TRANSITION";
    pub const IDEMPOTENCY_CONFLICT: &str = "PM_ERR:IDEMPOTENCY_CONFLICT";
    pub const ALREADY_EXISTS: &str = "PM_ERR:ALREADY_EXISTS";

    pub fn revision_conflict(expected: i64, current: i64) -> String {
        format!("{}:{}:{}", REVISION_CONFLICT, expected, current)
    }

    pub fn invalid_transition(from: &str, to: &str) -> String {
        format!("{}:{}:{}", INVALID_TRANSITION, from, to)
    }

    pub fn already_exists(short_id: &str) -> String {
        format!("{}:{}", ALREADY_EXISTS, short_id)
    }
}

/// Outcome of an idempotency-guarded operation.
pub enum IdempotencyOutcome {
    /// The operation executed now.
    Fresh(serde_json::Value),
    /// Same key + same canonical request seen before: the stored
    /// response is returned and the operation did NOT run again.
    Replayed(serde_json::Value),
}

/// Idempotency guard over `(actor, operation, scope, key)` per the frozen
/// wire contract §14.4. Same key + same canonical request replays the
/// stored response; same key + different request is a conflict.
///
/// Reservation-first: the key row is inserted (response NULL) in its own
/// IMMEDIATE transaction BEFORE the operation runs, so a concurrent
/// duplicate waits briefly and replays instead of double-executing. A
/// crashed reservation older than the takeover window is reclaimed and
/// re-run. Narrowed residual: a crash between the operation's own commit
/// and the response write leaves a reservation whose takeover re-runs
/// the operation — the existence guards downstream turn that into a
/// structured error rather than a silent overwrite; full closure needs
/// in-tx execute hooks.
pub fn run_idempotent(
    actor_id: &str,
    operation: &str,
    scope_id: &str,
    key: &str,
    canonical_request: &serde_json::Value,
    execute: impl FnOnce() -> Result<serde_json::Value, String>,
) -> Result<IdempotencyOutcome, String> {
    const TAKEOVER_AFTER_MS: i64 = 30_000;
    const WAIT_STEP_MS: u64 = 100;
    const WAIT_BUDGET_STEPS: u32 = 20;

    let canonical =
        serde_json::to_string(canonical_request).map_err(|err| format!("canonicalize: {err}"))?;
    let mut connection = project_io::helpers::conn()?;

    let mut waited: u32 = 0;
    loop {
        let tx = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|err| format!("pm idempotency tx: {err}"))?;
        let existing: Option<(String, Option<String>, i64)> = tx
            .query_row(
                "SELECT request_hash, response_json, created_at FROM pm_idempotency
                 WHERE actor_id = ?1 AND operation = ?2 AND scope_id = ?3 AND idem_key = ?4",
                rusqlite::params![actor_id, operation, scope_id, key],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map(Some)
            .or_else(|err| match err {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(format!("pm idempotency: {other}")),
            })?;

        match existing {
            Some((stored_request, _, _)) if stored_request != canonical => {
                return Err(format!(
                    "{}:{}:{}",
                    error::IDEMPOTENCY_CONFLICT,
                    operation,
                    key
                ));
            }
            Some((_, Some(stored_response), _)) => {
                let response =
                    serde_json::from_str(&stored_response).unwrap_or(serde_json::Value::Null);
                return Ok(IdempotencyOutcome::Replayed(response));
            }
            Some((_, None, reserved_at)) => {
                let age = chrono::Utc::now().timestamp_millis() - reserved_at;
                if age < TAKEOVER_AFTER_MS {
                    drop(tx);
                    if waited >= WAIT_BUDGET_STEPS {
                        return Err(format!(
                            "{}:{}:{}:in_progress",
                            error::IDEMPOTENCY_CONFLICT,
                            operation,
                            key
                        ));
                    }
                    waited += 1;
                    std::thread::sleep(std::time::Duration::from_millis(WAIT_STEP_MS));
                    continue;
                }
                tx.execute(
                    "UPDATE pm_idempotency SET created_at = ?5
                     WHERE actor_id = ?1 AND operation = ?2 AND scope_id = ?3 AND idem_key = ?4",
                    rusqlite::params![
                        actor_id,
                        operation,
                        scope_id,
                        key,
                        chrono::Utc::now().timestamp_millis(),
                    ],
                )
                .map_err(|err| format!("pm idempotency takeover: {err}"))?;
                tx.commit()
                    .map_err(|err| format!("pm idempotency takeover commit: {err}"))?;
                break;
            }
            None => {
                tx.execute(
                    "INSERT INTO pm_idempotency
                        (actor_id, operation, scope_id, idem_key, request_hash, response_json, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6)",
                    rusqlite::params![
                        actor_id,
                        operation,
                        scope_id,
                        key,
                        canonical,
                        chrono::Utc::now().timestamp_millis(),
                    ],
                )
                .map_err(|err| format!("pm idempotency reserve: {err}"))?;
                tx.commit()
                    .map_err(|err| format!("pm idempotency reserve commit: {err}"))?;
                break;
            }
        }
    }

    match execute() {
        Ok(response) => {
            let response_raw = serde_json::to_string(&response)
                .map_err(|err| format!("serialize response: {err}"))?;
            connection
                .execute(
                    "UPDATE pm_idempotency SET response_json = ?5
                     WHERE actor_id = ?1 AND operation = ?2 AND scope_id = ?3 AND idem_key = ?4",
                    rusqlite::params![actor_id, operation, scope_id, key, response_raw],
                )
                .map_err(|err| format!("pm idempotency record: {err}"))?;
            Ok(IdempotencyOutcome::Fresh(response))
        }
        Err(err) => {
            let _ = connection.execute(
                "DELETE FROM pm_idempotency
                 WHERE actor_id = ?1 AND operation = ?2 AND scope_id = ?3 AND idem_key = ?4
                   AND response_json IS NULL",
                rusqlite::params![actor_id, operation, scope_id, key],
            );
            Err(err)
        }
    }
}

/// L3 ownership guard v1: a work item claimed by one session may not
/// have its lifecycle or content advanced by a different session. Human
/// direct operation passes no session and is exempt (actor/org policy
/// applies instead); agent-plane callers pass their session id.
fn guard_claim_holder(
    frontmatter: &WorkItemFrontmatter,
    caller_session: Option<&str>,
) -> Result<(), String> {
    let Some(caller) = caller_session else {
        return Ok(());
    };
    if let Some(holder) = frontmatter
        .execution_lock
        .as_ref()
        .and_then(|lock| lock.active_session_id.as_deref())
    {
        if holder != caller {
            return Err(format!(
                "Work item '{}' is claimed by another session: {}",
                frontmatter.short_id, holder
            ));
        }
    }
    Ok(())
}

/// OCC-capable non-lifecycle patch (`work.update` on the wire): title,
/// body and priority only — state changes stay with transition/claim.
#[allow(clippy::too_many_arguments)]
pub fn patch_project_work_item(
    project_slug: &str,
    short_id: &str,
    title: Option<&str>,
    body: Option<&str>,
    priority: Option<&str>,
    stage: Option<Option<u32>>,
    actor: Option<&WorkItemMutationActor>,
    expected_revision: Option<i64>,
    caller_session: Option<&str>,
) -> Result<WorkItemData, String> {
    let title_owned = title.map(str::to_string);
    let body_owned = body.map(str::to_string);
    let priority_owned = priority.map(str::to_string);
    let caller_owned = caller_session.map(str::to_string);
    project_io::update_work_item_atomic_serviced(
        project_slug,
        short_id,
        actor,
        project_io::AtomicServiceOptions {
            expected_local_version: expected_revision,
            operation: Some("work.update"),
            ..Default::default()
        },
        move |frontmatter, current_body| {
            guard_claim_holder(frontmatter, caller_owned.as_deref())?;
            if let Some(title) = title_owned {
                frontmatter.title = title;
            }
            if let Some(body) = body_owned {
                *current_body = body;
            }
            if let Some(priority) = priority_owned {
                frontmatter.priority = priority;
            }
            if let Some(stage) = stage {
                frontmatter.stage = stage;
            }
            frontmatter.updated_at = chrono::Utc::now().to_rfc3339();
            Ok(())
        },
    )?;
    project_io::read_work_item(project_slug, short_id)
}

/// Standalone counterpart of [`patch_project_work_item`]: OCC-capable
/// non-lifecycle patch for an org-scoped item, used by the agent-plane
/// CLI to fill drafts that have no project.
#[allow(clippy::too_many_arguments)]
pub fn patch_standalone_work_item(
    org_id: Option<&str>,
    short_id: &str,
    title: Option<&str>,
    body: Option<&str>,
    priority: Option<&str>,
    stage: Option<Option<u32>>,
    actor: Option<&WorkItemMutationActor>,
) -> Result<WorkItemData, String> {
    let title_owned = title.map(str::to_string);
    let body_owned = body.map(str::to_string);
    let priority_owned = priority.map(str::to_string);
    project_io::update_standalone_work_item_atomic_by(
        org_id,
        actor,
        short_id,
        move |frontmatter, current_body| {
            if let Some(title) = title_owned {
                frontmatter.title = title;
            }
            if let Some(body) = body_owned {
                *current_body = body;
            }
            if let Some(priority) = priority_owned {
                frontmatter.priority = priority;
            }
            if let Some(stage) = stage {
                frontmatter.stage = stage;
            }
            frontmatter.updated_at = chrono::Utc::now().to_rfc3339();
            Ok(())
        },
    )?;
    project_io::read_standalone_work_item(org_id, short_id)
}

/// Audited assignment (`work.assign`): ownership only, no run trigger —
/// dispatch semantics belong to the orchestration layer.
pub fn assign_project_work_item(
    project_slug: &str,
    short_id: &str,
    assignee: &str,
    assignee_type: Option<&str>,
    actor: Option<&WorkItemMutationActor>,
    expected_revision: Option<i64>,
) -> Result<WorkItemData, String> {
    let assignee_owned = assignee.to_string();
    let type_owned = assignee_type.map(str::to_string);
    project_io::update_work_item_atomic_serviced(
        project_slug,
        short_id,
        actor,
        project_io::AtomicServiceOptions {
            expected_local_version: expected_revision,
            operation: Some("work.assign"),
            ..Default::default()
        },
        move |frontmatter, _body| {
            frontmatter.assignee = Some(assignee_owned);
            if let Some(kind) = type_owned {
                frontmatter.assignee_type = Some(kind);
            }
            frontmatter.updated_at = chrono::Utc::now().to_rfc3339();
            Ok(())
        },
    )?;
    project_io::read_work_item(project_slug, short_id)
}

/// Single-transaction `work.release`: only the claim holder may hand
/// back execution; the lock clears and the release edge returns the
/// item to open in the same audited mutation.
pub fn release_project_work_item(
    project_slug: &str,
    short_id: &str,
    session_id: &str,
    actor: Option<&WorkItemMutationActor>,
) -> Result<WorkItemData, String> {
    let session_owned = session_id.to_string();
    project_io::update_work_item_atomic_serviced(
        project_slug,
        short_id,
        actor,
        project_io::AtomicServiceOptions {
            operation: Some("work.release"),
            reason: Some("released".to_string()),
            ..Default::default()
        },
        move |frontmatter, _body| {
            let holder = frontmatter
                .execution_lock
                .as_ref()
                .and_then(|lock| lock.active_session_id.clone());
            match holder {
                None => {
                    return Err(format!(
                        "Work item '{}' has no active claim to release",
                        frontmatter.short_id
                    ));
                }
                Some(active) if active != session_owned => {
                    return Err(format!(
                        "Work item '{}' is claimed by another session: {}",
                        frontmatter.short_id, active
                    ));
                }
                Some(_) => {}
            }
            frontmatter.execution_lock = None;
            let now = chrono::Utc::now().to_rfc3339();
            for linked in frontmatter.linked_sessions.iter_mut() {
                if linked.session_id == session_owned
                    && linked.status == crate::projects::types::LinkedSessionStatus::Running
                {
                    linked.status = crate::projects::types::LinkedSessionStatus::Cancelled;
                    linked.completed_at = Some(now.clone());
                }
            }
            if matches!(
                state::map_legacy_status(&frontmatter.status),
                Some(WorkItemState::InProgress)
            ) {
                frontmatter.status = "open".to_string();
            }
            frontmatter.updated_at = now;
            Ok(())
        },
    )?;
    project_io::read_work_item(project_slug, short_id)
}

/// Audited whole-row overwrite for seed/E2E and any remaining
/// full-frontmatter writer: existing rows go through the serviced atomic
/// path (version bump + audit + watermark), missing rows take the
/// guarded single-transaction create.
pub fn overwrite_project_work_item(
    project_slug: &str,
    short_id: &str,
    frontmatter: &WorkItemFrontmatter,
    body: &str,
    actor: Option<&WorkItemMutationActor>,
) -> Result<(), String> {
    if project_io::read_work_item(project_slug, short_id).is_ok() {
        let next_frontmatter = frontmatter.clone();
        let next_body = body.to_string();
        return project_io::update_work_item_atomic_serviced(
            project_slug,
            short_id,
            actor,
            project_io::AtomicServiceOptions {
                operation: Some("work.write"),
                ..Default::default()
            },
            move |current, current_body| {
                *current = next_frontmatter;
                *current_body = next_body;
                Ok(())
            },
        );
    }
    let mut connection = project_io::helpers::conn()?;
    let tx = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|err| format!("work.write tx: {err}"))?;
    let (project_id, org_id) = project_io::resolve_project_scope_in_tx(&tx, project_slug)?;
    guard_new_work_item_id_in_tx(&tx, short_id)?;
    project_io::write_work_item_in_tx(
        &tx,
        Some(project_id),
        &org_id,
        short_id,
        frontmatter,
        body,
        true,
    )?;
    append_create_audit_in_tx(&tx, short_id, Some(project_slug), None, actor)?;
    tx.commit()
        .map_err(|err| format!("work.write commit: {err}"))?;
    crate::projects::events::notify_work_item_schedule_changed();
    crate::sync::collab_bridge::record_work_item_write(
        &org_id,
        Some(project_slug),
        &frontmatter.id,
        frontmatter.deleted_at.is_some(),
    )
}

/// Standalone counterpart of [`overwrite_project_work_item`].
pub fn overwrite_standalone_work_item(
    org_id: Option<&str>,
    short_id: &str,
    frontmatter: &WorkItemFrontmatter,
    body: &str,
    actor: Option<&WorkItemMutationActor>,
) -> Result<(), String> {
    let resolved_org = org_id.unwrap_or("personal-org").to_string();
    if project_io::read_standalone_work_item(org_id, short_id).is_ok() {
        let next_frontmatter = frontmatter.clone();
        let next_body = body.to_string();
        project_io::update_standalone_work_item_atomic(
            org_id,
            short_id,
            move |current, current_body| {
                *current = next_frontmatter;
                *current_body = next_body;
                Ok(())
            },
        )?;
        let _ = actor;
        return Ok(());
    }
    let mut connection = project_io::helpers::conn()?;
    let tx = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|err| format!("work.write tx: {err}"))?;
    guard_new_work_item_id_in_tx(&tx, short_id)?;
    project_io::write_work_item_in_tx(&tx, None, &resolved_org, short_id, frontmatter, body, true)?;
    append_create_audit_in_tx(&tx, short_id, None, Some(&resolved_org), actor)?;
    tx.commit()
        .map_err(|err| format!("work.write commit: {err}"))?;
    crate::projects::events::notify_work_item_schedule_changed();
    crate::sync::collab_bridge::record_work_item_write(
        &resolved_org,
        None,
        &frontmatter.id,
        frontmatter.deleted_at.is_some(),
    )
}

/// Single-transaction `work.claim`: execution-lock acquisition and the
/// strict `open -> in_progress` transition commit together, with OCC
/// checked once at entry. Replaces the acquire-then-transition
/// composition whose first step bumped the revision the second step
/// then compared against.
pub fn claim_project_work_item(
    project_slug: &str,
    short_id: &str,
    session_id: &str,
    agent_role: Option<&str>,
    reason: crate::projects::types::WorkItemExecutionLockReason,
    actor: Option<&WorkItemMutationActor>,
    expected_revision: Option<i64>,
) -> Result<WorkItemData, String> {
    let short_id_owned = short_id.to_string();
    let session_owned = session_id.to_string();
    let role_owned = agent_role.map(|value| value.to_string());
    project_io::update_work_item_atomic_serviced(
        project_slug,
        short_id,
        actor,
        project_io::AtomicServiceOptions {
            expected_local_version: expected_revision,
            operation: Some("work.claim"),
            strict_fsm: true,
            reason: Some("claimed".to_string()),
        },
        move |frontmatter, _body| {
            project_io::apply_execution_claim(
                frontmatter,
                &short_id_owned,
                &session_owned,
                role_owned.as_deref(),
                reason,
            )?;
            frontmatter.status = "in_progress".to_string();
            Ok(())
        },
    )?;
    project_io::read_work_item(project_slug, short_id)
}

/// Standalone-org counterpart to [`claim_project_work_item`]: same
/// execution-claim semantics and `in_progress` entry for org-scoped
/// items that live outside any project.
#[allow(clippy::too_many_arguments)]
pub fn claim_standalone_work_item(
    org_id: Option<&str>,
    short_id: &str,
    session_id: &str,
    agent_role: Option<&str>,
    reason: crate::projects::types::WorkItemExecutionLockReason,
    actor: Option<&WorkItemMutationActor>,
    expected_revision: Option<i64>,
) -> Result<WorkItemData, String> {
    let short_id_owned = short_id.to_string();
    let session_owned = session_id.to_string();
    let role_owned = agent_role.map(|value| value.to_string());
    project_io::update_standalone_work_item_atomic_serviced(
        org_id,
        actor,
        project_io::AtomicServiceOptions {
            expected_local_version: expected_revision,
            operation: Some("work.claim"),
            strict_fsm: true,
            reason: Some("claimed".to_string()),
        },
        short_id,
        move |frontmatter, _body| {
            project_io::apply_execution_claim(
                frontmatter,
                &short_id_owned,
                &session_owned,
                role_owned.as_deref(),
                reason,
            )?;
            frontmatter.status = "in_progress".to_string();
            Ok(())
        },
    )?;
    project_io::read_standalone_work_item(org_id, short_id)
}

/// Strict, audited status transition for a project-scoped work item.
///
/// This is the `work.transition` application operation from the frozen
/// contract: it validates the portable FSM (hard reject, not flag-only),
/// honors `expected_revision`, clears the execution lock when the target
/// maps to portable `open` (the release edge), and records the reason in
/// the audit payload. Lifecycle-only: non-lifecycle fields are patch
/// territory.
pub fn transition_project_work_item(
    project_slug: &str,
    short_id: &str,
    to_status: &str,
    reason: Option<&str>,
    actor: Option<&WorkItemMutationActor>,
    expected_revision: Option<i64>,
) -> Result<WorkItemData, String> {
    transition_project_work_item_scoped(
        project_slug,
        short_id,
        to_status,
        reason,
        actor,
        expected_revision,
        None,
    )
}

/// Session-scoped transition: the agent plane passes its session id and
/// the L3 claim-holder guard applies; the human plane passes None.
#[allow(clippy::too_many_arguments)]
pub fn transition_project_work_item_scoped(
    project_slug: &str,
    short_id: &str,
    to_status: &str,
    reason: Option<&str>,
    actor: Option<&WorkItemMutationActor>,
    expected_revision: Option<i64>,
    caller_session: Option<&str>,
) -> Result<WorkItemData, String> {
    let to_status_owned = to_status.to_string();
    let reason_owned = reason.map(|value| value.to_string());
    let caller_owned = caller_session.map(str::to_string);
    project_io::update_work_item_atomic_serviced(
        project_slug,
        short_id,
        actor,
        project_io::AtomicServiceOptions {
            expected_local_version: expected_revision,
            operation: Some("work.transition"),
            strict_fsm: true,
            reason: reason_owned,
        },
        move |frontmatter, _body| {
            guard_claim_holder(frontmatter, caller_owned.as_deref())?;
            if frontmatter.status == to_status_owned {
                return Err(error::invalid_transition(
                    &frontmatter.status,
                    &to_status_owned,
                ));
            }
            let releases_to_open = matches!(
                state::map_legacy_status(&to_status_owned),
                Some(state::WorkItemState::Open)
            );
            frontmatter.status = to_status_owned.clone();
            if releases_to_open {
                // Release edge (§9.3): entering portable `open` clears the
                // active execution claim so the item is re-claimable.
                frontmatter.execution_lock = None;
            }
            Ok(())
        },
    )?;
    project_io::read_work_item(project_slug, short_id)
}

/// Standalone-org counterpart to [`transition_project_work_item_scoped`]:
/// same claim guard, FSM strictness, release edge, and audit label.
pub fn transition_standalone_work_item(
    org_id: Option<&str>,
    short_id: &str,
    to_status: &str,
    reason: Option<&str>,
    actor: Option<&WorkItemMutationActor>,
    expected_revision: Option<i64>,
    caller_session: Option<&str>,
) -> Result<WorkItemData, String> {
    let to_status_owned = to_status.to_string();
    let reason_owned = reason.map(|value| value.to_string());
    let caller_owned = caller_session.map(str::to_string);
    project_io::update_standalone_work_item_atomic_serviced(
        org_id,
        actor,
        project_io::AtomicServiceOptions {
            expected_local_version: expected_revision,
            operation: Some("work.transition"),
            strict_fsm: true,
            reason: reason_owned,
        },
        short_id,
        move |frontmatter, _body| {
            guard_claim_holder(frontmatter, caller_owned.as_deref())?;
            if frontmatter.status == to_status_owned {
                return Err(error::invalid_transition(
                    &frontmatter.status,
                    &to_status_owned,
                ));
            }
            let releases_to_open = matches!(
                state::map_legacy_status(&to_status_owned),
                Some(state::WorkItemState::Open)
            );
            frontmatter.status = to_status_owned.clone();
            if releases_to_open {
                frontmatter.execution_lock = None;
            }
            Ok(())
        },
    )?;
    project_io::read_standalone_work_item(org_id, short_id)
}

/// Creation DTO for the canonical `work.create` application operation.
///
/// Deliberately NOT the 32-field `WorkItemFrontmatter`: callers describe
/// the work; the service owns row construction. Short-id allocation stays
/// with the caller because collab-synced orgs mint ids on the server
/// (design §16.5) and that allocator currently lives client-side.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorkItemRequest {
    pub title: String,
    #[serde(default)]
    pub body: String,
    pub project_id: Option<String>,
    pub status: Option<String>,
    pub priority: Option<String>,
    pub assignee: Option<String>,
    pub assignee_type: Option<String>,
    #[serde(default)]
    pub labels: Vec<String>,
    pub milestone: Option<String>,
    pub parent: Option<String>,
    #[serde(default)]
    pub stage: Option<u32>,
    pub start_date: Option<String>,
    pub target_date: Option<String>,
    pub created_by: Option<String>,
    #[serde(default)]
    pub starred: bool,
    pub schedule: Option<WorkItemSchedule>,
    pub orchestrator_config: Option<OrchestratorConfig>,
    /// Optional parsed checklist written atomically with creation.
    #[serde(default)]
    pub todos: Vec<TodoEntry>,
    /// Optional human handoff written atomically with initial assignment.
    pub handoff: Option<WorkItemHandoff>,
    /// Durable session provenance written in the same operation.
    #[serde(default)]
    pub linked_sessions: Vec<LinkedSession>,
}

pub(crate) fn build_frontmatter_for_graph(
    short_id: &str,
    request: &CreateWorkItemRequest,
) -> WorkItemFrontmatter {
    build_frontmatter(short_id, request)
}

fn build_frontmatter(short_id: &str, request: &CreateWorkItemRequest) -> WorkItemFrontmatter {
    let now = chrono::Utc::now().to_rfc3339();
    WorkItemFrontmatter {
        id: short_id.to_string(),
        short_id: short_id.to_string(),
        title: request.title.clone(),
        project: request.project_id.clone(),
        status: request
            .status
            .clone()
            .unwrap_or_else(|| "backlog".to_string()),
        priority: request
            .priority
            .clone()
            .unwrap_or_else(|| "none".to_string()),
        assignee: request.assignee.clone(),
        assignee_type: request.assignee_type.clone(),
        labels: request.labels.clone(),
        milestone: request.milestone.clone(),
        parent: request.parent.clone(),
        stage: request.stage,
        start_date: request.start_date.clone(),
        target_date: request.target_date.clone(),
        created_by: request.created_by.clone(),
        created_at: now.clone(),
        updated_at: now,
        deleted_at: None,
        starred: request.starred,
        todos: request.todos.clone(),
        comments: vec![],
        history: vec![],
        delegations: vec![],
        linked_sessions: request.linked_sessions.clone(),
        handoff: request.handoff.clone(),
        proof_of_work: None,
        orchestrator_config: request.orchestrator_config.clone(),
        orchestrator_state: None,
        follow_up_items: vec![],
        schedule: request.schedule.clone(),
        routine_source: None,
        execution_lock: None,
        close_out: None,
        work_products: vec![],
    }
}

// Audit residual: the audit row commits in its own small transaction right
// after the insert (the crud write path doesn't take in-tx hooks yet); the
// crash window closes when crud converges onto the serviced choke point.

/// The `workitems` PK is a single global column, so a same-id row in any
/// other scope would be silently reassigned by the upsert. Creation must
/// refuse instead of clobbering.
pub(crate) fn guard_new_work_item_id_in_tx(
    tx: &rusqlite::Transaction,
    short_id: &str,
) -> Result<(), String> {
    let count: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM workitems WHERE id = ?1",
            rusqlite::params![short_id],
            |row| row.get(0),
        )
        .map_err(|err| format!("work.create existence guard: {err}"))?;
    if count > 0 {
        return Err(error::already_exists(short_id));
    }
    Ok(())
}

fn append_create_audit_in_tx(
    tx: &rusqlite::Transaction,
    entity_id: &str,
    project_slug: Option<&str>,
    org_id: Option<&str>,
    actor: Option<&WorkItemMutationActor>,
) -> Result<(), String> {
    let seq = audit::bump_change_seq(tx)?;
    audit::append_audit_event(
        tx,
        &audit::AuditEventRow {
            operation: "work.create",
            entity_type: "work_item",
            entity_id,
            project_slug,
            org_id,
            actor,
            revision: 0,
            seq,
            payload: serde_json::json!({}),
        },
    )
}

/// Canonical `work.create` for a project-scoped item. The single Rust
/// construction site replacing per-caller `WorkItemFrontmatter` literals.
/// Guard, row write, audit and watermark commit in one transaction.
pub fn create_project_work_item(
    project_slug: &str,
    short_id: &str,
    request: &CreateWorkItemRequest,
    actor: Option<&WorkItemMutationActor>,
) -> Result<WorkItemData, String> {
    let frontmatter = build_frontmatter(short_id, request);
    let mut connection = project_io::helpers::conn()?;
    let tx = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|err| format!("work.create tx: {err}"))?;
    let (project_id, org_id) = project_io::resolve_project_scope_in_tx(&tx, project_slug)?;
    guard_new_work_item_id_in_tx(&tx, short_id)?;
    project_io::write_work_item_in_tx(
        &tx,
        Some(project_id),
        &org_id,
        short_id,
        &frontmatter,
        &request.body,
        true,
    )?;
    append_create_audit_in_tx(&tx, short_id, Some(project_slug), None, actor)?;
    tx.commit()
        .map_err(|err| format!("work.create commit: {err}"))?;
    crate::projects::events::notify_work_item_schedule_changed();
    crate::sync::collab_bridge::record_work_item_write(
        &org_id,
        Some(project_slug),
        &frontmatter.id,
        false,
    )?;
    project_io::read_work_item(project_slug, short_id)
}

/// Current OCC revision (`local_version`) of a project-scoped item —
/// surfaced through `work show` so callers can supply
/// `--expected-revision` on the next mutation.
pub fn read_project_work_item_revision(project_slug: &str, short_id: &str) -> Result<i64, String> {
    let connection = project_io::helpers::conn()?;
    connection
        .query_row(
            "SELECT w.local_version FROM workitems w
             JOIN projects p ON p.id = w.project_id
             WHERE p.slug = ?1 AND w.short_id = ?2",
            rusqlite::params![project_slug, short_id],
            |row| row.get(0),
        )
        .map_err(|err| match err {
            rusqlite::Error::QueryReturnedNoRows => {
                format!("Work item '{}' not found", short_id)
            }
            other => format!("DB error: {}", other),
        })
}

/// Canonical `work.note` (`work.update.append`): append-only comment on
/// the item, audited under its own operation label.
pub fn note_project_work_item(
    project_slug: &str,
    short_id: &str,
    kind: &str,
    body: &str,
    actor: Option<&WorkItemMutationActor>,
) -> Result<(), String> {
    note_project_work_item_threaded(project_slug, short_id, kind, body, None, actor)
}

/// Append a note as a reply in a persisted Discussion thread without waking
/// the linked Session again. This is the receipt path used by an agent that
/// was already resumed for the parent comment.
pub fn note_project_work_item_threaded(
    project_slug: &str,
    short_id: &str,
    kind: &str,
    body: &str,
    parent_id: Option<&str>,
    actor: Option<&WorkItemMutationActor>,
) -> Result<(), String> {
    let author = actor
        .map(|a| a.name.clone())
        .unwrap_or_else(|| "agent".to_string());
    let note_body = if kind == "comment" {
        body.to_string()
    } else {
        // Portable note kinds (comment|progress|blocker|decision|handoff|
        // review) ride in the comment text until comments grow a kind
        // column; the audit payload carries the kind losslessly.
        format!("[{}] {}", kind, body)
    };
    let reason = Some(kind.to_string());
    let body_owned = note_body;
    let parent_id = parent_id.map(str::to_string);
    project_io::update_work_item_atomic_serviced(
        project_slug,
        short_id,
        actor,
        project_io::AtomicServiceOptions {
            operation: Some("work.note"),
            reason,
            ..Default::default()
        },
        move |frontmatter, _item_body| {
            let now = chrono::Utc::now().to_rfc3339();
            let thread_id = parent_id
                .as_deref()
                .map(|parent_id| {
                    frontmatter
                        .comments
                        .iter()
                        .find(|comment| comment.id == parent_id)
                        .map(|comment| {
                            comment
                                .thread_id
                                .clone()
                                .unwrap_or_else(|| comment.id.clone())
                        })
                        .ok_or_else(|| format!("Discussion parent '{parent_id}' not found"))
                })
                .transpose()?;
            frontmatter
                .comments
                .push(crate::projects::types::CommentEntry {
                    id: format!("note-{}", chrono::Utc::now().timestamp_millis()),
                    author,
                    content: body_owned,
                    created_at: now,
                    mentioned_user_ids: vec![],
                    parent_id,
                    thread_id,
                    ..Default::default()
                });
            Ok(())
        },
    )
}

/// Idempotent form of [`note_project_work_item`] for durable consumers.
///
/// The caller owns `note_id` and must derive it from the source event. Replays
/// after a process crash become a no-op once that exact note is present, while
/// the Work Item mutation and its audit/write side effects still share the
/// normal atomic boundary.
pub fn note_project_work_item_idempotent(
    project_slug: &str,
    short_id: &str,
    note_id: &str,
    kind: &str,
    body: &str,
    actor: Option<&WorkItemMutationActor>,
) -> Result<(), String> {
    if note_id.trim().is_empty() {
        return Err("note_id is required".to_string());
    }
    let author = actor
        .map(|a| a.name.clone())
        .unwrap_or_else(|| "agent".to_string());
    let note_body = if kind == "comment" {
        body.to_string()
    } else {
        format!("[{}] {}", kind, body)
    };
    let stable_note_id = note_id.to_string();
    project_io::update_work_item_atomic_serviced(
        project_slug,
        short_id,
        actor,
        project_io::AtomicServiceOptions {
            operation: Some("work.note"),
            reason: Some(kind.to_string()),
            ..Default::default()
        },
        move |frontmatter, _item_body| {
            if frontmatter
                .comments
                .iter()
                .any(|comment| comment.id == stable_note_id)
            {
                return Ok(());
            }
            frontmatter
                .comments
                .push(crate::projects::types::CommentEntry {
                    id: stable_note_id,
                    author,
                    content: note_body,
                    created_at: chrono::Utc::now().to_rfc3339(),
                    mentioned_user_ids: vec![],
                    ..Default::default()
                });
            Ok(())
        },
    )
}

pub fn note_standalone_work_item(
    org_id: Option<&str>,
    short_id: &str,
    kind: &str,
    body: &str,
    actor: Option<&WorkItemMutationActor>,
) -> Result<(), String> {
    note_standalone_work_item_threaded(org_id, short_id, kind, body, None, actor)
}

pub fn note_standalone_work_item_threaded(
    org_id: Option<&str>,
    short_id: &str,
    kind: &str,
    body: &str,
    parent_id: Option<&str>,
    actor: Option<&WorkItemMutationActor>,
) -> Result<(), String> {
    let author = actor
        .map(|a| a.name.clone())
        .unwrap_or_else(|| "agent".to_string());
    let note_body = if kind == "comment" {
        body.to_string()
    } else {
        format!("[{}] {}", kind, body)
    };
    let parent_id = parent_id.map(str::to_string);
    project_io::update_standalone_work_item_atomic_serviced(
        org_id,
        actor,
        project_io::AtomicServiceOptions {
            operation: Some("work.note"),
            reason: Some(kind.to_string()),
            ..Default::default()
        },
        short_id,
        move |frontmatter, _item_body| {
            let now = chrono::Utc::now().to_rfc3339();
            let thread_id = parent_id
                .as_deref()
                .map(|parent_id| {
                    frontmatter
                        .comments
                        .iter()
                        .find(|comment| comment.id == parent_id)
                        .map(|comment| {
                            comment
                                .thread_id
                                .clone()
                                .unwrap_or_else(|| comment.id.clone())
                        })
                        .ok_or_else(|| format!("Discussion parent '{parent_id}' not found"))
                })
                .transpose()?;
            frontmatter
                .comments
                .push(crate::projects::types::CommentEntry {
                    id: format!("note-{}", chrono::Utc::now().timestamp_millis()),
                    author,
                    content: note_body,
                    created_at: now,
                    mentioned_user_ids: vec![],
                    parent_id,
                    thread_id,
                    ..Default::default()
                });
            Ok(())
        },
    )
}

/// Standalone counterpart to [`note_project_work_item_idempotent`].
pub fn note_standalone_work_item_idempotent(
    org_id: Option<&str>,
    short_id: &str,
    note_id: &str,
    kind: &str,
    body: &str,
    actor: Option<&WorkItemMutationActor>,
) -> Result<(), String> {
    if note_id.trim().is_empty() {
        return Err("note_id is required".to_string());
    }
    let author = actor
        .map(|a| a.name.clone())
        .unwrap_or_else(|| "agent".to_string());
    let note_body = if kind == "comment" {
        body.to_string()
    } else {
        format!("[{}] {}", kind, body)
    };
    let stable_note_id = note_id.to_string();
    project_io::update_standalone_work_item_atomic_serviced(
        org_id,
        actor,
        project_io::AtomicServiceOptions {
            operation: Some("work.note"),
            reason: Some(kind.to_string()),
            ..Default::default()
        },
        short_id,
        move |frontmatter, _item_body| {
            if frontmatter
                .comments
                .iter()
                .any(|comment| comment.id == stable_note_id)
            {
                return Ok(());
            }
            frontmatter
                .comments
                .push(crate::projects::types::CommentEntry {
                    id: stable_note_id,
                    author,
                    content: note_body,
                    created_at: chrono::Utc::now().to_rfc3339(),
                    mentioned_user_ids: vec![],
                    ..Default::default()
                });
            Ok(())
        },
    )
}

const PORTABLE_RELATION_KINDS: &[&str] = &[
    "depends_on",
    "relates_to",
    "duplicates",
    "implements",
    "supersedes",
    "continued_by",
    "generated_by",
    "participated_in",
];

/// Canonical `work.relate` (`work.relation.add`): typed semantic edge in
/// the `pm_relations` table, audited + watermarked in one transaction.
pub fn relate_project_work_item(
    project_slug: &str,
    short_id: &str,
    kind: &str,
    target_ref: &str,
    actor: Option<&WorkItemMutationActor>,
) -> Result<(), String> {
    if !PORTABLE_RELATION_KINDS.contains(&kind) {
        return Err(format!(
            "{}:relation kind '{}' is not portable",
            error::PREFIX,
            kind
        ));
    }
    // Existence check outside the tx (short id is scope-stable).
    let _ = read_project_work_item_revision(project_slug, short_id)?;
    let mut connection = project_io::helpers::conn()?;
    let tx = connection
        .transaction()
        .map_err(|err| format!("pm relate tx: {}", err))?;
    tx.execute(
        "INSERT INTO pm_relations (entity_type, entity_id, kind, target_ref, created_at, actor_id)
         VALUES ('work_item', ?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![
            short_id,
            kind,
            target_ref,
            chrono::Utc::now().timestamp_millis(),
            actor.map(|a| a.id.as_str()),
        ],
    )
    .map_err(|err| format!("pm relate: {}", err))?;
    let seq = audit::bump_change_seq(&tx)?;
    audit::append_audit_event(
        &tx,
        &audit::AuditEventRow {
            operation: "work.relate",
            entity_type: "work_item",
            entity_id: short_id,
            project_slug: Some(project_slug),
            org_id: None,
            actor,
            revision: 0,
            seq,
            payload: serde_json::json!({ "kind": kind, "targetRef": target_ref }),
        },
    )?;
    tx.commit()
        .map_err(|err| format!("pm relate commit: {}", err))
}

/// Read the typed relations of a project-scoped item.
pub fn list_work_item_relations(short_id: &str) -> Result<Vec<serde_json::Value>, String> {
    let connection = project_io::helpers::conn()?;
    let mut statement = connection
        .prepare(
            "SELECT kind, target_ref, created_at FROM pm_relations
             WHERE entity_type = 'work_item' AND entity_id = ?1
             ORDER BY id",
        )
        .map_err(|err| format!("pm relations: {}", err))?;
    let rows = statement
        .query_map(rusqlite::params![short_id], |row| {
            Ok(serde_json::json!({
                "kind": row.get::<_, String>(0)?,
                "targetRef": row.get::<_, String>(1)?,
                "createdAt": row.get::<_, i64>(2)?,
            }))
        })
        .map_err(|err| format!("pm relations: {}", err))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("pm relations: {}", err))?;
    Ok(rows)
}

const ROOT_BOOTSTRAP_OPERATION: &str = "work.bootstrap";
const ROOT_BOOTSTRAP_TITLE_MAX_CHARS: usize = 80;

fn derive_root_bootstrap_title(content: &str) -> String {
    let first_line = content.trim().lines().next().unwrap_or("").trim();
    let title: String = first_line
        .chars()
        .take(ROOT_BOOTSTRAP_TITLE_MAX_CHARS)
        .collect();
    if title.is_empty() {
        "Untitled project".to_string()
    } else {
        title
    }
}

/// Idempotent root-WorkItem creation for a Project session (orgtrack/v1
/// §7.2), shared by the native message-accept path and the CLI session
/// follow-up path. `raw_org_scope` may carry looser session-plane scopes
/// (`cloud:<uuid>`, `personal-org`); anything without a local org row
/// falls back to the personal standalone scope. Returns the root's short
/// id; the caller owns linking it back onto its own session row.
pub fn bootstrap_root_standalone_item(
    session_id: &str,
    raw_org_scope: Option<&str>,
    content: &str,
) -> Result<String, String> {
    let org_id = crate::projects::io::resolve_local_org_scope(raw_org_scope);
    let session_ref = format!("org2:{session_id}");
    let actor = WorkItemMutationActor {
        id: session_ref.clone(),
        name: "ORG2 host".to_string(),
    };
    let scope_id = org_id.clone().unwrap_or_else(|| "standalone".to_string());

    // Canonical request deliberately excludes the message content: the
    // key is "this session's root", and a retry after a create-then-
    // link-failure may arrive with different content but must replay
    // the SAME stored root instead of conflicting or duplicating.
    let canonical = serde_json::json!({ "sessionRef": session_ref });
    let org_for_execute = org_id.clone();
    let title = derive_root_bootstrap_title(content);
    let body = content.to_string();
    let actor_for_execute = actor.clone();
    let outcome = run_idempotent(
        &session_ref,
        ROOT_BOOTSTRAP_OPERATION,
        &scope_id,
        session_id,
        &canonical,
        move || {
            let short_id =
                crate::projects::io::allocate_standalone_short_id(org_for_execute.as_deref())?;
            let request = CreateWorkItemRequest {
                title,
                body,
                created_by: Some(actor_for_execute.id.clone()),
                ..Default::default()
            };
            create_standalone_work_item(
                org_for_execute.as_deref(),
                &short_id,
                &request,
                Some(&actor_for_execute),
            )?;
            Ok(serde_json::json!({ "shortId": short_id }))
        },
    )?;

    let response = match outcome {
        IdempotencyOutcome::Fresh(value) | IdempotencyOutcome::Replayed(value) => value,
    };
    response
        .get("shortId")
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .ok_or_else(|| format!("bootstrap response missing shortId: {response}"))
}

/// True when `actor_id` appended a `work.note` audit row on the item at or
/// after `since_unix_ms`. The turn-end receipt fallback uses this to decide
/// whether the agent already delivered a Discussion receipt this turn.
pub fn work_item_noted_by_actor_since(
    short_id: &str,
    actor_id: &str,
    since_unix_ms: i64,
) -> Result<bool, String> {
    let connection = project_io::helpers::conn()?;
    connection
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM pm_audit_events
                WHERE entity_type = 'work_item' AND entity_id = ?1
                  AND actor_id = ?2 AND operation = 'work.note'
                  AND occurred_at >= ?3)",
            rusqlite::params![short_id, actor_id, since_unix_ms],
            |row| row.get::<_, i64>(0),
        )
        .map(|value| value != 0)
        .map_err(|err| format!("pm audit read: {err}"))
}

/// Canonical `work.create` for an org-scoped standalone item.
/// Guard, row write, audit and watermark commit in one transaction.
pub fn create_standalone_work_item(
    org_id: Option<&str>,
    short_id: &str,
    request: &CreateWorkItemRequest,
    actor: Option<&WorkItemMutationActor>,
) -> Result<WorkItemData, String> {
    let resolved_org = org_id.unwrap_or("personal-org").to_string();
    let frontmatter = build_frontmatter(short_id, request);
    let mut connection = project_io::helpers::conn()?;
    let tx = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|err| format!("work.create tx: {err}"))?;
    guard_new_work_item_id_in_tx(&tx, short_id)?;
    project_io::write_work_item_in_tx(
        &tx,
        None,
        &resolved_org,
        short_id,
        &frontmatter,
        &request.body,
        true,
    )?;
    append_create_audit_in_tx(&tx, short_id, None, Some(&resolved_org), actor)?;
    tx.commit()
        .map_err(|err| format!("work.create commit: {err}"))?;
    crate::projects::events::notify_work_item_schedule_changed();
    crate::sync::collab_bridge::record_work_item_write(
        &resolved_org,
        None,
        &frontmatter.id,
        false,
    )?;
    project_io::read_standalone_work_item(org_id, short_id)
}

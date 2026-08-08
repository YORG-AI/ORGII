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

/// Typed error sentinels understood by upper layers.
pub mod error {
    pub const PREFIX: &str = "PM_ERR:";
    pub const REVISION_CONFLICT: &str = "PM_ERR:REVISION_CONFLICT";
    pub const INVALID_TRANSITION: &str = "PM_ERR:INVALID_TRANSITION";
    pub const IDEMPOTENCY_CONFLICT: &str = "PM_ERR:IDEMPOTENCY_CONFLICT";

    pub fn revision_conflict(expected: i64, current: i64) -> String {
        format!("{}:{}:{}", REVISION_CONFLICT, expected, current)
    }

    pub fn invalid_transition(from: &str, to: &str) -> String {
        format!("{}:{}:{}", INVALID_TRANSITION, from, to)
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
/// Residual (documented): the record is written after the operation
/// commits rather than inside its transaction, so a crash between the
/// two can re-run the operation on retry. The window closes when the
/// mutation handlers take in-tx hooks; local single-writer CLI usage is
/// unaffected in practice.
pub fn run_idempotent(
    actor_id: &str,
    operation: &str,
    scope_id: &str,
    key: &str,
    canonical_request: &serde_json::Value,
    execute: impl FnOnce() -> Result<serde_json::Value, String>,
) -> Result<IdempotencyOutcome, String> {
    let canonical =
        serde_json::to_string(canonical_request).map_err(|err| format!("canonicalize: {err}"))?;
    let connection = project_io::helpers::conn()?;
    let existing: Option<(String, Option<String>)> = connection
        .query_row(
            "SELECT request_hash, response_json FROM pm_idempotency
             WHERE actor_id = ?1 AND operation = ?2 AND scope_id = ?3 AND idem_key = ?4",
            rusqlite::params![actor_id, operation, scope_id, key],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map(Some)
        .or_else(|err| match err {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(format!("pm idempotency: {other}")),
        })?;

    if let Some((stored_request, stored_response)) = existing {
        if stored_request != canonical {
            return Err(format!(
                "{}:{}:{}",
                error::IDEMPOTENCY_CONFLICT,
                operation,
                key
            ));
        }
        let response = stored_response
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or(serde_json::Value::Null);
        return Ok(IdempotencyOutcome::Replayed(response));
    }

    let response = execute()?;
    let response_raw =
        serde_json::to_string(&response).map_err(|err| format!("serialize response: {err}"))?;
    connection
        .execute(
            "INSERT OR IGNORE INTO pm_idempotency
                (actor_id, operation, scope_id, idem_key, request_hash, response_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                actor_id,
                operation,
                scope_id,
                key,
                canonical,
                response_raw,
                chrono::Utc::now().timestamp_millis(),
            ],
        )
        .map_err(|err| format!("pm idempotency record: {err}"))?;
    Ok(IdempotencyOutcome::Fresh(response))
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
    let to_status_owned = to_status.to_string();
    let reason_owned = reason.map(|value| value.to_string());
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

/// Audit a creation. Residual: the audit row commits in its own small
/// transaction right after the insert (the crud write path doesn't take
/// in-tx hooks yet); the crash window between the two is the documented
/// gap that closes when crud converges onto the serviced choke point.
fn audit_create(
    entity_id: &str,
    project_slug: Option<&str>,
    org_id: Option<&str>,
    actor: Option<&WorkItemMutationActor>,
) -> Result<(), String> {
    let mut connection = project_io::helpers::conn()?;
    let tx = connection
        .transaction()
        .map_err(|err| format!("pm audit tx: {}", err))?;
    let seq = audit::bump_change_seq(&tx)?;
    audit::append_audit_event(
        &tx,
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
    )?;
    tx.commit().map_err(|err| format!("pm audit commit: {}", err))
}

/// Canonical `work.create` for a project-scoped item. The single Rust
/// construction site replacing per-caller `WorkItemFrontmatter` literals.
pub fn create_project_work_item(
    project_slug: &str,
    short_id: &str,
    request: &CreateWorkItemRequest,
    actor: Option<&WorkItemMutationActor>,
) -> Result<WorkItemData, String> {
    let frontmatter = build_frontmatter(short_id, request);
    project_io::write_work_item(project_slug, short_id, &frontmatter, &request.body)?;
    audit_create(short_id, Some(project_slug), None, actor)?;
    project_io::read_work_item(project_slug, short_id)
}

/// Current OCC revision (`local_version`) of a project-scoped item —
/// surfaced through `work show` so callers can supply
/// `--expected-revision` on the next mutation.
pub fn read_project_work_item_revision(
    project_slug: &str,
    short_id: &str,
) -> Result<i64, String> {
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
            frontmatter.comments.push(crate::projects::types::CommentEntry {
                id: format!("note-{}", chrono::Utc::now().timestamp_millis()),
                author,
                content: body_owned,
                created_at: now,
                mentioned_user_ids: vec![],
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
            error::PREFIX, kind
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
    tx.commit().map_err(|err| format!("pm relate commit: {}", err))
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

/// Canonical `work.create` for an org-scoped standalone item.
pub fn create_standalone_work_item(
    org_id: Option<&str>,
    short_id: &str,
    request: &CreateWorkItemRequest,
    actor: Option<&WorkItemMutationActor>,
) -> Result<WorkItemData, String> {
    let frontmatter = build_frontmatter(short_id, request);
    project_io::write_standalone_work_item(org_id, short_id, &frontmatter, &request.body)?;
    audit_create(short_id, None, org_id, actor)?;
    project_io::read_standalone_work_item(org_id, short_id)
}

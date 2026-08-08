//! Routine application service (`orgtrack/v1` Phase 4).
//!
//! Owns the portable Routine domain: spec validation/canonicalization
//! ([`spec`]), versioned definitions with immutable per-run snapshots,
//! and RoutineRun materialization into generated WorkItems through the
//! same `work.create` handler every other entry point uses.
//!
//! Storage: `pm_routines` (current definition + revision) and
//! `pm_routine_runs` (immutable occurrence: revision, snapshot, hash,
//! status projection inputs). The legacy `routine_definitions` /
//! `routine_fires` tables stay readable until the Phase 4 conversion
//! completes; conversion is one-way and disables definitions it cannot
//! express portably, with a written report.

pub mod convert;
pub mod spec;

use crate::projects::io as project_io;
use crate::work_service;

/// Compute the immutable snapshot hash for a canonical spec body.
pub fn snapshot_hash(canonical: &str) -> String {
    // FNV-1a 64 over the canonical bytes, doubled for width. Not
    // cryptographic — the hash pins run provenance, it does not defend
    // against adversaries; swap for sha256 when a crypto dep lands in
    // this crate for other reasons.
    fn fnv1a(bytes: &[u8], seed: u64) -> u64 {
        let mut hash = 0xcbf2_9ce4_8422_2325u64 ^ seed;
        for byte in bytes {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01B3);
        }
        hash
    }
    let a = fnv1a(canonical.as_bytes(), 0);
    let b = fnv1a(canonical.as_bytes(), 0x9E37_79B9_7F4A_7C15);
    format!("fnv1a:{a:016x}{b:016x}")
}

/// `routine.apply` (§12.1): validate, canonicalize, then create or bump
/// the definition. Same canonical body → same revision (idempotent);
/// changed body → revision + 1. Historic runs are never touched.
pub fn apply(spec_file: &spec::RoutineSpecFile) -> Result<AppliedRoutine, String> {
    let violations = spec::validate(spec_file);
    if !violations.is_empty() {
        let details = serde_json::to_string(&violations).unwrap_or_default();
        return Err(format!("{}:{}", error::SPEC_INVALID, details));
    }
    let canonical = spec::canonicalize(spec_file)?;
    let hash = snapshot_hash(&canonical);

    let mut connection = project_io::helpers::conn()?;
    let tx = connection
        .transaction()
        .map_err(|err| format!("routine apply tx: {err}"))?;

    let existing: Option<(i64, String)> = tx
        .query_row(
            "SELECT revision, spec_hash FROM pm_routines WHERE name = ?1",
            rusqlite::params![spec_file.metadata.name],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map(Some)
        .or_else(|err| match err {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(format!("routine apply: {other}")),
        })?;

    let (revision, changed) = match existing {
        Some((revision, ref stored_hash)) if stored_hash == &hash => (revision, false),
        Some((revision, _)) => {
            let next = revision + 1;
            tx.execute(
                "UPDATE pm_routines
                 SET spec_json = ?2, spec_hash = ?3, revision = ?4, updated_at = ?5
                 WHERE name = ?1",
                rusqlite::params![
                    spec_file.metadata.name,
                    canonical,
                    hash,
                    next,
                    chrono::Utc::now().timestamp_millis(),
                ],
            )
            .map_err(|err| format!("routine apply: {err}"))?;
            (next, true)
        }
        None => {
            tx.execute(
                "INSERT INTO pm_routines
                    (name, routine_id, spec_json, spec_hash, revision, enabled, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, 1, 1, ?5, ?5)",
                rusqlite::params![
                    spec_file.metadata.name,
                    spec_file.metadata.id,
                    canonical,
                    hash,
                    chrono::Utc::now().timestamp_millis(),
                ],
            )
            .map_err(|err| format!("routine apply: {err}"))?;
            (1, true)
        }
    };

    if changed {
        let seq = work_service::audit::bump_change_seq(&tx)?;
        work_service::audit::append_audit_event(
            &tx,
            &work_service::audit::AuditEventRow {
                operation: "routine.apply",
                entity_type: "routine",
                entity_id: &spec_file.metadata.name,
                project_slug: None,
                org_id: None,
                actor: None,
                revision,
                seq,
                payload: serde_json::json!({ "specHash": hash }),
            },
        )?;
    }
    tx.commit()
        .map_err(|err| format!("routine apply commit: {err}"))?;

    Ok(AppliedRoutine {
        name: spec_file.metadata.name.clone(),
        revision,
        spec_hash: hash,
        changed,
    })
}

#[derive(Debug)]
pub struct AppliedRoutine {
    pub name: String,
    pub revision: i64,
    pub spec_hash: String,
    pub changed: bool,
}

/// Typed error sentinels for the routine domain.
pub mod error {
    pub const SPEC_INVALID: &str = "PM_ERR:ROUTINE_SPEC_INVALID";
    pub const INPUTS_INVALID: &str = "PM_ERR:ROUTINE_INPUTS_INVALID";
}

/// Substitute `{{ inputs.<name> }}` template markers (with or without
/// inner spaces) in root-work templates. Declarative only.
fn substitute_inputs(template: &str, inputs: &std::collections::BTreeMap<String, String>) -> String {
    let mut result = template.to_string();
    for (name, value) in inputs {
        for marker in [
            format!("{{{{ inputs.{} }}}}", name),
            format!("{{{{inputs.{}}}}}", name),
        ] {
            result = result.replace(&marker, value);
        }
    }
    result
}

#[derive(Debug)]
pub struct InvokedRun {
    pub run_id: String,
    pub root_short_id: String,
    /// step id -> generated child short id, in spec order.
    pub steps: Vec<(String, String)>,
}

/// `routine.invoke` (§12.2): snapshot the current revision, create the
/// RoutineRun, materialize the root WorkItem and one generated child per
/// step through the canonical `work.create` handler, and record the
/// dependency edges as durable `depends_on` relations. Scheduler and
/// manual invocations share this single entry point.
pub fn invoke(
    routine_name: &str,
    scope_project_slug: &str,
    inputs: &std::collections::BTreeMap<String, String>,
    created_by: Option<&crate::projects::types::WorkItemMutationActor>,
) -> Result<InvokedRun, String> {
    // 1. Load the current definition.
    let connection = project_io::helpers::conn()?;
    let (spec_json, spec_hash, revision): (String, String, i64) = connection
        .query_row(
            "SELECT spec_json, spec_hash, revision FROM pm_routines WHERE name = ?1",
            rusqlite::params![routine_name],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|err| match err {
            rusqlite::Error::QueryReturnedNoRows => {
                format!("Routine '{}' not found", routine_name)
            }
            other => format!("routine invoke: {other}"),
        })?;
    drop(connection);
    let snapshot: spec::RoutineSpecFile =
        serde_json::from_str(&spec_json).map_err(|err| format!("snapshot parse: {err}"))?;

    // 2. Validate inputs against the snapshot's contract.
    for (name, decl) in &snapshot.spec.inputs {
        if decl.required && !inputs.contains_key(name) {
            return Err(format!("{}:missing required input '{}'", error::INPUTS_INVALID, name));
        }
    }
    for name in inputs.keys() {
        if !snapshot.spec.inputs.contains_key(name) {
            return Err(format!("{}:unknown input '{}'", error::INPUTS_INVALID, name));
        }
    }

    let now = chrono::Utc::now().timestamp_millis();
    let run_id = format!("run_{}{:05}", now, std::process::id() % 100_000);

    // 3. Materialize the work graph through the canonical create handler.
    let root_short_id = project_io::allocate_short_id(scope_project_slug)?;
    let root_request = work_service::CreateWorkItemRequest {
        title: substitute_inputs(&snapshot.spec.root_work.title, inputs),
        body: snapshot
            .spec
            .root_work
            .body
            .as_deref()
            .map(|body| substitute_inputs(body, inputs))
            .unwrap_or_default(),
        priority: snapshot.spec.root_work.priority.clone(),
        labels: snapshot.spec.root_work.labels.clone(),
        created_by: created_by.map(|actor| actor.id.clone()),
        ..Default::default()
    };
    work_service::create_project_work_item(scope_project_slug, &root_short_id, &root_request, created_by)?;

    let mut step_ids: Vec<(String, String)> = Vec::new();
    for step in &snapshot.spec.steps {
        let child_short_id = project_io::allocate_short_id(scope_project_slug)?;
        let mut body = step
            .instruction
            .as_deref()
            .map(|instruction| substitute_inputs(instruction, inputs))
            .unwrap_or_default();
        if !step.inputs.is_empty() {
            body.push_str("\n\n## Inputs\n");
            for (name, expression) in &step.inputs {
                body.push_str(&format!("- {}: {}\n", name, expression));
            }
        }
        if let Some(actor_requirement) = &step.actor {
            body.push_str(&format!(
                "\n## Actor requirement\n- role: {}\n- requires: {}\n",
                actor_requirement.role,
                actor_requirement.requires.join(", ")
            ));
        }
        let child_request = work_service::CreateWorkItemRequest {
            title: substitute_inputs(&step.title, inputs),
            body,
            parent: Some(root_short_id.clone()),
            created_by: created_by.map(|actor| actor.id.clone()),
            ..Default::default()
        };
        work_service::create_project_work_item(
            scope_project_slug,
            &child_short_id,
            &child_request,
            created_by,
        )?;
        step_ids.push((step.id.clone(), child_short_id));
    }

    // 4. Durable graph edges: dependencies + run provenance.
    let index: std::collections::HashMap<&str, &str> = step_ids
        .iter()
        .map(|(step_id, short_id)| (step_id.as_str(), short_id.as_str()))
        .collect();
    for step in &snapshot.spec.steps {
        let child = index[step.id.as_str()];
        for need in &step.needs {
            work_service::relate_project_work_item(
                scope_project_slug,
                child,
                "depends_on",
                &format!("work://{}/{}", scope_project_slug, index[need.as_str()]),
                created_by,
            )?;
        }
        work_service::relate_project_work_item(
            scope_project_slug,
            child,
            "generated_by",
            &format!("run://{}", run_id),
            created_by,
        )?;
    }

    // 5. The run row + audit, one transaction.
    let mut connection = project_io::helpers::conn()?;
    let tx = connection
        .transaction()
        .map_err(|err| format!("routine invoke tx: {err}"))?;
    tx.execute(
        "INSERT INTO pm_routine_runs
            (id, routine_name, routine_revision, snapshot_json, snapshot_hash,
             scope_id, status, inputs_json, root_work_item_id, created_by,
             created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'running', ?7, ?8, ?9, ?10, ?10)",
        rusqlite::params![
            run_id,
            routine_name,
            revision,
            spec_json,
            spec_hash,
            scope_project_slug,
            serde_json::to_string(inputs).unwrap_or_default(),
            root_short_id,
            created_by.map(|actor| actor.id.as_str()),
            now,
        ],
    )
    .map_err(|err| format!("routine invoke: {err}"))?;
    let seq = work_service::audit::bump_change_seq(&tx)?;
    work_service::audit::append_audit_event(
        &tx,
        &work_service::audit::AuditEventRow {
            operation: "routine.invoke",
            entity_type: "routine_run",
            entity_id: &run_id,
            project_slug: Some(scope_project_slug),
            org_id: None,
            actor: created_by,
            revision,
            seq,
            payload: serde_json::json!({
                "routine": routine_name,
                "snapshotHash": spec_hash,
                "rootWorkItemId": root_short_id,
            }),
        },
    )?;
    tx.commit()
        .map_err(|err| format!("routine invoke commit: {err}"))?;

    Ok(InvokedRun {
        run_id,
        root_short_id,
        steps: step_ids,
    })
}

/// Set the host-local default scope binding used by scheduled invokes.
/// Deliberately outside the portable spec/hash — scope is deployment
/// configuration, not work-method knowledge.
pub fn set_default_scope(name: &str, scope: &str) -> Result<(), String> {
    let connection = project_io::helpers::conn()?;
    let changed = connection
        .execute(
            "UPDATE pm_routines SET default_scope = ?2 WHERE name = ?1",
            rusqlite::params![name, scope],
        )
        .map_err(|err| format!("routine set_default_scope: {err}"))?;
    if changed == 0 {
        return Err(format!("Routine '{}' not found", name));
    }
    Ok(())
}

/// One schedule-activation candidate for the host scheduler tick.
#[derive(Debug)]
pub struct ScheduledCandidate {
    pub name: String,
    pub cron: String,
    pub timezone: String,
    pub concurrency: spec::ConcurrencyPolicy,
    pub catch_up: spec::CatchUpPolicy,
    pub default_scope: Option<String>,
    pub last_evaluated_at: Option<i64>,
}

/// Enabled routines with schedule activations, for the host scheduler.
pub fn scheduled_candidates() -> Result<Vec<ScheduledCandidate>, String> {
    let connection = project_io::helpers::conn()?;
    let mut statement = connection
        .prepare(
            "SELECT name, spec_json, default_scope, last_evaluated_at
             FROM pm_routines WHERE enabled = 1",
        )
        .map_err(|err| format!("scheduled candidates: {err}"))?;
    let rows: Vec<(String, String, Option<String>, Option<i64>)> = statement
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .map_err(|err| format!("scheduled candidates: {err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("scheduled candidates: {err}"))?;
    let mut candidates = Vec::new();
    for (name, spec_json, default_scope, last_evaluated_at) in rows {
        let Ok(file) = serde_json::from_str::<spec::RoutineSpecFile>(&spec_json) else {
            continue;
        };
        for activation in &file.spec.activations {
            if let spec::Activation::Schedule {
                cron,
                timezone,
                policies,
            } = activation
            {
                candidates.push(ScheduledCandidate {
                    name: name.clone(),
                    cron: cron.clone(),
                    timezone: timezone.clone(),
                    concurrency: policies
                        .concurrency_policy
                        .unwrap_or(spec::ConcurrencyPolicy::Skip),
                    catch_up: policies.catch_up.unwrap_or(spec::CatchUpPolicy::None),
                    default_scope: default_scope.clone(),
                    last_evaluated_at,
                });
            }
        }
    }
    Ok(candidates)
}

/// Persist the scheduler watermark after an evaluation pass.
pub fn mark_evaluated(name: &str, evaluated_at: i64, next_fire_at: Option<i64>) -> Result<(), String> {
    let connection = project_io::helpers::conn()?;
    connection
        .execute(
            "UPDATE pm_routines SET last_evaluated_at = ?2, next_fire_at = ?3 WHERE name = ?1",
            rusqlite::params![name, evaluated_at, next_fire_at],
        )
        .map_err(|err| format!("routine mark_evaluated: {err}"))?;
    Ok(())
}

/// True when the routine has a non-terminal run (running or pending).
pub fn has_active_run(name: &str) -> Result<bool, String> {
    let connection = project_io::helpers::conn()?;
    let count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM pm_routine_runs
             WHERE routine_name = ?1 AND status IN ('running', 'pending')",
            rusqlite::params![name],
            |row| row.get(0),
        )
        .map_err(|err| format!("routine has_active_run: {err}"))?;
    Ok(count > 0)
}

/// Audit a suppressed automatic fire (skip/coalesce/queue while active).
pub fn audit_suppressed_fire(name: &str, policy: &str, scheduled_at: i64) -> Result<(), String> {
    let mut connection = project_io::helpers::conn()?;
    let tx = connection
        .transaction()
        .map_err(|err| format!("suppressed fire tx: {err}"))?;
    let seq = work_service::audit::bump_change_seq(&tx)?;
    work_service::audit::append_audit_event(
        &tx,
        &work_service::audit::AuditEventRow {
            operation: "routine.fire_suppressed",
            entity_type: "routine",
            entity_id: name,
            project_slug: None,
            org_id: None,
            actor: None,
            revision: 0,
            seq,
            payload: serde_json::json!({ "policy": policy, "scheduledAt": scheduled_at }),
        },
    )?;
    tx.commit()
        .map_err(|err| format!("suppressed fire commit: {err}"))
}

/// List routine definitions (name, revision, enabled, hash).
pub fn list_routines() -> Result<Vec<serde_json::Value>, String> {
    let connection = project_io::helpers::conn()?;
    let mut statement = connection
        .prepare(
            "SELECT name, routine_id, revision, enabled, spec_hash, updated_at
             FROM pm_routines ORDER BY name",
        )
        .map_err(|err| format!("routine list: {err}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok(serde_json::json!({
                "name": row.get::<_, String>(0)?,
                "routineId": row.get::<_, String>(1)?,
                "revision": row.get::<_, i64>(2)?,
                "enabled": row.get::<_, i64>(3)? != 0,
                "specHash": row.get::<_, String>(4)?,
                "updatedAt": row.get::<_, i64>(5)?,
            }))
        })
        .map_err(|err| format!("routine list: {err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("routine list: {err}"))?;
    Ok(rows)
}

/// Enable/disable automatic activations. Manual `routine run` stays
/// available on disabled routines by contract.
pub fn set_enabled(name: &str, enabled: bool) -> Result<(), String> {
    let connection = project_io::helpers::conn()?;
    let changed = connection
        .execute(
            "UPDATE pm_routines SET enabled = ?2, updated_at = ?3 WHERE name = ?1",
            rusqlite::params![name, enabled as i64, chrono::Utc::now().timestamp_millis()],
        )
        .map_err(|err| format!("routine set_enabled: {err}"))?;
    if changed == 0 {
        return Err(format!("Routine '{}' not found", name));
    }
    Ok(())
}

/// List routine runs, newest first, optionally filtered to one scope.
/// Row-level listing for the Runs surface — per-run WorkItem projection
/// stays in [`run_status`], which the UI calls on expand.
pub fn list_runs(
    scope_id: Option<&str>,
    limit: usize,
) -> Result<Vec<serde_json::Value>, String> {
    let connection = project_io::helpers::conn()?;
    let mut statement = connection
        .prepare(
            "SELECT id, routine_name, routine_revision, scope_id, status,
                    root_work_item_id, created_by, created_at, updated_at
             FROM pm_routine_runs
             WHERE (?1 IS NULL OR scope_id = ?1)
             ORDER BY created_at DESC, id DESC
             LIMIT ?2",
        )
        .map_err(|err| format!("routine list_runs: {err}"))?;
    let rows = statement
        .query_map(rusqlite::params![scope_id, limit as i64], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "routineName": row.get::<_, String>(1)?,
                "routineRevision": row.get::<_, i64>(2)?,
                "scopeId": row.get::<_, String>(3)?,
                "status": row.get::<_, String>(4)?,
                "rootWorkItemId": row.get::<_, Option<String>>(5)?,
                "createdBy": row.get::<_, Option<String>>(6)?,
                "createdAt": row.get::<_, i64>(7)?,
                "updatedAt": row.get::<_, i64>(8)?,
            }))
        })
        .map_err(|err| format!("routine list_runs: {err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("routine list_runs: {err}"))?;
    Ok(rows)
}

/// Durable run-status view: the run row plus each generated WorkItem's
/// state, with the overall status recomputed by the ordered decision
/// procedure from design §11 (cancel machinery lands in Phase 5, so the
/// cancel rules short-circuit to the stored status for now).
pub fn run_status(run_id: &str) -> Result<serde_json::Value, String> {
    let connection = project_io::helpers::conn()?;
    let (routine_name, revision, snapshot_hash, scope_id, stored_status, root_id): (
        String,
        i64,
        String,
        String,
        String,
        Option<String>,
    ) = connection
        .query_row(
            "SELECT routine_name, routine_revision, snapshot_hash, scope_id, status,
                    root_work_item_id
             FROM pm_routine_runs WHERE id = ?1",
            rusqlite::params![run_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .map_err(|err| match err {
            rusqlite::Error::QueryReturnedNoRows => format!("Run '{}' not found", run_id),
            other => format!("routine status: {other}"),
        })?;

    // Generated children: reverse lookup on the generated_by relation.
    let mut statement = connection
        .prepare(
            "SELECT entity_id FROM pm_relations
             WHERE kind = 'generated_by' AND target_ref = ?1
             ORDER BY id",
        )
        .map_err(|err| format!("routine status: {err}"))?;
    let child_ids: Vec<String> = statement
        .query_map(rusqlite::params![format!("run://{run_id}")], |row| {
            row.get(0)
        })
        .map_err(|err| format!("routine status: {err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("routine status: {err}"))?;
    drop(statement);
    drop(connection);

    let mut items = Vec::new();
    let mut portable_states = Vec::new();
    for child_id in &child_ids {
        let item = project_io::read_work_item(&scope_id, child_id)?;
        let portable = work_service::state::map_legacy_status(&item.frontmatter.status);
        portable_states.push(portable);
        items.push(serde_json::json!({
            "shortId": child_id,
            "title": item.frontmatter.title,
            "status": item.frontmatter.status,
            "portableState": portable.map(|state| state.as_str()),
        }));
    }

    let status = project_run_status(&stored_status, &portable_states, &child_ids, &scope_id)?;

    Ok(serde_json::json!({
        "apiVersion": "orgtrack/v1",
        "kind": "RoutineRun",
        "id": run_id,
        "routineName": routine_name,
        "routineRevision": revision,
        "snapshotHash": snapshot_hash,
        "scopeId": scope_id,
        "status": status,
        "rootWorkItemId": root_id,
        "workItems": items,
    }))
}

/// Ordered first-match projection (§11). Rules 1-3 (queue pending /
/// cancel) short-circuit to the stored status until Phase 5 lands the
/// cancel machinery; rules 4-7 compute from the generated items.
fn project_run_status(
    stored: &str,
    portable_states: &[Option<work_service::WorkItemState>],
    child_ids: &[String],
    scope_id: &str,
) -> Result<String, String> {
    use work_service::WorkItemState::*;
    if stored == "pending" || stored.starts_with("cancel") || stored == "cancelled" {
        return Ok(stored.to_string());
    }
    if portable_states.contains(&Some(Failed)) {
        return Ok("failed".into());
    }
    if !portable_states.is_empty() && portable_states.iter().all(|s| *s == Some(Completed)) {
        return Ok("succeeded".into());
    }
    let any_in_progress = portable_states.contains(&Some(InProgress));
    if any_in_progress {
        return Ok("running".into());
    }
    // Ready open work: open with all dependencies completed.
    let connection = project_io::helpers::conn()?;
    for (index, child_id) in child_ids.iter().enumerate() {
        if portable_states[index] != Some(Open) {
            continue;
        }
        let mut statement = connection
            .prepare(
                "SELECT target_ref FROM pm_relations
                 WHERE kind = 'depends_on' AND entity_type = 'work_item' AND entity_id = ?1",
            )
            .map_err(|err| format!("routine status: {err}"))?;
        let dependencies: Vec<String> = statement
            .query_map(rusqlite::params![child_id], |row| row.get(0))
            .map_err(|err| format!("routine status: {err}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| format!("routine status: {err}"))?;
        let all_done = dependencies.iter().all(|target| {
            target
                .strip_prefix(&format!("work://{scope_id}/"))
                .map(|dep_id| {
                    child_ids
                        .iter()
                        .position(|c| c == dep_id)
                        .map(|position| portable_states[position] == Some(Completed))
                        .unwrap_or(true)
                })
                .unwrap_or(true)
        });
        if all_done {
            return Ok("running".into());
        }
    }
    Ok("blocked".into())
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;

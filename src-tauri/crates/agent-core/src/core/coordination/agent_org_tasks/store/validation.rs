//! Pre-write validation guards shared across the task write paths: run
//! mutability, text-field limits, and the persistence invariants that keep
//! ownership, eligibility, roles, execution mode, and output metadata coherent
//! with the run roster.

use std::collections::HashSet;

use rusqlite::{params, OptionalExtension};

use crate::coordination::agent_org_payload_limits::{
    validate_optional_text, validate_required_text, validate_task_eligible_member_ids,
    validate_task_identifier, validate_text_len, TASK_ACTIVE_FORM_MAX_BYTES,
    TASK_ACTIVE_FORM_MAX_CHARS, TASK_DESCRIPTION_MAX_BYTES, TASK_DESCRIPTION_MAX_CHARS,
    TASK_OUTPUT_CONTENT_MAX_BYTES, TASK_OUTPUT_CONTENT_MAX_CHARS, TASK_OUTPUT_SUMMARY_MAX_BYTES,
    TASK_OUTPUT_SUMMARY_MAX_CHARS, TASK_RUN_MAX_OPEN_TASKS, TASK_SUBJECT_MAX_BYTES,
    TASK_SUBJECT_MAX_CHARS,
};

use super::super::{
    task_execution_mode, Task, TaskExecutionMode, TaskStatus, TASK_RUN_TASK_LIMIT_ERROR,
};

pub(super) fn ensure_task_rows_safe_for_operational_projection(
    conn: &rusqlite::Connection,
    run_id: &str,
) -> Result<(), String> {
    if super::dependencies::run_is_safe_for_operational_projection(conn, run_id)? {
        Ok(())
    } else {
        Err(
            "Agent Org task board contains oversized or corrupt rows; operational projection refused"
                .to_string(),
        )
    }
}

pub(super) fn ensure_task_run_capacity(
    existing_open_count: usize,
    incoming_count: usize,
) -> Result<(), String> {
    let projected_count = existing_open_count.checked_add(incoming_count).ok_or_else(|| {
        format!(
            "{TASK_RUN_TASK_LIMIT_ERROR}: task count overflow while checking the Agent Org run capacity"
        )
    })?;
    if projected_count <= TASK_RUN_MAX_OPEN_TASKS {
        return Ok(());
    }
    Err(format!(
        "{TASK_RUN_TASK_LIMIT_ERROR}: run retains {existing_open_count} open tasks and this mutation would add {incoming_count}; maximum open work is {TASK_RUN_MAX_OPEN_TASKS}"
    ))
}

#[cfg(test)]
pub(super) fn reject_writable_blocks(blocks: &[String]) -> Result<(), String> {
    if blocks.is_empty() {
        Ok(())
    } else {
        Err(
            "task `blocks` is a derived field; write canonical `blocked_by` dependencies instead"
                .to_string(),
        )
    }
}

pub(super) fn ensure_run_allows_task_mutation(
    conn: &rusqlite::Connection,
    org_run_id: &str,
) -> Result<(), String> {
    let run: Option<(String, i64)> = conn
        .query_row(
            "SELECT status,activation_generation
             FROM agent_org_runtime_runs WHERE id=?1",
            params![org_run_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|err| err.to_string())?;
    let (status, activation_generation) = match run {
        Some(run) => run,
        None => return Err(format!("agent_org_run_not_found: {org_run_id}")),
    };
    if status != "running" {
        return Err(crate::coordination::agent_org_runs::mutation_blocked_error(
            org_run_id, &status,
        ));
    }
    ensure_current_generation_has_no_certificate(conn, org_run_id, activation_generation)
}

/// Freeze the exact formal work episode once its completion certificate exists.
///
/// Graph-writer admission owns the separate Running/Idle/Paused decision: an
/// authorized UserDirected Writer may atomically reactivate an Idle Team, and
/// a Paused Team must retain its specific resume-required error. This helper
/// therefore checks the stable work episode. A newer authorization generation
/// may open a new episode after the previous one has reached Idle.
pub(super) fn ensure_current_generation_has_no_certificate(
    conn: &rusqlite::Connection,
    org_run_id: &str,
    activation_generation: i64,
) -> Result<(), String> {
    // A current-generation certificate is an immutable fence even if its
    // companion episode row is missing or corrupt.
    let raw_generation_certificate: bool = conn
        .query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM agent_org_runtime_run_completion_certificates
                 WHERE org_run_id=?1 AND activation_generation=?2
             )",
            params![org_run_id, activation_generation],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if raw_generation_certificate {
        return Err("agent_org_task_mutation_after_completion_certificate".to_string());
    }
    let active =
        crate::coordination::agent_org_work_episodes::active_with_connection(conn, org_run_id)?;
    if active.is_some() {
        return Ok(());
    }
    let latest =
        crate::coordination::agent_org_work_episodes::current_with_connection(conn, org_run_id)?;
    if latest.is_some_and(|episode| {
        episode
            .closing_activation_generation
            .is_some_and(|closing| closing >= activation_generation)
    }) {
        return Err("agent_org_task_mutation_after_completion_certificate".to_string());
    }
    Ok(())
}

pub(super) fn validate_task_text_fields(
    subject: &str,
    description: &str,
    active_form: Option<&str>,
) -> Result<(), String> {
    validate_required_text(
        "task subject",
        subject,
        TASK_SUBJECT_MAX_CHARS,
        TASK_SUBJECT_MAX_BYTES,
    )?;
    validate_text_len(
        "task description",
        description,
        TASK_DESCRIPTION_MAX_CHARS,
        TASK_DESCRIPTION_MAX_BYTES,
    )?;
    validate_optional_text(
        "task active_form",
        active_form,
        TASK_ACTIVE_FORM_MAX_CHARS,
        TASK_ACTIVE_FORM_MAX_BYTES,
    )
}

fn collect_roster_member_ids(
    members: &[crate::definitions::orgs::FlatOrgMember],
    out: &mut HashSet<String>,
) {
    for member in members {
        out.insert(member.member_id.clone());
    }
}

#[cfg(test)]
pub(super) fn validate_task_persistence_invariants(
    conn: &rusqlite::Connection,
    org_run_id: &str,
    owner: Option<&str>,
    status: TaskStatus,
    metadata: Option<&serde_json::Value>,
) -> Result<(), String> {
    if let Some(owner) = owner {
        validate_task_identifier("task owner_member_id", owner)?;
    }
    let metadata_object = match metadata {
        None => None,
        Some(serde_json::Value::Object(object)) => Some(object),
        Some(_) => return Err("task metadata must be a JSON object".to_string()),
    };

    let mut eligible_member_ids = Vec::new();
    if let Some(value) =
        metadata_object.and_then(|object| object.get(super::TASK_METADATA_ELIGIBLE_MEMBER_IDS))
    {
        let values = value.as_array().ok_or_else(|| {
            "eligible_member_ids must be an array of member_id strings".to_string()
        })?;
        let raw_member_ids = values
            .iter()
            .map(|value| {
                value.as_str().map(str::to_string).ok_or_else(|| {
                    "eligible_member_ids must contain only non-empty member_id strings".to_string()
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        validate_task_eligible_member_ids("eligible_member_ids", &raw_member_ids)?;
        let mut seen = HashSet::new();
        for value in values {
            let member_id = value
                .as_str()
                .map(str::trim)
                .filter(|member_id| !member_id.is_empty())
                .ok_or_else(|| {
                    "eligible_member_ids must contain only non-empty member_id strings".to_string()
                })?;
            if member_id == crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID {
                return Err("eligible_member_ids cannot include coordinator".to_string());
            }
            if seen.insert(member_id.to_string()) {
                eligible_member_ids.push(member_id.to_string());
            }
        }
    }
    if owner.is_none() && status == TaskStatus::Pending && eligible_member_ids.is_empty() {
        return Err("ownerless pending tasks require a non-empty eligible_member_ids list".into());
    }

    if let Some(required_role) =
        metadata_object.and_then(|object| object.get(super::TASK_METADATA_REQUIRED_ROLE))
    {
        let Some(required_role) = required_role.as_str() else {
            return Err("required_role must be a non-empty string".to_string());
        };
        validate_required_text(
            "required_role",
            required_role,
            crate::coordination::agent_org_payload_limits::TASK_REQUIRED_ROLE_MAX_CHARS,
            crate::coordination::agent_org_payload_limits::TASK_REQUIRED_ROLE_MAX_BYTES,
        )?;
    }

    if let Some(execution_mode) =
        metadata_object.and_then(|object| object.get(super::TASK_METADATA_EXECUTION_MODE))
    {
        let execution_mode = execution_mode
            .as_str()
            .ok_or_else(|| "execution_mode must be build or plan".to_string())?;
        super::TaskExecutionMode::from_wire(execution_mode)?;
    }

    let task_output = metadata_object
        .and_then(|object| object.get(super::TASK_METADATA_OUTPUT))
        .map(|value| {
            serde_json::from_value::<super::TaskOutput>(value.clone())
                .map_err(|err| format!("task output has invalid shape: {err}"))
        })
        .transpose()?;
    if let Some(output) = task_output.as_ref() {
        if status != TaskStatus::Completed {
            return Err("task output is only valid for completed tasks".to_string());
        }
        validate_required_text(
            "task output summary",
            &output.summary,
            TASK_OUTPUT_SUMMARY_MAX_CHARS,
            TASK_OUTPUT_SUMMARY_MAX_BYTES,
        )?;
        validate_optional_text(
            "task output content",
            output.content.as_deref(),
            TASK_OUTPUT_CONTENT_MAX_CHARS,
            TASK_OUTPUT_CONTENT_MAX_BYTES,
        )?;
        validate_task_identifier(
            "task output produced_by_member_id",
            &output.produced_by_member_id,
        )?;
        if chrono::DateTime::parse_from_rfc3339(&output.produced_at).is_err() {
            return Err("task output produced_at must be a valid RFC3339 timestamp".to_string());
        }
        crate::coordination::agent_org_payload_limits::validate_task_artifact_ids(
            "task output artifact_ids",
            &output.artifact_ids,
        )?;
    }

    let snapshot_json: Option<String> = conn
        .query_row(
            "SELECT org_snapshot_json FROM agent_org_runtime_runs WHERE id=?1",
            params![org_run_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| err.to_string())?
        .flatten();
    if let Some(snapshot_json) = snapshot_json {
        let snapshot: crate::definitions::orgs::AgentOrgLaunchSnapshot =
            serde_json::from_str(&snapshot_json).map_err(|err| {
                format!("invalid Agent Org launch snapshot for {org_run_id}: {err}")
            })?;
        crate::definitions::orgs::validate_launch_snapshot(&snapshot)
            .map_err(|err| format!("invalid Agent Org launch snapshot for {org_run_id}: {err}"))?;
        let mut roster = HashSet::new();
        collect_roster_member_ids(&snapshot.members, &mut roster);
        for member_id in &eligible_member_ids {
            if !roster.contains(member_id) {
                return Err(format!(
                    "eligible_member_ids contains member outside run roster: {member_id}"
                ));
            }
        }
        if let Some(owner) = owner {
            if owner != crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID
                && !roster.contains(owner)
            {
                return Err(format!("owner is outside run roster: {owner}"));
            }
        }
        if let Some(output) = task_output.as_ref() {
            let producer = output.produced_by_member_id.as_str();
            if producer != crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID
                && !roster.contains(producer)
            {
                return Err(format!(
                    "task output producer is outside run roster: {producer}"
                ));
            }
        }
    }
    Ok(())
}

pub(super) fn validate_task_model_invariants(
    conn: &rusqlite::Connection,
    task: &Task,
) -> Result<(), String> {
    validate_task_text_fields(
        &task.subject,
        &task.description,
        task.active_form.as_deref(),
    )?;
    validate_task_identifier("task id", &task.id)?;
    validate_task_identifier(
        "task created_by_participant_id",
        &task.created_by_participant_id,
    )?;
    validate_task_identifier("task source_turn_intent_id", &task.source_turn_intent_id)?;
    if let Some(message_id) = task.originating_message_id.as_deref() {
        validate_task_identifier("task originating_message_id", message_id)?;
    }
    if let Some(replaces_task_id) = task.replaces_task_id.as_deref() {
        validate_task_identifier("task replaces_task_id", replaces_task_id)?;
    }
    if let Some(owner) = task.owner.as_deref() {
        validate_task_identifier("task owner_member_id", owner)?;
        if owner == crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID {
            return Err("task owner cannot be coordinator".to_string());
        }
    }
    if matches!(
        task.status,
        TaskStatus::InProgress | TaskStatus::Completed | TaskStatus::Failed
    ) && task.owner.is_none()
    {
        return Err(format!(
            "{} task must retain its canonical owner",
            task.status.as_wire()
        ));
    }
    match task.status {
        TaskStatus::Pending | TaskStatus::InProgress => {
            if task.output.is_some()
                || task.failure_reason.is_some()
                || task.cancel_reason.is_some()
            {
                return Err("open task cannot contain terminal result fields".to_string());
            }
        }
        TaskStatus::Completed => {
            if task.output.is_none()
                || task.failure_reason.is_some()
                || task.cancel_reason.is_some()
            {
                return Err("completed task requires only output".to_string());
            }
        }
        TaskStatus::Failed => {
            if task.output.is_some()
                || task.failure_reason.is_none()
                || task.cancel_reason.is_some()
            {
                return Err("failed task requires only failure_reason".to_string());
            }
        }
        TaskStatus::Cancelled => {
            if task.output.is_some()
                || task.failure_reason.is_some()
                || task.cancel_reason.is_none()
            {
                return Err("cancelled task requires only cancel_reason".to_string());
            }
        }
    }
    if let Some(output) = task.output.as_ref() {
        match (
            task_execution_mode(task),
            output.plan_revision_id.as_deref(),
        ) {
            (TaskExecutionMode::Plan, None) => {
                return Err(
                    "plan_task_requires_formal_plan_revision: submit the plan with create_plan; ordinary task completion is not allowed"
                        .to_string(),
                );
            }
            (TaskExecutionMode::Build, Some(_)) => {
                return Err(
                    "build_task_output_cannot_reference_plan_revision: plan revisions belong only to planning tasks"
                        .to_string(),
                );
            }
            (TaskExecutionMode::Plan, Some(_)) | (TaskExecutionMode::Build, None) => {}
        }
        validate_required_text(
            "task output summary",
            &output.summary,
            TASK_OUTPUT_SUMMARY_MAX_CHARS,
            TASK_OUTPUT_SUMMARY_MAX_BYTES,
        )?;
        validate_optional_text(
            "task output content",
            output.content.as_deref(),
            TASK_OUTPUT_CONTENT_MAX_CHARS,
            TASK_OUTPUT_CONTENT_MAX_BYTES,
        )?;
        validate_task_identifier(
            "task output produced_by_member_id",
            &output.produced_by_member_id,
        )?;
        if task.owner.as_deref() != Some(output.produced_by_member_id.as_str()) {
            return Err("task output producer must equal the canonical task owner".to_string());
        }
        if chrono::DateTime::parse_from_rfc3339(&output.produced_at).is_err() {
            return Err("task output produced_at must be RFC3339".to_string());
        }
        crate::coordination::agent_org_payload_limits::validate_task_artifact_ids(
            "task output artifact_ids",
            &output.artifact_ids,
        )?;
    }
    for (label, reason) in [
        ("task failure reason", task.failure_reason.as_ref()),
        ("task cancel reason", task.cancel_reason.as_ref()),
    ] {
        if let Some(reason) = reason {
            validate_required_text(&format!("{label} code"), &reason.code, 128, 512)?;
            validate_required_text(&format!("{label} message"), &reason.message, 2_000, 8_000)?;
        }
    }
    let metadata_object = match task.metadata.as_ref() {
        None => None,
        Some(serde_json::Value::Object(object)) => Some(object),
        Some(_) => return Err("task metadata must be a JSON object".to_string()),
    };
    if metadata_object.is_some_and(|object| {
        object.contains_key(super::TASK_METADATA_EXECUTION_MODE)
            || object.contains_key(super::TASK_METADATA_OUTPUT)
    }) {
        return Err(
            "task metadata cannot contain reserved output or execution_mode fields".to_string(),
        );
    }

    let mut eligible_member_ids = Vec::new();
    if let Some(value) =
        metadata_object.and_then(|object| object.get(super::TASK_METADATA_ELIGIBLE_MEMBER_IDS))
    {
        let ids = value
            .as_array()
            .ok_or_else(|| "eligible_member_ids must be an array".to_string())?
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_string)
                    .ok_or_else(|| "eligible_member_ids must contain strings".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        validate_task_eligible_member_ids("eligible_member_ids", &ids)?;
        if ids
            .iter()
            .any(|id| id == crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID)
        {
            return Err("eligible_member_ids cannot include coordinator".to_string());
        }
        eligible_member_ids = ids;
    }
    if task.owner.is_none() && task.status == TaskStatus::Pending && eligible_member_ids.is_empty()
    {
        return Err("ownerless pending tasks require eligible_member_ids".to_string());
    }
    if let Some(required_role) =
        metadata_object.and_then(|object| object.get(super::TASK_METADATA_REQUIRED_ROLE))
    {
        let required_role = required_role
            .as_str()
            .ok_or_else(|| "required_role must be a string".to_string())?;
        validate_required_text(
            "required_role",
            required_role,
            crate::coordination::agent_org_payload_limits::TASK_REQUIRED_ROLE_MAX_CHARS,
            crate::coordination::agent_org_payload_limits::TASK_REQUIRED_ROLE_MAX_BYTES,
        )?;
    }

    let snapshot_json: String = conn
        .query_row(
            "SELECT org_snapshot_json FROM agent_org_runtime_runs WHERE id=?1",
            params![&task.org_run_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .flatten()
        .ok_or_else(|| "task actor snapshot missing".to_string())?;
    let snapshot: crate::definitions::orgs::AgentOrgLaunchSnapshot =
        serde_json::from_str(&snapshot_json)
            .map_err(|error| format!("task actor snapshot invalid: {error}"))?;
    crate::definitions::orgs::validate_launch_snapshot(&snapshot)
        .map_err(|error| format!("task actor snapshot invalid: {error}"))?;
    let mut roster = HashSet::new();
    collect_roster_member_ids(&snapshot.members, &mut roster);
    for member_id in eligible_member_ids.iter().chain(task.owner.iter()) {
        if !roster.contains(member_id) {
            return Err(format!(
                "task participant is outside run roster: {member_id}"
            ));
        }
    }
    Ok(())
}

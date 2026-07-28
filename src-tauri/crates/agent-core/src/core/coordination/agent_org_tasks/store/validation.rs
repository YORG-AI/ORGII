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
    TASK_OUTPUT_SUMMARY_MAX_CHARS, TASK_RUN_MAX_TASKS, TASK_SUBJECT_MAX_BYTES,
    TASK_SUBJECT_MAX_CHARS,
};

use super::super::{TaskStatus, TASK_RUN_TASK_LIMIT_ERROR};

pub(super) fn ensure_task_rows_safe_for_operational_projection(
    conn: &rusqlite::Connection,
    run_id: &str,
) -> Result<(), String> {
    if super::dependencies::run_is_safe_for_dependency_normalization(conn, run_id)? {
        Ok(())
    } else {
        Err(
            "Agent Org task board contains oversized or corrupt rows; operational projection refused"
                .to_string(),
        )
    }
}

pub(super) fn ensure_task_run_capacity(
    existing_count: usize,
    incoming_count: usize,
) -> Result<(), String> {
    let projected_count = existing_count.checked_add(incoming_count).ok_or_else(|| {
        format!(
            "{TASK_RUN_TASK_LIMIT_ERROR}: task count overflow while checking the Agent Org run capacity"
        )
    })?;
    if projected_count <= TASK_RUN_MAX_TASKS {
        return Ok(());
    }
    Err(format!(
        "{TASK_RUN_TASK_LIMIT_ERROR}: run retains {existing_count} tasks and this mutation would add {incoming_count}; maximum total is {TASK_RUN_MAX_TASKS}"
    ))
}

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
    let status: Option<String> = conn
        .query_row(
            "SELECT status FROM agent_org_runs WHERE id=?1",
            params![org_run_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| err.to_string())?;
    let status = match status {
        Some(status) => status,
        None => return Err(format!("agent_org_run_not_found: {org_run_id}")),
    };
    if status != "running" {
        return Err(format!(
            "agent_org_run_not_mutable: run {org_run_id} is {status}",
        ));
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
    members: &[crate::definitions::orgs::OrgMember],
    out: &mut HashSet<String>,
) {
    for member in members {
        out.insert(member.id.clone());
        collect_roster_member_ids(&member.children, out);
    }
}

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
            "SELECT org_snapshot_json FROM agent_org_runs WHERE id=?1",
            params![org_run_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| err.to_string())?
        .flatten();
    if let Some(snapshot_json) = snapshot_json {
        let snapshot: crate::definitions::orgs::OrgDefinition =
            serde_json::from_str(&snapshot_json).map_err(|err| {
                format!("invalid Agent Org launch snapshot for {org_run_id}: {err}")
            })?;
        let mut roster = HashSet::new();
        collect_roster_member_ids(&snapshot.children, &mut roster);
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

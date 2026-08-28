use rusqlite::{params, OptionalExtension};
use sha2::Digest;
use std::collections::HashMap;

const SUMMARY_CONTEXT_MAX_BYTES: usize = 128 * 1024;
const REQUESTED_SUMMARY_MAX_BYTES: usize = 8 * 1024;

pub(crate) fn summary_context_for_turn(
    session_id: &str,
    turn_intent_id: &str,
) -> Result<Option<String>, String> {
    let conn = database::db::get_connection().map_err(|error| error.to_string())?;
    let source: Option<(String, String, String)> = conn
        .query_row(
            "SELECT receipt.org_run_id,receipt.certificate_id,receipt.evidence_digest
             FROM agent_org_runtime_final_summary_receipts receipt
             JOIN agent_org_runtime_run_completion_certificates certificate
               ON certificate.id=receipt.certificate_id
             WHERE receipt.coordinator_session_id=?1 AND receipt.turn_intent_id=?2
               AND receipt.status IN ('running','persisting')",
            params![session_id, turn_intent_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some((run_id, certificate_id, evidence_digest)) = source else {
        return Ok(None);
    };
    let certificate = crate::coordination::agent_org_run_completion::load_with_connection(
        &conn,
        &certificate_id,
    )?
    .ok_or_else(|| "final_summary_certificate_not_found".to_string())?;
    if certificate.org_run_id != run_id {
        return Err("final_summary_certificate_run_mismatch".to_string());
    }
    let tasks = crate::coordination::agent_org_tasks::AgentOrgTaskStore::list_with_connection(
        &conn, &run_id,
    )?;
    let tasks_by_id = tasks
        .iter()
        .map(|task| (task.id.as_str(), task))
        .collect::<HashMap<_, _>>();
    let mut task_evidence = Vec::with_capacity(certificate.task_output_refs.len());
    for reference in &certificate.task_output_refs {
        let task = tasks_by_id
            .get(reference.task_id.as_str())
            .ok_or_else(|| format!("final_summary_task_missing:{}", reference.task_id))?;
        if task.status != crate::coordination::agent_org_tasks::TaskStatus::Completed {
            return Err(format!(
                "final_summary_referenced_task_not_completed:{}",
                reference.task_id
            ));
        }
        let output = task
            .output
            .as_ref()
            .ok_or_else(|| format!("final_summary_output_missing:{}", reference.task_id))?;
        let canonical = serde_json::to_vec(output).map_err(|error| error.to_string())?;
        let actual_digest = format!("{:x}", sha2::Sha256::digest(canonical));
        if actual_digest != reference.output_digest {
            return Err(format!(
                "final_summary_output_digest_mismatch:{}",
                reference.task_id
            ));
        }
        task_evidence.push(serde_json::json!({
            "taskId": task.id,
            "subject": task.subject,
            "status": task.status,
            "outputDigest": actual_digest,
            "output": output,
        }));
    }
    let terminal_resolutions = certificate
        .resolution_links
        .iter()
        .filter_map(|resolution| {
            let task = tasks_by_id.get(resolution.task_id.as_str())?;
            matches!(
                task.status,
                crate::coordination::agent_org_tasks::TaskStatus::Failed
                    | crate::coordination::agent_org_tasks::TaskStatus::Cancelled
            )
            .then(|| {
                serde_json::json!({
                    "resolution": resolution,
                    "taskId": task.id,
                    "subject": task.subject,
                    "status": task.status,
                    "failureReason": task.failure_reason,
                    "cancelReason": task.cancel_reason,
                })
            })
        })
        .collect::<Vec<_>>();
    let plans = crate::coordination::agent_org_plan_approvals::AgentOrgPlanRevisionStore::list_revision_summaries_by_run_with_connection(
        &conn,
        &run_id,
        100,
    )?;
    let requested_summary = truncate_utf8(&certificate.summary, REQUESTED_SUMMARY_MAX_BYTES);
    let mut context = serde_json::json!({
        "certificate": certificate,
        "evidenceDigest": evidence_digest,
        "requestedSummary": requested_summary,
        "taskEvidence": task_evidence,
        "terminalResolutions": terminal_resolutions,
        "planDecisions": plans,
    });
    let mut encoded = serde_json::to_string_pretty(&context).map_err(|error| error.to_string())?;
    if encoded.len() > SUMMARY_CONTEXT_MAX_BYTES {
        if let Some(object) = context.as_object_mut() {
            object.insert(
                "contextTruncated".to_string(),
                serde_json::Value::Bool(true),
            );
            object.remove("planDecisions");
        }
        encoded = serde_json::to_string_pretty(&context).map_err(|error| error.to_string())?;
    }
    if encoded.len() > SUMMARY_CONTEXT_MAX_BYTES {
        let mut omitted = 0u64;
        while encoded.len() > SUMMARY_CONTEXT_MAX_BYTES {
            let Some(task_evidence) = context
                .get_mut("taskEvidence")
                .and_then(serde_json::Value::as_array_mut)
            else {
                break;
            };
            if task_evidence.pop().is_none() {
                break;
            }
            omitted = omitted.saturating_add(1);
            if let Some(object) = context.as_object_mut() {
                object.insert("omittedTaskEvidenceCount".to_string(), omitted.into());
            }
            encoded = serde_json::to_string_pretty(&context).map_err(|error| error.to_string())?;
        }
    }
    if encoded.len() > SUMMARY_CONTEXT_MAX_BYTES {
        return Err("final_summary_context_exceeds_bound".to_string());
    }
    Ok(Some(format!(
        "## Agent Org Final Summary (read-only)\n\nWrite the final user-facing report from only the bounded certified evidence below. Do not call tools, mutate the Team, invent missing evidence, or continue implementation. Preserve explicit failed/cancelled resolutions and reference requested report TaskOutputs/Artifacts instead of replacing them.\n\n```json\n{encoded}\n```"
    )))
}

fn truncate_utf8(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end = end.saturating_sub(1);
    }
    value[..end].to_string()
}

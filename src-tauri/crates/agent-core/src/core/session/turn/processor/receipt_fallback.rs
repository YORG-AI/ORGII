//! Turn-end Work Item receipt fallback.
//!
//! The linked-work-item delivery mandate tells the agent every deliverable
//! must land on the Work Item through `org2-pm`, with exactly one
//! Discussion receipt per turn. When a turn completes without any
//! `work.note` from this agent on the linked item, the final assistant
//! message is the only record of the outcome — and it lives in chat, which
//! the Work Item Discussion never sees. This fallback synthesizes that
//! missing receipt from the final output so the Discussion trail stays
//! complete even when the model forgets the CLI.
//!
//! Mirrors the injection gate in `prompt.rs` (Project mode with a linked
//! `work_item_id`) and the actor derivation in the exec injection
//! kit (`agent:{definition}` after the `builtin:` trim), so the audit check
//! sees the same actor id the CLI writes carry — including subagent writes,
//! which root-walk to the same top-level session actor.

use tracing::{info, warn};

use super::{unified_persistence, UnifiedMessageProcessor};

const MIN_RECEIPT_CHARS: usize = 40;
const MAX_RECEIPT_CHARS: usize = 8_000;

/// Trim, suppress trivial acks, and clip on a char boundary. `None` means
/// the output is too small to be worth a synthesized receipt.
pub(super) fn receipt_body(response_text: &str) -> Option<String> {
    let trimmed = response_text.trim();
    if trimmed.chars().count() < MIN_RECEIPT_CHARS {
        return None;
    }
    let clipped: String = trimmed.chars().take(MAX_RECEIPT_CHARS).collect();
    Some(format!("(auto) {clipped}"))
}

impl UnifiedMessageProcessor {
    /// Fire-and-forget synthesis of the missing Discussion receipt.
    /// Failures are logged, never surfaced to the turn.
    pub(super) fn spawn_work_item_receipt_fallback(
        &self,
        session_id: &str,
        response_text: &str,
        turn_started_at_ms: i64,
    ) {
        let Some(body) = receipt_body(response_text) else {
            return;
        };
        let session_id = session_id.to_string();
        tokio::task::spawn_blocking(move || {
            if let Err(error) = synthesize_receipt_blocking(&session_id, &body, turn_started_at_ms)
            {
                warn!(
                    session_id,
                    error = %error,
                    "[receipt_fallback] failed to synthesize Work Item receipt"
                );
            }
        });
    }
}

fn synthesize_receipt_blocking(
    session_id: &str,
    body: &str,
    turn_started_at_ms: i64,
) -> Result<(), String> {
    let Some(record) = unified_persistence::get_session(session_id)
        .map_err(|err| format!("load session: {err}"))?
    else {
        return Ok(());
    };
    if record.product_mode.as_deref() != Some("project") {
        return Ok(());
    }
    let Some(work_item_id) = record.work_item_id.as_deref() else {
        return Ok(());
    };

    let agent = record
        .agent_definition_id
        .as_deref()
        .unwrap_or("os")
        .trim_start_matches("builtin:")
        .to_string();
    let actor_id = format!("agent:{agent}");

    if project_management::work_service::work_item_noted_by_actor_since(
        work_item_id,
        &actor_id,
        turn_started_at_ms,
    )? {
        return Ok(());
    }

    let actor = project_management::projects::types::WorkItemMutationActor {
        id: actor_id.clone(),
        name: agent,
    };
    match record.project_slug.as_deref() {
        Some(project_slug) => project_management::work_service::note_project_work_item(
            project_slug,
            work_item_id,
            "progress",
            body,
            Some(&actor),
        )?,
        None => {
            let org_id =
                project_management::projects::io::resolve_local_org_scope(record.org_id.as_deref());
            project_management::work_service::note_standalone_work_item(
                org_id.as_deref(),
                work_item_id,
                "progress",
                body,
                Some(&actor),
            )?
        }
    }
    info!(
        session_id,
        work_item_id, actor_id, "[receipt_fallback] synthesized turn-end Discussion receipt"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::receipt_body;

    #[test]
    fn suppresses_trivial_output() {
        assert_eq!(receipt_body("   Done.  "), None);
        assert_eq!(receipt_body(""), None);
    }

    #[test]
    fn keeps_substantial_output_with_auto_marker() {
        let text =
            "Implemented the export flow and verified the generated CSV against the fixture data.";
        let body = receipt_body(text).expect("substantial output");
        assert!(body.starts_with("(auto) Implemented"));
        assert!(body.contains("fixture data."));
    }

    #[test]
    fn clips_to_max_chars_on_char_boundary() {
        let text = "汉".repeat(9_000);
        let body = receipt_body(&text).expect("substantial output");
        assert_eq!(body.chars().count(), "(auto) ".chars().count() + 8_000);
    }
}

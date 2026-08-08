//! Project-session root WorkItem bootstrap (orgtrack/v1 §7.2).
//!
//! A Project session that has no active WorkItem gets its root created
//! when the first non-empty user submission is accepted — not when the
//! mode is switched and not when an empty session is opened. The
//! creation boundary is this host event; no LLM classification is
//! involved. The root's body preserves the original user request
//! verbatim (the derived short title never replaces it), and the
//! operation runs under a `(sessionRef)`-derived idempotency key so a
//! retried first submission cannot produce a duplicate root: if an
//! earlier attempt created the item but failed to link it, the replay
//! returns the stored short id and only the link is re-applied.

use project_management::projects::types::WorkItemMutationActor;
use project_management::work_service::{
    run_idempotent, CreateWorkItemRequest, IdempotencyOutcome,
};

const BOOTSTRAP_OPERATION: &str = "work.bootstrap";
const BOOTSTRAP_TITLE_MAX_CHARS: usize = 80;

/// Best-effort bootstrap called from the message-accept path. Failures
/// are logged, never turned into a turn error — a broken PM store must
/// not take chat down with it.
pub(super) async fn ensure_project_root_work_item(session_id: &str, content: &str) {
    if content.trim().is_empty() {
        return;
    }
    let sid = session_id.to_string();
    let body = content.to_string();
    let joined =
        tokio::task::spawn_blocking(move || bootstrap_root_work_item(&sid, &body)).await;
    match joined {
        Ok(Ok(Some(short_id))) => {
            tracing::info!(
                session_id,
                short_id,
                "[project-bootstrap] created and linked root work item"
            );
        }
        Ok(Ok(None)) => {}
        Ok(Err(err)) => {
            tracing::warn!(session_id, error = %err, "[project-bootstrap] failed");
        }
        Err(err) => {
            tracing::warn!(session_id, error = %err, "[project-bootstrap] worker failed");
        }
    }
}

/// Derive the short UI title from the first line of the request. The
/// original request stays in the body untouched.
fn derive_title(content: &str) -> String {
    let first_line = content.trim().lines().next().unwrap_or("").trim();
    let title = crate::utils::safe_truncate_chars_to_string(first_line, BOOTSTRAP_TITLE_MAX_CHARS);
    if title.is_empty() {
        "Untitled project".to_string()
    } else {
        title
    }
}

/// Blocking core, also driven directly by the `Track this` command —
/// there the "first accepted submission" already happened, so the root
/// is created from the recorded user input at conversion time.
pub(crate) fn bootstrap_root_work_item(
    session_id: &str,
    content: &str,
) -> Result<Option<String>, String> {
    let record = crate::session::persistence::get_session(session_id)
        .map_err(|err| format!("load session record: {err}"))?;
    let Some(record) = record else {
        return Ok(None);
    };
    if record.product_mode.as_deref() != Some("project") || record.work_item_id.is_some() {
        return Ok(None);
    }

    // The standalone store's org FK only accepts rows that exist in the
    // local `orgs` table. Session rows carry looser scopes: the implicit
    // personal org (`personal-org`, no row — same normalization as
    // `WorkItemTool::new`) and cloud sidebar scopes (`cloud:<uuid>`,
    // also not local rows). Anything without a local org row falls back
    // to the NULL (personal) standalone scope instead of failing the
    // insert.
    let org_id = record
        .org_id
        .clone()
        .filter(|org| org != project_management::projects::types::PERSONAL_ORG_ID)
        .filter(|org| {
            project_management::projects::io::read_project_orgs()
                .map(|orgs| orgs.iter().any(|row| &row.id == org))
                .unwrap_or(false)
        });
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
    let title = derive_title(content);
    let body = content.to_string();
    let actor_for_execute = actor.clone();
    let outcome = run_idempotent(
        &session_ref,
        BOOTSTRAP_OPERATION,
        &scope_id,
        session_id,
        &canonical,
        move || {
            let short_id = project_management::projects::io::allocate_standalone_short_id(
                org_for_execute.as_deref(),
            )?;
            let request = CreateWorkItemRequest {
                title,
                body,
                created_by: Some(actor_for_execute.id.clone()),
                ..Default::default()
            };
            project_management::work_service::create_standalone_work_item(
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
    let short_id = response
        .get("shortId")
        .and_then(|value| value.as_str())
        .ok_or_else(|| format!("bootstrap response missing shortId: {response}"))?
        .to_string();

    crate::session::persistence::link_bootstrap_work_item(session_id, &short_id)
        .map_err(|err| format!("link bootstrap work item: {err}"))?;
    Ok(Some(short_id))
}

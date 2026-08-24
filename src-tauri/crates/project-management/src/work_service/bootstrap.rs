use crate::projects::types::{WorkItemMutationActor, WorkItemOriginSession};

use super::{
    create_standalone_work_item, run_idempotent, CreateWorkItemRequest, IdempotencyOutcome,
};

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

/// Idempotent root-WorkItem creation for a Project session (`orgtrack/v1`
/// §7.2), shared by native and CLI message paths.
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

    // The key is "this session's root". Excluding content lets a retry after
    // create-then-link failure replay the same root even if content changed.
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
                origin_session: Some(WorkItemOriginSession {
                    session_id: session_id.to_string(),
                    provider: "org2".to_string(),
                    actor_id: actor_for_execute.id.clone(),
                    session_type: if session_id.starts_with("cliagent-") {
                        "cli".to_string()
                    } else {
                        "native".to_string()
                    },
                    captured_at: chrono::Utc::now().to_rfc3339(),
                }),
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

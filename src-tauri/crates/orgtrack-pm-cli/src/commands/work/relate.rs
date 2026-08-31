use std::collections::HashMap;

use project_management::work_service;

use super::require_short_id;
use crate::commands::mutation_actor;
use crate::context::ExecutionContext;
use crate::envelope::{emit_error, emit_success, CliError, ErrorCode};

pub(super) fn run(
    context: &ExecutionContext,
    short_id: Option<&String>,
    flags: &HashMap<String, String>,
) -> i32 {
    if let Err(err) = context.require_project_mode("work.relate") {
        return emit_error(err);
    }
    let scope = match context.require_scope() {
        Ok(scope) => scope.to_string(),
        Err(err) => return emit_error(err),
    };
    let short_id = match require_short_id(short_id) {
        Ok(short_id) => short_id,
        Err(err) => return emit_error(err),
    };
    let actor = match mutation_actor(context) {
        Ok(actor) => actor,
        Err(err) => return emit_error(err),
    };
    let (Some(kind), Some(target)) = (flags.get("type"), flags.get("target")) else {
        return emit_error(CliError::new(
            ErrorCode::InvalidArgument,
            "work relate requires --type <relation> and --target <ref>",
        ));
    };
    if let Some(rest) = target.strip_prefix("session://") {
        let (provider, external_id) = rest.split_once('/').unwrap_or((rest, ""));
        if let Err(err) =
            project_management::provider_host::validate_session_ref(provider, external_id)
        {
            return emit_error(CliError::new(ErrorCode::InvalidArgument, err).with_details(
                serde_json::json!({
                    "field": "--target",
                    "provider": provider,
                }),
            ));
        }
    }
    match work_service::relate_project_work_item(&scope, &short_id, kind, target, Some(&actor)) {
        Ok(()) => emit_success(
            serde_json::json!({ "related": true, "kind": kind, "targetRef": target }),
            None,
            None,
        ),
        Err(err) => {
            if err.contains("is not portable") {
                return emit_error(
                    CliError::new(
                        ErrorCode::InvalidArgument,
                        format!(
                            "Relation kind '{}' is not portable (depends_on|relates_to|duplicates|implements|supersedes|continued_by|generated_by|participated_in)",
                            kind
                        ),
                    )
                    .with_details(serde_json::json!({ "field": "--type", "value": kind })),
                );
            }
            emit_error(CliError::from_service(err))
        }
    }
}

use std::collections::{BTreeMap, HashMap};

use project_management::routine_service;

use super::mutation_actor;
use crate::context::ExecutionContext;
use crate::envelope::{emit_error, emit_success, CliError, ErrorCode};

fn load_spec_file(path: &str) -> Result<routine_service::spec::RoutineSpecFile, CliError> {
    let raw = std::fs::read_to_string(path).map_err(|err| {
        CliError::new(
            ErrorCode::InvalidArgument,
            format!("Cannot read routine file '{}': {}", path, err),
        )
    })?;
    // YAML is a superset of JSON here: one parser handles both authoring
    // formats; the canonical stored form is always JSON.
    serde_yaml::from_str(&raw).map_err(|err| {
        CliError::new(
            ErrorCode::InvalidArgument,
            format!(
                "Routine file '{}' does not match the portable spec: {}",
                path, err
            ),
        )
    })
}

fn routine_error(err: String) -> CliError {
    if let Some(details) = err.strip_prefix(routine_service::error::SPEC_INVALID) {
        let violations: serde_json::Value =
            serde_json::from_str(details.trim_start_matches(':')).unwrap_or_default();
        return CliError::new(ErrorCode::InvalidArgument, "Routine spec failed validation")
            .with_details(serde_json::json!({ "violations": violations }));
    }
    if let Some(rest) = err.strip_prefix(routine_service::error::INPUTS_INVALID) {
        return CliError::new(
            ErrorCode::InvalidArgument,
            format!("Routine inputs invalid: {}", rest.trim_start_matches(':')),
        );
    }
    CliError::from_service(err)
}

pub fn dispatch_routine(
    context: &ExecutionContext,
    positionals: &[String],
    flags: &HashMap<String, String>,
    inputs: &[(String, String)],
) -> i32 {
    match positionals.first().map(String::as_str) {
        Some("list") => match routine_service::list_routines() {
            Ok(rows) => emit_success(serde_json::json!({ "items": rows }), None, None),
            Err(err) => emit_error(CliError::from_service(err)),
        },
        Some("validate") => {
            let Some(path) = flags.get("file") else {
                return emit_error(CliError::new(
                    ErrorCode::InvalidArgument,
                    "routine validate requires --file <path>",
                ));
            };
            let file = match load_spec_file(path) {
                Ok(file) => file,
                Err(err) => return emit_error(err),
            };
            let violations = routine_service::spec::validate(&file);
            if violations.is_empty() {
                emit_success(serde_json::json!({ "valid": true }), None, None)
            } else {
                emit_error(
                    CliError::new(ErrorCode::InvalidArgument, "Routine spec failed validation")
                        .with_details(serde_json::json!({
                            "violations": serde_json::to_value(&violations).unwrap_or_default(),
                        })),
                )
            }
        }
        Some("apply") => {
            if let Err(err) = context.require_project_mode("routine.apply") {
                return emit_error(err);
            }
            let Some(path) = flags.get("file") else {
                return emit_error(CliError::new(
                    ErrorCode::InvalidArgument,
                    "routine apply requires --file <path>",
                ));
            };
            let file = match load_spec_file(path) {
                Ok(file) => file,
                Err(err) => return emit_error(err),
            };
            match routine_service::apply(&file) {
                Ok(applied) => emit_success(
                    serde_json::json!({
                        "name": applied.name,
                        "revision": applied.revision,
                        "specHash": applied.spec_hash,
                        "changed": applied.changed,
                    }),
                    Some(applied.revision),
                    None,
                ),
                Err(err) => emit_error(routine_error(err)),
            }
        }
        Some("run") => {
            if let Err(err) = context.require_project_mode("routine.run") {
                return emit_error(err);
            }
            let scope = match context.require_scope() {
                Ok(scope) => scope.to_string(),
                Err(err) => return emit_error(err),
            };
            let actor = match mutation_actor(context) {
                Ok(actor) => actor,
                Err(err) => return emit_error(err),
            };
            let Some(name) = positionals.get(1) else {
                return emit_error(CliError::new(
                    ErrorCode::InvalidArgument,
                    "Usage: org2 routine run <name> --input k=v ...",
                ));
            };
            let input_map: BTreeMap<String, String> = inputs.iter().cloned().collect();
            let invoke_key = flags.get("idempotency-key").map(String::as_str);
            match routine_service::invoke(name, &scope, &input_map, Some(&actor), invoke_key) {
                Ok(run) => emit_success(
                    serde_json::json!({
                        "runId": run.run_id,
                        "rootWorkItemId": run.root_short_id,
                        "steps": run
                            .steps
                            .iter()
                            .map(|(step, short_id)| serde_json::json!({
                                "stepId": step,
                                "workItemId": short_id,
                            }))
                            .collect::<Vec<_>>(),
                    }),
                    None,
                    None,
                ),
                Err(err) => emit_error(routine_error(err)),
            }
        }
        Some("status") => {
            let Some(run_id) = positionals.get(1) else {
                return emit_error(CliError::new(
                    ErrorCode::InvalidArgument,
                    "Usage: org2 routine status <run-id>",
                ));
            };
            match routine_service::run_status(run_id) {
                Ok(view) => emit_success(view, None, None),
                Err(err) => emit_error(CliError::from_service(err)),
            }
        }
        Some(action @ ("enable" | "disable")) => {
            if let Err(err) = context.require_project_mode("routine.set_enabled") {
                return emit_error(err);
            }
            let Some(name) = positionals.get(1) else {
                return emit_error(CliError::new(
                    ErrorCode::InvalidArgument,
                    format!("Usage: org2 routine {} <name>", action),
                ));
            };
            match routine_service::set_enabled(name, action == "enable") {
                Ok(()) => emit_success(
                    serde_json::json!({ "name": name, "enabled": action == "enable" }),
                    None,
                    None,
                ),
                Err(err) => emit_error(CliError::from_service(err)),
            }
        }
        Some("cancel") => emit_error(CliError::new(
            ErrorCode::UnsupportedCapability,
            "routine cancel lands with the Phase 5 runtime (cancel_requested machinery)",
        )),
        other => emit_error(CliError::new(
            ErrorCode::InvalidArgument,
            format!(
                "Unknown routine subcommand '{}'; expected list|validate|apply|run|status|enable|disable",
                other.unwrap_or("<none>")
            ),
        )),
    }
}

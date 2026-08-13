//! `org2-pm` — the Orgtrack PM protocol CLI (`orgtrack/v1`).
//!
//! Installed on PATH as `org2` by the distribution (the GUI binary is a
//! `windows_subsystem = "windows"` executable and cannot host a console
//! surface — frozen decision §4). Three entrances only:
//!
//! ```text
//! org2 context
//! org2 work   list|show|create|update|claim|transition|note|relate
//! org2 routine ...        (Phase 4)
//! ```
//!
//! Process model (design §13.0): short-lived console process linking the
//! same application crates as the desktop host; SQLite WAL handles the
//! multi-process story and every mutation bumps `pm_change_seq` inside
//! its transaction so the desktop reconciles incrementally.
//!
//! stdout carries exactly one JSON envelope; diagnostics go to stderr.

mod commands;
mod context;
mod envelope;

use envelope::{emit_error, CliError, ErrorCode};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = run(&args);
    std::process::exit(code);
}

/// Minimal flag parser: `--flag value` pairs plus positionals. `--json`
/// is accepted for wire-compat but JSON is already the only output mode.
/// `--input k=v` repeats and accumulates.
pub struct Parsed {
    pub positionals: Vec<String>,
    pub flags: std::collections::HashMap<String, String>,
    pub inputs: Vec<(String, String)>,
}

fn parse_args(args: &[String]) -> Result<Parsed, CliError> {
    let mut positionals = Vec::new();
    let mut flags = std::collections::HashMap::new();
    let mut inputs = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if let Some(name) = arg.strip_prefix("--") {
            if name == "json" || name == "ready" || name == "standalone" {
                flags.insert(name.to_string(), "true".to_string());
                i += 1;
                continue;
            }
            if name == "help" {
                return Err(CliError::new(
                    ErrorCode::InvalidArgument,
                    "org2-pm is JSON-envelope only. Commands: context show | \
                     work list|show|create|update|claim|transition|note|relate | \
                     routine list|validate|apply|run|status|enable|disable. \
                     Common flags: --scope <project> --mode project --actor \
                     <kind:id> --session-ref <provider:id> --idempotency-key <k>. \
                     With no project scope, work list/create use the current \
                     organization's standalone Work Items automatically"
                        .to_string(),
                ));
            }
            let value = args.get(i + 1).ok_or_else(|| {
                CliError::new(
                    ErrorCode::InvalidArgument,
                    format!("Flag --{} requires a value", name),
                )
            })?;
            if name == "input" {
                let (key, val) = value.split_once('=').ok_or_else(|| {
                    CliError::new(
                        ErrorCode::InvalidArgument,
                        format!("--input expects key=value, got '{}'", value),
                    )
                })?;
                inputs.push((key.to_string(), val.to_string()));
            } else {
                flags.insert(name.to_string(), value.clone());
            }
            i += 2;
        } else {
            positionals.push(arg.clone());
            i += 1;
        }
    }
    Ok(Parsed {
        positionals,
        flags,
        inputs,
    })
}

/// Idempotent schema init on the canonical store path — the same steps
/// the desktop host performs at startup (entry-point init parity, audit
/// Layer 9). Never a fallback to a different database.
fn ensure_schema() -> Result<(), CliError> {
    let connection = database::db::get_projects_connection()
        .map_err(|err| CliError::new(ErrorCode::StoreUnavailable, err.to_string()))?;
    project_management::projects::schema::init_project_tables(&connection)
        .map_err(|err| CliError::new(ErrorCode::StoreUnavailable, err.to_string()))?;
    Ok(())
}

fn run(args: &[String]) -> i32 {
    let parsed = match parse_args(args) {
        Ok(parsed) => parsed,
        Err(err) => return emit_error(err),
    };
    let flags = &parsed.flags;

    if let Err(err) = ensure_schema() {
        return emit_error(err);
    }

    let context = match context::resolve(
        flags.get("mode").map(String::as_str),
        flags.get("scope").map(String::as_str),
        flags.get("actor").map(String::as_str),
        flags.get("session-ref").map(String::as_str),
    ) {
        Ok(context) => context,
        Err(err) => return emit_error(err),
    };

    match parsed.positionals.first().map(String::as_str) {
        Some("context") => commands::cmd_context(&context),
        Some("work") => commands::dispatch_work(&context, &parsed.positionals[1..], flags),
        Some("project") => commands::dispatch_project(&context, &parsed.positionals[1..], flags),
        Some("routine") => {
            commands::dispatch_routine(&context, &parsed.positionals[1..], flags, &parsed.inputs)
        }
        Some(other) => emit_error(CliError::new(
            ErrorCode::InvalidArgument,
            format!(
                "Unknown command '{}'; expected context|work|project|routine",
                other
            ),
        )),
        None => emit_error(CliError::new(
            ErrorCode::InvalidArgument,
            "Usage: org2 <context|work|project|routine> ... (JSON envelope on stdout)",
        )),
    }
}

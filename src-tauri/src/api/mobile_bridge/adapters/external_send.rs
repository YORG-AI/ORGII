//! Source-aware mobile continuation for imported desktop conversations.
//!
//! Imported history is not a native ORGII agent session. For providers with
//! a verified non-interactive continuation surface, mobile resumes the
//! provider-owned conversation instead of writing to `agent_sessions`.

use std::collections::{HashMap, HashSet};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::watch;

use crate::api::mobile_bridge::fanout;
use crate::api::mobile_bridge::rpc::{RpcError, RpcErrorCode};

const MAX_CONCURRENT_EXTERNAL_SENDS: usize = 4;
const EXTERNAL_SEND_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const MAX_EXTERNAL_SEND_STDERR_BYTES: u64 = 8 * 1024;
const ROUND_ID_RETRY_DELAYS: [Duration; 6] = [
    Duration::ZERO,
    Duration::from_millis(50),
    Duration::from_millis(100),
    Duration::from_millis(200),
    Duration::from_millis(400),
    Duration::from_millis(800),
];

#[derive(Clone)]
struct ExternalSendControl {
    turn_intent_id: String,
    cancel: watch::Sender<bool>,
}

static ACTIVE_EXTERNAL_SENDS: OnceLock<Mutex<HashMap<String, ExternalSendControl>>> =
    OnceLock::new();

fn active_external_sends() -> &'static Mutex<HashMap<String, ExternalSendControl>> {
    ACTIVE_EXTERNAL_SENDS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ExternalSendCommand {
    binary: String,
    args: Vec<String>,
    cwd: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReservationResult {
    Reserved,
    Duplicate,
}

enum ExternalProcessOutcome {
    Completed,
    Exited(std::process::ExitStatus),
    Failed(String),
    Cancelled,
}

/// Wire capability for a Sidebar row. Imported sources remain visible, but
/// only Codex currently has a verified non-interactive continuation command.
pub(super) fn mobile_send_capability(
    session_id: &str,
    writable_codex_session_ids: &HashSet<String>,
) -> &'static str {
    if writable_codex_session_ids.contains(session_id) {
        "external_codex"
    } else if orgtrack_core::sources::imported_history::is_imported_history_session_id(session_id) {
        "read_only"
    } else {
        "native"
    }
}

fn codex_failure_message(status: &str, stderr: &str) -> String {
    if stderr.contains("paginated_threads is not supported yet") {
        return "This Codex conversation uses a history format that the installed Codex CLI cannot continue yet".to_string();
    }
    if stderr.contains("thread/resume") && stderr.contains("not found") {
        return "The Codex conversation could not be found by the installed Codex CLI".to_string();
    }
    format!("Codex could not continue this conversation ({status})")
}

fn reserve_external_send(
    session_id: &str,
    turn_intent_id: &str,
    cancel: watch::Sender<bool>,
) -> Result<ReservationResult, RpcError> {
    let mut active = active_external_sends()
        .lock()
        .map_err(|_| RpcError::new(RpcErrorCode::InvalidRequest, "send state unavailable"))?;
    if let Some(existing) = active.get(session_id) {
        if existing.turn_intent_id == turn_intent_id {
            return Ok(ReservationResult::Duplicate);
        }
        return Err(RpcError::new(
            RpcErrorCode::InvalidRequest,
            "This conversation is already processing a mobile message",
        ));
    }
    if active.len() >= MAX_CONCURRENT_EXTERNAL_SENDS {
        return Err(RpcError::new(
            RpcErrorCode::InvalidRequest,
            "Too many external conversations are processing messages",
        ));
    }
    active.insert(
        session_id.to_string(),
        ExternalSendControl {
            turn_intent_id: turn_intent_id.to_string(),
            cancel,
        },
    );
    Ok(ReservationResult::Reserved)
}

fn release_external_send(session_id: &str, turn_intent_id: &str) {
    if let Ok(mut active) = active_external_sends().lock() {
        if active
            .get(session_id)
            .is_some_and(|control| control.turn_intent_id == turn_intent_id)
        {
            active.remove(session_id);
        }
    }
}

fn send_status_notification(
    session_id: &str,
    turn_intent_id: &str,
    status: &str,
    message: Option<&str>,
    round_id: Option<&str>,
) -> Value {
    let mut notification = json!({
        "jsonrpc": "2.0",
        "method": "session/send_status",
        "params": {
            "sessionId": session_id,
            "turnIntentId": turn_intent_id,
            "status": status,
            "message": message,
        }
    });
    if let Some(round_id) = round_id {
        notification["params"]["roundId"] = Value::String(round_id.to_string());
    }
    notification
}

fn notify_send_status(
    session_id: &str,
    turn_intent_id: &str,
    status: &str,
    message: Option<&str>,
    round_id: Option<&str>,
) {
    let notification =
        send_status_notification(session_id, turn_intent_id, status, message, round_id);
    fanout::fanout_to_session(session_id, &notification.to_string());
}

/// Return the only newly appended authoritative turn. The overlap accepts a
/// bounded catalog dropping old head entries, but rejects rewrites, reorders,
/// and concurrent multi-turn appends instead of guessing by latest position.
fn unique_appended_turn_id(before: &[String], after: &[String]) -> Option<String> {
    if before.is_empty() {
        return (after.len() == 1).then(|| after[0].clone());
    }
    let max_overlap = before.len().min(after.len());
    let overlap = (1..=max_overlap)
        .rev()
        .find(|overlap| before[before.len() - overlap..] == after[..*overlap])?;
    (after.len() == overlap + 1).then(|| after[overlap].clone())
}

fn activity_chunk_text(chunk: &core_types::activity::ActivityChunk) -> Option<&str> {
    ["content", "message", "prompt", "text", "query"]
        .into_iter()
        .find_map(|field| chunk.args.get(field).and_then(Value::as_str))
        .or_else(|| chunk.args.as_str())
        .or_else(|| {
            ["content", "prompt", "text", "query"]
                .into_iter()
                .find_map(|field| chunk.result.get(field).and_then(Value::as_str))
        })
        .or_else(|| {
            chunk
                .result
                .get("message")
                .and_then(|message| message.get("content"))
                .and_then(Value::as_str)
        })
}

async fn resolve_external_round_id(
    session_id: &str,
    baseline_turn_ids: Option<&[String]>,
    content: &str,
) -> Option<String> {
    let baseline_turn_ids = baseline_turn_ids?;
    for delay in ROUND_ID_RETRY_DELAYS {
        if !delay.is_zero() {
            tokio::time::sleep(delay).await;
        }
        let Ok(current_turn_ids) =
            crate::orgtrack::history_commands::imported_history_cloud_turn_ids(
                session_id.to_string(),
            )
            .await
        else {
            continue;
        };
        let Some(candidate) = unique_appended_turn_id(baseline_turn_ids, &current_turn_ids) else {
            if current_turn_ids == baseline_turn_ids {
                continue;
            }
            return None;
        };
        let Ok(windows) = crate::orgtrack::history_commands::imported_history_cloud_turn_windows(
            session_id.to_string(),
            vec![candidate.clone()],
            0,
        )
        .await
        else {
            continue;
        };
        let opening_user = windows
            .first()
            .and_then(|window| {
                window.chunks.iter().find(|chunk| {
                    chunk.function
                        == orgtrack_core::sources::imported_history::FUNCTION_USER_MESSAGE
                })
            })
            .and_then(activity_chunk_text);
        if opening_user.is_some_and(|text| text.trim() == content.trim()) {
            return Some(candidate);
        }
    }
    None
}

fn codex_send_command(
    plan: &crate::orgtrack::history_commands::ExternalHistoryCliResumePlanWire,
    binary: String,
) -> Result<ExternalSendCommand, RpcError> {
    if plan.plan.source != orgtrack_core::sources::imported_history::metadata::SOURCE_CODEX_APP {
        return Err(RpcError::new(
            RpcErrorCode::InvalidRequest,
            "This imported conversation is read-only on mobile",
        ));
    }
    if !plan.source_available {
        return Err(RpcError::new(
            RpcErrorCode::SessionNotFound,
            "The Codex conversation file is no longer available",
        ));
    }
    if plan.plan.requires_cwd && !plan.cwd_exists {
        return Err(RpcError::new(
            RpcErrorCode::InvalidRequest,
            "The conversation workspace is no longer available",
        ));
    }

    Ok(ExternalSendCommand {
        binary,
        // The prompt is written to stdin. It never becomes shell syntax or a
        // process-list argument.
        args: vec![
            "exec".to_string(),
            "resume".to_string(),
            plan.plan.native_session_id.clone(),
            "-".to_string(),
        ],
        cwd: plan.plan.cwd.clone().filter(|_| plan.cwd_exists),
    })
}

async fn resolve_codex_binary() -> Result<String, RpcError> {
    tokio::task::spawn_blocking(|| {
        let resolution = integrations::cli_binary_resolver::resolve_cli_binary_for_inventory(
            "codex",
            std::env::var_os("PATH"),
        )
        .ok_or_else(|| "Codex CLI is not registered".to_string())?;
        if !resolution.installed() {
            return Err("Codex CLI is not installed or cannot be found".to_string());
        }
        Ok(resolution.command)
    })
    .await
    .map_err(|err| RpcError::new(RpcErrorCode::InvalidRequest, format!("task join: {err}")))?
    .map_err(|err| RpcError::new(RpcErrorCode::InvalidRequest, err))
}

/// Resume an imported conversation when its provider supports mobile writes.
/// Returns `Ok(None)` for native ORGII sessions so the caller can use the
/// existing agent-session submission path.
pub(super) async fn try_send_imported_session(
    session_id: &str,
    content: &str,
    turn_intent_id: &str,
) -> Result<Option<Value>, RpcError> {
    if !orgtrack_core::sources::imported_history::is_imported_history_session_id(session_id) {
        return Ok(None);
    }

    let plan =
        crate::orgtrack::history_commands::external_history_cli_resume_plan(session_id.to_string())
            .await
            .map_err(|err| RpcError::new(RpcErrorCode::InvalidRequest, err))?
            .ok_or_else(|| {
                RpcError::new(
                    RpcErrorCode::InvalidRequest,
                    "This imported conversation is read-only on mobile",
                )
            })?;
    let command = codex_send_command(&plan, resolve_codex_binary().await?)?;

    // Read before reserving so cancellation during provider I/O cannot leave a
    // stale active-send slot. Reservation still serializes the actual write.
    let baseline_turn_ids =
        crate::orgtrack::history_commands::imported_history_cloud_turn_ids(session_id.to_string())
            .await
            .ok();

    let (cancel_tx, mut cancel_rx) = watch::channel(false);
    match reserve_external_send(session_id, turn_intent_id, cancel_tx)? {
        ReservationResult::Duplicate => {
            return Ok(Some(json!({
                "accepted": true,
                "duplicate": true,
                "execution": "external_codex",
                "turnIntentId": turn_intent_id,
                "sessionId": session_id,
            })));
        }
        ReservationResult::Reserved => {}
    }

    let mut process = tokio::process::Command::new(&command.binary);
    process
        .args(&command.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(cwd) = command.cwd.as_deref() {
        process.current_dir(cwd);
    }
    #[cfg(windows)]
    process.creation_flags(app_platform::CREATE_NO_WINDOW);

    let mut child = match process.spawn() {
        Ok(child) => child,
        Err(err) => {
            release_external_send(session_id, turn_intent_id);
            return Err(RpcError::new(
                RpcErrorCode::InvalidRequest,
                format!("Could not start Codex: {err}"),
            ));
        }
    };
    let mut stdin = child.stdin.take().ok_or_else(|| {
        release_external_send(session_id, turn_intent_id);
        RpcError::new(RpcErrorCode::InvalidRequest, "Could not open Codex input")
    })?;
    let stderr_task = child.stderr.take().map(|stderr| {
        tokio::spawn(async move {
            let mut limited = stderr.take(MAX_EXTERNAL_SEND_STDERR_BYTES);
            let mut bytes = Vec::new();
            let _ = limited.read_to_end(&mut bytes).await;
            String::from_utf8_lossy(&bytes).into_owned()
        })
    });
    if let Err(err) = stdin.write_all(content.as_bytes()).await {
        let _ = child.kill().await;
        release_external_send(session_id, turn_intent_id);
        return Err(RpcError::new(
            RpcErrorCode::InvalidRequest,
            format!("Could not send input to Codex: {err}"),
        ));
    }
    drop(stdin);

    let owned_session_id = session_id.to_string();
    let owned_turn_intent_id = turn_intent_id.to_string();
    let owned_content = content.to_string();
    tokio::spawn(async move {
        let outcome = tokio::select! {
            result = child.wait() => match result {
                Ok(status) if status.success() => ExternalProcessOutcome::Completed,
                Ok(status) => ExternalProcessOutcome::Exited(status),
                Err(err) => ExternalProcessOutcome::Failed(format!("Codex process failed: {err}")),
            },
            changed = cancel_rx.changed() => {
                if changed.is_ok() && *cancel_rx.borrow() {
                    let _ = child.kill().await;
                    ExternalProcessOutcome::Cancelled
                } else {
                    let _ = child.kill().await;
                    ExternalProcessOutcome::Failed("Send controller closed".to_string())
                }
            },
            _ = tokio::time::sleep(EXTERNAL_SEND_TIMEOUT) => {
                let _ = child.kill().await;
                ExternalProcessOutcome::Failed("Codex send timed out".to_string())
            }
        };

        let stderr = match stderr_task {
            Some(task) => task.await.unwrap_or_default(),
            None => String::new(),
        };
        let round_id = if matches!(outcome, ExternalProcessOutcome::Completed) {
            resolve_external_round_id(
                &owned_session_id,
                baseline_turn_ids.as_deref(),
                &owned_content,
            )
            .await
        } else {
            None
        };
        let (status, message) = match outcome {
            ExternalProcessOutcome::Completed => ("completed", None),
            ExternalProcessOutcome::Exited(exit_status) => (
                "failed",
                Some(codex_failure_message(&exit_status.to_string(), &stderr)),
            ),
            ExternalProcessOutcome::Failed(message) => ("failed", Some(message)),
            ExternalProcessOutcome::Cancelled => ("cancelled", Some("Send cancelled".to_string())),
        };

        release_external_send(&owned_session_id, &owned_turn_intent_id);
        notify_send_status(
            &owned_session_id,
            &owned_turn_intent_id,
            status,
            message.as_deref(),
            round_id.as_deref(),
        );
    });

    Ok(Some(json!({
        "accepted": true,
        "execution": "external_codex",
        "turnIntentId": turn_intent_id,
        "sessionId": session_id,
    })))
}

pub(super) fn cancel_imported_session(session_id: &str) -> bool {
    let control = active_external_sends()
        .lock()
        .ok()
        .and_then(|active| active.get(session_id).cloned());
    control.is_some_and(|control| control.cancel.send(true).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use orgtrack_core::sources::cli_resume::CliResumePlan;

    fn codex_plan() -> crate::orgtrack::history_commands::ExternalHistoryCliResumePlanWire {
        crate::orgtrack::history_commands::ExternalHistoryCliResumePlanWire {
            plan: CliResumePlan {
                source: orgtrack_core::sources::imported_history::metadata::SOURCE_CODEX_APP,
                cli_agent_type: "codex",
                default_binary: "codex",
                resume_args: vec!["resume".to_string(), "thread-id".to_string()],
                native_session_id: "thread-id".to_string(),
                cwd: Some("/tmp/project with spaces".to_string()),
                requires_cwd: false,
            },
            display_command: "codex resume thread-id".to_string(),
            cwd_exists: true,
            source_available: true,
        }
    }

    #[test]
    fn codex_send_uses_exec_resume_and_stdin_for_prompt() {
        let command =
            codex_send_command(&codex_plan(), "/opt/codex".to_string()).expect("codex command");
        assert_eq!(command.binary, "/opt/codex");
        assert_eq!(command.args, ["exec", "resume", "thread-id", "-"]);
        assert_eq!(command.cwd.as_deref(), Some("/tmp/project with spaces"));
        assert!(!command.args.iter().any(|arg| arg.contains("user prompt")));
    }

    #[test]
    fn send_capability_is_source_aware() {
        let writable_codex_session_ids =
            HashSet::from(["codexapp-rollout-2026-01-01-thread".to_string()]);
        assert_eq!(
            mobile_send_capability(
                "codexapp-rollout-2026-01-01-thread",
                &writable_codex_session_ids,
            ),
            "external_codex"
        );
        assert_eq!(
            mobile_send_capability("codexapp-rollout-paginated", &writable_codex_session_ids),
            "read_only"
        );
        assert_eq!(
            mobile_send_capability("cursoride-composer-123", &writable_codex_session_ids),
            "read_only"
        );
        assert_eq!(
            mobile_send_capability("sde-native", &writable_codex_session_ids),
            "native"
        );
    }

    #[test]
    fn appended_turn_requires_one_proven_suffix_entry() {
        let ids = |values: &[&str]| {
            values
                .iter()
                .map(|value| value.to_string())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            unique_appended_turn_id(&ids(&["a", "b"]), &ids(&["a", "b", "c"])),
            Some("c".to_string())
        );
        assert_eq!(
            unique_appended_turn_id(&ids(&["a", "b", "c"]), &ids(&["b", "c", "d"])),
            Some("d".to_string())
        );
        assert_eq!(
            unique_appended_turn_id(&ids(&["a"]), &ids(&["a", "b", "c"])),
            None
        );
        assert_eq!(
            unique_appended_turn_id(&ids(&["a", "b"]), &ids(&["x", "c"])),
            None
        );
    }

    #[test]
    fn send_status_round_id_is_additive_and_success_only() {
        let completed = send_status_notification(
            "session-a",
            "intent-a",
            "completed",
            None,
            Some("codex-user-42"),
        );
        assert_eq!(
            completed["params"]["roundId"].as_str(),
            Some("codex-user-42")
        );
        let failed = send_status_notification("session-a", "intent-a", "failed", Some("no"), None);
        assert!(failed["params"].get("roundId").is_none());
    }

    #[test]
    fn codex_failure_message_explains_paginated_history_rejection() {
        assert_eq!(
            codex_failure_message(
                "exit status: 1",
                "thread/resume failed: paginated_threads is not supported yet"
            ),
            "This Codex conversation uses a history format that the installed Codex CLI cannot continue yet"
        );
    }
}

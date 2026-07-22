//! Fast hook capture, durable inbox spooling, and bounded desktop draining.

use std::fs;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use database::db::get_connection;
use orgtrack_core::canonical::{ResourceInteractionEnvelopeV1, SessionActorLifecycleEnvelopeV1};
use orgtrack_core::hook_adapter::{
    normalize_actor_lifecycle_payload, normalize_hook_payload, HookSource,
};
use orgtrack_core::repo_sync::paths::record_id;
use orgtrack_core::store::{sqlite::SqliteRecordStore, RecentHookSignal};
use tauri::Emitter;

use super::{approval_gate, persist_actor_lifecycle, persist_envelope};

const DEFAULT_RECENT_HOOK_SIGNALS: usize = 50;
const MAX_RECENT_HOOK_SIGNALS: usize = 500;
const MAX_HOOK_PAYLOAD_BYTES: u64 = 2 * 1024 * 1024;
const MAX_DRAIN_BATCH: usize = 1_000;
static INBOX_DRAIN_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

/// Entry point used by `orgii --session-provenance-hook <source>`.
/// Provenance failures are diagnostic only and never block the provider tool.
pub fn capture_hook_stdin(source: &str) -> Result<usize, String> {
    // Backstop for the hooks master switch: when it is off the managed hooks
    // are uninstalled, so this process normally isn't spawned at all — but a
    // stale hook line (failed uninstall, read-only config) may still invoke
    // us. Discard instead of spooling signals the user opted out of.
    if !agent_cli::session_provenance::provenance_hooks_master_enabled_quick() {
        return Ok(0);
    }
    let source_arg = source;
    let source = HookSource::parse(source)?;
    let mut stdin = std::io::stdin().take(MAX_HOOK_PAYLOAD_BYTES + 1);
    let mut payload = Vec::new();
    stdin
        .read_to_end(&mut payload)
        .map_err(|err| format!("Failed to read session-provenance hook input: {err}"))?;
    if payload.len() as u64 > MAX_HOOK_PAYLOAD_BYTES {
        return Err(format!(
            "Session-provenance hook input exceeds {MAX_HOOK_PAYLOAD_BYTES} bytes"
        ));
    }
    let payload: serde_json::Value = serde_json::from_slice(&payload)
        .map_err(|err| format!("Invalid session-provenance hook JSON: {err}"))?;
    // Latency-sensitive live-status fast path first: one loopback POST that
    // silently no-ops when the desktop is closed or the feature is off. The
    // durable provenance spool below is unaffected either way.
    if agent_cli::session_provenance::live_status_enabled_quick() {
        let orgii_session_id = std::env::var("ORGII_SESSION_ID")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        if let Some(status) = orgtrack_core::status_adapter::normalize_status_payload(
            source,
            &payload,
            orgii_session_id,
        ) {
            super::status_post::post_status_event(&status);
        }
    }
    let lifecycle = normalize_actor_lifecycle_payload(source, &payload)?;
    let envelopes = normalize_hook_payload(source, &payload)?;
    for envelope in &envelopes {
        spool_envelope(envelope)?;
    }
    if let Some(lifecycle) = lifecycle.as_ref() {
        spool_actor_lifecycle(lifecycle)?;
    }
    let session_start_source_session_id = codex_session_start_source_session_id(source, &payload);
    if let Err(error) = agent_cli::session_provenance::record_session_provenance_hook_activation(
        source_arg,
        session_start_source_session_id,
    ) {
        tracing::warn!(
            error = %error,
            source = source_arg,
            "[SessionProvenance] Failed to record hook activation"
        );
    }
    // Interactive approval bridge, deliberately LAST: status and provenance
    // capture are already durable before we block. For a managed Claude
    // session's PermissionRequest this long-polls the desktop for the
    // user's Approve/Deny and prints the verified decision JSON to stdout;
    // every other event/session/error path prints nothing, so Claude's own
    // permission flow applies (see `approval_gate` for the contract).
    if let Some(decision_json) =
        approval_gate::maybe_block_for_permission_decision(source, &payload)
    {
        let mut stdout = std::io::stdout();
        let _ = stdout.write_all(decision_json.as_bytes());
        let _ = stdout.flush();
    }
    Ok(envelopes.len() + usize::from(lifecycle.is_some()))
}

fn codex_session_start_source_session_id<'a>(
    source: HookSource,
    payload: &'a serde_json::Value,
) -> Option<&'a str> {
    if source != HookSource::Codex {
        return None;
    }
    let event = payload
        .get("hook_event_name")
        .or_else(|| payload.get("hookEventName"))
        .or_else(|| payload.get("event"))
        .and_then(serde_json::Value::as_str)?;
    if !event.eq_ignore_ascii_case("SessionStart") {
        return None;
    }
    payload
        .get("session_id")
        .or_else(|| payload.get("sessionId"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

pub(crate) async fn recent_signals(limit: Option<usize>) -> Result<Vec<RecentHookSignal>, String> {
    tokio::task::spawn_blocking(move || {
        let _ = drain_hook_inbox();
        let limit = limit
            .unwrap_or(DEFAULT_RECENT_HOOK_SIGNALS)
            .clamp(1, MAX_RECENT_HOOK_SIGNALS);
        let conn = get_connection().map_err(|err| err.to_string())?;
        SqliteRecordStore::new(&conn).list_recent_hook_signals(limit)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

fn spool_envelope(envelope: &ResourceInteractionEnvelopeV1) -> Result<(), String> {
    envelope
        .validate()
        .map_err(|err| format!("Invalid resource-interaction envelope: {err}"))?;
    let action = envelope.action.as_str();
    spool_bytes(
        "",
        record_id(&[
            &envelope.source,
            &envelope.session_id,
            envelope.source_event_id.as_deref().unwrap_or(""),
            &envelope.file_path,
            action,
            &envelope.occurred_at,
        ]),
        serde_json::to_vec(envelope)
            .map_err(|err| format!("Failed to serialize session-provenance envelope: {err}"))?,
    )
}

fn spool_actor_lifecycle(envelope: &SessionActorLifecycleEnvelopeV1) -> Result<(), String> {
    envelope
        .validate()
        .map_err(|err| format!("Invalid session-actor lifecycle envelope: {err}"))?;
    spool_bytes(
        "actor-",
        record_id(&[
            "actor-lifecycle",
            &envelope.source,
            &envelope.session_id,
            envelope.turn_id.as_deref().unwrap_or(""),
            &envelope.actor_id,
            envelope.phase.as_str(),
            &envelope.occurred_at,
        ]),
        serde_json::to_vec(envelope)
            .map_err(|err| format!("Failed to serialize session-actor lifecycle: {err}"))?,
    )
}

fn spool_bytes(prefix: &str, identity: String, bytes: Vec<u8>) -> Result<(), String> {
    let inbox = app_paths::session_provenance_inbox_dir();
    fs::create_dir_all(&inbox)
        .map_err(|err| format!("Failed to create {}: {err}", inbox.display()))?;
    let path = inbox.join(format!("{prefix}{identity}.json"));
    if path.exists() {
        return Ok(());
    }
    let temp_path = inbox.join(format!(".{prefix}{identity}.{}.tmp", std::process::id()));
    fs::write(&temp_path, bytes)
        .map_err(|err| format!("Failed to write {}: {err}", temp_path.display()))?;
    app_paths::set_sensitive_file_permissions(&temp_path).ok();
    match fs::rename(&temp_path, &path) {
        Ok(()) => Ok(()),
        Err(_) if path.exists() => {
            let _ = fs::remove_file(&temp_path);
            Ok(())
        }
        Err(err) => {
            let _ = fs::remove_file(&temp_path);
            Err(format!("Failed to publish {}: {err}", path.display()))
        }
    }
}

pub(crate) fn drain_hook_inbox() -> Result<usize, String> {
    let _guard = INBOX_DRAIN_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "Session-provenance inbox drain lock is poisoned".to_string())?;
    let inbox = app_paths::session_provenance_inbox_dir();
    if !inbox.exists() {
        return Ok(0);
    }
    let mut files = fs::read_dir(&inbox)
        .map_err(|err| format!("Failed to read {}: {err}", inbox.display()))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect::<Vec<_>>();
    files.sort();
    files.truncate(MAX_DRAIN_BATCH);

    let mut conn = get_connection().map_err(|err| err.to_string())?;
    let mut drained = 0;
    for path in files {
        let bytes = fs::read(&path).map_err(|err| err.to_string())?;
        let persisted =
            if let Ok(envelope) = serde_json::from_slice::<ResourceInteractionEnvelopeV1>(&bytes) {
                if envelope.validate().is_err() {
                    false
                } else {
                    let store = SqliteRecordStore::new(&conn);
                    persist_envelope(&store, &envelope)?;
                    true
                }
            } else if let Ok(envelope) =
                serde_json::from_slice::<SessionActorLifecycleEnvelopeV1>(&bytes)
            {
                if envelope.validate().is_err() {
                    false
                } else {
                    persist_actor_lifecycle(&mut conn, &envelope)?;
                    true
                }
            } else {
                false
            };
        if !persisted {
            quarantine_invalid_envelope(&inbox, &path)?;
            continue;
        }
        fs::remove_file(&path).map_err(|err| {
            format!(
                "Failed to remove drained envelope {}: {err}",
                path.display()
            )
        })?;
        drained += 1;
    }
    Ok(drained)
}

pub(crate) fn quarantine_invalid_envelope(inbox: &Path, path: &Path) -> Result<(), String> {
    let rejected = inbox.parent().unwrap_or(inbox).join("rejected");
    fs::create_dir_all(&rejected)
        .map_err(|err| format!("Failed to create {}: {err}", rejected.display()))?;
    let file_name = path
        .file_name()
        .ok_or_else(|| format!("Invalid inbox envelope path: {}", path.display()))?;
    let target = rejected.join(file_name);
    if target.exists() {
        return fs::remove_file(path)
            .map_err(|err| format!("Failed to remove {}: {err}", path.display()));
    }
    fs::rename(path, &target).map_err(|err| {
        format!(
            "Failed to quarantine {} as {}: {err}",
            path.display(),
            target.display()
        )
    })
}

pub(crate) fn spawn_hook_inbox_drain_loop(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let result = tauri::async_runtime::spawn_blocking(drain_hook_inbox).await;
            match result {
                Ok(Ok(drained)) if drained > 0 => {
                    let _ = app.emit(super::RESOURCE_INTERACTIONS_CHANGED_EVENT, ());
                }
                Ok(Ok(_)) => {}
                Ok(Err(err)) => {
                    tracing::warn!(error = %err, "[SessionProvenance] Hook inbox drain failed");
                }
                Err(err) => {
                    tracing::warn!(error = %err, "[SessionProvenance] Hook inbox drain task failed");
                }
            }
            tokio::time::sleep(Duration::from_secs(15)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn codex_task_activation_requires_its_own_session_start() {
        let post_tool = json!({
            "hook_event_name": "PostToolUse",
            "session_id": "task-without-start"
        });
        let session_start = json!({
            "hook_event_name": "SessionStart",
            "session_id": "task-with-start"
        });

        assert_eq!(
            codex_session_start_source_session_id(HookSource::Codex, &post_tool),
            None
        );
        assert_eq!(
            codex_session_start_source_session_id(HookSource::Codex, &session_start),
            Some("task-with-start")
        );
    }
}

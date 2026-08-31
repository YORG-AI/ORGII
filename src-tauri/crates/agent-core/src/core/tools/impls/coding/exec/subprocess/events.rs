//! Shell process broadcasts and authoritative EventStore argument patches.

use tauri::AppHandle;

use crate::bus::event_pipeline_bridge;

use super::super::shell_replay::active_state;
use super::{BackgroundReason, ExecIdentity};

pub(crate) fn broadcast_exec_output(
    identity: &ExecIdentity,
    chunk: &str,
    stream: &str,
    sequence: u64,
    persisted_bytes: u64,
) {
    crate::bus::broadcast_event(
        "agent:exec_output",
        serde_json::json!({
            "sessionId": identity.session_id,
            "toolCallId": identity.call_id,
            "chunk": chunk,
            "stream": stream,
            "sequence": sequence,
            "persistedBytes": persisted_bytes,
        }),
    );
}

pub(crate) fn broadcast_system_output(identity: &ExecIdentity, chunk: &str) {
    let state = active_state(&identity.session_id, &identity.call_id);
    broadcast_exec_output(
        identity,
        chunk,
        "system",
        state
            .as_ref()
            .map_or(0, |value| value.bookmark.visible_through_sequence),
        state
            .as_ref()
            .map_or(0, |value| value.bookmark.visible_bytes),
    );
}

fn patch_process_state(
    app_handle: Option<&AppHandle>,
    identity: &ExecIdentity,
    merge_args: serde_json::Value,
) {
    if let Some(handle) = app_handle {
        event_pipeline_bridge::update_tool_args_by_call_id(
            handle,
            &identity.session_id,
            &identity.call_id,
            merge_args,
        );
    }
}

pub(super) fn broadcast_process_started(
    identity: &ExecIdentity,
    pid: u32,
    command: &str,
    app_handle: Option<&AppHandle>,
) {
    patch_process_state(
        app_handle,
        identity,
        serde_json::json!({
            "shellPid": pid,
            "shellProcessStatus": "running",
        }),
    );
    crate::bus::broadcast_event(
        "agent:shell_process_started",
        serde_json::json!({
            "sessionId": identity.session_id,
            "toolCallId": identity.call_id,
            "pid": pid,
            "command": command,
        }),
    );
}

pub(super) fn broadcast_process_backgrounded(
    identity: &ExecIdentity,
    pid: u32,
    reason: BackgroundReason,
    app_handle: Option<&AppHandle>,
) {
    patch_process_state(
        app_handle,
        identity,
        serde_json::json!({
            "shellPid": pid,
            "shellProcessStatus": "background",
        }),
    );
    crate::bus::broadcast_event(
        "agent:shell_process_backgrounded",
        serde_json::json!({
            "sessionId": identity.session_id,
            "toolCallId": identity.call_id,
            "pid": pid,
            "reason": reason.as_wire_str(),
        }),
    );
}

pub(super) fn broadcast_process_exited(
    identity: &ExecIdentity,
    pid: u32,
    exit_code: Option<i32>,
    killed: bool,
    app_handle: Option<&AppHandle>,
) {
    patch_process_state(
        app_handle,
        identity,
        serde_json::json!({
            "shellPid": pid,
            "shellProcessStatus": if killed { "killed" } else { "exited" },
            "shellExitCode": exit_code,
        }),
    );
    crate::bus::broadcast_event(
        "agent:shell_process_exited",
        serde_json::json!({
            "sessionId": identity.session_id,
            "toolCallId": identity.call_id,
            "pid": pid,
            "exitCode": exit_code,
            "killed": killed,
        }),
    );
}

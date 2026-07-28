//! Shell command and await_output extractors.

use super::git_artifacts::{parse_git_artifacts, GitArtifactParseInput};
use super::helpers::{obj_f64, obj_i64, obj_str};
use crate::agent_sessions::event_pipeline::extractors::types::*;

pub(super) fn extract_shell(
    args: Option<&serde_json::Map<String, serde_json::Value>>,
    result: Option<&serde_json::Map<String, serde_json::Value>>,
) -> ExtractedShellData {
    extract_shell_with_output_limit(args, result, None)
}

/// Extract a historical shell row without duplicating an arbitrarily large
/// legacy stdout/stderr string. The raw cached JSON still has to be parsed once
/// so it can be migrated, but every string copied into `extracted` is capped
/// before allocation. This helper is used only during cached-row conversion;
/// live extraction retains its existing full-value semantics.
pub(super) fn extract_shell_bounded(
    args: Option<&serde_json::Map<String, serde_json::Value>>,
    result: Option<&serde_json::Map<String, serde_json::Value>>,
    max_output_bytes: usize,
) -> ExtractedShellData {
    extract_shell_with_output_limit(args, result, Some(max_output_bytes))
}

fn result_branch<'a>(
    result: Option<&'a serde_json::Map<String, serde_json::Value>>,
    branch: &str,
) -> Option<&'a serde_json::Map<String, serde_json::Value>> {
    let result = result?;
    let nested = result
        .get("output")
        .and_then(serde_json::Value::as_object)
        .and_then(|output| output.get(branch))
        .and_then(serde_json::Value::as_object)
        .filter(|value| !value.is_empty());
    nested.or_else(|| {
        result
            .get(branch)
            .and_then(serde_json::Value::as_object)
            .filter(|value| !value.is_empty())
    })
}

fn borrowed_str<'a>(
    object: Option<&'a serde_json::Map<String, serde_json::Value>>,
    key: &str,
) -> Option<&'a str> {
    object?.get(key)?.as_str()
}

fn borrowed_safe_str(value: &serde_json::Value) -> Option<&str> {
    match value {
        serde_json::Value::String(value) => Some(value),
        serde_json::Value::Object(object) => ["content", "text", "message"]
            .iter()
            .find_map(|key| object.get(*key).and_then(serde_json::Value::as_str)),
        serde_json::Value::Array(values) => values.iter().find_map(borrowed_safe_str),
        _ => None,
    }
}

fn utf8_tail_owned(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut start = value.len() - max_bytes;
    while start < value.len() && !value.is_char_boundary(start) {
        start += 1;
    }
    value[start..].to_string()
}

fn copy_output(value: &str, max_output_bytes: Option<usize>) -> String {
    match max_output_bytes {
        Some(max_bytes) => utf8_tail_owned(value, max_bytes),
        None => value.to_string(),
    }
}

fn extract_shell_with_output_limit(
    args: Option<&serde_json::Map<String, serde_json::Value>>,
    result: Option<&serde_json::Map<String, serde_json::Value>>,
    max_output_bytes: Option<usize>,
) -> ExtractedShellData {
    // Keep success/failure maps borrowed. The old extractor cloned the whole
    // result map and each selected output field, which briefly multiplied a
    // 10 MiB historical shell payload before EventStore could truncate it.
    let success = result_branch(result, "success");
    let failure = result_branch(result, "failure");
    let has_failure_payload = failure.is_some() && success.is_none();
    let command_data = success.or(failure);

    let command = borrowed_str(command_data, "command")
        .or_else(|| borrowed_str(args, "command"))
        .or_else(|| borrowed_str(result, "command"))
        .unwrap_or_default()
        .to_string();

    let interleaved = borrowed_str(command_data, "interleavedOutput")
        .or_else(|| borrowed_str(command_data, "interleaved_output"));
    let stdout = borrowed_str(command_data, "stdout").or_else(|| borrowed_str(result, "stdout"));
    let stderr = borrowed_str(command_data, "stderr").or_else(|| borrowed_str(result, "stderr"));
    let stream_output = borrowed_str(args, "streamOutput");
    let output_text = interleaved
        .or(stdout)
        .or(stderr)
        .or(stream_output)
        .or_else(|| {
            result
                .and_then(|value| value.get("output"))
                .and_then(borrowed_safe_str)
        })
        .or_else(|| borrowed_str(result, "observation"));
    let output = output_text.map(|value| copy_output(value, max_output_bytes));

    let empty = serde_json::Map::new();
    let command_data = command_data.unwrap_or(&empty);
    let exit_code = obj_i64(command_data, "exitCode")
        .or_else(|| obj_i64(command_data, "exit_code"))
        .or_else(|| result.and_then(|r| obj_i64(r, "exit_code")))
        // New bounded shell replay events keep process metadata in args and
        // deliberately omit the LLM-facing result summary from EventStore.
        .or_else(|| args.and_then(|a| obj_i64(a, "shellExitCode")));

    let execution_time =
        obj_f64(command_data, "executionTime").or_else(|| obj_f64(command_data, "execution_time"));
    let is_failure = has_failure_payload || exit_code.is_some_and(|code| code != 0);

    let cwd = args.and_then(|a| obj_str(a, "cwd"));

    let description = args.and_then(|a| obj_str(a, "description"));
    let kill_handle = args.and_then(|a| obj_str(a, "kill_handle"));
    let action = args.and_then(|a| match a.get("action") {
        Some(serde_json::Value::String(s)) => Some(s.clone()),
        _ => None,
    });
    let stream_output_owned = stream_output.map(|value| copy_output(value, max_output_bytes));
    let shell_pid = args.and_then(|a| obj_i64(a, "shellPid"));
    let shell_process_status = args.and_then(|a| obj_str(a, "shellProcessStatus"));
    let shell_log_path = args.and_then(|a| obj_str(a, "shellLogPath"));

    let git_artifacts = {
        let artifacts = parse_git_artifacts(GitArtifactParseInput {
            command: &command,
            output: output.as_deref(),
            exit_code,
        });
        if artifacts.is_empty() {
            None
        } else {
            Some(artifacts)
        }
    };

    ExtractedShellData {
        command,
        action,
        kill_handle,
        description,
        output,
        stream_output: stream_output_owned,
        exit_code,
        cwd,
        execution_time,
        is_failure,
        shell_pid,
        shell_process_status,
        shell_log_path,
        git_artifacts,
    }
}

pub(super) fn extract_await(
    args: Option<&serde_json::Map<String, serde_json::Value>>,
    result: Option<&serde_json::Map<String, serde_json::Value>>,
) -> ExtractedAwaitData {
    let handle = args.and_then(|a| obj_str(a, "handle").or_else(|| obj_str(a, "pid")));
    let block_until_ms = args.and_then(|a| obj_i64(a, "block_until_ms"));

    let result_text = match result {
        Some(r) => match r.get("output") {
            Some(serde_json::Value::String(s)) => Some(s.clone()),
            _ => obj_str(r, "output").or_else(|| obj_str(r, "text")),
        },
        None => None,
    };

    ExtractedAwaitData {
        handle,
        block_until_ms,
        result_text,
    }
}

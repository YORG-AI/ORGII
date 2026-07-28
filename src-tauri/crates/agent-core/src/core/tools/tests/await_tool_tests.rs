use std::path::PathBuf;

use crate::tools::impls::coding::exec::await_tool::AwaitTool;
use crate::tools::impls::coding::exec::registry;
use crate::tools::impls::coding::exec::shell_replay::{
    resolve_replay_root, ShellReplayStream, ShellReplayTarget, ShellReplayWriter,
};
use crate::tools::traits::Tool;
use core_types::session_event::ShellReplayStatus;

/// Extract the `awaitMeta::` JSON line from a tool result string.
fn extract_meta(result: &str) -> serde_json::Value {
    let line = result
        .lines()
        .find(|l| l.starts_with("awaitMeta::"))
        .unwrap_or_else(|| panic!("No awaitMeta:: line found in:\n{result}"));
    let json_str = line.strip_prefix("awaitMeta::").unwrap();
    serde_json::from_str(json_str)
        .unwrap_or_else(|err| panic!("Invalid JSON in awaitMeta: {err}\nLine: {line}"))
}

/// Extract the first (single-handle) item from `meta.items` for the common
/// case of testing a `wait_for` / `monitor` call on one handle. Panics if the
/// shape is wrong — intentional; the canonical meta always has `items[]`.
fn single_item(result: &str) -> serde_json::Value {
    let meta = extract_meta(result);
    let items = meta["items"]
        .as_array()
        .unwrap_or_else(|| panic!("awaitMeta missing items array: {meta}"));
    items
        .first()
        .cloned()
        .unwrap_or_else(|| panic!("awaitMeta.items is empty: {meta}"))
}

#[test]
fn test_schema_has_command_and_handles() {
    let tool = AwaitTool::new();
    let params = tool.parameters();
    let props = params.get("properties").unwrap();
    assert!(props.get("handles").is_some());
    assert!(props.get("wait_mode").is_some());
    assert!(props.get("command").is_some());
    assert!(props.get("scope").is_some());
    assert!(props.get("pid").is_none());
    // Legacy singular field is gone.
    assert!(props.get("handle").is_none());

    assert_eq!(props["handles"]["type"].as_str().unwrap(), "array");

    let command_enum = props["command"]["enum"].as_array().unwrap();
    let commands: Vec<&str> = command_enum.iter().map(|v| v.as_str().unwrap()).collect();
    assert!(commands.contains(&"wait_for"));
    assert!(commands.contains(&"monitor"));
    assert!(commands.contains(&"list"));

    let mode_enum = props["wait_mode"]["enum"].as_array().unwrap();
    let modes: Vec<&str> = mode_enum.iter().map(|v| v.as_str().unwrap()).collect();
    assert!(modes.contains(&"any"));
    assert!(modes.contains(&"all"));
}

#[test]
fn test_is_read_only() {
    assert!(AwaitTool::new().is_read_only());
}

#[tokio::test]
async fn test_missing_handles_returns_error() {
    let tool = AwaitTool::new();
    let result = tool
        .execute(
            serde_json::json!({}),
            &crate::tools::call_context::CallContext::default(),
        )
        .await;
    assert!(result.is_err());
    let err_msg = format!("{}", result.unwrap_err());
    assert!(
        err_msg.contains("handles"),
        "Error should mention handles: {err_msg}"
    );
}

#[tokio::test]
async fn test_legacy_singular_handle_rejected() {
    let tool = AwaitTool::new();
    let result = tool
        .execute(
            serde_json::json!({
                "handle": "something"
            }),
            &crate::tools::call_context::CallContext::default(),
        )
        .await;
    assert!(result.is_err());
    let err_msg = format!("{}", result.unwrap_err());
    assert!(
        err_msg.contains("handles"),
        "Error should steer caller to `handles`: {err_msg}"
    );
}

#[tokio::test]
async fn test_not_found_handle() {
    let tool = AwaitTool::new();
    let result = tool
        .execute(
            serde_json::json!({
                "handles": ["nonexistent-99999"]
            }),
            &crate::tools::call_context::CallContext::default(),
        )
        .await;
    assert!(result.is_err());
    let err_msg = format!("{}", result.unwrap_err());
    assert!(
        err_msg.contains("No background job"),
        "Should mention not found: {err_msg}"
    );
}

#[tokio::test]
async fn test_empty_handles_array_rejected() {
    let tool = AwaitTool::new();
    let result = tool
        .execute(
            serde_json::json!({
                "handles": []
            }),
            &crate::tools::call_context::CallContext::default(),
        )
        .await;
    assert!(result.is_err());
}

#[tokio::test]
async fn test_pattern_with_multiple_handles_rejected() {
    let pid_a = 88820_u32;
    let pid_b = 88821_u32;
    let ha = pid_a.to_string();
    let hb = pid_b.to_string();
    let _tx_a = registry::register_shell(
        pid_a,
        "a".into(),
        PathBuf::from("/tmp/fake-multi-a.txt"),
        "multi-session".into(),
    );
    let _tx_b = registry::register_shell(
        pid_b,
        "b".into(),
        PathBuf::from("/tmp/fake-multi-b.txt"),
        "multi-session".into(),
    );

    let tool = AwaitTool::new();
    let result = tool
        .execute(
            serde_json::json!({
                "command": "wait_for",
                "handles": [ha.clone(), hb.clone()],
                "pattern": "done",
                "block_until_ms": 0,
            }),
            &crate::tools::call_context::CallContext::default(),
        )
        .await;
    assert!(result.is_err());

    registry::remove(&ha);
    registry::remove(&hb);
}

#[tokio::test]
async fn test_shell_running_has_metadata() {
    let pid = 88801_u32;
    let handle = pid.to_string();
    let _tx = registry::register_shell(
        pid,
        "sleep 999".into(),
        PathBuf::from("/tmp/fake.txt"),
        "test-session".into(),
    );

    let tool = AwaitTool::new();
    let result = tool
        .execute(
            serde_json::json!({
                "handles": [handle.clone()],
                "block_until_ms": 0
            }),
            &crate::tools::call_context::CallContext::default(),
        )
        .await
        .unwrap();

    assert!(result.starts_with(&format!("[{handle}: running]")));

    let item = single_item(&result);
    assert_eq!(item["handle"].as_str().unwrap(), handle);
    assert_eq!(item["status"].as_str().unwrap(), "running");
    assert_eq!(item["jobKind"].as_str().unwrap(), "shell");
    assert_eq!(item["waitedMs"].as_u64().unwrap(), 0);
    // No pattern was supplied so the field shouldn't show up.
    assert!(item.get("patternMatched").is_none());
    assert!(item.get("matchLine").is_none());

    let meta = extract_meta(&result);
    assert_eq!(meta["count"].as_u64().unwrap(), 1);

    registry::remove(&handle);
}

#[tokio::test]
#[serial_test::serial]
async fn durable_shell_monitor_and_pattern_poll_authoritative_replay_tail() {
    let _sandbox = test_helpers::test_env::sandbox();
    let replay_root = resolve_replay_root();
    let session_id = "await-replay-session";
    let call_id = "await-replay-call";
    let pid = 88991_u32;
    let handle = pid.to_string();
    let mut writer = ShellReplayWriter::create(
        &replay_root,
        ShellReplayTarget::new(session_id, call_id),
        "emit ready",
        std::path::Path::new("/tmp"),
        None,
    )
    .unwrap();
    writer
        .append(ShellReplayStream::Stdout, b"READY_FROM_REPLAY\n")
        .unwrap();
    let _sender = registry::register_shell_replay(
        pid,
        "emit ready".into(),
        writer.path().to_path_buf(),
        session_id.into(),
        call_id.into(),
    );

    let tool = AwaitTool::new();
    let monitor = tool
        .execute(
            serde_json::json!({
                "command": "monitor",
                "handles": [handle.clone()],
                "tail_lines": 20,
            }),
            &crate::tools::call_context::CallContext::default(),
        )
        .await
        .unwrap();
    assert!(monitor.contains("READY_FROM_REPLAY"), "{monitor}");

    let matched = tool
        .execute(
            serde_json::json!({
                "command": "wait_for",
                "handles": [handle.clone()],
                "pattern": "READY_FROM_REPLAY",
                "block_until_ms": 10,
            }),
            &crate::tools::call_context::CallContext::default(),
        )
        .await
        .unwrap();
    assert_eq!(single_item(&matched)["patternMatched"], true);

    writer.finalize(ShellReplayStatus::Complete, None).unwrap();
    registry::mark_exited(&handle, registry::JobStatus::Exited(0));
    registry::remove(&handle);
}

#[tokio::test]
async fn test_shell_exited_zero_is_succeeded() {
    let pid = 88802_u32;
    let handle = pid.to_string();
    let _tx = registry::register_shell(
        pid,
        "echo done".into(),
        PathBuf::from("/tmp/fake.txt"),
        "test-session".into(),
    );
    registry::mark_exited(&handle, registry::JobStatus::Exited(0));

    let tool = AwaitTool::new();
    let result = tool
        .execute(
            serde_json::json!({
                "handles": [handle.clone()],
                "block_until_ms": 0
            }),
            &crate::tools::call_context::CallContext::default(),
        )
        .await
        .unwrap();

    assert!(result.starts_with(&format!("[{handle}: succeeded]")));

    let item = single_item(&result);
    assert_eq!(item["status"].as_str().unwrap(), "succeeded");
    assert_eq!(item["jobKind"].as_str().unwrap(), "shell");
    assert_eq!(item["exitCode"].as_i64().unwrap(), 0);

    registry::remove(&handle);
}

#[tokio::test]
async fn test_shell_exited_nonzero_is_failed() {
    let pid = 88803_u32;
    let handle = pid.to_string();
    let _tx = registry::register_shell(
        pid,
        "bad-cmd".into(),
        PathBuf::from("/tmp/fake.txt"),
        "test-session".into(),
    );
    registry::mark_exited(&handle, registry::JobStatus::Exited(1));

    let tool = AwaitTool::new();
    let result = tool
        .execute(
            serde_json::json!({
                "handles": [handle.clone()],
                "block_until_ms": 0
            }),
            &crate::tools::call_context::CallContext::default(),
        )
        .await
        .unwrap();

    assert!(result.starts_with(&format!("[{handle}: failed]")));

    let item = single_item(&result);
    assert_eq!(item["status"].as_str().unwrap(), "failed");
    assert_eq!(item["exitCode"].as_i64().unwrap(), 1);

    registry::remove(&handle);
}

#[tokio::test]
async fn test_shell_killed_is_failed_with_killed_flag() {
    let pid = 88804_u32;
    let handle = pid.to_string();
    let _tx = registry::register_shell(
        pid,
        "long-process".into(),
        PathBuf::from("/tmp/fake.txt"),
        "test-session".into(),
    );
    registry::mark_exited(&handle, registry::JobStatus::Killed);

    let tool = AwaitTool::new();
    let result = tool
        .execute(
            serde_json::json!({
                "handles": [handle.clone()],
                "block_until_ms": 0
            }),
            &crate::tools::call_context::CallContext::default(),
        )
        .await
        .unwrap();

    let item = single_item(&result);
    assert_eq!(item["status"].as_str().unwrap(), "failed");
    assert!(item["killed"].as_bool().unwrap());
    assert!(item.get("exitCode").is_none());

    registry::remove(&handle);
}

#[tokio::test]
async fn test_subagent_completed_has_succeeded_metadata() {
    let handle = "shadow-test-meta-abc".to_string();
    let (_tx, _cancel) = registry::register_subagent(
        handle.clone(),
        "shadow".into(),
        "Test Agent".into(),
        "parent-sess".into(),
    );

    registry::set_final_result(&handle, "Found 7 files.".into());
    registry::mark_exited(&handle, registry::JobStatus::Completed);

    let tool = AwaitTool::new();
    let result = tool
        .execute(
            serde_json::json!({
                "handles": [handle.clone()],
                "block_until_ms": 0
            }),
            &crate::tools::call_context::CallContext::default(),
        )
        .await
        .unwrap();

    assert!(result.starts_with(&format!("[{handle}: succeeded]")));

    let item = single_item(&result);
    assert_eq!(item["status"].as_str().unwrap(), "succeeded");
    assert_eq!(item["jobKind"].as_str().unwrap(), "subagent");
    assert!(item.get("exitCode").is_none());

    assert!(
        result.contains("Found 7 files."),
        "Should contain result text: {result}"
    );

    registry::remove(&handle);
}

#[tokio::test]
async fn test_subagent_failed_has_failed_metadata() {
    let handle = "agent-test-fail-meta".to_string();
    let (_tx, _cancel) = registry::register_subagent(
        handle.clone(),
        "delegate".into(),
        "Failing Agent".into(),
        "parent-sess".into(),
    );

    registry::set_final_result(&handle, "Agent 'Failing Agent' failed: OOM".into());
    registry::mark_exited(&handle, registry::JobStatus::Failed);

    let tool = AwaitTool::new();
    let result = tool
        .execute(
            serde_json::json!({
                "handles": [handle.clone()],
                "block_until_ms": 0
            }),
            &crate::tools::call_context::CallContext::default(),
        )
        .await
        .unwrap();

    assert!(result.starts_with(&format!("[{handle}: failed]")));

    let item = single_item(&result);
    assert_eq!(item["status"].as_str().unwrap(), "failed");
    assert_eq!(item["jobKind"].as_str().unwrap(), "subagent");

    assert!(result.contains("OOM"), "Should contain error: {result}");

    registry::remove(&handle);
}

#[tokio::test]
async fn test_subagent_running_has_running_metadata() {
    let handle = "shadow-running-xyz".to_string();
    let (_tx, _cancel) = registry::register_subagent(
        handle.clone(),
        "shadow".into(),
        "Running Agent".into(),
        "parent-sess".into(),
    );

    let tool = AwaitTool::new();
    let result = tool
        .execute(
            serde_json::json!({
                "handles": [handle.clone()],
                "block_until_ms": 0
            }),
            &crate::tools::call_context::CallContext::default(),
        )
        .await
        .unwrap();

    assert!(result.starts_with(&format!("[{handle}: running]")));

    let item = single_item(&result);
    assert_eq!(item["status"].as_str().unwrap(), "running");
    assert_eq!(item["jobKind"].as_str().unwrap(), "subagent");
    // No pattern supplied, so patternMatched shouldn't be emitted.
    assert!(item.get("patternMatched").is_none());

    registry::remove(&handle);
}

// ── Subcommand tests ────────────────────────────────────────────────

#[tokio::test]
async fn test_monitor_command_returns_immediately() {
    let pid = 88810_u32;
    let handle = pid.to_string();
    let _tx = registry::register_shell(
        pid,
        "sleep 9999".into(),
        PathBuf::from("/tmp/fake-status.txt"),
        "test-session-status".into(),
    );

    let tool = AwaitTool::new();
    let start = std::time::Instant::now();
    let result = tool
        .execute(
            serde_json::json!({
                "command": "monitor",
                "handles": [handle.clone()],
            }),
            &crate::tools::call_context::CallContext::default(),
        )
        .await
        .unwrap();
    let elapsed = start.elapsed();

    assert!(
        elapsed.as_millis() < 500,
        "monitor should be non-blocking, took {}ms",
        elapsed.as_millis()
    );

    let item = single_item(&result);
    assert_eq!(item["status"].as_str().unwrap(), "running");
    assert_eq!(item["jobKind"].as_str().unwrap(), "shell");

    registry::remove(&handle);
}

#[tokio::test]
async fn test_monitor_tail_lines_honored() {
    let pid = 88811_u32;
    let handle = pid.to_string();
    let _tx = registry::register_shell(
        pid,
        "cargo build".into(),
        PathBuf::from("/tmp/fake-tail.txt"),
        "test-session-tail".into(),
    );

    let tool = AwaitTool::new();
    let result = tool
        .execute(
            serde_json::json!({
                "command": "monitor",
                "handles": [handle.clone()],
                "tail_lines": 10
            }),
            &crate::tools::call_context::CallContext::default(),
        )
        .await
        .unwrap();

    let item = single_item(&result);
    assert_eq!(item["status"].as_str().unwrap(), "running");
    assert!(result.contains(&format!("--- [{handle}] last 10 lines ---")));

    registry::remove(&handle);
}

#[tokio::test]
async fn test_monitor_subagent_reads_recent_buffer() {
    let handle = "sub-tail-buffer-test".to_string();
    let (_tx, _cancel) = registry::register_subagent(
        handle.clone(),
        "shadow".into(),
        "Buffer Agent".into(),
        "test-session-tail".into(),
    );

    registry::push_output_line(&handle, "Line 1: searching files".into());
    registry::push_output_line(&handle, "Line 2: found 3 matches".into());

    let tool = AwaitTool::new();
    let result = tool
        .execute(
            serde_json::json!({
                "command": "monitor",
                "handles": [handle.clone()],
            }),
            &crate::tools::call_context::CallContext::default(),
        )
        .await
        .unwrap();

    assert!(
        result.contains("Line 1: searching files"),
        "Should contain buffered output: {result}"
    );
    assert!(
        result.contains("Line 2: found 3 matches"),
        "Should contain buffered output: {result}"
    );

    registry::remove(&handle);
}

#[tokio::test]
async fn test_list_returns_session_jobs() {
    let pid = 88812_u32;
    let shell_handle = pid.to_string();
    let _tx1 = registry::register_shell(
        pid,
        "npm run dev".into(),
        PathBuf::from("/tmp/fake-list.txt"),
        "test-session-list".into(),
    );

    let sub_handle = "sub-list-test-001".to_string();
    let (_tx2, _cancel2) = registry::register_subagent(
        sub_handle.clone(),
        "delegate".into(),
        "Explorer".into(),
        "test-session-list".into(),
    );

    let tool = AwaitTool::new();
    tool.set_session_key("test-session-list").await;

    let result = tool
        .execute(
            serde_json::json!({
                "command": "list",
            }),
            &crate::tools::call_context::CallContext::default(),
        )
        .await
        .unwrap();

    let meta = extract_meta(&result);
    assert_eq!(meta["command"].as_str().unwrap(), "list");
    assert_eq!(meta["status"].as_str().unwrap(), "succeeded");
    assert_eq!(meta["count"].as_u64().unwrap(), 2);

    let items = meta["items"].as_array().unwrap();
    let handles: Vec<&str> = items
        .iter()
        .map(|item| item["handle"].as_str().unwrap())
        .collect();
    assert!(handles.contains(&shell_handle.as_str()));
    assert!(handles.contains(&"sub-list-test-001"));

    assert!(
        result.contains("npm run dev"),
        "Table should contain label: {result}"
    );
    assert!(
        result.contains("Explorer"),
        "Table should contain agent name: {result}"
    );

    registry::remove(&shell_handle);
    registry::remove(&sub_handle);
}

#[tokio::test]
async fn test_list_empty_session() {
    let tool = AwaitTool::new();
    tool.set_session_key("nonexistent-session-xyz").await;

    let result = tool
        .execute(
            serde_json::json!({
                "command": "list",
            }),
            &crate::tools::call_context::CallContext::default(),
        )
        .await
        .unwrap();

    let meta = extract_meta(&result);
    assert_eq!(meta["count"].as_u64().unwrap(), 0);
    assert!(
        result.contains("no background jobs"),
        "Should show empty message: {result}"
    );
}

#[tokio::test]
async fn test_list_global_scope() {
    let pid = 88813_u32;
    let handle = pid.to_string();
    let _tx = registry::register_shell(
        pid,
        "global-test".into(),
        PathBuf::from("/tmp/fake-global.txt"),
        "other-session".into(),
    );

    let tool = AwaitTool::new();
    tool.set_session_key("my-session").await;

    let result = tool
        .execute(
            serde_json::json!({
                "command": "list",
                "scope": "global",
            }),
            &crate::tools::call_context::CallContext::default(),
        )
        .await
        .unwrap();

    let meta = extract_meta(&result);
    let items = meta["items"].as_array().unwrap();
    let handles: Vec<&str> = items
        .iter()
        .map(|item| item["handle"].as_str().unwrap())
        .collect();
    assert!(
        handles.contains(&handle.as_str()),
        "Global list should include jobs from other sessions"
    );

    registry::remove(&handle);
}

#[tokio::test]
async fn test_unknown_command_returns_error() {
    let tool = AwaitTool::new();
    let result = tool
        .execute(
            serde_json::json!({
                "command": "destroy",
                "handle": "12345"
            }),
            &crate::tools::call_context::CallContext::default(),
        )
        .await;

    assert!(result.is_err());
    let err_msg = format!("{}", result.unwrap_err());
    assert!(
        err_msg.contains("Unknown await_output command"),
        "Should mention unknown command: {err_msg}"
    );
}

/// When `command` is omitted AND no wait_for-only params are present,
/// the call defaults to `monitor` (non-blocking snapshot). `block_until_ms: 0`
/// on its own is consistent with monitor semantics and remains accepted.
#[tokio::test]
async fn test_default_command_is_monitor() {
    let pid = 88814_u32;
    let handle = pid.to_string();
    let _tx = registry::register_shell(
        pid,
        "sleep 100".into(),
        PathBuf::from("/tmp/fake-default.txt"),
        "test-default".into(),
    );

    let tool = AwaitTool::new();
    let result = tool
        .execute(
            serde_json::json!({
                "handles": [handle.clone()],
                "block_until_ms": 0
            }),
            &crate::tools::call_context::CallContext::default(),
        )
        .await
        .unwrap();

    let item = single_item(&result);
    assert_eq!(item["status"].as_str().unwrap(), "running");
    assert_eq!(item["waitedMs"].as_u64().unwrap(), 0);

    registry::remove(&handle);
}

/// Passing `wait_mode` without `command` is a malformed call — we reject it
/// loudly rather than silently defaulting to `monitor` (which would ignore
/// the caller's clear blocking intent).
#[tokio::test]
async fn test_missing_command_with_wait_mode_rejected() {
    let tool = AwaitTool::new();
    let result = tool
        .execute(
            serde_json::json!({
                "handles": ["12345"],
                "wait_mode": "all",
                "block_until_ms": 30000,
            }),
            &crate::tools::call_context::CallContext::default(),
        )
        .await;
    assert!(result.is_err());
    let err_msg = format!("{}", result.unwrap_err());
    assert!(
        err_msg.contains("command") && err_msg.contains("required"),
        "Should complain about missing required `command`: {err_msg}"
    );
}

/// Same for `pattern` — it's a wait_for-only param, so supplying it without
/// `command` is ambiguous.
#[tokio::test]
async fn test_missing_command_with_pattern_rejected() {
    let tool = AwaitTool::new();
    let result = tool
        .execute(
            serde_json::json!({
                "handles": ["12345"],
                "pattern": "done",
            }),
            &crate::tools::call_context::CallContext::default(),
        )
        .await;
    assert!(result.is_err());
    let err_msg = format!("{}", result.unwrap_err());
    assert!(
        err_msg.contains("command") && err_msg.contains("required"),
        "Should complain about missing required `command`: {err_msg}"
    );
}

/// `pattern: null` / `wait_mode: null` should be treated the same as
/// "not set" — i.e. the call should NOT be rejected as ambiguous (some
/// LLMs serialize unset optionals as explicit JSON null). It should fall
/// through to the default `"monitor"` command, which then surfaces its
/// normal "no such handle" error rather than the strict `InvalidParams`
/// "command is required" error.
#[tokio::test]
async fn test_null_pattern_is_treated_as_unset() {
    let tool = AwaitTool::new();
    let result = tool
        .execute(
            serde_json::json!({
                "handles": ["doesnotexist-99999"],
                "pattern": serde_json::Value::Null,
                "wait_mode": serde_json::Value::Null,
            }),
            &crate::tools::call_context::CallContext::default(),
        )
        .await;
    assert!(result.is_err());
    let err_msg = format!("{}", result.unwrap_err());
    assert!(
        err_msg.contains("No background job"),
        "null pattern/wait_mode should fall through to monitor (not InvalidParams); got: {err_msg}"
    );
    assert!(
        !err_msg.contains("required"),
        "Should NOT trip the strict `command is required` guard: {err_msg}"
    );
}

#[tokio::test]
async fn test_monitor_multiple_handles_returns_items_array() {
    let pid_a = 88830_u32;
    let pid_b = 88831_u32;
    let ha = pid_a.to_string();
    let hb = pid_b.to_string();
    let _tx_a = registry::register_shell(
        pid_a,
        "sleep 777".into(),
        PathBuf::from("/tmp/fake-multi-monitor-a.txt"),
        "multi-monitor".into(),
    );
    let _tx_b = registry::register_shell(
        pid_b,
        "sleep 888".into(),
        PathBuf::from("/tmp/fake-multi-monitor-b.txt"),
        "multi-monitor".into(),
    );

    let tool = AwaitTool::new();
    let result = tool
        .execute(
            serde_json::json!({
                "command": "monitor",
                "handles": [ha.clone(), hb.clone()],
            }),
            &crate::tools::call_context::CallContext::default(),
        )
        .await
        .unwrap();

    // Header should list both handles.
    assert!(result.contains(&format!("[{ha}: running]")));
    assert!(result.contains(&format!("[{hb}: running]")));

    let meta = extract_meta(&result);
    assert_eq!(meta["count"].as_u64().unwrap(), 2);
    let items = meta["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);

    // Each handle gets its own tail block.
    assert!(result.contains(&format!("--- [{ha}] last")));
    assert!(result.contains(&format!("--- [{hb}] last")));

    registry::remove(&ha);
    registry::remove(&hb);
}

#[tokio::test]
async fn test_wait_for_all_mode_waits_for_every_handle() {
    // With wait_mode=all, having one terminated and one running should time
    // out to the block_until_ms. We use a very short timeout so the test is
    // fast and still observably waits.
    let pid_done = 88832_u32;
    let pid_running = 88833_u32;
    let h_done = pid_done.to_string();
    let h_running = pid_running.to_string();
    let _tx_a = registry::register_shell(
        pid_done,
        "echo done".into(),
        PathBuf::from("/tmp/fake-all-a.txt"),
        "all-session".into(),
    );
    let _tx_b = registry::register_shell(
        pid_running,
        "sleep 999".into(),
        PathBuf::from("/tmp/fake-all-b.txt"),
        "all-session".into(),
    );
    registry::mark_exited(&h_done, registry::JobStatus::Exited(0));

    let tool = AwaitTool::new();
    let start = std::time::Instant::now();
    let result = tool
        .execute(
            serde_json::json!({
                "command": "wait_for",
                "handles": [h_done.clone(), h_running.clone()],
                "wait_mode": "all",
                "block_until_ms": 400,
            }),
            &crate::tools::call_context::CallContext::default(),
        )
        .await
        .unwrap();
    let elapsed = start.elapsed();

    // Should have blocked close to the full 400ms window because the second
    // handle never finishes.
    assert!(
        elapsed.as_millis() >= 300,
        "wait_mode=all should block, took only {}ms",
        elapsed.as_millis()
    );

    let meta = extract_meta(&result);
    assert_eq!(meta["count"].as_u64().unwrap(), 2);
    let items = meta["items"].as_array().unwrap();
    let statuses: Vec<&str> = items
        .iter()
        .map(|i| i["status"].as_str().unwrap())
        .collect();
    assert!(statuses.contains(&"succeeded"));
    assert!(statuses.contains(&"running"));

    registry::remove(&h_done);
    registry::remove(&h_running);
}

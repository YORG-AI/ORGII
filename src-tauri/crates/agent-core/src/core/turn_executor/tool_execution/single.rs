//! Sequential execution of a single tool call (write tools or lone read tools).

use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Instant;

use serde_json::Value;
use tracing::{info, warn};

use crate::core::tools::traits::ToolExecuteResult;
use crate::providers::traits::ToolCallRequest;
use crate::specialization::policies::activation::SessionScopedContextActivator;
use crate::tools::policy::ResolvedToolPolicy;
use crate::tools::registry::ToolRegistry;

use super::super::file_tracker::{
    extract_file_paths, is_file_write_tool, FileTimeTracker, FILE_READ_TOOLS,
};
use super::super::helpers::{
    add_tool_result, add_tool_result_rich_with_timestamp, add_tool_result_with_timestamp,
    check_permission, truncate_output,
};
use super::super::types::{PermissionProvider, TurnEventHandler};

use super::detect_stream_parse_error;
use super::diff_feedback::compute_diff_feedback;
use super::is_cancelled;
use super::is_error_text;
use super::ToolBatchOutcome;

pub(super) enum SingleResult {
    Continue,
    EarlyExit(ToolBatchOutcome),
}

/// Execute a single tool call (used for sequential groups and single-item parallel groups).
#[allow(clippy::too_many_arguments)]
pub(super) async fn execute_single_tool(
    messages: &mut Vec<Value>,
    tool_call: &ToolCallRequest,
    tools: &ToolRegistry,
    policy: &ResolvedToolPolicy,
    session_id: &str,
    handler: &dyn TurnEventHandler,
    permission_provider: Option<&dyn PermissionProvider>,
    cancel_flag: Option<&Arc<AtomicBool>>,
    file_tracker: &mut FileTimeTracker,
    consecutive_errors: &mut u32,
    workspace_path: Option<&std::path::Path>,
    policy_context_activator: Option<&SessionScopedContextActivator>,
) -> SingleResult {
    let args_preview: String =
        crate::utils::safe_truncate_chars_to_string(&tool_call.arguments.to_string(), 200);
    info!(
        "[agent-core] Tool call: {}({})",
        tool_call.name, args_preview
    );

    let display_tool_name = match tool_call
        .arguments
        .get("action")
        .and_then(|v: &Value| v.as_str())
    {
        Some(action) => format!("{}_{}", tool_call.name, action),
        None => tool_call.name.clone(),
    };

    if is_cancelled(cancel_flag) {
        info!(
            "[agent-core] Cancelled before tool call emission (session={})",
            session_id
        );
        return SingleResult::EarlyExit(ToolBatchOutcome::Cancelled);
    }

    handler.on_tool_call(
        session_id,
        &tool_call.id,
        &tool_call.name,
        &display_tool_name,
        &tool_call.arguments,
    );

    let intervention = handler
        .before_tool_execute(session_id, &tool_call.name, &tool_call.arguments)
        .await;

    // `result` holds the LLM-facing text string that drives all
    // downstream message-shape / error-detection code below. `rich` is
    // the full `ToolExecuteResult` (populated on the success path of the
    // main execute branch), used at the very bottom to decide whether
    // to emit the structured sidecar. On the error / blocked / denied
    // paths `rich` stays `None`.
    let (result, was_blocked) = if let Some(ref hook) = intervention {
        if hook.block {
            let reason = hook.block_reason.as_deref().unwrap_or("Blocked by plugin");
            info!(
                "[agent-core] Tool {} blocked by plugin: {}",
                tool_call.name, reason
            );
            (format!("Error: {}", reason), true)
        } else {
            (String::new(), false)
        }
    } else {
        (String::new(), false)
    };

    let mut rich: Option<ToolExecuteResult> = None;
    // `result_is_error` mirrors the in-block `is_error` decision so the
    // bottom message-writer can stamp the Anthropic wire-format
    // `is_error: true` flag on tool_result blocks. Pre-execute paths
    // (plugin-block, stream parse error, permission-denied) already
    // wrote and returned, so we only thread this through the
    // execute-vs-stale-vs-blocked branches that flow to the writer.
    let mut result_is_error = was_blocked;
    let result = if was_blocked {
        result
    } else {
        let effective_args = intervention
            .and_then(|h| h.modified_params)
            .unwrap_or_else(|| tool_call.arguments.clone());

        if is_cancelled(cancel_flag) {
            return SingleResult::EarlyExit(ToolBatchOutcome::Cancelled);
        }

        // Streaming parse-error short-circuit: the provider's stream
        // gave us bytes we couldn't decode as JSON, and `streaming.rs`
        // replaced the args with a marker. Skip the tool entirely and
        // emit a tool_result that tells the model exactly why, so it
        // can retry with fresh arguments next iteration instead of
        // cascading into a confusing "missing required field" error.
        if let Some(err_msg) = detect_stream_parse_error(&effective_args) {
            warn!(
                "[agent-core] Short-circuiting tool '{}' due to stream parse error: args marker present",
                tool_call.name
            );
            handler.on_tool_result(
                session_id,
                &tool_call.id,
                &tool_call.name,
                &display_tool_name,
                &err_msg,
            );
            add_tool_result(messages, &tool_call.id, &tool_call.name, &err_msg, true);
            *consecutive_errors += 1;
            return SingleResult::Continue;
        }

        if let Some(denied_msg) = check_permission(
            policy,
            permission_provider,
            session_id,
            &tool_call.name,
            &tool_call.id,
            &effective_args,
            cancel_flag,
        )
        .await
        {
            if is_cancelled(cancel_flag) {
                return SingleResult::EarlyExit(ToolBatchOutcome::Cancelled);
            }
            handler.on_tool_result(
                session_id,
                &tool_call.id,
                &tool_call.name,
                &display_tool_name,
                &denied_msg,
            );
            add_tool_result(messages, &tool_call.id, &tool_call.name, &denied_msg, true);
            return SingleResult::Continue;
        }

        let file_time_error = if is_file_write_tool(&tool_call.name) {
            let paths = extract_file_paths(&tool_call.name, &effective_args);
            let mut err: Option<String> = None;
            for path in &paths {
                if let Err(msg) = file_tracker.assert_fresh(path) {
                    err = Some(msg);
                    break;
                }
            }
            err
        } else {
            None
        };

        if let Some(stale_err) = file_time_error {
            if is_cancelled(cancel_flag) {
                return SingleResult::EarlyExit(ToolBatchOutcome::Cancelled);
            }
            warn!(
                "[agent-core] FileTime guard rejected {}: {}",
                tool_call.name, stale_err
            );
            let err_result = format!("Error: {}", stale_err);
            handler
                .after_tool_execute(
                    session_id,
                    &tool_call.id,
                    &tool_call.name,
                    &effective_args,
                    &err_result,
                    Some(&stale_err),
                    0,
                )
                .await;
            result_is_error = true;
            err_result
        } else {
            if is_cancelled(cancel_flag) {
                return SingleResult::EarlyExit(ToolBatchOutcome::Cancelled);
            }
            handler.on_tool_execute_start(
                session_id,
                &tool_call.id,
                &tool_call.name,
                &effective_args,
            );

            let exec_start = Instant::now();
            let ctx = crate::tools::call_context::CallContext::new(&tool_call.id, session_id);
            let raw_outcome = tools
                .execute_with_policy(&tool_call.name, effective_args.clone(), policy, &ctx)
                .await;
            let duration_ms = exec_start.elapsed().as_millis() as u64;

            // Split the structured outcome into:
            //   - `raw_result`: the LLM-facing string used by every
            //     existing error / truncation / file-tracking check.
            //   - `rich` (captured into the outer `let mut rich`): the
            //     full ToolExecuteResult on the success path, so the
            //     structured-sidecar emitter can see content_blocks /
            //     mcp_meta.
            let raw_result: String = match raw_outcome {
                Ok(result) => {
                    let text = result.text.clone();
                    rich = Some(result);
                    text
                }
                Err(msg) => msg,
            };
            let is_error = rich.is_none() || is_error_text(&raw_result);
            result_is_error = is_error;

            // Single entry point keeps read/write bookkeeping identical to the
            // concurrent path in `parallel.rs` (no drift).
            file_tracker.record_tool_file_effects(&tool_call.name, &effective_args, is_error);
            if is_file_write_tool(&tool_call.name) && !is_error {
                let changed_paths = extract_file_paths(&tool_call.name, &effective_args);
                if !changed_paths.is_empty() {
                    handler.on_file_change(session_id, &tool_call.name, &changed_paths);
                }
            }

            let budget = tools.get(&tool_call.name).map(|t| t.output_budget());
            let mut truncated = truncate_output(&raw_result, budget);

            if truncated.trim().is_empty() {
                truncated = "[No output]".to_string();
            }

            if is_file_write_tool(&tool_call.name) && !is_error {
                if let Some(summary) = compute_diff_feedback(&tool_call.name, &effective_args) {
                    truncated.push_str(&format!("\n{}", summary));
                }
            }

            if let Some(extra) = handler
                .post_tool_hook(&tool_call.name, &effective_args, &truncated)
                .await
            {
                truncated.push_str(&extra);
            }

            if FILE_READ_TOOLS.contains(&tool_call.name.as_str()) && !is_error {
                let paths = extract_file_paths(&tool_call.name, &effective_args);
                if let Some(extra) = policy_context_activator
                    .and_then(|activator| activator.augment_for_read_paths(&paths))
                {
                    truncated.push_str(&extra);
                }
            }

            if let Some(ws) = workspace_path {
                let persist_threshold = tools
                    .get(&tool_call.name)
                    .map(|t| t.persist_threshold())
                    .unwrap_or(usize::MAX);
                if truncated.len() > persist_threshold && !is_error {
                    use super::super::tool_result_storage;
                    match tool_result_storage::persist_tool_result(
                        ws,
                        session_id,
                        &tool_call.id,
                        &truncated,
                    ) {
                        Ok(persisted) => {
                            truncated = tool_result_storage::build_large_result_message(&persisted);
                        }
                        Err(err) => {
                            warn!("[agent-core] Failed to persist tool result: {}", err);
                        }
                    }
                }
            }

            let error_str = if is_error {
                Some(raw_result.as_str())
            } else {
                None
            };
            handler
                .after_tool_execute(
                    session_id,
                    &tool_call.id,
                    &tool_call.name,
                    &effective_args,
                    &truncated,
                    error_str,
                    duration_ms,
                )
                .await;

            truncated
        }
    };

    let ui_metadata = tools
        .get(&tool_call.name)
        .and_then(|tool| tool.ui_metadata(&tool_call.arguments, &result));

    handler.on_tool_result_with_metadata(
        session_id,
        &tool_call.id,
        &tool_call.name,
        &display_tool_name,
        &result,
        ui_metadata.as_ref(),
    );

    match rich.as_ref() {
        Some(rich_result) if rich_result.has_structured_payload() => {
            // Carry content_blocks / mcp_meta in the `_orgii_structured`
            // sidecar for the Anthropic-native wire format.
            add_tool_result_rich_with_timestamp(
                messages,
                &tool_call.id,
                &tool_call.name,
                &result,
                rich_result,
                result_is_error,
            );
        }
        _ => {
            add_tool_result_with_timestamp(
                messages,
                &tool_call.id,
                &tool_call.name,
                &result,
                result_is_error,
            );
        }
    }

    if is_cancelled(cancel_flag) {
        info!(
            "[agent-core] Cancelled after tool result emission (session={})",
            session_id
        );
        return SingleResult::EarlyExit(ToolBatchOutcome::Cancelled);
    }

    if tool_call.name == crate::tools::names::SUGGEST_MODE_SWITCH
        && result.starts_with(
            crate::tools::impls::orchestration::suggest_mode_switch::SWITCH_ACCEPTED_PREFIX,
        )
    {
        return SingleResult::EarlyExit(ToolBatchOutcome::EndTurn(String::new()));
    }

    if tool_call.name == crate::tools::names::CREATE_PLAN
        && result.starts_with(
            crate::tools::impls::plan_mode::create_plan::PLAN_SUBMITTED_END_TURN_PREFIX,
        )
    {
        // Plan was submitted for user review — end the turn so the FE
        // session drops to idle and the "Build" card is the only thing
        // awaiting user action. The user either clicks Build (which
        // triggers the next turn via `agent_plan_approval_response`) or
        // replies in chat to iterate.
        //
        // Note: only top-level `create_plan` calls carry this prefix; a
        // subagent's `create_plan` is a regular file-write and does NOT
        // end the parent turn.
        return SingleResult::EarlyExit(ToolBatchOutcome::EndTurn(String::new()));
    }

    if is_cancelled(cancel_flag) {
        info!(
            "[agent-core] Cancelled between tool calls (session={})",
            session_id
        );
        return SingleResult::EarlyExit(ToolBatchOutcome::Cancelled);
    }

    if is_error_text(&result) {
        *consecutive_errors += 1;
        if *consecutive_errors >= super::super::MAX_CONSECUTIVE_ERRORS {
            warn!(
                "[agent-core] {} consecutive tool errors, breaking loop (session={})",
                *consecutive_errors, session_id
            );
            let mut end = result.len().min(300);
            while !result.is_char_boundary(end) && end > 0 {
                end -= 1;
            }
            return SingleResult::EarlyExit(ToolBatchOutcome::ErrorLoop(format!(
                "I encountered {} consecutive tool errors and stopped to avoid wasting resources. \
                 The last error was: {}",
                *consecutive_errors,
                &result[..end]
            )));
        }
    } else {
        *consecutive_errors = 0;
    }

    SingleResult::Continue
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::test_support::{test_registry, MockEventHandler};

    #[tokio::test]
    async fn execute_start_uses_hook_modified_args() {
        let mut messages = vec![json!({"role": "user", "content": "edit"})];
        let call = ToolCallRequest {
            id: "call_edit".to_string(),
            name: crate::tools::names::EDIT_FILE.to_string(),
            arguments: json!({"file_path": "original.txt", "content": "old"}),
            thought_signature: None,
        };
        let handler = MockEventHandler::new().with_modified_params(json!({
            "file_path": "modified.txt",
            "content": "new"
        }));
        let tools = test_registry();
        let policy = ResolvedToolPolicy::permissive();
        let mut file_tracker = FileTimeTracker::new();
        let mut consecutive_errors = 0;

        let result = execute_single_tool(
            &mut messages,
            &call,
            &tools,
            &policy,
            "session-test",
            &handler,
            None,
            None,
            &mut file_tracker,
            &mut consecutive_errors,
            None,
            None,
        )
        .await;

        assert!(matches!(result, SingleResult::Continue));
        let tool_calls = handler.tool_calls.lock().unwrap().clone();
        assert_eq!(tool_calls[0].2["file_path"], "original.txt");

        let execute_starts = handler.tool_execute_starts.lock().unwrap().clone();
        assert_eq!(execute_starts[0].2["file_path"], "modified.txt");
    }
}

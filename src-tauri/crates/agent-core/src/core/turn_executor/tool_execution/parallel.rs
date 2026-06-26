//! Concurrent execution of read-only tool call groups.

use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Instant;

use serde_json::Value;
use tracing::info;

use crate::core::tools::traits::ToolExecuteResult;
use crate::providers::traits::ToolCallRequest;
use crate::specialization::policies::activation::SessionScopedContextActivator;
use crate::tools::policy::ResolvedToolPolicy;
use crate::tools::registry::ToolRegistry;

use super::super::file_tracker::{extract_file_paths, FileTimeTracker, FILE_READ_TOOLS};
use super::super::helpers::{
    add_tool_result, add_tool_result_rich_with_timestamp, add_tool_result_with_timestamp,
    check_permission, truncate_output,
};
use super::super::types::{PermissionProvider, TurnEventHandler};

use super::detect_stream_parse_error;
use super::is_cancelled;
use super::is_error_text;
use super::normalize_tool_use_concurrency;
use super::ToolBatchOutcome;

pub(super) enum ParallelResult {
    Continue(usize),
    EarlyExit(usize, ToolBatchOutcome),
}

/// Execute a group of read-only tool calls concurrently.
///
/// Pre-execution hooks and post-execution processing happen sequentially,
/// but the actual `tool.execute(, &crate::tools::call_context::CallContext::default())` calls run in parallel via `join_all`.
#[allow(clippy::too_many_arguments)]
pub(super) async fn execute_parallel_group(
    messages: &mut Vec<Value>,
    calls: &[&ToolCallRequest],
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
    max_tool_use_concurrency: usize,
) -> ParallelResult {
    info!(
        "[agent-core] Executing {} read-only tools concurrently",
        calls.len()
    );

    struct PreparedCall {
        index: usize,
        effective_args: Value,
        display_name: String,
        was_blocked: bool,
        blocked_result: String,
    }

    let mut prepared: Vec<PreparedCall> = Vec::with_capacity(calls.len());
    let mut denied_count: usize = 0;

    for (idx, call) in calls.iter().enumerate() {
        let args_preview: String =
            crate::utils::safe_truncate_chars_to_string(&call.arguments.to_string(), 200);
        info!("[agent-core] Tool call: {}({})", call.name, args_preview);

        if is_cancelled(cancel_flag) {
            return ParallelResult::EarlyExit(denied_count, ToolBatchOutcome::Cancelled);
        }

        let display_name = match call
            .arguments
            .get("action")
            .and_then(|v: &Value| v.as_str())
        {
            Some(action) => format!("{}_{}", call.name, action),
            None => call.name.clone(),
        };

        handler.on_tool_call(
            session_id,
            &call.id,
            &call.name,
            &display_name,
            &call.arguments,
        );

        let intervention = handler
            .before_tool_execute(session_id, &call.name, &call.arguments)
            .await;

        let (blocked_result, was_blocked) = if let Some(ref hook) = intervention {
            if hook.block {
                let reason = hook.block_reason.as_deref().unwrap_or("Blocked by plugin");
                info!(
                    "[agent-core] Tool {} blocked by plugin: {}",
                    call.name, reason
                );
                (format!("Error: {}", reason), true)
            } else {
                (String::new(), false)
            }
        } else {
            (String::new(), false)
        };

        if was_blocked {
            prepared.push(PreparedCall {
                index: idx,
                effective_args: call.arguments.clone(),
                display_name,
                was_blocked: true,
                blocked_result,
            });
            continue;
        }

        let effective_args = intervention
            .and_then(|h| h.modified_params)
            .unwrap_or_else(|| call.arguments.clone());

        // Same streaming parse-error short-circuit as `single.rs`. We
        // short-circuit here *before* permission/execution so the
        // model sees a clear "retry tool call" error message instead
        // of a confusing schema-validation failure from the tool
        // itself. See `detect_stream_parse_error` for the rationale.
        if let Some(err_msg) = detect_stream_parse_error(&effective_args) {
            tracing::warn!(
                "[agent-core] Short-circuiting parallel tool '{}' due to stream parse error",
                call.name
            );
            handler.on_tool_result(session_id, &call.id, &call.name, &display_name, &err_msg);
            add_tool_result(messages, &call.id, &call.name, &err_msg, true);
            *consecutive_errors += 1;
            denied_count += 1;
            continue;
        }

        if let Some(denied_msg) = check_permission(
            policy,
            permission_provider,
            session_id,
            &call.name,
            &call.id,
            &effective_args,
            cancel_flag,
        )
        .await
        {
            if is_cancelled(cancel_flag) {
                return ParallelResult::EarlyExit(denied_count, ToolBatchOutcome::Cancelled);
            }
            handler.on_tool_result(session_id, &call.id, &call.name, &display_name, &denied_msg);
            add_tool_result(messages, &call.id, &call.name, &denied_msg, true);
            denied_count += 1;
            continue;
        }

        prepared.push(PreparedCall {
            index: idx,
            effective_args,
            display_name,
            was_blocked: false,
            blocked_result: String::new(),
        });
    }

    struct ExecResult {
        index: usize,
        /// Full structured result from `Tool::execute`. The MCP bridge
        /// populates `content_blocks` / `mcp_meta`; native tools leave
        /// them empty. On policy-deny or internal error, this is
        /// `Err(msg)` and carries only the error string.
        raw_result: Result<ToolExecuteResult, String>,
        duration_ms: u64,
        effective_args: Value,
        display_name: String,
    }

    let mut blocked_results: Vec<(usize, String, String)> = Vec::new();
    let mut futures_to_run: Vec<(usize, Value, String)> = Vec::new();

    for prep in prepared {
        if prep.was_blocked {
            blocked_results.push((prep.index, prep.display_name, prep.blocked_result));
            continue;
        }

        if is_cancelled(cancel_flag) {
            return ParallelResult::EarlyExit(denied_count, ToolBatchOutcome::Cancelled);
        }
        let call = calls[prep.index];
        handler.on_tool_execute_start(session_id, &call.id, &call.name, &prep.effective_args);
        futures_to_run.push((prep.index, prep.effective_args, prep.display_name));
    }

    let concurrency_limit = normalize_tool_use_concurrency(max_tool_use_concurrency);
    let mut exec_outputs = Vec::with_capacity(futures_to_run.len());

    for chunk in futures_to_run.chunks(concurrency_limit) {
        let exec_futures: Vec<_> = chunk
            .iter()
            .map(|(idx, effective_args, _display_name)| {
                let tool_name = &calls[*idx].name;
                let call_id = &calls[*idx].id;
                let ctx = crate::tools::call_context::CallContext::new(call_id, session_id);
                let args = effective_args.clone();
                async move {
                    let start = Instant::now();
                    let raw_result = tools
                        .execute_with_policy(tool_name, args, policy, &ctx)
                        .await;
                    let duration_ms = start.elapsed().as_millis() as u64;
                    (*idx, raw_result, duration_ms)
                }
            })
            .collect();

        exec_outputs.extend(futures::future::join_all(exec_futures).await);
    }

    let mut results_by_index: std::collections::BTreeMap<usize, ExecResult> =
        std::collections::BTreeMap::new();
    for ((idx, raw_result, duration_ms), (_, effective_args, display_name)) in
        exec_outputs.into_iter().zip(futures_to_run.into_iter())
    {
        results_by_index.insert(
            idx,
            ExecResult {
                index: idx,
                raw_result,
                duration_ms,
                effective_args,
                display_name,
            },
        );
    }

    let mut executed_count = 0;

    for (idx, display_name, result) in &blocked_results {
        let call = calls[*idx];
        let is_err = is_error_text(result);
        handler.on_tool_result(session_id, &call.id, &call.name, display_name, result);
        add_tool_result_with_timestamp(messages, &call.id, &call.name, result, is_err);
        executed_count += 1;

        if is_err {
            *consecutive_errors += 1;
        } else {
            *consecutive_errors = 0;
        }
    }

    for (_idx, exec_result) in results_by_index {
        let call = calls[exec_result.index];

        // Split the exec outcome into:
        //   - `raw_text`: the LLM-facing string (always present; error
        //     messages on the Err path, tool text on the Ok path).
        //   - `rich`: the full structured result on the Ok path, used by
        //     the Anthropic-native wire to attach image/audio/resource
        //     blocks + `_meta` to the outgoing tool message. `None` on
        //     the Err path.
        let (raw_text, rich): (String, Option<ToolExecuteResult>) = match exec_result.raw_result {
            Ok(result) => (result.text.clone(), Some(result)),
            Err(msg) => (msg, None),
        };
        let is_error = rich.is_none() || is_error_text(&raw_text);

        // Single entry point keeps read/write bookkeeping identical to the
        // sequential path in `single.rs` (no drift).
        file_tracker.record_tool_file_effects(&call.name, &exec_result.effective_args, is_error);

        let budget = tools.get(&call.name).map(|t| t.output_budget());
        let mut truncated = truncate_output(&raw_text, budget);

        if truncated.trim().is_empty() {
            truncated = "[No output]".to_string();
        }

        if let Some(extra) = handler
            .post_tool_hook(&call.name, &exec_result.effective_args, &truncated)
            .await
        {
            truncated.push_str(&extra);
        }

        if FILE_READ_TOOLS.contains(&call.name.as_str()) && !is_error {
            let paths = extract_file_paths(&call.name, &exec_result.effective_args);
            if let Some(extra) = policy_context_activator
                .and_then(|activator| activator.augment_for_read_paths(&paths))
            {
                truncated.push_str(&extra);
            }
        }

        if let Some(ws) = workspace_path {
            let persist_threshold = tools
                .get(&call.name)
                .map(|t| t.persist_threshold())
                .unwrap_or(usize::MAX);
            if truncated.len() > persist_threshold && !is_error {
                use super::super::tool_result_storage;
                match tool_result_storage::persist_tool_result(ws, session_id, &call.id, &truncated)
                {
                    Ok(persisted) => {
                        truncated = tool_result_storage::build_large_result_message(&persisted);
                    }
                    Err(err) => {
                        tracing::warn!("[agent-core] Failed to persist tool result: {}", err);
                    }
                }
            }
        }

        let error_str = if is_error {
            Some(raw_text.as_str())
        } else {
            None
        };
        handler
            .after_tool_execute(
                session_id,
                &call.id,
                &call.name,
                &exec_result.effective_args,
                &truncated,
                error_str,
                exec_result.duration_ms,
            )
            .await;

        let ui_metadata = tools
            .get(&call.name)
            .and_then(|tool| tool.ui_metadata(&exec_result.effective_args, &truncated));

        handler.on_tool_result_with_metadata(
            session_id,
            &call.id,
            &call.name,
            &exec_result.display_name,
            &truncated,
            ui_metadata.as_ref(),
        );
        // Carry the in-block `is_error` decision through to the wire
        // emitter. We want the post-truncation/persistence flag, so
        // re-evaluate against the final string the LLM will see; this
        // also catches the rare case where `truncate_output` collapses
        // a non-error into an empty `[No output]` (still success).
        let truncated_is_error = is_error || is_error_text(&truncated);
        match rich.as_ref() {
            Some(rich_result) if rich_result.has_structured_payload() => {
                // Carry structured content_blocks / mcp_meta in the
                // `_orgii_structured` sidecar so Anthropic-native
                // provider can promote them to top-level user.content[].
                add_tool_result_rich_with_timestamp(
                    messages,
                    &call.id,
                    &call.name,
                    &truncated,
                    rich_result,
                    truncated_is_error,
                );
            }
            _ => {
                add_tool_result_with_timestamp(
                    messages,
                    &call.id,
                    &call.name,
                    &truncated,
                    truncated_is_error,
                );
            }
        }
        executed_count += 1;

        if is_cancelled(cancel_flag) {
            return ParallelResult::EarlyExit(
                executed_count + denied_count,
                ToolBatchOutcome::Cancelled,
            );
        }

        if is_error_text(&truncated) {
            *consecutive_errors += 1;
            if *consecutive_errors >= super::super::MAX_CONSECUTIVE_ERRORS {
                let mut end = truncated.len().min(300);
                while !truncated.is_char_boundary(end) && end > 0 {
                    end -= 1;
                }
                return ParallelResult::EarlyExit(
                    executed_count + denied_count,
                    ToolBatchOutcome::ErrorLoop(format!(
                        "I encountered {} consecutive tool errors and stopped to avoid wasting resources. \
                         The last error was: {}",
                        *consecutive_errors,
                        &truncated[..end]
                    )),
                );
            }
        } else {
            *consecutive_errors = 0;
        }
    }

    ParallelResult::Continue(executed_count + denied_count)
}

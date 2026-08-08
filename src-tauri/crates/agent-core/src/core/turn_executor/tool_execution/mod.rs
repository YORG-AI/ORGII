//! Tool call execution — handles tool calls within a turn.
//!
//! Supports concurrent execution of read-only tools when the LLM requests
//! multiple tool calls in a single response. Write tools always execute
//! sequentially.
//!
//! Split across submodules to stay within the 600-line file-size guideline:
//!
//! | Submodule       | Responsibility                                             |
//! |-----------------|------------------------------------------------------------|
//! | `parallel`      | Concurrent execution of read-only tool groups (`join_all`) |
//! | `single`        | Sequential execution of a single tool call                 |
//! | `diff_feedback` | Post-write diff summaries for `edit_file` / `apply_patch`  |
//!
//! Tool calls are executed only after the provider stream completes. Streaming
//! deltas may update the UI while arguments arrive, but every completed call
//! enters `execute_tool_calls` so permission checks, hooks, file tracking,
//! persistence, metadata, and error accounting stay in one chokepoint.
//!
//! The execution path constructs a typed [`CallContext`](crate::tools::traits::CallContext)
//! per call, so adding a new framework metadata field is a struct-field
//! change in `call_context.rs` plus population at the dispatch site.

mod diff_feedback;
mod parallel;
mod single;

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use serde_json::Value;

use crate::core::providers::openai_compat::STREAM_PARSE_ERROR_KEY;
use crate::providers::traits::ToolCallRequest;
use crate::specialization::policies::activation::SessionScopedContextActivator;
use crate::tools::policy::ResolvedToolPolicy;
use crate::tools::registry::ToolRegistry;

use super::file_tracker::FileTimeTracker;
use super::types::{PermissionProvider, TurnEventHandler};
use super::usage_telemetry::ToolExecutionUsage;

use parallel::{execute_parallel_group, ParallelResult};
use single::{execute_single_tool, SingleResult};

/// Prefix that marks a tool-result string as an error.
///
/// Both `single` and `parallel` execution paths build error tool_result
/// strings as `format!("Error: {}", reason)` (and `truncate_output` is
/// transparent to leading text). `is_error_text` performs the structural
/// check so the `"Error"` literal lives in exactly one place.
pub(crate) const TOOL_ERROR_PREFIX: &str = "Error";
pub(crate) fn normalize_tool_use_concurrency(value: usize) -> usize {
    if value > 0 {
        value
    } else {
        crate::core::definitions::schema::DEFAULT_MAX_TOOL_USE_CONCURRENCY as usize
    }
}

/// Returns true if `text` is a tool-result string that should be counted
/// against the consecutive-error budget. Mirrors the historical
/// `text.starts_with("Error")` check.
pub(crate) fn is_error_text(text: &str) -> bool {
    text.starts_with(TOOL_ERROR_PREFIX)
}

const TOOL_RESULT_AGGREGATE_BUDGET_CHARS: usize = 200_000;

/// Legibility floor: even when earlier tools in a batch have consumed the
/// aggregate budget, every result keeps at least this much room so late
/// tools degrade to a usable stub instead of being squeezed to ~1 char.
const MIN_RESULT_BUDGET_CHARS: usize = 2_000;

/// Cap on post-truncation hook/policy text appended to a tool result
/// (`post_tool_hook` extras, read-path policy activations). These appends
/// happen after budget accounting, so an uncapped hook could bypass both
/// the per-tool and aggregate budgets.
pub(super) const HOOK_APPEND_MAX_CHARS: usize = 10_000;

/// Marker prefix for inline image results (resolved to image blocks by
/// `turn_executor/screenshot.rs`). Kept in sync with the marker emitted by
/// `tool_infra/file/read.rs`.
const INLINE_IMAGE_MARKER: &str = "[image:";

pub(super) struct ToolResultAggregateBudget {
    remaining: usize,
}

impl Default for ToolResultAggregateBudget {
    fn default() -> Self {
        Self {
            remaining: TOOL_RESULT_AGGREGATE_BUDGET_CHARS,
        }
    }
}

impl ToolResultAggregateBudget {
    pub(super) fn inline_result(
        &mut self,
        raw_text: &str,
        per_tool_budget: Option<usize>,
        allow_persist: bool,
        session_id: &str,
        tool_name: &str,
    ) -> String {
        let per_tool_limit = per_tool_budget.unwrap_or(super::MAX_TOOL_OUTPUT_CHARS);
        let effective_budget = per_tool_limit.min(self.remaining.max(MIN_RESULT_BUDGET_CHARS));

        // Char truncation must never cut an inline image marker: the
        // resolver regex no longer matches and the model receives the
        // budget's worth of raw base64 noise. Replace the whole result
        // with actionable advice instead.
        if raw_text.len() > effective_budget && raw_text.contains(INLINE_IMAGE_MARKER) {
            let rendered = format!(
                "[image omitted] The {} result contains an inline image encoded as {} KB of base64, \
                 which exceeds the {} KB inline budget — truncated base64 would decode to a corrupt \
                 image, so nothing was attached. Downscale or crop the image first (e.g. \
                 `sips -Z 1024 <file>` on macOS or ImageMagick `convert <file> -resize 1024x1024 ...`), \
                 then read the smaller file.",
                tool_name,
                raw_text.len() / 1024,
                effective_budget / 1024,
            );
            self.remaining = self.remaining.saturating_sub(rendered.len());
            return rendered;
        }

        let rendered = if allow_persist {
            super::helpers::truncate_or_persist_output(
                raw_text,
                Some(effective_budget),
                session_id,
                tool_name,
            )
        } else {
            super::helpers::truncate_output(raw_text, Some(effective_budget))
        };
        self.remaining = self.remaining.saturating_sub(rendered.len());
        rendered
    }
}

pub(crate) fn is_cancelled(cancel_flag: Option<&Arc<AtomicBool>>) -> bool {
    cancel_flag.is_some_and(|flag| flag.load(std::sync::atomic::Ordering::Relaxed))
}

/// If `args` is the synthetic marker that the streaming parser injects
/// when it fails to decode the accumulated `function.arguments` JSON,
/// return a human-readable error message suitable for a tool_result.
/// Otherwise return `None` and let the caller run the tool normally.
///
/// The message intentionally mentions "streaming JSON" and "retry" so
/// the model understands this is a transport-layer failure, not a
/// schema-validation rejection from the tool itself. Well-behaved models
/// will re-emit the tool call with fresh arguments on the next iteration.
pub(super) fn detect_stream_parse_error(args: &Value) -> Option<String> {
    let obj = args.as_object()?;
    let marker = obj.get(STREAM_PARSE_ERROR_KEY)?;
    let cause = marker
        .get("cause")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    let parse_err = marker
        .get("parse_err")
        .and_then(|v| v.as_str())
        .unwrap_or("(no detail)");
    let total_len = marker
        .get("total_len")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let preview = marker.get("preview").and_then(|v| v.as_str()).unwrap_or("");
    Some(format!(
        "Error: streaming JSON parse failure — the tool call arguments \
         could not be decoded from the provider's SSE stream. \
         cause={} | parse_err={} | total_len={} | preview={:?}. \
         Please retry the tool call with fresh arguments.",
        cause, parse_err, total_len, preview
    ))
}

/// Outcome of executing a batch of tool calls in one LLM iteration.
pub(crate) enum ToolBatchOutcome {
    /// All tool calls processed; continue to next LLM iteration.
    Continue,
    /// A mode switch was accepted; end the turn with this content.
    EndTurn(String),
    /// Cancelled by user mid-execution.
    Cancelled,
    /// Too many consecutive errors; end the turn with this message.
    ErrorLoop(String),
}

/// A group of tool calls that can be executed together.
enum ToolGroup<'a> {
    /// Consecutive concurrency-safe tools that can run concurrently.
    Parallel(Vec<&'a ToolCallRequest>),
    /// A single non-concurrency-safe (write) tool that must run alone.
    Sequential(&'a ToolCallRequest),
}

/// Partition tool calls into parallel (concurrency-safe) and sequential
/// (write) groups: consecutive concurrency-safe calls are grouped together;
/// any other call gets its own sequential group.
fn partition_tool_calls<'a>(
    calls: &'a [ToolCallRequest],
    tools: &ToolRegistry,
) -> Vec<ToolGroup<'a>> {
    let mut groups: Vec<ToolGroup<'a>> = Vec::new();
    let mut current_parallel: Vec<&'a ToolCallRequest> = Vec::new();

    for call in calls {
        let concurrency_safe = tools
            .get(&call.name)
            .map(|t| t.is_concurrency_safe())
            .unwrap_or(false);

        if concurrency_safe {
            current_parallel.push(call);
        } else {
            if !current_parallel.is_empty() {
                groups.push(ToolGroup::Parallel(std::mem::take(&mut current_parallel)));
            }
            groups.push(ToolGroup::Sequential(call));
        }
    }

    if !current_parallel.is_empty() {
        groups.push(ToolGroup::Parallel(current_parallel));
    }

    groups
}

/// Execute all tool calls from a single LLM response, recording results into `messages`.
///
/// Read-only tools within a consecutive group are executed concurrently
/// (their actual `execute()` call runs in parallel via `join_all`).
/// Write tools always execute one at a time.
///
/// Returns how many tool calls were actually executed (for backfill tracking)
/// and the outcome that determines whether the outer loop should continue.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn execute_tool_calls(
    messages: &mut Vec<Value>,
    tool_calls: &[ToolCallRequest],
    tools: &ToolRegistry,
    policy: &ResolvedToolPolicy,
    session_id: &str,
    turn_intent_id: &str,
    projected_inbox_ids: &[i64],
    handler: &dyn TurnEventHandler,
    permission_provider: Option<&dyn PermissionProvider>,
    cancel_flag: Option<&Arc<AtomicBool>>,
    file_tracker: &mut FileTimeTracker,
    consecutive_errors: &mut u32,
    policy_context_activator: Option<&SessionScopedContextActivator>,
    max_tool_use_concurrency: usize,
) -> (usize, Vec<ToolExecutionUsage>, ToolBatchOutcome) {
    let groups = partition_tool_calls(tool_calls, tools);
    let mut executed_count = 0;
    let mut execution_usage = Vec::new();
    let mut aggregate_budget = ToolResultAggregateBudget::default();

    for group in groups {
        match group {
            ToolGroup::Parallel(calls) if calls.len() > 1 => {
                let result = execute_parallel_group(
                    messages,
                    &calls,
                    tools,
                    policy,
                    session_id,
                    turn_intent_id,
                    projected_inbox_ids,
                    handler,
                    permission_provider,
                    cancel_flag,
                    file_tracker,
                    consecutive_errors,
                    policy_context_activator,
                    max_tool_use_concurrency,
                    &mut aggregate_budget,
                )
                .await;
                match result {
                    ParallelResult::Continue(count, mut usage) => {
                        executed_count += count;
                        execution_usage.append(&mut usage);
                    }
                    ParallelResult::EarlyExit(count, mut usage, outcome) => {
                        execution_usage.append(&mut usage);
                        return (executed_count + count, execution_usage, outcome);
                    }
                }
            }
            ToolGroup::Parallel(calls) => {
                for call in calls {
                    let result = execute_single_tool(
                        messages,
                        call,
                        tools,
                        policy,
                        session_id,
                        turn_intent_id,
                        projected_inbox_ids,
                        handler,
                        permission_provider,
                        cancel_flag,
                        file_tracker,
                        consecutive_errors,
                        policy_context_activator,
                        &mut aggregate_budget,
                    )
                    .await;
                    match result {
                        SingleResult::Continue(usage) => {
                            executed_count += 1;
                            execution_usage.push(usage);
                        }
                        SingleResult::EarlyExit(outcome) => {
                            return (executed_count + 1, execution_usage, outcome);
                        }
                    }
                }
            }
            ToolGroup::Sequential(call) => {
                let result = execute_single_tool(
                    messages,
                    call,
                    tools,
                    policy,
                    session_id,
                    turn_intent_id,
                    projected_inbox_ids,
                    handler,
                    permission_provider,
                    cancel_flag,
                    file_tracker,
                    consecutive_errors,
                    policy_context_activator,
                    &mut aggregate_budget,
                )
                .await;
                match result {
                    SingleResult::Continue(usage) => {
                        executed_count += 1;
                        execution_usage.push(usage);
                    }
                    SingleResult::EarlyExit(outcome) => {
                        return (executed_count + 1, execution_usage, outcome);
                    }
                }
            }
        }
    }

    (executed_count, execution_usage, ToolBatchOutcome::Continue)
}

#[cfg(test)]
#[allow(clippy::field_reassign_with_default)]
// Budget tests mutate the one field whose boundary behavior they exercise.
mod tests {
    use super::*;
    use crate::tools::traits::{Tool, ToolError};
    use async_trait::async_trait;

    struct FakeReadTool;
    #[async_trait]
    impl Tool for FakeReadTool {
        fn name(&self) -> &str {
            "read_file"
        }
        fn description(&self) -> &str {
            "read"
        }
        fn parameters(&self) -> Value {
            serde_json::json!({"type":"object","properties":{}})
        }
        fn is_read_only(&self) -> bool {
            true
        }
        async fn execute_text(
            &self,
            _params: Value,
            _ctx: &crate::tools::traits::CallContext,
        ) -> Result<String, ToolError> {
            Ok("ok".into())
        }
    }

    struct FakeWriteTool;
    #[async_trait]
    impl Tool for FakeWriteTool {
        fn name(&self) -> &str {
            "edit_file"
        }
        fn description(&self) -> &str {
            "edit"
        }
        fn parameters(&self) -> Value {
            serde_json::json!({"type":"object","properties":{}})
        }
        async fn execute_text(
            &self,
            _params: Value,
            _ctx: &crate::tools::traits::CallContext,
        ) -> Result<String, ToolError> {
            Ok("ok".into())
        }
    }

    struct FakeSearchTool;
    #[async_trait]
    impl Tool for FakeSearchTool {
        fn name(&self) -> &str {
            "code_search"
        }
        fn description(&self) -> &str {
            "search"
        }
        fn parameters(&self) -> Value {
            serde_json::json!({"type":"object","properties":{}})
        }
        fn is_read_only(&self) -> bool {
            true
        }
        async fn execute_text(
            &self,
            _params: Value,
            _ctx: &crate::tools::traits::CallContext,
        ) -> Result<String, ToolError> {
            Ok("ok".into())
        }
    }

    /// Mimics `agent`: mutates state (not read-only) but each invocation is
    /// isolated, so it opts into concurrent execution.
    struct FakeAgentTool;
    #[async_trait]
    impl Tool for FakeAgentTool {
        fn name(&self) -> &str {
            "agent"
        }
        fn description(&self) -> &str {
            "agent"
        }
        fn parameters(&self) -> Value {
            serde_json::json!({"type":"object","properties":{}})
        }
        fn is_concurrency_safe(&self) -> bool {
            true
        }
        async fn execute_text(
            &self,
            _params: Value,
            _ctx: &crate::tools::traits::CallContext,
        ) -> Result<String, ToolError> {
            Ok("ok".into())
        }
    }

    fn tc(name: &str, id: &str) -> ToolCallRequest {
        ToolCallRequest {
            id: id.to_string(),
            name: name.to_string(),
            arguments: serde_json::json!({}),
            thought_signature: None,
        }
    }

    fn make_registry() -> ToolRegistry {
        let mut reg = ToolRegistry::new();
        reg.register(Box::new(FakeReadTool));
        reg.register(Box::new(FakeWriteTool));
        reg.register(Box::new(FakeSearchTool));
        reg.register(Box::new(FakeAgentTool));
        reg
    }

    #[test]
    fn partition_all_readonly_becomes_one_parallel_group() {
        let reg = make_registry();
        let calls = vec![tc("read_file", "1"), tc("code_search", "2")];
        let groups = partition_tool_calls(&calls, &reg);
        assert_eq!(groups.len(), 1);
        assert!(matches!(&groups[0], ToolGroup::Parallel(v) if v.len() == 2));
    }

    #[test]
    fn partition_all_write_becomes_sequential() {
        let reg = make_registry();
        let calls = vec![tc("edit_file", "1"), tc("edit_file", "2")];
        let groups = partition_tool_calls(&calls, &reg);
        assert_eq!(groups.len(), 2);
        assert!(matches!(&groups[0], ToolGroup::Sequential(_)));
        assert!(matches!(&groups[1], ToolGroup::Sequential(_)));
    }

    #[test]
    fn partition_mixed_splits_correctly() {
        let reg = make_registry();
        let calls = vec![
            tc("read_file", "1"),
            tc("code_search", "2"),
            tc("edit_file", "3"),
            tc("read_file", "4"),
        ];
        let groups = partition_tool_calls(&calls, &reg);
        assert_eq!(groups.len(), 3);
        assert!(matches!(&groups[0], ToolGroup::Parallel(v) if v.len() == 2));
        assert!(matches!(&groups[1], ToolGroup::Sequential(_)));
        assert!(matches!(&groups[2], ToolGroup::Parallel(v) if v.len() == 1));
    }

    #[test]
    fn partition_unknown_tool_treated_as_write() {
        let reg = make_registry();
        let calls = vec![tc("unknown_tool", "1"), tc("read_file", "2")];
        let groups = partition_tool_calls(&calls, &reg);
        assert_eq!(groups.len(), 2);
        assert!(matches!(&groups[0], ToolGroup::Sequential(_)));
        assert!(matches!(&groups[1], ToolGroup::Parallel(v) if v.len() == 1));
    }

    #[test]
    fn partition_empty_returns_empty() {
        let reg = make_registry();
        let calls: Vec<ToolCallRequest> = vec![];
        let groups = partition_tool_calls(&calls, &reg);
        assert!(groups.is_empty());
    }

    /// Regression: N `agent` launches in one LLM response must form ONE
    /// parallel group, not N sequential groups (each foreground delegate
    /// would otherwise block the next — "4 workers" degrades to serial).
    #[test]
    fn partition_multiple_agent_calls_one_parallel_group() {
        let reg = make_registry();
        let calls = vec![
            tc("agent", "1"),
            tc("agent", "2"),
            tc("agent", "3"),
            tc("agent", "4"),
        ];
        let groups = partition_tool_calls(&calls, &reg);
        assert_eq!(groups.len(), 1);
        assert!(matches!(&groups[0], ToolGroup::Parallel(v) if v.len() == 4));
    }

    #[test]
    fn partition_agent_groups_with_readonly_but_not_write() {
        let reg = make_registry();
        let calls = vec![
            tc("read_file", "1"),
            tc("agent", "2"),
            tc("edit_file", "3"),
            tc("agent", "4"),
        ];
        let groups = partition_tool_calls(&calls, &reg);
        assert_eq!(groups.len(), 3);
        assert!(matches!(&groups[0], ToolGroup::Parallel(v) if v.len() == 2));
        assert!(matches!(&groups[1], ToolGroup::Sequential(_)));
        assert!(matches!(&groups[2], ToolGroup::Parallel(v) if v.len() == 1));
    }

    // ---- max_tool_use_concurrency ----

    #[test]
    fn normalize_tool_use_concurrency_uses_default_for_zero() {
        assert_eq!(
            normalize_tool_use_concurrency(0),
            crate::core::definitions::schema::DEFAULT_MAX_TOOL_USE_CONCURRENCY as usize
        );
    }

    #[test]
    fn normalize_tool_use_concurrency_accepts_positive_values() {
        assert_eq!(normalize_tool_use_concurrency(3), 3);
        assert_eq!(normalize_tool_use_concurrency(10), 10);
    }

    // ---- ToolResultAggregateBudget ----

    #[test]
    fn inline_result_floor_prevents_starvation_when_budget_exhausted() {
        let mut budget = ToolResultAggregateBudget::default();
        budget.remaining = 0;
        let raw = "x".repeat(10_000);
        let out = budget.inline_result(&raw, Some(50_000), false, "sess-floor", "read_file");
        assert!(
            out.contains("[output truncated"),
            "expected truncation marker, got: {}",
            &out[..out.len().min(200)]
        );
        // Effective budget is the 2K floor, not 1 char.
        assert!(
            out.len() >= MIN_RESULT_BUDGET_CHARS / 2 && out.len() <= MIN_RESULT_BUDGET_CHARS + 200,
            "expected ~{} chars, got {}",
            MIN_RESULT_BUDGET_CHARS,
            out.len()
        );
    }

    #[test]
    fn inline_result_under_budget_passes_through() {
        let mut budget = ToolResultAggregateBudget::default();
        let out = budget.inline_result("small", Some(50_000), false, "sess-small", "read_file");
        assert_eq!(out, "small");
        assert_eq!(
            budget.remaining,
            TOOL_RESULT_AGGREGATE_BUDGET_CHARS - "small".len()
        );
    }

    #[test]
    fn inline_result_never_cuts_image_marker_mid_base64() {
        let mut budget = ToolResultAggregateBudget::default();
        let raw = format!(
            "Image: shot.png (image/png, 300.0 KB)\n\n[image:image/png:{}]",
            "A".repeat(400_000)
        );
        let out = budget.inline_result(&raw, Some(100_000), false, "sess-img", "read_file");
        assert!(
            out.starts_with("[image omitted]"),
            "expected advice message, got: {}",
            &out[..out.len().min(200)]
        );
        assert!(
            !out.contains("[image:image/png:"),
            "marker must not survive partially"
        );
        assert!(out.contains("Downscale or crop"), "got: {out}");
    }

    #[test]
    fn inline_result_keeps_image_marker_when_under_budget() {
        let mut budget = ToolResultAggregateBudget::default();
        let raw = format!(
            "Image: s.png (image/png, 1.0 KB)\n\n[image:image/png:{}]",
            "A".repeat(1_000)
        );
        let out = budget.inline_result(&raw, Some(100_000), false, "sess-img-ok", "read_file");
        assert_eq!(out, raw);
    }

    // ---- detect_stream_parse_error ----

    #[test]
    fn detect_stream_parse_error_returns_none_for_normal_args() {
        let args = serde_json::json!({"path": "foo.md", "content": "hi"});
        assert!(super::detect_stream_parse_error(&args).is_none());
    }

    #[test]
    fn detect_stream_parse_error_returns_none_for_empty_object() {
        let args = serde_json::json!({});
        assert!(super::detect_stream_parse_error(&args).is_none());
    }

    #[test]
    fn detect_stream_parse_error_returns_none_for_non_object() {
        let args = serde_json::json!(["array", "not", "object"]);
        assert!(super::detect_stream_parse_error(&args).is_none());
    }

    #[test]
    fn detect_stream_parse_error_recognizes_marker_and_formats_message() {
        let args = serde_json::json!({
            STREAM_PARSE_ERROR_KEY: {
                "cause": "truncated (stream ended before closing braces)",
                "parse_err": "EOF while parsing a value at line 1 column 42",
                "preview": r#"{"path":"foo.md","content":"hello wor"#,
                "total_len": 37_u64,
            }
        });
        let msg = super::detect_stream_parse_error(&args).expect("marker should be detected");
        assert!(
            msg.starts_with("Error: streaming JSON parse failure"),
            "got: {msg}"
        );
        assert!(msg.contains("truncated"));
        assert!(msg.contains("foo.md"));
        assert!(msg.contains("Please retry the tool call"));
    }

    #[test]
    fn detect_stream_parse_error_tolerates_missing_marker_fields() {
        // Defensive: if the inner shape drifts (e.g. future refactor
        // drops `preview`), we still produce a usable message rather
        // than panicking.
        let args = serde_json::json!({
            STREAM_PARSE_ERROR_KEY: {
                "cause": "empty (no arguments deltas received)",
            }
        });
        let msg = super::detect_stream_parse_error(&args).expect("marker should be detected");
        assert!(msg.contains("empty"));
        assert!(msg.contains("Please retry the tool call"));
    }
}

//! Reusable agentic turn processor.
//!
//! Provides a generic LLM loop that any agent type can call with its own
//! event handlers and persistence strategies.

mod backoff;
pub(crate) mod context_accounting;
mod continuation;
mod execute;
pub(crate) mod file_tracker;
pub mod helpers;
mod length_recovery;
#[cfg(debug_assertions)]
pub mod provider_request_capture;
mod screenshot;
pub(crate) use screenshot::resolve_screenshot_markers;
mod stream_error_recovery;
pub(crate) mod stream_normalizer;
pub(crate) mod tool_execution;
mod types;
mod usage_accumulator;
mod usage_telemetry;

// Items kept at the `turn_executor::` surface — checked one by one
// against real call sites. The accessor / structured-key set
// (`msg_content_str`, `msg_tool_calls`, `STRUCTURED_*`,
// `add_tool_result_with_timestamp`, `add_tool_result_rich_with_timestamp`)
// is reached only through the deeper `helpers::` segment, so flattening
// them here would just be dead surface.
pub use execute::execute_turn;
pub use file_tracker::FileTimeTracker;
pub use helpers::{
    add_assistant_message, add_tool_result, last_assistant_text, msg_role, safe_truncate_end,
    truncate_output,
};
pub use types::{
    PermissionProvider, PermissionVerdict, SteeringInjection, SteeringQueue, ToolHookIntervention,
    TurnConfig, TurnEventHandler, TurnIterationHook, TurnResult,
};
pub use usage_telemetry::{AttributionMethod, LlmUsageSpan, ToolUsageAttribution, UsageTelemetry};

// `MAX_TOOL_OUTPUT_CHARS` is consumed by `helpers::*` and a couple of test
// modules via `use crate::core::turn_executor::MAX_TOOL_OUTPUT_CHARS`.
// `set_test_backoff_override_ms` is consumed by the retry-tests module the
// same way. Re-export both so the public surface stays unchanged.
#[cfg(test)]
pub(crate) use backoff::set_test_backoff_override_ms;
pub(crate) use backoff::MAX_TOOL_OUTPUT_CHARS;

// `MAX_CONSECUTIVE_ERRORS` has no direct consumer left in this file (its
// former sole caller, `execute_turn`, now lives in `execute.rs` and imports
// it directly from `backoff`) — it stays as a bare `use` here because
// `tool_execution::{single,parallel}` reach it via
// `super::super::MAX_CONSECUTIVE_ERRORS`, which resolves through this
// module's item table.
use backoff::MAX_CONSECUTIVE_ERRORS;
pub(crate) use context_accounting::ContextUsageSnapshot;

#[cfg(test)]
#[path = "../../tests/processor_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "../../tests/turn_executor_retry_tests.rs"]
mod retry_tests;

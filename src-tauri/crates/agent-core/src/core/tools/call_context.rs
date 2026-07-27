//! Per-call framework metadata threaded explicitly to every `Tool::execute`.
//!
//! `CallContext` replaces the previous mechanism of injecting `__call_id`
//! and `__session_id` into the params `Value` itself
//! (`turn_executor::tool_execution::inject_framework_meta` + boundary
//! stripping in `parse_params` / MCP bridge). That mechanism was a
//! data + metadata polyglot — every new consumer path had to remember to
//! strip the reserved namespace, and we shipped two real bugs after
//! adding `__session_id` (strict agent-org task tools rejecting every
//! call; `__session_id` leaking to external MCP servers).
//!
//! Threading a typed context makes the contract compiler-enforced and
//! gives a single, obvious place to add future framework keys (e.g.,
//! `turn_index`, `parent_call_id`) without touching the params pipeline.
//!
//! ## Semantics
//!
//! - `call_id`: identifies one tool invocation within a turn. Sourced
//!   from `ToolUse.id` (Anthropic) or the synthesized id for OpenAI-
//!   compatible streaming. Used by the MCP bridge to stamp
//!   `agent:mcp_progress` events and by orchestration tools that need
//!   per-call correlation.
//!
//! - `session_id`: the *dispatching* session's id. Per-call attribution
//!   is race-free even when background subagents (which inherit the
//!   parent's `ToolRegistry`) run concurrently — unlike the legacy
//!   `ToolRegistry::set_session_key` shared mutable state that was the
//!   root cause of the `create_plan` subagent-misattribution saga.
//!
//! - `turn_intent_id` and `projected_inbox_ids`: identify the exact durable
//!   turn and Inbox batch whose effects become committed only after this turn
//!   succeeds.  Agent Org finality uses them to build a prospective
//!   completion certificate without guessing or subtracting unrelated work.
//!
//! ## Defaults
//!
//! `CallContext::default()` is a zero-value context (empty strings).
//! Test fixtures and direct in-process callers that don't have a real
//! dispatching session use `&CallContext::default()`; production
//! dispatch always constructs a populated ctx in
//! `turn_executor::tool_execution`.

/// Per-call framework metadata.
///
/// Threaded explicitly by `turn_executor::tool_execution` to every
/// `Tool::execute` / `Tool::execute_text` call. Tools that need
/// framework identity (MCP bridge, create_plan, orchestration tools
/// that correlate with parent state) read it from here; tools that
/// don't need it just bind `_ctx`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CallContext {
    /// Identifier of this individual tool invocation within the turn.
    pub call_id: String,
    /// Identifier of the dispatching session.
    pub session_id: String,
    /// Durable lifecycle identity of the dispatching turn. Empty for
    /// maintenance/direct test calls that do not belong to a real turn.
    pub turn_intent_id: String,
    /// Exact Agent Org Inbox rows held by this turn's deferred drain guard.
    /// These rows are acknowledged only when the turn succeeds.
    pub projected_inbox_ids: Vec<i64>,
}

impl CallContext {
    /// Construct a populated context. Production dispatch sites use this.
    pub fn new(call_id: impl Into<String>, session_id: impl Into<String>) -> Self {
        Self {
            call_id: call_id.into(),
            session_id: session_id.into(),
            turn_intent_id: String::new(),
            projected_inbox_ids: Vec::new(),
        }
    }

    pub fn for_turn(
        call_id: impl Into<String>,
        session_id: impl Into<String>,
        turn_intent_id: impl Into<String>,
        projected_inbox_ids: Vec<i64>,
    ) -> Self {
        Self {
            call_id: call_id.into(),
            session_id: session_id.into(),
            turn_intent_id: turn_intent_id.into(),
            projected_inbox_ids,
        }
    }
}

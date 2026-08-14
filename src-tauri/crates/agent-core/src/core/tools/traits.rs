//! Base trait for agent tools.
//!
//! Tools are capabilities that the agent can use to interact with
//! the environment, such as reading files, executing commands, etc.
//!
//! ## Type-Safe Tool Parameters (Recommended)
//!
//! Use `#[derive(Deserialize, JsonSchema)]` on a params struct to get:
//! - Automatic JSON Schema generation (no hand-written schemas)
//! - Compile-time type checking
//! - Automatic validation on deserialization
//!
//! ```ignore
//! use schemars::JsonSchema;
//! use serde::Deserialize;
//!
//! #[derive(Debug, Deserialize, JsonSchema)]
//! pub struct ReadFileParams {
//!     /// Path to the file to read
//!     pub path: String,
//!     /// Maximum lines to read (optional)
//!     #[serde(default)]
//!     pub max_lines: Option<u32>,
//! }
//!
//! impl Tool for ReadFileTool {
//!     fn parameters(&self) -> Value {
//!         params_schema::<ReadFileParams>()
//!     }
//!
//!     async fn execute(&self, params: Value) -> Result<ToolExecuteResult, ToolError> {
//!         let params: ReadFileParams = parse_params(params)?;
//!         // params.path is now a typed String, params.max_lines is Option<u32>
//!         Ok(ToolExecuteResult::text("contents..."))
//!     }
//! }
//! ```
//!
//! ## Dual-Track Response Pattern (Optional)
//!
//! Tools can optionally provide structured UI metadata separate from the
//! LLM-facing text response. This follows the Onyx pattern of separating
//! `rich_response` (for UI) from `llm_facing_response` (for LLM context).
//!
//! Override `ui_metadata()` to return structured data for frontend rendering:
//!
//! ```ignore
//! impl Tool for SearchTool {
//!     async fn execute(&self, params: Value) -> Result<ToolExecuteResult, ToolError> {
//!         // Returns concise text for LLM context
//!         Ok(ToolExecuteResult::text("Found 5 matches in 3 files..."))
//!     }
//!
//!     fn ui_metadata(&self, params: &Value, result: &str) -> Option<ToolUIMetadata> {
//!         // Returns structured data for rich UI rendering
//!         Some(ToolUIMetadata {
//!             display_type: "search_results".into(),
//!             data: serde_json::json!({
//!                 "matches": [...],
//!                 "total_count": 5,
//!             }),
//!         })
//!     }
//! }
//! ```

use async_trait::async_trait;
use serde_json::Value;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use crate::turn_executor::PermissionProvider;

// Re-export the metadata / result / error / params types from their dedicated
// modules so existing `use crate::core::tools::traits::*` imports
// keep working after the split.
pub use super::call_context::CallContext;
pub use super::error::ToolError;
pub use super::metadata::{ToolAction, ToolPriority, ToolSchemaCacheScope, ToolUIMetadata};
pub use super::params::{
    assert_llm_compatible_schema, optional_bool, optional_int, optional_string, params_schema,
    parse_params, parse_params_described, required_string, sanitize_tool_name,
};
pub use super::result::{McpMeta, ToolContentBlock, ToolExecuteResult};

use super::params::ensure_object_schema;

/// Abstract trait for agent tools.
///
/// Each tool provides a name, description, JSON Schema parameters,
/// and an async execute method. Tools are registered in a [`ToolRegistry`]
/// and invoked by the agent loop when the LLM requests a tool call.
#[async_trait]
pub trait Tool: Send + Sync {
    /// Tool name used in function calls (e.g., "read_file", "exec").
    fn name(&self) -> &str;

    /// Human-readable description of what the tool does.
    fn description(&self) -> &str;

    /// Tool category for grouping in the UI. Use one of the constants from
    /// [`crate::tools::categories`] (e.g. `CODING`, `WEB`,
    /// `DESKTOP`, `DATA`, `AGENT`). Default is `GENERAL` for uncategorized
    /// tools (plugins, ad-hoc tools).
    fn category(&self) -> &str {
        crate::tools::categories::GENERAL
    }

    /// Whether this tool has all required configuration to function.
    ///
    /// Tools that return `false` are excluded from the LLM prompt so the
    /// agent never tries to call them. Override in tools that depend on
    /// external credentials, binaries, or runtime prerequisites.
    fn is_ready(&self) -> bool {
        true
    }

    /// Human-readable reason why the tool is not ready (`None` when ready).
    ///
    /// Surfaced in logs and the frontend "config required" indicator.
    fn not_ready_reason(&self) -> Option<&str> {
        None
    }

    /// Space-separated synonym keywords that improve `tool_search`
    /// discoverability (e.g. `"bash shell terminal grep"` for an exec tool).
    /// Matched with higher weight than the description, lower than the name.
    fn search_hint(&self) -> &str {
        ""
    }

    /// JSON Schema for tool parameters.
    ///
    /// Must be an object-type schema with `properties` and `required` fields.
    /// Example:
    /// ```json
    /// {
    ///   "type": "object",
    ///   "properties": {
    ///     "path": { "type": "string", "description": "File path to read" }
    ///   },
    ///   "required": ["path"]
    /// }
    /// ```
    fn parameters(&self) -> Value;

    /// Execute the tool with given parameters.
    ///
    /// `ctx` carries the per-call framework metadata (`call_id`,
    /// `session_id`) — see [`CallContext`] for the full contract and
    /// why this is a typed parameter rather than `__`-prefixed keys
    /// inside `params`.
    ///
    /// Default implementation delegates to [`Self::execute_text`] and wraps
    /// its `String` result into a plain-text [`ToolExecuteResult`]. Native
    /// tools should override [`Self::execute_text`] only.
    ///
    /// Override **this** method directly when you need to populate
    /// structured fields (`content_blocks`, `mcp_meta`) — currently the MCP
    /// bridge and any future provider that returns non-text
    /// content. In that case, override `execute` and leave `execute_text`
    /// to its default fallback.
    async fn execute(
        &self,
        params: Value,
        ctx: &CallContext,
    ) -> Result<ToolExecuteResult, ToolError> {
        self.execute_text(params, ctx)
            .await
            .map(ToolExecuteResult::text)
    }

    /// Execute the tool and return its LLM-facing text only.
    ///
    /// This is the method the vast majority of tools should implement.
    /// The trait's default `execute` wraps the returned string into a
    /// plain-text [`ToolExecuteResult`]. Tools with structured output
    /// (MCP bridge) should override [`Self::execute`] directly and leave
    /// this method as the default `unimplemented!()`.
    ///
    /// `ctx` carries the per-call framework metadata — see [`CallContext`].
    async fn execute_text(&self, _params: Value, _ctx: &CallContext) -> Result<String, ToolError> {
        Err(ToolError::ExecutionFailed(format!(
            "tool '{}' did not implement execute_text or override execute",
            self.name()
        )))
    }

    /// Set the current channel context for tools that need it (message, spawn, cron).
    /// Default implementation is a no-op.
    async fn set_context(&self, _channel: &str, _chat_id: &str, _sender_id: &str) {}

    /// Set the active IDE repository path for coding tools (exec, git, search).
    /// When set, this overrides the config workspace as the default working directory.
    /// Default implementation is a no-op.
    async fn set_active_repo(&self, _repo_path: &str) {}

    /// Set the agent session key for correlating streaming events (e.g., exec output).
    /// Default implementation is a no-op.
    async fn set_session_key(&self, _session_key: &str) {}

    /// Set the active turn's cancellation signal on tools that can block.
    /// Default implementation is a no-op.
    async fn set_cancel_flag(&self, _cancel_flag: Arc<AtomicBool>) {}

    /// Snapshot the parent's current conversation messages for fork-path subagents.
    /// Called by the processor before each turn. The unified `AgentTool` uses this
    /// to prepend parent context when `fork: true`, enabling prompt cache sharing.
    /// Default implementation is a no-op.
    async fn set_parent_messages(&self, _messages: &[Value]) {}

    /// Loading priority for this tool.
    ///
    /// `Always` (default): schema included in every LLM request.
    /// `OnDemand`: schema omitted from the prompt; the tool is only
    /// discoverable via `tool_search` and loaded when the agent calls it.
    fn priority(&self) -> ToolPriority {
        ToolPriority::Always
    }

    /// Cache-stability segment for this tool's schema.
    ///
    /// Built-in tools default to the stable prefix. Runtime-live tools supplied
    /// by MCP servers or plugins must override this to `LiveSuffix`, so provider
    /// adapters can preserve the stable schema prefix when those external tools
    /// connect, disconnect, or change.
    fn schema_cache_scope(&self) -> ToolSchemaCacheScope {
        ToolSchemaCacheScope::StablePrefix
    }

    /// Whether this tool only reads state without modifying anything.
    ///
    /// Read-only tools can be executed concurrently when the LLM requests
    /// multiple tool calls in a single response. Tools that create, modify,
    /// or delete files/processes/state must return `false` (the default).
    fn is_read_only(&self) -> bool {
        false
    }

    /// Cheap, side-effect-free probe of the external state this call
    /// observes, for the turn executor's repeat guard.
    ///
    /// The repeat guard breaks the turn after `MAX_REPEAT_STREAK` identical
    /// tool calls. That is correct for deterministic tools (same args → same
    /// result → the model is looping), but wrong for observation tools whose
    /// identical re-invocation is the intended protocol while the observed
    /// job advances — `await_output` polling a long build, most notably.
    /// Tools in that category override this to return a fingerprint of the
    /// observed state (job status + a monotonic output cursor): when the
    /// fingerprint changed between two identical calls, the model received
    /// new information and the guard resets its streak; when it is unchanged,
    /// the repeat counts as a genuine no-progress attempt.
    ///
    /// `None` (the default) keeps pure args-identity semantics. Must not
    /// block or mutate anything — the executor calls it before dispatching
    /// the batch.
    fn progress_fingerprint(&self, _params: &Value) -> Option<String> {
        None
    }

    /// Whether this tool can run concurrently with other tool calls in the
    /// same LLM response, even if it mutates state.
    ///
    /// Defaults to `is_read_only()`. Override to `true` for tools that have
    /// side effects but are isolated from each other — e.g. `agent`: each
    /// subagent runs in its own session, so multiple launches in one response
    /// must not serialize behind one another.
    fn is_concurrency_safe(&self) -> bool {
        self.is_read_only()
    }

    /// Ordering weight for this tool's schema in the provider tool list.
    /// Lower sorts earlier; ties keep the registry's deterministic order
    /// (cache segment, then name — stable sort).
    ///
    /// Schema position is an attention signal for the model. The default 0
    /// preserves the existing order for every tool; only tools that should
    /// be surfaced prominently (e.g. `agent` at the top, mirroring Claude
    /// Code's Task-tool-first layout) override this.
    fn schema_priority(&self) -> i8 {
        0
    }

    /// Maximum characters allowed in the tool result before truncation.
    /// Override in tools that need more (file read) or less (grep) output.
    fn output_budget(&self) -> usize {
        50_000
    }

    /// Whether oversized output may be persisted to disk and replaced with a
    /// `<persisted-output>` stub. Default true (shell/search dumps are
    /// retrievable-by-path). Tools whose output is semantically load-bearing
    /// — skill bodies the model must follow, subagent results the frontend
    /// parses into cards, file reads that would be circular to re-read from
    /// disk — MUST return false so oversized output falls back to plain tail
    /// truncation instead of a stub.
    fn allow_persisted_output(&self) -> bool {
        true
    }

    /// Optional dynamic description for the LLM schema.
    ///
    /// When provided, `to_schema()` uses this instead of the static
    /// `description()`. Use for runtime context like the current working
    /// directory, file size limits, or mode-specific hints.
    ///
    /// Called once per `get_definitions()` invocation (effectively once per
    /// turn). Keep the implementation cheap — simple string interpolation.
    fn llm_description(&self) -> Option<String> {
        None
    }

    /// Attach a permission provider for command-level user confirmation.
    /// Used by ExecTool to prompt the user before running commands with
    /// external side effects (git push, gh pr create, npm publish, etc.).
    async fn set_permission_provider(&self, _provider: Arc<dyn PermissionProvider>) {}

    /// Generate structured UI metadata for rich frontend rendering.
    ///
    /// This implements the "dual-track response" pattern: `execute()` returns
    /// a concise text response for LLM context, while `ui_metadata()` provides
    /// structured data for rich UI rendering (tables, diffs, search results, etc.).
    ///
    /// Override this in tools that benefit from structured UI presentation.
    /// The default returns `None`, meaning the raw text result is used as-is.
    ///
    /// # Arguments
    /// * `params` - The parameters passed to execute (for context)
    /// * `result` - The text result from execute (for augmentation)
    ///
    /// # Example
    /// ```ignore
    /// fn ui_metadata(&self, _params: &Value, result: &str) -> Option<ToolUIMetadata> {
    ///     Some(ToolUIMetadata {
    ///         display_type: "code_diff".into(),
    ///         data: serde_json::json!({ "diff": result }),
    ///         summary: Some(format!("Modified {} lines", count_lines(result))),
    ///     })
    /// }
    /// ```
    fn ui_metadata(&self, _params: &Value, _result: &str) -> Option<ToolUIMetadata> {
        None
    }

    /// Structured actions/subcommands this tool supports, for the Integrations UI.
    ///
    /// The default implementation looks up `self.name()` in the single source
    /// of truth [`builtin_tools::BUILTIN_TOOLS`](super::builtin_tools::BUILTIN_TOOLS).
    /// Built-in tools should NOT override this — add the tool's actions to the
    /// `BUILTIN_TOOLS` table in `builtin_tools.rs` instead so that the runtime
    /// registry, `list_all_tools()`, and the Integrations preview panel all
    /// read from the same row. Custom/plugin tools (e.g. MCP) may override this
    /// to supply their own actions dynamically.
    fn actions(&self) -> Vec<ToolAction> {
        super::builtin_tools::builtin_tool_actions(self.name())
    }

    /// Convert to OpenAI function calling schema format.
    ///
    /// Validates that `parameters()` is a proper JSON Schema with
    /// `"type": "object"`. If it is not (e.g. a custom tool using shorthand
    /// format, a buggy MCP server, etc.), this wraps it automatically so
    /// a single malformed tool cannot crash the entire API request.
    fn to_schema(&self) -> Value {
        let params = self.parameters();
        let safe_params = ensure_object_schema(params);
        let desc = self
            .llm_description()
            .unwrap_or_else(|| self.description().to_string());
        let safe_name = sanitize_tool_name(self.name());
        serde_json::json!({
            "type": "function",
            "function": {
                "name": safe_name,
                "description": desc,
                "parameters": safe_params,
            },
            (super::metadata::ORGII_TOOL_SCHEMA_CACHE_SCOPE_KEY): self.schema_cache_scope().as_str(),
        })
    }
}

#[cfg(test)]
#[path = "tests/base_tests.rs"]
mod tests;

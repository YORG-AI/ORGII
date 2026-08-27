//! MCP Bridge Tool — bridges an MCP server tool into the agent's ToolRegistry.
//!
//! One `McpBridgeTool` instance per (server, tool) pair. Implements the
//! `Tool` trait so the LLM can call MCP tools like any built-in tool.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;

use crate::tools::traits::{McpMeta, Tool, ToolError, ToolExecuteResult, ToolSchemaCacheScope};

use super::manager::McpManager;
use super::result::McpCallResult;

/// Project an `McpCallResult` (server-level shape with `text` +
/// `content_blocks` + `_meta` + `structuredContent`) into the
/// `ToolExecuteResult` the agent's tool pipeline consumes.
///
/// Pulled out of `McpBridgeTool::execute` so the mapping is unit-
/// testable without spinning up an rmcp `RunningService`.
///
/// Semantics:
/// - `text` is copied verbatim (it's what OpenAI-compat wire sends).
/// - `content_blocks` moves over verbatim (used by the Anthropic-native
///   wire format to emit typed blocks).
/// - `mcp_meta` is `Some` iff either `_meta` or `structuredContent` was
///   present on the server response; otherwise `None` so the
///   `skip_serializing_if` in `ToolExecuteResult` keeps downstream JSON
///   payloads clean for non-MCP tools that route through the bridge
///   (today: none).
pub(crate) fn call_result_to_execute_result(result: McpCallResult) -> ToolExecuteResult {
    let mcp_meta = if result.meta.is_some() || result.structured_content.is_some() {
        Some(McpMeta {
            meta: result.meta,
            structured_content: result.structured_content,
        })
    } else {
        None
    };
    ToolExecuteResult {
        text: result.text,
        content_blocks: result.content_blocks,
        mcp_meta,
        turn_directive: None,
    }
}

/// A tool that bridges a single MCP server tool into the agent's ToolRegistry.
pub struct McpBridgeTool {
    /// Fully qualified name: `mcp_{server}_{tool}`.
    full_name: String,
    /// Original tool name on the MCP server.
    tool_name: String,
    /// MCP server name.
    server_name: String,
    /// Tool description from the MCP server.
    tool_description: String,
    /// JSON Schema for the tool's input (from `tools/list`).
    tool_schema: Value,
    /// Shared MCP manager for dispatching calls.
    manager: Arc<McpManager>,
}

/// Max characters we ever advertise to the LLM in an MCP tool description.
///
/// OpenAPI-generated MCP servers have been observed dumping 15–60 KB of
/// endpoint docs into `tool.description`; this cap keeps the system
/// prompt from blowing up at the p95 tail.
pub const MAX_MCP_DESCRIPTION_LENGTH: usize = 2048;

/// Truncation marker appended when a description exceeds
/// [`MAX_MCP_DESCRIPTION_LENGTH`]. The leading character is U+2026
/// (`HORIZONTAL ELLIPSIS`).
pub const TRUNCATION_MARKER: &str = "… [truncated]";

/// Truncate `text` so its character count is at most `max_chars`, appending
/// [`TRUNCATION_MARKER`]. Returns `text` unchanged if it's already short enough.
///
/// Uses `char_indices()` to find the last safe UTF-8 boundary — never
/// panics on multi-byte sequences.
pub fn truncate_description(text: &str, max_chars: usize) -> String {
    let head = crate::utils::safe_truncate_chars(text, max_chars);
    if head.len() == text.len() {
        return text.to_string();
    }
    let mut out = String::with_capacity(head.len() + TRUNCATION_MARKER.len());
    out.push_str(head);
    out.push_str(TRUNCATION_MARKER);
    out
}

/// Normalize a server or tool segment so it's safe to embed in an MCP tool
/// name (`mcp__<server>__<tool>`) and acceptable to Anthropic's tool-name
/// validator (`^[a-zA-Z0-9_-]{1,64}$`).
///
/// Any character outside `[A-Za-z0-9_-]` is replaced with `_`.
pub fn normalize_name_for_mcp(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    out
}

/// Build the fully-qualified tool name used internally for an MCP tool.
///
/// Format: `mcp__{server}__{tool}` (**double** underscore separator).
/// Both segments are run through `normalize_name_for_mcp` so unusual
/// characters (spaces, dots, `@`, `/` …) don't leak into the wire name —
/// which is also how the inverse parser `mcpInfoFromString` recovers
/// them.
///
/// `mcpInfoFromString` splits on `__`, so any server or tool name
/// containing an underscore would be mis-parsed if the separator were
/// a single underscore.
pub fn build_mcp_tool_name(server_name: &str, tool_name: &str) -> String {
    format!(
        "mcp__{}__{}",
        normalize_name_for_mcp(server_name),
        normalize_name_for_mcp(tool_name)
    )
}

/// Decide whether a single MCP tool should be skipped during registration,
/// given the user-configured disabled-server / disabled-tool sets.
///
/// Pure helper extracted from [`register_mcp_tools`] so the namespace
/// contract (`disabled_tools` matches the `mcp__<server>__<tool>`
/// full name, NOT a builtin name) is unit-testable without spinning up
/// an `McpManager`. Callers must pass the MCP-namespaced disabled set
/// (e.g. `AgentToolSelection.disabled_mcp_tools`); a builtin-tool
/// blocklist would silently match nothing.
pub fn should_skip_mcp_tool(
    server_name: &str,
    tool_full_name: &str,
    disabled_tools: Option<&std::collections::HashSet<String>>,
    disabled_servers: Option<&std::collections::HashSet<String>>,
) -> bool {
    if let Some(svrs) = disabled_servers {
        if svrs.contains(server_name) {
            return true;
        }
    }
    if let Some(tools) = disabled_tools {
        if tools.contains(tool_full_name) {
            return true;
        }
    }
    false
}

impl McpBridgeTool {
    /// Create a new bridge tool.
    ///
    /// Full name is `mcp__{server}__{tool}` (double underscores as
    /// namespace separators).
    pub fn new(
        server_name: String,
        tool_name: String,
        tool_description: String,
        tool_schema: Value,
        manager: Arc<McpManager>,
    ) -> Self {
        let full_name = build_mcp_tool_name(&server_name, &tool_name);
        let tool_description = truncate_description(&tool_description, MAX_MCP_DESCRIPTION_LENGTH);
        Self {
            full_name,
            tool_name,
            server_name,
            tool_description,
            tool_schema,
            manager,
        }
    }
}

#[async_trait]
impl Tool for McpBridgeTool {
    fn name(&self) -> &str {
        &self.full_name
    }

    fn description(&self) -> &str {
        &self.tool_description
    }

    fn category(&self) -> &str {
        "mcp"
    }

    fn parameters(&self) -> Value {
        self.tool_schema.clone()
    }

    fn schema_cache_scope(&self) -> ToolSchemaCacheScope {
        ToolSchemaCacheScope::LiveSuffix
    }

    /// Override the default `execute` (which would delegate to
    /// `execute_text` and drop structured payload) so that the bridge
    /// preserves `content_blocks`, `_meta`, and `structuredContent` all
    /// the way through to `ToolExecuteResult`.
    ///
    /// This is the only spot in the codebase that populates
    /// `ToolExecuteResult::content_blocks` / `mcp_meta` today. Wire-layer
    /// consumers that flatten to a single string (OpenAI-compat
    /// providers via `turn_executor::helpers::add_tool_result`) keep
    /// working because they only read `.text`; Anthropic-native providers
    /// read `.content_blocks` directly.
    ///
    /// Progress forwarding: calls `manager.call_tool_with_progress` so
    /// any `notifications/progress` the server emits for this tool
    /// becomes an `agent:mcp_progress` Tauri/WS event. The progress
    /// callback runs synchronously inside the SDK's `ProgressDispatcher`
    /// (see `McpClient::call_tool_typed_with_progress`). Per-call context
    /// (`call_id`, `session_id`) comes from the typed `CallContext`
    /// threaded by `turn_executor::tool_execution` — no `__`-prefixed
    /// key reading or `set_session_key` Mutex.
    async fn execute(
        &self,
        params: Value,
        ctx: &crate::tools::traits::CallContext,
    ) -> Result<ToolExecuteResult, ToolError> {
        ctx.require_tool_authority(self.name())?;
        if ctx.call_id.is_empty() {
            tracing::warn!(
                tool = %self.full_name,
                "mcp::bridge::execute: ctx.call_id empty (direct caller path); progress events will have empty toolCallId"
            );
        }
        if ctx.session_id.is_empty() {
            tracing::warn!(
                tool = %self.full_name,
                "mcp::bridge::execute: ctx.session_id empty (direct caller path); progress events will have empty sessionId"
            );
        }
        let call_id = ctx.call_id.clone();
        let session_key = ctx.session_id.clone();
        let tool_name_full = self.full_name.clone();

        let result = self
            .manager
            .call_tool_with_progress(
                &self.server_name,
                &self.tool_name,
                params,
                None,
                move |tick| {
                    // `progress` / `total` / `message` mirror MCP spec
                    // `ProgressNotificationParam`. (don't drop outgoing data): preserve
                    // explicit `null` vs missing for `total`/`message`
                    // so the UI can distinguish "unbounded" progress
                    // (spinner) from "42 / 100" (bar).
                    let total = tick
                        .total
                        .map(serde_json::Value::from)
                        .unwrap_or(serde_json::Value::Null);
                    let message = tick
                        .message
                        .clone()
                        .map(serde_json::Value::from)
                        .unwrap_or(serde_json::Value::Null);
                    crate::bus::broadcast_event(
                        "agent:mcp_progress",
                        serde_json::json!({
                            "sessionId": session_key,
                            "toolCallId": call_id,
                            "toolName": tool_name_full,
                            "progress": tick.progress,
                            "total": total,
                            "message": message,
                        }),
                    );
                },
            )
            .await
            .map_err(|err| ToolError::ExecutionFailed(err.to_string()))?;
        Ok(call_result_to_execute_result(result))
    }
}

/// Register all tools from an McpManager into a ToolRegistry.
///
/// Creates one `McpBridgeTool` per (server, tool) pair and registers it.
/// Skips tools whose full name is in `disabled_tools` and skips entire
/// servers whose name is in `disabled_servers`.
///
/// `workspace_path` is used to load the merged (global + workspace) config so that
/// `auto_approve` entries in workspace-level `.orgii/mcp-servers.json` are
/// respected, not just the global config.
///
/// Returns the set of fully-qualified tool names (`mcp__server__tool`)
/// that are auto-approved (from the server's `auto_approve` config).
pub async fn register_mcp_tools(
    registry: &mut crate::tools::registry::ToolRegistry,
    manager: &Arc<McpManager>,
    disabled_tools: Option<&std::collections::HashSet<String>>,
    disabled_servers: Option<&std::collections::HashSet<String>>,
    workspace_path: Option<&std::path::Path>,
    load_workspace_resources: bool,
) -> Result<Vec<String>, String> {
    // Load merged config first so a session that opts out of workspace settings
    // does not inherit tools from workspace servers connected by another session.
    let config = crate::mcp::config::McpConfigFile::load_merged_with_workspace_scope(
        workspace_path,
        load_workspace_resources,
    )?;
    let visible_server_names: std::collections::HashSet<String> = config
        .mcp_servers
        .iter()
        .filter(|(name, server_config)| {
            !server_config.disabled
                && disabled_servers
                    .map(|set| !set.contains(*name))
                    .unwrap_or(true)
        })
        .map(|(name, _server_config)| name.clone())
        .collect();

    // `needs-auth` servers get a single `mcp__<server>__authenticate`
    // pseudo-tool instead of their advertised tools — the LLM calls
    // it to kick off the OAuth flow, and on success the bridge
    // re-registers the real tools on the next call.
    let needs_auth_servers = manager.needs_auth_servers().await;
    let needs_auth_names: std::collections::HashSet<String> = needs_auth_servers
        .iter()
        .map(|(name, _)| name.clone())
        .collect();
    for (server_name, auth_config) in &needs_auth_servers {
        if !visible_server_names.contains(server_name) {
            continue;
        }
        let full_name = build_mcp_tool_name(server_name, "authenticate");
        if should_skip_mcp_tool(server_name, &full_name, disabled_tools, disabled_servers) {
            continue;
        }
        registry.register(Box::new(super::auth_tool::McpAuthTool::new(
            server_name.clone(),
            auth_config.clone(),
            Arc::clone(manager),
        )));
    }

    let all_tools = manager.all_tools().await;
    let mut auto_approved = Vec::new();

    for (server_name, tool_def) in all_tools {
        if !visible_server_names.contains(&server_name) {
            continue;
        }
        // Skip servers whose real tools are currently shadowed by the
        // OAuth pseudo-tool — in the normal path they won't have
        // published `all_tools()` entries anyway (they aren't in
        // `clients`), but this keeps us correct if a race leaves a
        // stale entry behind.
        if needs_auth_names.contains(&server_name) {
            continue;
        }

        let full_name = build_mcp_tool_name(&server_name, &tool_def.name);

        if should_skip_mcp_tool(&server_name, &full_name, disabled_tools, disabled_servers) {
            continue;
        }

        // Check if this tool is auto-approved
        if let Some(server_config) = config.mcp_servers.get(&server_name) {
            if let Some(ref approve_list) = server_config.auto_approve {
                if approve_list.contains(&tool_def.name) || approve_list.iter().any(|p| p == "*") {
                    auto_approved.push(full_name.clone());
                }
            }
        }

        let bridge = McpBridgeTool::new(
            server_name,
            tool_def.name,
            tool_def.description,
            tool_def.input_schema,
            Arc::clone(manager),
        );

        registry.register(Box::new(bridge));
    }

    // Register the two global resource tools (`ListMcpResources` +
    // `ReadMcpResource`) exactly once iff at least one connected,
    // non-disabled server actually exposes a resource.
    //
    // Per-server `mcp__<server>__read_resource` pseudo-tools no longer
    // exist — the LLM passes the `server` parameter to the global tools
    // instead. This keeps the `tools` array stable as servers come and
    // go.
    let any_resource_visible = manager
        .all_resources()
        .await
        .iter()
        .any(|(server_name, _)| {
            visible_server_names.contains(server_name)
                && disabled_servers
                    .map(|set| !set.contains(server_name))
                    .unwrap_or(true)
        });
    if any_resource_visible {
        let list_name = super::resource_tools::LIST_MCP_RESOURCES_TOOL_NAME.to_string();
        let read_name = super::resource_tools::READ_MCP_RESOURCE_TOOL_NAME.to_string();
        let list_disabled = disabled_tools
            .map(|set| set.contains(&list_name))
            .unwrap_or(false);
        let read_disabled = disabled_tools
            .map(|set| set.contains(&read_name))
            .unwrap_or(false);
        if !list_disabled {
            registry.register(Box::new(super::resource_tools::McpListResourcesTool::new(
                Arc::clone(manager),
                visible_server_names.clone(),
            )));
        }
        if !read_disabled {
            registry.register(Box::new(super::resource_tools::McpReadResourceTool::new(
                Arc::clone(manager),
                visible_server_names.clone(),
            )));
        }
    }

    Ok(auto_approved)
}

#[cfg(test)]
mod call_result_mapping_tests {
    //! Safety net for the bridge mapping: the projection from
    //! `McpCallResult` to `ToolExecuteResult` must keep the structured
    //! payload (content_blocks, _meta, structuredContent) alongside the
    //! flattened `text`.
    //!
    //! Wire-layer flattening for OpenAI-compat providers happens in
    //! `turn_executor::helpers::add_tool_result` and reads only
    //! `ToolExecuteResult.text`. These tests document that the bridge
    //! does NOT do that flattening itself — structured data survives
    //! until the wire layer chooses to drop it.
    use super::call_result_to_execute_result;
    use super::McpCallResult;
    use crate::tools::traits::ToolContentBlock;
    use serde_json::json;

    #[test]
    fn plain_text_result_has_no_mcp_meta() {
        let result = call_result_to_execute_result(McpCallResult {
            text: "hello".into(),
            content_blocks: vec![ToolContentBlock::Text {
                text: "hello".into(),
            }],
            meta: None,
            structured_content: None,
        });
        assert_eq!(result.text, "hello");
        assert_eq!(result.content_blocks.len(), 1);
        assert!(result.mcp_meta.is_none(), "no _meta, no structuredContent");
    }

    #[test]
    fn meta_alone_populates_mcp_meta() {
        let result = call_result_to_execute_result(McpCallResult {
            text: String::new(),
            content_blocks: Vec::new(),
            meta: Some(json!({"progressToken": "abc"})),
            structured_content: None,
        });
        let meta = result.mcp_meta.expect("mcp_meta should be populated");
        assert!(meta.meta.is_some());
        assert!(meta.structured_content.is_none());
    }

    #[test]
    fn structured_content_alone_populates_mcp_meta() {
        let result = call_result_to_execute_result(McpCallResult {
            text: "summary".into(),
            content_blocks: Vec::new(),
            meta: None,
            structured_content: Some(json!({"rows": 3})),
        });
        let meta = result.mcp_meta.expect("mcp_meta should be populated");
        assert!(meta.meta.is_none());
        assert_eq!(meta.structured_content.as_ref().unwrap()["rows"], 3);
    }

    #[test]
    fn both_meta_and_structured_content_survive() {
        let result = call_result_to_execute_result(McpCallResult {
            text: "flattened text for LLM".into(),
            content_blocks: vec![
                ToolContentBlock::Text {
                    text: "flattened text for LLM".into(),
                },
                ToolContentBlock::Image {
                    mime_type: "image/png".into(),
                    data: "ZmFrZQ==".into(),
                },
            ],
            meta: Some(json!({"orgii/toolUseId": "call-42"})),
            structured_content: Some(json!({"status": "ok"})),
        });

        assert_eq!(result.text, "flattened text for LLM");
        assert_eq!(result.content_blocks.len(), 2);
        // Snapshot before consuming `mcp_meta` below — the
        // Anthropic-native wire branches on this flag, so we assert it
        // in the same test that verifies the underlying fields.
        assert!(result.has_structured_payload());

        let meta = result
            .mcp_meta
            .as_ref()
            .expect("both _meta and structuredContent populated");
        assert_eq!(meta.meta.as_ref().unwrap()["orgii/toolUseId"], "call-42");
        assert_eq!(meta.structured_content.as_ref().unwrap()["status"], "ok");
    }

    #[test]
    fn has_structured_payload_false_for_text_only() {
        // Text-only block should not count as "structured" — that flag
        // is reserved for non-text payload that Anthropic-native wire
        // would want to pass through verbatim.
        let result = call_result_to_execute_result(McpCallResult {
            text: "hi".into(),
            content_blocks: Vec::new(),
            meta: None,
            structured_content: None,
        });
        // Text-only, no content_blocks, no mcp_meta → not structured.
        assert!(!result.has_structured_payload());
    }
}

#[cfg(test)]
mod skip_decision_tests {
    //! Pin the namespace contract for `register_mcp_tools` filtering:
    //! matching is by the `mcp__<server>__<tool>` full name, never by
    //! a builtin tool name. These tests guard against regressions that
    //! would let a disjoint blocklist silently no-op the filter.
    use super::should_skip_mcp_tool;
    use std::collections::HashSet;

    #[test]
    fn no_disabled_sets_means_no_skip() {
        assert!(!should_skip_mcp_tool(
            "github",
            "mcp__github__create_issue",
            None,
            None,
        ));
    }

    #[test]
    fn disabled_server_skips_every_tool_under_it() {
        let servers: HashSet<String> = ["github".into()].into_iter().collect();
        assert!(should_skip_mcp_tool(
            "github",
            "mcp__github__create_issue",
            None,
            Some(&servers),
        ));
        assert!(should_skip_mcp_tool(
            "github",
            "mcp__github__list_repos",
            None,
            Some(&servers),
        ));
    }

    #[test]
    fn disabled_tool_skips_only_the_namespaced_full_name() {
        let tools: HashSet<String> = ["mcp__github__create_issue".into()].into_iter().collect();
        assert!(should_skip_mcp_tool(
            "github",
            "mcp__github__create_issue",
            Some(&tools),
            None,
        ));
        // Sibling tool on the same server must NOT be skipped.
        assert!(!should_skip_mcp_tool(
            "github",
            "mcp__github__list_repos",
            Some(&tools),
            None,
        ));
    }

    #[test]
    fn builtin_tool_name_in_disabled_tools_does_not_skip_mcp_tool() {
        // This is the exact bug PR 6 fixes: passing builtin names like
        // `read_file` or `bash` into `disabled_tools` must NOT skip MCP
        // tools, because MCP tool full names are `mcp__<server>__<tool>`.
        let builtin_disabled: HashSet<String> =
            ["read_file".into(), "bash".into()].into_iter().collect();
        assert!(!should_skip_mcp_tool(
            "github",
            "mcp__github__create_issue",
            Some(&builtin_disabled),
            None,
        ));
    }

    #[test]
    fn disabled_server_takes_precedence_over_unrelated_tool_set() {
        let servers: HashSet<String> = ["github".into()].into_iter().collect();
        let tools: HashSet<String> = ["mcp__other__do_thing".into()].into_iter().collect();
        assert!(should_skip_mcp_tool(
            "github",
            "mcp__github__create_issue",
            Some(&tools),
            Some(&servers),
        ));
    }
}

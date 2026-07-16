//! Tool registry for dynamic tool management.
//!
//! Allows dynamic registration and execution of tools by the agent loop.
//! Supports policy-based filtering and execution gating.

#[cfg(test)]
#[path = "tests/registry_tests.rs"]
mod tests;

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use serde_json::Value;

use super::policy::ResolvedToolPolicy;
use super::traits::{sanitize_tool_name, Tool, ToolAction, ToolExecuteResult, ToolPriority};

/// Registry for agent tools.
///
/// Stores tools by name and provides lookup, execution, and schema generation.
/// Supports an optional fallback registry for overlay patterns (delegate lookup
/// to an inner registry for tools not registered locally).
pub struct ToolRegistry {
    tools: HashMap<String, Box<dyn Tool>>,
    fallback: Option<Arc<ToolRegistry>>,
}

impl ToolRegistry {
    /// Create an empty registry.
    pub fn new() -> Self {
        Self {
            tools: HashMap::new(),
            fallback: None,
        }
    }

    /// Create a registry that delegates to `inner` for tools not found locally.
    pub fn with_fallback(inner: Arc<ToolRegistry>) -> Self {
        Self {
            tools: HashMap::new(),
            fallback: Some(inner),
        }
    }

    /// Register a tool. Replaces any existing tool with the same name.
    pub fn register(&mut self, tool: Box<dyn Tool>) {
        self.tools.insert(tool.name().to_string(), tool);
    }

    /// Get a reference to a tool by name. Checks local tools first, then fallback.
    ///
    /// If exact match fails, tries short alias resolution, then reverse-lookup
    /// by sanitized name so that LLM-returned names like `Disk_Usage_Checker`
    /// match the original `Disk Usage Checker` registration.
    pub fn get(&self, name: &str) -> Option<&dyn Tool> {
        let canonical = resolve_tool_alias(name);
        self.tools
            .get(canonical)
            .map(|boxed| boxed.as_ref())
            .or_else(|| {
                self.tools
                    .values()
                    .find(|tool| sanitize_tool_name(tool.name()) == canonical)
                    .map(|boxed| boxed.as_ref())
            })
            .or_else(|| self.fallback.as_ref().and_then(|fb| fb.get(canonical)))
    }

    /// Check if a tool is registered (locally or in fallback).
    pub fn has(&self, name: &str) -> bool {
        self.get(name).is_some()
    }

    pub fn ready_tool_names(&self) -> Vec<String> {
        let mut names: Vec<String> = Vec::new();
        let mut seen = std::collections::HashSet::new();
        self.collect_tool_names(&mut names, &mut seen, true);
        names.sort();
        names
    }

    fn collect_tool_names(
        &self,
        names: &mut Vec<String>,
        seen: &mut std::collections::HashSet<String>,
        ready_only: bool,
    ) {
        let mut local: Vec<&dyn Tool> = self.tools.values().map(|tool| tool.as_ref()).collect();
        local.sort_by(|tool_a, tool_b| tool_a.name().cmp(tool_b.name()));
        for tool in local {
            let name = tool.name().to_string();
            if seen.insert(name.clone()) && (!ready_only || tool.is_ready()) {
                names.push(name);
            }
        }
        if let Some(ref fb) = self.fallback {
            fb.collect_tool_names(names, seen, ready_only);
        }
    }

    /// Get all tool definitions in OpenAI function calling format.
    ///
    /// Returns a `Vec` of tool schemas suitable for passing to the LLM.
    /// Recursively walks the entire fallback chain (local tools shadow
    /// deeper fallbacks by name). Tools where `is_ready()` returns false
    /// are excluded from the output.
    pub fn get_definitions(&self) -> Vec<Value> {
        let mut defs: Vec<Value> = Vec::new();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        self.collect_definitions(&mut defs, &mut seen, None);
        defs
    }

    /// Walk fallback chain. `priority_filter = Some(ToolPriority::Always)`
    /// excludes `OnDemand` tools (used by `get_definitions_budgeted`);
    /// `None` includes every tool regardless of priority.
    ///
    /// **Cache stability:** tools are emitted by schema cache segment first
    /// (`StablePrefix` before `LiveSuffix`) and then lexicographically by name,
    /// not `HashMap` iteration order. This gives every provider a stable built-in
    /// schema prefix while keeping runtime-live MCP/plugin schemas at the end.
    /// Providers that support explicit prompt caching can mark the stable-prefix
    /// boundary; providers that do not still benefit from deterministic wire bytes.
    fn collect_definitions(
        &self,
        defs: &mut Vec<Value>,
        seen: &mut std::collections::HashSet<String>,
        priority_filter: Option<ToolPriority>,
    ) {
        let mut local: Vec<&dyn Tool> = self.tools.values().map(|tool| tool.as_ref()).collect();
        local.sort_by(|tool_a, tool_b| {
            tool_a
                .schema_cache_scope()
                .cmp(&tool_b.schema_cache_scope())
                .then_with(|| tool_a.name().cmp(tool_b.name()))
        });
        for tool in local {
            let name = tool.name().to_string();
            if !seen.insert(name.clone()) {
                continue;
            }
            if let Some(required) = priority_filter {
                if tool.priority() != required {
                    continue;
                }
            }
            tracing::debug!("[tools] Checking prompt visibility for '{}'", name);
            if tool.is_ready() {
                tracing::debug!("[tools] Building prompt schema for '{}'", name);
                defs.push(tool.to_schema());
                tracing::debug!("[tools] Built prompt schema for '{}'", name);
            } else if let Some(reason) = tool.not_ready_reason() {
                tracing::debug!("[tools] Hiding '{}' from prompt: {}", name, reason);
            } else {
                tracing::debug!("[tools] Hiding '{}' from prompt: not ready", name);
            }
        }
        if let Some(ref fb) = self.fallback {
            fb.collect_definitions(defs, seen, priority_filter);
        }
    }

    /// Get tool definitions with priority-based deferred loading.
    ///
    /// Only `Always`-priority tools are included. `OnDemand` tools are
    /// excluded from the prompt (discoverable via `tool_search`).
    /// Recursively walks the entire fallback chain (local tools shadow
    /// deeper fallbacks by name). The result is then filtered through
    /// the tool policy.
    pub fn get_definitions_budgeted(&self, policy: &ResolvedToolPolicy) -> Vec<Value> {
        let mut defs: Vec<Value> = Vec::new();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        self.collect_definitions(&mut defs, &mut seen, Some(ToolPriority::Always));
        let mut defs = policy.filter_definitions(defs);
        // Stable sort by each tool's declared schema_priority (default 0),
        // so tools like `agent` can surface at the top of the provider list
        // while everything else keeps its registration order.
        defs.sort_by_key(|def| {
            tool_schema_name(def)
                .and_then(|name| self.get(&name))
                .map(|tool| tool.schema_priority())
                .unwrap_or(0)
        });
        defs
    }

    /// Names from the exact policy-filtered Always-priority schemas sent to the provider.
    pub fn prompt_tool_names(&self, policy: &ResolvedToolPolicy) -> Vec<String> {
        let mut names: Vec<String> = self
            .get_definitions_budgeted(policy)
            .iter()
            .filter_map(tool_schema_name)
            .collect();
        names.sort();
        names
    }

    /// Name + description summaries from the exact policy-filtered provider schemas.
    pub fn prompt_tool_summaries(&self, policy: &ResolvedToolPolicy) -> Vec<(String, String)> {
        self.get_definitions_budgeted(policy)
            .iter()
            .filter_map(tool_schema_summary)
            .collect()
    }

    /// Search a query against all ready tools (local + fallback chain).
    ///
    /// Tokenized scoring, not whole-phrase substring: the query is split
    /// on whitespace and lowercased; each token scores 3 for a name hit,
    /// 2 for a `search_hint()` hit, 1 for a description hit. Any token
    /// hit makes the tool a candidate; results are sorted by total score
    /// (descending), then name, and capped at `limit`.
    ///
    /// Returns `(name, description, deferred)` tuples — `deferred == false`
    /// means the tool is already in the prompt (`Always` priority); `true`
    /// means it loads on first call. Searching ALL tools (not just the
    /// OnDemand pool) lets the caller tell the model "already loaded"
    /// instead of returning a false negative.
    pub fn search_tools(&self, query: &str, limit: usize) -> Vec<(String, String, bool)> {
        let tokens: Vec<String> = query
            .split_whitespace()
            .map(|t| t.to_lowercase())
            .filter(|t| !t.is_empty())
            .collect();
        if tokens.is_empty() {
            return Vec::new();
        }

        let mut scored: Vec<(u32, String, String, bool)> = Vec::new();
        let mut seen = std::collections::HashSet::new();

        let mut score_tool = |tool: &dyn Tool| {
            if !tool.is_ready() {
                return;
            }
            let name = tool.name().to_string();
            if !seen.insert(name.clone()) {
                return;
            }
            let name_lower = name.to_lowercase();
            let hint_lower = tool.search_hint().to_lowercase();
            let desc_lower = tool.description().to_lowercase();
            let mut score = 0u32;
            for token in &tokens {
                if name_lower.contains(token.as_str()) {
                    score += 3;
                } else if hint_lower.contains(token.as_str()) {
                    score += 2;
                } else if desc_lower.contains(token.as_str()) {
                    score += 1;
                }
            }
            if score > 0 {
                scored.push((
                    score,
                    name,
                    tool.description().to_string(),
                    tool.priority() == ToolPriority::OnDemand,
                ));
            }
        };

        for tool in self.tools.values() {
            score_tool(tool.as_ref());
        }
        let mut fb_chain = self.fallback.as_deref();
        while let Some(fb) = fb_chain {
            for tool in fb.tools.values() {
                score_tool(tool.as_ref());
            }
            fb_chain = fb.fallback.as_deref();
        }

        scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
        scored
            .into_iter()
            .take(limit)
            .map(|(_, name, desc, deferred)| (name, desc, deferred))
            .collect()
    }

    /// List all deferred (`OnDemand`) tool names.
    pub fn deferred_tool_names(&self) -> Vec<String> {
        let mut names: Vec<String> = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for tool in self.tools.values() {
            if tool.priority() == ToolPriority::OnDemand
                && tool.is_ready()
                && seen.insert(tool.name().to_string())
            {
                names.push(tool.name().to_string());
            }
        }
        if let Some(ref fb) = self.fallback {
            for tool in fb.tools.values() {
                if tool.priority() == ToolPriority::OnDemand
                    && tool.is_ready()
                    && seen.insert(tool.name().to_string())
                {
                    names.push(tool.name().to_string());
                }
            }
        }
        names.sort();
        names
    }

    /// Execute a tool by name. Returns the full [`ToolExecuteResult`]
    /// (text + structured content blocks + MCP metadata) so wire-format
    /// callers (Anthropic native, MCP bridge) can keep structured payloads.
    ///
    /// The error path returns a pre-formatted `"Error: ..."` string so
    /// callers can persist it verbatim into the LLM tool_result message.
    ///
    /// `ctx` carries the per-call framework metadata — see
    /// [`crate::tools::call_context::CallContext`].
    pub async fn execute(
        &self,
        name: &str,
        params: Value,
        ctx: &crate::tools::call_context::CallContext,
    ) -> Result<ToolExecuteResult, String> {
        let Some(tool) = self.get(name) else {
            return Err(format!("Error: Tool '{}' not found", name));
        };

        match tool.execute(params, ctx).await {
            Ok(result) => Ok(result),
            Err(err) => Err(format!("Error executing {}: {}", name, err)),
        }
    }

    /// Execute a tool with policy check.
    pub async fn execute_with_policy(
        &self,
        name: &str,
        params: Value,
        policy: &ResolvedToolPolicy,
        ctx: &crate::tools::call_context::CallContext,
    ) -> Result<ToolExecuteResult, String> {
        let canonical = resolve_tool_alias(name);
        if !policy.is_allowed(canonical) {
            return Err(format!(
                "Error: Tool '{}' is not allowed by the current tool policy",
                canonical
            ));
        }
        self.execute(canonical, params, ctx).await
    }

    /// Get list of registered tool names (including fallback).
    pub fn tool_names(&self) -> Vec<String> {
        let mut names: Vec<String> = Vec::new();
        let mut seen = std::collections::HashSet::new();
        self.collect_tool_names(&mut names, &mut seen, false);
        names.sort();
        names
    }

    /// Get tool info (name, description, category) for prompt-visible tools.
    ///
    /// Mirrors [`Self::get_definitions`]: registered tools whose runtime
    /// prerequisites are not available (`is_ready() == false`) are hidden from
    /// the prompt-side "Available Tools" summary so the text list cannot drift
    /// from the schemas actually sent to the provider.
    pub fn tool_info(&self) -> Vec<(String, String, String)> {
        let mut seen = std::collections::HashSet::new();
        let mut info: Vec<(String, String, String)> = Vec::new();
        for tool in self.tools.values() {
            if !tool.is_ready() {
                continue;
            }
            seen.insert(tool.name().to_string());
            info.push((
                tool.name().to_string(),
                tool.description().to_string(),
                tool.category().to_string(),
            ));
        }
        if let Some(ref fb) = self.fallback {
            for tool in fb.tools.values() {
                if !tool.is_ready() {
                    continue;
                }
                if seen.insert(tool.name().to_string()) {
                    info.push((
                        tool.name().to_string(),
                        tool.description().to_string(),
                        tool.category().to_string(),
                    ));
                }
            }
        }
        info.sort_by(|entry_a, entry_b| entry_a.0.cmp(&entry_b.0));
        info
    }

    /// Get the structured actions for a tool by name.
    pub fn tool_actions(&self, name: &str) -> Vec<ToolAction> {
        if let Some(tool) = self.tools.get(name) {
            return tool.actions();
        }
        if let Some(ref fb) = self.fallback {
            if let Some(tool) = fb.tools.get(name) {
                return tool.actions();
            }
        }
        vec![]
    }

    /// Number of registered tools (including fallback).
    pub fn len(&self) -> usize {
        let local = self.tools.len();
        match self.fallback {
            Some(ref fb) => {
                let overlap = fb
                    .tools
                    .keys()
                    .filter(|k| self.tools.contains_key(*k))
                    .count();
                local + fb.tools.len() - overlap
            }
            None => local,
        }
    }

    /// Whether the registry is empty (including fallback).
    pub fn is_empty(&self) -> bool {
        self.tools.is_empty() && self.fallback.as_ref().is_none_or(|fb| fb.is_empty())
    }

    /// Iterate all tools (local + fallback, no duplicates).
    fn all_tools(&self) -> Vec<&dyn Tool> {
        let mut result: Vec<&dyn Tool> = self.tools.values().map(|b| b.as_ref()).collect();
        if let Some(ref fb) = self.fallback {
            for (name, tool) in &fb.tools {
                if !self.tools.contains_key(name) {
                    result.push(tool.as_ref());
                }
            }
        }
        result
    }

    /// Set context on all tools that support it (message, spawn, cron).
    pub async fn set_all_contexts(&self, channel: &str, chat_id: &str, sender_id: &str) {
        for tool in self.all_tools() {
            tool.set_context(channel, chat_id, sender_id).await;
        }
    }

    /// Set the active IDE repository on all coding tools (exec, git, search).
    /// This overrides the config workspace as the default working directory.
    pub async fn set_active_repo(&self, repo_path: &str) {
        for tool in self.all_tools() {
            tool.set_active_repo(repo_path).await;
        }
    }

    /// Set the agent session key on all tools that support it (e.g., exec).
    /// Used to correlate streaming events (agent:exec_output) with the session.
    pub async fn set_session_key(&self, session_key: &str) {
        for tool in self.all_tools() {
            tool.set_session_key(session_key).await;
        }
    }

    /// Set the active turn cancellation signal on all tools that can block.
    pub async fn set_cancel_flag(&self, cancel_flag: Arc<AtomicBool>) {
        for tool in self.all_tools() {
            tool.set_cancel_flag(Arc::clone(&cancel_flag)).await;
        }
    }

    /// Snapshot parent conversation messages into tools that support fork-path subagents.
    pub async fn set_parent_messages(&self, messages: &[serde_json::Value]) {
        for tool in self.all_tools() {
            tool.set_parent_messages(messages).await;
        }
    }

    /// Attach a permission provider to all tools that support command-level
    /// user confirmation (currently only ExecTool).
    pub async fn set_permission_provider(
        &self,
        provider: Arc<dyn crate::turn_executor::PermissionProvider>,
    ) {
        for tool in self.all_tools() {
            tool.set_permission_provider(Arc::clone(&provider)).await;
        }
    }
}

fn tool_schema_name(schema: &Value) -> Option<String> {
    schema
        .get("function")
        .and_then(|function| function.get("name"))
        .or_else(|| schema.get("name"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn tool_schema_summary(schema: &Value) -> Option<(String, String)> {
    let name = tool_schema_name(schema)?;
    let description = schema
        .get("function")
        .and_then(|function| function.get("description"))
        .or_else(|| schema.get("description"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    Some((name, description))
}

/// Resolve short tool aliases to canonical names.
///
/// Keeps the alias table small and close to the dispatch site so
/// new short names are trivially discoverable in one place.
fn resolve_tool_alias(name: &str) -> &str {
    match name {
        "wi" => super::names::MANAGE_WORK_ITEM,
        _ => name,
    }
}

impl Default for ToolRegistry {
    fn default() -> Self {
        Self::new()
    }
}

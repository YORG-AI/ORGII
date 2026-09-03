//! `tool_search` — discover tools by keyword.
//!
//! When the agent needs a capability that isn't in its current tool set,
//! it calls `tool_search` with a query. The search covers ALL registered
//! tools (not just the deferred pool) with tokenized scoring, and each
//! result is labeled `[loaded]`, `[deferred]`, or `[unavailable]` so the
//! model always gets an actionable answer instead of a dead end.

use std::sync::Arc;

use async_trait::async_trait;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;

use crate::tools::policy::ResolvedToolPolicy;
use crate::tools::registry::ToolRegistry;
use crate::tools::traits::{params_schema, parse_params, Tool, ToolError, ToolPriority};

const MAX_RESULTS: usize = 10;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ToolSearchParams {
    /// Search query — whitespace-separated keywords matched against tool
    /// names, hints, and descriptions (e.g. "shell grep", "browser").
    /// Use `select:<tool_name>` to look up one tool by exact name.
    /// An empty query lists all deferred tools.
    pub query: String,
}

/// Meta-tool that searches registered tools by keyword.
///
/// Core (`Always`) tools are already in the prompt; `OnDemand` tools are
/// deferred until discovered here. Tools denied by the session tool policy
/// are reported as unavailable with a reason, never silently hidden —
/// a model that can see *why* something is missing can route around it.
pub struct ToolSearchTool {
    registry: Arc<ToolRegistry>,
    policy: Option<Arc<ResolvedToolPolicy>>,
}

impl ToolSearchTool {
    pub fn new(registry: Arc<ToolRegistry>) -> Self {
        Self {
            registry,
            policy: None,
        }
    }

    /// Attach the session tool policy so results can be labeled
    /// `[unavailable]` when a tool exists but is policy-denied.
    pub fn with_policy(registry: Arc<ToolRegistry>, policy: Arc<ResolvedToolPolicy>) -> Self {
        Self {
            registry,
            policy: Some(policy),
        }
    }

    fn availability_label(
        &self,
        name: &str,
        deferred: bool,
        effective_policy: Option<&ResolvedToolPolicy>,
    ) -> &'static str {
        if let Some(policy) = effective_policy {
            if !policy.is_allowed(name) {
                return "[unavailable: denied by the current tool policy/mode — \
                        it may become available in a different mode (e.g. Build)]";
            }
        }
        if deferred {
            "[deferred — call it by name as usual; it will be loaded automatically]"
        } else {
            "[loaded — already in your tool list, call it directly]"
        }
    }

    fn format_matches(
        &self,
        query: &str,
        matches: &[(String, String, bool)],
        effective_policy: Option<&ResolvedToolPolicy>,
    ) -> String {
        let mut output = format!("Found {} tool(s) matching '{}':\n\n", matches.len(), query);
        for (name, description, deferred) in matches {
            let label = self.availability_label(name, *deferred, effective_policy);
            let summary: String = crate::utils::safe_truncate_chars_to_string(&description, 300);
            output.push_str(&format!("**{}** {}\n{}\n\n", name, label, summary));
        }
        output
    }

    /// Bounded catalogue of everything discoverable, used when a query
    /// misses. Replaces the old "Try a broader query" dead end.
    fn fallback_catalogue(&self, effective_policy: Option<&ResolvedToolPolicy>) -> String {
        let deferred = self
            .registry
            .deferred_tool_names()
            .into_iter()
            .filter(|name| effective_policy.is_none_or(|policy| policy.is_allowed(name)))
            .collect::<Vec<_>>();
        if deferred.is_empty() {
            return "No deferred tools are registered in this session.".to_string();
        }
        format!(
            "Available deferred tools ({}):\n{}\n\nCall any of them by name, or use `select:<name>` for details.",
            deferred.len(),
            deferred
                .iter()
                .map(|name| format!("  - {}", name))
                .collect::<Vec<_>>()
                .join("\n")
        )
    }

    fn exact_select(&self, name: &str, effective_policy: Option<&ResolvedToolPolicy>) -> String {
        match self.registry.get(name) {
            Some(tool) => {
                let deferred = tool.priority() == ToolPriority::OnDemand;
                let label = self.availability_label(tool.name(), deferred, effective_policy);
                format!("**{}** {}\n{}", tool.name(), label, tool.description())
            }
            None => format!(
                "No tool named '{}' is registered.\n\n{}",
                name,
                self.fallback_catalogue(effective_policy)
            ),
        }
    }
}

#[async_trait]
impl Tool for ToolSearchTool {
    fn name(&self) -> &str {
        crate::tools::names::TOOL_SEARCH
    }

    fn description(&self) -> &str {
        "Search for additional tools not currently loaded. Returns matching tool names, descriptions, and availability. Supports `select:<tool_name>` for exact lookup."
    }

    fn category(&self) -> &str {
        crate::tools::categories::META
    }

    fn is_read_only(&self) -> bool {
        true
    }

    fn priority(&self) -> ToolPriority {
        ToolPriority::Always
    }

    fn parameters(&self) -> Value {
        params_schema::<ToolSearchParams>()
    }

    async fn execute_text(
        &self,
        params: Value,
        ctx: &crate::tools::traits::CallContext,
    ) -> Result<String, ToolError> {
        let params: ToolSearchParams = parse_params(params)?;
        let query = params.query.trim();
        let effective_policy = if ctx
            .turn_process_control
            .as_ref()
            .is_some_and(|control| control.require_owned_job_finality)
        {
            self.policy
                .as_ref()
                .map(|policy| {
                    policy.for_persisted_agent_org_turn(&ctx.session_id, &ctx.turn_intent_id)
                })
                .transpose()
                .map_err(ToolError::ExecutionFailed)?
        } else {
            self.policy.as_deref().cloned()
        };

        if query.is_empty() {
            return Ok(self.fallback_catalogue(effective_policy.as_ref()));
        }

        if let Some(name) = query.strip_prefix("select:") {
            return Ok(self.exact_select(name.trim(), effective_policy.as_ref()));
        }

        let matches = self.registry.search_tools(query, MAX_RESULTS);

        if matches.is_empty() {
            Ok(format!(
                "No tools found matching '{}'.\n\n{}",
                query,
                self.fallback_catalogue(effective_policy.as_ref())
            ))
        } else {
            Ok(self.format_matches(query, &matches, effective_policy.as_ref()))
        }
    }
}

use super::strip_optional_null_placeholders;
use crate::tools::policy::{ResolvedToolPolicy, ToolPolicyLayer};
use crate::tools::registry::ToolRegistry;
use crate::tools::traits::{Tool, ToolError, ToolPriority, ToolSchemaCacheScope};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::Arc;

// ============================================
// Mock Tool
// ============================================

struct MockTool {
    tool_name: String,
    tool_description: String,
    tool_category: String,
    ready: bool,
    tool_priority: ToolPriority,
    schema_cache_scope: ToolSchemaCacheScope,
    tool_schema_priority: i8,
}

impl MockTool {
    fn new(name: &str) -> Self {
        Self {
            tool_name: name.to_string(),
            tool_description: format!("Mock tool: {}", name),
            tool_category: "testing".to_string(),
            ready: true,
            tool_priority: ToolPriority::Always,
            schema_cache_scope: ToolSchemaCacheScope::StablePrefix,
            tool_schema_priority: 0,
        }
    }

    fn with_schema_priority(name: &str, priority: i8) -> Self {
        Self {
            tool_schema_priority: priority,
            ..Self::new(name)
        }
    }

    fn live(name: &str) -> Self {
        Self {
            tool_name: name.to_string(),
            tool_description: format!("Live tool: {}", name),
            tool_category: "testing".to_string(),
            ready: true,
            tool_priority: ToolPriority::Always,
            schema_cache_scope: ToolSchemaCacheScope::LiveSuffix,
            tool_schema_priority: 0,
        }
    }

    fn not_ready(name: &str) -> Self {
        Self {
            tool_name: name.to_string(),
            tool_description: format!("Unready tool: {}", name),
            tool_category: "testing".to_string(),
            ready: false,
            tool_priority: ToolPriority::Always,
            schema_cache_scope: ToolSchemaCacheScope::StablePrefix,
            tool_schema_priority: 0,
        }
    }

    fn on_demand(name: &str, description: &str) -> Self {
        Self {
            tool_name: name.to_string(),
            tool_description: description.to_string(),
            tool_category: "testing".to_string(),
            ready: true,
            tool_priority: ToolPriority::OnDemand,
            schema_cache_scope: ToolSchemaCacheScope::StablePrefix,
            tool_schema_priority: 0,
        }
    }
}

#[async_trait]
impl Tool for MockTool {
    fn name(&self) -> &str {
        &self.tool_name
    }

    fn description(&self) -> &str {
        &self.tool_description
    }

    fn category(&self) -> &str {
        &self.tool_category
    }

    fn is_ready(&self) -> bool {
        self.ready
    }

    fn not_ready_reason(&self) -> Option<&str> {
        if self.ready {
            None
        } else {
            Some("not configured")
        }
    }

    fn priority(&self) -> ToolPriority {
        self.tool_priority
    }

    fn schema_cache_scope(&self) -> ToolSchemaCacheScope {
        self.schema_cache_scope
    }

    fn schema_priority(&self) -> i8 {
        self.tool_schema_priority
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "input": {"type": "string"}
            }
        })
    }

    async fn execute_text(
        &self,
        _params: Value,
        _ctx: &crate::tools::traits::CallContext,
    ) -> Result<String, ToolError> {
        Ok(format!("executed:{}", self.tool_name))
    }
}

// ============================================
// Basic Operations
// ============================================

#[test]
fn strict_schema_null_placeholders_restore_optional_omissions() {
    let schema = json!({
        "type": "object",
        "required": ["query"],
        "properties": {
            "query": {"type": "string"},
            "repo_paths": {
                "type": "array",
                "items": {"type": "string"}
            },
            "explicit_null": {
                "anyOf": [
                    {"type": "string"},
                    {"type": "null"}
                ]
            }
        }
    });
    let mut params = json!({
        "query": "TodoBlock",
        "repo_paths": null,
        "explicit_null": null
    });

    strip_optional_null_placeholders(&mut params, &schema);

    assert_eq!(
        params,
        json!({
            "query": "TodoBlock",
            "explicit_null": null
        })
    );
}

#[test]
fn strict_schema_null_placeholder_cleanup_recurses_into_nested_objects() {
    let schema = json!({
        "type": "object",
        "required": ["items"],
        "properties": {
            "items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["content"],
                    "properties": {
                        "content": {"type": "string"},
                        "activeForm": {"type": "string"}
                    }
                }
            }
        }
    });
    let mut params = json!({
        "items": [{"content": "Run tests", "activeForm": null}]
    });

    strip_optional_null_placeholders(&mut params, &schema);

    assert_eq!(params, json!({"items": [{"content": "Run tests"}]}));
}

#[test]
fn new_registry_is_empty() {
    let registry = ToolRegistry::new();
    assert!(registry.is_empty());
    assert_eq!(registry.len(), 0);
}

#[test]
fn default_registry_is_empty() {
    let registry = ToolRegistry::default();
    assert!(registry.is_empty());
}

#[test]
fn register_and_get_tool() {
    let mut registry = ToolRegistry::new();
    registry.register(Box::new(MockTool::new("read_file")));

    assert!(registry.has("read_file"));
    assert!(!registry.has("nonexistent"));
    assert_eq!(registry.len(), 1);
    assert!(!registry.is_empty());

    let tool = registry.get("read_file");
    assert!(tool.is_some());
    assert_eq!(tool.unwrap().name(), "read_file");
}

#[test]
fn register_replaces_existing_tool() {
    let mut registry = ToolRegistry::new();
    registry.register(Box::new(MockTool::new("tool_a")));
    registry.register(Box::new(MockTool::new("tool_a")));
    assert_eq!(registry.len(), 1);
}

// ============================================
// Tool Names & Info
// ============================================

#[test]
fn tool_names_returns_all_registered() {
    let mut registry = ToolRegistry::new();
    registry.register(Box::new(MockTool::new("exec")));
    registry.register(Box::new(MockTool::new("read_file")));
    registry.register(Box::new(MockTool::new("search")));

    let mut names = registry.tool_names();
    names.sort();
    assert_eq!(names, vec!["exec", "read_file", "search"]);
}

#[test]
fn tool_info_returns_sorted_entries() {
    let mut registry = ToolRegistry::new();
    registry.register(Box::new(MockTool::new("zebra")));
    registry.register(Box::new(MockTool::new("alpha")));

    let info = registry.tool_info();
    assert_eq!(info.len(), 2);
    assert_eq!(info[0].0, "alpha");
    assert_eq!(info[1].0, "zebra");
    assert_eq!(info[0].2, "testing");
}

// ============================================
// Definitions & Readiness
// ============================================

#[test]
fn get_definitions_excludes_unready_tools() {
    let mut registry = ToolRegistry::new();
    registry.register(Box::new(MockTool::new("ready_tool")));
    registry.register(Box::new(MockTool::not_ready("unready_tool")));

    let defs = registry.get_definitions();
    assert_eq!(defs.len(), 1);

    let name = defs[0]["function"]["name"].as_str().unwrap();
    assert_eq!(name, "ready_tool");
}

#[test]
fn get_definitions_emits_stable_prefix_before_live_suffix() {
    let mut registry = ToolRegistry::new();
    registry.register(Box::new(MockTool::live("live_alpha")));
    registry.register(Box::new(MockTool::new("stable_zebra")));
    registry.register(Box::new(MockTool::live("live_beta")));
    registry.register(Box::new(MockTool::new("stable_alpha")));

    let defs = registry.get_definitions();
    let names: Vec<&str> = defs
        .iter()
        .map(|definition| definition["function"]["name"].as_str().unwrap())
        .collect();
    let scopes: Vec<&str> = defs
        .iter()
        .map(|definition| {
            definition[crate::tools::metadata::ORGII_TOOL_SCHEMA_CACHE_SCOPE_KEY]
                .as_str()
                .unwrap()
        })
        .collect();

    assert_eq!(
        names,
        vec!["stable_alpha", "stable_zebra", "live_alpha", "live_beta"]
    );
    assert_eq!(
        scopes,
        vec![
            "stable_prefix",
            "stable_prefix",
            "live_suffix",
            "live_suffix"
        ]
    );
}

// ============================================
// Fallback Registry
// ============================================

#[test]
fn fallback_provides_tools_not_in_local() {
    let mut inner = ToolRegistry::new();
    inner.register(Box::new(MockTool::new("inner_tool")));
    let inner_arc = Arc::new(inner);

    let outer = ToolRegistry::with_fallback(inner_arc);

    assert!(outer.has("inner_tool"));
    assert_eq!(outer.len(), 1);

    let tool = outer.get("inner_tool");
    assert!(tool.is_some());
    assert_eq!(tool.unwrap().name(), "inner_tool");
}

#[test]
fn local_tool_overrides_fallback() {
    let mut inner = ToolRegistry::new();
    inner.register(Box::new(MockTool::new("shared")));
    let inner_arc = Arc::new(inner);

    let mut outer = ToolRegistry::with_fallback(inner_arc);
    outer.register(Box::new(MockTool::new("shared")));

    // Only counts once (local overrides)
    assert_eq!(outer.len(), 1);
    assert!(outer.has("shared"));
}

#[test]
fn len_counts_combined_without_duplicates() {
    let mut inner = ToolRegistry::new();
    inner.register(Box::new(MockTool::new("a")));
    inner.register(Box::new(MockTool::new("b")));
    inner.register(Box::new(MockTool::new("c")));
    let inner_arc = Arc::new(inner);

    let mut outer = ToolRegistry::with_fallback(inner_arc);
    outer.register(Box::new(MockTool::new("b"))); // overlaps
    outer.register(Box::new(MockTool::new("d"))); // new

    // a (fb) + b (local, overlaps fb) + c (fb) + d (local) = 4
    assert_eq!(outer.len(), 4);
}

#[test]
fn tool_names_includes_fallback_without_duplicates() {
    let mut inner = ToolRegistry::new();
    inner.register(Box::new(MockTool::new("x")));
    inner.register(Box::new(MockTool::new("y")));
    let inner_arc = Arc::new(inner);

    let mut outer = ToolRegistry::with_fallback(inner_arc);
    outer.register(Box::new(MockTool::new("y"))); // overlaps
    outer.register(Box::new(MockTool::new("z"))); // new

    let mut names = outer.tool_names();
    names.sort();
    assert_eq!(names, vec!["x", "y", "z"]);
}

#[test]
fn get_definitions_merges_fallback_without_duplicates() {
    let mut inner = ToolRegistry::new();
    inner.register(Box::new(MockTool::new("fb_only")));
    inner.register(Box::new(MockTool::new("both")));
    let inner_arc = Arc::new(inner);

    let mut outer = ToolRegistry::with_fallback(inner_arc);
    outer.register(Box::new(MockTool::new("both")));
    outer.register(Box::new(MockTool::new("local_only")));

    let defs = outer.get_definitions();
    // local: both, local_only; fb: fb_only (both already in local)
    assert_eq!(defs.len(), 3);
}

// ============================================
// Execute
// ============================================

#[tokio::test]
async fn execute_runs_registered_tool() {
    let mut registry = ToolRegistry::new();
    registry.register(Box::new(MockTool::new("my_tool")));

    let result = registry
        .execute(
            "my_tool",
            json!({}),
            &crate::tools::call_context::CallContext::default(),
        )
        .await
        .unwrap();
    assert_eq!(result.text, "executed:my_tool");
}

#[tokio::test]
async fn execute_returns_error_for_missing_tool() {
    let registry = ToolRegistry::new();
    let err = registry
        .execute(
            "missing",
            json!({}),
            &crate::tools::call_context::CallContext::default(),
        )
        .await
        .unwrap_err();
    assert!(err.contains("not found"));
}

#[tokio::test]
async fn execute_fallback_tool() {
    let mut inner = ToolRegistry::new();
    inner.register(Box::new(MockTool::new("fb_tool")));
    let inner_arc = Arc::new(inner);

    let outer = ToolRegistry::with_fallback(inner_arc);
    let result = outer
        .execute(
            "fb_tool",
            json!({}),
            &crate::tools::call_context::CallContext::default(),
        )
        .await
        .unwrap();
    assert_eq!(result.text, "executed:fb_tool");
}

// ============================================
// Tool Priority & Budgeted Definitions
// ============================================

#[test]
fn default_priority_is_always() {
    let tool = MockTool::new("regular");
    assert_eq!(tool.priority(), ToolPriority::Always);
}

#[test]
fn on_demand_priority() {
    let tool = MockTool::on_demand("db_tool", "Database explorer");
    assert_eq!(tool.priority(), ToolPriority::OnDemand);
}

#[test]
fn get_definitions_budgeted_excludes_on_demand() {
    let mut registry = ToolRegistry::new();
    registry.register(Box::new(MockTool::new("read_file")));
    registry.register(Box::new(MockTool::new("exec")));
    registry.register(Box::new(MockTool::on_demand(
        "db_explore",
        "Explore databases",
    )));
    registry.register(Box::new(MockTool::on_demand("db_run", "Run SQL queries")));

    let policy = ResolvedToolPolicy::permissive();
    let defs = registry.get_definitions_budgeted(&policy);

    let names: Vec<&str> = defs
        .iter()
        .filter_map(|d| d["function"]["name"].as_str())
        .collect();

    assert!(names.contains(&"read_file"));
    assert!(names.contains(&"exec"));
    assert!(!names.contains(&"db_explore"));
    assert!(!names.contains(&"db_run"));
    assert_eq!(defs.len(), 2);
}

/// Negative schema_priority (e.g. `agent` = -10) surfaces the tool at the
/// top of the provider list; all priority-0 tools keep the registry's
/// deterministic order (cache segment, then name — stable sort).
#[test]
fn get_definitions_budgeted_sorts_by_schema_priority() {
    let mut registry = ToolRegistry::new();
    registry.register(Box::new(MockTool::new("read_file")));
    registry.register(Box::new(MockTool::new("exec")));
    registry.register(Box::new(MockTool::with_schema_priority("agent", -10)));
    registry.register(Box::new(MockTool::new("edit_file")));

    let policy = ResolvedToolPolicy::permissive();
    let defs = registry.get_definitions_budgeted(&policy);

    let names: Vec<&str> = defs
        .iter()
        .filter_map(|d| d["function"]["name"].as_str())
        .collect();

    // "agent" jumps the lexicographic order ("agent" would sort first here
    // anyway, so pin the more interesting property below with a name that
    // would otherwise sort LAST).
    assert_eq!(names[0], "agent", "negative priority must sort first");
    // Priority-0 tools keep the deterministic lexicographic tie order.
    assert_eq!(names[1..], ["edit_file", "exec", "read_file"]);

    // Same check with a priority tool whose name sorts last lexicographically:
    // priority must beat name order.
    let mut registry = ToolRegistry::new();
    registry.register(Box::new(MockTool::new("edit_file")));
    registry.register(Box::new(MockTool::with_schema_priority("zz_agent", -10)));
    let defs = registry.get_definitions_budgeted(&policy);
    let names: Vec<&str> = defs
        .iter()
        .filter_map(|d| d["function"]["name"].as_str())
        .collect();
    assert_eq!(names, vec!["zz_agent", "edit_file"]);
}

/// Priority sorting also applies across fallback layers: a high-priority
/// tool registered in the base registry still sorts to the top of the
/// combined definition list.
#[test]
fn schema_priority_sorts_across_fallback_layers() {
    let mut base = ToolRegistry::new();
    base.register(Box::new(MockTool::with_schema_priority("agent", -10)));
    let mut overlay = ToolRegistry::with_fallback(Arc::new(base));
    overlay.register(Box::new(MockTool::new("read_file")));

    let policy = ResolvedToolPolicy::permissive();
    let defs = overlay.get_definitions_budgeted(&policy);

    let names: Vec<&str> = defs
        .iter()
        .filter_map(|d| d["function"]["name"].as_str())
        .collect();
    assert_eq!(names, vec!["agent", "read_file"]);
}

#[test]
fn prompt_tool_summaries_match_budgeted_policy_surface() {
    let mut registry = ToolRegistry::new();
    registry.register(Box::new(MockTool::new("read_file")));
    registry.register(Box::new(MockTool::new("edit_file")));
    registry.register(Box::new(MockTool::on_demand(
        "db_explore",
        "Explore databases",
    )));

    let policy = ResolvedToolPolicy::from_layers(vec![ToolPolicyLayer {
        allow: Some(vec!["read_file".to_string()]),
        deny: Vec::new(),
    }]);

    let names = registry.prompt_tool_names(&policy);
    let summaries = registry.prompt_tool_summaries(&policy);

    assert_eq!(names, vec!["read_file"]);
    assert_eq!(summaries.len(), 1);
    assert_eq!(summaries[0].0, "read_file");
    assert_eq!(summaries[0].1, "Mock tool: read_file");
}

#[test]
fn get_definitions_budgeted_with_fallback() {
    let mut inner = ToolRegistry::new();
    inner.register(Box::new(MockTool::new("inner_always")));
    inner.register(Box::new(MockTool::on_demand(
        "inner_deferred",
        "Deferred tool",
    )));
    let inner_arc = Arc::new(inner);

    let mut outer = ToolRegistry::with_fallback(inner_arc);
    outer.register(Box::new(MockTool::new("outer_always")));

    let policy = ResolvedToolPolicy::permissive();
    let defs = outer.get_definitions_budgeted(&policy);

    let names: Vec<&str> = defs
        .iter()
        .filter_map(|d| d["function"]["name"].as_str())
        .collect();

    assert!(names.contains(&"outer_always"));
    assert!(names.contains(&"inner_always"));
    assert!(!names.contains(&"inner_deferred"));
    assert_eq!(defs.len(), 2);
}

/// Regression: `with_fallback(outer_with_fallback(...))` used to drop
/// the deepest layer. Memory forks (`ToolRegistry::with_fallback(self.tools)`)
/// hit this — the main agent's overlay only registers meta-tools directly,
/// so without recursion the LLM would see zero base tools.
#[test]
fn get_definitions_budgeted_recurses_through_multiple_fallback_layers() {
    let mut base = ToolRegistry::new();
    base.register(Box::new(MockTool::new("base_tool_a")));
    base.register(Box::new(MockTool::new("base_tool_b")));
    let base_arc = Arc::new(base);

    let mut overlay = ToolRegistry::with_fallback(Arc::clone(&base_arc));
    overlay.register(Box::new(MockTool::new("overlay_meta")));
    let overlay_arc = Arc::new(overlay);

    let fork = ToolRegistry::with_fallback(overlay_arc);

    let policy = ResolvedToolPolicy::permissive();
    let defs = fork.get_definitions_budgeted(&policy);

    let names: Vec<&str> = defs
        .iter()
        .filter_map(|d| d["function"]["name"].as_str())
        .collect();

    assert!(names.contains(&"base_tool_a"));
    assert!(names.contains(&"base_tool_b"));
    assert!(names.contains(&"overlay_meta"));
    assert_eq!(defs.len(), 3);
}

#[test]
fn get_definitions_shadows_by_name_across_fallback_chain() {
    let mut base = ToolRegistry::new();
    base.register(Box::new(MockTool::new("shared")));
    let base_arc = Arc::new(base);

    let mut overlay = ToolRegistry::with_fallback(base_arc);
    overlay.register(Box::new(MockTool::new("shared")));

    let defs = overlay.get_definitions();

    let count = defs
        .iter()
        .filter(|d| d["function"]["name"].as_str() == Some("shared"))
        .count();
    assert_eq!(count, 1, "name shadowing must not produce duplicates");
}

// ============================================
// Tool Search (tokenized, all tools)
// ============================================

#[test]
fn search_tools_by_name() {
    let mut registry = ToolRegistry::new();
    registry.register(Box::new(MockTool::new("read_file")));
    registry.register(Box::new(MockTool::on_demand(
        "db_explore",
        "Explore database schemas",
    )));
    registry.register(Box::new(MockTool::on_demand("db_run", "Run SQL queries")));

    let results = registry.search_tools("db", 10);
    assert_eq!(results.len(), 2);
    assert_eq!(results[0].0, "db_explore");
    assert_eq!(results[1].0, "db_run");
    assert!(results[0].2, "on-demand tool must be flagged deferred");
}

#[test]
fn search_tools_by_description() {
    let mut registry = ToolRegistry::new();
    registry.register(Box::new(MockTool::on_demand(
        "canvas_draw",
        "Draw shapes on a canvas",
    )));
    registry.register(Box::new(MockTool::on_demand(
        "web_scrape",
        "Scrape web page content",
    )));

    let results = registry.search_tools("canvas", 10);
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].0, "canvas_draw");
}

#[test]
fn search_tools_case_insensitive() {
    let mut registry = ToolRegistry::new();
    registry.register(Box::new(MockTool::on_demand(
        "DataViz",
        "Visualize data charts",
    )));

    let results = registry.search_tools("dataviz", 10);
    assert_eq!(results.len(), 1);
}

#[test]
fn search_tools_includes_always_tools_marked_loaded() {
    let mut registry = ToolRegistry::new();
    registry.register(Box::new(MockTool::new("read_file")));
    registry.register(Box::new(MockTool::on_demand(
        "file_stats",
        "Show file statistics",
    )));

    let results = registry.search_tools("file", 10);
    assert_eq!(results.len(), 2, "always tools must appear too");
    let read_file = results.iter().find(|r| r.0 == "read_file").unwrap();
    assert!(!read_file.2, "always tool must NOT be flagged deferred");
    let file_stats = results.iter().find(|r| r.0 == "file_stats").unwrap();
    assert!(file_stats.2);
}

#[test]
fn search_tools_multiword_natural_language_query() {
    // The regression that motivated the rewrite: whole-phrase substring
    // matching returned zero results for natural queries like
    // "shell command execute grep".
    let mut registry = ToolRegistry::new();
    registry.register(Box::new(MockTool::on_demand(
        "run_shell",
        "Execute a shell command or kill a backgrounded process.",
    )));
    registry.register(Box::new(MockTool::on_demand(
        "web_scrape",
        "Scrape web page content",
    )));

    let results = registry.search_tools("shell command execute grep", 10);
    assert!(
        results.iter().any(|r| r.0 == "run_shell"),
        "tokenized matching must find run_shell for a multiword query"
    );
}

#[test]
fn search_tools_ranks_name_hits_above_description_hits() {
    let mut registry = ToolRegistry::new();
    registry.register(Box::new(MockTool::on_demand(
        "other_tool",
        "A tool about shell things",
    )));
    registry.register(Box::new(MockTool::on_demand("run_shell", "Run programs")));

    let results = registry.search_tools("shell", 10);
    assert_eq!(
        results[0].0, "run_shell",
        "name hit must outrank description hit"
    );
}

#[test]
fn search_tools_no_matches() {
    let mut registry = ToolRegistry::new();
    registry.register(Box::new(MockTool::on_demand(
        "db_explore",
        "Database explorer",
    )));

    let results = registry.search_tools("nonexistent", 10);
    assert!(results.is_empty());
}

#[test]
fn search_tools_respects_limit() {
    let mut registry = ToolRegistry::new();
    for i in 0..20 {
        registry.register(Box::new(MockTool::on_demand(
            &format!("db_tool_{i}"),
            "Database tool",
        )));
    }

    let results = registry.search_tools("db", 5);
    assert_eq!(results.len(), 5);
}

#[test]
fn deferred_tool_names_lists_all_on_demand() {
    let mut registry = ToolRegistry::new();
    registry.register(Box::new(MockTool::new("always_tool")));
    registry.register(Box::new(MockTool::on_demand("deferred_a", "Tool A")));
    registry.register(Box::new(MockTool::on_demand("deferred_b", "Tool B")));
    registry.register(Box::new(MockTool::not_ready("not_ready_deferred")));

    let names = registry.deferred_tool_names();
    assert_eq!(names, vec!["deferred_a", "deferred_b"]);
}

#[test]
fn deferred_tool_names_includes_fallback() {
    let mut inner = ToolRegistry::new();
    inner.register(Box::new(MockTool::on_demand(
        "fb_deferred",
        "Fallback deferred",
    )));
    let inner_arc = Arc::new(inner);

    let mut outer = ToolRegistry::with_fallback(inner_arc);
    outer.register(Box::new(MockTool::on_demand(
        "local_deferred",
        "Local deferred",
    )));

    let names = outer.deferred_tool_names();
    assert_eq!(names, vec!["fb_deferred", "local_deferred"]);
}

// ============================================
// ToolSearchTool Execute
// ============================================

#[tokio::test]
async fn tool_search_finds_deferred_tools() {
    let mut registry = ToolRegistry::new();
    registry.register(Box::new(MockTool::new("read_file")));
    registry.register(Box::new(MockTool::on_demand(
        "db_explore",
        "Explore database schemas and tables",
    )));
    registry.register(Box::new(MockTool::on_demand(
        "db_run",
        "Execute SQL queries against databases",
    )));
    let registry_arc = Arc::new(registry);

    let search_tool = crate::tools::impls::meta::tool_search::ToolSearchTool::new(registry_arc);
    let result = search_tool
        .execute(
            json!({"query": "database"}),
            &crate::tools::call_context::CallContext::default(),
        )
        .await
        .unwrap();

    assert!(result.contains("db_explore"));
    assert!(result.contains("db_run"));
    assert!(result.contains("Found 2 tool(s)"));
}

#[tokio::test]
async fn tool_search_empty_query_lists_all() {
    let mut registry = ToolRegistry::new();
    registry.register(Box::new(MockTool::on_demand("tool_a", "Description A")));
    registry.register(Box::new(MockTool::on_demand("tool_b", "Description B")));
    let registry_arc = Arc::new(registry);

    let search_tool = crate::tools::impls::meta::tool_search::ToolSearchTool::new(registry_arc);
    let result = search_tool
        .execute(
            json!({"query": ""}),
            &crate::tools::call_context::CallContext::default(),
        )
        .await
        .unwrap();

    assert!(result.contains("Available deferred tools (2)"));
    assert!(result.contains("tool_a"));
    assert!(result.contains("tool_b"));
}

#[tokio::test]
async fn tool_search_no_matches_returns_catalogue() {
    let mut registry = ToolRegistry::new();
    registry.register(Box::new(MockTool::on_demand("db_tool", "Database tool")));
    let registry_arc = Arc::new(registry);

    let search_tool = crate::tools::impls::meta::tool_search::ToolSearchTool::new(registry_arc);
    let result = search_tool
        .execute(
            json!({"query": "nonexistent"}),
            &crate::tools::call_context::CallContext::default(),
        )
        .await
        .unwrap();

    assert!(result.contains("No tools found"));
    // Zero hits must NOT be a dead end: the full deferred catalogue follows.
    assert!(result.contains("db_tool"));
}

#[tokio::test]
async fn tool_search_no_deferred_tools() {
    let mut registry = ToolRegistry::new();
    registry.register(Box::new(MockTool::new("always_tool")));
    let registry_arc = Arc::new(registry);

    let search_tool = crate::tools::impls::meta::tool_search::ToolSearchTool::new(registry_arc);
    let result = search_tool
        .execute(
            json!({"query": ""}),
            &crate::tools::call_context::CallContext::default(),
        )
        .await
        .unwrap();

    assert!(result.contains("No deferred tools are registered"));
}

#[tokio::test]
async fn tool_search_select_exact_name() {
    let mut registry = ToolRegistry::new();
    registry.register(Box::new(MockTool::on_demand("db_tool", "Database tool")));
    let registry_arc = Arc::new(registry);

    let search_tool = crate::tools::impls::meta::tool_search::ToolSearchTool::new(registry_arc);
    let result = search_tool
        .execute(
            json!({"query": "select:db_tool"}),
            &crate::tools::call_context::CallContext::default(),
        )
        .await
        .unwrap();

    assert!(result.contains("db_tool"));
    assert!(result.contains("deferred"));
}

#[tokio::test]
async fn tool_search_marks_policy_denied_as_unavailable() {
    let mut registry = ToolRegistry::new();
    registry.register(Box::new(MockTool::new("run_shell")));
    let registry_arc = Arc::new(registry);

    let mut policy = ResolvedToolPolicy::permissive();
    policy = policy.with_extra_layer(ToolPolicyLayer {
        allow: None,
        deny: vec!["run_shell".to_string()],
    });

    let search_tool = crate::tools::impls::meta::tool_search::ToolSearchTool::with_policy(
        registry_arc,
        Arc::new(policy),
    );
    let result = search_tool
        .execute(
            json!({"query": "shell"}),
            &crate::tools::call_context::CallContext::default(),
        )
        .await
        .unwrap();

    assert!(result.contains("run_shell"));
    assert!(
        result.contains("unavailable"),
        "policy-denied tool must be reported as unavailable, not hidden: {result}"
    );
}

// ============================================
// LLM Schema Compatibility Contract
// ============================================

#[test]
fn all_registered_tool_schemas_are_llm_compatible() {
    // Registry-level invariant: every schema a tool exposes must survive
    // the least-common-denominator function-calling dialect. A top-level
    // tagged-enum (`oneOf`) schema gets flattened to `properties: {}` by
    // providers and every call then fails with "missing field". This test
    // exercises the concrete params types that previously violated it.
    use crate::tools::traits::assert_llm_compatible_schema;

    let schemas: Vec<(&str, Value)> = vec![
        (
            "inspect_terminals",
            crate::tools::traits::params_schema::<
                crate::tools::impls::coding::inspect_terminals::InspectTerminalsParams,
            >(),
        ),
        (
            "manage_workspace",
            crate::tools::traits::params_schema::<
                crate::tools::impls::coding::manage_workspace::ManageWorkspaceParams,
            >(),
        ),
        (
            "worktree",
            crate::tools::traits::params_schema::<
                crate::tools::impls::coding::worktree::WorktreeParams,
            >(),
        ),
    ];
    for (name, schema) in schemas {
        assert_llm_compatible_schema(&schema)
            .unwrap_or_else(|err| panic!("{name} schema violates LLM contract: {err}"));
        let props = schema["properties"].as_object().unwrap();
        assert!(
            props.contains_key("action"),
            "{name} schema must expose the `action` field to the model"
        );
    }
}

#[test]
fn real_tool_schemas_have_no_nullable_type_arrays() {
    // Tools with `Option<T>` fields (e.g. `edit_file`'s content/old_string/
    // new_string) make schemars emit `"type": ["string", "null"]`. draft-07
    // permits that, but baidu/ernie's function-call validator rejects any
    // nullable type-array with HTTP 400 `not a valid jsonSchema`.
    // `params_schema` collapses every `[scalar, "null"]` to the plain scalar,
    // so the generated schema must contain NO `"type"` arrays at all. Pin the
    // real offender (`edit_file`) plus a write-file params type so a future
    // optional field that reintroduces a nullable array is caught here rather
    // than at runtime against a specific provider.
    use crate::tools::traits::params_schema;

    fn has_type_array(value: &Value) -> bool {
        match value {
            Value::Object(map) => {
                if matches!(map.get("type"), Some(Value::Array(_))) {
                    return true;
                }
                map.values().any(has_type_array)
            }
            Value::Array(items) => items.iter().any(has_type_array),
            _ => false,
        }
    }

    let schemas: Vec<(&str, Value)> = vec![(
        "edit_file",
        params_schema::<crate::tools::impls::coding::edit_file::EditFileParams>(),
    )];

    for (name, schema) in schemas {
        assert!(
            !has_type_array(&schema),
            "{name} schema must not contain nullable type arrays \
             (baidu/ernie rejects them): {schema}"
        );
    }
}

#[test]
fn llm_contract_rejects_tagged_enum_schema() {
    use crate::tools::traits::assert_llm_compatible_schema;
    use schemars::JsonSchema;

    #[derive(JsonSchema)]
    #[serde(tag = "action", rename_all = "snake_case")]
    #[allow(dead_code)]
    enum BadParams {
        Foo { x: String },
        Bar,
    }

    let schema = crate::tools::traits::params_schema::<BadParams>();
    assert!(
        assert_llm_compatible_schema(&schema).is_err(),
        "top-level tagged-enum schemas must be rejected by the contract"
    );
}

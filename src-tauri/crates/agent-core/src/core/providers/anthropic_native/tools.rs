//! OpenAI → Anthropic tool definition conversion.
//!
//! Anthropic uses a flat `{ name, description, input_schema }` shape
//! whereas OpenAI nests it under `function`. This module also stamps
//! cache breakpoints on the generic tool-schema cache boundaries emitted by
//! the registry.

use serde_json::Value;

use crate::tools::metadata::{
    strip_tool_schema_cache_scope, tool_schema_cache_scope, ToolSchemaCacheScope,
};

/// Convert OpenAI-format tool definitions to Anthropic format and stamp
/// prompt-cache breakpoints at generic schema cache boundaries.
///
/// The registry already emits stable schemas before runtime-live schemas. This
/// adapter only translates that generic metadata into Anthropic's
/// `cache_control` wire marker.
///
/// When `skip_cache_write` is true, no breakpoints (BP2) are stamped —
/// one-shot side queries never re-read the cached prefix, so writing it
/// only pays the cache-write premium.
pub(super) fn convert_tools(openai_tools: &[Value], skip_cache_write: bool) -> Vec<Value> {
    let mut tools: Vec<(ToolSchemaCacheScope, Value)> = openai_tools
        .iter()
        .filter_map(|tool| {
            convert_one_tool(tool).map(|converted| (tool_schema_cache_scope(tool), converted))
        })
        .collect();

    if !skip_cache_write {
        if let Some(last_stable_index) = tools
            .iter()
            .rposition(|(scope, _)| *scope == ToolSchemaCacheScope::StablePrefix)
        {
            stamp_cache_control(&mut tools[last_stable_index].1);
        }

        if let Some((_, last)) = tools.last_mut() {
            stamp_cache_control(last);
        }
    }

    tools.into_iter().map(|(_, tool)| tool).collect()
}

fn convert_one_tool(tool: &Value) -> Option<Value> {
    let mut tool = tool.clone();
    strip_tool_schema_cache_scope(&mut tool);
    let func = tool.get("function")?;
    let name = func.get("name")?.as_str()?;
    let description = func
        .get("description")
        .and_then(|description| description.as_str())
        .unwrap_or("");
    let parameters = func
        .get("parameters")
        .cloned()
        .unwrap_or(serde_json::json!({
            "type": "object",
            "properties": {}
        }));

    Some(serde_json::json!({
        "name": name,
        "description": description,
        "input_schema": parameters,
    }))
}

fn stamp_cache_control(tool: &mut Value) {
    if let Some(obj) = tool.as_object_mut() {
        obj.insert(
            "cache_control".to_string(),
            serde_json::json!({ "type": "ephemeral" }),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn convert_tools_adds_cache_control_to_last() {
        let tools = vec![tool_def("read_file", "Read"), tool_def("exec", "Exec")];
        let converted = convert_tools(&tools, false);
        assert_eq!(converted.len(), 2);
        assert!(converted[0].get("cache_control").is_none());
        assert!(converted[1]["cache_control"].is_object());
    }

    #[test]
    fn convert_tools_stamps_generic_stable_prefix_boundary() {
        let tools = vec![
            tool_def("exec", "Exec"),
            tool_def("read_file", "Read"),
            tool_def_with_scope(
                "external_search",
                "Search",
                ToolSchemaCacheScope::LiveSuffix,
            ),
            tool_def_with_scope("plugin_notify", "Notify", ToolSchemaCacheScope::LiveSuffix),
        ];

        let converted = convert_tools(&tools, false);
        let names: Vec<&str> = converted
            .iter()
            .map(|tool| tool["name"].as_str().expect("tool name"))
            .collect();

        assert_eq!(
            names,
            vec!["exec", "read_file", "external_search", "plugin_notify"]
        );
        assert!(converted[0].get("cache_control").is_none());
        assert!(converted[1]["cache_control"].is_object());
        assert!(converted[2].get("cache_control").is_none());
        assert!(converted[3]["cache_control"].is_object());
    }

    #[test]
    fn convert_tools_stamps_only_final_tool_when_all_tools_are_live() {
        let tools = vec![
            tool_def_with_scope(
                "external_search",
                "Search",
                ToolSchemaCacheScope::LiveSuffix,
            ),
            tool_def_with_scope("plugin_notify", "Notify", ToolSchemaCacheScope::LiveSuffix),
        ];

        let converted = convert_tools(&tools, false);

        assert_eq!(converted.len(), 2);
        assert!(converted[0].get("cache_control").is_none());
        assert!(converted[1]["cache_control"].is_object());
    }

    #[test]
    fn convert_tools_skip_cache_write_stamps_no_breakpoints() {
        let tools = vec![
            tool_def("exec", "Exec"),
            tool_def("read_file", "Read"),
            tool_def_with_scope("plugin_notify", "Notify", ToolSchemaCacheScope::LiveSuffix),
        ];

        let converted = convert_tools(&tools, true);

        assert_eq!(converted.len(), 3);
        for tool in &converted {
            assert!(
                tool.get("cache_control").is_none(),
                "skip_cache_write must suppress every BP2 stamp: {tool}"
            );
        }
    }

    fn tool_def(name: &str, description: &str) -> Value {
        tool_def_with_scope(name, description, ToolSchemaCacheScope::StablePrefix)
    }

    fn tool_def_with_scope(name: &str, description: &str, scope: ToolSchemaCacheScope) -> Value {
        json!({
            "type": "function",
            "function": {
                "name": name,
                "description": description,
                "parameters": {
                    "type": "object",
                    "properties": {}
                }
            },
            (crate::tools::metadata::ORGII_TOOL_SCHEMA_CACHE_SCOPE_KEY): scope.as_str(),
        })
    }
}

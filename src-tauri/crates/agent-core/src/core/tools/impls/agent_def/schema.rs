//! JSON Schema for `AgentDefinitionTool::parameters`.

use serde_json::{json, Value};

pub(super) const DESCRIPTION: &str =
    "Manage custom agent definitions and agent organizations.\n\n\
     ## Required: `action` field\n\
     Every call MUST include an `action` field as the first key of the arguments object. There is no default. Calling without `action` fails with `missing field 'action'`.\n\n\
     Agent actions: list, get, create, update, remove.\n\
     Org actions: list_orgs, get_org, create_org, update_org, remove_org.\n\n\
     **Always use 'list' / 'list_orgs' first** before creating to avoid duplicates.\n\
     When creating agents, the tool checks for similar names and warns you.\n\
     When creating agents, use `tools` to restrict which built-in or MCP tools the agent can use.\n\
     Use `tools.excludedTools` to exclude specific tools, `tools.disabledMcpServers` to hide MCP servers, \
     or `tools.disabledMcpTools` to hide individual MCP tools. Leave `tools` empty to inherit everything.\n\n\
     ## Examples\n\
     - `{\"action\": \"list\"}`\n\
     - `{\"action\": \"get\", \"agent_id\": \"my-agent\"}`\n\
     - `{\"action\": \"create\", \"name\": \"Reviewer\", \"description\": \"Reviews PRs\"}`\n\
     - `{\"action\": \"list_orgs\"}`\n\
     - `{\"action\": \"create_org\", \"name\": \"Product\", \"role\": \"PM\"}`";

pub(super) fn parameters_schema() -> Value {
    let agent_props = json!({
        "action": {
            "type": "string",
            "description": "The operation to perform.",
            "enum": ["list", "get", "create", "update", "remove",
                     "list_orgs", "get_org", "create_org", "update_org", "remove_org"]
        },
        "agent_id": { "type": "string", "description": "Agent ID (required for get, update, remove)" },
        "org_id": { "type": "string", "description": "Org ID (required for get_org, update_org, remove_org)" },
        "name": { "type": "string", "description": "Agent or org name (required for create / create_org)" },
        "role": { "type": "string", "description": "Org leader role (for create_org / update_org)" },
        "description": { "type": "string", "description": "Agent or org description" },
        "instructions": { "type": "string", "description": "Coordinator operating instructions (for create_org / update_org)" },
        "soul_content": { "type": "string", "description": "System prompt / soul content" },
        "temperature": { "type": "number", "description": "LLM temperature (0.0-1.0)" },
        "max_tokens": { "type": "integer", "description": "Max output tokens per response" },
        "context_window": { "type": "integer", "description": "Context window size" }
    });

    let tools_schema = json!({
        "type": "object",
        "description": "Per-agent tool selection. Empty = inherit everything.",
        "properties": {
            "excludedTools": {
                "type": "array",
                "items": { "type": "string" },
                "description": "Built-in tool names to exclude from this agent"
            },
            "disabledMcpServers": {
                "type": "array",
                "items": { "type": "string" },
                "description": "MCP server names to hide entirely"
            },
            "disabledMcpTools": {
                "type": "array",
                "items": { "type": "string" },
                "description": "Individual MCP tool names in `mcp__<server>__<tool>` form to hide"
            }
        }
    });

    let skills_config_schema = json!({
        "type": "object",
        "description": "Per-agent skills config. Overrides global skills_enabled / disabled_skills.",
        "properties": {
            "enabled": { "type": "boolean", "description": "Override global skills_enabled (null = inherit)" },
            "include": { "type": "array", "items": { "type": "string" }, "description": "Whitelist: only load these skill names (empty = all)" },
            "exclude": { "type": "array", "items": { "type": "string" }, "description": "Blacklist: additional skills to disable" }
        }
    });

    let extra_props = json!({
        "sub_agents": {
            "type": "array",
            "items": { "type": "object", "properties": { "agent_id": { "type": "string" } }, "required": ["agent_id"] },
            "description": "Sub-agent references"
        },
        "tools": tools_schema,
        "skills_config": skills_config_schema
    });

    let members_prop = json!({
        "members": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": { "type": "string" },
                    "role": { "type": "string" },
                    "agent_id": { "type": "string" },
                    "instructions": { "type": "string", "description": "Operating instructions used only for this member" },
                    "children": { "type": "array", "items": { "type": "object" } }
                },
                "required": ["name"]
            },
            "description": "Org team members"
        }
    });

    let mut props = agent_props.as_object().cloned().unwrap_or_default();
    if let Some(extra) = extra_props.as_object() {
        props.extend(extra.clone());
    }
    if let Some(members) = members_prop.as_object() {
        props.extend(members.clone());
    }

    json!({
        "type": "object",
        "properties": props,
        "required": ["action"]
    })
}

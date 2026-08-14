//! Agent definition management tool for all agents.
//!
//! Lets agents list, inspect, create, update, and remove custom agents
//! stored in `~/.orgii/agent-definitions.json`, and manage agent organizations.
//!
//! The implementation is split into per-action modules:
//!
//! | Submodule       | Responsibility                                        |
//! |-----------------|-------------------------------------------------------|
//! | `schema`        | Tool description + JSON Schema                        |
//! | `agent_actions` | `list`, `get`, `create`, `update`, `remove`           |
//! | `org_actions`   | Org CRUD (`list_orgs`, `get_org`, `create_org`, ...)  |
//! | `formatting`    | Markdown rendering of agents and orgs                 |
//! | `parsing`       | Helpers for sub-agents / org members / name matching  |

mod agent_actions;
mod formatting;
mod org_actions;
mod parsing;
mod schema;

use async_trait::async_trait;
use serde_json::Value;
use tauri::Manager;

use crate::definitions::orgs::AgentOrgsStore;
use crate::definitions::AgentDefinitionsStore;
use crate::tools::names as tool_names;
use crate::tools::traits::{required_string, Tool, ToolError};

/// Agent definition management tool.
pub struct AgentDefinitionTool {
    app_handle: tauri::AppHandle,
}

impl AgentDefinitionTool {
    pub fn new(app_handle: tauri::AppHandle) -> Self {
        Self { app_handle }
    }

    fn store(&self) -> &AgentDefinitionsStore {
        self.app_handle
            .state::<std::sync::Arc<AgentDefinitionsStore>>()
            .inner()
    }

    fn org_store(&self) -> std::sync::Arc<AgentOrgsStore> {
        self.app_handle
            .state::<std::sync::Arc<AgentOrgsStore>>()
            .inner()
            .clone()
    }
}

#[async_trait]
impl Tool for AgentDefinitionTool {
    fn name(&self) -> &str {
        tool_names::MANAGE_AGENT_DEF
    }

    fn category(&self) -> &str {
        crate::tools::categories::AGENT
    }

    fn description(&self) -> &str {
        schema::DESCRIPTION
    }

    fn parameters(&self) -> Value {
        schema::parameters_schema()
    }

    async fn execute_text(
        &self,
        params: Value,
        _ctx: &crate::tools::traits::CallContext,
    ) -> Result<String, ToolError> {
        let action = required_string(&params, "action")?;

        match action.as_str() {
            "list" => agent_actions::list_agents(self.store()),
            "get" => agent_actions::get_agent(self.store(), &params),
            "create" => agent_actions::create_agent(self.store(), &params),
            "update" => agent_actions::update_agent(self.store(), &params),
            "remove" => agent_actions::remove_agent(self.store(), &params),

            "list_orgs" => org_actions::list_orgs(&self.org_store()),
            "get_org" => org_actions::get_org(&self.org_store(), &params),
            "create_org" => org_actions::create_org(&self.org_store(), &params).await,
            "update_org" => org_actions::update_org(&self.org_store(), &params).await,
            "remove_org" => org_actions::remove_org(&self.org_store(), &params).await,

            _ => Err(ToolError::InvalidParams(format!(
                "Unknown action: '{}'. Valid: list, get, create, update, remove, \
                 list_orgs, get_org, create_org, update_org, remove_org",
                action
            ))),
        }
    }
}

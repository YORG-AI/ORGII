//! Project-level CRUD action handlers (`list`, `read`, `create`, `update`,
//! `delete`).

use serde_json::Value;

use crate::tools::traits::{optional_string, required_string, ToolError};

use super::params::optional_string_array;

pub(super) async fn list() -> Result<String, ToolError> {
    crate::tool_infra::list_projects()
        .await
        .map_err(ToolError::ExecutionFailed)
}

pub(super) async fn read(slug: &str) -> Result<String, ToolError> {
    crate::tool_infra::read_project(slug)
        .await
        .map_err(ToolError::ExecutionFailed)
}

pub(super) async fn create(
    params: &Value,
    default_org_id: Option<&str>,
) -> Result<String, ToolError> {
    let name = required_string(params, "name")?;
    let description = optional_string(params, "description").unwrap_or_default();
    let org_id = optional_string(params, "project_org_id")
        .filter(|value| !value.trim().is_empty())
        .or_else(|| default_org_id.map(String::from));
    let status = optional_string(params, "status");
    let priority = optional_string(params, "priority");
    let health = optional_string(params, "health");
    let lead = optional_string(params, "lead");
    let members = optional_string_array(params, "members");
    let labels = optional_string_array(params, "labels");
    let linked_repos = optional_string_array(params, "linked_repos");
    let start_date = optional_string(params, "start_date");
    let target_date = optional_string(params, "target_date");

    crate::tool_infra::create_project(
        &name,
        &description,
        org_id.as_deref(),
        status.as_deref(),
        priority.as_deref(),
        health.as_deref(),
        lead.as_deref(),
        members,
        labels,
        linked_repos,
        start_date.as_deref(),
        target_date.as_deref(),
    )
    .await
    .map_err(ToolError::ExecutionFailed)
}

pub(super) async fn update(slug: &str, params: &Value) -> Result<String, ToolError> {
    let name = optional_string(params, "name");
    let description = optional_string(params, "description");
    let status = optional_string(params, "status");
    let priority = optional_string(params, "priority");
    let health = optional_string(params, "health");
    let lead = optional_string(params, "lead");
    let members = optional_string_array(params, "members");
    let labels = optional_string_array(params, "labels");
    let linked_repos = optional_string_array(params, "linked_repos");
    let start_date = optional_string(params, "start_date");
    let target_date = optional_string(params, "target_date");

    crate::tool_infra::update_project(
        slug,
        name.as_deref(),
        description.as_deref(),
        status.as_deref(),
        priority.as_deref(),
        health.as_deref(),
        lead.as_deref(),
        members,
        labels,
        linked_repos,
        start_date.as_deref(),
        target_date.as_deref(),
    )
    .await
    .map_err(ToolError::ExecutionFailed)
}

pub(super) async fn delete(slug: &str) -> Result<String, ToolError> {
    crate::tool_infra::delete_project(slug)
        .await
        .map_err(ToolError::ExecutionFailed)
}

//! CRUD handlers for `OrgDefinition` entries (agent organizations).

use serde_json::Value;
use uuid::Uuid;

use crate::definitions::orgs::{AgentOrgsStore, OrgDefinition};
use crate::tools::traits::{optional_string, required_string, ToolError};

use super::formatting::{format_org_detail, format_org_summary};
use super::parsing::parse_org_members;

pub(super) fn list_orgs(store: &AgentOrgsStore) -> Result<String, ToolError> {
    let orgs = store
        .orgs
        .lock()
        .map_err(|err| ToolError::ExecutionFailed(format!("Lock error: {}", err)))?;

    if orgs.is_empty() {
        return Ok("No agent organizations defined. Use 'create_org' to add one.".to_string());
    }

    let mut out = format!("Found {} org(s):\n\n", orgs.len());
    for org in orgs.iter() {
        out.push_str(&format_org_summary(org));
        out.push('\n');
    }
    Ok(out)
}

pub(super) fn get_org(store: &AgentOrgsStore, params: &Value) -> Result<String, ToolError> {
    let org_id = required_string(params, "org_id")?;
    let orgs = store
        .orgs
        .lock()
        .map_err(|err| ToolError::ExecutionFailed(format!("Lock error: {}", err)))?;

    let org = orgs
        .iter()
        .find(|o| o.id == org_id)
        .ok_or_else(|| ToolError::ExecutionFailed(format!("Org '{}' not found", org_id)))?;

    Ok(format_org_detail(org))
}

pub(super) fn create_org(store: &AgentOrgsStore, params: &Value) -> Result<String, ToolError> {
    let name = required_string(params, "name")?;
    let description = optional_string(params, "description");
    let instructions = optional_string(params, "instructions");
    let role = optional_string(params, "role").unwrap_or_else(|| "leader".to_string());
    let leader_agent_id = optional_string(params, "agent_id").unwrap_or_default();
    let children = parse_org_members(params);

    let orgs = store
        .orgs
        .lock()
        .map_err(|err| ToolError::ExecutionFailed(format!("Lock error: {}", err)))?;

    if orgs
        .iter()
        .any(|o| o.name.to_lowercase() == name.to_lowercase())
    {
        return Err(ToolError::ExecutionFailed(format!(
            "An org named '{}' already exists. Use 'update_org' to modify it.",
            name
        )));
    }

    drop(orgs);
    let new_id = Uuid::new_v4().to_string();
    let org = OrgDefinition {
        id: new_id.clone(),
        name: name.clone(),
        role,
        agent_id: leader_agent_id,
        description,
        instructions,
        hierarchy_mode: Default::default(),
        plan_approval_policy: Default::default(),
        children,
    };

    store.insert(org).map_err(ToolError::ExecutionFailed)?;

    Ok(format!("Created org '{}' with id `{}`.", name, new_id))
}

pub(super) fn update_org(store: &AgentOrgsStore, params: &Value) -> Result<String, ToolError> {
    let org_id = required_string(params, "org_id")?;

    let mut orgs = store
        .orgs
        .lock()
        .map_err(|err| ToolError::ExecutionFailed(format!("Lock error: {}", err)))?;

    let org = orgs
        .iter_mut()
        .find(|o| o.id == org_id)
        .ok_or_else(|| ToolError::ExecutionFailed(format!("Org '{}' not found", org_id)))?;

    if let Some(name) = optional_string(params, "name") {
        org.name = name;
    }
    if let Some(desc) = optional_string(params, "description") {
        org.description = Some(desc);
    }
    if let Some(instructions) = optional_string(params, "instructions") {
        org.instructions = Some(instructions);
    }
    if let Some(role) = optional_string(params, "role") {
        org.role = role;
    }
    if let Some(agent_id) = optional_string(params, "agent_id") {
        org.agent_id = agent_id;
    }
    if params.get("members").is_some() {
        org.children = parse_org_members(params);
    }

    let name = org.name.clone();
    let updated = org.clone();
    drop(orgs);
    store.replace(updated).map_err(ToolError::ExecutionFailed)?;

    Ok(format!("Updated org '{}'.", name))
}

pub(super) fn remove_org(store: &AgentOrgsStore, params: &Value) -> Result<String, ToolError> {
    let org_id = required_string(params, "org_id")?;

    let orgs = store
        .orgs
        .lock()
        .map_err(|err| ToolError::ExecutionFailed(format!("Lock error: {}", err)))?;

    let removed_name = orgs.iter().find(|o| o.id == org_id).map(|o| o.name.clone());
    drop(orgs);
    let removed = store.remove(&org_id).map_err(ToolError::ExecutionFailed)?;

    if removed {
        Ok(format!("Removed org '{}'.", removed_name.unwrap_or(org_id)))
    } else {
        Err(ToolError::ExecutionFailed(format!(
            "Org '{}' not found",
            org_id
        )))
    }
}

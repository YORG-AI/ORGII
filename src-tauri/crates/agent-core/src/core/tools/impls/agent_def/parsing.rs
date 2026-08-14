//! Parsing helpers for agent definitions and org members.

use serde_json::Value;
use uuid::Uuid;

use crate::definitions::orgs::FlatOrgMember;
use crate::definitions::SubAgentRef;

pub fn parse_sub_agents(params: &Value) -> Option<Vec<SubAgentRef>> {
    params.get("sub_agents").and_then(|val| {
        val.as_array().map(|arr| {
            arr.iter()
                .filter_map(|item| {
                    let agent_id = item.get("agent_id")?.as_str()?.to_string();
                    Some(SubAgentRef {
                        agent_id,
                        isolation: None,
                    })
                })
                .collect()
        })
    })
}

/// Parse the `members` array of a create/update org call.
///
/// Malformed entries are hard, structured errors — never silently dropped.
/// A silently dropped member used to cascade into Writer-grant and
/// communication-link removal on update, i.e. silent data destruction.
pub fn parse_org_members(
    params: &Value,
    accept_existing_ids: bool,
) -> Result<Vec<FlatOrgMember>, String> {
    let Some(members_value) = params.get("members") else {
        return Ok(Vec::new());
    };
    let Some(entries) = members_value.as_array() else {
        return Err("'members' must be an array of member objects".to_string());
    };
    entries
        .iter()
        .enumerate()
        .map(|(index, member)| parse_single_member(member, index, accept_existing_ids))
        .collect()
}

fn parse_single_member(
    val: &Value,
    index: usize,
    accept_existing_id: bool,
) -> Result<FlatOrgMember, String> {
    let Some(entry) = val.as_object() else {
        return Err(format!(
            "members[{index}] must be an object with at least a 'name' field"
        ));
    };
    let name = match entry.get("name").map(|value| value.as_str()) {
        Some(Some(name)) if !name.trim().is_empty() => name.to_string(),
        Some(Some(_)) => {
            return Err(format!("members[{index}] has an empty 'name'"));
        }
        Some(None) => {
            return Err(format!("members[{index}] field 'name' must be a string"));
        }
        None => {
            return Err(format!(
                "members[{index}] is missing the required 'name' field"
            ));
        }
    };
    let role = match entry.get("role") {
        None => "member".to_string(),
        Some(value) => value
            .as_str()
            .ok_or_else(|| format!("members[{index}] ('{name}') field 'role' must be a string"))?
            .to_string(),
    };
    let agent_id = match entry.get("agent_id") {
        None => String::new(),
        Some(value) => value
            .as_str()
            .ok_or_else(|| {
                format!("members[{index}] ('{name}') field 'agent_id' must be a string")
            })?
            .to_string(),
    };
    let member_id = if accept_existing_id {
        match entry.get("member_id") {
            None => Uuid::new_v4().to_string(),
            Some(value) => {
                let member_id = value.as_str().ok_or_else(|| {
                    format!(
                        "members[{index}] ('{name}') field 'member_id' must be a string"
                    )
                })?;
                if member_id.is_empty() {
                    return Err(format!(
                        "members[{index}] ('{name}') has an empty 'member_id'"
                    ));
                }
                if member_id.trim() != member_id {
                    return Err(format!(
                        "members[{index}] ('{name}') field 'member_id' must not have leading or trailing whitespace"
                    ));
                }
                member_id.to_string()
            }
        }
    } else {
        Uuid::new_v4().to_string()
    };
    Ok(FlatOrgMember {
        member_id,
        name,
        role,
        agent_id,
        runtime_config: None,
    })
}

/// Fuzzy name match: case-insensitive containment in either direction.
pub fn names_similar(name_a: &str, name_b: &str) -> bool {
    let lower_a = name_a.to_lowercase();
    let lower_b = name_b.to_lowercase();
    lower_a == lower_b || lower_a.contains(&lower_b) || lower_b.contains(&lower_a)
}

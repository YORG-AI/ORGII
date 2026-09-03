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

pub fn parse_org_members(params: &Value, accept_existing_ids: bool) -> Vec<FlatOrgMember> {
    params
        .get("members")
        .and_then(|val| val.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|member| parse_single_member(member, accept_existing_ids))
                .collect()
        })
        .unwrap_or_default()
}

fn parse_single_member(val: &Value, accept_existing_id: bool) -> Option<FlatOrgMember> {
    let name = val.get("name")?.as_str()?.to_string();
    let role = val
        .get("role")
        .and_then(|v| v.as_str())
        .unwrap_or("member")
        .to_string();
    let agent_id = val
        .get("agent_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let member_id = accept_existing_id
        .then(|| val.get("member_id").and_then(|value| value.as_str()))
        .flatten()
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    Some(FlatOrgMember {
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

//! CRUD handlers for `OrgDefinition` entries (agent organizations).
//!
//! Mutating actions are async and go through the store's `*_async`
//! wrappers (the single `spawn_blocking` owner) so fsync-under-mutex
//! store commits never run on the async executor.

use std::sync::Arc;

use serde_json::Value;
use uuid::Uuid;

use crate::definitions::orgs::{
    all_member_links, AgentOrgsStore, MemberCommunicationLink, OrgDefinition,
};
use crate::tools::traits::{optional_string, required_string, ToolError};

use super::formatting::{format_org_detail, format_org_summary};
use super::parsing::parse_org_members;

pub(super) fn list_orgs(store: &AgentOrgsStore) -> Result<String, ToolError> {
    let orgs = store.list().map_err(ToolError::ExecutionFailed)?;

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
    let org = store.get(&org_id).map_err(ToolError::ExecutionFailed)?;

    Ok(format_org_detail(&org))
}

pub(super) async fn create_org(
    store: &Arc<AgentOrgsStore>,
    params: &Value,
) -> Result<String, ToolError> {
    let name = required_string(params, "name")?;
    let description = optional_string(params, "description");
    let role = optional_string(params, "role").unwrap_or_else(|| "leader".to_string());
    let leader_agent_id = optional_string(params, "agent_id").unwrap_or_default();
    // Model-authored create input never controls stable identities.
    let members = parse_org_members(params, false).map_err(ToolError::InvalidParams)?;
    let orgs = store.list().map_err(ToolError::ExecutionFailed)?;

    if orgs
        .iter()
        .any(|o| o.name.to_lowercase() == name.to_lowercase())
    {
        return Err(ToolError::ExecutionFailed(format!(
            "An org named '{}' already exists. Use 'update_org' to modify it.",
            name
        )));
    }

    let new_id = Uuid::new_v4().to_string();
    let mut org = OrgDefinition {
        id: new_id.clone(),
        name: name.clone(),
        role,
        agent_id: leader_agent_id,
        description,
        plan_approval_policy: Default::default(),
        members,
        additional_task_graph_writer_member_ids: Vec::new(),
        member_communication_links: Vec::new(),
    };
    org.member_communication_links = all_member_links(&org.members);

    store
        .insert_async(org)
        .await
        .map_err(ToolError::ExecutionFailed)?;

    Ok(format!("Created org '{}' with id `{}`.", name, new_id))
}

pub(super) async fn update_org(
    store: &Arc<AgentOrgsStore>,
    params: &Value,
) -> Result<String, ToolError> {
    let org_id = required_string(params, "org_id")?;

    let mut org = store.get(&org_id).map_err(ToolError::ExecutionFailed)?;

    if let Some(name) = optional_string(params, "name") {
        org.name = name;
    }
    if let Some(desc) = optional_string(params, "description") {
        org.description = Some(desc);
    }
    if let Some(role) = optional_string(params, "role") {
        org.role = role;
    }
    if let Some(agent_id) = optional_string(params, "agent_id") {
        org.agent_id = agent_id;
    }
    if params.get("members").is_some() {
        let requested_member_ids = params
            .get("members")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|member| member.get("member_id").and_then(Value::as_str))
            .collect::<Vec<_>>();
        let existing_ids = org
            .members
            .iter()
            .map(|member| member.member_id.as_str())
            .collect::<std::collections::HashSet<_>>();
        if let Some(unknown_id) = requested_member_ids
            .iter()
            .find(|member_id| !existing_ids.contains(**member_id))
        {
            return Err(ToolError::ExecutionFailed(format!(
                "Org '{}' has no existing member id '{}'",
                org_id, unknown_id
            )));
        }
        let mut new_members = parse_org_members(params, true).map_err(ToolError::InvalidParams)?;
        // Model updates never carry runtime configuration; surviving members
        // keep whatever runtime_config the user persisted for them.
        for member in new_members.iter_mut() {
            if let Some(existing) = org
                .members
                .iter()
                .find(|existing| existing.member_id == member.member_id)
            {
                member.runtime_config = existing.runtime_config.clone();
            }
        }
        let retained_ids = new_members
            .iter()
            .filter(|member| existing_ids.contains(member.member_id.as_str()))
            .map(|member| member.member_id.clone())
            .collect::<std::collections::HashSet<_>>();
        let new_ids = new_members
            .iter()
            .filter(|member| !existing_ids.contains(member.member_id.as_str()))
            .map(|member| member.member_id.clone())
            .collect::<std::collections::HashSet<_>>();
        org.additional_task_graph_writer_member_ids
            .retain(|member_id| retained_ids.contains(member_id));
        let existing_links = org
            .member_communication_links
            .iter()
            .map(|link| {
                let link = MemberCommunicationLink::canonical(
                    link.member_a_id.clone(),
                    link.member_b_id.clone(),
                );
                (link.member_a_id, link.member_b_id)
            })
            .collect::<std::collections::HashSet<_>>();
        org.member_communication_links = all_member_links(&new_members)
            .into_iter()
            .filter(|link| {
                new_ids.contains(&link.member_a_id)
                    || new_ids.contains(&link.member_b_id)
                    || existing_links
                        .contains(&(link.member_a_id.clone(), link.member_b_id.clone()))
            })
            .collect();
        org.members = new_members;
    }

    let name = org.name.clone();
    store
        .replace_async(org)
        .await
        .map_err(ToolError::ExecutionFailed)?;

    Ok(format!("Updated org '{}'.", name))
}

pub(super) async fn remove_org(
    store: &Arc<AgentOrgsStore>,
    params: &Value,
) -> Result<String, ToolError> {
    let org_id = required_string(params, "org_id")?;

    let removed_name = store.get(&org_id).ok().map(|org| org.name);
    let removed = store
        .remove_async(org_id.clone())
        .await
        .map_err(ToolError::ExecutionFailed)?;

    if removed {
        Ok(format!("Removed org '{}'.", removed_name.unwrap_or(org_id)))
    } else {
        Err(ToolError::ExecutionFailed(format!(
            "Org '{}' not found",
            org_id
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::definitions::builtin::SDE_AGENT_ID;
    use crate::definitions::orgs::{OrgMemberRuntimeConfig, PlanApprovalPolicy};
    use serde_json::json;

    #[tokio::test]
    async fn model_create_generates_stable_ids_and_explicit_default_links() {
        let _sandbox = test_helpers::test_env::sandbox();
        let store = Arc::new(AgentOrgsStore::new());
        create_org(
            &store,
            &json!({
                "name": "Model Created Team",
                "agent_id": SDE_AGENT_ID,
                "members": [
                    {"member_id": "model-controlled-a", "name": "Alice", "agent_id": SDE_AGENT_ID},
                    {"member_id": "model-controlled-b", "name": "Bob", "agent_id": SDE_AGENT_ID},
                    {"member_id": "model-controlled-c", "name": "Carol", "agent_id": SDE_AGENT_ID}
                ]
            }),
        )
        .await
        .expect("create Team");

        let org = store
            .list()
            .expect("list Teams")
            .into_iter()
            .find(|org| org.name == "Model Created Team")
            .expect("created Team");
        assert_eq!(org.members.len(), 3);
        assert_eq!(org.member_communication_links.len(), 3);
        assert!(org.additional_task_graph_writer_member_ids.is_empty());
        assert!(org
            .members
            .iter()
            .all(|member| !member.member_id.starts_with("model-controlled")));
    }

    #[tokio::test]
    async fn model_update_preserves_survivor_policy_and_connects_new_members() {
        let _sandbox = test_helpers::test_env::sandbox();
        let store = Arc::new(AgentOrgsStore::new());
        create_org(
            &store,
            &json!({
                "name": "Model Updated Team",
                "agent_id": SDE_AGENT_ID,
                "members": [
                    {"name": "Alice", "agent_id": SDE_AGENT_ID},
                    {"name": "Bob", "agent_id": SDE_AGENT_ID}
                ]
            }),
        )
        .await
        .expect("create Team");
        let mut original = store
            .list()
            .expect("list Teams")
            .into_iter()
            .find(|org| org.name == "Model Updated Team")
            .expect("created Team");
        let alice_id = original.members[0].member_id.clone();
        let bob_id = original.members[1].member_id.clone();
        original.plan_approval_policy = PlanApprovalPolicy::User;
        original.additional_task_graph_writer_member_ids = vec![alice_id.clone(), bob_id.clone()];
        original.member_communication_links.clear();
        original.members[0].runtime_config = Some(OrgMemberRuntimeConfig {
            model: Some("user-pinned-model".to_string()),
            ..Default::default()
        });
        store.replace(original.clone()).expect("seed user policy");

        update_org(
            &store,
            &json!({
                "org_id": original.id,
                "members": [
                    {"member_id": alice_id, "name": "Alice Renamed", "role": "Builder", "agent_id": SDE_AGENT_ID},
                    {"name": "Carol", "role": "Reviewer", "agent_id": SDE_AGENT_ID}
                ]
            }),
        )
        .await
        .expect("update Team");

        let updated = store.get(&original.id).expect("updated Team");
        assert_eq!(updated.plan_approval_policy, PlanApprovalPolicy::User);
        assert_eq!(updated.members[0].member_id, alice_id);
        assert_ne!(updated.members[1].member_id, bob_id);
        assert_eq!(
            updated.members[0]
                .runtime_config
                .as_ref()
                .and_then(|config| config.model.as_deref()),
            Some("user-pinned-model"),
            "surviving member keeps persisted runtime_config through a model update"
        );
        assert!(updated.members[1].runtime_config.is_none());
        assert_eq!(
            updated.additional_task_graph_writer_member_ids,
            vec![alice_id.clone()]
        );
        assert_eq!(
            updated.member_communication_links,
            vec![MemberCommunicationLink::canonical(
                alice_id,
                updated.members[1].member_id.clone()
            )]
        );
    }

    #[tokio::test]
    async fn model_update_rejects_malformed_member_entries_instead_of_dropping_them() {
        let _sandbox = test_helpers::test_env::sandbox();
        let store = Arc::new(AgentOrgsStore::new());
        create_org(
            &store,
            &json!({
                "name": "Malformed Update Team",
                "agent_id": SDE_AGENT_ID,
                "members": [
                    {"name": "Alice", "agent_id": SDE_AGENT_ID},
                    {"name": "Bob", "agent_id": SDE_AGENT_ID}
                ]
            }),
        )
        .await
        .expect("create Team");
        let original = store
            .list()
            .expect("list Teams")
            .into_iter()
            .find(|org| org.name == "Malformed Update Team")
            .expect("created Team");
        let alice_id = original.members[0].member_id.clone();

        // members[1] lacks 'name' — previously it was silently dropped,
        // deleting Bob and cascading into grant/link removal.
        let err = update_org(
            &store,
            &json!({
                "org_id": original.id,
                "members": [
                    {"member_id": alice_id, "name": "Alice", "agent_id": SDE_AGENT_ID},
                    {"role": "Reviewer", "agent_id": SDE_AGENT_ID}
                ]
            }),
        )
        .await
        .expect_err("malformed member entry must be rejected");
        let message = err.to_string();
        assert!(
            message.contains("members[1]") && message.contains("name"),
            "error must name the malformed entry index and field: {message}"
        );

        // Non-string field types are structured errors too.
        let err = update_org(
            &store,
            &json!({
                "org_id": original.id,
                "members": [
                    {"name": "Alice", "role": 7, "agent_id": SDE_AGENT_ID}
                ]
            }),
        )
        .await
        .expect_err("non-string role must be rejected");
        assert!(err.to_string().contains("members[0]"));

        for invalid_member_id in [json!(7), json!(""), json!(" alice ")] {
            let err = update_org(
                &store,
                &json!({
                    "org_id": original.id,
                    "members": [
                        {
                            "member_id": invalid_member_id,
                            "name": "Alice",
                            "agent_id": SDE_AGENT_ID
                        }
                    ]
                }),
            )
            .expect_err("malformed member_id must be rejected instead of replaced");
            let message = err.to_string();
            assert!(
                message.contains("members[0]") && message.contains("member_id"),
                "error must name the malformed member_id: {message}"
            );
        }

        // The org is unchanged after the rejected updates.
        let unchanged = store.get(&original.id).expect("org still present");
        assert_eq!(unchanged.members.len(), 2);

        // create_org rejects malformed entries the same way.
        let err = create_org(
            &store,
            &json!({
                "name": "Another Team",
                "agent_id": SDE_AGENT_ID,
                "members": [{"agent_id": SDE_AGENT_ID}]
            }),
        )
        .await
        .expect_err("malformed member entry must be rejected on create");
        assert!(err.to_string().contains("members[0]"));
    }
}

use std::path::{Path, PathBuf};

use crate::definitions::{AgentDefinition, SubAgentRef};
use crate::session::persistence as session_persistence;
use crate::state::AgentAppState;
use core_types::providers::NativeHarnessType;

#[derive(Debug, Clone)]
pub struct AgentLaunchSpec {
    pub session_id: String,
    pub definition: AgentDefinition,
    pub workspace: PathBuf,
    pub account_id: Option<String>,
    pub model_override: Option<String>,
    pub native_harness_type: Option<NativeHarnessType>,
    pub agent_org_run_hint: Option<String>,
}

impl AgentLaunchSpec {
    pub fn new(
        session_id: impl Into<String>,
        definition: AgentDefinition,
        workspace: PathBuf,
        account_id: Option<String>,
        model_override: Option<String>,
        native_harness_type: Option<NativeHarnessType>,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            definition,
            workspace,
            account_id,
            model_override: model_override.filter(|model| !model.is_empty()),
            native_harness_type,
            agent_org_run_hint: None,
        }
    }

    pub fn with_agent_org_run_hint(mut self, run_id: Option<String>) -> Self {
        self.agent_org_run_hint = run_id.filter(|value| !value.is_empty());
        self
    }

    pub async fn from_session_sources(
        state: &AgentAppState,
        session_id: &str,
        workspace: PathBuf,
        account_id: Option<String>,
        model_override: Option<String>,
        native_harness_type: Option<NativeHarnessType>,
    ) -> Result<Self, String> {
        let definition = resolve_definition_for_launch(state, session_id).await?;
        Ok(Self::new(
            session_id,
            definition,
            workspace,
            account_id,
            model_override,
            native_harness_type,
        ))
    }

    pub async fn registered_session(
        state: &AgentAppState,
        session_id: &str,
        workspace: PathBuf,
        account_id: Option<String>,
        model_override: Option<String>,
        native_harness_type: Option<NativeHarnessType>,
    ) -> Result<Self, String> {
        let session = state
            .get_session(session_id)
            .await
            .ok_or_else(|| format!("channel session '{}' not registered", session_id))?;
        Ok(Self::new(
            session_id,
            session.definition.clone(),
            workspace,
            account_id,
            model_override,
            native_harness_type,
        ))
    }

    pub async fn workspace_session(
        state: &AgentAppState,
        session_id: &str,
        model: &str,
        account_id: Option<&str>,
        workspace_path: &Path,
    ) -> Result<Self, String> {
        Self::from_session_sources(
            state,
            session_id,
            workspace_path.to_path_buf(),
            account_id.map(str::to_string),
            Some(model.to_string()),
            None,
        )
        .await
    }

    pub async fn work_item_session(
        state: &AgentAppState,
        session_id: &str,
        model: &str,
        account_id: &str,
        workspace: PathBuf,
        agent_definition_id: Option<&str>,
        sub_agent_ids: &[String],
    ) -> Result<Self, String> {
        let mut definition =
            resolve_definition_from_id_or_session(state, session_id, agent_definition_id).await?;
        apply_sub_agent_override(&mut definition, sub_agent_ids);
        Ok(Self::new(
            session_id,
            definition,
            workspace,
            Some(account_id.to_string()),
            Some(model.to_string()),
            None,
        ))
    }
}

async fn resolve_definition_from_id_or_session(
    state: &AgentAppState,
    session_id: &str,
    agent_definition_id: Option<&str>,
) -> Result<AgentDefinition, String> {
    if let Some(definition_id) = agent_definition_id.filter(|id| !id.is_empty()) {
        let store = crate::definitions::definitions_store();
        return store.get(definition_id).ok_or_else(|| {
            format!(
                "work-item session '{}' references missing agent_definition_id '{}'",
                session_id, definition_id
            )
        });
    }
    resolve_definition_for_launch(state, session_id).await
}

async fn resolve_definition_for_launch(
    state: &AgentAppState,
    session_id: &str,
) -> Result<AgentDefinition, String> {
    if let Some(session) = state.get_session(session_id).await {
        return Ok(session.definition.clone());
    }

    if let Some(definition_id) = load_persisted_definition_id(session_id).await? {
        let store = crate::definitions::definitions_store();
        return store.get(&definition_id).ok_or_else(|| {
            format!(
                "session '{}' references missing persisted agent_definition_id '{}'",
                session_id, definition_id
            )
        });
    }

    // Last resort: prefix mapping. Custom agents share the sdeagent-/
    // osagent- prefixes, so reaching this branch for a custom agent
    // collapses its identity to a builtin — warn loudly so the missing
    // persisted agent_definition_id gets noticed.
    tracing::warn!(
        "[launch] session '{}' has no in-memory definition and no persisted \
         agent_definition_id; falling back to builtin prefix mapping",
        session_id
    );
    crate::definitions::prefix_lookup::definition_for_session_id(session_id).ok_or_else(|| {
        format!(
            "session '{}' has no persisted agent_definition_id and no builtin prefix mapping",
            session_id
        )
    })
}

async fn load_persisted_definition_id(session_id: &str) -> Result<Option<String>, String> {
    let session_id = session_id.to_string();
    tokio::task::spawn_blocking(move || {
        session_persistence::get_session(&session_id)
            .map(|record| record.and_then(|row| row.agent_definition_id))
    })
    .await
    .map_err(|err| format!("definition lookup task failed: {err}"))?
    .map_err(|err| format!("definition lookup DB failed: {err}"))
}

fn apply_sub_agent_override(definition: &mut AgentDefinition, sub_agent_ids: &[String]) {
    if sub_agent_ids.is_empty() {
        return;
    }

    let sub_agents: Vec<SubAgentRef> = sub_agent_ids
        .iter()
        .filter(|agent_id| !agent_id.is_empty())
        .map(|agent_id| SubAgentRef {
            agent_id: agent_id.clone(),
            isolation: None,
        })
        .collect();

    definition.sub_agents = Some(sub_agents);
}

#[cfg(test)]
mod tests {
    use super::apply_sub_agent_override;

    #[test]
    fn work_item_sub_agent_override_replaces_definition_sub_agents() {
        let mut definition = crate::definitions::sde_agent();
        let sub_agent_ids = vec!["builtin:review".to_string(), "custom:qa".to_string()];

        apply_sub_agent_override(&mut definition, &sub_agent_ids);

        let sub_agents = definition
            .sub_agents
            .expect("override should set sub agents");
        let ids: Vec<String> = sub_agents
            .into_iter()
            .map(|sub_agent| sub_agent.agent_id)
            .collect();
        assert_eq!(ids, sub_agent_ids);
    }

    #[test]
    fn empty_work_item_sub_agent_override_preserves_definition_sub_agents() {
        let mut definition = crate::definitions::os_agent();
        let original = definition.sub_agents.clone();
        let sub_agent_ids: Vec<String> = Vec::new();

        apply_sub_agent_override(&mut definition, &sub_agent_ids);

        assert_eq!(
            definition.sub_agents.as_ref().map(Vec::len),
            original.as_ref().map(Vec::len)
        );
    }

    #[test]
    fn work_item_override_is_visible_to_resolved_agent_sub_agents() {
        let mut definition = crate::definitions::sde_agent();
        let sub_agent_ids = vec!["custom:reviewer".to_string()];
        apply_sub_agent_override(&mut definition, &sub_agent_ids);
        definition.selected_model_id = Some("test/model".to_string());

        let overrides = crate::session::overrides::SessionOverrides::new(
            Some(std::path::PathBuf::from("/tmp/orgii-test-work-item")),
            None,
        );
        let resolved = crate::definitions::resolved::ResolvedAgent::resolve(
            &definition,
            Some(&crate::definitions::definitions_store()),
            &overrides,
        )
        .expect("work-item launch definition should resolve");

        let resolved_ids: Vec<String> = resolved
            .sub_agents
            .into_iter()
            .map(|sub_agent| sub_agent.agent_id)
            .collect();
        assert_eq!(resolved_ids, sub_agent_ids);
    }
}

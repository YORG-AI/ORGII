//! Agent Org decoration for directory rows.
//!
//! Marks the rows that are the root session of an Agent Org run with the org
//! icon, id, and display name.

use agent_core::coordination::agent_org_runs::{AgentOrgRunRecord, AgentOrgRunStore};
use agent_core::definitions::orgs::OrgDefinition;

use crate::agent_sessions::session_directory::types::SessionAggregateRecord;

const AGENT_ORG_ICON_ID: &str = "network";

fn agent_org_display_name(run: &AgentOrgRunRecord) -> String {
    run.org_snapshot_json
        .as_deref()
        .and_then(|json| serde_json::from_str::<OrgDefinition>(json).ok())
        .map(|org| org.name)
        .unwrap_or_else(|| run.org_id.clone())
}

pub(super) fn annotate_agent_org_root_rows(
    sessions: &mut [SessionAggregateRecord],
) -> Result<(), String> {
    let requested_root_ids = sessions
        .iter()
        .map(|session| session.session_id.clone())
        .collect::<Vec<_>>();
    if requested_root_ids.is_empty() {
        return Ok(());
    }
    let mut root_session_ids = std::collections::HashMap::new();
    for run in AgentOrgRunStore::list_runs_for_root_session_ids(&requested_root_ids)? {
        let Some(root_session_id) = run.root_session_id.clone() else {
            continue;
        };
        let org_name = agent_org_display_name(&run);
        root_session_ids
            .entry(root_session_id)
            .or_insert((run.org_id, org_name));
    }

    for session in sessions {
        if let Some((org_id, org_name)) = root_session_ids.get(&session.session_id) {
            session.agent_icon_id = Some(AGENT_ORG_ICON_ID.to_string());
            session.agent_org_id = Some(org_id.clone());
            session.agent_org_name = Some(org_name.clone());
        }
    }

    Ok(())
}

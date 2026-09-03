mod completion;
mod delete;
mod lifecycle;
mod queries;
mod quiescence;
mod session_lookup;
mod starting;
mod worker_sessions;

fn serialize_launch_snapshot(
    snapshot: &crate::definitions::orgs::AgentOrgLaunchSnapshot,
) -> Result<String, String> {
    crate::definitions::orgs::validate_launch_snapshot(snapshot)?;
    serde_json::to_string(snapshot)
        .map_err(|err| format!("failed to serialize Agent Org launch snapshot: {err}"))
}

pub struct AgentOrgRunStore;

use super::{coordinator_replay_profile, AgentOrgTurnToolProfile};

#[test]
fn summary_authority_lookup_failure_never_falls_back_to_coordinator_tools() {
    assert_eq!(
        coordinator_replay_profile(Err("database unavailable".to_string())),
        None
    );
    assert_eq!(
        coordinator_replay_profile(Ok(true)),
        Some(AgentOrgTurnToolProfile::SummaryOnly)
    );
    assert_eq!(
        coordinator_replay_profile(Ok(false)),
        Some(AgentOrgTurnToolProfile::CoordinatorOrchestration)
    );
}

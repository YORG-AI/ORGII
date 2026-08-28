use super::{is_terminal_final_summary_failure_for_run, should_keep_agent_org_intent_in_flight};

#[test]
fn ordinary_sde_failure_does_not_query_agent_org_summary_authority() {
    let _sandbox = test_helpers::test_env::sandbox();
    assert!(!is_terminal_final_summary_failure_for_run(
        None,
        "ordinary-sde-session",
        "ordinary-sde-turn",
    ));
}

#[test]
fn assistant_persistence_failure_keeps_only_nonterminal_agent_org_intent_in_flight() {
    let error = format!(
        "{} disk full",
        crate::core::session::turn::event_handler::AGENT_ORG_ASSISTANT_PERSISTENCE_ERROR_PREFIX
    );

    assert!(should_keep_agent_org_intent_in_flight(
        Some("run-1"),
        &error,
        false,
    ));
    assert!(!should_keep_agent_org_intent_in_flight(None, &error, false,));
    assert!(!should_keep_agent_org_intent_in_flight(
        Some("run-1"),
        "provider failed",
        false,
    ));
    assert!(!should_keep_agent_org_intent_in_flight(
        Some("run-1"),
        &error,
        true,
    ));
}

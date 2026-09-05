use super::is_terminal_final_summary_failure_for_run;

#[test]
fn ordinary_sde_failure_does_not_query_agent_org_summary_authority() {
    let _sandbox = test_helpers::test_env::sandbox();
    assert!(!is_terminal_final_summary_failure_for_run(
        None,
        "ordinary-sde-session",
        "ordinary-sde-turn",
    ));
}

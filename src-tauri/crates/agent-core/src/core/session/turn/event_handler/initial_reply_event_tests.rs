use super::{event_factory, EventHandlerConfig, UnifiedEventHandler};

#[test]
fn only_the_exact_initial_root_turn_gets_a_public_reply_marker() {
    let _sandbox = test_helpers::test_env::sandbox();
    let conn = database::db::get_connection().expect("initial reply fixture database");
    crate::coordination::init_agent_org_schemas(&conn).expect("Agent Org schema");
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO agent_org_runtime_runs(
             id,org_id,coordinator_agent_id,root_session_id,entry_mode,status,
             activation_generation,has_initial_work,created_at,updated_at
         ) VALUES ('run','org','coordinator','coordinator-session',
                   'standalone_session','running',1,1,?1,?1)",
        [&now],
    )
    .expect("seed run");
    conn.execute(
        "INSERT INTO agent_org_runtime_initial_inputs(
             org_run_id,turn_intent_id,message_id,content,payload_json,status,
             created_at,updated_at
         ) VALUES ('run','initial-turn','initial-message','Build it','{}',
                   'dispatched',?1,?1)",
        [&now],
    )
    .expect("seed initial input");

    let initial_handler = UnifiedEventHandler::new(EventHandlerConfig {
        agent_org_turn_intent_id: Some("initial-turn".to_string()),
        ..Default::default()
    });
    let mut initial_reply =
        event_factory::build_assistant_message_event("coordinator-session", "Accepted");
    assert!(initial_handler
        .attach_agent_org_assistant_authority("coordinator-session", &mut initial_reply));
    assert_eq!(
        initial_reply
            .result
            .pointer("/agent_org_initial_reply/message_id")
            .and_then(serde_json::Value::as_str),
        Some("initial-message")
    );
    assert_eq!(
        initial_reply
            .result
            .pointer("/agent_org_initial_reply/turn_intent_id")
            .and_then(serde_json::Value::as_str),
        Some("initial-turn")
    );

    let ordinary_handler = UnifiedEventHandler::new(EventHandlerConfig {
        agent_org_turn_intent_id: Some("ordinary-root-turn".to_string()),
        ..Default::default()
    });
    let mut ordinary_reply =
        event_factory::build_assistant_message_event("coordinator-session", "Internal update");
    assert!(ordinary_handler
        .attach_agent_org_assistant_authority("coordinator-session", &mut ordinary_reply));
    assert!(ordinary_reply
        .result
        .get("agent_org_initial_reply")
        .is_none());

    let mut wrong_session_reply =
        event_factory::build_assistant_message_event("member-session", "Not public");
    assert!(initial_handler
        .attach_agent_org_assistant_authority("member-session", &mut wrong_session_reply));
    assert!(wrong_session_reply
        .result
        .get("agent_org_initial_reply")
        .is_none());
}

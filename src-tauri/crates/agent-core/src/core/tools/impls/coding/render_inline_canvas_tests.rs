use super::{
    apply_canvas_revision_edits, canvas_acceptance, format_canvas_acceptance,
    load_materialized_canvas_args, load_validated_canvas_target, validate_canvas_payload,
    RenderInlineCanvasTool, ReviseInlineCanvasTool, MAX_CANVAS_REVISION_CHAIN_DEPTH,
};
use crate::tools::names as tool_names;
use crate::tools::traits::{CallContext, Tool, ToolError};
use rusqlite::{params, Connection};
use serde_json::json;

#[test]
fn acceptance_does_not_claim_visual_success() {
    let result = format_canvas_acceptance(
        tool_names::RENDER_INLINE_CANVAS,
        "html",
        42,
        "Prototype",
        "",
    );

    assert!(result.contains("accepted html content"));
    assert!(result.contains("visual output not verified"));
    assert!(!result.contains("rendered html content"));
}

#[test]
fn url_acceptance_does_not_claim_embedding_succeeded() {
    let result = format_canvas_acceptance(
        tool_names::RENDER_INLINE_CANVAS,
        "url",
        0,
        "Docs",
        "https://example.com",
    );

    assert!(result.contains("accepted url=\"https://example.com\""));
    assert!(result.contains("visual output not verified"));
    assert!(!result.contains("embedded url"));
}

#[test]
fn description_routes_interactive_sketches_to_stateful_react() {
    let tool = RenderInlineCanvasTool::new();
    let description = tool.description();

    assert!(description.contains("interactive sketches"));
    assert!(description.contains("multi-step flows"));
    assert!(description.contains("React.useState"));
    assert!(!description.contains("JSX is not transformed"));
    assert!(!description.contains("Hooks and ReactDOM APIs are not available"));
}

#[test]
fn creation_and_revision_have_distinct_identity_contracts() {
    let creation_schema = RenderInlineCanvasTool::new().parameters();
    let creation_properties = creation_schema["properties"]
        .as_object()
        .expect("render_inline_canvas properties");
    assert!(!creation_properties.contains_key("revises_event_id"));
    assert!(!creation_properties.contains_key("target_event_id"));

    let revision_schema = ReviseInlineCanvasTool::new().parameters();
    let revision_properties = revision_schema["properties"]
        .as_object()
        .expect("revise_inline_canvas properties");
    assert!(revision_properties.contains_key("target_event_id"));
    assert!(revision_properties.contains_key("edits"));
    assert!(revision_properties.contains_key("agent_steps"));
    assert_eq!(
        revision_schema["required"],
        json!(["target_event_id", "mode", "agent_steps"])
    );
    assert_eq!(revision_schema["additionalProperties"], false);
}

#[test]
fn compact_revision_acceptance_reports_edits_without_echoing_source() {
    let result = canvas_acceptance(
        tool_names::REVISE_INLINE_CANVAS,
        &json!({
            "target_event_id": "canvas-a",
            "mode": "react",
            "edits": [{"find": "Start", "replace": "Start setup"}]
        }),
        "call-revision",
    );

    assert!(result.contains("accepted 1 targeted source edit"));
    assert!(result.contains("visual output not verified"));
    assert!(!result.contains("Start setup"));
}

#[test]
fn acceptance_carries_the_canvas_event_id_for_later_revisions() {
    let result = canvas_acceptance(
        tool_names::RENDER_INLINE_CANVAS,
        &json!({"mode": "html", "content": "<div></div>"}),
        "call-1",
    );
    assert!(result.contains("event_id=\"tool-call-call-1\""));
    assert!(result.contains("target_event_id"));

    // Maintenance/test dispatches without a call id must not fabricate
    // a dangling event id.
    let without_call_id = canvas_acceptance(
        tool_names::RENDER_INLINE_CANVAS,
        &json!({"mode": "html", "content": "<div></div>"}),
        "",
    );
    assert!(!without_call_id.contains("event_id="));
}

#[test]
fn revision_description_requests_a_factual_visible_progress_update() {
    let tool = ReviseInlineCanvasTool::new();
    let description = tool.description();

    assert!(description.contains("user-visible update"));
    assert!(description.contains("do not expose private chain-of-thought"));
    assert!(description.contains("prefer edits"));
    assert!(description.contains("never a fixed template"));
    assert!(description.contains("user's language"));
    assert!(description.contains("Emit agent_steps before edits"));
}

#[test]
fn revision_requires_bounded_agent_generated_steps() {
    let missing = validate_canvas_payload(
        &json!({
            "target_event_id": "canvas-a",
            "mode": "react",
            "content": "function App() { return null; }"
        }),
        true,
    );
    assert!(matches!(
        missing,
        Err(ToolError::InvalidParams(message)) if message.contains("agent_steps")
    ));

    let whitespace = validate_canvas_payload(
        &json!({
            "target_event_id": "canvas-a",
            "mode": "react",
            "agent_steps": ["   "],
            "content": "function App() { return null; }"
        }),
        true,
    );
    assert!(matches!(
        whitespace,
        Err(ToolError::InvalidParams(message)) if message.contains("agent_steps[0]")
    ));

    assert!(validate_canvas_payload(
        &json!({
            "target_event_id": "canvas-a",
            "mode": "react",
            "agent_steps": ["替换按钮文案", "核对原有交互"],
            "content": "function App() { return null; }"
        }),
        true,
    )
    .is_ok());
}

#[test]
fn compact_edits_require_a_unique_match_by_default() {
    let ambiguous = apply_canvas_revision_edits(
        "Same Same",
        &[json!({"find": "Same", "replace": "Changed"})],
    );
    assert!(matches!(
        ambiguous,
        Err(ToolError::InvalidParams(message)) if message.contains("matched 2 times")
    ));

    let replaced = apply_canvas_revision_edits(
        "Same Same",
        &[json!({"find": "Same", "replace": "Changed", "all": true})],
    )
    .expect("replace-all edit");
    assert_eq!(replaced, "Changed Changed");
}

#[test]
fn materializes_compact_revision_chains_from_persisted_events() {
    let connection = Connection::open_in_memory().expect("in-memory database");
    connection
        .execute(
            "CREATE TABLE events (
                    id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    function_name TEXT,
                    args_json TEXT NOT NULL
                )",
            [],
        )
        .expect("events table");
    connection
        .execute(
            "INSERT INTO events (id, session_id, function_name, args_json) VALUES (?1, ?2, ?3, ?4)",
            params![
                "canvas-a",
                "session-a",
                tool_names::RENDER_INLINE_CANVAS,
                json!({"mode": "react", "content": "Start Keep"}).to_string()
            ],
        )
        .expect("base canvas");
    connection
        .execute(
            "INSERT INTO events (id, session_id, function_name, args_json) VALUES (?1, ?2, ?3, ?4)",
            params![
                "canvas-b",
                "session-a",
                tool_names::REVISE_INLINE_CANVAS,
                json!({
                    "target_event_id": "canvas-a",
                    "mode": "react",
                    "edits": [{"find": "Start", "replace": "Start setup"}]
                })
                .to_string()
            ],
        )
        .expect("compact revision");

    let args = load_materialized_canvas_args(
        &connection,
        "session-a",
        "canvas-b",
        &mut std::collections::HashSet::new(),
        0,
    )
    .expect("materialized Canvas");
    assert_eq!(args["content"], "Start setup Keep");
}

#[tokio::test]
async fn revision_rejects_an_empty_target_before_persistence_lookup() {
    let result = ReviseInlineCanvasTool::new()
        .execute_text(
            json!({
                "target_event_id": "  ",
                "mode": "react",
                "agent_steps": ["定位目标"],
                "content": "function App() { return null; }"
            }),
            &CallContext::new("call-revision", "session-a"),
        )
        .await;

    assert!(
        matches!(result, Err(ToolError::InvalidParams(message)) if message.contains("target_event_id"))
    );
}

#[test]
fn revision_target_must_be_a_canvas_in_the_same_session() {
    let connection = Connection::open_in_memory().expect("in-memory database");
    connection
        .execute(
            "CREATE TABLE events (
                    id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    function_name TEXT,
                    args_json TEXT NOT NULL DEFAULT '{}'
                )",
            [],
        )
        .expect("events table");
    connection
        .execute(
            "INSERT INTO events (id, session_id, function_name) VALUES (?1, ?2, ?3)",
            params!["canvas-a", "session-a", tool_names::RENDER_INLINE_CANVAS],
        )
        .expect("canvas event");
    connection
        .execute(
            "INSERT INTO events (id, session_id, function_name) VALUES (?1, ?2, ?3)",
            params!["read-a", "session-a", tool_names::READ_FILE],
        )
        .expect("non-canvas event");

    assert!(load_validated_canvas_target(&connection, "session-a", "canvas-a").is_ok());
    assert!(matches!(
        load_validated_canvas_target(&connection, "session-b", "canvas-a"),
        Err(ToolError::InvalidParams(_))
    ));
    assert!(matches!(
        load_validated_canvas_target(&connection, "session-a", "read-a"),
        Err(ToolError::InvalidParams(_))
    ));
}

fn canvas_chain_connection() -> Connection {
    let connection = Connection::open_in_memory().expect("in-memory database");
    connection
        .execute(
            "CREATE TABLE events (
                    id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    function_name TEXT,
                    args_json TEXT NOT NULL
                )",
            [],
        )
        .expect("events table");
    connection
}

fn insert_canvas_event(
    connection: &Connection,
    id: &str,
    function_name: &str,
    args: serde_json::Value,
) {
    connection
        .execute(
            "INSERT INTO events (id, session_id, function_name, args_json) VALUES (?1, ?2, ?3, ?4)",
            params![id, "session-a", function_name, args.to_string()],
        )
        .expect("insert canvas event");
}

#[test]
fn cyclic_revision_chain_reports_the_cycle() {
    let connection = canvas_chain_connection();
    insert_canvas_event(
        &connection,
        "canvas-a",
        tool_names::REVISE_INLINE_CANVAS,
        json!({
            "target_event_id": "canvas-b",
            "mode": "react",
            "edits": [{"find": "x", "replace": "y"}]
        }),
    );
    insert_canvas_event(
        &connection,
        "canvas-b",
        tool_names::REVISE_INLINE_CANVAS,
        json!({
            "target_event_id": "canvas-a",
            "mode": "react",
            "edits": [{"find": "x", "replace": "y"}]
        }),
    );

    let result = load_materialized_canvas_args(
        &connection,
        "session-a",
        "canvas-a",
        &mut std::collections::HashSet::new(),
        0,
    );
    assert!(matches!(
        result,
        Err(ToolError::InvalidParams(message))
            if message.contains("cyclic") && !message.contains("depth")
    ));
}

#[test]
fn deep_revision_chain_tells_the_agent_how_to_reset() {
    let connection = canvas_chain_connection();
    insert_canvas_event(
        &connection,
        "canvas-0",
        tool_names::RENDER_INLINE_CANVAS,
        json!({"mode": "react", "content": "base"}),
    );
    for index in 1..=MAX_CANVAS_REVISION_CHAIN_DEPTH + 1 {
        insert_canvas_event(
            &connection,
            &format!("canvas-{index}"),
            tool_names::REVISE_INLINE_CANVAS,
            json!({
                "target_event_id": format!("canvas-{}", index - 1),
                "mode": "react",
                "edits": [{"find": "x", "replace": "y"}]
            }),
        );
    }

    let result = load_materialized_canvas_args(
        &connection,
        "session-a",
        &format!("canvas-{}", MAX_CANVAS_REVISION_CHAIN_DEPTH + 1),
        &mut std::collections::HashSet::new(),
        0,
    );
    assert!(matches!(
        result,
        Err(ToolError::InvalidParams(message))
            if message.contains("exceeds the supported depth")
                && message.contains("complete replacement")
                && !message.contains("cyclic")
    ));
}

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::json;

use super::*;
use crate::security::{AutonomyLevel, CommandRiskRules, SecurityPolicy};
use crate::session::workspace::SessionWorkspace;
use crate::tools::traits::Tool;

fn fresh_tool() -> ManageCodeMapTool {
    let workspace = SessionWorkspace::new(PathBuf::from("/workspace"));
    ManageCodeMapTool::new(
        PathBuf::from("/workspace"),
        None,
        Arc::new(parking_lot::RwLock::new(workspace)),
    )
}

#[test]
fn manage_code_map_uses_canonical_name_and_is_mutating() {
    let tool = fresh_tool();

    assert_eq!(tool.name(), tool_names::MANAGE_CODE_MAP);
    assert_eq!(tool.category(), crate::tools::categories::CODING);
    assert!(!tool.is_read_only());
}

#[test]
fn manage_code_map_schema_exposes_lifecycle_actions() {
    let schema = fresh_tool().parameters();

    assert_eq!(
        schema.get("type").and_then(|value| value.as_str()),
        Some("object")
    );
    let enum_values = schema
        .pointer("/properties/action/enum")
        .and_then(|value| value.as_array())
        .expect("action enum should exist");
    for action in ["status", "index", "reindex", "cancel", "clear"] {
        assert!(enum_values.iter().any(|value| value == action));
    }
    assert!(schema
        .get("required")
        .and_then(|value| value.as_array())
        .is_some_and(|required| required.iter().any(|value| value == "action")));
}

#[tokio::test]
async fn explicit_relative_workspace_uses_selected_workspace_base_under_open_policy() {
    let workspace = tempfile::tempdir().unwrap();
    let selected = workspace.path().join("selected");
    std::fs::create_dir(&selected).unwrap();
    let workspace_state = Arc::new(parking_lot::RwLock::new(SessionWorkspace::new(
        workspace.path().to_path_buf(),
    )));
    let tool = ManageCodeMapTool::new(workspace.path().to_path_buf(), None, workspace_state);

    assert_eq!(
        tool.authorize_workspace_path(PathBuf::from("selected"))
            .await
            .unwrap(),
        selected.canonicalize().unwrap()
    );
}

#[tokio::test]
async fn explicit_forbidden_workspace_is_denied_under_open_policy() {
    let workspace = tempfile::tempdir().unwrap();
    let forbidden = tempfile::tempdir().unwrap();
    let workspace_state = Arc::new(parking_lot::RwLock::new(SessionWorkspace::new(
        workspace.path().to_path_buf(),
    )));
    let policy = Arc::new(SecurityPolicy::new(
        AutonomyLevel::Full,
        false,
        Vec::new(),
        Vec::new(),
        vec![forbidden.path().to_string_lossy().into_owned()],
        false,
        CommandRiskRules::default(),
    ));
    let tool = ManageCodeMapTool::new(workspace.path().to_path_buf(), None, workspace_state)
        .with_security_policy(policy);

    assert!(matches!(
        tool.authorize_workspace_path(forbidden.path().to_path_buf())
            .await,
        Err(ToolError::PermissionDenied(_))
    ));
}

#[tokio::test]
async fn manage_code_map_rejects_clear_without_confirmation() {
    let error = fresh_tool()
        .execute_text(json!({ "action": "clear" }), &Default::default())
        .await
        .expect_err("clear should require explicit confirmation");

    assert!(error.to_string().contains("confirm: true"));
}

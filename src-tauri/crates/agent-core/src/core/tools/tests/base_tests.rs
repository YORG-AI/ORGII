use crate::tools::traits::{
    optional_bool, optional_int, optional_string, required_string, Tool, ToolError,
};
use async_trait::async_trait;
use serde_json::{json, Value};

#[test]
fn required_string_extracts_value() {
    let params = json!({"path": "/tmp/foo.txt"});
    assert_eq!(required_string(&params, "path").unwrap(), "/tmp/foo.txt");
}

#[test]
fn required_string_missing_key_errors() {
    let params = json!({"other": "value"});
    let err = required_string(&params, "path").unwrap_err();
    assert!(matches!(err, ToolError::InvalidParams(_)));
    assert!(err.to_string().contains("path"));
}

#[test]
fn required_string_non_string_value_errors() {
    let params = json!({"count": 42});
    assert!(required_string(&params, "count").is_err());
}

#[test]
fn optional_string_present() {
    let params = json!({"mode": "fast"});
    assert_eq!(optional_string(&params, "mode"), Some("fast".to_string()));
}

#[test]
fn optional_string_absent() {
    let params = json!({"other": "x"});
    assert_eq!(optional_string(&params, "mode"), None);
}

#[test]
fn optional_string_wrong_type() {
    let params = json!({"mode": 123});
    assert_eq!(optional_string(&params, "mode"), None);
}

#[test]
fn optional_int_present() {
    let params = json!({"limit": 100});
    assert_eq!(optional_int(&params, "limit"), Some(100));
}

#[test]
fn optional_int_absent() {
    assert_eq!(optional_int(&json!({}), "limit"), None);
}

#[test]
fn optional_bool_present() {
    let params = json!({"recursive": true});
    assert_eq!(optional_bool(&params, "recursive"), Some(true));
}

#[test]
fn optional_bool_absent() {
    assert_eq!(optional_bool(&json!({}), "recursive"), None);
}

#[test]
fn tool_error_display_variants() {
    assert!(ToolError::InvalidParams("bad".into())
        .to_string()
        .contains("Invalid parameters"));
    assert!(ToolError::ExecutionFailed("boom".into())
        .to_string()
        .contains("Execution failed"));
    assert!(ToolError::PermissionDenied("nope".into())
        .to_string()
        .contains("Permission denied"));
    assert!(ToolError::Timeout("slow".into())
        .to_string()
        .contains("Timeout"));
}

// ============================================
// llm_description / to_schema tests (dynamic tool descriptions)
// ============================================

struct StaticTool;

#[async_trait]
impl Tool for StaticTool {
    fn name(&self) -> &str {
        "static_tool"
    }
    fn description(&self) -> &str {
        "static description"
    }
    fn parameters(&self) -> Value {
        json!({"type": "object", "properties": {}})
    }
    async fn execute_text(
        &self,
        _params: Value,
        _ctx: &crate::tools::traits::CallContext,
    ) -> Result<String, ToolError> {
        Ok("ok".into())
    }
}

struct DynamicTool;

#[async_trait]
impl Tool for DynamicTool {
    fn name(&self) -> &str {
        "dynamic_tool"
    }
    fn description(&self) -> &str {
        "static fallback"
    }
    fn parameters(&self) -> Value {
        json!({"type": "object", "properties": {}})
    }
    async fn execute_text(
        &self,
        _params: Value,
        _ctx: &crate::tools::traits::CallContext,
    ) -> Result<String, ToolError> {
        Ok("ok".into())
    }
    fn llm_description(&self) -> Option<String> {
        Some("dynamic description with /workspace/project".to_string())
    }
}

#[test]
fn to_schema_uses_static_description_when_no_llm_description() {
    let tool = StaticTool;
    let schema = tool.to_schema();
    let desc = schema["function"]["description"].as_str().unwrap();
    assert_eq!(desc, "static description");
}

#[test]
fn to_schema_prefers_llm_description_when_present() {
    let tool = DynamicTool;
    let schema = tool.to_schema();
    let desc = schema["function"]["description"].as_str().unwrap();
    assert_eq!(desc, "dynamic description with /workspace/project");
}

#[test]
fn llm_description_default_returns_none() {
    let tool = StaticTool;
    assert!(tool.llm_description().is_none());
}

// ============================================
// Dynamic llm_description tests for production tools
// ============================================

#[test]
fn web_search_llm_description_contains_current_year() {
    use crate::tools::impls::web::web_search::WebSearchTool;

    crate::test_support::install_crypto_provider_for_tests();
    let tool = WebSearchTool::new(Some("test-key".into()));
    let desc = tool
        .llm_description()
        .expect("should return dynamic description");
    let current_year = chrono::Local::now().format("%Y").to_string();
    assert!(
        desc.contains(&current_year),
        "Description should contain current year {current_year}, got: {desc}"
    );
    assert!(
        desc.contains("IMPORTANT"),
        "Description should contain date guidance"
    );
}

#[test]
fn read_file_llm_description_contains_workspace() {
    use crate::tools::impls::coding::files::ReadFileTool;
    use std::path::PathBuf;

    let tool = ReadFileTool::new(Some(PathBuf::from("/projects/myapp")));
    let desc = tool
        .llm_description()
        .expect("should return dynamic description");
    assert!(
        desc.contains("/projects/myapp"),
        "Description should contain workspace path, got: {desc}"
    );
}

#[test]
fn read_file_llm_description_unrestricted_fallback() {
    use crate::tools::impls::coding::files::ReadFileTool;

    let tool = ReadFileTool::new(None);
    let desc = tool
        .llm_description()
        .expect("should return dynamic description");
    assert!(
        desc.contains("(unrestricted)"),
        "Description should show unrestricted, got: {desc}"
    );
}

#[test]
fn list_dir_llm_description_contains_workspace() {
    use crate::tools::impls::coding::files::ListDirTool;
    use std::path::PathBuf;

    let tool = ListDirTool::new(Some(PathBuf::from("/projects/myapp")));
    let desc = tool
        .llm_description()
        .expect("should return dynamic description");
    assert!(desc.contains("/projects/myapp"));
}

#[test]
fn edit_tool_llm_description_with_workspace() {
    use crate::tools::impls::coding::edit_file::EditTool;
    use std::path::PathBuf;

    let tool = EditTool::new().with_workspace(PathBuf::from("/projects/myapp"));
    let desc = tool
        .llm_description()
        .expect("should return dynamic description");
    assert!(desc.contains("/projects/myapp"));
}

#[test]
fn edit_tool_llm_description_none_without_workspace() {
    use crate::tools::impls::coding::edit_file::EditTool;

    let tool = EditTool::new();
    assert!(
        tool.llm_description().is_none(),
        "EditTool without workspace should return None (fallback to static)"
    );
}
#[test]
fn search_tool_llm_description_contains_repo() {
    use crate::tools::impls::coding::code_search::SearchTool;
    use std::path::PathBuf;

    let tool = SearchTool::new(PathBuf::from("/projects/myapp"));
    let desc = tool
        .llm_description()
        .expect("should return dynamic description");
    assert!(desc.contains("/projects/myapp"));
    assert!(desc.contains("Search code"));
}

#[test]
fn mode_switch_llm_description_none_without_mode() {
    use crate::interaction::mode_switch::ModeSwitchManager;
    use crate::tools::impls::orchestration::suggest_mode_switch::{
        ModeSwitchToolContext, SuggestModeSwitchTool,
    };
    use std::sync::Arc;

    let manager = Arc::new(ModeSwitchManager::new());
    let ctx = Arc::new(ModeSwitchToolContext::new(manager));
    let tool = SuggestModeSwitchTool::new(ctx);
    assert!(
        tool.llm_description().is_none(),
        "Without current_mode set, should return None"
    );
}

#[test]
fn mode_switch_llm_description_with_mode() {
    use crate::interaction::mode_switch::ModeSwitchManager;
    use crate::tools::impls::orchestration::suggest_mode_switch::{
        ModeSwitchToolContext, SuggestModeSwitchTool,
    };
    use std::sync::Arc;

    let manager = Arc::new(ModeSwitchManager::new());
    let ctx = Arc::new(ModeSwitchToolContext::new(manager).with_mode("build"));
    let tool = SuggestModeSwitchTool::new(ctx);
    let desc = tool
        .llm_description()
        .expect("should return dynamic description");
    assert!(desc.contains("build"), "Should contain current mode");
    assert!(
        desc.contains("Only `plan` is accepted as target_mode"),
        "Should describe that only plan is a valid target"
    );
}

// MessageTool and AgentTool dynamic description tests are omitted here because
// they require complex runtime dependencies (MessageBus, LLMProvider).
// Their llm_description() implementations are verified by cargo check + clippy.

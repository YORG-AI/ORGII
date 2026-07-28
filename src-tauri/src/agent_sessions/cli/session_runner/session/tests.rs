use super::super::env_setup::{opencode_zenmux_model_id, setup_opencode_zenmux_profile};
use super::super::input_assembly::cli_exec_mode_bridge;
use super::super::oauth_setup::{is_api_overloaded_message, is_retryable_overloaded_chunk};
use super::super::plan_approval::{
    create_plan_content_from_chunk, looks_like_buildable_plan_body,
    plan_content_from_successful_write_chunk, synthetic_cli_plan_path,
};
use super::*;
use core_types::activity::ActivityChunk;
use core_types::providers::{CODEX_ID_TOKEN_ENV_KEY, CODEX_REFRESH_TOKEN_ENV_KEY};
use key_vault::key_store::ModelKey;
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex as StdMutex;

static ORGII_HOME_TEST_LOCK: StdMutex<()> = StdMutex::new(());

fn with_temp_orgii_home<R>(run: impl FnOnce(&Path) -> R) -> R {
    let _guard = ORGII_HOME_TEST_LOCK
        .lock()
        .expect("lock ORGII_HOME test guard");
    let previous = std::env::var("ORGII_HOME").ok();
    let temp_dir = tempfile::tempdir().expect("create temp ORGII_HOME");
    std::env::set_var("ORGII_HOME", temp_dir.path());
    let result = run(temp_dir.path());
    match previous {
        Some(value) => std::env::set_var("ORGII_HOME", value),
        None => std::env::remove_var("ORGII_HOME"),
    }
    result
}

fn read_json(path: &Path) -> Value {
    let text = std::fs::read_to_string(path).expect("read json file");
    serde_json::from_str(&text).expect("parse json file")
}

#[test]
fn opencode_zenmux_model_id_prefers_session_model() {
    let mut key = ModelKey::new(ModelType::ZenmuxApi);
    key.enabled_models = vec!["anthropic/claude-sonnet-4.5".to_string()];
    key.available_models = vec!["deepseek/deepseek-chat".to_string()];

    assert_eq!(
        opencode_zenmux_model_id(Some("qwen/qwen3-coder-plus"), &key),
        "qwen/qwen3-coder-plus"
    );
}

#[test]
fn opencode_zenmux_model_id_falls_back_to_enabled_models() {
    let mut key = ModelKey::new(ModelType::ZenmuxApi);
    key.enabled_models = vec!["anthropic/claude-sonnet-4.5".to_string()];
    key.available_models = vec!["deepseek/deepseek-chat".to_string()];

    assert_eq!(
        opencode_zenmux_model_id(None, &key),
        "anthropic/claude-sonnet-4.5"
    );
}

#[test]
fn setup_opencode_zenmux_profile_writes_config_and_auth() {
    let temp_dir = tempfile::tempdir().expect("temp opencode profile");
    let mut key = ModelKey::new(ModelType::ZenmuxApi);
    key.api_key = Some("sk-ai-v1-test".to_string());
    key.enabled_models = vec!["anthropic/claude-sonnet-4.5".to_string()];

    setup_opencode_zenmux_profile(temp_dir.path(), &key, None).expect("setup profile");

    let config = read_json(&temp_dir.path().join(".config/opencode/opencode.json"));
    assert_eq!(
        config["provider"]["zenmux"]["npm"].as_str(),
        Some("@ai-sdk/openai-compatible")
    );
    assert_eq!(
        config["provider"]["zenmux"]["options"]["baseURL"].as_str(),
        Some("https://zenmux.ai/api/v1")
    );
    assert_eq!(
        config["provider"]["zenmux"]["options"]["apiKey"].as_str(),
        Some("{env:ZENMUX_API_KEY}")
    );
    assert_eq!(
        config["model"].as_str(),
        Some("zenmux/anthropic/claude-sonnet-4.5")
    );
    assert!(config["provider"]["zenmux"]["models"]["openai/gpt-5-codex"].is_object());

    let auth = read_json(&temp_dir.path().join(".local/share/opencode/auth.json"));
    assert_eq!(auth["zenmux"]["type"].as_str(), Some("api"));
    assert_eq!(auth["zenmux"]["key"].as_str(), Some("sk-ai-v1-test"));
}

#[test]
fn cli_plan_mode_bridge_preserves_side_chat_semantics() {
    let bridge = cli_exec_mode_bridge(Some("plan")).expect("plan bridge");
    assert!(bridge.contains("draft, create, update, revise, or submit an approval plan"));
    assert!(bridge.contains("answer the question directly"));
    assert!(bridge.contains("do not create, revise, or submit a plan"));
    assert!(bridge.contains("canonicalizes the written plan file into the approval card"));
}

#[test]
fn cli_plan_markdown_detection_accepts_buildable_plan_text_only() {
    assert!(looks_like_buildable_plan_body(
        "### Build Approval Plan\n\nChange: Create `artifact.md`.\n\nScope: one low-risk filesystem change.\n\nVerification: confirm the file exists and content matches."
    ));
    assert!(looks_like_buildable_plan_body(
        "# Create Acceptance Artifact\n\n1. Create `artifact.md` with exactly `ORGII_MARKER`.\n2. Make no other filesystem changes.\n3. Verify the new file contains the required content exactly."
    ));
    assert!(!looks_like_buildable_plan_body(
        "I will submit a plan soon."
    ));
    assert!(!looks_like_buildable_plan_body(
        "Here is a general explanation without any build or verification details."
    ));
}

#[test]
fn create_plan_shape_extracts_cursor_cli_plan_args() {
    let mut chunk = ActivityChunk::new("session-1", "tool_call", "orgii acceptance artifact");
    chunk.args = serde_json::json!({
        "name": "ORGII acceptance artifact",
        "plan": "Build step: create `artifact.md` with the required content. Verification: confirm the file exists and no other changes were made."
    });
    chunk.result = serde_json::json!({ "success": {} });

    let content = create_plan_content_from_chunk(&chunk).expect("plan content");
    assert!(content.starts_with("# ORGII acceptance artifact"));
    assert!(content.contains("artifact.md"));
}

#[test]
fn successful_write_chunk_plan_content_uses_new_body() {
    let mut chunk = ActivityChunk::new("session-1", "tool_call", "edit_file_by_replace");
    chunk.args = serde_json::json!({
        "path": "/tmp/plan.md",
        "new_string": "# New Plan\n\nCreate `new.md` and verify the file contains exactly `NEW_MARKER`."
    });
    chunk.result = serde_json::json!({ "success": { "path": "/tmp/plan.md" } });

    let content = plan_content_from_successful_write_chunk(&chunk).expect("plan content");
    assert!(content.contains("new.md"));
    assert!(!content.contains("old.md"));
}

#[test]
fn enter_plan_mode_result_is_not_treated_as_assistant_plan() {
    let mut chunk = ActivityChunk::new("session-1", "tool_call", "enter_plan_mode");
    chunk.result = serde_json::json!({
        "content": "Entered plan mode. You should now focus on exploring the codebase and designing an implementation approach."
    });
    assert!(create_plan_content_from_chunk(&chunk).is_none());
}

#[test]
fn synthetic_cli_plan_path_is_session_scoped() {
    with_temp_orgii_home(|root| {
        let path = synthetic_cli_plan_path("cli/session:1", 42);
        assert!(path.starts_with(root));
        assert!(path.to_string_lossy().contains("cli-session-1"));
        assert!(path.ends_with("synthetic-plan-42.md"));
    });
}

#[test]
fn child_env_sanitization_keeps_runtime_tokens_out_of_subprocess_env() {
    let mut codex_env = HashMap::new();
    codex_env.insert("OPENAI_API_KEY".to_string(), "access-token".to_string());
    codex_env.insert(
        CODEX_REFRESH_TOKEN_ENV_KEY.to_string(),
        "refresh-token".to_string(),
    );
    codex_env.insert(CODEX_ID_TOKEN_ENV_KEY.to_string(), "id-token".to_string());
    sanitize_cli_oauth_env_for_child(&ModelType::Codex, &mut codex_env);
    assert_eq!(
        codex_env.get("OPENAI_API_KEY").map(String::as_str),
        Some("access-token")
    );
    assert!(!codex_env.contains_key(CODEX_REFRESH_TOKEN_ENV_KEY));
    assert!(!codex_env.contains_key(CODEX_ID_TOKEN_ENV_KEY));
}

#[test]
fn overloaded_error_detection() {
    assert!(is_api_overloaded_message("overloaded_error"));
    assert!(is_api_overloaded_message(
        "Anthropic API error: overloaded_error - API overloaded"
    ));
    assert!(is_api_overloaded_message("Error 529: API overloaded"));
    assert!(is_api_overloaded_message("429 Too Many Requests"));
    assert!(is_api_overloaded_message("Rate limit exceeded"));
    assert!(is_api_overloaded_message("too many requests"));
    assert!(!is_api_overloaded_message("Connection refused"));
    assert!(!is_api_overloaded_message("unauthorized access"));
    assert!(!is_api_overloaded_message(
        "Gemini OAuth access token expired"
    ));
}

#[test]
fn overloaded_chunk_detection() {
    let make_chunk = |result: serde_json::Value| core_types::activity::ActivityChunk {
        chunk_id: "test".to_string(),
        session_id: "s".to_string(),
        action_type: "error".to_string(),
        function: "error".to_string(),
        args: serde_json::json!({}),
        result,
        created_at: "2024-01-01T00:00:00Z".to_string(),
        thread_id: None,
        process_id: None,
        broadcast_only: false,
    };

    let overloaded = make_chunk(serde_json::json!({
        "error_message": "overloaded_error: The API is currently overloaded"
    }));
    assert!(is_retryable_overloaded_chunk(&overloaded).is_some());

    let rate_limited = make_chunk(serde_json::json!({
        "error": "429 Too Many Requests"
    }));
    assert!(is_retryable_overloaded_chunk(&rate_limited).is_some());

    let auth_error = make_chunk(serde_json::json!({
        "error_message": "401 Unauthorized: invalid api key"
    }));
    assert!(is_retryable_overloaded_chunk(&auth_error).is_none());

    let no_error = make_chunk(serde_json::json!({
        "text": "Hello world"
    }));
    assert!(is_retryable_overloaded_chunk(&no_error).is_none());
}

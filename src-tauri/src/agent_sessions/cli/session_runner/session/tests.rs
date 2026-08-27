use super::super::env_setup::{
    atlascloud_model_id, clear_codex_compatible_profile, codex_needs_compatible_profile,
    opencode_zenmux_model_id, resolve_orgtrack_product_mode, setup_codex_compatible_profile,
    setup_codex_hosted_profile, setup_opencode_atlascloud_profile, setup_opencode_zenmux_profile,
    validate_codex_own_key_provider,
};
use super::super::input_assembly::cli_exec_mode_bridge;
use super::super::oauth_setup::{is_api_overloaded_message, is_retryable_overloaded_chunk};
use super::super::plan_approval::{
    create_plan_content_from_chunk, looks_like_buildable_plan_body,
    plan_content_from_successful_write_chunk, synthetic_cli_plan_path,
};
use super::*;
use core_types::activity::ActivityChunk;
use core_types::providers::{CODEX_ID_TOKEN_ENV_KEY, CODEX_REFRESH_TOKEN_ENV_KEY};
use key_vault::key_store::{AuthMethod, ModelKey};
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::path::Path;

#[test]
fn project_is_always_build_execution_while_ordinary_modes_stay_distinct() {
    assert_eq!(
        resolve_cli_effective_mode(Some("project"), Some("ask"), Some("plan")),
        AgentExecMode::Build
    );
    assert_eq!(
        resolve_cli_effective_mode(Some("build"), Some("ask"), Some("build")),
        AgentExecMode::Ask
    );
    assert_eq!(
        resolve_cli_effective_mode(Some("build"), None, Some("plan")),
        AgentExecMode::Plan
    );
}

#[test]
fn project_scope_does_not_grant_project_product_capability() {
    assert_eq!(resolve_orgtrack_product_mode(Some("build"), false), "build");
    assert_eq!(resolve_orgtrack_product_mode(None, false), "build");
    assert_eq!(resolve_orgtrack_product_mode(None, true), "project");
}

fn with_temp_orgii_home<R>(run: impl FnOnce(&Path) -> R) -> R {
    let _guard = crate::test_utils::test_env::lock_home();
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
fn atlascloud_model_id_prefers_session_model() {
    let mut key = ModelKey::new(ModelType::AtlascloudApi);
    key.enabled_models = vec!["zai-org/glm-5.1".to_string()];

    assert_eq!(
        atlascloud_model_id(Some("deepseek-ai/deepseek-v3.2"), &key),
        "deepseek-ai/deepseek-v3.2"
    );
}

#[test]
fn setup_codex_compatible_profile_writes_responses_provider_without_websocket() {
    let temp_dir = tempfile::tempdir().expect("temp Codex profile");
    let mut key = ModelKey::new(ModelType::ZenmuxApi);
    key.api_key = Some("zenmux-test-key".to_string());
    key.enabled_models = vec!["z-ai/glm-5.2".to_string()];
    let mut env = HashMap::from([
        ("OPENAI_API_KEY".to_string(), "zenmux-test-key".to_string()),
        (
            "OPENAI_BASE_URL".to_string(),
            "https://stale.example/v1".to_string(),
        ),
    ]);

    setup_codex_compatible_profile(temp_dir.path(), &key, None, &mut env).expect("setup profile");

    let config = std::fs::read_to_string(temp_dir.path().join("config.toml")).expect("read config");
    assert!(config.contains("model_provider = \"orgii_compatible\""));
    assert!(config.contains("model = \"z-ai/glm-5.2\""));
    assert!(config.contains("[model_providers.orgii_compatible]"));
    assert!(config.contains("base_url = \"https://zenmux.ai/api/v1\""));
    assert!(config.contains("env_key = \"OPENAI_API_KEY\""));
    assert!(config.contains("wire_api = \"responses\""));
    assert!(config.contains("requires_openai_auth = false"));
    assert!(config.contains("supports_websockets = false"));
    assert!(config.contains("request_max_retries = 2"));
    assert!(config.contains("stream_max_retries = 2"));
    assert!(!config.contains("zenmux-test-key"));
    assert!(!env.contains_key("OPENAI_BASE_URL"));
    assert_eq!(
        env.get("OPENAI_API_KEY").map(String::as_str),
        Some("zenmux-test-key")
    );
}

#[test]
fn codex_compatible_profile_uses_zenmux_default_base_url_and_namespaced_model() {
    let temp_dir = tempfile::tempdir().expect("temp Codex profile");
    let key = ModelKey::new(ModelType::ZenmuxApi);
    let mut env = HashMap::new();

    setup_codex_compatible_profile(temp_dir.path(), &key, Some("z-ai/glm-5.2"), &mut env)
        .expect("setup compatible profile");

    let config = std::fs::read_to_string(temp_dir.path().join("config.toml")).expect("read config");
    assert!(config.contains("base_url = \"https://zenmux.ai/api/v1\""));
    assert!(config.contains("model = \"z-ai/glm-5.2\""));
}

#[test]
fn codex_own_key_provider_gate_uses_the_central_compatibility_contract() {
    for model_type in [ModelType::Codex, ModelType::OpenaiApi, ModelType::ZenmuxApi] {
        let key = ModelKey::new(model_type.clone());
        assert!(
            validate_codex_own_key_provider(&key).is_ok(),
            "expected {} to be compatible with Codex",
            model_type.as_str()
        );
    }

    for model_type in [
        ModelType::AnthropicApi,
        ModelType::GeminiApi,
        ModelType::ClaudeCode,
        ModelType::AtlascloudApi,
        ModelType::ZhipuApi,
    ] {
        let key = ModelKey::new(model_type.clone());
        assert!(
            validate_codex_own_key_provider(&key).is_err(),
            "expected {} to be rejected for Codex",
            model_type.as_str()
        );
    }
}

#[test]
fn direct_openai_keys_keep_the_builtin_codex_provider() {
    // No override and the official endpoint both mean "just use Codex's own
    // `openai` provider" — no synthetic table, no capability downgrade.
    assert!(!codex_needs_compatible_profile(&ModelKey::new(
        ModelType::OpenaiApi
    )));

    let mut official = ModelKey::new(ModelType::OpenaiApi);
    official.base_url = Some("https://api.openai.com/v1/".to_string());
    assert!(!codex_needs_compatible_profile(&official));

    let mut blank = ModelKey::new(ModelType::OpenaiApi);
    blank.base_url = Some("   ".to_string());
    assert!(!codex_needs_compatible_profile(&blank));

    // A gateway/proxy endpoint still needs the custom provider table.
    let mut gateway = ModelKey::new(ModelType::OpenaiApi);
    gateway.base_url = Some("https://gateway.internal/v1".to_string());
    assert!(codex_needs_compatible_profile(&gateway));

    // Third parties always need it.
    assert!(codex_needs_compatible_profile(&ModelKey::new(
        ModelType::ZenmuxApi
    )));
}

#[test]
fn clearing_a_stale_compatible_profile_spares_codex_authored_config() {
    let temp_dir = tempfile::tempdir().expect("temp Codex profile");
    let config_path = temp_dir.path().join("config.toml");

    clear_codex_compatible_profile(temp_dir.path()).expect("absent profile is not an error");

    std::fs::write(&config_path, "model_provider = \"orgii_compatible\"\n").expect("seed profile");
    clear_codex_compatible_profile(temp_dir.path()).expect("stale ORGII profile removed");
    assert!(
        !config_path.exists(),
        "an endpoint override that was later cleared must not keep routing"
    );

    std::fs::write(&config_path, "model = \"gpt-5.1-codex\"\n").expect("seed foreign config");
    clear_codex_compatible_profile(temp_dir.path()).expect("foreign config preserved");
    assert!(config_path.exists());
}

#[test]
fn codex_compatible_profile_rejects_an_unresolved_model() {
    let temp_dir = tempfile::tempdir().expect("temp Codex profile");
    let key = ModelKey::new(ModelType::ZenmuxApi);
    let mut env = HashMap::new();

    let error = setup_codex_compatible_profile(temp_dir.path(), &key, None, &mut env)
        .expect_err("missing model must fail closed");

    assert!(error.contains("explicit Responses-compatible model"));
    assert!(!temp_dir.path().join("config.toml").exists());
}

#[test]
fn hosted_codex_profile_is_session_scoped_and_fails_closed() {
    with_temp_orgii_home(|_| {
        let mut env = HashMap::from([("PROXY_TOKEN".to_string(), "hosted-test-token".to_string())]);

        setup_codex_hosted_profile("hosted-session-1", Some("http://127.0.0.1:43123"), &mut env)
            .expect("setup hosted profile");

        let profile = app_paths::codex_hosted_cli_profile_dir("hosted-session-1");
        assert_eq!(
            env.get("CODEX_HOME").map(String::as_str),
            Some(profile.to_string_lossy().as_ref())
        );
        let config = std::fs::read_to_string(profile.join("config.toml")).unwrap();
        assert!(config.contains("base_url = \"http://127.0.0.1:43123/v1\""));
        assert!(config.contains("supports_websockets = false"));
        assert!(config.contains("request_max_retries = 2"));
        assert!(config.contains("stream_max_retries = 2"));

        let mut missing_token = HashMap::new();
        assert!(setup_codex_hosted_profile(
            "hosted-session-2",
            Some("http://127.0.0.1:43123"),
            &mut missing_token,
        )
        .is_err());
        assert!(!missing_token.contains_key("CODEX_HOME"));
        assert!(!app_paths::codex_hosted_cli_profile_dir("hosted-session-2").exists());

        let blocked_profile = app_paths::codex_hosted_cli_profile_dir("hosted-session-3");
        std::fs::create_dir_all(blocked_profile.parent().unwrap()).unwrap();
        std::fs::write(&blocked_profile, b"not a directory").unwrap();
        let mut blocked_env =
            HashMap::from([("PROXY_TOKEN".to_string(), "hosted-test-token".to_string())]);
        assert!(setup_codex_hosted_profile(
            "hosted-session-3",
            Some("http://127.0.0.1:43123"),
            &mut blocked_env,
        )
        .is_err());
        assert!(!blocked_env.contains_key("CODEX_HOME"));
    });
}

#[test]
fn codex_api_key_profile_must_not_be_written_as_oauth_tokens() {
    with_temp_orgii_home(|_| {
        let account_id = "zhipu-api-key-shape";
        let mut key = ModelKey::new(ModelType::ZhipuApi);
        key.api_key = Some("zhipu-test-key".to_string());
        let mut env = HashMap::new();
        env.insert("OPENAI_API_KEY".to_string(), "zhipu-test-key".to_string());

        super::super::oauth_setup::write_codex_cli_auth_file(account_id, &key, &env)
            .expect("write Codex API-key auth profile");

        let auth = read_json(&app_paths::codex_cli_profile_dir(account_id).join("auth.json"));
        assert_eq!(auth["OPENAI_API_KEY"].as_str(), Some("zhipu-test-key"));
        assert!(auth.get("tokens").is_none());
    });
}

#[test]
fn codex_auth_payload_matches_credential_type_matrix() {
    use super::super::oauth_setup::codex_cli_auth_payload;

    for model_type in [
        ModelType::Codex,
        ModelType::ZhipuApi,
        ModelType::ZenmuxApi,
        ModelType::AtlascloudApi,
    ] {
        let mut key = ModelKey::new(model_type);
        key.api_key = Some("provider-api-key".to_string());
        let payload = codex_cli_auth_payload(&key, &HashMap::new()).unwrap();
        assert_eq!(payload["OPENAI_API_KEY"].as_str(), Some("provider-api-key"));
        assert!(payload.get("tokens").is_none());
    }

    let mut oauth_key = ModelKey::new(ModelType::Codex);
    oauth_key.auth_method = AuthMethod::Oauth;
    oauth_key.session_token = Some("oauth-access".to_string());
    oauth_key.env_vars.insert(
        CODEX_REFRESH_TOKEN_ENV_KEY.to_string(),
        "oauth-refresh".to_string(),
    );
    oauth_key
        .env_vars
        .insert(CODEX_ID_TOKEN_ENV_KEY.to_string(), "oauth-id".to_string());
    let payload = codex_cli_auth_payload(&oauth_key, &HashMap::new()).unwrap();
    assert!(payload["OPENAI_API_KEY"].is_null());
    assert_eq!(
        payload["tokens"]["access_token"].as_str(),
        Some("oauth-access")
    );
    assert_eq!(
        payload["tokens"]["refresh_token"].as_str(),
        Some("oauth-refresh")
    );
    assert_eq!(payload["tokens"]["id_token"].as_str(), Some("oauth-id"));
}

#[test]
fn zenmux_auth_json_stays_api_key_shaped_when_profile_is_rewritten() {
    use super::super::oauth_setup::write_codex_cli_auth_file;

    with_temp_orgii_home(|_| {
        let account_id = "zenmux-rewrite-shape";
        let profile_dir = app_paths::codex_cli_profile_dir(account_id);
        let mut key = ModelKey::new(ModelType::ZenmuxApi);
        key.api_key = Some("zenmux-test-key".to_string());
        key.enabled_models = vec!["z-ai/glm-5.2".to_string()];
        let mut env = HashMap::new();
        env.insert("OPENAI_API_KEY".to_string(), "zenmux-test-key".to_string());
        setup_codex_compatible_profile(&profile_dir, &key, None, &mut env).unwrap();
        write_codex_cli_auth_file(account_id, &key, &env).unwrap();

        let auth = read_json(&profile_dir.join("auth.json"));
        assert_eq!(auth["OPENAI_API_KEY"].as_str(), Some("zenmux-test-key"));
        assert!(auth.get("tokens").is_none());
    });
}

#[test]
fn oauth_retry_eligibility_requires_matching_native_oauth_credential() {
    use super::super::oauth_setup::is_cli_oauth_retry_eligible;

    let mut codex_oauth = ModelKey::new(ModelType::Codex);
    codex_oauth.auth_method = AuthMethod::Oauth;
    let codex_api_key = ModelKey::new(ModelType::Codex);
    let mut claude_oauth = ModelKey::new(ModelType::ClaudeCode);
    claude_oauth.auth_method = AuthMethod::Oauth;
    let claude_api_key = ModelKey::new(ModelType::ClaudeCode);
    let zhipu_api_key = ModelKey::new(ModelType::ZhipuApi);
    let zenmux_api_key = ModelKey::new(ModelType::ZenmuxApi);

    assert!(is_cli_oauth_retry_eligible(
        &ModelType::Codex,
        KeySource::OwnKey,
        Some(&codex_oauth)
    ));
    assert!(is_cli_oauth_retry_eligible(
        &ModelType::ClaudeCode,
        KeySource::OwnKey,
        Some(&claude_oauth)
    ));

    for (target, key) in [
        (&ModelType::Codex, &codex_api_key),
        (&ModelType::Codex, &zhipu_api_key),
        (&ModelType::Codex, &zenmux_api_key),
        (&ModelType::Codex, &claude_oauth),
        (&ModelType::ClaudeCode, &claude_api_key),
        (&ModelType::ClaudeCode, &zhipu_api_key),
        (&ModelType::ClaudeCode, &zenmux_api_key),
        (&ModelType::ClaudeCode, &codex_oauth),
    ] {
        assert!(!is_cli_oauth_retry_eligible(
            target,
            KeySource::OwnKey,
            Some(key)
        ));
    }
    assert!(!is_cli_oauth_retry_eligible(
        &ModelType::Codex,
        KeySource::HostedKey,
        Some(&codex_oauth)
    ));
}

#[test]
fn app_server_auth_error_chunk_uses_the_native_oauth_retry_gate() {
    use super::super::oauth_setup::is_retryable_cli_oauth_failure_chunk;

    let mut chunk = ActivityChunk::new("session-1", "error", "error");
    chunk.result = serde_json::json!({
        "observation": "401 Unauthorized: OAuth access token expired",
        "error": "401 Unauthorized: OAuth access token expired",
        "success": false,
    });

    assert!(is_retryable_cli_oauth_failure_chunk(true, &chunk).is_some());
    assert!(is_retryable_cli_oauth_failure_chunk(false, &chunk).is_none());
}

#[test]
fn stderr_summary_collapses_timestamped_retries_but_keeps_distinct_failures() {
    let lines = VecDeque::from([
        "2026-08-03T07:23:34Z ERROR Reconnecting... 1/5 (unexpected status 402 Payment Required, url: https://zenmux.ai/api/v1/responses, cf-ray: first)".to_string(),
        "2026-08-03T07:23:39Z ERROR Reconnecting... 2/5 (unexpected status 402 Payment Required, url: https://zenmux.ai/api/v1/responses, cf-ray: second)".to_string(),
        "2026-08-03T07:23:42Z ERROR unexpected status 402 Payment Required, url: https://zenmux.ai/api/v1/responses, cf-ray: final".to_string(),
        "2026-08-03T07:23:43Z ERROR codex_api: 401 Unauthorized".to_string(),
    ]);

    assert_eq!(
        super::super::finalize::summarize_cli_stderr(&lines).as_deref(),
        Some(
            "unexpected status 402 Payment Required, url: https://zenmux.ai/api/v1/responses\ncodex_api: 401 Unauthorized"
        )
    );
}

#[test]
fn stderr_summary_drops_the_notice_the_parser_already_suppressed() {
    let notice = "2026-08-03T07:23:30Z WARN Model metadata for `z-ai/glm-5.2` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.";
    let lines = VecDeque::from([
        notice.to_string(),
        "2026-08-03T07:23:43Z ERROR codex_api: 401 Unauthorized".to_string(),
    ]);

    // `not found` would otherwise re-promote a notice Codex recovers from into
    // the persisted failure message.
    assert_eq!(
        super::super::finalize::summarize_cli_stderr(&lines).as_deref(),
        Some("codex_api: 401 Unauthorized")
    );

    // On its own it is not a failure reason either. The last-line fallback
    // must not resurrect it — a session that only logged this notice has no
    // stderr-derived failure message at all.
    let only_notice = VecDeque::from([notice.to_string()]);
    assert_eq!(
        super::super::finalize::summarize_cli_stderr(&only_notice),
        None
    );

    // A real line behind the notice is still reachable through that fallback.
    let notice_then_plain = VecDeque::from([
        "2026-08-03T07:23:44Z INFO codex_core: exiting".to_string(),
        notice.to_string(),
    ]);
    assert_eq!(
        super::super::finalize::summarize_cli_stderr(&notice_then_plain).as_deref(),
        Some("2026-08-03T07:23:44Z INFO codex_core: exiting")
    );
}

#[test]
fn stderr_summary_falls_back_to_last_nonempty_line() {
    let lines = VecDeque::from([
        "Reading additional input from stdin...".to_string(),
        "".to_string(),
    ]);
    assert_eq!(
        super::super::finalize::summarize_cli_stderr(&lines).as_deref(),
        Some("Reading additional input from stdin...")
    );
}

#[test]
fn structured_cli_error_wins_over_non_diagnostic_stderr() {
    let lines = VecDeque::from(["Reading additional input from stdin...".to_string()]);

    assert_eq!(
        super::super::finalize::resolve_cli_failure_message(
            None,
            Some("unexpected status 402 Payment Required".to_string()),
            &lines,
        )
        .as_deref(),
        Some("unexpected status 402 Payment Required")
    );
}

#[test]
fn terminal_cli_error_is_extracted_from_error_and_failed_session_end_chunks() {
    let mut error_chunk = ActivityChunk::new("session-1", "error", "error");
    error_chunk.result = serde_json::json!({
        "error": "unexpected status 402 Payment Required, cf-ray: volatile-id",
        "success": false,
    });
    assert_eq!(
        super::terminal_cli_error_from_chunk(&error_chunk).as_deref(),
        Some("unexpected status 402 Payment Required")
    );

    let mut end_chunk = ActivityChunk::new("session-1", "session_end", "session_end");
    end_chunk.result = serde_json::json!({
        "success": false,
        "error_message": "provider rejected the request",
    });
    assert_eq!(
        super::terminal_cli_error_from_chunk(&end_chunk).as_deref(),
        Some("provider rejected the request")
    );
}

#[test]
fn failed_session_end_replaces_an_earlier_provisional_error() {
    let mut terminal_error = None;
    let mut error_chunk = ActivityChunk::new("session-1", "error", "error");
    error_chunk.result = serde_json::json!({
        "error": "earlier transport error",
        "success": false,
    });
    super::record_terminal_cli_error(&mut terminal_error, &error_chunk);
    assert_eq!(terminal_error.as_deref(), Some("earlier transport error"));

    let mut end_chunk = ActivityChunk::new("session-1", "session_end", "session_end");
    end_chunk.result = serde_json::json!({
        "success": false,
        "error_message": "authoritative upstream failure",
    });
    super::record_terminal_cli_error(&mut terminal_error, &end_chunk);
    assert_eq!(
        terminal_error.as_deref(),
        Some("authoritative upstream failure")
    );
}

#[test]
fn codex_uses_native_overload_retries_without_whole_turn_replay() {
    assert!(!super::is_app_overload_retry_eligible(&ModelType::Codex));
    assert!(super::is_app_overload_retry_eligible(
        &ModelType::ClaudeCode
    ));
}

#[test]
fn exhausted_overload_builds_one_visible_terminal_error_chunk() {
    assert!(exhausted_overload_error_chunk(
        "session-1",
        MAX_OVERLOAD_RETRIES - 1,
        "429 Too Many Requests",
    )
    .is_none());

    let (message, chunk) = exhausted_overload_error_chunk(
        "session-1",
        MAX_OVERLOAD_RETRIES,
        "429 Too Many Requests, request-id: volatile",
    )
    .expect("exhausted overload should produce a terminal error");

    assert_eq!(message, "429 Too Many Requests");
    assert_eq!(chunk.action_type, "error");
    assert_eq!(chunk.function, "error");
    assert_eq!(
        terminal_cli_error_from_chunk(&chunk).as_deref(),
        Some(message.as_str())
    );
}

#[test]
fn setup_opencode_atlascloud_profile_writes_config_and_auth() {
    let temp_dir = tempfile::tempdir().expect("temp OpenCode profile");
    let mut key = ModelKey::new(ModelType::AtlascloudApi);
    key.api_key = Some("atlas-test-key".to_string());
    key.enabled_models = vec!["zai-org/glm-5.1".to_string()];

    setup_opencode_atlascloud_profile(temp_dir.path(), &key, None).expect("setup profile");

    let config = read_json(&temp_dir.path().join(".config/opencode/opencode.json"));
    assert_eq!(
        config["provider"]["atlascloud"]["npm"].as_str(),
        Some("@ai-sdk/openai-compatible")
    );
    assert_eq!(
        config["provider"]["atlascloud"]["options"]["baseURL"].as_str(),
        Some("https://api.atlascloud.ai/v1")
    );
    assert_eq!(
        config["provider"]["atlascloud"]["options"]["apiKey"].as_str(),
        Some("{env:ATLASCLOUD_API_KEY}")
    );
    assert_eq!(config["model"].as_str(), Some("atlascloud/zai-org/glm-5.1"));
    assert!(config["provider"]["atlascloud"]["models"]["zai-org/glm-5.1"].is_object());

    let auth = read_json(&temp_dir.path().join(".local/share/opencode/auth.json"));
    assert_eq!(auth["atlascloud"]["type"].as_str(), Some("api"));
    assert_eq!(auth["atlascloud"]["key"].as_str(), Some("atlas-test-key"));
}

#[test]
fn atlas_model_string_is_preserved_before_the_codex_provider_gate_rejects_it() {
    assert_eq!(
        resolve_session_model(
            &ModelType::Codex,
            Some(&ModelType::AtlascloudApi),
            Some("zai-org/glm-5.1"),
        )
        .as_deref(),
        Some("zai-org/glm-5.1")
    );
    assert!(
        super::super::env_setup::validate_codex_own_key_provider(&ModelKey::new(
            ModelType::AtlascloudApi,
        ))
        .is_err()
    );
    assert_eq!(
        resolve_session_model(
            &ModelType::ClaudeCode,
            Some(&ModelType::AtlascloudApi),
            Some("zai-org/glm-5.1"),
        ),
        None
    );
}

#[test]
fn codex_rejects_chat_only_providers_and_zenmux_preserves_aggregator_namespace() {
    for provider in [ModelType::ZhipuApi, ModelType::AtlascloudApi] {
        let key = ModelKey::new(provider);
        let error = super::super::env_setup::validate_codex_own_key_provider(&key)
            .expect_err("Chat Completions must not be treated as Codex Responses");
        assert!(error.contains("Responses-compatible"));
    }
    assert_eq!(
        super::super::env_setup::normalize_codex_provider_model_id(
            "z-ai/glm-5.2",
            &ModelType::ZenmuxApi,
        ),
        "z-ai/glm-5.2"
    );
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
fn cli_build_mode_bridge_requires_byte_exact_verification() {
    let bridge = cli_exec_mode_bridge(Some("build")).expect("build bridge");
    assert!(bridge.contains("verify byte count and trailing bytes"));
    assert!(bridge.contains("trimmed text readers hide trailing newlines"));
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

/// The whole point of the collector: a child can exit with its stderr still
/// sitting unread in the pipe, and every consumer of the buffer runs after
/// `wait()`. Reading without draining is how a session that failed loudly
/// reports nothing at all.
///
/// The writer emits its 200 lines in one `printf` rather than a loop on
/// purpose: a slow writer gives the reader task a poll between every line and
/// it keeps up trivially. Dumped in a single write, the reader is still
/// working through the pipe when the child is already reaped — without the
/// drain this buffer ends around line 127, and the last line, the one a real
/// CLI puts its error on, is exactly what gets lost.
///
/// Hence the line numbers come from Rust and not from `seq` (which is not
/// POSIX): passing them as `"$@"` keeps it a single `printf`, and the test
/// stands on that shape. A `while` loop around `printf` costs 200 writes and
/// passes whether or not `drain` exists.
#[cfg(unix)]
#[tokio::test]
async fn stderr_collector_has_the_whole_output_once_drained() {
    let numbers: Vec<String> = (1..=200).map(|n| n.to_string()).collect();
    let mut child = tokio::process::Command::new("sh")
        .arg("-c")
        .arg(r#"exec >&2; printf 'line %s\n' "$@""#)
        // `sh -c` assigns the first operand to $0, so the numbers start at $1.
        .arg("stderr-writer")
        .args(&numbers)
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("spawn stderr writer");

    let mut collector = CliStderrCollector::new();
    collector.attach(
        child.stderr.take().expect("stderr was piped"),
        "test-session".to_string(),
    );

    let status = child.wait().await.expect("wait for stderr writer");
    assert!(status.success());

    collector.drain().await;

    let lines = collector.lines();
    let buf = lines.lock().await;
    // The buffer is a bounded ring, so the last line written is the assertion
    // that matters: it can only be there if the reader ran to EOF.
    assert_eq!(buf.len(), MAX_STDERR_LINES);
    assert_eq!(buf.back().map(String::as_str), Some("line 200"));
    assert_eq!(buf.front().map(String::as_str), Some("line 181"));
}

/// A CLI that leaves its stderr with a process outliving it keeps the pipe open
/// after the child itself is reaped, so `drain` gives up on a deadline — and has
/// to abort the reader when it does. Dropping the handle would only detach the
/// task, leaving it, the pipe fd and a buffer handle alive for as long as that
/// process lives, once per attempt.
///
/// `start_paused` makes the deadline free: with the reader parked on the pipe
/// the runtime has nothing left to run, so the clock jumps to the timeout. The
/// reader's own `Arc` clone is the proof it stopped — the count can only drop
/// back once the task's future has been dropped.
#[cfg(unix)]
#[tokio::test(start_paused = true)]
async fn a_reader_the_grandchild_holds_open_is_aborted_not_detached() {
    // The backgrounded sleep inherits stderr and outlives the shell, so the
    // write end is still open once the child is gone. Its own process group is
    // the only handle on it afterwards — the shell's exit orphans it.
    let mut child = tokio::process::Command::new("sh")
        .arg("-c")
        .arg("exec >&2; echo dying; sleep 300 &")
        .stderr(std::process::Stdio::piped())
        .process_group(0)
        .spawn()
        .expect("spawn stderr writer");
    let group = child.id().expect("child pid before wait") as libc::pid_t;

    let mut collector = CliStderrCollector::new();
    collector.attach(
        child.stderr.take().expect("stderr was piped"),
        "test-session".to_string(),
    );
    assert!(child
        .wait()
        .await
        .expect("wait for stderr writer")
        .success());

    let lines = collector.lines();
    assert_eq!(
        Arc::strong_count(&lines),
        3,
        "the collector, the reader task and this handle"
    );

    collector.drain().await;

    assert_eq!(
        Arc::strong_count(&lines),
        2,
        "a reader that outlived the deadline must be aborted, not detached"
    );

    // SAFETY: signalling a process group this test created.
    unsafe { libc::kill(-group, libc::SIGKILL) };
}

#[cfg(unix)]
#[tokio::test]
async fn draining_the_stderr_collector_twice_is_a_no_op() {
    let mut child = tokio::process::Command::new("sh")
        .arg("-c")
        .arg("echo boom >&2")
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("spawn stderr writer");

    let mut collector = CliStderrCollector::new();
    collector.attach(
        child.stderr.take().expect("stderr was piped"),
        "test-session".to_string(),
    );
    let _ = child.wait().await;

    // Both transports drain, and the run loop drains again for the finalizer.
    collector.drain().await;
    collector.drain().await;

    let lines = collector.lines();
    assert_eq!(
        lines.lock().await.back().map(String::as_str),
        Some("boom"),
        "the second drain must not discard what the first collected"
    );
}

/// A collector that was never attached to a child (spawn failed before the
/// pipe was taken) must not make the caller wait out the drain timeout.
#[tokio::test]
async fn draining_an_unattached_stderr_collector_returns_immediately() {
    let mut collector = CliStderrCollector::new();
    tokio::time::timeout(tokio::time::Duration::from_secs(1), collector.drain())
        .await
        .expect("drain of an unattached collector must not block");
    assert!(collector.lines().lock().await.is_empty());
}

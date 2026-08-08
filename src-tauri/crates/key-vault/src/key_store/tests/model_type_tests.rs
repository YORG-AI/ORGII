// Tests for ModelType predicate methods and ModelKey edge cases.
// These complement the conversion tests already in tests.rs.

use crate::key_store::{AuthMethod, HealthStatus, ModelKey, ModelType};

// ---------------------------------------------------------------------------
// ModelType::is_cli_agent / is_api_key_provider
// ---------------------------------------------------------------------------

#[test]
fn cli_agents_are_cli_agents() {
    let cli_types = [
        ModelType::CursorCli,
        ModelType::ClaudeCode,
        ModelType::Codex,
        ModelType::Copilot,
        ModelType::Kiro,
        ModelType::KimiCli,
        ModelType::OpenCode,
        ModelType::QoderCli,
        ModelType::TraeCli,
    ];
    for t in &cli_types {
        assert!(t.is_cli_agent(), "{:?} should be a CLI agent", t);
        assert!(
            !t.is_api_key_provider(),
            "{:?} should not be an API key provider",
            t
        );
    }
}

#[test]
fn api_providers_are_api_key_providers() {
    let api_types = [
        ModelType::AnthropicApi,
        ModelType::OpenaiApi,
        ModelType::AtlascloudApi,
        ModelType::DeepseekApi,
        ModelType::GeminiApi,
        ModelType::GroqApi,
        ModelType::XaiApi,
        ModelType::ZhipuApi,
        ModelType::DashscopeApi,
        ModelType::MoonshotApi,
        ModelType::OpenrouterApi,
        ModelType::ZenmuxApi,
        ModelType::VllmApi,
        ModelType::MinimaxApi,
        ModelType::LongcatApi,
        ModelType::AzureOpenaiApi,
        ModelType::AzureAnthropicApi,
    ];
    for t in &api_types {
        assert!(
            t.is_api_key_provider(),
            "{:?} should be an API key provider",
            t
        );
        assert!(!t.is_cli_agent(), "{:?} should not be a CLI agent", t);
    }
}

// ---------------------------------------------------------------------------
// ModelType::needs_mitm_proxy
// ---------------------------------------------------------------------------

#[test]
fn only_cursor_copilot_kiro_need_mitm() {
    assert!(ModelType::CursorCli.needs_mitm_proxy());
    assert!(ModelType::Copilot.needs_mitm_proxy());
    assert!(ModelType::Kiro.needs_mitm_proxy());

    // Other CLI agents do NOT use MITM proxy
    assert!(!ModelType::ClaudeCode.needs_mitm_proxy());
    assert!(!ModelType::Codex.needs_mitm_proxy());
    assert!(!ModelType::KimiCli.needs_mitm_proxy());
    assert!(!ModelType::OpenCode.needs_mitm_proxy());

    // API providers do NOT use MITM proxy
    assert!(!ModelType::AnthropicApi.needs_mitm_proxy());
    assert!(!ModelType::OpenaiApi.needs_mitm_proxy());
}

// ---------------------------------------------------------------------------
// ModelType::is_acp (Agent Communication Protocol)
// ---------------------------------------------------------------------------

#[test]
fn acp_types_are_copilot_kiro_opencode() {
    assert!(ModelType::Copilot.is_acp());
    assert!(ModelType::Kiro.is_acp());
    assert!(ModelType::OpenCode.is_acp());

    assert!(!ModelType::CursorCli.is_acp());
    assert!(!ModelType::ClaudeCode.is_acp());
    assert!(!ModelType::Codex.is_acp());
    assert!(!ModelType::AnthropicApi.is_acp());
}

// ---------------------------------------------------------------------------
// ModelType::is_market_native
// ---------------------------------------------------------------------------

#[test]
fn only_orgii_orchestrator_is_market_native() {
    assert!(ModelType::OrgiiOrchestrator.is_market_native());

    assert!(!ModelType::CursorCli.is_market_native());
    assert!(!ModelType::AnthropicApi.is_market_native());
    assert!(!ModelType::Codex.is_market_native());
}

// ---------------------------------------------------------------------------
// ModelType::as_str round-trip through from_str
// ---------------------------------------------------------------------------

#[test]
fn as_str_round_trips_through_from_str() {
    let all_types = [
        ModelType::CursorCli,
        ModelType::ClaudeCode,
        ModelType::Codex,
        ModelType::Copilot,
        ModelType::Kiro,
        ModelType::KimiCli,
        ModelType::OpenCode,
        ModelType::QoderCli,
        ModelType::TraeCli,
        ModelType::AnthropicApi,
        ModelType::OpenaiApi,
        ModelType::AtlascloudApi,
        ModelType::DeepseekApi,
        ModelType::GeminiApi,
        ModelType::GroqApi,
        ModelType::XaiApi,
        ModelType::ZhipuApi,
        ModelType::DashscopeApi,
        ModelType::MoonshotApi,
        ModelType::OpenrouterApi,
        ModelType::ZenmuxApi,
        ModelType::VllmApi,
        ModelType::MinimaxApi,
        ModelType::LongcatApi,
        ModelType::AzureOpenaiApi,
        ModelType::AzureAnthropicApi,
        ModelType::OrgiiOrchestrator,
    ];
    for t in &all_types {
        let s = t.as_str();
        let recovered = ModelType::from_str(s);
        assert_eq!(
            recovered,
            Some(t.clone()),
            "Round-trip failed for {:?} (\"{}\")",
            t,
            s
        );
    }
}

// ---------------------------------------------------------------------------
// ModelType::from_str — unknown input
// ---------------------------------------------------------------------------

#[test]
fn from_str_returns_none_for_unknown_strings() {
    assert_eq!(ModelType::from_str(""), None);
    assert_eq!(ModelType::from_str("totally_unknown"), None);
    assert_eq!(ModelType::from_str("  cursor_cli "), None); // trailing space not accepted
}

// ---------------------------------------------------------------------------
// ModelKey::new defaults
// ---------------------------------------------------------------------------

#[test]
fn model_key_new_has_sensible_defaults() {
    let key = ModelKey::new(ModelType::ClaudeCode);
    assert_eq!(key.model_type, ModelType::ClaudeCode);
    assert!(key.api_key.is_none());
    assert!(key.session_token.is_none());
    assert!(key.name.is_none());
    assert!(key.enabled);
    assert!(key.has_local_key);
    assert!(!key.is_listed);
    assert_eq!(key.health_status, HealthStatus::Unknown);
    assert_eq!(key.auth_method, AuthMethod::ApiKey);
    assert!(key.available_models.is_empty());
    assert!(key.enabled_models.is_empty());
}

// ---------------------------------------------------------------------------
// ModelKey::mask_api_key edge cases
// ---------------------------------------------------------------------------

#[test]
fn mask_api_key_returns_none_when_no_key() {
    let key = ModelKey::new(ModelType::OpenaiApi);
    assert_eq!(key.mask_api_key(), None);
}

#[test]
fn mask_api_key_masks_very_short_key_fully() {
    let mut key = ModelKey::new(ModelType::OpenaiApi);
    key.api_key = Some("abc".to_string());
    // short string — fully masked
    let masked = key.mask_api_key().unwrap();
    assert!(
        !masked.contains("abc"),
        "Short key should be fully masked, got {:?}",
        masked
    );
}

#[test]
fn mask_api_key_shows_last_four_chars_of_long_key() {
    let mut key = ModelKey::new(ModelType::OpenaiApi);
    key.api_key = Some("sk-1234567890ABCDEF".to_string());
    let masked = key.mask_api_key().unwrap();
    // Last 4 chars should appear, rest masked
    assert!(
        masked.ends_with("CDEF"),
        "Expected last 4 chars, got {:?}",
        masked
    );
    assert!(
        masked.contains('*'),
        "Expected asterisks in masked key, got {:?}",
        masked
    );
}

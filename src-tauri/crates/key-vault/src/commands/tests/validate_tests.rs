use super::*;
use crate::test_support::install_crypto_provider_for_tests;

// ── default_base_url_for_provider ─────────────────────────────────
//
// Regression guard: the helper must strip a trailing `/v1` segment
// because `OpenAIValidator::validate` re-appends `/v1/models` itself.
// A pass-through here would silently produce `…/v1/v1/models`.

#[test]
fn default_base_url_strips_trailing_v1() {
    assert_eq!(
        default_base_url_for_provider("openai_api"),
        Some("https://api.openai.com".to_string())
    );
    assert_eq!(
        default_base_url_for_provider("anthropic_api"),
        Some("https://api.anthropic.com".to_string())
    );
    assert_eq!(
        default_base_url_for_provider("groq_api"),
        Some("https://api.groq.com/openai".to_string())
    );
    assert_eq!(
        default_base_url_for_provider("xai_api"),
        Some("https://api.x.ai".to_string())
    );
    assert_eq!(
        default_base_url_for_provider("atlascloud_api"),
        Some("https://api.atlascloud.ai".to_string())
    );
}

#[test]
fn default_base_url_keeps_url_without_v1_suffix() {
    // deepseek_api's default base URL is "https://api.deepseek.com" — no /v1 to strip.
    assert_eq!(
        default_base_url_for_provider("deepseek_api"),
        Some("https://api.deepseek.com".to_string())
    );
}

#[test]
fn default_base_url_returns_none_for_no_default() {
    // Azure providers have no default — user must supply their endpoint.
    assert_eq!(default_base_url_for_provider("azure_openai_api"), None);
    assert_eq!(default_base_url_for_provider("azure_anthropic_api"), None);
    // CLI agents also return no default (config has default_base_url: None).
    assert_eq!(default_base_url_for_provider("cursor_cli"), None);
    assert_eq!(default_base_url_for_provider("claude_code"), None);
}

#[test]
fn default_base_url_unknown_provider_returns_none() {
    assert_eq!(default_base_url_for_provider("not_a_real_provider"), None);
}

#[test]
fn oauth_auth_failures_are_not_hidden_by_the_fallback_catalog() {
    for error in [
        "HTTP 401",
        "HTTP 403",
        "unauthorized",
        "forbidden",
        "invalid credential",
        "invalid token",
        "access denied",
        "token expired",
    ] {
        assert!(is_oauth_discovery_auth_error(error), "{error}");
    }
    assert!(!is_oauth_discovery_auth_error("request timed out"));
}

#[test]
fn opencode_base_url_defaults_to_zen_and_respects_selection() {
    assert_eq!(resolve_opencode_base_url(None), OPENCODE_ZEN_BASE_URL);
    assert_eq!(
        resolve_opencode_base_url(Some(OPENCODE_ZEN_BASE_URL)),
        OPENCODE_ZEN_BASE_URL
    );
    assert_eq!(
        resolve_opencode_base_url(Some(OPENCODE_GO_BASE_URL)),
        OPENCODE_GO_BASE_URL
    );
}

// ── validate_token_format dispatch ────────────────────────────────
//
// Pure dispatch — no network, no `reqwest::Client` constructed.
// Walks every accepted agent_type to ensure the match arms keep
// routing to *some* validator (not the unknown-type error path).

fn ok_format(agent_type: &str, token: &str) -> (bool, String) {
    validate_token_format(agent_type.to_string(), token.to_string())
        .unwrap_or_else(|err| panic!("validate_token_format({agent_type}) errored: {err}"))
}

#[test]
fn validate_token_format_routes_canonical_cli_agents() {
    // Every CLI-agent arm constructs a `<Validator>::new()` (which
    // builds a `reqwest::Client`), so a crypto provider must be set
    // even though we never make a network call.
    install_crypto_provider_for_tests();
    for agent in [
        "copilot",
        "cursor_cli",
        "openai",
        "codex",
        "anthropic",
        "claude_code",
        "google",
        "kiro",
        "opencode",
    ] {
        let _ = ok_format(agent, "some-token-1234567890");
    }
}

#[test]
fn validate_token_format_routes_aliases() {
    install_crypto_provider_for_tests();
    // Each alias must accept the same input as its canonical name.
    // Just asserting "no error" — actual format rules are validator-specific.
    let _ = ok_format("github_copilot", "ghp_xxxxxxxxxx");
    let _ = ok_format("cursor", "key_xxxxxxxxxxxxxxxxxxxx");
}

#[test]
fn validate_token_format_routes_api_suffix_providers() {
    install_crypto_provider_for_tests();
    for agent in [
        "openai_api",
        "anthropic_api",
        "gemini_api",
        "azure_openai_api",
        "azure_anthropic_api",
    ] {
        let _ = ok_format(agent, "sk-xxxxxxxxxxxxxxxxxxxx");
    }
}

#[test]
fn validate_token_format_openai_compat_cluster_rejects_empty() {
    // The OpenAI-compat cluster shares one length-only check.
    for agent in [
        "deepseek_api",
        "groq_api",
        "xai_api",
        "atlascloud_api",
        "zhipu_api",
        "dashscope_api",
        "moonshot_api",
        "minimax_api",
        "longcat_api",
        "openrouter_api",
        "zenmux_api",
        "vllm_api",
        "orgii_orchestrator",
        "orgii",
    ] {
        let (valid, msg) = ok_format(agent, "");
        assert!(!valid, "{agent} accepted empty token");
        assert!(msg.contains("required"), "{agent} message: {msg}");
    }
}

#[test]
fn validate_token_format_openai_compat_cluster_rejects_short() {
    for agent in [
        "deepseek_api",
        "groq_api",
        "xai_api",
        "atlascloud_api",
        "zhipu_api",
        "dashscope_api",
        "moonshot_api",
        "minimax_api",
        "longcat_api",
        "openrouter_api",
        "zenmux_api",
        "vllm_api",
        "orgii_orchestrator",
        "orgii",
    ] {
        // 7 chars is below the 8-char minimum.
        let (valid, msg) = ok_format(agent, "abc1234");
        assert!(!valid, "{agent} accepted 7-char token");
        assert!(msg.contains("short"), "{agent} message: {msg}");
    }
}

#[test]
fn validate_token_format_openai_compat_cluster_accepts_long_enough() {
    for agent in [
        "deepseek_api",
        "groq_api",
        "xai_api",
        "atlascloud_api",
        "longcat_api",
        "orgii_orchestrator",
        "orgii",
    ] {
        // 8+ chars passes the length-only check.
        let (valid, msg) = ok_format(agent, "abcd1234efgh");
        assert!(valid, "{agent} rejected long-enough token (msg: {msg})");
    }
}

#[test]
fn validate_token_format_unknown_returns_err() {
    let res = validate_token_format("totally_made_up".into(), "tok".into());
    let err = res.expect_err("unknown agent type must Err");
    assert!(err.contains("totally_made_up"), "err was: {err}");
}

// ── run_validate_key dispatch (unknown-type only) ─────────────────
//
// The known-type arms each construct a `reqwest::Client` (so they
// need the crypto-provider bootstrap and live network), but the
// unknown-type error path is pure string formatting — keep it here
// as a cheap regression guard for the Err message contract.

#[tokio::test]
async fn run_validate_key_unknown_agent_type_errs_with_listing() {
    let err = run_validate_key(
        "definitely_not_real".into(),
        "sk-xxx".into(),
        None,
        None,
        None,
        None,
    )
    .await
    .expect_err("unknown agent_type must Err");

    assert!(err.contains("definitely_not_real"), "err was: {err}");
    // The error message also enumerates supported types — guard the
    // most stable canonical names against accidental drops.
    assert!(err.contains("openai_api"), "missing openai_api: {err}");
    assert!(
        err.contains("anthropic_api"),
        "missing anthropic_api: {err}"
    );
    assert!(err.contains("cursor_cli"), "missing cursor_cli: {err}");
}

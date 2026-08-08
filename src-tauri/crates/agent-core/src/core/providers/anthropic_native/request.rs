//! Shared HTTP request setup for Anthropic Messages API.
//!
//! Both the streaming and non-streaming paths construct exactly the same
//! `MessagesRequest` and use the same auth/header conventions; the only
//! difference is the `stream: bool` flag and what they do with the response
//! body. Centralizing the construction here keeps the two paths from
//! drifting on protocol details (anthropic-version, prompt-caching beta,
//! Azure Bearer vs x-api-key auth, extra header pass-through).

use serde_json::{json, Value};

use super::client::{AnthropicAuthMode, AnthropicClient};
use super::messages::extract_system;
use super::thinking::build_thinking_params;
use super::tools::convert_tools;
use super::types::MessagesRequest;
/// All inputs to a Messages API request, post-resolution.
///
/// The caller has already resolved the model alias and run the messages
/// through `extract_system` — this struct just bundles the result so the
/// streaming/non-streaming entry points can hand it to the request builder
/// without re-doing the same extraction.
pub(super) struct PreparedRequest {
    pub url: String,
    pub body: MessagesRequest,
    pub resolved_model: String,
}

/// Build the request body and resolve the URL/model for a chat call.
///
/// `stream` is the only thing that differs between the two paths — the
/// thinking/temperature/max_tokens triad is computed identically.
///
/// `skip_cache_write` suppresses all three `cache_control` breakpoints
/// (BP1 system, BP2 tools, BP3 history tail) for one-shot requests whose
/// prefix is never sent again — see [`crate::providers::traits::ChatOptions`].
#[allow(clippy::too_many_arguments)]
pub(super) fn prepare_request(
    client: &AnthropicClient,
    messages: &[Value],
    tools: Option<&[Value]>,
    model: &str,
    max_tokens: u32,
    temperature: f32,
    stream: bool,
    skip_cache_write: bool,
) -> PreparedRequest {
    // Strip the reasoning-level suffix ORG2 encodes into variant ids (e.g.
    // `claude-opus-4-8-thinking-xhigh`) — providers reject the suffixed
    // alias, and the decoded level drives thinking-mode parameter selection.
    let parsed = crate::providers::thinking_mode::parse_model_variant(model);
    let resolved_model =
        crate::providers::model_hints::wire_model_name(client.provider_spec, &parsed.base_model);
    let (system, anthropic_messages) = extract_system(messages, skip_cache_write);

    // Extract tool_choice override (from side_query structured output)
    // before converting tools to Anthropic format.
    let (tool_choice_override, clean_tools) = if let Some(t) = tools {
        let (ovr, cleaned) = crate::core::side_query::extract_tool_choice_override(t);
        (ovr, Some(cleaned))
    } else {
        (None, None)
    };
    let anthropic_tools = clean_tools
        .as_deref()
        .map(|tools| convert_tools(tools, skip_cache_write));

    let caps = crate::providers::model_capabilities::resolve(&resolved_model, None);
    let directive = if tool_choice_override.is_some() || clean_tools.is_some() {
        // When tools are present (including structured output), use Auto
        // directive — we want the model to respond, not suppress thinking.
        crate::providers::anthropic_native::thinking::ThinkingDirective::Auto
    } else {
        // Plain side queries: suppress thinking when possible.
        crate::providers::anthropic_native::thinking::ThinkingDirective::PlainText
    };
    let outcome = build_thinking_params(
        &resolved_model,
        parsed.level,
        parsed.thinking,
        directive,
        &caps,
        max_tokens,
        temperature,
    );
    let thinking = outcome.thinking;
    let effort = outcome.effort;
    let mut effective_temp = outcome.temperature;
    let effective_max_tokens = outcome.max_tokens;

    // Self-healing: once a model has rejected `temperature` with a 400
    // (`temperature is deprecated for this model`), never send it again —
    // for this model, for the rest of the process. See
    // `model_capabilities::temperature_unsupported`.
    if crate::providers::model_capabilities::temperature_unsupported(&resolved_model) {
        effective_temp = None;
    }

    let tool_choice = if let Some(ovr) = tool_choice_override {
        // Forced tool_choice from structured output
        Some(ovr)
    } else if clean_tools.is_some() {
        Some(json!({"type": "auto"}))
    } else {
        None
    };

    let output_config = claude_output_config(effort.as_deref());

    let body = MessagesRequest {
        model: resolved_model.clone(),
        max_tokens: effective_max_tokens,
        system: claude_oauth_system(system, client.auth_mode),
        messages: anthropic_messages,
        tools: anthropic_tools,
        tool_choice,
        temperature: effective_temp,
        stream,
        thinking,
        output_config,
        metadata: claude_oauth_metadata(client.auth_mode, &client.oauth_session_id),
    };

    PreparedRequest {
        url: client.messages_url(),
        body,
        resolved_model,
    }
}

const PROMPT_CACHING_BETA: &str = "prompt-caching-2024-07-31";
/// Required for `cache_control.ttl: "1h"` breakpoints (extended prompt
/// cache TTL); without this beta the API rejects the ttl field.
const EXTENDED_CACHE_TTL_BETA: &str = "extended-cache-ttl-2025-04-11";
const CLAUDE_CODE_BETA: &str = "claude-code-20250219";
const CLAUDE_OAUTH_BETA: &str = "oauth-2025-04-20";
const INTERLEAVED_THINKING_BETA: &str = "interleaved-thinking-2025-05-14";
const TOOL_STREAMING_BETA: &str = "fine-grained-tool-streaming-2025-05-14";
const EFFORT_BETA: &str = "effort-2025-11-24";
const CLAUDE_OAUTH_USER_AGENT: &str = "claude-cli/2.1.78 (orgii, cli)";

fn claude_output_config(effort: Option<&str>) -> Option<Value> {
    effort.map(|effort| json!({ "effort": effort }))
}

/// Whether requests for `model` may carry `output_config.effort`, and thus
/// need the effort beta. Mirrors the reference harness, which gates the beta
/// per model instead of sending it unconditionally — third-party
/// Anthropic-protocol gateways and non-effort models must not see it.
fn model_uses_effort_beta(model: &str, provider_name: &str) -> bool {
    use crate::providers::thinking_mode::{
        parse_model_variant, resolve_thinking_mode, ThinkingMode,
    };
    let parsed = parse_model_variant(model);
    matches!(
        resolve_thinking_mode(&parsed.base_model, provider_name),
        ThinkingMode::AnthropicAdaptive | ThinkingMode::Anthropic46
    )
}

/// Join a base beta list with the optional effort beta.
fn beta_header_value(base: &[&str], effort: bool) -> String {
    let mut parts: Vec<&str> = base.to_vec();
    if effort {
        parts.push(EFFORT_BETA);
    }
    parts.join(",")
}

/// Process-stable device id: the reference harness sends one device id per
/// install; a fresh random id on every request is an abuse-heuristic anomaly.
fn stable_device_id() -> &'static str {
    static DEVICE_ID: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    DEVICE_ID.get_or_init(|| uuid::Uuid::new_v4().simple().to_string().repeat(2))
}

fn claude_oauth_metadata(auth_mode: AnthropicAuthMode, session_id: &str) -> Option<Value> {
    if auth_mode != AnthropicAuthMode::ClaudeOauth {
        return None;
    }

    Some(json!({
        "user_id": json!({
            "device_id": stable_device_id(),
            "account_uuid": "",
            "session_id": session_id,
        })
        .to_string()
    }))
}

fn claude_oauth_system(system: Option<Value>, auth_mode: AnthropicAuthMode) -> Option<Value> {
    if auth_mode != AnthropicAuthMode::ClaudeOauth {
        return system;
    }

    let identity_block = json!({
        "type": "text",
        "text": "You are Claude Code, Anthropic's official CLI for Claude."
    });

    match system {
        Some(Value::Array(mut entries)) => {
            entries.insert(0, identity_block);
            Some(Value::Array(entries))
        }
        Some(existing) => Some(Value::Array(vec![identity_block, existing])),
        None => Some(Value::Array(vec![identity_block])),
    }
}

/// Apply the Anthropic-specific auth + header set to a `RequestBuilder`.
///
/// Direct Anthropic API keys use `x-api-key`; Azure AI Foundry and Claude
/// OAuth use Bearer auth but are separate modes because they require different
/// beta/header sets.
pub(super) fn apply_headers(
    client: &AnthropicClient,
    resolved_model: &str,
    builder: reqwest::RequestBuilder,
) -> reqwest::RequestBuilder {
    let mut req = builder
        .header("anthropic-version", "2023-06-01")
        .header("Content-Type", "application/json");

    // `extra_headers` (applied below) may carry a caller-supplied
    // `anthropic-beta`; never emit our own alongside it — reqwest appends
    // rather than replaces, and a duplicated beta header breaks requests.
    let beta_overridden = client.config.extra_headers.contains_key("anthropic-beta");
    let effort = model_uses_effort_beta(resolved_model, client.provider_spec.name);

    req = match client.auth_mode {
        AnthropicAuthMode::ApiKey => {
            let mut req = req.header("x-api-key", &client.config.api_key);
            if !beta_overridden {
                req = req.header(
                    "anthropic-beta",
                    beta_header_value(&[PROMPT_CACHING_BETA, EXTENDED_CACHE_TTL_BETA], effort),
                );
            }
            req
        }
        AnthropicAuthMode::AzureBearer => {
            let mut req = req.header("Authorization", format!("Bearer {}", client.config.api_key));
            if !beta_overridden {
                req = req.header(
                    "anthropic-beta",
                    beta_header_value(&[PROMPT_CACHING_BETA, EXTENDED_CACHE_TTL_BETA], effort),
                );
            }
            req
        }
        AnthropicAuthMode::ClaudeOauth => {
            let token = client
                .current_access_token()
                .unwrap_or_else(|_| client.config.api_key.clone());
            let mut req = req
                .header("Authorization", format!("Bearer {}", token))
                .header("accept-encoding", "identity")
                .header("User-Agent", CLAUDE_OAUTH_USER_AGENT)
                .header("x-app", "cli");
            if !beta_overridden {
                req = req.header(
                    "anthropic-beta",
                    beta_header_value(
                        &[
                            CLAUDE_CODE_BETA,
                            CLAUDE_OAUTH_BETA,
                            INTERLEAVED_THINKING_BETA,
                            TOOL_STREAMING_BETA,
                            EXTENDED_CACHE_TTL_BETA,
                        ],
                        effort,
                    ),
                );
            }
            req
        }
    };

    for (key, value) in &client.config.extra_headers {
        req = req.header(key, value);
    }
    req
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_oauth_metadata_matches_claude_code_shape() {
        let session_id = uuid::Uuid::new_v4().to_string();
        let metadata = claude_oauth_metadata(AnthropicAuthMode::ClaudeOauth, &session_id)
            .expect("Claude OAuth requests include metadata");
        let user_id = metadata["user_id"]
            .as_str()
            .expect("user_id is JSON string");
        let parsed: Value = serde_json::from_str(user_id).expect("user_id parses as JSON");

        assert_eq!(parsed["device_id"].as_str().unwrap().len(), 64);
        assert_eq!(parsed["account_uuid"], "");
        assert_eq!(parsed["session_id"].as_str().unwrap(), session_id);
    }

    #[test]
    fn claude_oauth_metadata_ids_are_stable_across_requests() {
        let first = claude_oauth_metadata(AnthropicAuthMode::ClaudeOauth, "sess-1").unwrap();
        let second = claude_oauth_metadata(AnthropicAuthMode::ClaudeOauth, "sess-1").unwrap();
        // Same session + same install → byte-identical metadata (the
        // reference harness fingerprint is stable, not per-request random).
        assert_eq!(first, second);
    }

    #[test]
    fn api_key_requests_do_not_include_claude_oauth_metadata() {
        assert!(claude_oauth_metadata(AnthropicAuthMode::ApiKey, "sess-1").is_none());
    }

    #[test]
    fn claude_oauth_system_prepends_identity_without_dropping_existing_blocks() {
        let original = json!([
            {
                "type": "text",
                "text": "ORGII system prompt",
                "cache_control": { "type": "ephemeral" }
            }
        ]);

        let system = claude_oauth_system(Some(original), AnthropicAuthMode::ClaudeOauth)
            .expect("Claude OAuth requests always include system");
        let entries = system.as_array().expect("system remains an array");

        assert_eq!(entries.len(), 2);
        assert_eq!(
            entries[0]["text"],
            "You are Claude Code, Anthropic's official CLI for Claude."
        );
        assert!(entries[0].get("cache_control").is_none());
        assert_eq!(entries[1]["text"], "ORGII system prompt");
        assert_eq!(entries[1]["cache_control"]["type"], "ephemeral");
    }

    #[test]
    fn api_key_system_is_not_rewritten() {
        let original = json!([{ "type": "text", "text": "ORGII system prompt" }]);
        let system = claude_oauth_system(Some(original.clone()), AnthropicAuthMode::ApiKey);

        assert_eq!(system, Some(original));
    }

    #[test]
    fn claude_output_config_nests_effort_for_messages_api() {
        assert_eq!(
            claude_output_config(Some("high")),
            Some(json!({ "effort": "high" }))
        );
        assert_eq!(claude_output_config(None), None);
    }

    #[test]
    fn effort_beta_is_gated_per_model() {
        assert!(model_uses_effort_beta("claude-opus-4-8", "anthropic"));
        assert!(model_uses_effort_beta("claude-opus-5", "anthropic"));
        assert!(model_uses_effort_beta("claude-fable-5", "anthropic"));
        assert!(model_uses_effort_beta("claude-sonnet-4-6", "anthropic"));
        assert!(!model_uses_effort_beta("claude-haiku-4-5", "anthropic"));
        assert!(model_uses_effort_beta("claude-sonnet-5", "anthropic"));
        assert!(!model_uses_effort_beta("gpt-5.4", "openai"));
    }

    #[test]
    fn beta_header_value_appends_effort_only_when_enabled() {
        assert_eq!(
            beta_header_value(&[PROMPT_CACHING_BETA], false),
            PROMPT_CACHING_BETA
        );
        assert_eq!(
            beta_header_value(&[PROMPT_CACHING_BETA], true),
            format!("{PROMPT_CACHING_BETA},{EFFORT_BETA}")
        );
    }

    /// `key_vault::model_supports_output_config_effort` (drives which effort
    /// ladders the UI synthesizes) must agree with the wire-level effort gate
    /// here, or the UI offers ladders the provider will not honor. Update
    /// `key_vault`'s list and `thinking_mode`'s classification together.
    #[test]
    fn effort_capability_stays_in_lockstep_with_key_vault() {
        for model in [
            "claude-fable-5",
            "claude-opus-5",
            "claude-opus-4-8",
            "claude-opus-4-7",
            "claude-opus-4-6",
            "claude-sonnet-4-6",
            "claude-sonnet-5",
            "claude-haiku-4-5",
            "claude-opus-4-5",
        ] {
            assert_eq!(
                key_vault::commands::model_supports_output_config_effort(model),
                model_uses_effort_beta(model, "anthropic"),
                "effort capability drift for {model}"
            );
        }
    }

    #[test]
    fn claude_oauth_user_agent_uses_claude_cli_semver_shape() {
        assert!(CLAUDE_OAUTH_USER_AGENT.starts_with("claude-cli/"));
        let version = CLAUDE_OAUTH_USER_AGENT
            .strip_prefix("claude-cli/")
            .unwrap()
            .split(' ')
            .next()
            .unwrap();
        let parts: Vec<&str> = version.split('.').collect();
        assert_eq!(parts.len(), 3);
        assert!(parts.iter().all(|part| part.parse::<u64>().is_ok()));
    }
}

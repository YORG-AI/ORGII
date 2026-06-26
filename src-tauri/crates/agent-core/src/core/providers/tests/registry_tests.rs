use crate::providers::model_hints::*;
use crate::providers::registry::*;

#[test]
fn guess_provider_by_model_anthropic() {
    let spec = guess_provider_by_model("claude-sonnet-4-20250514").unwrap();
    assert_eq!(spec.name, "anthropic");
}

#[test]
fn guess_provider_by_model_openai() {
    let spec = guess_provider_by_model("gpt-4o-mini").unwrap();
    assert_eq!(spec.name, "openai");
}

#[test]
fn guess_provider_by_model_deepseek() {
    let spec = guess_provider_by_model("deepseek-r1").unwrap();
    assert_eq!(spec.name, "deepseek");
}

#[test]
fn guess_provider_by_model_gemini() {
    let spec = guess_provider_by_model("gemini-2.0-flash").unwrap();
    assert_eq!(spec.name, "gemini");
}

#[test]
fn guess_provider_by_model_case_insensitive() {
    assert!(guess_provider_by_model("Claude-Sonnet-4").is_some());
    assert!(guess_provider_by_model("GPT-4O").is_some());
}

#[test]
fn guess_provider_by_model_unknown_returns_none() {
    assert!(guess_provider_by_model("totally-unknown-model-xyz").is_none());
}

#[test]
fn find_by_name_known() {
    assert_eq!(find_by_name("anthropic").unwrap().display_name, "Anthropic");
    assert_eq!(find_by_name("groq").unwrap().display_name, "Groq");
}

#[test]
fn find_by_name_unknown() {
    assert!(find_by_name("nonexistent").is_none());
}

#[test]
fn normalize_already_prefixed() {
    assert_eq!(
        normalize_claude_shorthand("claude-sonnet-4"),
        "claude-sonnet-4"
    );
}

#[test]
fn normalize_shorthand_sonnet() {
    assert_eq!(
        normalize_claude_shorthand("sonnet-4.5"),
        "claude-sonnet-4.5"
    );
}

#[test]
fn normalize_shorthand_haiku() {
    assert_eq!(normalize_claude_shorthand("haiku-3.5"), "claude-haiku-3.5");
}

#[test]
fn normalize_shorthand_opus() {
    assert_eq!(normalize_claude_shorthand("opus-4"), "claude-opus-4");
}

#[test]
fn normalize_non_claude_passthrough() {
    assert_eq!(normalize_claude_shorthand("gpt-4o"), "gpt-4o");
}

#[test]
fn context_window_hint_claude_models() {
    assert_eq!(context_window_hint("claude-sonnet-4-20250514"), 200_000);
    assert_eq!(context_window_hint("claude-opus-4.5"), 1_000_000);
    assert_eq!(context_window_hint("claude-3-5-sonnet"), 200_000);
}

#[test]
fn context_window_hint_gpt_models() {
    assert_eq!(context_window_hint("gpt-4o"), 128_000);
    assert_eq!(context_window_hint("gpt-4.1-mini"), 1_000_000);
    assert_eq!(context_window_hint("gpt-5"), 1_000_000);
}

#[test]
fn context_window_hint_gemini() {
    assert_eq!(context_window_hint("gemini-2.0-flash"), 1_000_000);
}

#[test]
fn context_window_hint_unknown_returns_default() {
    assert_eq!(
        context_window_hint("totally-unknown"),
        200_000 // ModelCapabilities::unknown().context_window
    );
}

#[test]
fn context_window_hint_normalizes_shorthand() {
    assert_eq!(context_window_hint("sonnet-4"), 200_000);
}

#[test]
fn wire_model_name_strips_prefix() {
    let spec = find_by_name("anthropic").unwrap();
    assert_eq!(
        wire_model_name(spec, "anthropic/claude-sonnet-4-20250514"),
        "claude-sonnet-4-20250514"
    );
}

#[test]
fn deepseek_default_api_base_matches_docs() {
    let spec = find_by_name("deepseek").unwrap();
    assert_eq!(spec.default_api_base, Some("https://api.deepseek.com"));
}

#[test]
fn wire_model_name_keeps_direct_deepseek_model_bare() {
    let spec = find_by_name("deepseek").unwrap();
    assert_eq!(wire_model_name(spec, "deepseek-r1"), "deepseek-r1");
}

#[test]
fn wire_model_name_strips_stale_deepseek_prefix() {
    let spec = find_by_name("deepseek").unwrap();
    assert_eq!(wire_model_name(spec, "deepseek/deepseek-r1"), "deepseek-r1");
}

#[test]
fn wire_model_name_keeps_direct_deepseek_v4_bare() {
    let spec = find_by_name("deepseek").unwrap();
    assert_eq!(
        wire_model_name(spec, "deepseek/deepseek-v4-pro"),
        "deepseek-v4-pro"
    );
}

#[test]
fn wire_model_name_normalizes_shorthand() {
    let spec = find_by_name("anthropic").unwrap();
    assert_eq!(wire_model_name(spec, "sonnet-4.5"), "claude-sonnet-4.5");
}

#[test]
fn fast_model_hint_for_claude() {
    assert!(fast_model_hint("claude-sonnet-4").contains("haiku"));
}

#[test]
fn fast_model_hint_for_gpt() {
    assert!(fast_model_hint("gpt-4o").contains("gpt-4o-mini"));
}

#[test]
fn fast_model_hint_for_gemini() {
    assert!(fast_model_hint("gemini-2.0-pro").contains("flash"));
}

#[test]
fn fast_model_hint_for_deepseek() {
    assert!(fast_model_hint("deepseek-r1").contains("deepseek-chat"));
}

#[test]
fn fast_model_hint_unknown_returns_self() {
    assert_eq!(fast_model_hint("custom-model"), "custom-model");
}

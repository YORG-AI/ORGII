use super::{discovered_model_from_anthropic, AnthropicValidator, ModelInfo};

#[test]
fn test_validate_format() {
    let validator = AnthropicValidator::new();

    let (valid, _) = validator.validate_format("sk-ant-1234567890abcdefghij");
    assert!(valid);

    let (valid, _) = validator.validate_format("sk_1234567890abcdefghij");
    assert!(valid);

    let (valid, _) = validator.validate_format("invalid-key");
    assert!(!valid);
}

#[test]
fn parses_current_anthropic_model_capabilities() {
    let model: ModelInfo = serde_json::from_value(serde_json::json!({
        "id": "claude-opus-5",
        "display_name": "Claude Opus 5",
        "max_input_tokens": 1_000_000,
        "max_tokens": 128_000,
        "capabilities": {
            "effort": {
                "supported": true,
                "low": { "supported": true },
                "medium": { "supported": true },
                "high": { "supported": true },
                "xhigh": { "supported": true },
                "max": { "supported": true }
            },
            "thinking": {
                "supported": true,
                "types": {
                    "adaptive": { "supported": true },
                    "enabled": { "supported": false }
                }
            }
        }
    }))
    .expect("Anthropic model response");

    let discovered = discovered_model_from_anthropic(model);
    assert_eq!(discovered.id, "claude-opus-5");
    assert_eq!(discovered.display_name.as_deref(), Some("Claude Opus 5"));
    assert_eq!(discovered.context_window, Some(1_000_000));
    assert_eq!(discovered.max_output_tokens, Some(128_000));
    assert_eq!(
        discovered.supported_efforts,
        vec!["low", "medium", "high", "xhigh", "max"]
    );
    assert!(discovered.supports_adaptive_thinking);
    assert!(!discovered.supports_manual_thinking);
}

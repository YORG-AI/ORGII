use crate::providers::openai::OpenAIValidator;

#[test]
fn discovery_retains_astra_and_its_context_without_widening_other_providers() {
    let payload = serde_json::json!({"data": [
        {"id": "gpt-6-astra", "context_length": 1_050_000},
        {"id": "gpt-5.6-sol"},
        {"id": "text-embedding-3-large", "context_length": 8192},
        {"id": "deepseek-chat"}
    ]});
    for provider in [None, Some("openai_api")] {
        let (models, contexts) = OpenAIValidator::filter_models(
            serde_json::from_value(payload.clone()).unwrap(),
            false,
            provider,
        );
        assert_eq!(models, vec!["gpt-6-astra", "gpt-5.6-sol"]);
        assert_eq!(contexts.get("gpt-6-astra"), Some(&1_050_000));
        assert_eq!(contexts.len(), 1);
    }
    let (models, _) = OpenAIValidator::filter_models(
        serde_json::from_value(payload.clone()).unwrap(),
        false,
        Some("deepseek_api"),
    );
    assert_eq!(models, vec!["deepseek-chat"]);
    let (models, contexts) = OpenAIValidator::filter_models(
        serde_json::from_value(payload).unwrap(),
        true,
        Some("openai_api"),
    );
    assert_eq!(models.len(), 4);
    assert_eq!(contexts.len(), 2);
}

#[test]
fn test_validate_format() {
    let validator = OpenAIValidator::new();

    let (valid, _) = validator.validate_format("sk-1234567890abcdefghij");
    assert!(valid);

    let (valid, _) = validator.validate_format("sk-proj-1234567890");
    assert!(valid);

    let (valid, _) = validator.validate_format("invalid-key");
    assert!(!valid);

    let (valid, _) = validator.validate_format("");
    assert!(!valid);
}

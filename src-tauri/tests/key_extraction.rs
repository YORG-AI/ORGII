//! Integration test: key_vault::key_extractor end-to-end
//!
//! Tests the full key extraction pipeline across different agent types,
//! verifying that key extraction + URL scoring + agent-type auto-derivation
//! work together correctly for realistic inputs.

use key_vault::key_extractor::{extract_keys, ExtractionResult};

fn assert_high_confidence(result: &ExtractionResult) {
    assert_eq!(
        result.confidence, "high",
        "expected high confidence, got: {}",
        result.confidence
    );
}

#[test]
fn multi_agent_extraction_from_same_input_format() {
    let template = |key: &str, url: &str| {
        format!("卡号：{key}\n密码：\nhttps://docs.example.com/guide\n{url}")
    };

    let codex_input = template(
        "sk-testkey000000000000000000",
        "https://proxy.example.com/api/codex/v1",
    );
    let codex_result = extract_keys(&codex_input, Some("codex"));
    assert_high_confidence(&codex_result);
    assert!(codex_result.api_key.is_some());
    assert_eq!(
        codex_result.base_url.as_deref(),
        Some("https://proxy.example.com/api/codex/v1")
    );

    let gemini_input = template(
        "sk-testkey000000000000000000",
        "https://proxy.example.com/api/gemini/v1",
    );
    let gemini_result = extract_keys(&gemini_input, Some("gemini_api"));
    assert_high_confidence(&gemini_result);
    assert_eq!(
        gemini_result.base_url.as_deref(),
        Some("https://proxy.example.com/api/gemini/v1")
    );
}

#[test]
fn extraction_rejects_documentation_urls() {
    let doc_urls = [
        "https://docs.example.com/getting-started",
        "https://example.com/wiki/setup#installation",
        "https://nzrio8u1kt.feishu.cn/wiki/something?singleDoc#guide",
    ];

    for doc_url in &doc_urls {
        let input = format!("sk-test1234567890abcdefghijklmnopqrstuvwxyz\n{}", doc_url);
        let result = extract_keys(&input, Some("codex"));
        assert!(
            result.base_url.is_none(),
            "doc URL {doc_url} should not be picked as base_url, got: {:?}",
            result.base_url
        );
    }
}

#[test]
fn auto_detect_differentiates_key_formats() {
    let anthropic_key = "sk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let anthropic = extract_keys(anthropic_key, None);
    assert_eq!(anthropic.key_type.as_deref(), Some("anthropic"));

    let generic_key = "sk-proj-testkey000000000000000";
    let generic = extract_keys(generic_key, None);
    assert_eq!(generic.key_type.as_deref(), Some("unknown"));
}

#[test]
fn agent_type_hint_overrides_auto_detection() {
    let key = "sk-test1234567890abcdefghijklmnopqrstuvwxyz";
    let api_url = "https://proxy.example.com/api/v1";
    let input = format!("{key}\n{api_url}");

    let without_hint = extract_keys(&input, None);
    let with_codex = extract_keys(&input, Some("codex"));

    assert!(without_hint.api_key.is_some());
    assert!(with_codex.api_key.is_some());
    assert_eq!(with_codex.key_type.as_deref(), Some("codex"));
}

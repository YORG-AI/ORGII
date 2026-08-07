use crate::key_extractor::{
    derive_search_terms, extract_keys, fuzzy_score, score_url, URL_MIN_SCORE,
};

#[test]
fn test_anthropic_key_extraction() {
    let input = r#"Claude Key:KEY：sk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
环境变量中配置 ANTHROPIC_BASE_URL = "https://proxy.example.com/api""#;

    let result = extract_keys(input, Some("claude_code"));
    insta::assert_yaml_snapshot!("anthropic_key", result);
}

#[test]
fn test_gemini_proxy_key_extraction() {
    let input = r#"卡号：sk-testkey1234567890abcdefghijklmnopqrstuvwxyz1234
密码：
https://example.com/tutorial"#;

    let result = extract_keys(input, Some("gemini_api"));
    insta::assert_yaml_snapshot!("gemini_proxy_key", result);
}

#[test]
fn test_auto_detect_anthropic() {
    let input = "My key is sk_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    let result = extract_keys(input, None);
    insta::assert_yaml_snapshot!("auto_detect_anthropic", result);
}

#[test]
fn test_auto_detect_generic_sk() {
    let input = "Use this key: sk-proj-testkey000000000000000";
    let result = extract_keys(input, None);
    insta::assert_yaml_snapshot!("auto_detect_generic_sk", result);
}

#[test]
fn test_base_url_with_chinese() {
    let input = "ANTHROPIC_BASE_URL = \u{201C}https://api.example.com\u{201D}";
    let result = extract_keys(input, None);
    assert_eq!(result.base_url, Some("https://api.example.com".to_string()));
}

// ── URL scoring tests ──────────────────────────────────────────

#[test]
fn test_codex_messy_chinese_input() {
    let input = r#"订单编号：3220005651050105891
nexus_42
sk-testkey000000000000000000


8号车 Nexus
8号车 Nexus
8号车 Nexus

文档：https://cc.yoouu.cn/
余额查询：https://nexus.itssx.com/key-query

https://nexusacc.itssx.com/api/codex/codex

闲鱼订单好评加 6 刀"#;

    let result = extract_keys(input, Some("codex"));
    insta::assert_yaml_snapshot!("codex_messy_chinese", result);
}

#[test]
fn test_non_api_urls_filtered() {
    let input = r#"sk-test1234567890abcdefghijklmnopqrstuvwxyz
https://example.com/key-query
https://example.com/docs/getting-started
https://api.example.com/api/codex/v1"#;

    let result = extract_keys(input, Some("codex"));
    insta::assert_yaml_snapshot!("non_api_urls_filtered", result);
}

#[test]
fn test_scoring_picks_best_among_many_urls() {
    let input = r#"sk-test1234567890abcdefghijklmnopqrstuvwxyz

Homepage: https://proxy.example.com/
Docs:     https://proxy.example.com/docs/setup
Status:   https://proxy.example.com/status
API:      https://proxy.example.com/api/v1/claude"#;

    let result = extract_keys(input, Some("claude_code"));
    assert_eq!(
        result.base_url,
        Some("https://proxy.example.com/api/v1/claude".to_string())
    );
}

#[test]
fn test_scoring_api_subdomain_bonus() {
    let input = r#"sk-test1234567890abcdefghijklmnopqrstuvwxyz
https://www.example.com/gemini
https://api.example.com/gemini"#;

    let result = extract_keys(input, Some("gemini_api"));
    assert_eq!(
        result.base_url,
        Some("https://api.example.com/gemini".to_string())
    );
}

#[test]
fn test_scoring_no_url_above_threshold() {
    let input = r#"sk-test1234567890abcdefghijklmnopqrstuvwxyz
https://example.com/
https://example.com/docs
https://example.com/blog/announcement"#;

    let result = extract_keys(input, Some("codex"));
    assert!(result.api_key.is_some());
    assert!(result.base_url.is_none());
}

#[test]
fn test_scoring_secondary_keyword_boost() {
    let input = r#"sk-test1234567890abcdefghijklmnopqrstuvwxyz
https://random-proxy.com/service
https://random-proxy.com/openai/v1"#;

    let result = extract_keys(input, Some("codex"));
    assert_eq!(
        result.base_url,
        Some("https://random-proxy.com/openai/v1".to_string())
    );
}

#[test]
fn test_scoring_claude_proxy_with_neutral_proxy() {
    let input = r#"sk_cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
https://docs.example-claude-proxy.test/guide
https://api.example-claude-proxy.test/api/v1"#;

    let result = extract_keys(input, Some("claude_code"));
    assert_eq!(
        result.base_url,
        Some("https://api.example-claude-proxy.test/api/v1".to_string())
    );
}

#[test]
fn test_scoring_no_agent_type_still_works() {
    let input = r#"sk-test1234567890abcdefghijklmnopqrstuvwxyz
https://example.com/
https://proxy.example.com/api/v1/chat"#;

    let result = extract_keys(input, None);
    assert!(result.api_key.is_some());
    assert_eq!(
        result.base_url,
        Some("https://proxy.example.com/api/v1/chat".to_string())
    );
}

#[test]
fn test_key_adjacent_to_chinese_no_separator() {
    let input = "密钥sk-b166e6c00f9246f4bda823196826815c\n吉米 cli 使用文档：\nhttps://nzrio8u1kt.feishu.cn/wiki/Tvbgwa8Tfi2HfQkN5jocurxInbf?from=from_copylink";

    let result = extract_keys(input, Some("codex"));
    insta::assert_yaml_snapshot!("key_adjacent_chinese", result);
}

#[test]
fn test_gemini_proxy_key_with_yuque_docs() {
    let input = "卡号：sk-testgemini000000000000000\n密码：\nhttps://www.yuque.com/yeweiyang-egjcx/fmgce5/wb12f08va3xakgwu?singleDoc# 《gemini api接入教程》";

    let result = extract_keys(input, Some("gemini_api"));
    insta::assert_yaml_snapshot!("gemini_yuque_docs", result);
}

#[test]
fn test_score_url_unit() {
    let api_score = score_url("https://api.example.com/api/codex/v1", Some("codex"));
    assert!(
        api_score > 10.0,
        "API URL should score high, got {}",
        api_score
    );

    let docs_score = score_url("https://example.com/docs", Some("codex"));
    assert!(
        docs_score < 0.0,
        "Docs URL should score negative, got {}",
        docs_score
    );

    let root_score = score_url("https://example.com/", Some("codex"));
    assert!(
        root_score < URL_MIN_SCORE,
        "Root URL should be below threshold, got {}",
        root_score
    );

    let query_score = score_url("https://example.com/key-query", Some("codex"));
    assert!(
        query_score < URL_MIN_SCORE,
        "Utility URL should be below threshold, got {}",
        query_score
    );

    let wiki_score = score_url("https://example.com/wiki/page#section", Some("codex"));
    assert!(
        wiki_score < 0.0,
        "Wiki URL should score negative, got {}",
        wiki_score
    );
}

#[test]
fn test_derive_search_terms() {
    assert_eq!(derive_search_terms("codex"), vec!["codex"]);
    assert_eq!(derive_search_terms("claude_code"), vec!["claude"]);
    assert_eq!(derive_search_terms("gemini_api"), vec!["gemini"]);
    assert_eq!(derive_search_terms("cursor_cli"), vec!["cursor"]);
    assert_eq!(derive_search_terms("copilot"), vec!["copilot"]);
    assert_eq!(derive_search_terms("kiro"), vec!["kiro"]);

    assert_eq!(derive_search_terms("mistral_cli"), vec!["mistral"]);
    assert_eq!(derive_search_terms("llama_code"), vec!["llama"]);
    assert_eq!(derive_search_terms("deepseek"), vec!["deepseek"]);
}

#[test]
fn test_fuzzy_match_agent_to_url() {
    assert!(fuzzy_score("codex", "codex").is_some());
    assert!(fuzzy_score("gemini", "geminicode").is_some());
    assert!(fuzzy_score("codex", "feishu").is_none());
}

#[test]
fn test_unknown_future_agent_works() {
    let input = r#"sk-test1234567890abcdefghijklmnopqrstuvwxyz
https://example.com/docs/setup
https://proxy.example.com/api/v1/mistral"#;

    let result = extract_keys(input, Some("mistral_cli"));
    assert_eq!(
        result.base_url,
        Some("https://proxy.example.com/api/v1/mistral".to_string())
    );
}

#[test]
fn test_claude_neutral_proxy_input() {
    let input = "3178873309230105891Claude Key 100 credit/month card:KEY：sk_dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\n教程请查看https://example-claude-proxy.test/admin-next/api-stats；\n环境变量中配置 ANTHROPIC_BASE_URL = \"https://example-claude-proxy.test/api\"";

    let result = extract_keys(input, Some("claude_code"));
    insta::assert_yaml_snapshot!("claude_neutral_proxy", result);

    let stats_score = score_url(
        "https://example-claude-proxy.test/admin-next/api-stats",
        Some("claude_code"),
    );
    let api_score = score_url("https://example-claude-proxy.test/api", Some("claude_code"));
    assert!(api_score > stats_score);
}

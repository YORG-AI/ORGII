use crate::specialization::policies::{parse_source, PolicySource};
use crate::tool_infra::slugify;

// -- slugify --

#[test]
fn slugify_basic() {
    assert_eq!(slugify("My Cool Rule"), "my-cool-rule");
}

#[test]
fn slugify_special_chars() {
    assert_eq!(slugify("rule_v2.0 (draft)"), "rule-v2-0-draft");
}

#[test]
fn slugify_already_clean() {
    assert_eq!(slugify("clean-name"), "clean-name");
}

#[test]
fn slugify_consecutive_separators() {
    assert_eq!(slugify("a---b___c"), "a-b-c");
}

#[test]
fn slugify_leading_trailing_separators() {
    assert_eq!(slugify("--hello--"), "hello");
}

#[test]
fn slugify_empty() {
    assert_eq!(slugify(""), "");
}

#[test]
fn slugify_unicode() {
    let result = slugify("café règle");
    assert!(result.starts_with("caf"));
    assert!(!result.contains(' '));
    assert!(!result.contains('é'));
}

// -- parse_source --

#[test]
fn parse_source_global() {
    assert_eq!(parse_source("global").unwrap(), PolicySource::Global);
}

#[test]
fn parse_source_workspace() {
    assert_eq!(parse_source("workspace").unwrap(), PolicySource::Workspace);
}

#[test]
fn parse_source_unknown_errors() {
    let err = parse_source("local").unwrap_err();
    assert!(err.contains("Unknown policy source"));
}

// -- PolicySource serde --

#[test]
fn policy_source_serde() {
    let json = serde_json::to_string(&PolicySource::Global).unwrap();
    assert_eq!(json, "\"global\"");
    let parsed: PolicySource = serde_json::from_str("\"workspace\"").unwrap();
    assert_eq!(parsed, PolicySource::Workspace);
}

// -- E2E: migrated Simon rules actually load into os-agent prompt data --
// 验证 Phase 7 迁移的 personal rules 在运行时被 os_agent loader 读出（不只是 frontmatter 单测）。
#[test]
#[serial_test::serial]
fn migrated_personal_rules_load_for_os_agent_e2e() {
    use crate::specialization::policies::load_enabled_policies_for_os_agent;
    use std::io::Write;

    let tmp = tempfile::tempdir().unwrap();
    // ORGII_HOME 直接替代 orgii_root，personal rules = ORGII_HOME/personal/rules
    let rules_dir = tmp.path().join("personal/rules");
    std::fs::create_dir_all(&rules_dir).unwrap();
    let mut f = std::fs::File::create(rules_dir.join("00-core-constraints.md")).unwrap();
    f.write_all(b"---\npaths: []\n---\n\n# core\n\nNEVER fallback. NEVER timeout. setsid nohup for background.")
        .unwrap();
    let mut g = std::fs::File::create(rules_dir.join("01-user-profile.md")).unwrap();
    g.write_all(b"---\npaths: []\n---\n\n# profile\n\nDefault model is sonnet-4.6.")
        .unwrap();

    let prev = std::env::var("ORGII_HOME").ok();
    std::env::set_var("ORGII_HOME", tmp.path());

    let rules = load_enabled_policies_for_os_agent("opus");

    // restore env before asserting
    match prev {
        Some(v) => std::env::set_var("ORGII_HOME", v),
        None => std::env::remove_var("ORGII_HOME"),
    }

    let joined: String = rules.iter().map(|(_, c)| c.clone()).collect::<Vec<_>>().join("\n");
    assert!(rules.len() >= 2, "expected >=2 loaded rules, got {}", rules.len());
    assert!(joined.contains("NEVER fallback"), "core constraint not loaded into prompt data");
    assert!(joined.contains("setsid"), "setsid rule not loaded");
    assert!(joined.contains("sonnet-4.6"), "model preference not loaded");
}

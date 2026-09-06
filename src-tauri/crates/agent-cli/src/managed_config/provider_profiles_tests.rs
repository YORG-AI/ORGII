use super::tests::{OrgiiHomeGuard, TEST_ENV_LOCK};
use super::{claude_models::*, provider_profiles::*, *};
use std::{collections::BTreeMap, sync::Mutex};

fn profile(target: &str) -> HarnessProviderProfile {
    HarnessProviderProfile {
        id: "fixture-profile".into(),
        revision: 0,
        name: "Gateway profile".into(),
        target: target.into(),
        key_id: "vault-reference".into(),
        endpoint: "https://gateway.example/prefix".into(),
        auth_scheme: "x-api-key".into(),
        models: super::profile_models::ProfileModels::Claude(ClaudeModels {
            default_role: ClaudeRole::Opus,
            roles: [
                ClaudeRole::Sonnet,
                ClaudeRole::Opus,
                ClaudeRole::Fable,
                ClaudeRole::Haiku,
            ]
            .into_iter()
            .map(|role| {
                (
                    role,
                    ClaudeModel {
                        model: format!("vendor/{}-request", role.as_str()),
                        display_name: format!("{} display", role.as_str()),
                        context_1m: role == ClaudeRole::Opus,
                    },
                )
            })
            .collect(),
        }),
    }
}
fn connection(profile: HarnessProviderProfile) -> DirectConnection {
    DirectConnection {
        key_id: profile.key_id.clone(),
        provider: "custom_api".into(),
        model: profile.models.default_model().unwrap().to_string(),
        base_url: profile.endpoint.clone(),
        api_key: "synthetic-native-secret".into(),
        desktop_auth_scheme: (profile.target == "claude_desktop")
            .then(|| profile.auth_scheme.clone()),
        profile: Some(profile),
    }
}
struct ExternalHome(Option<std::ffi::OsString>);
impl ExternalHome {
    fn set(path: &std::path::Path) -> Self {
        let old = std::env::var_os("ORGII_EXTERNAL_HISTORY_HOME");
        std::env::set_var("ORGII_EXTERNAL_HISTORY_HOME", path);
        Self(old)
    }
}
impl Drop for ExternalHome {
    fn drop(&mut self) {
        if let Some(value) = self.0.take() {
            std::env::set_var("ORGII_EXTERNAL_HISTORY_HOME", value);
        } else {
            std::env::remove_var("ORGII_EXTERNAL_HISTORY_HOME");
        }
    }
}

#[test]
fn cli_writer_maps_all_roles_and_clears_stale_capabilities_without_leaking_labels_into_ids() {
    let mut p = profile("claude_code");
    p.models.claude_mut().unwrap().roles.insert(
        ClaudeRole::Subagent,
        ClaudeModel {
            model: "vendor/worker".into(),
            display_name: "".into(),
            context_1m: true,
        },
    );
    let original = r#"{"permissions":{"allow":["Read"]},"env":{"ANTHROPIC_DEFAULT_FABLE_MODEL":"old","ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES":"thinking","ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME":"old label","CLAUDE_CODE_SUBAGENT_MODEL":"old","KEEP":"value"}}"#;
    let generated = direct::generate_direct_configs(
        "claude_code",
        &BTreeMap::from([("settings".into(), original.into())]),
        &connection(p),
        None,
    )
    .unwrap();
    let value: serde_json::Value = serde_json::from_str(&generated["settings"]).unwrap();
    let env = &value["env"];
    assert_eq!(env["ANTHROPIC_API_KEY"], "synthetic-native-secret");
    assert!(env.get("ANTHROPIC_AUTH_TOKEN").is_none());
    assert_eq!(
        env["ANTHROPIC_DEFAULT_OPUS_MODEL"],
        "vendor/opus-request[1m]"
    );
    assert_eq!(env["ANTHROPIC_DEFAULT_OPUS_MODEL_NAME"], "opus display");
    assert_eq!(env["ANTHROPIC_DEFAULT_FABLE_MODEL"], "vendor/fable-request");
    assert_eq!(env["CLAUDE_CODE_SUBAGENT_MODEL"], "vendor/worker[1m]");
    assert!(env
        .get("ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES")
        .is_none());
    assert_eq!(env["ANTHROPIC_MODEL"], "opus");
    assert_eq!(value["model"], "opus");
    assert_eq!(env["KEEP"], "value");
    assert_eq!(value["permissions"]["allow"][0], "Read");
}
#[test]
fn desktop_uses_native_family_tiers_exact_ids_and_default_order_even_when_ids_repeat() {
    let mut p = profile("claude_desktop");
    for entry in p.models.claude_mut().unwrap().roles.values_mut() {
        entry.model = "vendor/shared".into();
    }
    let generated = desktop::generate(&BTreeMap::new(), &connection(p), None).unwrap();
    let value: serde_json::Value = serde_json::from_str(&generated["profile"]).unwrap();
    let models = value["inferenceModels"].as_array().unwrap();
    assert_eq!(models.len(), 4);
    assert_eq!(models[0]["anthropicFamilyTier"], "opus");
    assert_eq!(models[0]["supports1m"], true);
    assert_eq!(models[0]["labelOverride"], "opus display");
    assert!(models
        .iter()
        .all(|m| m["name"] == "vendor/shared" && m["isFamilyDefault"] == true));
    assert_eq!(value["modelDiscoveryEnabled"], false);
}
#[test]
fn invalid_profiles_are_rejected_before_persistence() {
    let original = profile("claude_code");
    for endpoint in [
        "https://user:secret@example.com",
        "https://example.com?key=secret",
        "file:///tmp/config",
    ] {
        let mut p = original.clone();
        p.endpoint = endpoint.into();
        assert!(save(p).is_err());
    }
    let mut p = original.clone();
    p.target = "codex".into();
    assert!(save(p).is_err());
    let mut p = original.clone();
    p.models
        .claude_mut()
        .unwrap()
        .roles
        .remove(&ClaudeRole::Fable);
    assert!(save(p).is_err());
    let mut p = original.clone();
    p.models
        .claude_mut()
        .unwrap()
        .roles
        .get_mut(&ClaudeRole::Sonnet)
        .unwrap()
        .model = "injected\nmodel".into();
    assert!(save(p).is_err());
    let mut p = original.clone();
    p.models.claude_mut().unwrap().default_role = ClaudeRole::Subagent;
    assert!(save(p).is_err());
    let mut p = original;
    p.auth_scheme = "unknown".into();
    assert!(save(p).is_err());
}
#[test]
fn save_apply_switch_and_restore_keep_catalog_and_native_state_independent() {
    let _lock = TEST_ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let temp = tempfile::tempdir().unwrap();
    let _home = OrgiiHomeGuard::set(&temp.path().join("orgii"));
    let _external = ExternalHome::set(temp.path());
    let settings = temp.path().join(".claude/settings.json");
    std::fs::create_dir_all(settings.parent().unwrap()).unwrap();
    let original = r#"{"env":{"KEEP":"original"},"permissions":{"allow":["Read"]}}"#;
    std::fs::write(&settings, original).unwrap();
    let first = save(profile("claude_code")).unwrap();
    assert_eq!(first.revision, 1);
    assert_eq!(std::fs::read_to_string(&settings).unwrap(), original);
    enable_direct("claude_code", connection(first.clone()), None).unwrap();
    assert_eq!(applied("claude_code").unwrap(), Some(first.clone()));
    assert!(delete("claude_code", &first.id, first.revision).is_err());
    let mut edited = first.clone();
    edited
        .models
        .claude_mut()
        .unwrap()
        .roles
        .get_mut(&ClaudeRole::Opus)
        .unwrap()
        .model = "vendor/updated".into();
    let edited = save(edited).unwrap();
    let native_before = std::fs::read_to_string(&settings).unwrap();
    assert_eq!(applied("claude_code").unwrap(), Some(first.clone()));
    assert!(save(first.clone()).is_err());
    assert!(enable_direct("claude_code", connection(first), None).is_err());
    assert_eq!(std::fs::read_to_string(&settings).unwrap(), native_before);
    enable_direct("claude_code", connection(edited.clone()), None).unwrap();
    assert_eq!(applied("claude_code").unwrap(), Some(edited.clone()));
    let mut second = edited.clone();
    second.id = "another-profile".into();
    second.revision = 0;
    second.endpoint = "https://other.example".into();
    let second = save(second).unwrap();
    enable_direct("claude_code", connection(second.clone()), None).unwrap();
    delete("claude_code", &edited.id, edited.revision).unwrap();
    operations::restore_agent_default_unlocked("claude_code", false).unwrap();
    assert_eq!(std::fs::read_to_string(&settings).unwrap(), original);
    assert!(applied("claude_code").unwrap().is_none());
    assert_eq!(list("claude_code").unwrap(), vec![second]);
    let catalog = std::fs::read_to_string(
        app_paths::cli_config_profile_manifest("claude_code")
            .with_file_name("provider-profiles.json"),
    )
    .unwrap();
    assert!(!catalog.contains("synthetic-native-secret"));
    assert!(catalog.contains("vault-reference"));
    let desktop = save(profile("claude_desktop")).unwrap();
    assert_eq!(list("claude_desktop").unwrap(), vec![desktop]);
}
#[test]
fn repeated_models_are_tested_once_and_capability_changes_remain_distinct_configuration() {
    let mut p = profile("claude_code");
    for entry in p.models.claude_mut().unwrap().roles.values_mut() {
        entry.model = "same-model".into();
    }
    assert_eq!(p.models.request_models().len(), 1);
    let before = serde_json::to_string(&p).unwrap();
    p.models
        .claude_mut()
        .unwrap()
        .roles
        .get_mut(&ClaudeRole::Sonnet)
        .unwrap()
        .context_1m = true;
    assert_ne!(serde_json::to_string(&p).unwrap(), before);
    p.models
        .claude_mut()
        .unwrap()
        .roles
        .get_mut(&ClaudeRole::Haiku)
        .unwrap()
        .context_1m = true;
    assert!(p.validate().is_err());
}

#[test]
fn leaving_profiles_removes_old_role_metadata_and_authentication() {
    let generated = direct::generate_direct_configs(
        "claude_code",
        &BTreeMap::new(),
        &connection(profile("claude_code")),
        None,
    )
    .unwrap();
    let managed = generators::generate_claude_code_managed_config(
        &generated["settings"],
        Some("proxy-model"),
        "http://127.0.0.1:9999",
        "synthetic-proxy-token",
    )
    .unwrap();
    let value: serde_json::Value = serde_json::from_str(&managed).unwrap();
    assert!(value["env"].get("ANTHROPIC_API_KEY").is_none());
    assert!(value["env"]
        .get("ANTHROPIC_DEFAULT_OPUS_MODEL_NAME")
        .is_none());
    assert_eq!(value["env"]["ANTHROPIC_DEFAULT_FABLE_MODEL"], "proxy-model");
    let mut quick = connection(profile("claude_code"));
    quick.profile = None;
    let generated =
        direct::generate_direct_configs("claude_code", &generated, &quick, None).unwrap();
    let value: serde_json::Value = serde_json::from_str(&generated["settings"]).unwrap();
    assert!(value["env"].get("ANTHROPIC_DEFAULT_FABLE_MODEL").is_none());
    assert!(value["env"]
        .get("ANTHROPIC_DEFAULT_OPUS_MODEL_NAME")
        .is_none());
}
#[test]
fn version_overrides_cannot_silently_remap_profile_request_ids() {
    assert!(direct::generate_direct_configs(
        "claude_code",
        &BTreeMap::from([(
            "settings".into(),
            r#"{"modelOverrides":{"claude-opus-5":"another-model"}}"#.into()
        )]),
        &connection(profile("claude_code")),
        None
    )
    .is_err());
}

#[test]
fn catalog_is_bounded_and_conflicting_writers_cannot_replace_it() {
    let _lock = TEST_ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let temp = tempfile::tempdir().unwrap();
    let _home = OrgiiHomeGuard::set(&temp.path().join("orgii"));
    let _external = ExternalHome::set(temp.path());
    let catalog_lock = target_lock::lock_profile_catalog("claude_code").unwrap();
    assert!(save(profile("claude_code")).is_err());
    drop(catalog_lock);
    for i in 0..64 {
        let mut p = profile("claude_code");
        p.id = format!("profile-{i}");
        save(p).unwrap();
    }
    assert_eq!(list("claude_code").unwrap().len(), 64);
    assert!(save(profile("claude_code")).is_err());
    let mut existing = list("claude_code").unwrap().remove(0);
    existing.name = "Updated".into();
    assert!(save(existing).is_ok());
    let path = app_paths::cli_config_profile_manifest("claude_code")
        .with_file_name("provider-profiles.json");
    std::fs::write(&path, "{malformed-catalog").unwrap();
    assert!(list("claude_code").is_err());
    assert!(save(profile("claude_code")).is_err());
    assert_eq!(std::fs::read_to_string(path).unwrap(), "{malformed-catalog");
}

fn codex_profile() -> HarnessProviderProfile {
    serde_json::from_value(serde_json::json!({
        "id":"codex-fixture", "revision":0, "name":"Responses gateway", "target":"codex",
        "keyId":"vault-reference", "endpoint":"https://gateway.example/prefix/v1", "authScheme":"bearer",
        "models":{"model":"vendor/reasoner", "reasoningEffort":"high", "contextWindow":64000,"autoCompactTokenLimit":50000}
    })).unwrap()
}

#[test]
fn codex_profiles_write_exact_model_effort_and_limits_preserve_auth_and_restore() {
    let _lock = TEST_ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let temp = tempfile::tempdir().unwrap();
    let _home = OrgiiHomeGuard::set(&temp.path().join("orgii"));
    let _external = ExternalHome::set(temp.path());
    let config = temp.path().join(".codex/config.toml");
    std::fs::create_dir_all(config.parent().unwrap()).unwrap();
    let original = "model = 'old'\nmodel_reasoning_effort = 'low'\n[mcp_servers.fixture]\ncommand = 'original'\n";
    std::fs::write(&config, original).unwrap();
    let auth = config.with_file_name("auth.json");
    std::fs::write(&auth, "original-subscription-login").unwrap();
    let first = save(codex_profile()).unwrap();
    assert_eq!(list("codex").unwrap(), vec![first.clone()]);
    assert!(list("claude_code").unwrap().is_empty());
    assert_eq!(std::fs::read_to_string(&config).unwrap(), original);
    enable_direct("codex", connection(first.clone()), None).unwrap();
    let raw = std::fs::read_to_string(&config).unwrap();
    let native: toml::Value = toml::from_str(&raw).unwrap();
    assert_eq!(native["model"].as_str(), Some("vendor/reasoner"));
    assert_eq!(native["model_reasoning_effort"].as_str(), Some("high"));
    assert_eq!(native["model_context_window"].as_integer(), Some(64000));
    assert_eq!(
        native["model_auto_compact_token_limit"].as_integer(),
        Some(50000)
    );
    assert_eq!(
        native["model_providers"]["orgii"]["base_url"].as_str(),
        Some("https://gateway.example/prefix/v1")
    );
    assert_eq!(
        native["model_providers"]["orgii"]["wire_api"].as_str(),
        Some("responses")
    );
    assert_eq!(
        native["model_providers"]["orgii"]["experimental_bearer_token"].as_str(),
        Some("synthetic-native-secret")
    );
    assert_eq!(
        native["mcp_servers"]["fixture"]["command"].as_str(),
        Some("original")
    );
    assert_eq!(applied("codex").unwrap(), Some(first.clone()));
    assert!(delete("codex", &first.id, first.revision).is_err());
    let mut edited = first.clone();
    edited.models =
        super::profile_models::ProfileModels::Codex(super::profile_models::CodexModels {
            model: "another/model".into(),
            reasoning_effort: None,
            context_window: None,
            auto_compact_token_limit: None,
        });
    let edited = save(edited).unwrap();
    assert!(enable_direct("codex", connection(first), None).is_err());
    assert_eq!(std::fs::read_to_string(&config).unwrap(), raw);
    enable_direct("codex", connection(edited.clone()), None).unwrap();
    let raw = std::fs::read_to_string(&config).unwrap();
    assert!(!raw.contains("model_reasoning_effort"));
    assert!(!raw.contains("model_context_window"));
    assert!(!raw.contains("model_auto_compact_token_limit"));
    assert_eq!(
        std::fs::read_to_string(&auth).unwrap(),
        "original-subscription-login"
    );
    std::fs::write(&config, format!("{raw}\n# external edit\n")).unwrap();
    assert!(enable_direct("codex", connection(edited), None).is_err());
    assert!(operations::restore_agent_default_unlocked("codex", false).is_err());
    std::fs::write(&config, &raw).unwrap();
    operations::restore_agent_default_unlocked("codex", false).unwrap();
    assert_eq!(std::fs::read_to_string(&config).unwrap(), original);
    assert!(applied("codex").unwrap().is_none());
}

#[test]
fn codex_profile_validation_rejects_mixed_models_auth_and_invalid_limits() {
    let base = serde_json::to_value(codex_profile()).unwrap();
    for (field, value) in [
        ("model", serde_json::json!("bad model")),
        ("reasoningEffort", serde_json::json!("made-up")),
        ("contextWindow", serde_json::json!(0)),
        ("autoCompactTokenLimit", serde_json::json!(64001)),
    ] {
        let mut json = base.clone();
        json["models"][field] = value;
        let p: HarnessProviderProfile = serde_json::from_value(json).unwrap();
        assert!(save(p).is_err());
    }
    for (field, value) in [("target", "claude_code"), ("authScheme", "x-api-key")] {
        let mut json = base.clone();
        json[field] = value.into();
        assert!(save(serde_json::from_value(json).unwrap()).is_err());
    }
    let mut p = codex_profile();
    if let super::profile_models::ProfileModels::Codex(m) = &mut p.models {
        m.context_window = None;
    }
    assert!(save(p).is_err());
    let mut json = base;
    json["models"]["roles"] = serde_json::json!({});
    assert!(serde_json::from_value::<HarnessProviderProfile>(json).is_err());
}

#[test]
fn codex_overrides_and_mismatched_native_connection_cannot_bypass_tested_profile() {
    for raw in ["profile='work'", "model_catalog_json='custom.json'"] {
        assert!(direct::generate_direct_configs(
            "codex",
            &BTreeMap::from([("config".into(), raw.into())]),
            &connection(codex_profile()),
            None
        )
        .is_err());
    }
    let mut wrong = connection(codex_profile());
    wrong.model = "untested".into();
    assert!(direct::generate_direct_configs("codex", &BTreeMap::new(), &wrong, None).is_err());
    assert!(direct::generate_direct_configs(
        "claude_code",
        &BTreeMap::new(),
        &connection(codex_profile()),
        None
    )
    .is_err());
}

#[test]
fn leaving_codex_profile_for_proxy_or_quick_connection_clears_only_profile_model_settings() {
    let _lock = TEST_ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let temp = tempfile::tempdir().unwrap();
    let _home = OrgiiHomeGuard::set(&temp.path().join("orgii"));
    let _external = ExternalHome::set(temp.path());
    let p = save(codex_profile()).unwrap();
    enable_direct("codex", connection(p.clone()), None).unwrap();
    let mut quick = connection(p.clone());
    quick.profile = None;
    enable_direct("codex", quick, None).unwrap();
    let path = temp.path().join(".codex/config.toml");
    assert!(!std::fs::read_to_string(&path)
        .unwrap()
        .contains("model_context_window"));
    enable_direct("codex", connection(p), None).unwrap();
    operations::enable_agent_orgii_managed_unlocked(
        "codex",
        Some("vault-reference".into()),
        Some("custom_api".into()),
        Some("proxy-model".into()),
        false,
    )
    .unwrap();
    let raw = std::fs::read_to_string(path).unwrap();
    for field in [
        "model_reasoning_effort",
        "model_context_window",
        "model_auto_compact_token_limit",
    ] {
        assert!(!raw.contains(field));
    }
}

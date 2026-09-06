use super::tests::{OrgiiHomeGuard, TEST_ENV_LOCK};
use super::{claude_models::*, provider_profiles::*, *};
use std::{collections::BTreeMap, sync::Mutex};

fn profile(target: &str) -> ClaudeProviderProfile {
    ClaudeProviderProfile {
        id: "fixture-profile".into(),
        revision: 0,
        name: "Gateway profile".into(),
        target: target.into(),
        key_id: "vault-reference".into(),
        endpoint: "https://gateway.example/prefix".into(),
        auth_scheme: "x-api-key".into(),
        models: ClaudeModels {
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
        },
    }
}
fn connection(profile: ClaudeProviderProfile) -> DirectConnection {
    DirectConnection {
        key_id: profile.key_id.clone(),
        provider: "custom_api".into(),
        model: profile.models.roles[&profile.models.default_role]
            .model
            .clone(),
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
    p.models.roles.insert(
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
    for entry in p.models.roles.values_mut() {
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
    p.models.roles.remove(&ClaudeRole::Fable);
    assert!(save(p).is_err());
    let mut p = original.clone();
    p.models.roles.get_mut(&ClaudeRole::Sonnet).unwrap().model = "injected\nmodel".into();
    assert!(save(p).is_err());
    let mut p = original.clone();
    p.models.default_role = ClaudeRole::Subagent;
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
    for entry in p.models.roles.values_mut() {
        entry.model = "same-model".into();
    }
    assert_eq!(p.models.request_models().len(), 1);
    let before = serde_json::to_string(&p).unwrap();
    p.models
        .roles
        .get_mut(&ClaudeRole::Sonnet)
        .unwrap()
        .context_1m = true;
    assert_ne!(serde_json::to_string(&p).unwrap(), before);
    p.models
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

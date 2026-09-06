#[cfg(any(target_os = "macos", windows))]
use super::tests::{OrgiiHomeGuard, TEST_ENV_LOCK};
use super::*;
use std::collections::BTreeMap;
#[cfg(any(target_os = "macos", windows))]
use std::sync::Mutex;

#[cfg(any(target_os = "macos", windows))]
struct ExternalHome(Option<std::ffi::OsString>);
#[cfg(any(target_os = "macos", windows))]
impl ExternalHome {
    fn set(path: &std::path::Path) -> Self {
        let previous = std::env::var_os("ORGII_EXTERNAL_HISTORY_HOME");
        std::env::set_var("ORGII_EXTERNAL_HISTORY_HOME", path);
        Self(previous)
    }
}
#[cfg(any(target_os = "macos", windows))]
impl Drop for ExternalHome {
    fn drop(&mut self) {
        match self.0.take() {
            Some(value) => std::env::set_var("ORGII_EXTERNAL_HISTORY_HOME", value),
            None => std::env::remove_var("ORGII_EXTERNAL_HISTORY_HOME"),
        }
    }
}
fn connection() -> DirectConnection {
    DirectConnection {
        profile: None,
        key_id: "desktop-key".into(),
        provider: "custom_api".into(),
        model: "claude-sonnet-5".into(),
        base_url: "https://desktop.example/anthropic".into(),
        api_key: "synthetic-desktop-key".into(),
        desktop_auth_scheme: Some("x-api-key".into()),
    }
}

#[test]
fn native_schema_preserves_other_profiles_without_enabling_unrelated_permissions() {
    let source = BTreeMap::from([
        (
            "desktop".into(),
            r#"{"mcpServers":{"keep":{}},"deploymentMode":"1p"}"#.into(),
        ),
        (
            "catalog".into(),
            r#"{"entries":[{"id":"other","name":"Personal"}],"appliedId":"other","keep":true}"#
                .into(),
        ),
    ]);
    let generated = desktop::generate(&source, &connection(), None).unwrap();
    let profile: serde_json::Value = serde_json::from_str(&generated["profile"]).unwrap();
    assert_eq!(
        profile["inferenceGatewayBaseUrl"],
        "https://desktop.example/anthropic"
    );
    assert_eq!(profile["inferenceGatewayAuthScheme"], "x-api-key");
    assert_eq!(profile["inferenceModels"][0]["name"], "claude-sonnet-5");
    assert!(profile.get("coworkEgressAllowedHosts").is_none());
    assert!(profile.get("disableDeploymentModeChooser").is_none());
    let config: serde_json::Value = serde_json::from_str(&generated["desktop"]).unwrap();
    assert!(config["mcpServers"].get("keep").is_some());
    let catalog: serde_json::Value = serde_json::from_str(&generated["catalog"]).unwrap();
    assert_eq!(catalog["entries"][0]["id"], "other");
    assert_eq!(catalog["keep"], true);
}

#[test]
fn malformed_or_unowned_configuration_and_unsupported_models_are_rejected() {
    for (id, raw) in [
        ("desktop", "[]"),
        ("desktop", "{secret"),
        ("third_party", r#"{"enterpriseConfig":{}}"#),
        ("catalog", r#"{"entries":{}}"#),
        ("profile", "{}"),
    ] {
        let error = desktop::generate(
            &BTreeMap::from([(id.into(), raw.into())]),
            &connection(),
            None,
        )
        .unwrap_err();
        assert!(!error.contains("{secret"));
    }
    let mut value = connection();
    value.model = "custom-model".into();
    assert!(desktop::generate(&BTreeMap::new(), &value, None).is_err());
    value.model = "claude-sonnet-5".into();
    value.desktop_auth_scheme = Some("unknown".into());
    assert!(desktop::generate(&BTreeMap::new(), &value, None).is_err());
}

#[cfg(any(target_os = "macos", windows))]
#[test]
fn desktop_and_cli_apply_restore_and_manifest_ownership_are_independent() {
    let _lock = TEST_ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let temp = tempfile::tempdir().unwrap();
    let _home = OrgiiHomeGuard::set(&temp.path().join("orgii"));
    let _external = ExternalHome::set(temp.path());
    let targets = desktop::targets().unwrap();
    let original = r#"{"mcpServers":{"keep":{}},"deploymentMode":"1p"}"#;
    std::fs::create_dir_all(targets[0].2.parent().unwrap()).unwrap();
    std::fs::write(&targets[0].2, original).unwrap();
    let mut cli_connection = connection();
    cli_connection.desktop_auth_scheme = None;
    let cli = enable_direct("claude_code", cli_connection, None).unwrap();
    let cli_path = &cli.target_files[0].target_path;
    let cli_bytes = std::fs::read(cli_path).unwrap();
    let cli_manifest = std::fs::read(manifest::manifest_path("claude_code")).unwrap();
    let expected = operations::status_for_unlocked(desktop::TARGET)
        .unwrap()
        .target_files
        .into_iter()
        .map(|file| (file.id, file.current_hash))
        .collect();
    let applied = enable_direct(desktop::TARGET, connection(), Some(&expected)).unwrap();
    assert_eq!(applied.target_files.len(), 4);
    assert_eq!(applied.mode, CliConfigMode::Direct);
    assert_eq!(std::fs::read(cli_path).unwrap(), cli_bytes);
    assert_eq!(
        std::fs::read(manifest::manifest_path("claude_code")).unwrap(),
        cli_manifest
    );
    let desktop_bytes: Vec<_> = targets
        .iter()
        .map(|(_, _, path)| std::fs::read(path).unwrap())
        .collect();
    operations::restore_agent_default_unlocked("claude_code", false).unwrap();
    for (index, (_, _, path)) in targets.iter().enumerate() {
        assert_eq!(std::fs::read(path).unwrap(), desktop_bytes[index]);
    }
    assert!(restore_managed_configs_for_shutdown()
        .unwrap()
        .restored_agents
        .is_empty());
    assert!(enable_orgii_managed(desktop::TARGET, None, None, None, false).is_err());
    assert!(managed_proxy_protocol_for_agent(desktop::TARGET).is_none());
    enable_direct(desktop::TARGET, connection(), None).unwrap();
    operations::restore_agent_default_unlocked(desktop::TARGET, false).unwrap();
    assert_eq!(std::fs::read_to_string(&targets[0].2).unwrap(), original);
    for (_, _, path) in targets.iter().skip(1) {
        assert!(!path.exists());
    }
}

#[cfg(any(target_os = "macos", windows))]
#[test]
fn stale_catalog_and_external_edit_block_apply_and_restore_without_partial_writes() {
    let _lock = TEST_ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let temp = tempfile::tempdir().unwrap();
    let _home = OrgiiHomeGuard::set(&temp.path().join("orgii"));
    let _external = ExternalHome::set(temp.path());
    let status = enable_direct(desktop::TARGET, connection(), None).unwrap();
    let before: Vec<_> = status
        .target_files
        .iter()
        .map(|file| std::fs::read(&file.target_path).unwrap())
        .collect();
    let catalog = status
        .target_files
        .iter()
        .find(|file| file.id == "catalog")
        .unwrap();
    std::fs::write(&catalog.target_path, r#"{"entries":[],"external":true}"#).unwrap();
    assert!(enable_direct(desktop::TARGET, connection(), None).is_err());
    assert!(operations::restore_agent_default_unlocked(desktop::TARGET, false).is_err());
    for (index, file) in status.target_files.iter().enumerate() {
        if file.id != "catalog" {
            assert_eq!(std::fs::read(&file.target_path).unwrap(), before[index]);
        }
    }
}

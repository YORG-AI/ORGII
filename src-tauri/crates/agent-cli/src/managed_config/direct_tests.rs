use super::tests::{test_manifest, test_target, OrgiiHomeGuard, TEST_ENV_LOCK};
use super::*;
use std::{collections::BTreeMap, sync::Mutex};

fn connection(key: &str) -> DirectConnection {
    DirectConnection {
        key_id: "test-key".into(),
        provider: "custom_api".into(),
        model: "fixture-model".into(),
        base_url: "http://127.0.0.1:9999/v1".into(),
        api_key: key.into(),
    }
}

struct ExternalHome(Option<std::ffi::OsString>);
impl ExternalHome {
    fn set(path: &std::path::Path) -> Self {
        let previous = std::env::var_os("ORGII_EXTERNAL_HISTORY_HOME");
        std::env::set_var("ORGII_EXTERNAL_HISTORY_HOME", path);
        Self(previous)
    }
}
impl Drop for ExternalHome {
    fn drop(&mut self) {
        match self.0.take() {
            Some(value) => std::env::set_var("ORGII_EXTERNAL_HISTORY_HOME", value),
            None => std::env::remove_var("ORGII_EXTERNAL_HISTORY_HOME"),
        }
    }
}

#[test]
fn direct_switch_changes_native_credentials_survives_shutdown_and_restores_original() {
    let _lock = TEST_ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let temp = tempfile::tempdir().unwrap();
    let _home = OrgiiHomeGuard::set(&temp.path().join("orgii"));
    let _external = ExternalHome::set(temp.path());
    for (agent, folder, file, original) in [
        (
            "codex",
            ".codex",
            "config.toml",
            "# user comment\nmodel = 'original'\n[features]\nshell_tool = true\n",
        ),
        (
            "claude_code",
            ".claude",
            "settings.json",
            "{\"permissions\":{\"allow\":[\"Read\"]},\"env\":{\"KEEP\":\"value\"}}",
        ),
    ] {
        let dir = temp.path().join(folder);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(file);
        std::fs::write(&path, original).unwrap();
        let auth_path = dir.join("auth.json");
        std::fs::write(&auth_path, "native-login-sentinel").unwrap();
        let status = enable_direct(agent, connection("first-key"), None).unwrap();
        assert_eq!(status.mode, CliConfigMode::Direct);
        assert!(status.proxy_url.is_none());
        assert!(managed_selection_for_agent(agent).unwrap().is_none());
        enable_direct(agent, connection("second-key"), None).unwrap();
        let generated = std::fs::read_to_string(&path).unwrap();
        assert!(generated.contains("second-key"));
        assert!(!generated.contains("first-key"));
        if agent == "codex" {
            assert!(generated.contains("# user comment"));
        }
        assert_eq!(
            std::fs::read_to_string(&auth_path).unwrap(),
            "native-login-sentinel"
        );
        assert!(restore_managed_configs_for_shutdown()
            .unwrap()
            .restored_agents
            .is_empty());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), generated);
        operations::restore_agent_default_unlocked(agent, false).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
    }
}

#[test]
fn direct_apply_and_restore_refuse_external_edits() {
    let _lock = TEST_ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let temp = tempfile::tempdir().unwrap();
    let _home = OrgiiHomeGuard::set(&temp.path().join("orgii"));
    let _external = ExternalHome::set(temp.path());
    enable_direct("codex", connection("key"), None).unwrap();
    let path = temp.path().join(".codex/config.toml");
    std::fs::write(&path, "model = 'external-edit'").unwrap();
    assert!(enable_direct("codex", connection("replacement"), None).is_err());
    assert!(operations::status_for_unlocked("codex").unwrap().conflict);
    assert!(operations::restore_agent_default_unlocked("codex", false).is_err());
    assert_eq!(
        std::fs::read_to_string(path).unwrap(),
        "model = 'external-edit'"
    );
}

#[test]
fn malformed_configs_and_existing_provider_collisions_are_preserved() {
    for (agent, id, raw) in [
        (
            "codex",
            "config",
            "[model_providers.orgii]\nname='user-owned'",
        ),
        ("codex", "config", "secret = 'unterminated"),
        ("claude_code", "settings", "{broken-secret"),
        (
            "claude_code",
            "settings",
            "{\"apiKeyHelper\":\"private-command\"}",
        ),
    ] {
        let result = direct::generate_direct_configs(
            agent,
            &BTreeMap::from([(id.into(), raw.into())]),
            &connection("key"),
            None,
        );
        let error = result.unwrap_err();
        assert!(!error.contains("unterminated"));
        assert!(!error.contains("private-command"));
    }
}

#[test]
fn interrupted_transaction_does_not_overwrite_a_later_external_edit() {
    let _lock = TEST_ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let temp = tempfile::tempdir().unwrap();
    let _home = OrgiiHomeGuard::set(&temp.path().join("orgii"));
    let path = temp.path().join("config.toml");
    std::fs::write(&path, b"before").unwrap();
    let target = test_target("config", &path, temp.path());
    let snapshots = snapshot::read_target_snapshots(std::slice::from_ref(&target)).unwrap();
    let mutations = BTreeMap::from([(
        "config".into(),
        snapshot::TargetMutation::Write(b"ours".to_vec()),
    )]);
    transaction::begin_transaction(
        "test-agent",
        &snapshots,
        &test_manifest("test-agent", vec![target]),
        &mutations,
    )
    .unwrap();
    std::fs::write(&path, b"external").unwrap();
    assert!(transaction::recover_pending_transaction_unlocked("test-agent").is_err());
    assert_eq!(std::fs::read(&path).unwrap(), b"external");
    assert!(transaction::transaction_journal_path("test-agent").exists());
}

#[test]
fn target_lock_prevents_another_writer_without_creating_native_config() {
    let _lock = TEST_ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let temp = tempfile::tempdir().unwrap();
    let _home = OrgiiHomeGuard::set(&temp.path().join("orgii"));
    let _external = ExternalHome::set(temp.path());
    let first = target_lock::lock_targets("codex").unwrap();
    assert!(target_lock::lock_targets("codex").is_err());
    assert!(!temp.path().join(".codex").exists());
    drop(first);
    assert!(target_lock::lock_targets("codex").is_ok());
}

#[test]
fn stale_preview_cannot_apply_even_before_first_switch() {
    let _lock = TEST_ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let temp = tempfile::tempdir().unwrap();
    let _home = OrgiiHomeGuard::set(&temp.path().join("orgii"));
    let _external = ExternalHome::set(temp.path());
    let expected = operations::status_for_unlocked("codex")
        .unwrap()
        .target_files
        .into_iter()
        .map(|target| (target.id, target.current_hash))
        .collect();
    std::fs::create_dir_all(temp.path().join(".codex")).unwrap();
    let path = temp.path().join(".codex/config.toml");
    std::fs::write(&path, "model = 'new-external'").unwrap();
    assert!(enable_direct("codex", connection("key"), Some(&expected)).is_err());
    assert_eq!(
        std::fs::read_to_string(path).unwrap(),
        "model = 'new-external'"
    );
}

#[cfg(unix)]
#[test]
fn native_symlinks_are_rejected_and_credentials_are_owner_only() {
    use std::os::unix::{fs::symlink, fs::PermissionsExt};
    let _lock = TEST_ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let temp = tempfile::tempdir().unwrap();
    let _home = OrgiiHomeGuard::set(&temp.path().join("orgii"));
    let _external = ExternalHome::set(temp.path());
    std::fs::create_dir_all(temp.path().join(".codex")).unwrap();
    let original = temp.path().join("original");
    std::fs::write(&original, "model = 'original'").unwrap();
    let path = temp.path().join(".codex/config.toml");
    symlink(&original, &path).unwrap();
    assert!(enable_direct("codex", connection("key"), None).is_err());
    assert_eq!(
        std::fs::read_to_string(&original).unwrap(),
        "model = 'original'"
    );
    std::fs::remove_file(&path).unwrap();
    enable_direct("codex", connection("key"), None).unwrap();
    assert_eq!(
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[test]
fn official_anthropic_uses_native_api_key_authentication() {
    let mut connection = connection("synthetic-official-key");
    connection.base_url = "https://api.anthropic.com".into();
    let generated =
        direct::generate_direct_configs("claude_code", &BTreeMap::new(), &connection, None)
            .unwrap();
    let settings: serde_json::Value = serde_json::from_str(&generated["settings"]).unwrap();
    assert_eq!(
        settings["env"]["ANTHROPIC_API_KEY"],
        "synthetic-official-key"
    );
    assert!(settings["env"].get("ANTHROPIC_AUTH_TOKEN").is_none());
}

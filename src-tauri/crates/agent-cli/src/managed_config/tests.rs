use super::file_io::*;
use super::generators::*;
use super::manifest::*;
use super::operations::*;
use super::proxy::*;
use super::registry::*;
use super::snapshot::*;
use super::transaction::*;
use super::*;

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

const TEST_PROXY_TOKEN: &str = "test-proxy-token";
static TEST_ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

struct OrgiiHomeGuard {
    previous: Option<OsString>,
}

impl OrgiiHomeGuard {
    fn set(path: &Path) -> Self {
        let previous = std::env::var_os("ORGII_HOME");
        std::env::set_var("ORGII_HOME", path);
        Self { previous }
    }
}

impl Drop for OrgiiHomeGuard {
    fn drop(&mut self) {
        match self.previous.take() {
            Some(value) => std::env::set_var("ORGII_HOME", value),
            None => std::env::remove_var("ORGII_HOME"),
        }
    }
}

fn test_target(id: &str, target_path: &Path, profile_root: &Path) -> CliConfigTargetFileManifest {
    CliConfigTargetFileManifest {
        id: id.to_string(),
        target_path: target_path.to_string_lossy().to_string(),
        default_backup_path: profile_root
            .join("default")
            .join(format!("{id}.bak"))
            .to_string_lossy()
            .to_string(),
        managed_profile_path: profile_root
            .join("managed")
            .join(format!("{id}.txt"))
            .to_string_lossy()
            .to_string(),
        original_hash: None,
        last_applied_hash: None,
        default_was_missing: false,
    }
}

fn test_manifest(
    agent_name: &str,
    targets: Vec<CliConfigTargetFileManifest>,
) -> CliConfigProfileManifest {
    CliConfigProfileManifest {
        agent: agent_name.to_string(),
        mode: CliConfigMode::OrgiiManaged,
        target_files: targets,
        selected_key_id: Some("key-1".to_string()),
        selected_provider: Some("openai_api".to_string()),
        selected_model: Some("gpt-test".to_string()),
        proxy_url: Some(DEFAULT_PROXY_URL.to_string()),
        proxy_token: Some(TEST_PROXY_TOKEN.to_string()),
        created_at: "1".to_string(),
        updated_at: "1".to_string(),
    }
}

fn generated_for(agent_name: &str, existing: &[(&str, &str)]) -> BTreeMap<String, String> {
    let existing_contents = existing
        .iter()
        .map(|(id, content)| ((*id).to_string(), (*content).to_string()))
        .collect();
    generate_managed_configs(
        agent_name,
        &existing_contents,
        Some("test-model"),
        DEFAULT_PROXY_URL,
        TEST_PROXY_TOKEN,
    )
    .unwrap()
}

fn central_cli_registry_agent_names() -> Vec<&'static str> {
    include_str!("../../../key-vault/src/commands/registry/data/cli_agents.rs")
        .lines()
        .filter_map(|line| {
            line.trim()
                .strip_prefix("name: \"")
                .and_then(|value| value.strip_suffix("\","))
        })
        .collect()
}

#[test]
fn codex_managed_config_preserves_existing_settings() {
    let raw = r#"
model = "gpt-5"
approval_policy = "on-request"

[features]
shell_tool = true
"#;

    let generated = generate_codex_managed_config(
        raw,
        Some("gpt-5-codex"),
        DEFAULT_PROXY_URL,
        TEST_PROXY_TOKEN,
    )
    .unwrap();
    let parsed: toml::Value = toml::from_str(&generated).unwrap();

    assert_eq!(parsed["model"].as_str(), Some("gpt-5-codex"));
    assert_eq!(parsed["model_provider"].as_str(), Some("orgii"));
    assert_eq!(parsed["approval_policy"].as_str(), Some("on-request"));
    assert_eq!(parsed["features"]["shell_tool"].as_bool(), Some(true));
    assert_eq!(
        parsed["model_providers"]["orgii"]["base_url"].as_str(),
        Some("http://127.0.0.1:17888/cli/codex/test-proxy-token/v1")
    );
    assert!(parsed["model_providers"]["orgii"].get("env_key").is_none());
    assert_eq!(
        parsed["model_providers"]["orgii"]["requires_openai_auth"].as_bool(),
        Some(false)
    );
    assert_eq!(
        parsed["model_providers"]["orgii"]["supports_websockets"].as_bool(),
        Some(false)
    );
    assert_eq!(
        parsed["model_providers"]["orgii"]["request_max_retries"].as_integer(),
        Some(CODEX_REQUEST_MAX_RETRIES)
    );
    assert_eq!(
        parsed["model_providers"]["orgii"]["stream_max_retries"].as_integer(),
        Some(CODEX_STREAM_MAX_RETRIES)
    );
}

#[test]
fn codex_managed_config_uses_placeholder_model_when_missing() {
    let generated =
        generate_codex_managed_config("", None, "http://localhost:9999", TEST_PROXY_TOKEN).unwrap();
    let parsed: toml::Value = toml::from_str(&generated).unwrap();

    assert_eq!(parsed["model"].as_str(), Some(DEFAULT_ORGII_MODEL));
    assert_eq!(
        parsed["model_providers"]["orgii"]["base_url"].as_str(),
        Some("http://localhost:9999/cli/codex/test-proxy-token/v1")
    );
}

#[test]
fn claude_code_managed_config_preserves_existing_settings() {
    let raw = r#"
{
  "permissions": {
"allow": ["Bash(git status:*)"]
  },
  "env": {
"CUSTOM_FLAG": "keep"
  }
}
"#;

    let generated = generate_claude_code_managed_config(
        raw,
        Some("claude-sonnet-4-5"),
        DEFAULT_PROXY_URL,
        TEST_PROXY_TOKEN,
    )
    .unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&generated).unwrap();

    assert_eq!(parsed["model"].as_str(), Some("claude-sonnet-4-5"));
    assert_eq!(
        parsed["permissions"]["allow"][0].as_str(),
        Some("Bash(git status:*)")
    );
    assert_eq!(parsed["env"]["CUSTOM_FLAG"].as_str(), Some("keep"));
    assert_eq!(
        parsed["env"]["ANTHROPIC_BASE_URL"].as_str(),
        Some("http://127.0.0.1:17888/cli/claude_code/test-proxy-token/claude")
    );
    assert_eq!(
        parsed["env"]["ANTHROPIC_AUTH_TOKEN"].as_str(),
        Some(TEST_PROXY_TOKEN)
    );
    assert_eq!(
        parsed["env"]["ANTHROPIC_MODEL"].as_str(),
        Some("claude-sonnet-4-5")
    );
}

#[test]
fn proxy_base_urls_include_authenticated_route() {
    assert_eq!(
        codex_proxy_base_url(DEFAULT_PROXY_URL, TEST_PROXY_TOKEN),
        "http://127.0.0.1:17888/cli/codex/test-proxy-token/v1"
    );
    assert_eq!(
        claude_code_proxy_base_url(DEFAULT_PROXY_URL, TEST_PROXY_TOKEN),
        "http://127.0.0.1:17888/cli/claude_code/test-proxy-token/claude"
    );
}

#[test]
fn managed_adapter_registry_exposes_protocols_and_targets() {
    assert_eq!(
        managed_proxy_protocol_for_agent(CODEX_AGENT),
        Some(CliManagedProxyProtocol::OpenAiResponses)
    );
    assert_eq!(
        managed_proxy_protocol_for_agent(OPENCODE_AGENT),
        Some(CliManagedProxyProtocol::OpenAiChatCompletions)
    );
    assert_eq!(
        managed_proxy_protocol_for_agent(AIDER_AGENT),
        Some(CliManagedProxyProtocol::OpenAiChatCompletions)
    );
    assert!(!supported_agent("amp"));

    let opencode_targets = agent_manifest_targets(OPENCODE_AGENT).unwrap();
    assert_eq!(opencode_targets.len(), 1);
    assert_eq!(opencode_targets[0].id, OPENCODE_CONFIG_FILE_ID);
    let aider_targets = agent_manifest_targets(AIDER_AGENT).unwrap();
    assert_eq!(aider_targets.len(), 1);
    assert_eq!(aider_targets[0].id, AIDER_CONFIG_FILE_ID);
}

#[test]
fn every_central_cli_registry_entry_has_an_explicit_managed_config_result() {
    let agent_names = central_cli_registry_agent_names();
    assert!(
        !agent_names.is_empty(),
        "central CLI registry unexpectedly has no entries"
    );

    let mut supported = 0;
    let mut unavailable = 0;
    for &agent_name in &agent_names {
        match managed_config_availability_for_agent(agent_name) {
            CliManagedConfigAvailability::Supported(_) => supported += 1,
            CliManagedConfigAvailability::Unavailable(reason) => {
                unavailable += 1;
                assert!(!reason.trim().is_empty(), "missing reason for {agent_name}");
            }
            CliManagedConfigAvailability::Unknown => {
                panic!("central CLI registry entry is not classified: {agent_name}")
            }
        }
    }

    // The registry is intentionally extensible. Classification coverage,
    // not a duplicated hard-coded registry size, is the invariant this
    // test owns; `Unknown` above fails with the exact missing agent name.
    assert_eq!(supported + unavailable, agent_names.len());
    assert!(supported > 0, "expected at least one managed CLI adapter");
    assert!(
        unavailable > 0,
        "expected explicit reasons for unsupported CLI adapters"
    );
}

#[test]
fn every_managed_adapter_resolves_all_declared_targets() {
    for adapter in MANAGED_CONFIG_ADAPTERS {
        let targets = agent_manifest_targets(adapter.agent_name).unwrap();
        assert_eq!(
            targets.len(),
            adapter.targets.len(),
            "{}",
            adapter.agent_name
        );
        assert!(!targets.is_empty(), "{}", adapter.agent_name);
    }

    let omp_targets = agent_manifest_targets(OMP_AGENT).unwrap();
    assert!(omp_targets[0]
        .target_path
        .replace('\\', "/")
        .ends_with("/.oh-omp/agent/models.yml"));
    assert!(omp_targets[1]
        .target_path
        .replace('\\', "/")
        .ends_with("/.oh-omp/agent/config.yml"));

    if std::env::var_os("GOOSE_PATH_ROOT").is_none() {
        let goose_targets = agent_manifest_targets(GOOSE_AGENT).unwrap();
        let config_path = goose_targets[0].target_path.replace('\\', "/");
        let secrets_path = goose_targets[1].target_path.replace('\\', "/");
        #[cfg(target_os = "windows")]
        {
            assert!(config_path.ends_with("/Block/goose/config/config.yaml"));
            assert!(secrets_path.ends_with("/Block/goose/config/secrets.yaml"));
        }
        #[cfg(not(target_os = "windows"))]
        {
            assert!(config_path.ends_with("/goose/config.yaml"));
            assert!(secrets_path.ends_with("/goose/secrets.yaml"));
        }
    }
}

#[test]
fn opencode_managed_config_preserves_jsonc_and_adds_orgii_provider() {
    let raw = r#"
{
  // Keep existing providers and settings.
  "theme": "system",
  "provider": {
"existing": {
  "npm": "@ai-sdk/openai"
},
  },
}
"#;

    let generated = generate_opencode_managed_config(
        raw,
        Some("deepseek-chat"),
        DEFAULT_PROXY_URL,
        TEST_PROXY_TOKEN,
    )
    .unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&generated).unwrap();

    assert_eq!(parsed["theme"].as_str(), Some("system"));
    assert!(parsed["provider"]["existing"].is_object());
    assert_eq!(
        parsed["provider"]["orgii"]["options"]["baseURL"].as_str(),
        Some("http://127.0.0.1:17888/cli/opencode/test-proxy-token/v1")
    );
    assert_eq!(
        parsed["provider"]["orgii"]["options"]["apiKey"].as_str(),
        Some(TEST_PROXY_TOKEN)
    );
    assert_eq!(parsed["model"].as_str(), Some("orgii/deepseek-chat"));
    assert_eq!(parsed["small_model"].as_str(), Some("orgii/deepseek-chat"));
}

#[test]
fn aider_managed_config_preserves_yaml_and_uses_openai_compatible_model() {
    let raw = r#"
auto-commits: false
map-tokens: 2048
"#;

    let generated = generate_aider_managed_config(
        raw,
        Some("anthropic/claude-sonnet-4"),
        DEFAULT_PROXY_URL,
        TEST_PROXY_TOKEN,
    )
    .unwrap();
    let parsed: serde_yaml::Value = serde_yaml::from_str(&generated).unwrap();

    assert_eq!(parsed["auto-commits"].as_bool(), Some(false));
    assert_eq!(parsed["map-tokens"].as_u64(), Some(2048));
    assert_eq!(
        parsed["model"].as_str(),
        Some("openai/anthropic/claude-sonnet-4")
    );
    assert_eq!(
        parsed["openai-api-base"].as_str(),
        Some("http://127.0.0.1:17888/cli/aider/test-proxy-token/v1")
    );
    assert_eq!(parsed["openai-api-key"].as_str(), Some(TEST_PROXY_TOKEN));
}

#[test]
fn kimi_and_goose_managed_configs_select_the_orgii_model() {
    let kimi = generated_for(
        KIMI_CLI_AGENT,
        &[(KIMI_CLI_CONFIG_FILE_ID, "theme = \"dark\"\n")],
    );
    let kimi: toml::Value = toml::from_str(&kimi[KIMI_CLI_CONFIG_FILE_ID]).unwrap();
    assert_eq!(kimi["theme"].as_str(), Some("dark"));
    assert_eq!(kimi["default_model"].as_str(), Some("orgii/test-model"));
    assert_eq!(
        kimi["providers"]["orgii"]["base_url"].as_str(),
        Some("http://127.0.0.1:17888/cli/kimi_cli/test-proxy-token/v1")
    );
    assert_eq!(
        kimi["models"]["orgii/test-model"]["provider"].as_str(),
        Some("orgii")
    );

    let goose = generated_for(
        GOOSE_AGENT,
        &[
            (
                GOOSE_CONFIG_FILE_ID,
                "extensions:\n  developer:\n    enabled: true\n",
            ),
            (GOOSE_SECRETS_FILE_ID, "EXISTING_SECRET: keep\n"),
        ],
    );
    let goose_config: serde_yaml::Value =
        serde_yaml::from_str(&goose[GOOSE_CONFIG_FILE_ID]).unwrap();
    let goose_secrets: serde_yaml::Value =
        serde_yaml::from_str(&goose[GOOSE_SECRETS_FILE_ID]).unwrap();
    assert_eq!(goose_config["active_provider"].as_str(), Some("openai"));
    assert_eq!(
        goose_config["providers"]["openai"]["model"].as_str(),
        Some("test-model")
    );
    assert_eq!(
        goose_config["OPENAI_BASE_URL"].as_str(),
        Some("http://127.0.0.1:17888/cli/goose/test-proxy-token/v1")
    );
    assert_eq!(
        goose_config["extensions"]["developer"]["enabled"].as_bool(),
        Some(true)
    );
    assert_eq!(goose_secrets["EXISTING_SECRET"].as_str(), Some("keep"));
    assert_eq!(
        goose_secrets["OPENAI_API_KEY"].as_str(),
        Some(TEST_PROXY_TOKEN)
    );
}

#[test]
fn cline_kilo_and_mimo_configs_activate_the_managed_provider() {
    let cline = generated_for(
        CLINE_AGENT,
        &[(
            CLINE_PROVIDERS_FILE_ID,
            r#"{"version":1,"lastUsedProvider":"cline","providers":{"cline":{"settings":{"provider":"cline"},"updatedAt":"2026-01-01T00:00:00.000Z","tokenSource":"oauth"}}}"#,
        )],
    );
    let cline: serde_json::Value = serde_json::from_str(&cline[CLINE_PROVIDERS_FILE_ID]).unwrap();
    assert_eq!(cline["lastUsedProvider"].as_str(), Some("orgii"));
    assert!(cline["providers"]["cline"].is_object());
    assert!(chrono::DateTime::parse_from_rfc3339(
        cline["providers"]["orgii"]["updatedAt"].as_str().unwrap()
    )
    .is_ok());
    assert_eq!(
        cline["providers"]["orgii"]["settings"]["model"].as_str(),
        Some("test-model")
    );
    assert_eq!(
        cline["providers"]["orgii"]["settings"]["protocol"].as_str(),
        Some("openai-chat")
    );
    assert_eq!(
        cline["providers"]["orgii"]["settings"]["client"].as_str(),
        Some("openai-compatible")
    );
    assert_eq!(
        cline["providers"]["orgii"]["settings"]["baseUrl"].as_str(),
        Some("http://127.0.0.1:17888/cli/cline/test-proxy-token/v1")
    );

    let kilo = generated_for(
        KILO_AGENT,
        &[(KILO_CONFIG_FILE_ID, "{ enabled_providers: ['existing'] }")],
    );
    let kilo: serde_json::Value = serde_json::from_str(&kilo[KILO_CONFIG_FILE_ID]).unwrap();
    assert_eq!(kilo["model"].as_str(), Some("orgii/test-model"));
    assert!(kilo["enabled_providers"]
        .as_array()
        .unwrap()
        .iter()
        .any(|value| value.as_str() == Some("orgii")));
    assert_eq!(
        kilo["provider"]["orgii"]["options"]["baseURL"].as_str(),
        Some("http://127.0.0.1:17888/cli/kilo/test-proxy-token/v1")
    );

    let mimo = generated_for(
        MIMO_CODE_AGENT,
        &[(MIMO_CODE_CONFIG_FILE_ID, "{\"theme\":\"dark\"}")],
    );
    let mimo: serde_json::Value = serde_json::from_str(&mimo[MIMO_CODE_CONFIG_FILE_ID]).unwrap();
    assert_eq!(mimo["theme"].as_str(), Some("dark"));
    assert_eq!(mimo["model"].as_str(), Some("orgii/test-model"));
    assert_eq!(
        mimo["provider"]["orgii"]["options"]["baseURL"].as_str(),
        Some("http://127.0.0.1:17888/cli/mimo_code/test-proxy-token/v1")
    );
}

#[test]
fn hermes_openclaw_and_qwen_configs_preserve_existing_values() {
    let hermes = generated_for(
        HERMES_AGENT,
        &[(HERMES_CONFIG_FILE_ID, "display:\n  compact: true\n")],
    );
    let hermes: serde_yaml::Value = serde_yaml::from_str(&hermes[HERMES_CONFIG_FILE_ID]).unwrap();
    assert_eq!(hermes["display"]["compact"].as_bool(), Some(true));
    assert_eq!(hermes["model"]["provider"].as_str(), Some("custom"));
    assert_eq!(hermes["model"]["default"].as_str(), Some("test-model"));

    let openclaw = generated_for(
        OPENCLAW_AGENT,
        &[(OPENCLAW_CONFIG_FILE_ID, "{ logging: { level: 'debug' } }")],
    );
    let openclaw: serde_json::Value =
        serde_json::from_str(&openclaw[OPENCLAW_CONFIG_FILE_ID]).unwrap();
    assert_eq!(openclaw["logging"]["level"].as_str(), Some("debug"));
    assert_eq!(
        openclaw["agents"]["defaults"]["model"]["primary"].as_str(),
        Some("orgii/test-model")
    );
    assert_eq!(
        openclaw["models"]["providers"]["orgii"]["api"].as_str(),
        Some("openai-completions")
    );

    let qwen = generated_for(
        QWEN_CODE_AGENT,
        &[(QWEN_CODE_SETTINGS_FILE_ID, "{\"theme\":\"dark\"}")],
    );
    let qwen: serde_json::Value = serde_json::from_str(&qwen[QWEN_CODE_SETTINGS_FILE_ID]).unwrap();
    assert_eq!(qwen["theme"].as_str(), Some("dark"));
    assert_eq!(
        qwen["security"]["auth"]["selectedType"].as_str(),
        Some("orgii")
    );
    assert_eq!(qwen["providerProtocol"]["orgii"].as_str(), Some("openai"));
    assert_eq!(
        qwen["modelProviders"]["orgii"][0]["baseUrl"].as_str(),
        Some("http://127.0.0.1:17888/cli/qwen_code/test-proxy-token/v1")
    );
}

#[test]
fn continue_droid_and_autohand_configs_select_the_managed_model() {
    let continue_config = generated_for(
        CONTINUE_CLI_AGENT,
        &[(
            CONTINUE_CLI_CONFIG_FILE_ID,
            "name: Existing\nversion: 2.0.0\nmodels: []\n",
        )],
    );
    let continue_config: serde_yaml::Value =
        serde_yaml::from_str(&continue_config[CONTINUE_CLI_CONFIG_FILE_ID]).unwrap();
    assert_eq!(continue_config["name"].as_str(), Some("Existing"));
    assert_eq!(continue_config["models"][0]["name"].as_str(), Some("ORGII"));
    assert_eq!(
        continue_config["models"][0]["model"].as_str(),
        Some("test-model")
    );
    assert!(!continue_config["models"][0]["roles"]
        .as_sequence()
        .unwrap()
        .iter()
        .any(|role| role.as_str() == Some("apply")));

    let droid = generated_for(
        DROID_AGENT,
        &[(DROID_SETTINGS_FILE_ID, "{\"theme\":\"dark\"}")],
    );
    let droid: serde_json::Value = serde_json::from_str(&droid[DROID_SETTINGS_FILE_ID]).unwrap();
    assert_eq!(droid["theme"].as_str(), Some("dark"));
    assert_eq!(droid["model"].as_str(), Some("test-model"));
    assert_eq!(
        droid["customModels"][0]["displayName"].as_str(),
        Some("ORGII")
    );
    assert_eq!(
        droid["customModels"][0]["baseUrl"].as_str(),
        Some("http://127.0.0.1:17888/cli/droid/test-proxy-token/v1")
    );

    let autohand = generated_for(
        AUTOHAND_AGENT,
        &[(AUTOHAND_CONFIG_FILE_ID, "{\"telemetry\":false}")],
    );
    let autohand: serde_json::Value =
        serde_json::from_str(&autohand[AUTOHAND_CONFIG_FILE_ID]).unwrap();
    assert_eq!(autohand["telemetry"].as_bool(), Some(false));
    assert_eq!(autohand["provider"].as_str(), Some("openai"));
    assert_eq!(autohand["openai"]["model"].as_str(), Some("test-model"));
}

#[test]
fn vibe_omp_and_pi_multi_file_configs_are_complete() {
    let vibe = generated_for(
        MISTRAL_VIBE_AGENT,
        &[
            (MISTRAL_VIBE_CONFIG_FILE_ID, "theme = \"dark\"\n"),
            (MISTRAL_VIBE_ENV_FILE_ID, "EXISTING=keep\n"),
        ],
    );
    let vibe_config: toml::Value = toml::from_str(&vibe[MISTRAL_VIBE_CONFIG_FILE_ID]).unwrap();
    assert_eq!(vibe_config["theme"].as_str(), Some("dark"));
    assert_eq!(vibe_config["active_model"].as_str(), Some("orgii"));
    assert_eq!(vibe_config["providers"][0]["name"].as_str(), Some("orgii"));
    assert_eq!(
        vibe_config["models"][0]["name"].as_str(),
        Some("test-model")
    );
    assert!(vibe[MISTRAL_VIBE_ENV_FILE_ID].contains("EXISTING=keep"));
    assert!(vibe[MISTRAL_VIBE_ENV_FILE_ID].contains("ORGII_API_KEY=\"test-proxy-token\""));

    let omp = generated_for(
        OMP_AGENT,
        &[
            (OMP_MODELS_FILE_ID, "providers: {}\n"),
            (OMP_SETTINGS_FILE_ID, "theme:\n  dark: titanium\n"),
        ],
    );
    let omp_models: serde_yaml::Value = serde_yaml::from_str(&omp[OMP_MODELS_FILE_ID]).unwrap();
    let omp_settings: serde_yaml::Value = serde_yaml::from_str(&omp[OMP_SETTINGS_FILE_ID]).unwrap();
    assert_eq!(
        omp_models["providers"]["orgii"]["models"][0]["id"].as_str(),
        Some("test-model")
    );
    assert_eq!(
        omp_settings["modelRoles"]["default"].as_str(),
        Some("orgii/test-model")
    );
    assert!(omp_settings["modelRoles"].get("task").is_none());
    assert_eq!(omp_settings["theme"]["dark"].as_str(), Some("titanium"));

    let pi = generated_for(
        PI_AGENT,
        &[
            (PI_SETTINGS_FILE_ID, "{\"theme\":\"dark\"}"),
            (PI_MODELS_FILE_ID, "{\"providers\":{}}"),
        ],
    );
    let pi_settings: serde_json::Value = serde_json::from_str(&pi[PI_SETTINGS_FILE_ID]).unwrap();
    let pi_models: serde_json::Value = serde_json::from_str(&pi[PI_MODELS_FILE_ID]).unwrap();
    assert_eq!(pi_settings["theme"].as_str(), Some("dark"));
    assert_eq!(pi_settings["defaultProvider"].as_str(), Some("orgii"));
    assert_eq!(pi_settings["defaultModel"].as_str(), Some("test-model"));
    assert_eq!(
        pi_models["providers"]["orgii"]["models"][0]["id"].as_str(),
        Some("test-model")
    );
}

#[test]
fn generated_proxy_token_has_256_bits() {
    let token = generate_proxy_token();
    assert_eq!(token.len(), 64);
    assert!(token.chars().all(|ch| ch.is_ascii_hexdigit()));
}

#[test]
fn atomic_write_replaces_existing_file_without_delete_gap() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("config.json");
    std::fs::write(&path, b"old").unwrap();

    write_file_atomic(&path, b"new").unwrap();

    assert_eq!(std::fs::read(&path).unwrap(), b"new");
}

#[test]
fn transaction_rolls_back_prior_targets_when_later_write_fails() {
    let _env_lock = TEST_ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let temp = tempfile::tempdir().unwrap();
    let _home = OrgiiHomeGuard::set(&temp.path().join("orgii-home"));
    let target_a_path = temp.path().join("a.json");
    let blocked_parent = temp.path().join("blocked-parent");
    let target_b_path = blocked_parent.join("b.json");
    std::fs::write(&target_a_path, b"original-a").unwrap();
    std::fs::write(&blocked_parent, b"not-a-directory").unwrap();

    let profile_root = temp.path().join("profiles");
    let target_a = test_target("a", &target_a_path, &profile_root);
    let target_b = test_target("b", &target_b_path, &profile_root);
    let targets = vec![target_a.clone(), target_b.clone()];
    let snapshots = read_target_snapshots(&targets).unwrap();
    let manifest = test_manifest("test-agent", targets);
    let mutations = BTreeMap::from([
        (
            "a".to_string(),
            TargetMutation::Write(b"managed-a".to_vec()),
        ),
        (
            "b".to_string(),
            TargetMutation::Write(b"managed-b".to_vec()),
        ),
    ]);

    let result = execute_transaction("test-agent", &snapshots, &mutations, &manifest);

    assert!(result.is_err());
    assert_eq!(std::fs::read(&target_a_path).unwrap(), b"original-a");
    assert!(!target_b_path.exists());
    assert!(!transaction_journal_path("test-agent").exists());
}

#[test]
fn pending_transaction_recovers_exact_pre_operation_content() {
    let _env_lock = TEST_ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let temp = tempfile::tempdir().unwrap();
    let _home = OrgiiHomeGuard::set(&temp.path().join("orgii-home"));
    let target_path = temp.path().join("config.toml");
    std::fs::write(&target_path, b"original").unwrap();
    let target = test_target("config", &target_path, &temp.path().join("profiles"));
    let snapshots = read_target_snapshots(std::slice::from_ref(&target)).unwrap();
    let manifest = test_manifest("test-agent", vec![target]);

    begin_transaction("test-agent", &snapshots, &manifest).unwrap();
    write_file_atomic(&target_path, b"managed").unwrap();
    recover_pending_transaction_unlocked("test-agent").unwrap();

    assert_eq!(std::fs::read(&target_path).unwrap(), b"original");
    assert!(!transaction_journal_path("test-agent").exists());
}

#[test]
fn committed_transaction_cleanup_does_not_undo_target_changes() {
    let _env_lock = TEST_ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let temp = tempfile::tempdir().unwrap();
    let _home = OrgiiHomeGuard::set(&temp.path().join("orgii-home"));
    let target_path = temp.path().join("config.toml");
    std::fs::write(&target_path, b"original").unwrap();
    let target = test_target("config", &target_path, &temp.path().join("profiles"));
    let snapshots = read_target_snapshots(std::slice::from_ref(&target)).unwrap();
    let manifest = test_manifest("test-agent", vec![target]);

    begin_transaction("test-agent", &snapshots, &manifest).unwrap();
    write_file_atomic(&target_path, b"managed").unwrap();
    write_manifest(&manifest).unwrap();
    recover_pending_transaction_unlocked("test-agent").unwrap();

    assert_eq!(std::fs::read(&target_path).unwrap(), b"managed");
    assert!(!transaction_journal_path("test-agent").exists());
}

#[test]
fn refreshed_default_backups_are_versioned_and_never_overwritten() {
    let _env_lock = TEST_ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let temp = tempfile::tempdir().unwrap();
    let _home = OrgiiHomeGuard::set(&temp.path().join("orgii-home"));
    let target_path = temp.path().join("config.toml");
    let profile_root = temp.path().join("profiles");
    let target = test_target("config", &target_path, &profile_root);

    std::fs::write(&target_path, b"default-v1").unwrap();
    let snapshots = read_target_snapshots(std::slice::from_ref(&target)).unwrap();
    let first = ensure_default_backup_from_snapshot(
        "test-agent",
        target,
        snapshots.get("config").unwrap(),
        true,
    )
    .unwrap();

    std::fs::write(&target_path, b"default-v2").unwrap();
    let snapshots = read_target_snapshots(std::slice::from_ref(&first)).unwrap();
    let second = ensure_default_backup_from_snapshot(
        "test-agent",
        first.clone(),
        snapshots.get("config").unwrap(),
        true,
    )
    .unwrap();

    assert_ne!(first.default_backup_path, second.default_backup_path);
    assert_eq!(
        std::fs::read(&first.default_backup_path).unwrap(),
        b"default-v1"
    );
    assert_eq!(
        std::fs::read(&second.default_backup_path).unwrap(),
        b"default-v2"
    );
}

#[test]
fn restore_is_a_noop_when_default_mode_is_already_active() {
    let _env_lock = TEST_ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let temp = tempfile::tempdir().unwrap();
    let _home = OrgiiHomeGuard::set(&temp.path().join("orgii-home"));
    let target_path = temp.path().join("config.toml");
    let profile_root = temp.path().join("profiles");
    let mut target = test_target("config", &target_path, &profile_root);
    let backup_path = PathBuf::from(&target.default_backup_path);
    std::fs::create_dir_all(backup_path.parent().unwrap()).unwrap();
    std::fs::write(&backup_path, b"older-default").unwrap();
    std::fs::write(&target_path, b"new-user-change").unwrap();
    target.original_hash = Some(sha256_bytes(b"older-default"));
    target.last_applied_hash = Some(sha256_bytes(b"managed"));

    let mut manifest = test_manifest(CODEX_AGENT, vec![target]);
    manifest.mode = CliConfigMode::Default;
    write_manifest(&manifest).unwrap();

    restore_agent_default_unlocked(CODEX_AGENT, false).unwrap();

    assert_eq!(std::fs::read(&target_path).unwrap(), b"new-user-change");
}

#[test]
fn shutdown_restores_active_managed_config_without_forcing() {
    let _env_lock = TEST_ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let temp = tempfile::tempdir().unwrap();
    let _home = OrgiiHomeGuard::set(&temp.path().join("orgii-home"));
    let target_path = temp.path().join("config.toml");
    let profile_root = temp.path().join("profiles");
    let mut target = test_target("config", &target_path, &profile_root);
    let backup_path = PathBuf::from(&target.default_backup_path);
    std::fs::create_dir_all(backup_path.parent().unwrap()).unwrap();
    std::fs::write(&backup_path, b"default-config").unwrap();
    std::fs::write(&target_path, b"managed-config").unwrap();
    target.original_hash = Some(sha256_bytes(b"default-config"));
    target.last_applied_hash = Some(sha256_bytes(b"managed-config"));
    write_manifest(&test_manifest(CODEX_AGENT, vec![target])).unwrap();

    let report = restore_managed_configs_for_shutdown().unwrap();

    assert_eq!(report.restored_agents, vec![CODEX_AGENT.to_string()]);
    assert!(report.failed_agents.is_empty());
    assert_eq!(std::fs::read(&target_path).unwrap(), b"default-config");
    assert_eq!(
        read_manifest(CODEX_AGENT).unwrap().unwrap().mode,
        CliConfigMode::Default
    );
}

#[test]
fn shutdown_leaves_externally_modified_managed_config_untouched() {
    let _env_lock = TEST_ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let temp = tempfile::tempdir().unwrap();
    let _home = OrgiiHomeGuard::set(&temp.path().join("orgii-home"));
    let target_path = temp.path().join("config.toml");
    let profile_root = temp.path().join("profiles");
    let mut target = test_target("config", &target_path, &profile_root);
    let backup_path = PathBuf::from(&target.default_backup_path);
    std::fs::create_dir_all(backup_path.parent().unwrap()).unwrap();
    std::fs::write(&backup_path, b"default-config").unwrap();
    std::fs::write(&target_path, b"external-change").unwrap();
    target.original_hash = Some(sha256_bytes(b"default-config"));
    target.last_applied_hash = Some(sha256_bytes(b"managed-config"));
    write_manifest(&test_manifest(CODEX_AGENT, vec![target])).unwrap();

    let report = restore_managed_configs_for_shutdown().unwrap();

    assert!(report.restored_agents.is_empty());
    assert_eq!(report.failed_agents.len(), 1);
    assert_eq!(report.failed_agents[0].0, CODEX_AGENT);
    assert_eq!(std::fs::read(&target_path).unwrap(), b"external-change");
    assert_eq!(
        read_manifest(CODEX_AGENT).unwrap().unwrap().mode,
        CliConfigMode::OrgiiManaged
    );
}

#[test]
fn missing_managed_mode_backup_is_never_recreated_from_active_config() {
    let temp = tempfile::tempdir().unwrap();
    let target_path = temp.path().join("config.toml");
    std::fs::write(&target_path, b"managed-content").unwrap();
    let mut target = test_target("config", &target_path, &temp.path().join("profiles"));
    target.original_hash = Some(sha256_bytes(b"original-content"));
    target.last_applied_hash = Some(sha256_bytes(b"managed-content"));
    let snapshots = read_target_snapshots(std::slice::from_ref(&target)).unwrap();

    let result = ensure_default_backup_from_snapshot(
        "test-agent",
        target,
        snapshots.get("config").unwrap(),
        false,
    );

    assert!(result.is_err());
}

#[test]
fn hosted_codex_profile_is_owned_valid_toml_and_uses_bounded_internal_retries() {
    let temp = tempfile::tempdir().unwrap();

    write_codex_hosted_profile(temp.path(), "http://127.0.0.1:43123/").unwrap();

    let content = std::fs::read_to_string(temp.path().join("config.toml")).unwrap();
    let config: toml::Value = toml::from_str(&content).unwrap();
    let proxy = &config["model_providers"]["proxy"];
    assert_eq!(
        proxy["base_url"].as_str(),
        Some("http://127.0.0.1:43123/v1")
    );
    assert_eq!(proxy["env_key"].as_str(), Some("PROXY_TOKEN"));
    assert_eq!(proxy["requires_openai_auth"].as_bool(), Some(false));
    assert_eq!(proxy["wire_api"].as_str(), Some("responses"));
    assert_eq!(proxy["supports_websockets"].as_bool(), Some(false));
    assert_eq!(
        proxy["request_max_retries"].as_integer(),
        Some(CODEX_REQUEST_MAX_RETRIES)
    );
    assert_eq!(
        proxy["stream_max_retries"].as_integer(),
        Some(CODEX_STREAM_MAX_RETRIES)
    );
}

#[cfg(unix)]
#[test]
fn credential_profile_writes_are_owner_only_from_the_first_byte() {
    use std::os::unix::fs::PermissionsExt;

    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("auth.json");

    write_cli_profile_file_atomic(&path, b"{\"token\":\"secret\"}").unwrap();
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600,
        "credential file must land owner-only without a separate chmod"
    );

    // Rewriting goes through a fresh temp file; the replacement must be just
    // as private as the original, and no staging file may survive.
    write_cli_profile_file_atomic(&path, b"{\"token\":\"rotated\"}").unwrap();
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let leftovers: Vec<_> = std::fs::read_dir(temp.path())
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.file_name())
        .filter(|name| name.to_string_lossy().ends_with(".tmp"))
        .collect();
    assert!(
        leftovers.is_empty(),
        "staging files left behind: {leftovers:?}"
    );
}

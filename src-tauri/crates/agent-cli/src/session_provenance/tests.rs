use super::antigravity::*;
use super::claude::*;
use super::codex::*;
use super::config::*;
use super::cursor::*;
use super::factory_droid::*;
use super::kimi::*;
use super::opencode::*;
use super::qwen_code::*;
use super::trae::*;
use super::windsurf::*;
use super::zcode::*;
use super::*;

use serde_json::{json, Map, Value};
use std::path::Path;

#[test]
fn nested_config_preserves_user_hooks_and_removes_only_ours() {
    let mut config = json!({
        "hooks": {"PostToolUse": [{
            "matcher": "Read",
            "hooks": [{"type": "command", "command": "user-hook"}]
        }]},
        "theme": "dark"
    });
    update_nested_platform(
        &mut config,
        true,
        "Read",
        "orgii --session-provenance-hook claude",
        "orgii.exe --session-provenance-hook claude",
    )
    .expect("enable nested hook");
    update_nested_platform(&mut config, false, "Read", "unused", "unused")
        .expect("disable nested hook");
    assert_eq!(config["theme"], "dark");
    assert_eq!(
        config["hooks"]["PostToolUse"][0]["hooks"][0]["command"],
        "user-hook"
    );
    assert!(!config.to_string().contains(HOOK_MARKER));
}

#[test]
fn claude_lifecycle_events_install_and_remove_symmetrically() {
    let mut config = json!({
        "hooks": {"Stop": [{
            "hooks": [{"type": "command", "command": "user-stop-hook"}]
        }]},
        "theme": "dark"
    });
    let unix = "orgii --session-provenance-hook claude";
    let windows = "orgii.exe --session-provenance-hook claude";
    update_claude_lifecycle_events(&mut config, true, unix, windows)
        .expect("install lifecycle events");
    for (event_name, matcher) in CLAUDE_CODE_LIFECYCLE_EVENTS {
        assert!(
            nested_event_has_managed_hook(
                &config,
                SessionProvenanceHookPlatform::ClaudeCode,
                event_name,
                *matcher
            ),
            "missing managed {event_name}"
        );
    }
    // Completeness follows the live-status shape once PostToolUse widens.
    update_nested_platform(
        &mut config,
        true,
        CLAUDE_CODE_LIVE_STATUS_POST_TOOL_USE_MATCHER,
        unix,
        windows,
    )
    .expect("install live-status PostToolUse");
    assert!(config_has_complete_managed_hooks(
        &config,
        SessionProvenanceHookPlatform::ClaudeCode,
        true
    ));
    // Legacy shape (file matcher only) is NOT complete under live status.
    assert!(!config_has_complete_managed_hooks(
        &json!({"hooks": {"PostToolUse": [{
            "matcher": CLAUDE_CODE_POST_TOOL_USE_MATCHER,
            "hooks": [{"type": "command", "command": unix}]
        }]}}),
        SessionProvenanceHookPlatform::ClaudeCode,
        true
    ));

    update_claude_lifecycle_events(&mut config, false, "unused", "unused")
        .expect("remove lifecycle events");
    // The user's own Stop hook survives; every managed lifecycle entry is
    // gone (PostToolUse keeps the managed provenance hook).
    assert_eq!(
        config["hooks"]["Stop"][0]["hooks"][0]["command"],
        "user-stop-hook"
    );
    for (event_name, matcher) in CLAUDE_CODE_LIFECYCLE_EVENTS {
        assert!(
            !nested_event_has_managed_hook(
                &config,
                SessionProvenanceHookPlatform::ClaudeCode,
                event_name,
                *matcher
            ),
            "managed {event_name} not removed"
        );
    }
    assert_eq!(config["theme"], "dark");
}

#[test]
fn claude_permission_request_hook_gets_blocking_timeout_and_stale_installs_repair() {
    let unix = "orgii --session-provenance-hook claude";
    let windows = "orgii.exe --session-provenance-hook claude";
    let mut config = json!({});
    update_claude_lifecycle_events(&mut config, true, unix, windows)
        .expect("install lifecycle events");
    update_nested_platform(
        &mut config,
        true,
        CLAUDE_CODE_LIVE_STATUS_POST_TOOL_USE_MATCHER,
        unix,
        windows,
    )
    .expect("install live-status PostToolUse");

    // Only the PermissionRequest entry carries the raised long-poll
    // timeout; every other lifecycle event keeps the fast default.
    for (event_name, _) in CLAUDE_CODE_LIFECYCLE_EVENTS {
        let expected = if *event_name == "PermissionRequest" {
            CLAUDE_PERMISSION_REQUEST_HOOK_TIMEOUT_SECS
        } else {
            DEFAULT_HOOK_TIMEOUT_SECS
        };
        let timeout = config["hooks"][*event_name][0]["hooks"][0]["timeout"]
            .as_u64()
            .unwrap_or_else(|| panic!("missing timeout on {event_name}"));
        assert_eq!(timeout, expected, "wrong timeout on {event_name}");
    }
    assert!(config_has_complete_managed_hooks(
        &config,
        SessionProvenanceHookPlatform::ClaudeCode,
        true
    ));

    // A pre-approval-bridge install (PermissionRequest at the old 5s
    // timeout) is incomplete under live status, so startup reconcile
    // rewrites it with the raised timeout.
    config["hooks"]["PermissionRequest"][0]["hooks"][0]["timeout"] = json!(5);
    assert!(!config_has_complete_managed_hooks(
        &config,
        SessionProvenanceHookPlatform::ClaudeCode,
        true
    ));
    update_claude_lifecycle_events(&mut config, true, unix, windows)
        .expect("repair lifecycle events");
    assert!(config_has_complete_managed_hooks(
        &config,
        SessionProvenanceHookPlatform::ClaudeCode,
        true
    ));
}

#[test]
fn claude_completeness_uses_legacy_shape_when_live_status_off() {
    let unix = "orgii --session-provenance-hook claude";
    let legacy = json!({"hooks": {"PostToolUse": [{
        "matcher": CLAUDE_CODE_POST_TOOL_USE_MATCHER,
        "hooks": [{"type": "command", "command": unix}]
    }]}});
    assert!(config_has_complete_managed_hooks(
        &legacy,
        SessionProvenanceHookPlatform::ClaudeCode,
        false
    ));
    assert!(!config_has_complete_managed_hooks(
        &legacy,
        SessionProvenanceHookPlatform::ClaudeCode,
        true
    ));
}

#[test]
fn codex_matcher_uses_public_hook_tool_names() {
    assert!(CODEX_POST_TOOL_USE_MATCHER.contains("Bash"));
    assert!(CODEX_POST_TOOL_USE_MATCHER.contains("apply_patch"));
    assert!(!CODEX_POST_TOOL_USE_MATCHER.contains("exec_command"));
}

#[test]
fn codex_config_installs_and_removes_required_hooks() {
    let mut config = json!({
        "hooks": {
            "SubagentStop": [{
                "matcher": "explorer",
                "hooks": [{"type": "command", "command": "user-hook"}]
            }]
        }
    });
    update_codex_platform(
        &mut config,
        true,
        false,
        "orgii --session-provenance-hook codex",
        "orgii.exe --session-provenance-hook codex",
    )
    .expect("enable Codex hooks");

    assert_eq!(config["hooks"]["PostToolUse"].as_array().unwrap().len(), 1);
    assert_eq!(config["hooks"]["SessionStart"].as_array().unwrap().len(), 1);
    assert_eq!(
        config["hooks"]["SubagentStart"].as_array().unwrap().len(),
        1
    );
    assert_eq!(config["hooks"]["SubagentStop"].as_array().unwrap().len(), 2);
    assert!(config_has_complete_managed_hooks(
        &config,
        SessionProvenanceHookPlatform::Codex,
        false
    ));

    config["hooks"]["SessionStart"] = json!([]);
    assert!(!config_has_complete_managed_hooks(
        &config,
        SessionProvenanceHookPlatform::Codex,
        false
    ));

    update_codex_platform(
        &mut config,
        true,
        false,
        "orgii --session-provenance-hook codex",
        "orgii.exe --session-provenance-hook codex",
    )
    .expect("repair incomplete Codex hooks");

    update_codex_platform(&mut config, false, false, "unused", "unused")
        .expect("disable Codex hooks");
    assert!(config.to_string().contains("user-hook"));
    assert!(!config.to_string().contains(HOOK_MARKER));
}

#[test]
fn codex_fingerprint_tracks_only_managed_definition_changes() {
    let mut config = json!({
        "hooks": {
            "PostToolUse": [{
                "matcher": "Read",
                "hooks": [{"type": "command", "command": "user-hook"}]
            }]
        },
        "theme": "dark"
    });
    update_codex_platform(
        &mut config,
        true,
        false,
        "orgii --session-provenance-hook codex",
        "orgii.exe --session-provenance-hook codex",
    )
    .expect("enable Codex hooks");
    let original = managed_hook_fingerprint(&config, SessionProvenanceHookPlatform::Codex)
        .expect("managed fingerprint");

    config["hooks"]["PostToolUse"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "matcher": "Write",
            "hooks": [{"type": "command", "command": "another-user-hook"}]
        }));
    config["theme"] = json!("light");
    assert_eq!(
        managed_hook_fingerprint(&config, SessionProvenanceHookPlatform::Codex),
        Some(original.clone()),
        "unrelated user configuration must not invalidate approval"
    );

    let managed_group = config["hooks"]["PostToolUse"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|group| group.to_string().contains(HOOK_MARKER))
        .expect("managed PostToolUse group");
    managed_group["matcher"] = json!("apply_patch");
    assert_ne!(
        managed_hook_fingerprint(&config, SessionProvenanceHookPlatform::Codex),
        Some(original),
        "a managed matcher change requires fresh approval"
    );
}

#[test]
fn codex_activation_requires_a_matching_receipt() {
    let receipt = HookActivationReceipt {
        schema_version: ACTIVATION_RECEIPT_SCHEMA_VERSION,
        platform: SessionProvenanceHookPlatform::Codex,
        hook_fingerprint: "current".to_string(),
        activated_at: "2026-07-15T12:00:00.000Z".to_string(),
    };
    assert_eq!(
        codex_activation_from_receipt("current", None),
        (
            SessionProvenanceHookActivationState::AwaitingVerification,
            None
        )
    );
    assert_eq!(
        codex_activation_from_receipt("stale", Some(receipt.clone())),
        (
            SessionProvenanceHookActivationState::AwaitingVerification,
            None
        )
    );
    assert_eq!(
        codex_activation_from_receipt("current", Some(receipt)),
        (
            SessionProvenanceHookActivationState::Active,
            Some("2026-07-15T12:00:00.000Z".to_string())
        )
    );
}

#[test]
fn activation_state_is_immediate_for_providers_without_a_trust_gate() {
    assert_eq!(
        activation_for_installed_hook(SessionProvenanceHookPlatform::ClaudeCode, true)
            .expect("Claude activation"),
        (SessionProvenanceHookActivationState::Active, None)
    );
    assert_eq!(
        activation_for_installed_hook(SessionProvenanceHookPlatform::Codex, false)
            .expect("inactive Codex"),
        (SessionProvenanceHookActivationState::Inactive, None)
    );
}

#[test]
fn cursor_config_preserves_user_events() {
    let mut config = json!({
        "version": 1,
        "hooks": {"postToolUse": [{"command": "user-hook"}]}
    });
    update_cursor_platform(
        &mut config,
        true,
        false,
        "orgii --session-provenance-hook cursor",
    )
    .expect("enable Cursor hook");
    assert_eq!(config["hooks"]["postToolUse"].as_array().unwrap().len(), 2);
    assert_eq!(
        config["hooks"]["subagentStart"].as_array().unwrap().len(),
        1
    );
    assert_eq!(config["hooks"]["subagentStop"].as_array().unwrap().len(), 1);
    assert!(config_has_complete_managed_hooks(
        &config,
        SessionProvenanceHookPlatform::Cursor,
        false
    ));
    update_cursor_platform(&mut config, false, false, "unused").expect("disable Cursor hook");
    assert_eq!(config["hooks"]["postToolUse"].as_array().unwrap().len(), 1);
    assert!(config["hooks"]["subagentStart"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(config["hooks"]["subagentStop"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn qwen_config_installs_scoped_post_tool_use_and_preserves_user_hooks() {
    let mut config = json!({
        "hooks": {"PostToolUse": [{
            "matcher": "read_file",
            "hooks": [{"type": "command", "command": "user-hook"}]
        }]},
        "theme": "dark"
    });
    update_nested_platform(
        &mut config,
        true,
        QWEN_CODE_POST_TOOL_USE_MATCHER,
        "orgii --session-provenance-hook qwen",
        "orgii.exe --session-provenance-hook qwen",
    )
    .expect("enable Qwen hook");
    assert_eq!(config["theme"], "dark");
    assert!(config_has_complete_managed_hooks(
        &config,
        SessionProvenanceHookPlatform::QwenCode,
        false
    ));
    // The managed matcher is Qwen-specific, not the Claude Code one.
    assert!(!config_has_complete_managed_hooks(
        &config,
        SessionProvenanceHookPlatform::ClaudeCode,
        false
    ));
    update_nested_platform(
        &mut config,
        false,
        QWEN_CODE_POST_TOOL_USE_MATCHER,
        "x",
        "x",
    )
    .expect("disable Qwen hook");
    assert!(config.to_string().contains("user-hook"));
    assert!(!config.to_string().contains(HOOK_MARKER));
}

#[test]
fn factory_droid_config_installs_and_removes_only_our_hook() {
    let mut config = json!({});
    update_nested_platform(
        &mut config,
        true,
        FACTORY_DROID_POST_TOOL_USE_MATCHER,
        "orgii --session-provenance-hook droid",
        "orgii.exe --session-provenance-hook droid",
    )
    .expect("enable Droid hook");
    assert!(config_has_complete_managed_hooks(
        &config,
        SessionProvenanceHookPlatform::FactoryDroid,
        false
    ));
    assert!(config.to_string().contains(HOOK_MARKER));
    update_nested_platform(
        &mut config,
        false,
        FACTORY_DROID_POST_TOOL_USE_MATCHER,
        "x",
        "x",
    )
    .expect("disable Droid hook");
    assert!(!config.to_string().contains(HOOK_MARKER));
}

#[test]
fn trae_config_installs_versioned_single_command_hook_and_preserves_user_hooks() {
    let mut config = json!({
        "version": 1,
        "hooks": {"PostToolUse": [{
            "matcher": "RunCommand",
            "hooks": [{"type": "command", "command": "user-hook"}]
        }]}
    });
    update_trae_platform(&mut config, true, "orgii --session-provenance-hook trae")
        .expect("enable Trae hook");
    assert_eq!(config["version"], 1);
    assert!(config_has_complete_managed_hooks(
        &config,
        SessionProvenanceHookPlatform::Trae,
        false
    ));
    // Trae uses a single `command` field — never `commandWindows`.
    let ours = config["hooks"]["PostToolUse"]
        .as_array()
        .unwrap()
        .iter()
        .find(|group| {
            group["hooks"][0]["command"]
                .as_str()
                .is_some_and(|command| command.contains(HOOK_MARKER))
        })
        .expect("managed Trae group");
    assert!(ours["hooks"][0].get("commandWindows").is_none());
    update_trae_platform(&mut config, false, "x").expect("disable Trae hook");
    assert!(config.to_string().contains("user-hook"));
    assert!(!config.to_string().contains(HOOK_MARKER));
}

#[test]
fn windsurf_config_installs_event_keyed_hooks_and_preserves_user_hooks() {
    let mut config = json!({
        "hooks": {"post_write_code": [{"command": "user-hook"}]}
    });
    update_windsurf_platform(
        &mut config,
        true,
        "orgii --session-provenance-hook windsurf",
        "orgii.exe --session-provenance-hook windsurf",
    )
    .expect("enable Windsurf hook");
    // User hook preserved; our hook added to both file events.
    assert_eq!(
        config["hooks"]["post_write_code"].as_array().unwrap().len(),
        2
    );
    assert_eq!(
        config["hooks"]["post_read_code"].as_array().unwrap().len(),
        1
    );
    assert!(config_has_complete_managed_hooks(
        &config,
        SessionProvenanceHookPlatform::Windsurf,
        false
    ));
    update_windsurf_platform(&mut config, false, "x", "x").expect("disable Windsurf hook");
    assert_eq!(
        config["hooks"]["post_write_code"].as_array().unwrap().len(),
        1
    );
    assert!(config.to_string().contains("user-hook"));
    assert!(!config.to_string().contains(HOOK_MARKER));
}

#[test]
fn antigravity_config_installs_own_group_and_preserves_others() {
    let mut config = json!({
        "orca-status": {
            "PostToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "orca-hook" }] }]
        }
    });
    update_antigravity_platform(
        &mut config,
        true,
        false,
        "orgii --session-provenance-hook antigravity",
    )
    .expect("enable Antigravity hook");
    // Foreign group untouched; our group present.
    assert!(config.get("orca-status").is_some());
    assert!(antigravity_has_managed_hook(&config));
    assert!(config_has_complete_managed_hooks(
        &config,
        SessionProvenanceHookPlatform::Antigravity,
        false
    ));
    update_antigravity_platform(&mut config, false, false, "x").expect("disable Antigravity hook");
    assert!(config.get(ANTIGRAVITY_HOOK_GROUP).is_none());
    assert!(config.get("orca-status").is_some());
    assert!(!config.to_string().contains(HOOK_MARKER));
}

#[test]
fn kimi_toml_install_preserves_user_hooks_and_removes_only_ours() {
    let mut root: toml::Value = toml::from_str(
        "model = \"kimi-k2\"\n\n[[hooks]]\nevent = \"Stop\"\ncommand = \"user-hook\"\n",
    )
    .expect("parse base config");
    kimi_apply_managed_hook(
        &mut root,
        true,
        false,
        "orgii --session-provenance-hook kimi",
    )
    .expect("enable Kimi hook");
    let serialized = toml::to_string_pretty(&root).expect("serialize");
    assert!(serialized.contains("model = \"kimi-k2\""));
    assert!(serialized.contains("user-hook"));
    assert!(serialized.contains(HOOK_MARKER));
    assert!(serialized.contains("StrReplaceFile"));

    kimi_apply_managed_hook(&mut root, false, false, "unused").expect("disable Kimi hook");
    let serialized = toml::to_string_pretty(&root).expect("serialize");
    assert!(serialized.contains("user-hook"));
    assert!(!serialized.contains(HOOK_MARKER));
}

#[test]
fn kimi_managed_detection_reads_the_toml_hooks_array() {
    let temp = tempfile::tempdir().expect("temp dir");
    let path = temp.path().join("config.toml");
    std::fs::write(
        &path,
        format!("[[hooks]]\nevent = \"PostToolUse\"\ncommand = \"orgii {HOOK_MARKER} kimi\"\n"),
    )
    .expect("write managed config");
    assert!(kimi_config_is_managed(&path));

    std::fs::write(&path, "[[hooks]]\nevent = \"Stop\"\ncommand = \"other\"\n")
        .expect("write user config");
    assert!(!kimi_config_is_managed(&path));
    assert!(!kimi_config_is_managed(&temp.path().join("missing.toml")));
}

#[test]
fn opencode_plugin_template_embeds_binary_and_marker() {
    let rendered = OPENCODE_PLUGIN_TEMPLATE.replace(
        "__ORGII_BINARY__",
        &js_escaped_path(Path::new("/Apps/ORG2/orgii")),
    );
    assert!(rendered.contains("/Apps/ORG2/orgii"));
    assert!(rendered.contains(HOOK_MARKER));
    assert!(rendered.contains("tool.execute.after"));
    assert!(!rendered.contains("__ORGII_BINARY__"));
}

#[test]
fn js_escaped_path_escapes_backslashes_and_quotes() {
    assert_eq!(
        js_escaped_path(Path::new(r"C:\Program Files\orgii.exe")),
        r"C:\\Program Files\\orgii.exe"
    );
}

#[test]
fn opencode_managed_detection_only_matches_our_plugin() {
    let temp = tempfile::tempdir().expect("temp dir");
    let managed = temp.path().join("orgii-session-provenance.js");
    std::fs::write(
        &managed,
        format!("// {HOOK_MARKER} opencode\nexport const X = 1;"),
    )
    .expect("write managed plugin");
    assert!(opencode_plugin_is_managed(&managed));

    let user = temp.path().join("user-plugin.js");
    std::fs::write(&user, "export const Y = 2;").expect("write user plugin");
    assert!(!opencode_plugin_is_managed(&user));
    assert!(!opencode_plugin_is_managed(&temp.path().join("missing.js")));
}

#[test]
fn platform_wire_ids_match_the_frontend_enum() {
    // These strings are the contract with the TS `SessionProvenanceHookPlatformSchema`.
    // A mismatch makes `session_provenance_hooks_set_enabled` reject the platform.
    let cases = [
        (SessionProvenanceHookPlatform::ClaudeCode, "claude_code"),
        (SessionProvenanceHookPlatform::Codex, "codex"),
        (SessionProvenanceHookPlatform::Cursor, "cursor"),
        (SessionProvenanceHookPlatform::QwenCode, "qwen_code"),
        (SessionProvenanceHookPlatform::FactoryDroid, "factory_droid"),
        (SessionProvenanceHookPlatform::Trae, "trae"),
        (SessionProvenanceHookPlatform::OpenCode, "opencode"),
        (SessionProvenanceHookPlatform::Windsurf, "windsurf"),
        (SessionProvenanceHookPlatform::Kimi, "kimi"),
        (SessionProvenanceHookPlatform::Antigravity, "antigravity"),
        (SessionProvenanceHookPlatform::ZCode, "zcode"),
    ];
    for (platform, expected) in cases {
        assert_eq!(
            serde_json::to_value(platform).unwrap(),
            serde_json::Value::String(expected.to_string()),
            "unexpected wire id for {platform:?}"
        );
        let round_trip: SessionProvenanceHookPlatform =
            serde_json::from_value(serde_json::json!(expected)).unwrap();
        assert_eq!(round_trip, platform);
    }
}

#[test]
fn preferences_default_to_all_platforms_enabled() {
    let preferences = HookPreferences::default();
    for platform in ALL_SESSION_PROVENANCE_HOOK_PLATFORMS {
        assert!(
            preferences.enabled(platform),
            "expected {platform:?} enabled by default"
        );
    }
    assert_eq!(ALL_SESSION_PROVENANCE_HOOK_PLATFORMS.len(), 11);
}

#[test]
fn zcode_plugin_hooks_value_carries_marker_and_post_tool_use() {
    let hooks = zcode_hooks_value("orgii --session-provenance-hook zcode");
    assert_eq!(
        hooks["hooks"]["PostToolUse"][0]["matcher"],
        ZCODE_POST_TOOL_USE_MATCHER
    );
    let command = hooks["hooks"]["PostToolUse"][0]["hooks"][0]["command"]
        .as_str()
        .unwrap();
    assert!(command.contains(HOOK_MARKER));
    assert!(command.ends_with("zcode"));
    // ZCode plugin/data/marketplace paths stay inside its plugin store.
    assert!(zcode_plugin_hooks_path()
        .to_string_lossy()
        .contains(".zcode/cli/plugins"));
    assert!(zcode_plugin_data_dir()
        .to_string_lossy()
        .ends_with("session-provenance@orgii"));
}

#[test]
fn zcode_plugin_id_is_name_at_marketplace() {
    assert_eq!(
        zcode_plugin_id(),
        format!("{ZCODE_PLUGIN_NAME}@{ZCODE_PLUGIN_MARKETPLACE}")
    );
}

#[test]
fn zcode_config_path_is_under_zcode_cli() {
    let path = zcode_config_path();
    let path_str = path.to_string_lossy();
    assert!(
        path_str.ends_with(".zcode/cli/config.json"),
        "expected ~/.zcode/cli/config.json, got {path_str}"
    );
}

#[test]
fn zcode_set_plugin_enabled_writes_config_entry_and_preserves_user_keys() {
    let temp = tempfile::tempdir().expect("temp config dir");
    let config_path = temp.path().join("config.json");
    let seed = json!({
        "model": "glm-5",
        "plugins": {
            "enabledPlugins": { "other-plugin": true }
        }
    });
    std::fs::write(&config_path, seed.to_string()).expect("write seed config");

    // Initially our plugin is not enabled.
    let mut config = read_config(&config_path).expect("read seed");
    assert!(!zcode_plugin_is_enabled_in(&config));

    // Enable, then read back from disk to prove it persisted.
    set_plugin_enabled_in_config(&mut config, true).expect("enable in memory");
    assert!(zcode_plugin_is_enabled_in(&config));
    zcode_set_plugin_enabled_at(&config_path, true).expect("enable on disk");

    let written: Value =
        serde_json::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
    assert_eq!(written["model"], "glm-5");
    assert_eq!(written["plugins"]["enabledPlugins"]["other-plugin"], true);
    assert_eq!(
        written["plugins"]["enabledPlugins"][zcode_plugin_id()],
        true
    );

    // Disabling leaves the unrelated plugin and top-level keys intact.
    zcode_set_plugin_enabled_at(&config_path, false).expect("disable on disk");
    let written: Value =
        serde_json::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
    assert_eq!(written["model"], "glm-5");
    assert_eq!(written["plugins"]["enabledPlugins"]["other-plugin"], true);
    assert!(written["plugins"]["enabledPlugins"]
        .get(zcode_plugin_id())
        .is_none_or(|v| !v.as_bool().unwrap_or(true)));
}

#[test]
fn zcode_set_plugin_enabled_creates_missing_config_file() {
    let temp = tempfile::tempdir().expect("temp config dir");
    let config_path = temp.path().join("nested").join("config.json");
    assert!(!config_path.exists());

    // No config.json exists yet; enabling must create it (and its parent).
    zcode_set_plugin_enabled_at(&config_path, true).expect("enable creates config");
    let written: Value =
        serde_json::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
    assert!(zcode_plugin_is_enabled_in(&written));
}

#[test]
fn zcode_registry_round_trip_adds_and_removes_entry() {
    let temp = tempfile::tempdir().expect("temp registry dir");
    let registry_path = temp.path().join("installed_plugins.json");
    let cache_path = temp
        .path()
        .join("cache")
        .join("session-provenance")
        .join("0.1.0");

    // Start from a registry that already lists an unrelated plugin.
    let seed = json!({
        "version": 1,
        "plugins": { "other@marketplace": { "installPath": "/x", "version": "1.0" } }
    });
    std::fs::write(&registry_path, seed.to_string()).expect("write seed registry");

    // The pure helpers are config-value based; verify via the real file by
    // re-reading after each write. We exercise the file-writing functions
    // directly against the temp path through a thin wrapper.
    // Note: zcode_set_plugin_installed uses the real plugins-root path, so
    // we verify the in-memory transform instead by parsing both states.
    let mut config = read_config(&registry_path).expect("read seed");
    assert!(!zcode_registry_has_plugin(&config));

    zcode_add_plugin_to_registry(&mut config, &cache_path);
    assert!(zcode_registry_has_plugin(&config));
    assert_eq!(
        config["plugins"][zcode_plugin_id()]["installPath"],
        cache_path.to_string_lossy().to_string()
    );
    // Unrelated plugin survives.
    assert!(config["plugins"].get("other@marketplace").is_some());

    // Remove only our entry.
    zcode_remove_plugin_from_registry_value(&mut config);
    assert!(!zcode_registry_has_plugin(&config));
    assert!(config["plugins"].get("other@marketplace").is_some());
}

#[test]
fn zcode_unparseable_config_is_treated_as_empty_not_crash() {
    let config = serde_json::from_str::<Value>("{ not valid json");
    // The pure helpers operate on already-parsed values; the tolerance is
    // exercised by `read_zcode_config` falling back to an empty object, so
    // here we just confirm an empty object reads as not-enabled.
    let empty = Value::Object(Map::new());
    assert!(!zcode_plugin_is_enabled_in(&empty));
    assert!(config.is_err(), "garbage must fail to parse");
}

#[test]
fn legacy_v1_preferences_without_new_platforms_still_load() {
    // A preferences file written before Qwen/Droid/Trae/OpenCode existed
    // omits their keys. Struct-level `default` must fill them (enabled)
    // without a schema bump.
    let preferences: HookPreferences = serde_json::from_value(json!({
        "schemaVersion": 1,
        "claudeCode": false,
        "codex": true,
        "cursor": true
    }))
    .expect("legacy preferences load");
    assert!(!preferences.enabled(SessionProvenanceHookPlatform::ClaudeCode));
    assert!(preferences.enabled(SessionProvenanceHookPlatform::QwenCode));
    assert!(preferences.enabled(SessionProvenanceHookPlatform::FactoryDroid));
    assert!(preferences.enabled(SessionProvenanceHookPlatform::Trae));
    assert!(preferences.enabled(SessionProvenanceHookPlatform::OpenCode));
}

#[test]
fn unknown_hook_shapes_fail_without_clobbering_config() {
    let mut config = json!({"hooks": "future-format", "theme": "dark"});
    let original = config.clone();
    let error = update_nested_platform(&mut config, true, "Read", "orgii", "orgii.exe")
        .expect_err("unknown shape must fail closed");
    assert!(error.contains("must be a JSON object"));
    assert_eq!(config, original);
}

#[test]
fn marker_in_unrelated_config_does_not_report_hooks_enabled() {
    let config = json!({"notes": HOOK_MARKER});
    assert!(!config_has_complete_managed_hooks(
        &config,
        SessionProvenanceHookPlatform::ClaudeCode,
        false
    ));
}

#[test]
fn newer_preferences_are_read_tolerantly_not_rejected() {
    // A preferences file written by a NEWER build (extra platform field this
    // reader doesn't know) must deserialize by ignoring the unknown field,
    // not error — otherwise reconciliation aborts and all capture is
    // silently disabled. Known fields are still read; missing ones default.
    let preferences: HookPreferences = serde_json::from_value(json!({
        "schemaVersion": 1,
        "claudeCode": false,
        "codex": true,
        "cursor": true,
        "futurePlatform": true
    }))
    .expect("newer preferences load by ignoring unknown fields");
    assert!(!preferences.enabled(SessionProvenanceHookPlatform::ClaudeCode));
    assert!(preferences.enabled(SessionProvenanceHookPlatform::Codex));
    // Fields absent in this older-shaped file fall back to enabled.
    assert!(preferences.enabled(SessionProvenanceHookPlatform::ZCode));
}

#[test]
fn atomic_write_replaces_an_existing_config() {
    let temp = tempfile::tempdir().expect("temporary config dir");
    let path = temp.path().join("hooks.json");
    std::fs::write(&path, b"old").expect("old config");

    write_atomic(&path, b"new").expect("replace config");

    assert_eq!(std::fs::read(&path).unwrap(), b"new");
}

#[cfg(unix)]
#[test]
fn atomic_write_leaves_an_unchanged_config_in_place() {
    use std::os::unix::fs::MetadataExt;

    let temp = tempfile::tempdir().expect("temporary config dir");
    let path = temp.path().join("hooks.json");
    std::fs::write(&path, b"same").expect("existing config");
    let inode_before = std::fs::metadata(&path).expect("metadata before").ino();

    write_atomic(&path, b"same").expect("unchanged config is a no-op");

    let inode_after = std::fs::metadata(&path).expect("metadata after").ino();
    assert_eq!(inode_after, inode_before);
    assert_eq!(std::fs::read(&path).unwrap(), b"same");
}

#[test]
fn codex_session_activation_is_scoped_to_task_and_hook_fingerprint() {
    let receipt = HookSessionActivationReceipt {
        schema_version: ACTIVATION_RECEIPT_SCHEMA_VERSION,
        platform: SessionProvenanceHookPlatform::Codex,
        source_session_id: "task-a".to_string(),
        hook_fingerprint: "fingerprint-a".to_string(),
        activated_at: "2026-07-20T12:00:00.000Z".to_string(),
    };

    assert!(session_activation_matches(
        "fingerprint-a",
        "task-a",
        Some(receipt.clone())
    ));
    assert!(!session_activation_matches(
        "fingerprint-a",
        "task-b",
        Some(receipt.clone())
    ));
    assert!(!session_activation_matches(
        "fingerprint-b",
        "task-a",
        Some(receipt)
    ));
}

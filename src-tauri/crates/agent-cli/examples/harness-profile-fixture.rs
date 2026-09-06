//! Used only by scripts/verification/harness-connection-cli.py in an isolated HOME.
fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3
        || !args[2].starts_with("http://127.0.0.1:")
        || std::env::var_os("ORGII_EXTERNAL_HISTORY_HOME").is_none()
    {
        return Err("Fixture requires an isolated config root and a loopback endpoint".into());
    }
    let mapped = args[1] == "claude_profiles";
    let profile = if mapped {
        use agent_cli::managed_config::{
            claude_models::{ClaudeModel, ClaudeModels, ClaudeRole},
            provider_profiles::{save, HarnessProviderProfile},
        };
        Some(save(HarnessProviderProfile {
            id: "fixture".into(),
            revision: 0,
            name: "Fixture".into(),
            target: "claude_code".into(),
            key_id: "fixture".into(),
            endpoint: args[2].clone(),
            auth_scheme: "x-api-key".into(),
            models: agent_cli::managed_config::profile_models::ProfileModels::Claude(
                ClaudeModels {
                    default_role: ClaudeRole::Sonnet,
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
                                model: format!("fixture-{}", role.as_str()),
                                display_name: format!("Display {}", role.as_str()),
                                context_1m: false,
                            },
                        )
                    })
                    .collect(),
                },
            ),
        })?)
    } else if args[1] == "codex_profiles" {
        use agent_cli::managed_config::{
            profile_models::{CodexModels, ProfileModels},
            provider_profiles::{save, HarnessProviderProfile},
        };
        Some(save(HarnessProviderProfile {
            id: "codex-fixture".into(),
            revision: 0,
            name: "Codex fixture".into(),
            target: "codex".into(),
            key_id: "fixture".into(),
            endpoint: args[2].clone(),
            auth_scheme: "bearer".into(),
            models: ProfileModels::Codex(CodexModels {
                model: "fixture-model".into(),
                reasoning_effort: Some("high".into()),
                context_window: Some(64000),
                auto_compact_token_limit: Some(50000),
            }),
        })?)
    } else {
        None
    };
    agent_cli::managed_config::enable_direct(
        if mapped {
            "claude_code"
        } else if args[1] == "codex_profiles" {
            "codex"
        } else {
            &args[1]
        },
        agent_cli::managed_config::DirectConnection {
            profile,
            desktop_auth_scheme: None,
            key_id: "fixture".into(),
            provider: "custom_api".into(),
            model: if mapped {
                "fixture-sonnet"
            } else {
                "fixture-model"
            }
            .into(),
            base_url: args[2].clone(),
            api_key: "orgii-fixture-key".into(),
        },
        None,
    )?;
    Ok(())
}

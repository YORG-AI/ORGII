//! AI-powered git utilities.
//!
//! Uses the user's configured LLM provider credentials to generate
//! commit messages from staged (or working-tree) diffs.
//!
//! Credential resolution order:
//! 1. Direct API key providers (DeepSeek, OpenAI, Gemini, etc.)
//! 2. CLI agent API keys (Claude Code → Anthropic, Codex → OpenAI, etc.)
//! 3. Cursor session token → Connect RPC to Cursor's StreamChat API

use std::collections::HashMap;
use std::path::Path;

use serde_json::json;
use tracing::info;

use agent_core::providers::openai_compat::OpenAICompatClient;
use agent_core::providers::registry::PROVIDERS;
use agent_core::providers::traits::{LLMProvider, ProviderConfig};
use key_vault::key_store::{ModelType, KEY_SERVICE};

use super::cursor_chat::cursor_stream_chat;
use super::diff::{get_diff_numstat, get_staged_diff};

const MAX_DIFF_CHARS: usize = 4000;
const MAX_INSTRUCTION_CHARS: usize = 4000;

const SYSTEM_PROMPT: &str = "\
You are a git commit message generator. Given the diff below, write a \
concise commit message following the Conventional Commits format.\n\
Return ONLY the commit message — no explanation, no markdown fences.\n\
Rules:\n\
- One-line summary, max 72 characters.\n\
- Imperative mood (\"add\", not \"added\").\n\
- Lowercase type prefix: feat | fix | refactor | docs | style | test | chore | perf | ci | build.\n\
- If the scope is obvious, include it: `feat(auth): …`\n\
- Do NOT repeat filenames already visible in the diff header.";

fn build_system_prompt(commit_instructions: Option<&str>) -> Result<String, String> {
    let Some(instructions) = commit_instructions
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(SYSTEM_PROMPT.to_string());
    };

    if instructions.chars().count() > MAX_INSTRUCTION_CHARS {
        return Err(format!(
            "Commit instructions must be {} characters or fewer",
            MAX_INSTRUCTION_CHARS
        ));
    }

    Ok(format!(
        "{}\n\nUser-configured additional instructions:\n{}",
        SYSTEM_PROMPT, instructions
    ))
}

fn build_cursor_prompt(system_prompt: &str, diff_summary: &str) -> String {
    format!("{}\n\nDiff:\n{}", system_prompt, diff_summary)
}

/// Preferred provider order for commit-message generation (cheapest first).
const PREFERRED_API_TYPES: &[ModelType] = &[
    ModelType::DeepseekApi,
    ModelType::OpenaiApi,
    ModelType::GeminiApi,
    ModelType::GroqApi,
    ModelType::XaiApi,
    ModelType::AnthropicApi,
    ModelType::OpenrouterApi,
    ModelType::ZenmuxApi,
    ModelType::DashscopeApi,
    ModelType::MoonshotApi,
    ModelType::MinimaxApi,
    ModelType::ZhipuApi,
    ModelType::VllmApi,
];

/// CLI agent fallback: use stored api_key via standard provider APIs.
/// CursorCli is excluded — Cursor uses gRPC/protobuf (not OpenAI-compatible REST).
const CLI_AGENT_FALLBACKS: &[(ModelType, &str, &str, Option<&str>)] = &[
    (
        ModelType::ClaudeCode,
        "anthropic",
        "claude-sonnet-4-20250514",
        None,
    ),
    (ModelType::Codex, "openai", "gpt-4o-mini", None),
];

/// Default model per provider (small/cheap).
fn default_model_for(agent_type: &ModelType) -> &'static str {
    match agent_type {
        ModelType::DeepseekApi => "deepseek-chat",
        ModelType::OpenaiApi => "gpt-4o-mini",
        ModelType::GeminiApi => "gemini-2.0-flash",
        ModelType::GroqApi => "llama-3.1-8b-instant",
        ModelType::XaiApi => "grok-4-fast-reasoning",
        ModelType::AnthropicApi => "claude-sonnet-4-20250514",
        ModelType::OpenrouterApi => "deepseek/deepseek-chat",
        ModelType::ZenmuxApi => "deepseek/deepseek-chat",
        ModelType::DashscopeApi => "qwen-turbo",
        ModelType::MoonshotApi => "moonshot-v1-8k",
        ModelType::MinimaxApi => "abab6.5s-chat",
        ModelType::ZhipuApi => "glm-4-flash",
        ModelType::VllmApi => "default",
        _ => "gpt-4o-mini",
    }
}

/// Map ModelType → provider registry name.
fn provider_name_for(agent_type: &ModelType) -> &'static str {
    match agent_type {
        ModelType::DeepseekApi => "deepseek",
        ModelType::OpenaiApi => "openai",
        ModelType::GeminiApi => "gemini",
        ModelType::GroqApi => "groq",
        ModelType::XaiApi => "xai",
        ModelType::AnthropicApi => "anthropic",
        ModelType::OpenrouterApi => "openrouter",
        ModelType::ZenmuxApi => "zenmux",
        ModelType::DashscopeApi => "dashscope",
        ModelType::MoonshotApi => "moonshot",
        ModelType::MinimaxApi => "minimax",
        ModelType::ZhipuApi => "zhipu",
        ModelType::VllmApi => "vllm",
        _ => "openai",
    }
}

/// Build a compact diff summary string, truncated to `MAX_DIFF_CHARS`.
fn build_diff_summary(repo_path: &Path) -> Result<String, String> {
    let staged = get_staged_diff(repo_path, 3)?;

    if !staged.files.is_empty() {
        let mut out = String::with_capacity(MAX_DIFF_CHARS + 256);
        out.push_str("Staged changes:\n");

        for file in &staged.files {
            let header = format!(
                "\n--- {} ({}, +{} -{})\n",
                file.file_path, file.status, file.insertions, file.deletions
            );
            if out.len() + header.len() > MAX_DIFF_CHARS {
                out.push_str("\n[...truncated, more files changed]");
                break;
            }
            out.push_str(&header);

            for hunk in &file.hunks {
                for line in &hunk.lines {
                    let prefix = match line.line_type.as_str() {
                        "addition" => "+",
                        "deletion" => "-",
                        _ => " ",
                    };
                    let entry = format!("{}{}", prefix, line.content);
                    if out.len() + entry.len() > MAX_DIFF_CHARS {
                        out.push_str("[...truncated]\n");
                        return Ok(out);
                    }
                    out.push_str(&entry);
                }
            }
        }
        return Ok(out);
    }

    let numstat = get_diff_numstat(repo_path, "HEAD", None, false, false)?;
    if numstat.files.is_empty() {
        return Err("No staged or unstaged changes to summarize".to_string());
    }

    let mut out = String::with_capacity(MAX_DIFF_CHARS);
    out.push_str("Unstaged changes (file summary):\n");
    for file in &numstat.files {
        let line = format!(
            "  {} ({}, +{} -{})\n",
            file.path, file.status, file.insertions, file.deletions
        );
        if out.len() + line.len() > MAX_DIFF_CHARS {
            out.push_str("  [...more files]\n");
            break;
        }
        out.push_str(&line);
    }
    Ok(out)
}

/// Tauri command: generate a commit message for the given repository.
#[tauri::command]
pub async fn generate_commit_message(
    repo_path: String,
    commit_instructions: Option<String>,
) -> Result<String, String> {
    let path = Path::new(&repo_path);
    if !path.exists() {
        return Err(format!("Repository path does not exist: {}", repo_path));
    }

    let diff_summary = build_diff_summary(path)?;
    let system_prompt = build_system_prompt(commit_instructions.as_deref())?;
    info!(
        "generate_commit_message: diff_summary len={}",
        diff_summary.len()
    );

    let creds = KEY_SERVICE.list_keys();

    // Step 1: Direct API key providers (cheapest first)
    let mut chosen_key: Option<String> = None;
    let mut chosen_base_url: Option<String> = None;
    let mut chosen_provider: Option<&str> = None;
    let mut chosen_model: Option<&str> = None;

    for preferred in PREFERRED_API_TYPES {
        for cred in &creds {
            if cred.model_type == *preferred {
                if let Some(ref key) = cred.api_key {
                    if !key.is_empty() {
                        chosen_key = Some(key.clone());
                        chosen_base_url = cred.base_url.clone();
                        chosen_provider = Some(provider_name_for(preferred));
                        chosen_model = Some(default_model_for(preferred));
                        break;
                    }
                }
            }
        }
        if chosen_key.is_some() {
            break;
        }
    }

    // Step 2: CLI agent fallback — use stored api_key via standard provider APIs
    if chosen_key.is_none() {
        for &(ref cli_type, prov_name, model, api_base_override) in CLI_AGENT_FALLBACKS {
            for cred in &creds {
                if cred.model_type == *cli_type {
                    if let Some(ref key) = cred.api_key {
                        if !key.is_empty() {
                            info!(
                                "generate_commit_message: using CLI agent {} api_key",
                                cli_type.as_str()
                            );
                            chosen_key = Some(key.clone());
                            chosen_base_url = api_base_override
                                .map(|s| s.to_string())
                                .or_else(|| cred.base_url.clone());
                            chosen_provider = Some(prov_name);
                            chosen_model = Some(model);
                            break;
                        }
                    }
                }
            }
            if chosen_key.is_some() {
                break;
            }
        }
    }

    // Steps 1+2 succeeded: call via OpenAI-compatible HTTP API
    if let Some(api_key) = chosen_key {
        let prov_name = chosen_provider.unwrap_or("openai");
        let model = chosen_model.unwrap_or("gpt-4o-mini");

        let spec = PROVIDERS
            .iter()
            .find(|s| s.name == prov_name)
            .ok_or_else(|| format!("Unknown provider: {}", prov_name))?;

        let config = ProviderConfig {
            api_key,
            api_base: chosen_base_url.or_else(|| spec.default_api_base.map(|s| s.to_string())),
            extra_headers: HashMap::new(),
            is_azure: false,
        };

        let client = OpenAICompatClient::new(config, spec, model.to_string());

        info!(
            "generate_commit_message: provider={}, model={}",
            spec.display_name, model
        );

        let messages = vec![
            json!({ "role": "system", "content": &system_prompt }),
            json!({ "role": "user", "content": diff_summary }),
        ];

        let response = client
            .chat(&messages, None, model, 256, 0.3)
            .await
            .map_err(|err| format!("LLM request failed: {}", err))?;

        let content = response
            .content
            .unwrap_or_default()
            .trim()
            .trim_matches('`')
            .trim()
            .to_string();

        if content.is_empty() {
            return Err("LLM returned an empty response".to_string());
        }

        info!(
            "generate_commit_message: result={:?}",
            &content[..content.len().min(80)]
        );
        return Ok(content);
    }

    // Step 3: Cursor session token → Connect RPC to Cursor's StreamChat API
    for cred in &creds {
        if cred.model_type == ModelType::CursorCli {
            let token = cred
                .session_token
                .as_deref()
                .or(cred.api_key.as_deref())
                .filter(|s| !s.is_empty());

            if let Some(access_token) = token {
                info!("generate_commit_message: trying Cursor StreamChat via Connect RPC");

                let prompt = build_cursor_prompt(&system_prompt, &diff_summary);

                let raw = cursor_stream_chat(access_token, "gpt-4o-mini", &prompt).await?;
                let content = raw.trim().trim_matches('`').trim().to_string();

                if content.is_empty() {
                    return Err("Cursor StreamChat returned empty response".to_string());
                }

                info!(
                    "generate_commit_message: Cursor result={:?}",
                    &content[..content.len().min(80)]
                );
                return Ok(content);
            }
        }
    }

    Err(
        "No AI provider credentials configured. Add an API key in Settings > Code Accounts, or log into Cursor IDE to use your Cursor subscription."
            .to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXPECTED_SMALL_MODELS: &[(ModelType, &str, &str)] = &[
        (ModelType::DeepseekApi, "deepseek", "deepseek-chat"),
        (ModelType::OpenaiApi, "openai", "gpt-4o-mini"),
        (ModelType::GeminiApi, "gemini", "gemini-2.0-flash"),
        (ModelType::GroqApi, "groq", "llama-3.1-8b-instant"),
        (ModelType::XaiApi, "xai", "grok-4-fast-reasoning"),
        (
            ModelType::AnthropicApi,
            "anthropic",
            "claude-sonnet-4-20250514",
        ),
        (
            ModelType::OpenrouterApi,
            "openrouter",
            "deepseek/deepseek-chat",
        ),
        (ModelType::ZenmuxApi, "zenmux", "deepseek/deepseek-chat"),
        (ModelType::DashscopeApi, "dashscope", "qwen-turbo"),
        (ModelType::MoonshotApi, "moonshot", "moonshot-v1-8k"),
        (ModelType::MinimaxApi, "minimax", "abab6.5s-chat"),
        (ModelType::ZhipuApi, "zhipu", "glm-4-flash"),
        (ModelType::VllmApi, "vllm", "default"),
    ];

    #[test]
    fn custom_instructions_are_appended_after_the_builtin_prompt() {
        let prompt = build_system_prompt(Some("  Write a detailed English body.  "))
            .expect("custom instructions should be accepted");

        assert!(prompt.starts_with(SYSTEM_PROMPT));
        assert!(prompt
            .ends_with("User-configured additional instructions:\nWrite a detailed English body."));
    }

    #[test]
    fn blank_instructions_preserve_the_builtin_prompt_exactly() {
        assert_eq!(build_system_prompt(None).unwrap(), SYSTEM_PROMPT);
        assert_eq!(build_system_prompt(Some("  \n  ")).unwrap(), SYSTEM_PROMPT);
    }

    #[test]
    fn instructions_over_the_limit_are_rejected() {
        let instructions = "x".repeat(MAX_INSTRUCTION_CHARS + 1);
        let error = build_system_prompt(Some(&instructions)).unwrap_err();
        assert!(error.contains("4000 characters or fewer"));
    }

    #[test]
    fn provider_prompt_payloads_share_the_effective_instructions() {
        let system_prompt = build_system_prompt(Some("Include a detailed body."))
            .expect("custom instructions should be accepted");
        let messages = vec![
            json!({ "role": "system", "content": &system_prompt }),
            json!({ "role": "user", "content": "diff summary" }),
        ];
        let cursor_prompt = build_cursor_prompt(&system_prompt, "diff summary");

        assert_eq!(
            messages[0]["content"].as_str(),
            Some(system_prompt.as_str())
        );
        assert_eq!(messages[1]["content"], "diff summary");
        assert!(cursor_prompt.starts_with(&system_prompt));
        assert!(cursor_prompt.ends_with("Diff:\ndiff summary"));
    }

    #[test]
    fn preferred_api_types_have_explicit_small_model_defaults() {
        assert_eq!(PREFERRED_API_TYPES.len(), EXPECTED_SMALL_MODELS.len());
        for preferred in PREFERRED_API_TYPES {
            let Some((_, expected_provider, expected_model)) = EXPECTED_SMALL_MODELS
                .iter()
                .find(|(model_type, _, _)| model_type == preferred)
            else {
                panic!(
                    "preferred provider {} has no explicit small-model test fixture",
                    preferred.as_str()
                );
            };
            assert_eq!(provider_name_for(preferred), *expected_provider);
            assert_eq!(default_model_for(preferred), *expected_model);
        }
    }

    #[test]
    fn git_commit_generation_excludes_providers_without_generic_defaults() {
        for excluded in [
            ModelType::AzureOpenaiApi,
            ModelType::AzureAnthropicApi,
            ModelType::OrgiiOrchestrator,
            ModelType::CursorCli,
            ModelType::KimiCli,
            ModelType::OpenCode,
        ] {
            assert!(
                !PREFERRED_API_TYPES.contains(&excluded),
                "{} should not silently fall back to a generic provider/model",
                excluded.as_str()
            );
        }
    }
}

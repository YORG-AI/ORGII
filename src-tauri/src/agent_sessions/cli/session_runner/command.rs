//! CLI command building and parser creation for each CLI agent type (ModelType).

use crate::agent_sessions::cli::parsers::antigravity::AntigravityParser;
use crate::agent_sessions::cli::parsers::claude_code::ClaudeCodeParser;
use crate::agent_sessions::cli::parsers::codex::CodexParser;
use crate::agent_sessions::cli::parsers::cursor::CursorParser;
use crate::agent_sessions::cli::parsers::CliAgentParser;
use crate::agent_sessions::cli::session_runner::launch_profiles::{
    defaults_for_agent, static_args_to_vec, uses_codex_app_server, ResolvedCliLaunchProfile,
};
use key_vault::key_store::ModelType;
use std::collections::HashMap;

pub(super) struct CliCommandBuildRequest<'a> {
    pub agent: &'a ModelType,
    pub launch_profile: &'a ResolvedCliLaunchProfile,
    pub model: Option<&'a str>,
    pub task: &'a str,
    pub resume_id: Option<&'a str>,
    pub api_key: Option<&'a str>,
    pub endpoint: Option<&'a str>,
    pub mode: Option<&'a str>,
    pub repo_path: Option<&'a str>,
    pub additional_dirs: &'a [String],
}

pub(super) fn build_command_with_launch_profile(
    request: CliCommandBuildRequest<'_>,
) -> Vec<String> {
    let CliCommandBuildRequest {
        agent,
        launch_profile,
        model,
        task,
        resume_id,
        api_key,
        endpoint,
        mode,
        repo_path,
        additional_dirs,
    } = request;

    if !additional_dirs.is_empty() && !matches!(agent, ModelType::ClaudeCode | ModelType::Codex) {
        tracing::warn!(
            agent = ?agent,
            dirs = ?additional_dirs,
            "[cli-runner] CLI agent does not support --add-dir; additional directories will NOT be visible to it",
        );
    }

    // Codex app-server transport: the argv is just `codex app-server` plus
    // model-variant `-c` overrides. The exec-mode defaults (`exec` subcommand)
    // and the profile's sandbox/approval args are meaningless to app-server —
    // sandbox, approval policy, cwd, model, resume and the task itself all
    // travel over JSON-RPC (`thread/start` / `turn/start` params) instead.
    if uses_codex_app_server(agent, launch_profile) {
        let mut cmd = vec![launch_profile.command.clone(), "app-server".into()];
        if let Some(m) = model {
            let codex_model = map_codex_model_variant(m);
            for config in codex_model.config_overrides {
                cmd.push("-c".into());
                cmd.push(config);
            }
        }
        return cmd;
    }

    let mut cmd = vec![launch_profile.command.clone()];
    if let Some(defaults) = defaults_for_agent(agent) {
        cmd.extend(static_args_to_vec(defaults.command_args));
    }
    cmd.extend(launch_profile.args.clone());

    match agent {
        ModelType::CursorCli => {
            cmd.push("--output-format".into());
            cmd.push("stream-json".into());
            cmd.push("--stream-partial-output".into());
            if let Some(key) = api_key {
                cmd.push("--api-key".into());
                cmd.push(key.into());
            }
            if let Some(ep) = endpoint {
                cmd.push("--endpoint".into());
                cmd.push(ep.into());
                cmd.push("--agent-endpoint".into());
                cmd.push(ep.into());
            }
            if let Some(rid) = resume_id {
                cmd.push("--resume".into());
                cmd.push(rid.into());
            }
            if let Some(m) = model {
                cmd.push("--model".into());
                cmd.push(m.into());
            }
            if let Some(md) = mode {
                if matches!(md, "plan" | "ask") {
                    cmd.push("--mode".into());
                    cmd.push(md.into());
                }
            }
            if let Some(ws) = repo_path {
                cmd.push("--workspace".into());
                cmd.push(ws.into());
            }
            cmd.push("-p".into());
            cmd.push(task.into());
            cmd
        }
        ModelType::ClaudeCode => {
            cmd.push("--output-format".into());
            cmd.push("stream-json".into());
            cmd.push("--verbose".into());
            if let Some(rid) = resume_id {
                cmd.push("--resume".into());
                cmd.push(rid.into());
            }
            if let Some(m) = model {
                let claude_model = map_claude_model_variant(m);
                cmd.push("--model".into());
                cmd.push(claude_model.base_model);
                if let Some(effort) = claude_model.effort {
                    cmd.push("--effort".into());
                    cmd.push(effort);
                }
            }
            for dir in additional_dirs {
                if dir.is_empty() {
                    continue;
                }
                cmd.push("--add-dir".into());
                cmd.push(dir.clone());
            }
            cmd.push("-p".into());
            cmd.push(task.into());
            cmd
        }
        ModelType::Codex => {
            cmd.push("--json".into());
            cmd.push("--skip-git-repo-check".into());
            if let Some(ws) = repo_path {
                cmd.push("--cd".into());
                cmd.push(ws.into());
            }
            if let Some(m) = model {
                let codex_model = map_codex_model_variant(m);
                cmd.push("-m".into());
                cmd.push(codex_model.base_model);
                for config in codex_model.config_overrides {
                    cmd.push("-c".into());
                    cmd.push(config);
                }
            }
            if let Some(rid) = resume_id {
                cmd.push("resume".into());
                cmd.push(rid.into());
            }
            for dir in additional_dirs {
                if dir.is_empty() {
                    continue;
                }
                cmd.push("--add-dir".into());
                cmd.push(dir.clone());
            }
            cmd.push(task.into());
            cmd
        }
        ModelType::Copilot => {
            cmd.push("--acp".into());
            if let Some(rid) = resume_id {
                cmd.push("--resume".into());
                cmd.push(rid.into());
            }
            if let Some(m) = model {
                cmd.push("--model".into());
                cmd.push(m.into());
            }
            cmd
        }
        ModelType::Kiro | ModelType::OpenCode => cmd,
        ModelType::Antigravity => {
            if let Some(rid) = resume_id {
                cmd.push("--conversation".into());
                cmd.push(rid.into());
            }
            if let Some(m) = model {
                cmd.push("--model".into());
                cmd.push(m.into());
            }
            for dir in additional_dirs {
                if dir.is_empty() {
                    continue;
                }
                cmd.push("--add-dir".into());
                cmd.push(dir.clone());
            }
            cmd.push("--print".into());
            cmd.push(task.into());
            cmd
        }
        ModelType::KimiCli
        | ModelType::Aider
        | ModelType::Goose
        | ModelType::Amp
        | ModelType::Cline
        | ModelType::Kilo
        | ModelType::Grok
        | ModelType::Devin
        | ModelType::Rovo
        | ModelType::Hermes
        | ModelType::OpenClaw
        | ModelType::Aug
        | ModelType::Codebuff
        | ModelType::QwenCode
        | ModelType::MimoCode
        | ModelType::Continue
        | ModelType::Droid
        | ModelType::MistralVibe
        | ModelType::Autohand
        | ModelType::Omp
        | ModelType::Pi
        | ModelType::QoderCli
        | ModelType::TraeCli => {
            if !task.is_empty() {
                cmd.push(task.into());
            }
            cmd
        }
        other => {
            panic!(
                "ModelType::{:?} is not a CLI agent — cannot build command",
                other
            );
        }
    }
}

pub(super) fn launch_profile_env(profile: &ResolvedCliLaunchProfile) -> HashMap<String, String> {
    profile.env.clone()
}

struct CodexModelLaunchConfig {
    base_model: String,
    config_overrides: Vec<String>,
}

/// Base model name for the app-server `thread/start` params. The reasoning
/// effort / service-tier variant suffixes go on the argv as `-c` overrides
/// (see the app-server arm in [`build_command_with_launch_profile`]); the
/// thread param only carries the variant-stripped base model.
pub(super) fn codex_app_server_thread_model(model: Option<&str>) -> Option<String> {
    model.map(|m| map_codex_model_variant(m).base_model)
}

fn map_codex_model_variant(model: &str) -> CodexModelLaunchConfig {
    const CODEX_VARIANT_BASES: [&str; 8] = [
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-5.5",
        "gpt-5.4",
        "gpt-5.4-mini",
        "gpt-5.3-codex",
        "gpt-5.2",
    ];
    const CODEX_REASONING_LEVELS: [&str; 5] = ["low", "medium", "high", "xhigh", "ultra"];

    for base_model in CODEX_VARIANT_BASES {
        let Some(suffix) = model.strip_prefix(base_model) else {
            continue;
        };
        let Some(suffix) = suffix.strip_prefix('-') else {
            continue;
        };
        let suffix_parts: Vec<&str> = suffix.split('-').collect();
        let Some(reasoning) = suffix_parts.first().copied() else {
            continue;
        };
        if !CODEX_REASONING_LEVELS.contains(&reasoning) {
            continue;
        }

        let mut config_overrides = vec![format!("model_reasoning_effort=\"{reasoning}\"")];
        if suffix_parts.get(1).copied() == Some("fast") {
            config_overrides.push("service_tier=\"priority\"".to_string());
        }
        return CodexModelLaunchConfig {
            base_model: base_model.to_string(),
            config_overrides,
        };
    }

    CodexModelLaunchConfig {
        base_model: model.to_string(),
        config_overrides: Vec::new(),
    }
}

/// Map market shorthand model names to full CLI model names.
///
/// Fallback mapping for when the proxy's resolved `model_name` is unavailable
/// (e.g., fallback allocation path, pool sync failure, or local billing mode).
/// The hosted service normalizes "claude-sonnet-4.5" → "sonnet-4.5", but the
/// Claude Code CLI expects full names like "claude-sonnet-4.5".
/// This re-adds the "claude-" prefix for Claude-family models.
/// Non-Claude models (gpt-*, gemini-*, grok-*, raptor-*) pass through unchanged.
///
/// Also strips trailing YYYYMMDD date suffixes (e.g. `claude-haiku-4-5-20251001`
/// → `claude-haiku-4-5`). The API layer accepts these suffixes, but Claude Code
/// CLI rejects them.
#[cfg(test)]
pub(super) fn map_claude_model(model: &str) -> String {
    map_claude_model_variant(model).base_model
}

pub(super) struct ClaudeModelLaunchConfig {
    pub base_model: String,
    pub effort: Option<String>,
}

/// Effort/reasoning suffix tokens the Claude Code CLI accepts via `--effort`.
/// The market model id encodes effort as a trailing suffix (e.g.
/// `claude-opus-4-8-high`), but Claude Code's `--model` only understands the
/// base model name — the level must go to the separate `--effort` flag.
/// `extra-high` is the frontend variant token; the CLI spells it `xhigh`.
fn claude_effort_token(token: &str) -> Option<&'static str> {
    match token {
        "low" => Some("low"),
        "medium" => Some("medium"),
        "high" => Some("high"),
        "xhigh" | "extra-high" => Some("xhigh"),
        "max" => Some("max"),
        _ => None,
    }
}

/// Split a Claude market model id into the base model (for `--model`) and an
/// optional effort level (for `--effort`), then normalize the base name the
/// same way [`map_claude_model`] does (strip date suffix, re-add `claude-`
/// prefix). Non-effort suffixes (e.g. `thinking`, `fast`) and plain version
/// numbers are left on the base model untouched.
pub(super) fn map_claude_model_variant(model: &str) -> ClaudeModelLaunchConfig {
    // Try the compound `extra-high` token first (two trailing segments),
    // then a single trailing segment. `rfind` alone would split
    // `...-extra-high` at the last `-`, leaving `extra` on the base model.
    let (base, effort) = split_claude_effort(model);

    let base_model = strip_cli_date_suffix(base);
    ClaudeModelLaunchConfig {
        base_model: agent_core::providers::model_hints::normalize_claude_shorthand(base_model),
        effort,
    }
}

fn split_claude_effort(model: &str) -> (&str, Option<String>) {
    let mut dash_positions = model
        .char_indices()
        .filter(|(_, c)| *c == '-')
        .map(|(idx, _)| idx);
    let last = dash_positions.next_back();
    let second_last = dash_positions.next_back();

    // Compound token like `extra-high` spans the final two segments.
    if let (Some(second), Some(_)) = (second_last, last) {
        if let Some(level) = claude_effort_token(&model[second + 1..]) {
            return (&model[..second], Some(level.to_string()));
        }
    }
    if let Some(pos) = last {
        if let Some(level) = claude_effort_token(&model[pos + 1..]) {
            return (&model[..pos], Some(level.to_string()));
        }
    }
    (model, None)
}

/// Strip a trailing 8-digit date suffix (YYYYMMDD) from a model ID.
/// E.g. `claude-haiku-4-5-20251001` → `claude-haiku-4-5`.
/// Non-matching strings are returned unchanged.
fn strip_cli_date_suffix(model: &str) -> &str {
    if let Some(pos) = model.rfind('-') {
        let suffix = &model[pos + 1..];
        if suffix.len() == 8 && suffix.chars().all(|c| c.is_ascii_digit()) {
            return &model[..pos];
        }
    }
    model
}

/// Create the appropriate parser for a CLI agent type.
///
/// Copilot uses ACP (bidirectional JSON-RPC) instead of CliAgentParser.
/// API key providers are not CLI agents and should never reach this function.
pub(super) fn create_parser(agent: &ModelType, session_id: &str) -> Box<dyn CliAgentParser> {
    match agent {
        ModelType::CursorCli => Box::new(CursorParser::new(session_id)),
        ModelType::ClaudeCode => Box::new(ClaudeCodeParser::new(session_id)),
        ModelType::Codex => Box::new(CodexParser::new(session_id)),
        ModelType::Antigravity => Box::new(AntigravityParser::new(session_id)),
        other => panic!(
            "ModelType::{:?} does not use CliAgentParser (Copilot/Kiro/OpenCode use ACP; API providers are not CLI agents)",
            other
        ),
    }
}

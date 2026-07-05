//! CLI command building and parser creation for each CLI agent type (ModelType).

use crate::agent_sessions::cli::parsers::claude_code::ClaudeCodeParser;
use crate::agent_sessions::cli::parsers::codex::CodexParser;
use crate::agent_sessions::cli::parsers::cursor::CursorParser;
use crate::agent_sessions::cli::parsers::gemini::GeminiParser;
use crate::agent_sessions::cli::parsers::CliAgentParser;
use integrations::cli_binary_resolver::{resolve_cli_binary_command, CliBinaryId};
use key_vault::key_store::ModelType;

pub(super) fn resolve_cli_agent_command(agent: &ModelType) -> String {
    let binary_id = match agent {
        ModelType::CursorCli => CliBinaryId::CursorCli,
        ModelType::ClaudeCode => CliBinaryId::ClaudeCode,
        ModelType::Codex => CliBinaryId::Codex,
        ModelType::GeminiCli => CliBinaryId::GeminiCli,
        ModelType::Kiro => CliBinaryId::Kiro,
        ModelType::Copilot => CliBinaryId::Copilot,
        ModelType::OpenCode => CliBinaryId::OpenCode,
        ModelType::KimiCli => CliBinaryId::KimiCli,
        ModelType::OpenClaude => CliBinaryId::OpenClaude,
        ModelType::Aider => CliBinaryId::Aider,
        ModelType::Goose => CliBinaryId::Goose,
        ModelType::Amp => CliBinaryId::Amp,
        ModelType::Cline => CliBinaryId::Cline,
        ModelType::Kilo => CliBinaryId::Kilo,
        ModelType::Grok => CliBinaryId::Grok,
        ModelType::Devin => CliBinaryId::Devin,
        ModelType::Rovo => CliBinaryId::Rovo,
        ModelType::Hermes => CliBinaryId::Hermes,
        ModelType::OpenClaw => CliBinaryId::OpenClaw,
        ModelType::Crush => CliBinaryId::Crush,
        ModelType::Aug => CliBinaryId::Aug,
        ModelType::Codebuff => CliBinaryId::Codebuff,
        ModelType::CommandCode => CliBinaryId::CommandCode,
        ModelType::QwenCode => CliBinaryId::QwenCode,
        ModelType::MimoCode => CliBinaryId::MimoCode,
        ModelType::Antigravity => CliBinaryId::Antigravity,
        ModelType::Continue => CliBinaryId::Continue,
        ModelType::Droid => CliBinaryId::Droid,
        ModelType::MistralVibe => CliBinaryId::MistralVibe,
        ModelType::Ante => CliBinaryId::Ante,
        ModelType::Autohand => CliBinaryId::Autohand,
        ModelType::Omp => CliBinaryId::Omp,
        ModelType::Pi => CliBinaryId::Pi,
        other => panic!(
            "ModelType::{:?} is not a CLI agent — cannot resolve command",
            other
        ),
    };
    resolve_cli_binary_command(binary_id)
}

fn parse_launch_args(value: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut chars = value.chars().peekable();
    let mut quote: Option<char> = None;
    let mut escaped = false;

    while let Some(ch) = chars.next() {
        if escaped {
            current.push(ch);
            escaped = false;
            continue;
        }

        if ch == '\\' {
            escaped = true;
            continue;
        }

        if let Some(quote_char) = quote {
            if ch == quote_char {
                quote = None;
            } else {
                current.push(ch);
            }
            continue;
        }

        match ch {
            '\'' | '"' => quote = Some(ch),
            ch if ch.is_whitespace() => {
                if !current.is_empty() {
                    args.push(std::mem::take(&mut current));
                }
                while chars.peek().is_some_and(|next| next.is_whitespace()) {
                    chars.next();
                }
            }
            _ => current.push(ch),
        }
    }

    if escaped {
        current.push('\\');
    }
    if !current.is_empty() {
        args.push(current);
    }

    args
}

fn resolved_launch_args(launch_args: Option<&str>, defaults: &[&str]) -> Vec<String> {
    match launch_args {
        Some(value) => parse_launch_args(value),
        None => defaults.iter().map(|arg| (*arg).to_string()).collect(),
    }
}

fn push_launch_args(cmd: &mut Vec<String>, launch_args: Option<&str>, defaults: &[&str]) {
    cmd.extend(resolved_launch_args(launch_args, defaults));
}

/// Build the CLI command for a given CLI agent type.
///
/// Matches the market worker's `_build_agent_command()`.
/// When `resume_id` is provided, adds the appropriate resume flag for the CLI.
/// `api_key` is passed for agents that accept an explicit key argument (e.g. Cursor `--api-key`).
/// `endpoint` overrides the CLI's API endpoint URL (e.g. Cursor `--endpoint`).
/// `additional_dirs` extends the CLI's working set; only `claude_code`
/// and `codex` accept the flag today — other CLI agents log a warning
/// and the extra dirs are not passed through.
#[allow(clippy::too_many_arguments)]
pub(super) fn build_command(
    agent: &ModelType,
    model: Option<&str>,
    task: &str,
    resume_id: Option<&str>,
    api_key: Option<&str>,
    endpoint: Option<&str>,
    mode: Option<&str>,
    repo_path: Option<&str>,
    additional_dirs: &[String],
    launch_args: Option<&str>,
) -> Vec<String> {
    // Only claude_code and codex accept `--add-dir`. For every other CLI
    // agent, extra workspace roots cannot be expressed on the command
    // line — warn loudly instead of silently dropping the grant.
    if !additional_dirs.is_empty() && !matches!(agent, ModelType::ClaudeCode | ModelType::Codex) {
        tracing::warn!(
            agent = ?agent,
            dirs = ?additional_dirs,
            "[cli-runner] CLI agent does not support --add-dir; additional directories will NOT be visible to it",
        );
    }
    match agent {
        ModelType::CursorCli => {
            let mut cmd = vec![resolve_cli_agent_command(agent), "agent".into()];
            cmd.push("--output-format".into());
            cmd.push("stream-json".into());
            cmd.push("--stream-partial-output".into());
            push_launch_args(&mut cmd, launch_args, &["--force", "--approve-mcps"]);
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
                match md {
                    "plan" | "ask" => {
                        cmd.push("--mode".into());
                        cmd.push(md.into());
                    }
                    _ => {}
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
            let mut cmd = vec![resolve_cli_agent_command(agent)];
            cmd.push("--output-format".into());
            cmd.push("stream-json".into());
            cmd.push("--verbose".into());
            push_launch_args(&mut cmd, launch_args, &["--dangerously-skip-permissions"]);
            if let Some(rid) = resume_id {
                cmd.push("--resume".into());
                cmd.push(rid.into());
            }
            if let Some(m) = model {
                cmd.push("--model".into());
                cmd.push(map_claude_model(m));
            }
            // Multi-root: claude accepts space-separated paths after a single
            // `--add-dir`; one flag per directory also works. Use one flag per
            // dir to keep tokenisation unambiguous when paths contain spaces.
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
            let mut cmd = vec![resolve_cli_agent_command(agent), "exec".into()];
            cmd.push("--json".into());
            cmd.push("--skip-git-repo-check".into());
            cmd.push("--sandbox".into());
            cmd.push("workspace-write".into());
            push_launch_args(&mut cmd, launch_args, &[]);
            if let Some(ws) = repo_path {
                cmd.push("--cd".into());
                cmd.push(ws.into());
            }
            if let Some(m) = model {
                cmd.push("-m".into());
                cmd.push(m.into());
            }
            if let Some(rid) = resume_id {
                cmd.push("resume".into());
                cmd.push(rid.into());
            }
            // Codex requires one `--add-dir <path>` per extra root.
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
        ModelType::GeminiCli => {
            let mut cmd = vec![resolve_cli_agent_command(agent)];
            cmd.push("--output-format".into());
            cmd.push("stream-json".into());
            push_launch_args(&mut cmd, launch_args, &["--yolo"]);
            if let Some(rid) = resume_id {
                cmd.push("--resume".into());
                cmd.push(rid.into());
            }
            if let Some(m) = model {
                cmd.push("--model".into());
                cmd.push(m.into());
            }
            cmd.push("-p".into());
            cmd.push(task.into());
            cmd
        }
        ModelType::Kiro => {
            let mut cmd = vec![resolve_cli_agent_command(agent), "acp".into()];
            push_launch_args(&mut cmd, launch_args, &[]);
            cmd
        }
        ModelType::Copilot => {
            // Copilot exposes ACP over stdio only (no `--stdio`/`--port` flag).
            // `--allow-all-tools` + `--no-ask-user` keep the agent autonomous so
            // it never blocks on a permission or ask_user prompt.
            let mut cmd = vec![resolve_cli_agent_command(agent), "--acp".into()];
            push_launch_args(
                &mut cmd,
                launch_args,
                &["--allow-all-tools", "--no-ask-user"],
            );
            if let Some(rid) = resume_id {
                cmd.push("--resume".into());
                cmd.push(rid.into());
            }
            // Copilot routes across vendors (gpt-*, claude-*, gemini-*); pass the
            // model id through unchanged instead of Claude-specific normalization.
            if let Some(m) = model {
                cmd.push("--model".into());
                cmd.push(m.into());
            }
            cmd
        }
        ModelType::OpenCode => {
            let mut cmd = vec![resolve_cli_agent_command(agent), "acp".into()];
            push_launch_args(&mut cmd, launch_args, &[]);
            cmd
        }
        // Extended CLI agents: pass the task as a positional argument.
        // These agents use TUI-style invocation; ORGII surfaces their raw PTY
        // output rather than parsing structured JSON events.
        ModelType::OpenClaude
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
        | ModelType::Crush
        | ModelType::Aug
        | ModelType::Codebuff
        | ModelType::CommandCode
        | ModelType::QwenCode
        | ModelType::MimoCode
        | ModelType::Antigravity
        | ModelType::Continue
        | ModelType::Droid
        | ModelType::MistralVibe
        | ModelType::Ante
        | ModelType::Autohand
        | ModelType::Omp
        | ModelType::Pi => {
            let mut cmd = vec![resolve_cli_agent_command(agent)];
            push_launch_args(&mut cmd, launch_args, &[]);
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
pub(super) fn map_claude_model(model: &str) -> String {
    let model = strip_cli_date_suffix(model);
    agent_core::providers::model_hints::normalize_claude_shorthand(model)
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
        ModelType::GeminiCli => Box::new(GeminiParser::new(session_id)),
        other => panic!(
            "ModelType::{:?} does not use CliAgentParser (Copilot/Kiro use ACP; API providers are not CLI agents)",
            other
        ),
    }
}

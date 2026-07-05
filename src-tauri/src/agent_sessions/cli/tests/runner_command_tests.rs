use super::command::{build_command as build_command_with_launch_args, map_claude_model};
use key_vault::key_store::ModelType;
use std::path::Path;

#[allow(clippy::too_many_arguments)]
fn build_command(
    agent: &ModelType,
    model: Option<&str>,
    task: &str,
    resume_id: Option<&str>,
    api_key: Option<&str>,
    endpoint: Option<&str>,
    mode: Option<&str>,
    repo_path: Option<&str>,
    additional_dirs: &[String],
) -> Vec<String> {
    build_command_with_launch_args(
        agent,
        model,
        task,
        resume_id,
        api_key,
        endpoint,
        mode,
        repo_path,
        additional_dirs,
        None,
    )
}

fn command_name(command: &str) -> &str {
    Path::new(command)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(command)
}

// ============================================
// build_command — CursorCli
// ============================================

#[test]
fn build_cursor_cli_basic() {
    let cmd = build_command(
        &ModelType::CursorCli,
        None,
        "fix the login bug",
        None,
        None,
        None,
        None,
        None,
        &[],
    );
    assert_eq!(command_name(&cmd[0]), "cursor-agent");
    assert!(cmd.contains(&"agent".to_string()));
    assert!(cmd.contains(&"--output-format".to_string()));
    assert!(cmd.contains(&"stream-json".to_string()));
    assert!(cmd.contains(&"--force".to_string()));
    assert!(cmd.contains(&"-p".to_string()));
    assert!(cmd.last().unwrap() == "fix the login bug");
}

#[test]
fn build_cursor_cli_with_all_options() {
    let cmd = build_command(
        &ModelType::CursorCli,
        Some("claude-sonnet-4"),
        "task",
        Some("resume-123"),
        Some("sk-key"),
        Some("https://api.example.com"),
        Some("plan"),
        Some("/workspace"),
        &[],
    );
    assert!(cmd.contains(&"--api-key".to_string()));
    assert!(cmd.contains(&"sk-key".to_string()));
    assert!(cmd.contains(&"--endpoint".to_string()));
    assert!(cmd.contains(&"--agent-endpoint".to_string()));
    assert!(cmd.contains(&"--resume".to_string()));
    assert!(cmd.contains(&"resume-123".to_string()));
    assert!(cmd.contains(&"--model".to_string()));
    assert!(cmd.contains(&"claude-sonnet-4".to_string()));
    assert!(cmd.contains(&"--mode".to_string()));
    assert!(cmd.contains(&"plan".to_string()));
    assert!(cmd.contains(&"--workspace".to_string()));
    assert!(cmd.contains(&"/workspace".to_string()));
}

#[test]
fn build_cursor_cli_ignores_unknown_mode() {
    let cmd = build_command(
        &ModelType::CursorCli,
        None,
        "task",
        None,
        None,
        None,
        Some("yolo"),
        None,
        &[],
    );
    assert!(!cmd.contains(&"--mode".to_string()));
}

// ============================================
// build_command — ClaudeCode
// ============================================

#[test]
fn build_claude_code_basic() {
    let cmd = build_command(
        &ModelType::ClaudeCode,
        None,
        "implement feature",
        None,
        None,
        None,
        None,
        None,
        &[],
    );
    assert_eq!(command_name(&cmd[0]), "claude");
    assert!(cmd.contains(&"--output-format".to_string()));
    assert!(cmd.contains(&"--verbose".to_string()));
    assert!(cmd.contains(&"--dangerously-skip-permissions".to_string()));
    assert!(cmd.contains(&"-p".to_string()));
    assert_eq!(cmd.last().unwrap(), "implement feature");
}

#[test]
fn build_claude_code_with_model_maps_shorthand() {
    let cmd = build_command(
        &ModelType::ClaudeCode,
        Some("sonnet-4"),
        "task",
        None,
        None,
        None,
        None,
        None,
        &[],
    );
    assert!(cmd.contains(&"--model".to_string()));
    let model_idx = cmd.iter().position(|c| c == "--model").unwrap();
    assert_eq!(cmd[model_idx + 1], "claude-sonnet-4");
}

// ============================================
// build_command — Codex
// ============================================

#[test]
fn build_codex_basic() {
    let cmd = build_command(
        &ModelType::Codex,
        Some("o3"),
        "write tests",
        None,
        None,
        None,
        None,
        None,
        &[],
    );
    assert_eq!(command_name(&cmd[0]), "codex");
    assert_eq!(cmd[1], "exec");
    assert!(cmd.contains(&"--json".to_string()));
    assert!(cmd.contains(&"-m".to_string()));
    assert!(cmd.contains(&"o3".to_string()));
    assert_eq!(cmd.last().unwrap(), "write tests");
}

#[test]
fn build_codex_with_resume() {
    let cmd = build_command(
        &ModelType::Codex,
        None,
        "continue",
        Some("sess-abc"),
        None,
        None,
        None,
        None,
        &[],
    );
    assert!(cmd.contains(&"resume".to_string()));
    assert!(cmd.contains(&"sess-abc".to_string()));
}

// ============================================
// build_command — GeminiCli
// ============================================

#[test]
fn build_gemini_cli_basic() {
    let cmd = build_command(
        &ModelType::GeminiCli,
        Some("gemini-2.5-pro"),
        "refactor",
        None,
        None,
        None,
        None,
        None,
        &[],
    );
    assert_eq!(command_name(&cmd[0]), "gemini");
    assert!(cmd.contains(&"--yolo".to_string()));
    assert!(cmd.contains(&"--model".to_string()));
    assert!(cmd.contains(&"-p".to_string()));
}

// ============================================
// build_command — Kiro
// ============================================

#[test]
fn build_kiro_basic() {
    let cmd = build_command(
        &ModelType::Kiro,
        None,
        "task",
        None,
        None,
        None,
        None,
        None,
        &[],
    );
    assert_eq!(command_name(&cmd[0]), "kiro-cli");
    assert_eq!(cmd[1], "acp");
}

// ============================================
// build_command — Copilot
// ============================================

#[test]
fn build_copilot_basic() {
    let cmd = build_command(
        &ModelType::Copilot,
        None,
        "task",
        None,
        None,
        None,
        None,
        None,
        &[],
    );
    assert_eq!(command_name(&cmd[0]), "copilot");
    assert!(cmd.contains(&"--acp".to_string()));
    assert!(cmd.contains(&"--allow-all-tools".to_string()));
    assert!(cmd.contains(&"--no-ask-user".to_string()));
    // Copilot serves ACP over stdio only; there is no `--stdio` flag.
    assert!(!cmd.contains(&"--stdio".to_string()));
}

#[test]
fn build_copilot_resume_and_model_passthrough() {
    let cmd = build_command(
        &ModelType::Copilot,
        Some("gpt-5.4"),
        "task",
        Some("resume-123"),
        None,
        None,
        None,
        None,
        &[],
    );
    assert!(cmd.contains(&"--resume".to_string()));
    assert!(cmd.contains(&"resume-123".to_string()));
    assert!(cmd.contains(&"--model".to_string()));
    // Model id is passed through unchanged (Copilot is multi-vendor).
    assert!(cmd.contains(&"gpt-5.4".to_string()));
}

// ============================================
// build_command — OpenCode
// ============================================

#[test]
fn build_opencode_basic() {
    let cmd = build_command(
        &ModelType::OpenCode,
        None,
        "task",
        None,
        None,
        None,
        None,
        None,
        &[],
    );
    assert_eq!(command_name(&cmd[0]), "opencode");
    assert_eq!(cmd, vec![cmd[0].clone(), "acp".to_string()]);
}

#[test]
fn build_opencode_empty_launch_args_keeps_acp_command() {
    let cmd = build_command_with_launch_args(
        &ModelType::OpenCode,
        None,
        "task",
        None,
        None,
        None,
        None,
        None,
        &[],
        Some(""),
    );
    assert_eq!(command_name(&cmd[0]), "opencode");
    assert_eq!(cmd, vec![cmd[0].clone(), "acp".to_string()]);
}

#[test]
fn build_opencode_custom_launch_args_append_after_acp() {
    let cmd = build_command_with_launch_args(
        &ModelType::OpenCode,
        None,
        "task",
        None,
        None,
        None,
        None,
        None,
        &[],
        Some("--config \"custom profile.toml\""),
    );
    assert_eq!(command_name(&cmd[0]), "opencode");
    assert_eq!(cmd[1], "acp");
    assert_eq!(cmd[2], "--config");
    assert_eq!(cmd[3], "custom profile.toml");
}

#[test]
fn build_claude_custom_launch_args_replace_default_permission_arg() {
    let cmd = build_command_with_launch_args(
        &ModelType::ClaudeCode,
        None,
        "task",
        None,
        None,
        None,
        None,
        None,
        &[],
        Some("--permission-mode manual"),
    );
    assert!(!cmd.contains(&"--dangerously-skip-permissions".to_string()));
    assert!(cmd.contains(&"--permission-mode".to_string()));
    assert!(cmd.contains(&"manual".to_string()));
}

#[test]
fn build_cursor_empty_launch_args_removes_default_permission_args() {
    let cmd = build_command_with_launch_args(
        &ModelType::CursorCli,
        None,
        "task",
        None,
        None,
        None,
        None,
        None,
        &[],
        Some(""),
    );
    assert!(!cmd.contains(&"--force".to_string()));
    assert!(!cmd.contains(&"--approve-mcps".to_string()));
    assert!(cmd.contains(&"--output-format".to_string()));
    assert!(cmd.contains(&"-p".to_string()));
}

// ============================================
// build_command — API providers panic
// ============================================

#[test]
#[should_panic(expected = "is not a CLI agent")]
fn build_command_panics_for_api_provider() {
    build_command(
        &ModelType::AnthropicApi,
        None,
        "task",
        None,
        None,
        None,
        None,
        None,
        &[],
    );
}

// ============================================
// build_command — additional_dirs (--add-dir)
// ============================================

#[test]
fn build_claude_code_with_additional_dirs() {
    let extras = vec!["/repo/backend".to_string(), "/repo/shared".to_string()];
    let cmd = build_command(
        &ModelType::ClaudeCode,
        None,
        "task",
        None,
        None,
        None,
        None,
        None,
        &extras,
    );
    let mut add_dirs = Vec::new();
    let mut iter = cmd.iter();
    while let Some(arg) = iter.next() {
        if arg == "--add-dir" {
            add_dirs.push(iter.next().cloned().unwrap_or_default());
        }
    }
    assert_eq!(
        add_dirs,
        vec!["/repo/backend".to_string(), "/repo/shared".to_string()]
    );
}

#[test]
fn build_codex_with_additional_dirs() {
    let extras = vec!["/repo/web".to_string()];
    let cmd = build_command(
        &ModelType::Codex,
        Some("o3"),
        "task",
        None,
        None,
        None,
        None,
        None,
        &extras,
    );
    let mut iter = cmd.iter();
    let mut found = false;
    while let Some(arg) = iter.next() {
        if arg == "--add-dir" {
            assert_eq!(iter.next().map(String::as_str), Some("/repo/web"));
            found = true;
        }
    }
    assert!(found, "codex should forward --add-dir for extras");
}

#[test]
fn build_cursor_cli_ignores_additional_dirs() {
    // Cursor uses --workspace (single root) and does not accept --add-dir;
    // the slice must be silently dropped, not turned into bogus flags.
    let extras = vec!["/repo/extra".to_string()];
    let cmd = build_command(
        &ModelType::CursorCli,
        None,
        "task",
        None,
        None,
        None,
        None,
        None,
        &extras,
    );
    assert!(!cmd.contains(&"--add-dir".to_string()));
    assert!(!cmd.contains(&"/repo/extra".to_string()));
}

#[test]
fn build_claude_code_skips_empty_dirs() {
    let extras = vec!["".to_string(), "/repo/x".to_string(), "".to_string()];
    let cmd = build_command(
        &ModelType::ClaudeCode,
        None,
        "task",
        None,
        None,
        None,
        None,
        None,
        &extras,
    );
    let count = cmd.iter().filter(|a| *a == "--add-dir").count();
    assert_eq!(count, 1);
    assert!(cmd.contains(&"/repo/x".to_string()));
}

// ============================================
// map_claude_model
// ============================================

#[test]
fn map_claude_model_adds_prefix_to_shorthand() {
    assert_eq!(map_claude_model("sonnet-4"), "claude-sonnet-4");
    assert_eq!(map_claude_model("sonnet-4.5"), "claude-sonnet-4.5");
    assert_eq!(map_claude_model("haiku-3.5"), "claude-haiku-3.5");
    assert_eq!(map_claude_model("opus-4"), "claude-opus-4");
}

#[test]
fn map_claude_model_passthrough_full_name() {
    assert_eq!(map_claude_model("claude-sonnet-4"), "claude-sonnet-4");
    assert_eq!(map_claude_model("claude-opus-4"), "claude-opus-4");
}

#[test]
fn map_claude_model_strips_date_suffix() {
    assert_eq!(
        map_claude_model("claude-haiku-4-5-20251001"),
        "claude-haiku-4-5"
    );
    assert_eq!(
        map_claude_model("claude-sonnet-4-5-20241022"),
        "claude-sonnet-4-5"
    );
    assert_eq!(map_claude_model("claude-opus-4-20250101"), "claude-opus-4");
    // Non-8-digit suffix must pass through unchanged
    assert_eq!(map_claude_model("claude-sonnet-4-5"), "claude-sonnet-4-5");
}

#[test]
fn map_claude_model_passthrough_non_claude() {
    assert_eq!(map_claude_model("gpt-4o"), "gpt-4o");
    assert_eq!(map_claude_model("gemini-2.5-pro"), "gemini-2.5-pro");
    assert_eq!(map_claude_model("o3"), "o3");
}

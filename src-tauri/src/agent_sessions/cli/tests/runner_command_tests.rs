use super::command::{
    build_command_with_launch_profile, map_claude_model, map_claude_model_variant,
    CliCommandBuildRequest,
};
use super::launch_profiles::{
    bare_command_for_agent, default_args_for_mode, default_env_for_mode, defaults_for_agent,
    CliPermissionMode, ResolvedCliLaunchProfile,
};
use key_vault::key_store::ModelType;
use std::path::Path;

struct TestCommandBuildOptions<'a> {
    agent: &'a ModelType,
    model: Option<&'a str>,
    task: &'a str,
    resume_id: Option<&'a str>,
    api_key: Option<&'a str>,
    endpoint: Option<&'a str>,
    mode: Option<&'a str>,
    repo_path: Option<&'a str>,
    additional_dirs: &'a [String],
}

impl<'a> TestCommandBuildOptions<'a> {
    fn new(agent: &'a ModelType, task: &'a str) -> Self {
        Self {
            agent,
            model: None,
            task,
            resume_id: None,
            api_key: None,
            endpoint: None,
            mode: None,
            repo_path: None,
            additional_dirs: &[],
        }
    }
}

macro_rules! build_command {
    ($agent:expr, task = $task:expr $(,)?) => {{
        build_command_from_options(TestCommandBuildOptions::new(&$agent, $task))
    }};
    ($agent:expr, task = $task:expr, $($field:ident = $value:expr),+ $(,)?) => {{
        let mut options = TestCommandBuildOptions::new(&$agent, $task);
        $(
            options.$field = $value;
        )+
        build_command_from_options(options)
    }};
}

fn command_name(command: &str) -> &str {
    Path::new(command)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(command)
}

fn build_command_from_options(options: TestCommandBuildOptions<'_>) -> Vec<String> {
    let defaults = defaults_for_agent(options.agent).unwrap_or_else(|| {
        panic!(
            "ModelType::{:?} is not a CLI agent — cannot build command",
            options.agent
        )
    });
    let launch_profile = ResolvedCliLaunchProfile {
        permission_mode: CliPermissionMode::FullPermission,
        command: bare_command_for_agent(options.agent)
            .expect("CLI bare command")
            .to_string(),
        args: default_args_for_mode(defaults, CliPermissionMode::FullPermission),
        env: default_env_for_mode(defaults, CliPermissionMode::FullPermission),
        transport: None,
    };

    build_command_with_launch_profile(CliCommandBuildRequest {
        agent: options.agent,
        launch_profile: &launch_profile,
        model: options.model,
        task: options.task,
        resume_id: options.resume_id,
        api_key: options.api_key,
        endpoint: options.endpoint,
        mode: options.mode,
        repo_path: options.repo_path,
        additional_dirs: options.additional_dirs,
    })
}

#[test]
fn build_cursor_cli_basic() {
    let cmd = build_command!(ModelType::CursorCli, task = "fix the login bug");
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
    let cmd = build_command!(
        ModelType::CursorCli,
        task = "task",
        model = Some("claude-sonnet-4"),
        resume_id = Some("resume-123"),
        api_key = Some("sk-key"),
        endpoint = Some("https://api.example.com"),
        mode = Some("plan"),
        repo_path = Some("/workspace"),
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
    let cmd = build_command!(ModelType::CursorCli, task = "task", mode = Some("yolo"));
    assert!(!cmd.contains(&"--mode".to_string()));
}

#[test]
fn build_claude_code_basic() {
    let cmd = build_command!(ModelType::ClaudeCode, task = "implement feature");
    assert_eq!(command_name(&cmd[0]), "claude");
    assert!(cmd.contains(&"--output-format".to_string()));
    assert!(cmd.contains(&"--verbose".to_string()));
    assert!(cmd.contains(&"--dangerously-skip-permissions".to_string()));
    assert!(cmd.contains(&"-p".to_string()));
    assert_eq!(cmd.last().unwrap(), "implement feature");
}

#[test]
fn build_claude_code_with_model_maps_shorthand() {
    let cmd = build_command!(
        ModelType::ClaudeCode,
        task = "task",
        model = Some("sonnet-4"),
    );
    assert!(cmd.contains(&"--model".to_string()));
    let model_idx = cmd.iter().position(|c| c == "--model").unwrap();
    assert_eq!(cmd[model_idx + 1], "claude-sonnet-4");
    assert!(!cmd.contains(&"--effort".to_string()));
}

#[test]
fn build_claude_code_effort_variant_maps_to_effort_flag() {
    let cmd = build_command!(
        ModelType::ClaudeCode,
        task = "task",
        model = Some("claude-opus-4-8-high"),
    );
    let model_idx = cmd.iter().position(|c| c == "--model").unwrap();
    assert_eq!(cmd[model_idx + 1], "claude-opus-4-8");
    let effort_idx = cmd.iter().position(|c| c == "--effort").unwrap();
    assert_eq!(cmd[effort_idx + 1], "high");
    assert!(!cmd.contains(&"claude-opus-4-8-high".to_string()));
}

#[test]
fn build_codex_basic() {
    let cmd = build_command!(ModelType::Codex, task = "write tests", model = Some("o3"));
    assert_eq!(command_name(&cmd[0]), "codex");
    assert_eq!(cmd[1], "exec");
    assert!(cmd.contains(&"--json".to_string()));
    assert!(cmd.contains(&"-m".to_string()));
    assert!(cmd.contains(&"o3".to_string()));
    assert_eq!(cmd.last().unwrap(), "write tests");
}

#[test]
fn build_codex_reasoning_variant_maps_to_config_override() {
    let cmd = build_command!(
        ModelType::Codex,
        task = "write tests",
        model = Some("gpt-5.5-high"),
    );
    let model_idx = cmd.iter().position(|arg| arg == "-m").unwrap();
    assert_eq!(cmd[model_idx + 1], "gpt-5.5");
    assert!(cmd.contains(&"-c".to_string()));
    assert!(cmd.contains(&"model_reasoning_effort=\"high\"".to_string()));
    assert!(!cmd.contains(&"gpt-5.5-high".to_string()));
}

#[test]
fn build_codex_fast_variant_maps_to_priority_service_tier() {
    let cmd = build_command!(
        ModelType::Codex,
        task = "write tests",
        model = Some("gpt-5.4-medium-fast"),
    );
    let model_idx = cmd.iter().position(|arg| arg == "-m").unwrap();
    assert_eq!(cmd[model_idx + 1], "gpt-5.4");
    assert!(cmd.contains(&"model_reasoning_effort=\"medium\"".to_string()));
    assert!(cmd.contains(&"service_tier=\"priority\"".to_string()));
}

#[test]
fn build_codex_gpt_5_6_ultra_fast_variant() {
    let cmd = build_command!(
        ModelType::Codex,
        task = "write tests",
        model = Some("gpt-5.6-sol-ultra-fast"),
    );
    let model_idx = cmd.iter().position(|arg| arg == "-m").unwrap();
    assert_eq!(cmd[model_idx + 1], "gpt-5.6-sol");
    assert!(cmd.contains(&"model_reasoning_effort=\"ultra\"".to_string()));
    assert!(cmd.contains(&"service_tier=\"priority\"".to_string()));
    assert!(!cmd.contains(&"gpt-5.6-sol-ultra-fast".to_string()));
}

#[test]
fn build_codex_with_resume() {
    let cmd = build_command!(
        ModelType::Codex,
        task = "continue",
        resume_id = Some("sess-abc"),
    );
    assert!(cmd.contains(&"resume".to_string()));
    assert!(cmd.contains(&"sess-abc".to_string()));
}

#[test]
fn build_antigravity_print_command() {
    let additional_dirs = vec!["/tmp/secondary".to_string()];
    let cmd = build_command!(
        ModelType::Antigravity,
        task = "inspect the repository",
        model = Some("gemini-3.1-pro"),
        resume_id = Some("conversation-123"),
        additional_dirs = &additional_dirs,
    );

    assert_eq!(command_name(&cmd[0]), "agy");
    assert!(cmd
        .windows(2)
        .any(|pair| pair == ["--conversation", "conversation-123"]));
    assert!(cmd
        .windows(2)
        .any(|pair| pair == ["--model", "gemini-3.1-pro"]));
    assert!(cmd
        .windows(2)
        .any(|pair| pair == ["--add-dir", "/tmp/secondary"]));
    assert!(cmd
        .windows(2)
        .any(|pair| pair == ["--print", "inspect the repository"]));
}

#[test]
fn build_kiro_basic() {
    let cmd = build_command!(ModelType::Kiro, task = "task");
    assert_eq!(command_name(&cmd[0]), "kiro-cli");
    assert_eq!(cmd[1], "acp");
}

#[test]
fn build_copilot_basic() {
    let cmd = build_command!(ModelType::Copilot, task = "task");
    assert_eq!(command_name(&cmd[0]), "copilot");
    assert!(cmd.contains(&"--acp".to_string()));
    assert!(cmd.contains(&"--allow-all".to_string()));
    assert!(cmd.contains(&"--no-ask-user".to_string()));
    assert!(!cmd.contains(&"--stdio".to_string()));
}

#[test]
fn build_copilot_resume_and_model_passthrough() {
    let cmd = build_command!(
        ModelType::Copilot,
        task = "task",
        model = Some("gpt-5.4"),
        resume_id = Some("resume-123"),
    );
    assert!(cmd.contains(&"--resume".to_string()));
    assert!(cmd.contains(&"resume-123".to_string()));
    assert!(cmd.contains(&"--model".to_string()));
    assert!(cmd.contains(&"gpt-5.4".to_string()));
}

#[test]
fn build_opencode_basic() {
    let cmd = build_command!(ModelType::OpenCode, task = "task");
    assert_eq!(command_name(&cmd[0]), "opencode");
    assert_eq!(cmd[1], "acp");
}

#[test]
#[should_panic(expected = "is not a CLI agent")]
fn build_command_panics_for_api_provider() {
    build_command!(ModelType::AnthropicApi, task = "task");
}

#[test]
fn build_claude_code_with_additional_dirs() {
    let extras = vec!["/repo/backend".to_string(), "/repo/shared".to_string()];
    let cmd = build_command!(
        ModelType::ClaudeCode,
        task = "task",
        additional_dirs = &extras,
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
    let cmd = build_command!(
        ModelType::Codex,
        task = "task",
        model = Some("o3"),
        additional_dirs = &extras,
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
    let extras = vec!["/repo/extra".to_string()];
    let cmd = build_command!(
        ModelType::CursorCli,
        task = "task",
        additional_dirs = &extras,
    );
    assert!(!cmd.contains(&"--add-dir".to_string()));
    assert!(!cmd.contains(&"/repo/extra".to_string()));
}

#[test]
fn build_claude_code_skips_empty_dirs() {
    let extras = vec!["".to_string(), "/repo/x".to_string(), "".to_string()];
    let cmd = build_command!(
        ModelType::ClaudeCode,
        task = "task",
        additional_dirs = &extras,
    );
    let count = cmd.iter().filter(|arg| *arg == "--add-dir").count();
    assert_eq!(count, 1);
    assert!(cmd.contains(&"/repo/x".to_string()));
}

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
    assert_eq!(map_claude_model("claude-sonnet-4-5"), "claude-sonnet-4-5");
}

#[test]
fn map_claude_model_passthrough_non_claude() {
    assert_eq!(map_claude_model("gpt-4o"), "gpt-4o");
    assert_eq!(map_claude_model("gemini-2.5-pro"), "gemini-2.5-pro");
    assert_eq!(map_claude_model("o3"), "o3");
}

#[test]
fn map_claude_model_variant_splits_effort() {
    let cfg = map_claude_model_variant("claude-opus-4-8-high");
    assert_eq!(cfg.base_model, "claude-opus-4-8");
    assert_eq!(cfg.effort.as_deref(), Some("high"));

    let cfg = map_claude_model_variant("opus-4-8-xhigh");
    assert_eq!(cfg.base_model, "claude-opus-4-8");
    assert_eq!(cfg.effort.as_deref(), Some("xhigh"));

    let cfg = map_claude_model_variant("claude-sonnet-4-5-extra-high");
    assert_eq!(cfg.base_model, "claude-sonnet-4-5");
    assert_eq!(cfg.effort.as_deref(), Some("xhigh"));
}

#[test]
fn map_claude_model_variant_no_effort_keeps_base() {
    let cfg = map_claude_model_variant("claude-opus-4-8");
    assert_eq!(cfg.base_model, "claude-opus-4-8");
    assert!(cfg.effort.is_none());

    // `thinking` is not an --effort level; leave it on the base model.
    let cfg = map_claude_model_variant("claude-opus-4-8-thinking");
    assert_eq!(cfg.base_model, "claude-opus-4-8-thinking");
    assert!(cfg.effort.is_none());
}

// ─── Codex app-server transport (experimental gate) ───

fn app_server_profile(agent: &ModelType, transport: Option<&str>) -> ResolvedCliLaunchProfile {
    let defaults = defaults_for_agent(agent).expect("CLI defaults");
    ResolvedCliLaunchProfile {
        permission_mode: CliPermissionMode::Manual,
        command: bare_command_for_agent(agent)
            .expect("CLI bare command")
            .to_string(),
        args: default_args_for_mode(defaults, CliPermissionMode::Manual),
        env: default_env_for_mode(defaults, CliPermissionMode::Manual),
        transport: transport.map(|value| value.to_string()),
    }
}

#[test]
fn uses_codex_app_server_requires_codex_and_explicit_flag() {
    use super::launch_profiles::uses_codex_app_server;

    // Default (no flag) stays on the shell-out path.
    let default_profile = app_server_profile(&ModelType::Codex, None);
    assert!(!uses_codex_app_server(&ModelType::Codex, &default_profile));

    // Explicit opt-in flips the codex profile only.
    let opted_in = app_server_profile(&ModelType::Codex, Some("app-server"));
    assert!(uses_codex_app_server(&ModelType::Codex, &opted_in));

    // Unknown transport values are ignored.
    let unknown = app_server_profile(&ModelType::Codex, Some("websocket"));
    assert!(!uses_codex_app_server(&ModelType::Codex, &unknown));

    // Non-codex agents never honor the flag.
    let claude = app_server_profile(&ModelType::ClaudeCode, Some("app-server"));
    assert!(!uses_codex_app_server(&ModelType::ClaudeCode, &claude));
}

#[test]
fn build_codex_app_server_argv_is_bare_subcommand() {
    let profile = app_server_profile(&ModelType::Codex, Some("app-server"));
    let cmd = build_command_with_launch_profile(CliCommandBuildRequest {
        agent: &ModelType::Codex,
        launch_profile: &profile,
        model: None,
        task: "fix the bug",
        resume_id: Some("thread-123"),
        api_key: None,
        endpoint: None,
        mode: None,
        repo_path: Some("/workspace"),
        additional_dirs: &[],
    });
    // Task, resume id, cwd, sandbox and approval flags all travel over
    // JSON-RPC — none of them may leak into the argv.
    assert_eq!(command_name(&cmd[0]), "codex");
    assert_eq!(cmd[1..], ["app-server".to_string()]);
}

#[test]
fn build_codex_app_server_argv_keeps_model_variant_overrides() {
    let profile = app_server_profile(&ModelType::Codex, Some("app-server"));
    let cmd = build_command_with_launch_profile(CliCommandBuildRequest {
        agent: &ModelType::Codex,
        launch_profile: &profile,
        model: Some("gpt-5.4-medium-fast"),
        task: "write tests",
        resume_id: None,
        api_key: None,
        endpoint: None,
        mode: None,
        repo_path: None,
        additional_dirs: &[],
    });
    assert_eq!(cmd[1], "app-server");
    assert!(cmd.contains(&"model_reasoning_effort=\"medium\"".to_string()));
    assert!(cmd.contains(&"service_tier=\"priority\"".to_string()));
    // The base model itself goes via thread/start params, not argv.
    assert!(!cmd.iter().any(|arg| arg == "-m"));
    assert!(!cmd.iter().any(|arg| arg == "gpt-5.4"));
}

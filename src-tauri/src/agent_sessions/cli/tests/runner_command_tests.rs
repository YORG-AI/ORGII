use super::command::{build_command_with_launch_profile, map_claude_model, CliCommandBuildRequest};
use super::launch_profiles::{
    bare_command_for_agent, default_args_for_mode, default_env_for_mode, defaults_for_agent,
    CliPermissionMode, ResolvedCliLaunchProfile,
};
use super::session::effective_additional_dirs;
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
fn build_gemini_cli_basic() {
    let cmd = build_command!(
        ModelType::GeminiCli,
        task = "refactor",
        model = Some("gemini-2.5-pro"),
    );
    assert_eq!(command_name(&cmd[0]), "gemini");
    assert!(cmd.contains(&"--yolo".to_string()));
    assert!(cmd.contains(&"--model".to_string()));
    assert!(cmd.contains(&"-p".to_string()));
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
    assert!(cmd.contains(&"--allow-all-tools".to_string()));
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
fn global_dirs_are_deduped_with_session_dirs_for_supported_clis() {
    let session_dir = tempfile::tempdir().unwrap();
    let global_dir = tempfile::tempdir().unwrap();
    let session_dirs = vec![session_dir.path().to_string_lossy().into_owned()];
    let effective = effective_additional_dirs(
        &session_dirs,
        &[
            session_dir.path().canonicalize().unwrap(),
            global_dir.path().canonicalize().unwrap(),
        ],
    );
    let codex = build_command!(
        ModelType::Codex,
        task = "task",
        additional_dirs = &effective,
    );
    let claude = build_command!(
        ModelType::ClaudeCode,
        task = "task",
        additional_dirs = &effective,
    );
    let expected = vec![
        session_dir
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned(),
        global_dir
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned(),
    ];

    for cmd in [&codex, &claude] {
        let add_dirs: Vec<String> = cmd
            .windows(2)
            .filter(|args| args[0] == "--add-dir")
            .map(|args| args[1].clone())
            .collect();
        assert_eq!(add_dirs, expected);
    }
}

#[test]
fn cursor_receives_no_global_dirs() {
    let global_dir = tempfile::tempdir().unwrap();
    let effective = effective_additional_dirs(&[], &[global_dir.path().canonicalize().unwrap()]);
    let cmd = build_command!(
        ModelType::CursorCli,
        task = "task",
        additional_dirs = &effective,
    );

    assert!(!cmd.contains(&"--add-dir".to_string()));
    assert!(!cmd.contains(&global_dir.path().to_string_lossy().into_owned()));
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

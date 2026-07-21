//! Shell execution tool: subprocess by default, PTY for interactive commands.
//!
//! Regular commands (ls, git, grep, etc.) run via `std::process::Command` —
//! fast, reliable, clean stdout/stderr capture with no marker games.
//!
//! When `interactive: true` is set, the command runs in a persistent PTY
//! session (shared with the frontend terminal UI) for password prompts,
//! sudo, SSH, and other interactive use cases. The user can see the
//! terminal and take over at any time.
//!
//! Integrated subprocess output is persisted to bounded-memory Session Replay
//! artifacts. Background jobs can be monitored without loading the artifact.
//! The agent can follow up using `await_output` subcommands
//! (wait/status/tail/list) to monitor progress, or `run_shell(kill_handle=...)`
//! to terminate.

pub mod await_tool;
mod external;
pub mod external_replay;
pub mod legacy_replay;
mod pty;
pub mod registry;
pub mod shell_replay;
mod subprocess;

use async_trait::async_trait;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tauri::async_runtime::Mutex as AsyncMutex;
use tauri::AppHandle;
use tracing::{info, warn};

use tokio::sync::Mutex as TokioMutex;

use crate::security::{self, SecurityPolicy, ValidationResult};
use crate::session::workspace::SessionWorkspace;
use crate::tools::names as tool_names;
use crate::tools::traits::{optional_string, Tool, ToolError};
use crate::turn_executor::{PermissionProvider, PermissionVerdict};
use ::terminal::pty_commands::pty::PtySession;

use self::pty::PtyResources;

/// Hard-coded fallback denylist of always-dangerous shell patterns.
///
/// Used **only** when this `ExecTool` instance has no
/// `SecurityPolicy` wired in (e.g. unit tests). When a policy is
/// present, `SecurityPolicy::validate_command_execution()` is the
/// single source of truth — this list is intentionally not consulted.
const DENY_PATTERNS: &[&str] = &[
    "rm -rf /",
    "rm -rf /*",
    "mkfs",
    "dd if=",
    ":(){ :|:", // fork bomb
    "> /dev/sda",
    "shutdown",
    "reboot",
    "halt",
    "poweroff",
];

/// Shell execution tool: subprocess default, PTY for interactive.
///
/// - **Default** (`interactive` omitted or `false`): runs command via
///   `std::process::Command` → fast, reliable, clean stdout/stderr.
/// - **Interactive** (`interactive: true`): runs in persistent PTY →
///   supports password prompts, sudo, SSH, interactive TUIs.
///   The terminal is visible in the frontend for user takeover.
pub struct ExecTool {
    working_dir: PathBuf,
    workspace_state: Option<Arc<parking_lot::RwLock<SessionWorkspace>>>,
    timeout_secs: u64,
    restrict_to_workspace: bool,
    pty: Option<PtyResources>,
    active_repo: TokioMutex<Option<PathBuf>>,
    session_key: TokioMutex<Option<String>>,
    cancel_flag: TokioMutex<Option<Arc<AtomicBool>>>,
    security_policy: Option<Arc<SecurityPolicy>>,
    permission_provider: TokioMutex<Option<Arc<dyn PermissionProvider>>>,
    shell_replays_root: Option<PathBuf>,
    app_handle: Option<AppHandle>,
}

impl ExecTool {
    /// Create an ExecTool without PTY capability (subprocess only).
    pub fn new(working_dir: PathBuf, timeout_secs: u64, restrict_to_workspace: bool) -> Self {
        Self {
            working_dir,
            workspace_state: None,
            timeout_secs,
            restrict_to_workspace,
            pty: None,
            active_repo: TokioMutex::new(None),
            session_key: TokioMutex::new(None),
            cancel_flag: TokioMutex::new(None),
            security_policy: None,
            permission_provider: TokioMutex::new(None),
            shell_replays_root: None,
            app_handle: None,
        }
    }

    /// Create an ExecTool with PTY capability (for interactive commands).
    pub fn new_with_pty(
        working_dir: PathBuf,
        timeout_secs: u64,
        restrict_to_workspace: bool,
        pty_sessions: Arc<AsyncMutex<HashMap<String, PtySession>>>,
        app_handle: AppHandle,
    ) -> Self {
        Self {
            working_dir,
            workspace_state: None,
            timeout_secs,
            restrict_to_workspace,
            session_key: TokioMutex::new(None),
            cancel_flag: TokioMutex::new(None),
            pty: Some(PtyResources::new(pty_sessions, app_handle.clone())),
            active_repo: TokioMutex::new(None),
            security_policy: None,
            permission_provider: TokioMutex::new(None),
            shell_replays_root: None,
            app_handle: Some(app_handle.clone()),
        }
    }

    pub fn with_workspace_state(
        mut self,
        workspace_state: Arc<parking_lot::RwLock<SessionWorkspace>>,
    ) -> Self {
        self.workspace_state = Some(workspace_state);
        self
    }

    pub fn with_security_policy(mut self, policy: Arc<SecurityPolicy>) -> Self {
        self.security_policy = Some(policy);
        self
    }

    pub fn with_shell_replays_root(mut self, path: PathBuf) -> Self {
        self.shell_replays_root = Some(path);
        self
    }

    pub fn with_app_handle(mut self, app_handle: Option<AppHandle>) -> Self {
        self.app_handle = app_handle;
        self
    }

    /// Command-level confirmation for risky shell commands.
    ///
    /// This is NOT a duplicate of the tool-level Ask verdict in
    /// `turn_executor/helpers/permission.rs` — that gate fires per TOOL
    /// CALL before execution; this gate fires per COMMAND when
    /// `SecurityPolicy` classifies it as needs-approval. Both flow
    /// through the SAME `PermissionProvider` (AgentPermissionManager),
    /// so always-allow rules and session permission state are shared.
    async fn request_command_confirmation(
        &self,
        command: &str,
        reason: &str,
    ) -> Result<(), ToolError> {
        self.request_command_confirmation_inner(command, reason, false)
            .await
    }

    async fn request_external_terminal_confirmation(
        &self,
        command: &str,
        reason: &str,
    ) -> Result<(), ToolError> {
        self.request_command_confirmation_inner(command, reason, true)
            .await
    }

    async fn request_command_confirmation_inner(
        &self,
        command: &str,
        reason: &str,
        force_prompt: bool,
    ) -> Result<(), ToolError> {
        let provider = self.permission_provider.lock().await.clone();
        let Some(provider) = provider else {
            return Err(ToolError::PermissionDenied(reason.to_string()));
        };

        if !force_prompt && provider.is_always_allowed(tool_names::RUN_SHELL).await {
            return Ok(());
        }

        let Some(session_id) = self.session_key.lock().await.clone() else {
            return Err(ToolError::PermissionDenied(
                "Permission request cannot be shown because the session key is not configured."
                    .into(),
            ));
        };
        let tool_call_id = format!("{}-confirm-{}", tool_names::RUN_SHELL, uuid::Uuid::new_v4());
        let confirm_args = if force_prompt {
            serde_json::json!({
                "command": command,
                "reason": reason,
                "terminal_target": "external",
            })
        } else {
            serde_json::json!({
                "command": command,
                "reason": reason,
            })
        };

        info!("[ExecTool] Command requires user confirmation: {}", command);
        match provider
            .request_permission(
                &session_id,
                tool_names::RUN_SHELL,
                &tool_call_id,
                &confirm_args,
            )
            .await
        {
            Ok(PermissionVerdict::Allow | PermissionVerdict::AlwaysAllow) => {
                info!("[ExecTool] User approved command: {}", command);
                Ok(())
            }
            Ok(PermissionVerdict::Deny) => Err(ToolError::PermissionDenied(format!(
                "User denied execution of: {}",
                command
            ))),
            Err(_) => Err(ToolError::PermissionDenied(
                "Permission request was cancelled or timed out.".into(),
            )),
        }
    }

    fn is_denied(command: &str) -> bool {
        let lower = command.to_lowercase();
        DENY_PATTERNS.iter().any(|pattern| lower.contains(pattern))
    }

    fn is_valid_shell_kill_handle(handle: &str) -> bool {
        !handle.is_empty() && handle.chars().all(|ch| ch.is_ascii_digit())
    }
}

#[async_trait]
impl Tool for ExecTool {
    fn name(&self) -> &str {
        tool_names::RUN_SHELL
    }

    fn category(&self) -> &str {
        crate::tools::categories::CODING
    }

    fn output_budget(&self) -> usize {
        30_000
    }

    fn search_hint(&self) -> &str {
        "bash shell terminal command execute exec grep awk sed process cli run script"
    }

    fn description(&self) -> &str {
        "Execute a shell command or kill a backgrounded process.\n\
        Execute: terminal_target=\"integrated\" (default) runs as a fast subprocess with clean stdout/stderr capture. \
        Set terminal_target=\"external\" only when the user explicitly asks to open the OS terminal for interactive input; \
        external terminal output cannot be captured like integrated stdout/stderr. \
        Set interactive: true ONLY for commands that require user input (passwords, sudo, SSH key passphrases). \
        Set mode: \"background\" up-front for long-running processes (dev servers, watchers, builds \
        you want to spawn then poll). Background mode returns a PID/await_output handle as soon as the process \
        is spawned; use await_output(command=\"wait_for\", handles=[pid]) to monitor until the process exits.\n\
        In the default blocking mode, commands that exceed the timeout are automatically backgrounded \
        (never killed) as a safety net — you get partial output plus a PID handle.\n\
        Kill: set kill_handle to the PID of a backgrounded process to terminate it (SIGTERM → 2s grace → SIGKILL).\n\
        For long-running commands (builds, installs, tests, git clone), prefer mode=\"background\" from the start, \
        then call await_output(command=\"wait_for\", handles=[pid]); do not treat progress output as completion. \
        IMPORTANT: Always limit output — use | head, --short, --oneline -N, -maxdepth, etc. \
        Do not use executable shell substitutions (`...`, $(...), or ${...}); for literal code fences/backticks, use a single-quoted heredoc such as <<'EOF' or use edit_file/write_file."
    }

    fn llm_description(&self) -> Option<String> {
        let cwd = self
            .active_repo
            .try_lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(|path| path.display().to_string()))
            .unwrap_or_else(|| self.working_dir.display().to_string());
        Some(format!(
            "Execute a shell command in {cwd} or kill a backgrounded process.\n\
            Execute: terminal_target=\"integrated\" (default) runs as a fast subprocess with clean stdout/stderr capture. \
            Set terminal_target=\"external\" only when the user explicitly asks to open the OS terminal for interactive input; \
            external terminal output cannot be captured like integrated stdout/stderr. \
            Set interactive: true ONLY for commands that require user input (passwords, sudo, SSH key passphrases). \
            Set mode: \"background\" up-front for long-running processes (dev servers, watchers, builds \
            you want to spawn then poll). Background mode returns a PID/await_output handle immediately after spawn; \
            use await_output(command=\"wait_for\", handles=[pid]) to monitor until the process exits.\n\
            In the default blocking mode, commands that exceed the timeout ({timeout}s) are automatically \
            backgrounded (never killed) as a safety net. You get bounded partial output, a PID handle, and durable Session Replay access.\n\
            Kill: set kill_handle to the PID of a backgrounded process to terminate it \
            (SIGTERM → 2s grace → SIGKILL).\n\
            For long-running commands (builds, installs, tests, git clone), prefer mode=\"background\" from the start, \
            then call await_output(command=\"wait_for\", handles=[pid]); do not treat progress output as completion. \
            IMPORTANT: Always limit output — use | head, --short, --oneline -N, -maxdepth, etc. \
            Do not use executable shell substitutions (`...`, $(...), or ${{...}}); for literal code fences/backticks, use a single-quoted heredoc such as <<'EOF' or use {edit_file}.\n\
            \n\
            ## Tool routing (CRITICAL)\n\
            - NEVER use shell `find` or `ls` to locate files — use `{code_search}` (find_files/glob) or `{list_dir}`.\n\
            - NEVER use shell `grep` or `rg` to search file contents — use `{code_search}` (grep action, ripgrep-backed).\n\
            - NEVER use `cat`/`head`/`tail`/`sed -n` to read files — use `{read_file}`.\n\
            - NEVER use `sed`/`awk`/`echo >`/heredoc to modify or create files — use `{edit_file}`.\n\
            - Quote file paths containing spaces (e.g. cd \"path with spaces\").\n\
            - Chain dependent commands with && in one call; use separate parallel calls for independent commands.\n\
            \n\
            ## Committing with git\n\
            Only commit when the user explicitly asks. When asked:\n\
            1. Run `git status`, `git diff HEAD`, and `git log --oneline -5` (in parallel) to see all changes and match the repo's commit message style.\n\
            2. Stage only the relevant files — never `git add -A` blindly when unrelated changes exist.\n\
            3. Multi-line commit messages: $() is blocked here, so write the message to a file with a single-quoted heredoc, then `git commit -F`:\n\
            cat > /tmp/commit-msg.txt <<'EOF'\n\
            Commit message here.\n\
            EOF\n\
            git commit -F /tmp/commit-msg.txt\n\
            (single-line messages can just use `git commit -m \"...\"`)\n\
            4. If the commit fails due to pre-commit hooks, fix the underlying issue and retry — NEVER use --no-verify.\n\
            NEVER update git config, never force-push, never amend published commits unless explicitly asked.\n\
            \n\
            ## Creating pull requests\n\
            Use `gh` for ALL GitHub interactions (PRs, issues, checks). When asked to create a PR:\n\
            1. Run `git status`, `git diff [base]...HEAD`, and `git log [base]..HEAD --oneline` to understand the FULL branch diff (all commits, not just the latest).\n\
            2. Push with `-u` if the branch has no upstream.\n\
            3. Write the PR body to a file with a single-quoted heredoc, then:\n\
            gh pr create --title \"the title\" --body-file /tmp/pr-body.md",
            cwd = cwd, timeout = self.timeout_secs,
            code_search = crate::tools::names::CODE_SEARCH,
            list_dir = crate::tools::names::LIST_DIR,
            read_file = crate::tools::names::READ_FILE,
            edit_file = crate::tools::names::EDIT_FILE,
        ))
    }

    fn parameters(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "Shell command to execute. Use absolute paths when possible."
                },
                "description": {
                    "type": "string",
                    "description": "A short human-readable description of what this command does (5-10 words). Shown to the user as the title."
                },
                "working_dir": {
                    "type": "string",
                    "description": "Working directory for the command."
                },
                "interactive": {
                    "type": "boolean",
                    "description": "Set true ONLY for commands needing user input (password prompts, sudo, ssh). Default: false."
                },
                "terminal_target": {
                    "type": "string",
                    "enum": ["integrated", "external"],
                    "description": "Where to run the command. 'integrated' (default) executes through the tool backend and captures stdout/stderr. 'external' opens the default OS terminal and sends the command there; use only when explicitly requested for interactive user input/password approval, and expect no stdout/stderr capture."
                },
                "mode": {
                    "type": "string",
                    "enum": ["blocking", "background"],
                    "description": "Execution mode. 'blocking' (default): wait for completion up to `wait` seconds, then auto-background on timeout. 'background': spawn and return immediately with a PID/await_output handle while complete output continues into Session Replay; intended for dev servers, watchers, and other long-running processes."
                },
                "wait": {
                    "type": "integer",
                    "description": "Blocking mode only. Seconds to wait before auto-backgrounding. Default: uses the configured exec timeout (~120s). Set lower (e.g. 10-30) for commands you expect to be long-running so you get partial output and a PID sooner. Set to 0 to auto-background immediately. Ignored when mode='background'. The process is never killed on timeout — use kill_handle to terminate."
                },
                "kill_handle": {
                    "type": "string",
                    "description": "Instead of running a command, kill a backgrounded shell process by its handle (PID). Sends SIGTERM, waits 2s grace, then SIGKILL. When this is set, 'command' is not required."
                }
            },
            "required": []
        })
    }

    async fn set_active_repo(&self, repo_path: &str) {
        let path = PathBuf::from(repo_path);
        if path.exists() {
            *self.active_repo.lock().await = Some(path);
        }
    }

    async fn set_session_key(&self, session_key: &str) {
        *self.session_key.lock().await = Some(session_key.to_string());
    }

    async fn set_cancel_flag(&self, cancel_flag: Arc<AtomicBool>) {
        *self.cancel_flag.lock().await = Some(cancel_flag);
    }

    async fn set_permission_provider(&self, provider: Arc<dyn PermissionProvider>) {
        *self.permission_provider.lock().await = Some(provider);
    }

    async fn execute_text(
        &self,
        params: Value,
        ctx: &crate::tools::traits::CallContext,
    ) -> Result<String, ToolError> {
        let command = optional_string(&params, "command");
        let kill_handle = params
            .get("kill_handle")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|handle| !handle.is_empty());

        if let Some(handle) = kill_handle {
            if Self::is_valid_shell_kill_handle(handle) {
                return match registry::kill_shell(handle).await {
                    Ok(()) => Ok(format!("Process {handle} killed.")),
                    Err(msg) => Err(ToolError::ExecutionFailed(msg)),
                };
            }

            if command.is_none() {
                return Err(ToolError::InvalidParams(format!(
                    "Invalid kill_handle '{handle}'. run_shell kill handles are numeric process handles returned by prior background shell output. To run a command, pass it in the command field instead."
                )));
            }

            warn!(
                "[ExecTool] ignoring invalid kill_handle '{}' because command is present",
                handle
            );
        }

        let command = command.ok_or_else(|| {
            ToolError::InvalidParams("Missing required string parameter: command".into())
        })?;
        let custom_dir =
            optional_string(&params, "working_dir").filter(|dir| !dir.trim().is_empty());
        let requested_interactive = params
            .get("interactive")
            .and_then(|val| val.as_bool())
            .unwrap_or(false);
        let interactive = requested_interactive;
        let terminal_target = external::TerminalTarget::parse(
            params
                .get("terminal_target")
                .and_then(|value| value.as_str()),
        )?;
        let wait_secs = params.get("wait").and_then(|val| val.as_u64());
        let mode = match params.get("mode").and_then(|v| v.as_str()) {
            None | Some("blocking") => subprocess::ExecMode::Blocking,
            Some("background") => subprocess::ExecMode::Background,
            Some(other) => {
                return Err(ToolError::InvalidParams(format!(
                    "Unknown mode \"{}\". Valid values: blocking, background.",
                    other
                )));
            }
        };

        if let Some(ref policy) = self.security_policy {
            match policy.validate_command_execution(&command, false) {
                ValidationResult::Allowed(_risk) => {}
                ValidationResult::NeedsApproval(_risk, reason) => {
                    self.request_command_confirmation(&command, &reason).await?;
                }
                ValidationResult::Denied(reason) => {
                    return Err(ToolError::PermissionDenied(reason));
                }
            }
        } else {
            if Self::is_denied(&command) {
                return Err(ToolError::PermissionDenied(format!(
                    "Command denied for safety: {}",
                    command
                )));
            }
            if let Some(reason) = security::requires_user_confirmation(&command) {
                self.request_command_confirmation(&command, &reason).await?;
            }
        }

        let current_workspace_dir = self
            .workspace_state
            .as_ref()
            .map(|workspace| workspace.read().working_dir().to_path_buf())
            .unwrap_or_else(|| self.working_dir.clone());
        let base_dir = {
            let active = self.active_repo.lock().await;
            active
                .clone()
                .unwrap_or_else(|| current_workspace_dir.clone())
        };

        let work_dir = if let Some(ref dir) = custom_dir {
            let path = PathBuf::from(dir);
            // Path syntax (null bytes, `..`, forbidden list) — command
            // policy owns this. Containment is decided below by the
            // live SessionWorkspace, the single path-authorization source.
            if let Some(ref policy) = self.security_policy {
                policy
                    .validate_path_syntax(dir)
                    .map_err(ToolError::PermissionDenied)?;
            }
            let workspace_only = self
                .security_policy
                .as_ref()
                .is_some_and(|policy| policy.workspace_only);
            if self.restrict_to_workspace || workspace_only {
                if let Some(ref workspace) = self.workspace_state {
                    let extra: Vec<PathBuf> =
                        self.active_repo.lock().await.clone().into_iter().collect();
                    workspace
                        .read()
                        .is_path_allowed(&path, &extra)
                        .map_err(ToolError::PermissionDenied)?;
                } else if !path.starts_with(&current_workspace_dir) {
                    return Err(ToolError::PermissionDenied(
                        "Working directory is outside workspace".to_string(),
                    ));
                }
            }
            Some(path)
        } else {
            None
        };

        // Resolve the cwd we want to spawn under. If the agent passed a custom
        // dir, honour it strictly (error if missing). Otherwise we may fall
        // back to the workspace root when the previously cached active_repo /
        // worktree has been deleted out from under us (e.g. an E2E scenario
        // tmpdir was cleaned, or `git worktree prune` removed a stale entry).
        // Without this fallback `tokio::process::Command::current_dir(...)`
        // returns ENOENT and the agent surfaces an opaque "Failed to spawn
        // command: No such file or directory" for every subsequent shell call.
        let mut effective_dir = work_dir.clone().unwrap_or(base_dir.clone());
        if !effective_dir.exists() {
            if work_dir.is_some() {
                return Err(ToolError::InvalidParams(format!(
                    "Working directory does not exist: {}",
                    effective_dir.display()
                )));
            }
            if effective_dir != current_workspace_dir && current_workspace_dir.exists() {
                warn!(
                    "[ExecTool] cached cwd '{}' no longer exists; falling back to workspace '{}'",
                    effective_dir.display(),
                    current_workspace_dir.display(),
                );
                effective_dir = current_workspace_dir.clone();
            } else {
                return Err(ToolError::ExecutionFailed(format!(
                    "Working directory does not exist: {}",
                    effective_dir.display()
                )));
            }
        }

        info!(
            "exec: {} (cwd: {}, interactive: {}, terminal_target: {:?})",
            command,
            effective_dir.display(),
            interactive,
            terminal_target,
        );

        if matches!(terminal_target, external::TerminalTarget::External) {
            if matches!(mode, subprocess::ExecMode::Background) {
                return Err(ToolError::InvalidParams(
                    "mode=\"background\" is incompatible with terminal_target=\"external\". External terminal commands are interactive windows and cannot be tracked as backend background jobs."
                        .into(),
                ));
            }
            self.request_external_terminal_confirmation(
                &command,
                "Opening an external terminal runs outside the tool backend and stdout/stderr cannot be captured. Confirm that you want ORGII to open your OS terminal and send this command.",
            )
            .await?;
            let launch = external::launch(&command, &effective_dir)?;
            return Ok(external::format_launch_result(&command, &launch));
        }

        if ctx.session_id.trim().is_empty() || ctx.call_id.trim().is_empty() {
            return Err(ToolError::ExecutionFailed(
                "Integrated run_shell requires exact CallContext session_id and call_id."
                    .to_string(),
            ));
        }
        let identity = subprocess::ExecIdentity::new(&ctx.session_id, &ctx.call_id);
        let replay_root = self.shell_replays_root.as_ref().ok_or_else(|| {
            ToolError::ExecutionFailed("Shell replay storage root is not configured.".to_string())
        })?;

        let cancel_flag = self.cancel_flag.lock().await.clone();
        if interactive {
            if matches!(mode, subprocess::ExecMode::Background) {
                return Err(ToolError::InvalidParams(
                    "mode=\"background\" is incompatible with interactive=true. \
                     Interactive sessions cannot be detached; drop one of the two options."
                        .into(),
                ));
            }
            if let Some(ref pty_res) = self.pty {
                let Some(session_key) = self.session_key.lock().await.clone() else {
                    return Err(ToolError::ExecutionFailed(
                        "PTY execution requires an agent session key.".to_string(),
                    ));
                };
                return pty::execute_via_pty(
                    pty_res,
                    pty::PtyExecutionRequest {
                        command: &command,
                        work_dir: work_dir.as_ref(),
                        timeout_secs: self.timeout_secs,
                        wait_secs,
                        working_dir: &current_workspace_dir,
                        agent_session_id: &session_key,
                        identity: &identity,
                        replay_root,
                        cancel_flag: cancel_flag.clone(),
                    },
                )
                .await;
            }
            info!("[ExecTool] interactive=true requested but PTY not available, using subprocess");
        }

        subprocess::execute_via_command(
            &command,
            effective_dir,
            self.timeout_secs,
            wait_secs,
            mode,
            &identity,
            replay_root,
            self.app_handle.clone(),
            cancel_flag.as_deref(),
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::Path;

    fn fresh_tool(workspace: &Path) -> ExecTool {
        ExecTool::new(workspace.to_path_buf(), 5, false)
            .with_shell_replays_root(workspace.join("shell-replays"))
    }

    fn test_call_context() -> crate::tools::call_context::CallContext {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT_CALL: AtomicU64 = AtomicU64::new(1);
        crate::tools::call_context::CallContext::new(
            format!(
                "exec-test-call-{}",
                NEXT_CALL.fetch_add(1, Ordering::Relaxed)
            ),
            "exec-test-session",
        )
    }

    #[tokio::test]
    async fn execute_falls_back_to_workspace_when_cached_repo_was_deleted() {
        let _sandbox = test_helpers::test_env::sandbox();
        let workspace = tempfile::tempdir().expect("workspace tmpdir");
        let stale_repo = workspace.path().join("worktree-deleted");
        std::fs::create_dir_all(&stale_repo).unwrap();

        let tool = fresh_tool(workspace.path());
        *tool.active_repo.lock().await = Some(stale_repo.clone());

        std::fs::remove_dir_all(&stale_repo).unwrap();
        assert!(!stale_repo.exists());

        let result = tool
            .execute_text(json!({"command": "/bin/echo hello"}), &test_call_context())
            .await
            .expect("run_shell should succeed after fallback");

        assert!(
            result.contains("hello"),
            "expected 'hello' in fallback result: {result}"
        );
    }

    #[tokio::test]
    async fn execute_errors_when_explicit_working_directory_is_missing() {
        let workspace = tempfile::tempdir().expect("workspace tmpdir");
        let tool = fresh_tool(workspace.path());
        let bogus = workspace.path().join("does-not-exist");

        let result = tool
            .execute_text(
                json!({
                    "command": "/bin/echo nope",
                    "working_dir": bogus.to_string_lossy(),
                }),
                &test_call_context(),
            )
            .await;

        match result {
            Err(ToolError::InvalidParams(msg)) => {
                assert!(
                    msg.contains("Working directory does not exist"),
                    "unexpected error: {msg}"
                );
            }
            other => panic!("expected InvalidParams, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn empty_working_directory_uses_default_workspace() {
        let _sandbox = test_helpers::test_env::sandbox();
        let workspace = tempfile::tempdir().expect("workspace tmpdir");
        let tool = fresh_tool(workspace.path());

        let result = tool
            .execute_text(
                json!({
                    "command": "/bin/echo hello",
                    "working_dir": "",
                }),
                &test_call_context(),
            )
            .await
            .expect("empty working_dir should fall back to default workspace");

        assert!(result.contains("hello"), "unexpected output: {result}");
    }

    #[tokio::test]
    async fn empty_kill_handle_is_ignored() {
        let _sandbox = test_helpers::test_env::sandbox();
        let workspace = tempfile::tempdir().expect("workspace tmpdir");
        let tool = fresh_tool(workspace.path());

        let result = tool
            .execute_text(
                json!({
                    "command": "/bin/echo hello",
                    "kill_handle": "",
                }),
                &test_call_context(),
            )
            .await
            .expect("empty kill_handle should not take the kill path");

        assert!(result.contains("hello"), "unexpected output: {result}");
    }

    #[tokio::test]
    async fn path_like_kill_handle_is_ignored_when_command_is_present() {
        let _sandbox = test_helpers::test_env::sandbox();
        let workspace = tempfile::tempdir().expect("workspace tmpdir");
        let tool = fresh_tool(workspace.path());

        let result = tool
            .execute_text(
                json!({
                    "command": "/bin/echo hello",
                    "kill_handle": "/dev/null",
                }),
                &test_call_context(),
            )
            .await
            .expect("path-like kill_handle should not take the kill path when command is present");

        assert!(result.contains("hello"), "unexpected output: {result}");
    }

    #[tokio::test]
    async fn invalid_kill_handle_without_command_is_rejected_as_protocol_error() {
        let workspace = tempfile::tempdir().expect("workspace tmpdir");
        let tool = fresh_tool(workspace.path());

        let result = tool
            .execute_text(
                json!({
                    "kill_handle": "/dev/null",
                }),
                &test_call_context(),
            )
            .await;

        match result {
            Err(ToolError::InvalidParams(msg)) => {
                assert!(
                    msg.contains("Invalid kill_handle"),
                    "unexpected error: {msg}"
                );
            }
            other => panic!("expected InvalidParams, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn external_terminal_target_is_exposed_in_schema() {
        let workspace = tempfile::tempdir().expect("workspace tmpdir");
        let tool = fresh_tool(workspace.path());
        let schema = tool.parameters();

        let enum_values = schema
            .pointer("/properties/terminal_target/enum")
            .and_then(|value| value.as_array())
            .expect("terminal_target enum should exist");
        assert_eq!(enum_values, &vec![json!("integrated"), json!("external")]);
    }

    #[tokio::test]
    async fn external_terminal_rejects_background_mode_before_launch() {
        let workspace = tempfile::tempdir().expect("workspace tmpdir");
        let tool = fresh_tool(workspace.path());

        let result = tool
            .execute_text(
                json!({
                    "command": "/bin/echo hello",
                    "terminal_target": "external",
                    "mode": "background",
                }),
                &test_call_context(),
            )
            .await;

        match result {
            Err(ToolError::InvalidParams(msg)) => {
                assert!(
                    msg.contains("terminal_target=\"external\""),
                    "unexpected error: {msg}"
                );
            }
            other => panic!("expected InvalidParams, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn unknown_terminal_target_is_rejected() {
        let workspace = tempfile::tempdir().expect("workspace tmpdir");
        let tool = fresh_tool(workspace.path());

        let result = tool
            .execute_text(
                json!({
                    "command": "/bin/echo hello",
                    "terminal_target": "space",
                }),
                &test_call_context(),
            )
            .await;

        match result {
            Err(ToolError::InvalidParams(msg)) => {
                assert!(
                    msg.contains("Unknown terminal_target"),
                    "unexpected error: {msg}"
                );
            }
            other => panic!("expected InvalidParams, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn blocking_command_returns_promptly_when_turn_is_cancelled() {
        let _sandbox = test_helpers::test_env::sandbox();
        let workspace = tempfile::tempdir().expect("workspace tmpdir");
        let tool = fresh_tool(workspace.path());
        let cancel_flag = Arc::new(AtomicBool::new(false));
        tool.set_cancel_flag(Arc::clone(&cancel_flag)).await;

        let started = std::time::Instant::now();
        let ctx = test_call_context();
        let run = tool.execute_text(
            json!({
                "command": "sleep 5",
                "wait": 10,
            }),
            &ctx,
        );
        tokio::pin!(run);

        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        cancel_flag.store(true, std::sync::atomic::Ordering::SeqCst);

        let result = run.await;
        assert!(
            started.elapsed() < std::time::Duration::from_secs(2),
            "cancelled shell command should not wait for natural process exit"
        );
        match result {
            Err(ToolError::ExecutionFailed(msg)) => {
                assert!(msg.contains("cancelled"), "unexpected error: {msg}");
            }
            other => panic!("expected cancelled execution error, got {other:?}"),
        }
    }
}

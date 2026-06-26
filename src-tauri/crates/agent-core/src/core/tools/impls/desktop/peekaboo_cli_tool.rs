use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use tokio::io::AsyncWriteExt;

use async_trait::async_trait;
use serde_json::{json, Value};
use tauri::Manager;
use tokio::process::Command;
use tracing::warn;

use crate::tools::categories as tool_categories;
use crate::tools::names as tool_names;
use crate::tools::traits::{required_string, Tool, ToolError};
use shared_state::split_browser_cli_command;

const OPTIONAL_SIDECAR_PLACEHOLDER_MARKER: &str = "ORGII_GENERATED_OPTIONAL_SIDECAR_PLACEHOLDER";
const PEEKABOO_VERSION: &str = "v3.2.3";
const PEEKABOO_STALL_TIMEOUT: Duration = Duration::from_secs(30);
const PEEKABOO_COMMAND_TIMEOUT: Duration = Duration::from_secs(120);
/// Wall-clock cap for the `sleep` subcommand, which intentionally blocks for a
/// caller-specified duration. The generic 120 s timeout would falsely kill a
/// long deliberate pause, so `sleep` gets a much larger ceiling instead.
const PEEKABOO_SLEEP_TIMEOUT: Duration = Duration::from_secs(3600);
const DESKTOP_OPERATION_IDLE_RESTORE: Duration = Duration::from_secs(20);
const ALLOWED_PEEKABOO_COMMANDS: &[&str] = &[
    "app",
    "click",
    "clipboard",
    "dialog",
    "dock",
    "drag",
    "help",
    "hotkey",
    "image",
    "list",
    "menubar",
    "menu",
    "move",
    "open",
    "paste",
    "perform-action",
    "permissions",
    "press",
    "scroll",
    "see",
    "set-value",
    "sleep",
    "space",
    "swipe",
    "type",
    "window",
];

/// Peekaboo subcommands that synthesize HID input. Anti-automation systems in
/// apps like WeChat flag pure Accessibility-API actions because no real HID
/// event ever reaches the WindowServer. Forcing `--input-strategy synthFirst`
/// on these commands makes Peekaboo post genuine CGEvent mouse/keyboard events
/// first (falling back to AX only on failure), which presents as real hardware
/// input. See `docs/agent/peekaboo-learnings/`.
const INPUT_COMMANDS: &[&str] = &[
    "click",
    "drag",
    "hotkey",
    "move",
    "paste",
    "perform-action",
    "press",
    "scroll",
    "set-value",
    "swipe",
    "type",
];

/// Peekaboo input strategy that prefers synthesized CGEvent (HID) input over
/// Accessibility-API actions.
const SYNTH_FIRST_STRATEGY: &str = "synthFirst";

/// Peekaboo typing profile that emits keystrokes with human-like cadence so
/// anti-bot heuristics do not flag the automation.
const HUMAN_PROFILE: &str = "human";

/// Peekaboo observation subcommands whose output is consumed by the LLM.
/// Forcing `--json` keeps the response machine-stable and token-efficient
/// instead of returning free-form human-readable text.
const OBSERVATION_COMMANDS: &[&str] = &["app", "list", "permissions", "see", "window"];

/// The `sleep` subcommand, special-cased for timeout handling.
const SLEEP_COMMAND: &str = "sleep";

const DESCRIPTION: &str = r#"Control the macOS desktop through the bundled Peekaboo CLI.

Pass the Peekaboo subcommand in `command`; ORGII adds the bundled executable path automatically. Do not include the executable name.

Examples:
- `see --app Safari --json`
- `click --on "Reload this page" --snapshot SNAPSHOT_ID`
- `type --text "hello" --clear`
- `hotkey cmd,shift,t`
- `scroll --direction down --amount 5`
- `image --mode screen --retina --path /tmp/screen.png`
- `list apps --json`
- `permissions status --json`

Use this for desktop observation and interaction commands only. Peekaboo requires macOS Screen Recording and Accessibility permissions.

Input commands (click, type, drag, scroll, etc.) automatically synthesize real HID events with human-like cadence so apps with anti-automation detection are not triggered."#;

#[derive(Debug, Clone)]
pub struct PeekabooCliTool {
    app_handle: Option<tauri::AppHandle>,
}

impl PeekabooCliTool {
    pub fn new(app_handle: Option<tauri::AppHandle>) -> Self {
        Self { app_handle }
    }
}

#[async_trait]
impl Tool for PeekabooCliTool {
    fn name(&self) -> &str {
        tool_names::CONTROL_DESKTOP_WITH_PEEKABOO
    }

    fn category(&self) -> &str {
        tool_categories::DESKTOP
    }

    fn description(&self) -> &str {
        DESCRIPTION
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "Raw Peekaboo CLI desktop subcommand and arguments, for example: see --app Safari --json, click --on \"Reload\" --snapshot SNAPSHOT_ID, type --text \"hello\", hotkey cmd,shift,t, image --mode screen --retina --path /tmp/screen.png. Do not include the peekaboo executable name."
                }
            },
            "required": ["command"]
        })
    }

    async fn execute_text(
        &self,
        params: Value,
        _ctx: &crate::tools::traits::CallContext,
    ) -> Result<String, ToolError> {
        let command = required_string(&params, "command")?;
        let mut args = split_browser_cli_command(&command)
            .map_err(|err| ToolError::InvalidParams(err.to_string()))?;
        ensure_allowed_peekaboo_command(&args).map_err(ToolError::InvalidParams)?;
        let config = crate::state::commands::desktop::load_desktop_config().unwrap_or_else(|err| {
            warn!(
                "[peekaboo] failed to load desktop config, using defaults: {}",
                err
            );
            crate::state::commands::desktop::DesktopConfig::default()
        });
        apply_managed_args(&mut args, &config);
        let executable = resolve_or_install_peekaboo_executable()
            .await
            .map_err(ToolError::ExecutionFailed)?;
        let visibility_guard = self
            .app_handle
            .as_ref()
            .and_then(DesktopOperationVisibilityGuard::for_peekaboo_operation);
        let output = run_peekaboo_cli_command(&executable, &args)
            .await
            .map_err(ToolError::ExecutionFailed)?;
        drop(visibility_guard);

        Ok(format_peekaboo_output(&output))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeekabooCliOutput {
    pub status: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

struct DesktopOperationVisibilityGuard {
    app_handle: tauri::AppHandle,
    generation: u64,
}

#[derive(Default)]
struct DesktopOperationVisibilityState {
    active_count: usize,
    generation: u64,
    lease_active: bool,
    hide_main_window: bool,
    main_window_was_visible: bool,
    wingman_bar_was_visible: bool,
    monitor_index: Option<usize>,
}

static DESKTOP_OPERATION_VISIBILITY_STATE: OnceLock<Mutex<DesktopOperationVisibilityState>> =
    OnceLock::new();

impl DesktopOperationVisibilityGuard {
    fn for_peekaboo_operation(app_handle: &tauri::AppHandle) -> Option<Self> {
        let hide_main_window = match crate::state::commands::desktop::load_desktop_config() {
            Ok(config) => config.hide_before_action,
            Err(err) => {
                warn!("[peekaboo] failed to load desktop config: {}", err);
                true
            }
        };
        Self::new(app_handle, hide_main_window, None)
    }

    fn for_visibility_test(
        app_handle: &tauri::AppHandle,
        monitor_index: Option<usize>,
    ) -> Option<Self> {
        Self::new(app_handle, true, monitor_index)
    }

    fn new(
        app_handle: &tauri::AppHandle,
        hide_main_window: bool,
        monitor_index: Option<usize>,
    ) -> Option<Self> {
        let (generation, should_apply_visibility) = {
            let mut state = desktop_operation_visibility_state()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.generation = state.generation.wrapping_add(1);
            state.active_count += 1;

            if !state.lease_active {
                state.lease_active = true;
                state.hide_main_window = hide_main_window;
                state.main_window_was_visible = app_handle
                    .get_webview_window("main")
                    .and_then(|window| window.is_visible().ok())
                    .unwrap_or(false);
                state.wingman_bar_was_visible =
                    crate::session::wingman::is_wingman_bar_visible(app_handle);
                state.monitor_index = monitor_index;
                warn!(
                    "[peekaboo-visibility] acquired lease generation={}, hide_main_window={}, main_was_visible={}, bar_was_visible={}, monitor_index={:?}",
                    state.generation,
                    state.hide_main_window,
                    state.main_window_was_visible,
                    state.wingman_bar_was_visible,
                    state.monitor_index
                );
                (state.generation, true)
            } else {
                warn!(
                    "[peekaboo-visibility] reused active lease generation={}, active_count={}, requested_hide_main_window={}, requested_monitor_index={:?}",
                    state.generation,
                    state.active_count,
                    hide_main_window,
                    monitor_index
                );
                (state.generation, false)
            }
        };

        if should_apply_visibility {
            warn!(
                "[peekaboo-visibility] applying visibility for generation={}",
                generation
            );
            apply_desktop_operation_visibility(app_handle);
        } else {
            warn!(
                "[peekaboo-visibility] visibility already active, skipped apply for generation={}",
                generation
            );
        }

        Some(Self {
            app_handle: app_handle.clone(),
            generation,
        })
    }
}

impl Drop for DesktopOperationVisibilityGuard {
    fn drop(&mut self) {
        let should_schedule_restore = {
            let mut state = desktop_operation_visibility_state()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if state.active_count > 0 {
                state.active_count -= 1;
            }
            let should_schedule = state.active_count == 0 && state.generation == self.generation;
            warn!(
                "[peekaboo-visibility] guard dropped generation={}, active_count={}, state_generation={}, should_schedule_restore={}",
                self.generation,
                state.active_count,
                state.generation,
                should_schedule
            );
            should_schedule
        };

        if !should_schedule_restore {
            return;
        }

        let app_handle = self.app_handle.clone();
        let generation = self.generation;
        std::thread::spawn(move || {
            std::thread::sleep(DESKTOP_OPERATION_IDLE_RESTORE);
            restore_desktop_operation_visibility_if_idle(&app_handle, generation);
        });
    }
}

pub fn show_desktop_operation_visibility_test(
    app_handle: &tauri::AppHandle,
    monitor_index: Option<usize>,
) {
    warn!(
        "[peekaboo-visibility] desktop-control visibility test requested monitor_index={:?}",
        monitor_index
    );
    drop(DesktopOperationVisibilityGuard::for_visibility_test(
        app_handle,
        monitor_index,
    ));
    warn!("[peekaboo-visibility] desktop-control visibility test guard released");
}

fn desktop_operation_visibility_state() -> &'static Mutex<DesktopOperationVisibilityState> {
    DESKTOP_OPERATION_VISIBILITY_STATE
        .get_or_init(|| Mutex::new(DesktopOperationVisibilityState::default()))
}

fn apply_desktop_operation_visibility(app_handle: &tauri::AppHandle) {
    let (hide_main_window, monitor_index) = {
        let state = desktop_operation_visibility_state()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        (state.hide_main_window, state.monitor_index)
    };

    warn!(
        "[peekaboo-visibility] apply start hide_main_window={}, monitor_index={:?}",
        hide_main_window, monitor_index
    );

    if hide_main_window {
        if let Some(window) = app_handle.get_webview_window("main") {
            match window.hide() {
                Ok(()) => warn!("[peekaboo-visibility] main window hidden"),
                Err(err) => warn!("[peekaboo-visibility] failed to hide main window: {}", err),
            }
        } else {
            warn!("[peekaboo-visibility] main window not found for hide");
        }
    }
    warn!(
        "[peekaboo-visibility] opening Wingman desktop-control bar monitor_index={:?}",
        monitor_index
    );
    crate::session::wingman::open_wingman_bar(
        app_handle,
        "desktop-control",
        "Agent is controlling your desktop",
        monitor_index,
    );
    warn!("[peekaboo-visibility] apply complete");
    #[cfg(all(target_os = "macos", feature = "wingman-bar-native"))]
    crate::session::wingman::wingman_bar_native::set_tool_indicator(1);
}

pub fn restore_desktop_operation_visibility_now(app_handle: &tauri::AppHandle) {
    let snapshot = {
        let mut state = desktop_operation_visibility_state()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !state.lease_active {
            warn!("[peekaboo-visibility] immediate restore skipped: no active lease");
            return;
        }
        warn!(
            "[peekaboo-visibility] immediate restore requested generation={}, active_count={}",
            state.generation, state.active_count
        );
        state.active_count = 0;
        state.generation = state.generation.wrapping_add(1);
        take_visibility_snapshot(&mut state)
    };
    restore_desktop_operation_visibility_snapshot(app_handle, snapshot);
}

fn restore_desktop_operation_visibility_if_idle(app_handle: &tauri::AppHandle, generation: u64) {
    let snapshot = {
        let mut state = desktop_operation_visibility_state()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.active_count != 0 || state.generation != generation {
            warn!(
                "[peekaboo-visibility] idle restore skipped requested_generation={}, state_generation={}, active_count={}",
                generation,
                state.generation,
                state.active_count
            );
            return;
        }
        warn!(
            "[peekaboo-visibility] idle restore running generation={}",
            generation
        );
        take_visibility_snapshot(&mut state)
    };
    restore_desktop_operation_visibility_snapshot(app_handle, snapshot);
}

fn take_visibility_snapshot(state: &mut DesktopOperationVisibilityState) -> (bool, bool, bool) {
    let snapshot = (
        state.hide_main_window,
        state.main_window_was_visible,
        state.wingman_bar_was_visible,
    );
    state.lease_active = false;
    state.hide_main_window = false;
    state.main_window_was_visible = false;
    state.wingman_bar_was_visible = false;
    state.monitor_index = None;
    snapshot
}

fn restore_desktop_operation_visibility_snapshot(
    app_handle: &tauri::AppHandle,
    snapshot: (bool, bool, bool),
) {
    let (hide_main_window, main_window_was_visible, wingman_bar_was_visible) = snapshot;
    warn!(
        "[peekaboo-visibility] restore snapshot hide_main_window={}, main_was_visible={}, bar_was_visible={}",
        hide_main_window,
        main_window_was_visible,
        wingman_bar_was_visible
    );
    if !wingman_bar_was_visible {
        warn!("[peekaboo-visibility] closing temporary Wingman bar");
        crate::session::wingman::close_wingman_bar(app_handle);
    }
    if hide_main_window && main_window_was_visible {
        if let Some(window) = app_handle.get_webview_window("main") {
            match window.show() {
                Ok(()) => warn!("[peekaboo-visibility] main window restored"),
                Err(err) => warn!(
                    "[peekaboo-visibility] failed to restore main window: {}",
                    err
                ),
            }
        } else {
            warn!("[peekaboo-visibility] main window not found for restore");
        }
    }
}

fn ensure_allowed_peekaboo_command(command_args: &[String]) -> Result<(), String> {
    let Some(command) = command_args.first().map(String::as_str) else {
        return Err("Peekaboo command must not be empty".to_string());
    };

    if command == "--help" || command == "-h" {
        return Ok(());
    }

    if command == "peekaboo" {
        return Err("Do not include the peekaboo executable name in command".to_string());
    }

    if ALLOWED_PEEKABOO_COMMANDS.contains(&command) {
        return Ok(());
    }

    Err(format!(
        "Unsupported Peekaboo command '{}'. Allowed commands: {}",
        command,
        ALLOWED_PEEKABOO_COMMANDS.join(", ")
    ))
}

fn has_arg(args: &[String], name: &str) -> bool {
    args.iter().any(|arg| arg == name)
}

/// Injects ORGII-managed Peekaboo arguments before the CLI is invoked.
///
/// Concerns, all skipped when the caller already supplied the flag — caller
/// intent always wins:
///
/// - **Locked local execution.** `--no-remote` is forced on every command so a
///   stray Peekaboo Bridge socket can never silently route our automation to
///   another process or machine. Not user-configurable — always on.
/// - **Anti-automation-detection** (`DesktopConfig::anti_detection`). Input
///   subcommands (`click`, `type`, …) get `--input-strategy synthFirst` so
///   Peekaboo posts real CGEvent (HID) input rather than pure Accessibility
///   actions. See `docs/agent/peekaboo-learnings/`.
/// - **Human input cadence** (`DesktopConfig::human_input_profile`). The `type`
///   subcommand gets `--profile human` for human-like keystroke timing.
/// - **Machine-stable output.** Observation subcommands (`see`, `list`, …) get
///   `--json` so the LLM receives structured, token-efficient output.
fn apply_managed_args(
    command_args: &mut Vec<String>,
    config: &crate::state::commands::desktop::DesktopConfig,
) {
    let Some(command) = command_args.first().cloned() else {
        return;
    };

    if !has_arg(command_args, "--no-remote") {
        command_args.push("--no-remote".to_string());
    }

    if INPUT_COMMANDS.contains(&command.as_str()) {
        if config.anti_detection && !has_arg(command_args, "--input-strategy") {
            command_args.push("--input-strategy".to_string());
            command_args.push(SYNTH_FIRST_STRATEGY.to_string());
        }

        if command == "type"
            && config.human_input_profile
            && !has_arg(command_args, "--profile")
            && !has_arg(command_args, "--delay")
        {
            command_args.push("--profile".to_string());
            command_args.push(HUMAN_PROFILE.to_string());
        }
    }

    if OBSERVATION_COMMANDS.contains(&command.as_str())
        && !has_arg(command_args, "--json")
        && !has_arg(command_args, "-j")
    {
        command_args.push("--json".to_string());
    }
}

/// Selects the wall-clock timeout for a Peekaboo command. `sleep` blocks for a
/// caller-specified duration, so it gets a much larger ceiling than the generic
/// command timeout.
fn command_timeout(command_args: &[String]) -> Duration {
    match command_args.first().map(String::as_str) {
        Some(SLEEP_COMMAND) => PEEKABOO_SLEEP_TIMEOUT,
        _ => PEEKABOO_COMMAND_TIMEOUT,
    }
}

/// Sends `SIGKILL` to the process group led by `pid`. The child was spawned
/// with `process_group(0)`, so its PID is also its PGID; killing the negative
/// PID reaps the leader and every helper process it forked.
#[cfg(unix)]
fn kill_process_group(pid: u32) {
    // SAFETY: `libc::kill` is an FFI call with no Rust-side invariants; a stale
    // PID simply yields `ESRCH`, which is harmless.
    unsafe {
        libc::kill(-(pid as libc::pid_t), libc::SIGKILL);
    }
}

async fn run_peekaboo_cli_command(
    executable: &Path,
    command_args: &[String],
) -> Result<PeekabooCliOutput, String> {
    let mut command = Command::new(executable);
    command
        .args(command_args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    // Run Peekaboo as the leader of its own process group so a timeout can
    // terminate the whole tree. `kill_on_drop` only reaps the direct child;
    // Peekaboo may fork helper processes (bridge, daemon) that would otherwise
    // be orphaned.
    #[cfg(unix)]
    command.process_group(0);

    let child = command
        .spawn()
        .map_err(|err| format!("Failed to run bundled Peekaboo CLI: {}", err))?;
    #[cfg(unix)]
    let child_pid = child.id();

    let timeout = command_timeout(command_args);
    let output = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(result) => {
            result.map_err(|err| format!("Failed to run bundled Peekaboo CLI: {}", err))?
        }
        Err(_) => {
            // `wait_with_output` was cancelled by the timeout; the dropped
            // `Child` future kills the direct child via `kill_on_drop`. Also
            // signal the whole process group to reap any forked helpers.
            #[cfg(unix)]
            if let Some(pid) = child_pid {
                kill_process_group(pid);
            }
            return Err(format!(
                "Peekaboo CLI timed out after {} seconds",
                timeout.as_secs()
            ));
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    if !output.status.success() {
        return Err(format!(
            "Peekaboo CLI exited with {}: {}{}{}",
            output.status,
            stderr,
            if stderr.is_empty() || stdout.is_empty() {
                ""
            } else {
                "\n"
            },
            stdout
        ));
    }

    Ok(PeekabooCliOutput {
        status: output.status.code(),
        stdout,
        stderr,
    })
}

async fn resolve_or_install_peekaboo_executable() -> Result<PathBuf, String> {
    match resolve_peekaboo_executable() {
        Ok(path) => Ok(path),
        Err(missing_error) => {
            install_peekaboo_sidecar().await?;
            resolve_peekaboo_executable().map_err(|err| {
                format!(
                    "Peekaboo was installed but could not be resolved: {err}. Original error: {missing_error}"
                )
            })
        }
    }
}

fn resolve_peekaboo_executable() -> Result<PathBuf, String> {
    let downloaded_path = app_paths::sidecar_bin_dir().join("peekaboo");
    if is_real_sidecar_file(&downloaded_path) {
        return Ok(downloaded_path);
    }

    // Development path: src-tauri/bin/peekaboo
    let dev_path = dev_peekaboo_path(env!("CARGO_MANIFEST_DIR"));
    if is_real_sidecar_file(&dev_path) {
        return Ok(dev_path);
    }

    Err(format!(
        "Peekaboo CLI not found. Install manually to '{}'. Checked: '{}', '{}'.",
        downloaded_path.display(),
        downloaded_path.display(),
        dev_path.display(),
    ))
}

fn is_real_sidecar_file(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    match fs::read_to_string(path) {
        Ok(content) => !content.starts_with(OPTIONAL_SIDECAR_PLACEHOLDER_MARKER),
        Err(_) => true,
    }
}

fn dev_peekaboo_path(agent_core_manifest_dir: &str) -> PathBuf {
    let manifest_dir = Path::new(agent_core_manifest_dir);
    let src_tauri_dir = manifest_dir
        .parent()
        .and_then(Path::parent)
        .unwrap_or(manifest_dir);
    src_tauri_dir.join("bin").join("peekaboo")
}

async fn install_peekaboo_sidecar() -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err("Peekaboo sidecar is only supported on macOS".to_string());
    }

    let bin_dir = app_paths::sidecar_bin_dir();
    tokio::fs::create_dir_all(&bin_dir)
        .await
        .map_err(|err| format!("failed to create sidecar bin dir: {err}"))?;

    let dest = bin_dir.join("peekaboo");
    let dest_aarch64 = bin_dir.join("peekaboo-aarch64-apple-darwin");
    let dest_x86 = bin_dir.join("peekaboo-x86_64-apple-darwin");

    if is_real_sidecar_file(&dest) && is_real_sidecar_file(&dest_aarch64) {
        return Ok(());
    }

    let client = reqwest::Client::builder()
        .user_agent("orgii-peekaboo-lazy-install/1.0")
        .timeout(Duration::from_secs(600))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|err| format!("failed to build HTTP client: {err}"))?;
    let url = format!(
        "https://github.com/steipete/peekaboo/releases/download/{PEEKABOO_VERSION}/peekaboo-macos-universal.tar.gz"
    );

    let tmp_dir = temp_dir_in(&bin_dir, "peekaboo")?;
    let archive = tmp_dir.join("peekaboo-macos-universal.tar.gz");
    download_to(&client, &url, &archive).await?;
    run_tar_extract(&archive, &tmp_dir)?;

    let binary = find_file_named(&tmp_dir, "peekaboo")
        .ok_or_else(|| "peekaboo binary not found in archive".to_string())?;
    let bytes = tokio::fs::read(&binary)
        .await
        .map_err(|err| format!("read extracted peekaboo: {err}"))?;

    for dest_path in [&dest, &dest_aarch64, &dest_x86] {
        tokio::fs::write(dest_path, &bytes)
            .await
            .map_err(|err| format!("write {}: {err}", dest_path.display()))?;
        set_executable(dest_path)?;
    }

    tokio::fs::write(
        bin_dir.join("peekaboo-VERSION"),
        format!("{PEEKABOO_VERSION}\n"),
    )
    .await
    .map_err(|err| format!("write peekaboo-VERSION: {err}"))?;

    let _ = tokio::fs::remove_dir_all(&tmp_dir).await;
    Ok(())
}

async fn download_to(client: &reqwest::Client, url: &str, dest: &Path) -> Result<(), String> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|err| format!("GET {url}: {err}"))?
        .error_for_status()
        .map_err(|err| format!("GET {url} HTTP error: {err}"))?;

    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|err| format!("create {}: {err}", dest.display()))?;
    use futures_util::StreamExt;
    let mut stream = response.bytes_stream();
    loop {
        match tokio::time::timeout(PEEKABOO_STALL_TIMEOUT, stream.next()).await {
            Ok(Some(Ok(chunk))) => {
                file.write_all(&chunk)
                    .await
                    .map_err(|err| format!("write {}: {err}", dest.display()))?;
            }
            Ok(Some(Err(err))) => return Err(format!("reading body {url}: {err}")),
            Ok(None) => break,
            Err(_) => {
                return Err(format!(
                    "download stalled (no data for {}s): {url}",
                    PEEKABOO_STALL_TIMEOUT.as_secs()
                ));
            }
        }
    }
    file.flush()
        .await
        .map_err(|err| format!("flush {}: {err}", dest.display()))?;
    Ok(())
}

fn temp_dir_in(parent: &Path, prefix: &str) -> Result<PathBuf, String> {
    let tmp = parent.join(format!(".tmp-{prefix}-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).map_err(|err| format!("mkdir tmp {}: {err}", tmp.display()))?;
    Ok(tmp)
}

fn find_file_named(dir: &Path, name: &str) -> Option<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return None;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_file_named(&path, name) {
                return Some(found);
            }
        } else if path.file_name().and_then(|file_name| file_name.to_str()) == Some(name) {
            return Some(path);
        }
    }
    None
}

fn run_tar_extract(archive: &Path, dest_dir: &Path) -> Result<(), String> {
    let mut command = std::process::Command::new("tar");
    command.arg("-xzf").arg(archive).arg("-C").arg(dest_dir);
    app_platform::hide_console(&mut command);
    let status = command
        .status()
        .map_err(|err| format!("tar failed to start: {err}"))?;

    if !status.success() {
        return Err(format!(
            "tar -xzf {} -C {} exited with {}",
            archive.display(),
            dest_dir.display(),
            status
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn set_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    let meta = fs::metadata(path).map_err(|err| format!("metadata {}: {err}", path.display()))?;
    let mut permissions = meta.permissions();
    permissions.set_mode(permissions.mode() | 0o755);
    fs::set_permissions(path, permissions)
        .map_err(|err| format!("chmod {}: {err}", path.display()))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_executable(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn format_peekaboo_output(output: &PeekabooCliOutput) -> String {
    let mut parts = vec![format!(
        "Peekaboo CLI completed with status {}.",
        output
            .status
            .map(|status| status.to_string())
            .unwrap_or_else(|| "unknown".to_string())
    )];

    if !output.stdout.is_empty() {
        parts.push(format!("stdout:\n{}", output.stdout));
    }

    if !output.stderr.is_empty() {
        parts.push(format!("stderr:\n{}", output.stderr));
    }

    parts.join("\n\n")
}

#[cfg(test)]
#[path = "peekaboo_cli_tool_tests.rs"]
mod tests;

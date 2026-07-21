//! Centralized data directory resolution for the ORGII app.
//!
//! Every module that needs a filesystem path under `~/.orgii/` should call
//! helpers from this crate instead of computing paths inline. This guarantees
//! a single fallback strategy, makes disk-usage tracking trivial, and lets
//! tests redirect everything via the `ORGII_HOME` env var.
//!
//! This crate is the leaf-most behavior crate in the workspace: it is allowed
//! to do filesystem and process work (e.g. `set_sensitive_file_permissions`)
//! but takes no domain dependencies. Every other crate may depend on it.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

/// User home directory with a deterministic fallback to the system temp dir.
pub fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(std::env::temp_dir)
}

/// User-home root scanned for histories created by external agent apps.
///
/// Production falls back to the real user home. Multi-instance development
/// launchers may set `ORGII_EXTERNAL_HISTORY_HOME` so a secondary profile
/// does not discover and publish the primary profile's external histories
/// under a different cloud identity.
pub fn external_history_home_dir() -> PathBuf {
    std::env::var_os("ORGII_EXTERNAL_HISTORY_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(home_dir)
}

/// Application data root: `~/.orgii/`.
///
/// Test override: setting `ORGII_HOME` redirects every path under the data
/// root to that directory. Production code must never set it.
///
/// Fallback: `$TMPDIR/.orgii/` (only reached if `dirs::home_dir()` fails).
pub fn orgii_root() -> PathBuf {
    if let Ok(override_path) = std::env::var("ORGII_HOME") {
        return PathBuf::from(override_path);
    }
    home_dir().join(".orgii")
}

/// Provider keys file: `~/.orgii/credentials.json`.
///
/// Filename retained from the legacy Python implementation; the user-facing
/// terminology in code and UI is "key", not "credential".
pub fn keys() -> PathBuf {
    orgii_root().join("credentials.json")
}

/// Local MITM proxy directory: `~/.orgii/proxy/`.
///
/// Holds the root CA certificate (`ca.pem` + `ca-key.pem`) generated and
/// consumed by `integrations::proxy::certificate_authority`. Callers create
/// the directory on demand.
pub fn proxy_dir() -> PathBuf {
    orgii_root().join("proxy")
}

/// Main SQLite database file: `~/.orgii/sessions.db`.
///
/// Hosts session events, CLI agent state, inbox, dev records, lineage,
/// orchestrator state, plan approvals, and the agent-core unified session
/// layer. The `database` workspace crate resolves this path on every
/// `get_connection()` call, so leaf crates that need to open the file (e.g.
/// the test harness) can call this helper directly without re-deriving the
/// join.
pub fn sessions_db() -> PathBuf {
    orgii_root().join("sessions.db")
}

/// Durable append-only shell replay artifacts: `~/.orgii/shell-replays/`.
///
/// Kept under the same `ORGII_HOME`-aware root as `sessions.db` so desktop,
/// headless/API execution, range reads, tests, and session deletion always
/// resolve the identical lifecycle-owned directory.
pub fn shell_replays_dir() -> PathBuf {
    orgii_root().join("shell-replays")
}

/// Privacy-filtered session-provenance hook inbox:
/// `~/.orgii/session-provenance/inbox/`.
///
/// External agent hooks write small, versioned envelopes here instead of
/// opening `sessions.db` directly. The desktop process drains the inbox and
/// owns all canonical SQLite writes.
pub fn session_provenance_inbox_dir() -> PathBuf {
    orgii_root().join("session-provenance").join("inbox")
}

/// Live agent-status loopback endpoint descriptor:
/// `~/.orgii/session-provenance/status-endpoint.json`.
///
/// Written atomically by the desktop each launch (`{version, port, token,
/// pid, startedAt}`), re-read by every hook subprocess invocation so CLI
/// sessions that outlive an Orgii restart reach the new server/token. Never
/// deleted on shutdown — a dead server just refuses the TCP connect.
pub fn agent_status_endpoint_path() -> PathBuf {
    orgii_root()
        .join("session-provenance")
        .join("status-endpoint.json")
}

/// Live agent-status last-status cache:
/// `~/.orgii/session-provenance/last-status.json`.
///
/// Debounced snapshot of the in-memory live-status map, hydrated on startup
/// (TTL-filtered) for UI continuity across restarts. Owner-only permissions;
/// never mirrored into `sessions.db`.
pub fn agent_status_cache_path() -> PathBuf {
    orgii_root()
        .join("session-provenance")
        .join("last-status.json")
}

/// Project & work-item SQLite database: `~/.orgii/projects/projects.db`.
///
/// Kept separate from `sessions_db` so cross-device sync and manual
/// export/import treat the project store as a self-contained file. The
/// parent directory must be created on demand by callers (the path itself
/// is just a `join`).
pub fn projects_db() -> PathBuf {
    orgii_root().join("projects").join("projects.db")
}

/// User settings JSONC file: `~/.orgii/settings.jsonc`.
///
/// VS-Code-style: a single human-editable JSONC file the user (or an agent)
/// can edit directly. The `settings` workspace crate watches this path for
/// external modifications.
pub fn settings() -> PathBuf {
    orgii_root().join("settings.jsonc")
}

/// Settings JSON-Schema file: `~/.orgii/settings-schema.json`.
///
/// Generated by the `settings` crate; consumed by the IDE and the frontend's
/// settings editor for autocomplete / validation.
pub fn settings_schema() -> PathBuf {
    orgii_root().join("settings-schema.json")
}

/// Screenshot capture directory: `~/.orgii/screenshots/`.
///
/// `shared_state::ScreenshotStore` writes captures here; both `agent_core`
/// and `browser` enumerate the directory at runtime. Callers create the dir
/// on demand.
pub fn screenshots_dir() -> PathBuf {
    orgii_root().join("screenshots")
}

/// LSP server discovery cache: `~/.orgii/lsp_cache.json`.
///
/// Read by the `lsp` crate's command layer, written by its install pipeline.
pub fn lsp_cache() -> PathBuf {
    orgii_root().join("lsp_cache.json")
}

/// Lint tool discovery cache: `~/.orgii/lint_cache.json`.
pub fn lint_cache() -> PathBuf {
    orgii_root().join("lint_cache.json")
}

/// Provider protocol capability cache: `~/.orgii/provider-capabilities.json`.
pub fn provider_capabilities_cache() -> PathBuf {
    orgii_root().join("provider-capabilities.json")
}

/// Usage diagnostics directory: `~/.orgii/diagnostics/`.
pub fn diagnostics_dir() -> PathBuf {
    orgii_root().join("diagnostics")
}

/// LSP server binaries installed by auto-install: `~/.orgii/lsp-bin/`.
pub fn lsp_bin_dir() -> PathBuf {
    orgii_root().join("lsp-bin")
}

/// Sidecar binaries downloaded at runtime: `~/.orgii/bin/`.
///
/// Peekaboo, agent-browser, and bundled git live here after the first-run
/// download so they are never bundled in the notarized `.app` bundle.
pub fn sidecar_bin_dir() -> PathBuf {
    orgii_root().join("bin")
}

/// Global LSP configuration: `~/.orgii/lsp.json`.
pub fn lsp_config() -> PathBuf {
    orgii_root().join("lsp.json")
}

/// System-dependency probe cache: `~/.orgii/dependencies.json`.
///
/// Written by `infrastructure::platform::dependencies::detect_system_dependencies`.
/// Read by leaf crates (e.g. `lsp`) that need to gate features on optional
/// runtime tools without re-scanning. Exposing the path here lets those
/// crates read the cache file without depending on the platform module.
pub fn dependencies_cache() -> PathBuf {
    orgii_root().join("dependencies.json")
}

/// Delete the dependency probe cache so the next call to
/// `detect_system_dependencies` rescans from scratch.
///
/// Call this once at startup after `augment_path_from_shell()` so that a
/// stale cache written under the old (stripped) PATH is not served back to
/// the frontend as if it were still valid.
pub fn clear_dependencies_cache() {
    let path = dependencies_cache();
    if path.exists() {
        if let Err(err) = std::fs::remove_file(&path) {
            tracing::warn!(
                path = %path.display(),
                error = %err,
                "[app_paths] could not clear dependency cache; stale probe results may persist"
            );
        }
    }
}

/// Per-repo Merkle snapshots root: `~/.orgii/merkle/`.
///
/// Read/written by the `search` crate's merkle workspace cache. Hoisted
/// here so the crate doesn't depend back into the `app` crate.
pub fn merkle_root() -> PathBuf {
    orgii_root().join("merkle")
}

/// Local embedding/model downloads: `~/.orgii/models/`.
pub fn models_dir() -> PathBuf {
    orgii_root().join("models")
}

/// Semantic-search USearch index: `~/.orgii/semantic_index/`.
pub fn semantic_index_dir() -> PathBuf {
    orgii_root().join("semantic_index")
}

/// Plugin package root: `~/.orgii/extensions/`.
///
/// The directory name is retained on disk because plugin packages were stored
/// there before the VS Code extension host was archived.
pub fn extensions_dir() -> PathBuf {
    orgii_root().join("extensions")
}

/// Plugin secret storage: `~/.orgii/extension_secrets.json`.
pub fn extension_secrets() -> PathBuf {
    orgii_root().join("extension_secrets.json")
}

// ============================================
// OS Agent ("personal") path family
// ============================================
//
// Hoisted here so `crates/agent-core` can resolve them without depending
// back into the `app` crate. Originally extracted as PR 1 of the
// agent_core extraction.

/// OS Agent ("personal") root: `~/.orgii/personal/`.
///
/// Single source of truth for the OS Agent. Everything that belongs to
/// the OS Agent — its automations, rules, skills, workspace — lives
/// under this directory. SDE / workspace-scoped sessions never read or write
/// here.
pub fn personal_root() -> PathBuf {
    orgii_root().join("personal")
}

/// OS Agent default workspace: `~/.orgii/personal/workspace/`.
///
/// Working directory where the OS Agent reads/writes files. Channel
/// sessions (telegram/feishu/wecom/...) default to this directory when
/// no workspace is attached.
pub fn personal_workspace() -> PathBuf {
    personal_root().join("workspace")
}

/// OS Agent automation rules: `~/.orgii/personal/automations.json`.
pub fn personal_automations() -> PathBuf {
    personal_root().join("automations.json")
}

/// OS Agent rules directory: `~/.orgii/personal/rules/`.
///
/// Markdown policy files that apply only to the OS Agent — never loaded
/// for workspace-scoped SDE sessions.
pub fn personal_rules_dir() -> PathBuf {
    personal_root().join("rules")
}

/// OS Agent rules config: `~/.orgii/personal/rules-config.json`.
pub fn personal_rules_config() -> PathBuf {
    personal_root().join("rules-config.json")
}

/// Custom agent definitions (global, not OS-Agent-scoped):
/// `~/.orgii/agent-definitions.json`.
///
/// Used by SDE, OS Agent, and any custom agent — intentionally outside
/// `personal/` because it is not OS-Agent-specific.
pub fn agent_definitions() -> PathBuf {
    orgii_root().join("agent-definitions.json")
}

/// Agent organizations (global): `~/.orgii/agent-orgs.json`.
pub fn agent_orgs() -> PathBuf {
    orgii_root().join("agent-orgs.json")
}

/// Builtin-agent overrides overlay: `~/.orgii/builtin-overrides.json`.
///
/// User-writable overlay for `builtin:*` agent definitions. Loaded on
/// top of the compiled-in builtin at runtime so users can re-pin
/// models, tweak tool lists, and adjust policies without forking the
/// Rust source. Storage contract §12 "Conflict C".
pub fn builtin_overrides() -> PathBuf {
    orgii_root().join("builtin-overrides.json")
}

/// Integrations config (Telegram/Discord/Feishu/...): `~/.orgii/integrations.json`.
pub fn integrations() -> PathBuf {
    orgii_root().join("integrations.json")
}

/// Root of the per-session file history archive: `~/.orgii/file-history/`.
pub fn file_history_root() -> PathBuf {
    orgii_root().join("file-history")
}

/// Per-session file history dir: `~/.orgii/file-history/<session_id>/`.
pub fn file_history_dir(session_id: &str) -> PathBuf {
    file_history_root().join(session_id)
}

// Git for Windows can take longer than 750 ms to cold-start while Defender or
// a concurrent build is busy. Treating that transient delay as "Git missing"
// blocks every repo-backed flow even though the executable is installed and
// the real operation would have succeeded. Probe generously once, then reuse
// the successful path for the lifetime of the process.
#[cfg(windows)]
const SYSTEM_GIT_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(not(windows))]
const SYSTEM_GIT_PROBE_TIMEOUT: Duration = Duration::from_millis(750);

static RESOLVED_SYSTEM_GIT: OnceLock<PathBuf> = OnceLock::new();

pub fn system_git_executable() -> Option<PathBuf> {
    if let Some(path) = RESOLVED_SYSTEM_GIT.get() {
        return Some(path.clone());
    }

    let resolved = system_git_candidate_paths()
        .into_iter()
        .find(|path| git_version_succeeds(path));
    if let Some(path) = resolved.as_ref() {
        let _ = RESOLVED_SYSTEM_GIT.set(path.clone());
    }
    resolved
}

pub fn system_git_candidate_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();

    #[cfg(target_os = "macos")]
    {
        paths.push(PathBuf::from("/opt/homebrew/bin/git"));
        paths.push(PathBuf::from("/usr/local/bin/git"));
    }

    if let Ok(path_value) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_value) {
            paths.push(dir.join(git_binary_name()));
        }
    }

    #[cfg(windows)]
    {
        let program_files_roots = ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"]
            .into_iter()
            .filter_map(std::env::var_os)
            .map(PathBuf::from)
            .collect::<Vec<_>>();
        let local_app_data = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
        paths.extend(windows_git_candidate_paths(
            &program_files_roots,
            local_app_data.as_deref(),
        ));
    }

    #[cfg(target_os = "macos")]
    {
        paths.push(PathBuf::from("/usr/bin/git"));
    }

    dedupe_paths(paths)
}

#[cfg(windows)]
fn windows_git_candidate_paths(
    program_files_roots: &[PathBuf],
    local_app_data: Option<&Path>,
) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for root in program_files_roots {
        paths.push(root.join("Git").join("cmd").join("git.exe"));
        paths.push(root.join("Git").join("bin").join("git.exe"));
    }
    if let Some(root) = local_app_data {
        let git_root = root.join("Programs").join("Git");
        paths.push(git_root.join("cmd").join("git.exe"));
        paths.push(git_root.join("bin").join("git.exe"));
    }
    paths
}

fn git_binary_name() -> &'static str {
    if cfg!(windows) {
        "git.exe"
    } else {
        "git"
    }
}

/// Augment the process `$PATH` with the user's full interactive login-shell PATH.
///
/// macOS `.app` bundles launched from the Dock or Finder start with a
/// stripped PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), so `which npm`,
/// `which claude`, etc. fail even when those tools are installed via
/// Homebrew (`/opt/homebrew/bin`) or nvm/fnm (`~/.nvm/...`).
///
/// Strategy: try shells in order, most complete first.
///   1. `$SHELL -i -l -c 'echo $PATH'` — interactive login: sources both
///      `~/.zprofile` (or `~/.bash_profile`) AND `~/.zshrc` (or `~/.bashrc`),
///      which is where nvm/fnm/conda inject themselves.
///   2. `$SHELL -l -c 'echo $PATH'` — non-interactive login: fallback if
///      the interactive run fails (some shells refuse `-i` without a tty).
///
/// The `-i` flag is what makes nvm visible: nvm hooks itself into the shell
/// via `~/.zshrc`, which is only sourced for interactive shells, not for
/// plain `zsh -l` (login-but-non-interactive).
///
/// Safe to call multiple times (idempotent). On Windows it's a no-op.
/// Call once at app startup before any binary-detection probes run.
pub fn augment_path_from_shell() {
    #[cfg(unix)]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());

        // Try interactive login first (picks up nvm via ~/.zshrc), then
        // plain login as fallback. Each probe is wrapped in a timeout so a
        // misbehaving rc file (one that blocks on a prompt / network call)
        // can't hang app startup forever.
        let shell_path_str = [
            vec!["-i", "-l", "-c", "echo $PATH"],
            vec!["-l", "-c", "echo $PATH"],
        ]
        .iter()
        .find_map(|args| run_shell_path_probe(&shell, args));

        if shell_path_str.is_none() {
            tracing::warn!(
                "[app_paths] shell PATH probe failed for {:?}; falling back to well-known dirs only",
                shell
            );
        }

        let current_path = std::env::var("PATH").unwrap_or_default();
        let current_dirs: HashSet<String> =
            current_path.split(':').map(|s| s.to_string()).collect();

        // Candidate dirs from the shell probe (if any) plus well-known install
        // locations that login-shell PATH frequently misses (homebrew, pipx,
        // uv, cargo, ~/.local/bin). Only dirs that actually exist are added.
        let mut candidate_dirs: Vec<String> = Vec::new();
        if let Some(shell_path) = shell_path_str.as_deref() {
            for dir in shell_path.split(':') {
                if !dir.is_empty() {
                    candidate_dirs.push(dir.to_string());
                }
            }
        }
        for dir in well_known_bin_dirs() {
            candidate_dirs.push(dir);
        }

        let mut seen: HashSet<String> = HashSet::new();
        let new_dirs: Vec<String> = candidate_dirs
            .into_iter()
            .filter(|dir| {
                !dir.is_empty()
                    && !current_dirs.contains(dir)
                    && seen.insert(dir.clone())
                    // Well-known dirs are only appended when present; shell dirs
                    // are trusted as-is (the shell already resolved them).
                    && Path::new(dir).is_dir()
            })
            .collect();

        if new_dirs.is_empty() {
            return;
        }

        let augmented = if current_path.is_empty() {
            new_dirs.join(":")
        } else {
            format!("{}:{}", new_dirs.join(":"), current_path)
        };

        std::env::set_var("PATH", &augmented);
        tracing::info!(
            "[app_paths] augmented PATH with {} new dirs: {:?}",
            new_dirs.len(),
            new_dirs,
        );
    }
}

/// Run a single `$SHELL <args>` PATH probe with a hard timeout so a blocking
/// rc file cannot wedge startup. Returns the trimmed `$PATH` on success.
#[cfg(unix)]
fn run_shell_path_probe(shell: &str, args: &[&str]) -> Option<String> {
    use std::sync::mpsc;

    let (tx, rx) = mpsc::channel();
    let shell = shell.to_string();
    let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    std::thread::spawn(move || {
        let output = Command::new(&shell)
            .args(&args)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output();
        let _ = tx.send(output);
    });

    let output = match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(output)) => output,
        _ => return None,
    };

    if !output.status.success() {
        return None;
    }

    let raw = String::from_utf8(output.stdout).ok()?;
    let trimmed = raw.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

/// Well-known executable directories that login-shell PATH probes commonly
/// miss (tool installers that hook only interactive rc files, or that install
/// outside the standard login PATH). Caller filters to those that exist.
#[cfg(unix)]
fn well_known_bin_dirs() -> Vec<String> {
    let mut dirs = vec![
        "/opt/homebrew/bin".to_string(),
        "/opt/homebrew/sbin".to_string(),
        "/usr/local/bin".to_string(),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        for sub in [".local/bin", ".cargo/bin", ".local/share/uv/tools/bin"] {
            if let Some(p) = home.join(sub).to_str() {
                dirs.push(p.to_string());
            }
        }
    }
    dirs
}

fn dedupe_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    paths
        .into_iter()
        .filter(|path| seen.insert(path.clone()))
        .collect()
}

fn git_version_succeeds(path: &Path) -> bool {
    if !is_executable_file(path) {
        return false;
    }

    let mut command = Command::new(path);
    command
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // Suppress console window on Windows.
    app_platform::hide_console(&mut command);
    let Ok(mut child) = command.spawn() else {
        return false;
    };

    let started_at = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if started_at.elapsed() >= SYSTEM_GIT_PROBE_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

fn is_executable_file(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }

    #[cfg(unix)]
    {
        std::fs::metadata(path)
            .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }

    #[cfg(not(unix))]
    {
        true
    }
}

/// Global project sync connection account store: `~/.orgii/sync_connections.json`.
pub fn sync_connections() -> PathBuf {
    orgii_root().join("sync_connections.json")
}

/// Global project sync connection token store: `~/.orgii/sync_connection_tokens.json`.
pub fn sync_connection_tokens() -> PathBuf {
    orgii_root().join("sync_connection_tokens.json")
}

/// Sync metrics log (rolling): `~/.orgii/sync-metrics.jsonl`.
pub fn sync_metrics_log() -> PathBuf {
    orgii_root().join("sync-metrics.jsonl")
}

/// Sync metrics log backup (rotated): `~/.orgii/sync-metrics.jsonl.1`.
pub fn sync_metrics_log_backup() -> PathBuf {
    orgii_root().join("sync-metrics.jsonl.1")
}

/// Global rules config: `~/.orgii/rules-config.json`.
pub fn global_policies_config() -> PathBuf {
    orgii_root().join("rules-config.json")
}

/// Workspace rules config: `{workspace}/.orgii/rules-config.json`.
pub fn workspace_policies_config(workspace_path: &Path) -> PathBuf {
    workspace_path.join(".orgii").join("rules-config.json")
}

/// MCP servers config (global): `~/.orgii/mcp-servers.json`.
pub fn mcp_servers_config() -> PathBuf {
    orgii_root().join("mcp-servers.json")
}

/// MCP servers config (workspace-level): `{workspace}/.orgii/mcp-servers.json`.
pub fn workspace_mcp_servers_config(workspace_path: &Path) -> PathBuf {
    workspace_path.join(".orgii").join("mcp-servers.json")
}

/// Global skills directory: `~/.orgii/skills/`.
pub fn global_skills_dir() -> PathBuf {
    orgii_root().join("skills")
}

/// File-based session registry root: `~/.orgii/sessions/`.
///
/// Crash-resilient per-session metadata files. Read/written by
/// `agent_core::core::session::file_registry`.
pub fn session_registry_dir() -> PathBuf {
    orgii_root().join("sessions")
}

/// Per-session metadata file: `~/.orgii/sessions/<session_id>.json`.
pub fn session_registry_file(session_id: &str) -> PathBuf {
    session_registry_dir().join(format!("{}.json", session_id))
}

/// Chat image attachments: `~/.orgii/session-images/`.
///
/// Files are named by content hash for automatic deduplication.
pub fn session_images_dir() -> PathBuf {
    orgii_root().join("session-images")
}

/// Per-session scratchpad: `/tmp/orgii-{uid}/{sanitized-workspace}/{session_id}/scratchpad/`.
///
/// Lives under the system temp dir with three-level isolation:
/// UID → workspace → session. On macOS `/tmp` symlinks to `/private/tmp`;
/// the base is canonicalized to avoid permission-check mismatches.
///
/// Returns the directory path on success. Creates with mode `0o700` on
/// Unix (owner-only) to prevent other users from reading/writing agent
/// temp files.
pub fn ensure_scratchpad(session_id: &str, workspace_path: &Path) -> std::io::Result<PathBuf> {
    let dir = scratchpad_dir(session_id, workspace_path);
    std::fs::create_dir_all(&dir)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let user_root = orgii_temp_root();
        if user_root.exists() {
            let _ = std::fs::set_permissions(&user_root, std::fs::Permissions::from_mode(0o700));
        }
    }

    Ok(dir)
}

/// Base temp dir for ORGII, per-user isolated.
///
/// Unix: `/tmp/orgii-{uid}/`  (resolves symlinks, e.g.
/// `/private/tmp/orgii-501/` on macOS)
/// Windows: `{TEMP}\orgii\`  (TEMP is already per-user)
pub fn orgii_temp_root() -> PathBuf {
    if let Ok(override_path) = std::env::var("ORGII_TEMP_ROOT") {
        return PathBuf::from(override_path);
    }

    let base = std::env::temp_dir();
    let resolved = std::fs::canonicalize(&base).unwrap_or(base);

    #[cfg(unix)]
    {
        let uid = unsafe { libc::getuid() };
        resolved.join(format!("orgii-{}", uid))
    }

    #[cfg(not(unix))]
    {
        resolved.join("orgii")
    }
}

/// Per-workspace temp dir: `/tmp/orgii-{uid}/{sanitized-workspace}/`.
pub fn workspace_temp_dir(workspace_path: &Path) -> PathBuf {
    orgii_temp_root().join(sanitize_workspace_path(workspace_path))
}

/// Per-session scratchpad directory (path only — does not create it).
pub fn scratchpad_dir(session_id: &str, workspace_path: &Path) -> PathBuf {
    workspace_temp_dir(workspace_path)
        .join(session_id)
        .join("scratchpad")
}

/// Best-effort cleanup: walk every workspace dir under `orgii_temp_root()`
/// looking for a directory named `session_id` and remove it. Used by
/// session deletion code that doesn't know the original workspace path
/// (e.g. `session_persistence::delete_session`).
pub fn cleanup_scratchpad_by_session_id(session_id: &str) {
    let root = orgii_temp_root();
    if !root.exists() {
        return;
    }
    let entries = match std::fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        if !entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
            continue;
        }
        let session_dir = entry.path().join(session_id);
        if session_dir.exists() {
            let _ = std::fs::remove_dir_all(&session_dir);
        }
    }
}

/// Hosted Kiro proxy HOME root: `/tmp/orgii-{uid}/kiro-proxy/`.
pub fn kiro_proxy_home_root() -> PathBuf {
    orgii_temp_root().join("kiro-proxy")
}

/// Hosted Kiro proxy HOME dir for one CLI session.
pub fn kiro_proxy_home(session_id: &str) -> PathBuf {
    kiro_proxy_home_root().join(sanitize_path_segment(session_id))
}

fn sanitize_workspace_path(workspace_path: &Path) -> String {
    let raw = workspace_path.to_string_lossy();
    sanitize_path_segment(raw.as_ref())
        .trim_start_matches('_')
        .to_string()
}

fn sanitize_path_segment(segment: &str) -> String {
    segment
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' => '_',
            '\0' => '_',
            other => other,
        })
        .collect()
}

/// Restrict a sensitive file (keys, OAuth tokens) to owner-only access.
///
/// Unix: `chmod 0o600`.
/// Windows: `icacls /inheritance:r /grant:r "<domain>\\<user>:F"` (best-effort;
/// logs a warning if `icacls` is unavailable rather than failing the parent op).
pub fn set_sensitive_file_permissions(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }

    #[cfg(windows)]
    {
        if let Some(path_str) = path.to_str() {
            if let Some(account) = current_windows_account_for_acl() {
                let mut cmd = std::process::Command::new("icacls");
                cmd.args([
                    path_str,
                    "/inheritance:r",
                    "/grant:r",
                    &format!("{}:F", account),
                ]);
                // Suppress console window on Windows.
                app_platform::hide_console(&mut cmd);
                let result = cmd.output();

                match result {
                    Ok(output) if !output.status.success() => {
                        tracing::warn!(
                            "[permissions] Failed to set permissions on {}: {}",
                            path_str,
                            String::from_utf8_lossy(&output.stderr)
                        );
                    }
                    Err(err) => {
                        tracing::warn!(
                            "[permissions] icacls not available, file {} may be world-readable: {}",
                            path_str,
                            err
                        );
                    }
                    _ => {}
                }
            }
        }
    }

    Ok(())
}

#[cfg(windows)]
fn current_windows_account_for_acl() -> Option<String> {
    let whoami = std::process::Command::new("whoami")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()
        .and_then(|output| {
            if output.status.success() {
                String::from_utf8(output.stdout)
                    .ok()
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
            } else {
                None
            }
        });
    if whoami.is_some() {
        return whoami;
    }

    let username = std::env::var("USERNAME").ok()?.trim().to_string();
    if username.is_empty() {
        return None;
    }
    if username.contains('\\') {
        return Some(username);
    }

    let domain = std::env::var("USERDOMAIN").unwrap_or_default();
    let domain = domain.trim();
    if domain.is_empty() {
        Some(username)
    } else {
        Some(format!("{}\\{}", domain, username))
    }
}

// ---------------------------------------------------------------------------
// Logs / per-session CLI homes / agent worktrees
// ---------------------------------------------------------------------------
//
// Misc `~/.orgii/` path helpers used by housekeeping, the per-session
// CLI runners (`agent_sessions::cli::session_runner`), and the worktree
// manager in the `git` crate. Owned here so leaf crates resolve them
// without any back-edge into the `app` crate.

/// Log directory: `~/.orgii/logs/`.
pub fn logs_dir() -> PathBuf {
    orgii_root().join("logs")
}

/// Per-session Cursor CLI config root: `~/.orgii/cursor-config/`.
pub fn cursor_config_root() -> PathBuf {
    orgii_root().join("cursor-config")
}

/// Per-session Cursor CLI config dir for one session.
pub fn cursor_config_dir(session_id: &str) -> PathBuf {
    cursor_config_root().join(session_id)
}

/// Account-scoped Cursor CLI profile root: `~/.orgii/cursor-cli-profiles/`.
pub fn cursor_cli_profile_root() -> PathBuf {
    orgii_root().join("cursor-cli-profiles")
}

/// Account-scoped Cursor CLI profile dir.
pub fn cursor_cli_profile_dir(account_id: &str) -> PathBuf {
    cursor_cli_profile_root().join(sanitize_path_segment(account_id))
}

/// Account-scoped Claude Code CLI config root: `~/.orgii/claude-code-cli-profiles/`.
pub fn claude_code_cli_profile_root() -> PathBuf {
    orgii_root().join("claude-code-cli-profiles")
}

/// Account-scoped Claude Code CLI config dir.
pub fn claude_code_cli_profile_dir(account_id: &str) -> PathBuf {
    claude_code_cli_profile_root().join(sanitize_path_segment(account_id))
}

/// Account-scoped Codex CLI profile root: `~/.orgii/codex-cli-profiles/`.
pub fn codex_cli_profile_root() -> PathBuf {
    orgii_root().join("codex-cli-profiles")
}

/// Account-scoped Codex CLI profile dir.
pub fn codex_cli_profile_dir(account_id: &str) -> PathBuf {
    codex_cli_profile_root().join(sanitize_path_segment(account_id))
}

/// Account-scoped Kiro CLI profile root: `~/.orgii/kiro-cli-profiles/`.
pub fn kiro_cli_profile_root() -> PathBuf {
    orgii_root().join("kiro-cli-profiles")
}

/// Account-scoped Kiro CLI HOME dir.
pub fn kiro_cli_profile_dir(account_id: &str) -> PathBuf {
    kiro_cli_profile_root().join(sanitize_path_segment(account_id))
}

/// Account-scoped OpenCode CLI profile root: `~/.orgii/opencode-cli-profiles/`.
pub fn opencode_cli_profile_root() -> PathBuf {
    orgii_root().join("opencode-cli-profiles")
}

/// Account-scoped OpenCode CLI HOME dir.
pub fn opencode_cli_profile_dir(account_id: &str) -> PathBuf {
    opencode_cli_profile_root().join(sanitize_path_segment(account_id))
}

/// CLI config manager profile root: `~/.orgii/cli-config-profiles/`.
///
/// Holds ORGII-managed backups and generated config profiles for external CLI
/// agents whose real user config may be switched between Default and
/// ORGII-managed modes.
pub fn cli_config_profiles_root() -> PathBuf {
    orgii_root().join("cli-config-profiles")
}

/// CLI config manager profile dir for one agent.
pub fn cli_config_profile_agent_dir(agent_name: &str) -> PathBuf {
    cli_config_profiles_root().join(sanitize_path_segment(agent_name))
}

/// Default/original CLI config backup dir for one agent.
pub fn cli_config_profile_default_dir(agent_name: &str) -> PathBuf {
    cli_config_profile_agent_dir(agent_name).join("default")
}

/// ORGII-generated CLI config profile dir for one agent.
pub fn cli_config_profile_orgii_dir(agent_name: &str) -> PathBuf {
    cli_config_profile_agent_dir(agent_name).join("orgii")
}

/// CLI config manager manifest path for one agent.
pub fn cli_config_profile_manifest(agent_name: &str) -> PathBuf {
    cli_config_profile_agent_dir(agent_name).join("manifest.json")
}

/// Oversized tool result spill root: `~/.orgii/tool-results/`.
pub fn tool_results_root() -> PathBuf {
    orgii_root().join("tool-results")
}

/// Oversized tool result spill dir for one session.
pub fn tool_results_dir(session_id: &str) -> PathBuf {
    tool_results_root().join(session_id)
}

/// Agent worktrees root: `~/.orgii/agent-worktrees/`.
///
/// Each session worktree lives under
/// `agent-worktrees/{repo-hash}/{session-id}/`; the `git` crate's
/// `worktree::create_session_worktree` builds those leaves on top of
/// this root.
pub fn agent_worktrees_root() -> PathBuf {
    orgii_root().join("agent-worktrees")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orgii_temp_root_contains_orgii_segment() {
        let root = orgii_temp_root();
        let root_str = root.to_string_lossy();
        assert!(
            root_str.contains("orgii"),
            "should contain 'orgii': {}",
            root_str
        );
    }

    #[test]
    fn sanitize_workspace_path_strips_slashes() {
        let sanitized = sanitize_workspace_path(Path::new("/Users/me/projects/foo"));
        assert!(!sanitized.contains('/'), "no slashes: {}", sanitized);
        assert!(
            sanitized.contains("foo"),
            "preserves dir name: {}",
            sanitized
        );
    }

    #[test]
    fn scratchpad_dir_three_level_isolation() {
        let dir = scratchpad_dir("sess-abc", Path::new("/Users/me/proj"));
        let dir_str = dir.to_string_lossy();
        assert!(dir_str.contains("orgii"), "user-isolated: {}", dir_str);
        assert!(
            dir_str.contains("sess-abc"),
            "session-isolated: {}",
            dir_str
        );
        assert!(
            dir_str.ends_with("scratchpad"),
            "ends with scratchpad: {}",
            dir_str
        );
    }

    #[test]
    fn ensure_scratchpad_creates_directory() {
        let session_id = format!("test-scratchpad-{}", std::process::id());
        let workspace = std::env::temp_dir().join("test-workspace-scratch");
        let result = ensure_scratchpad(&session_id, &workspace);
        assert!(result.is_ok());
        let dir = result.unwrap();
        assert!(dir.exists());
        assert!(dir.is_dir());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn windows_git_candidates_do_not_depend_on_inherited_path() {
        let candidates = windows_git_candidate_paths(
            &[
                PathBuf::from(r"C:\Program Files"),
                PathBuf::from(r"C:\Program Files (x86)"),
            ],
            Some(Path::new(r"C:\Users\me\AppData\Local")),
        );

        assert!(candidates.contains(&PathBuf::from(
            r"C:\Program Files\Git\cmd\git.exe"
        )));
        assert!(candidates.contains(&PathBuf::from(
            r"C:\Program Files\Git\bin\git.exe"
        )));
        assert!(candidates.contains(&PathBuf::from(
            r"C:\Users\me\AppData\Local\Programs\Git\cmd\git.exe"
        )));
    }
}

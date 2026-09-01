//! Kiro CLI ACP (Agent Client Protocol) integration.
//!
//! Thin wrapper over `acp_common` with Kiro-specific tool mapping and notifications.

use std::collections::HashMap;
use std::path::PathBuf;

use serde::Serialize;
use serde_json::Value;
use tokio::process::{ChildStdin, ChildStdout};
use tokio::sync::mpsc;

use super::acp_common::{self, AcpAgentAdapter, AcpSessionResult};
use core_types::activity::ActivityChunk;

// ============================================
// ACP mode (kiro-cli acp)
// ============================================

/// Kiro adapter — overrides tool name mapping for Kiro-specific tool names
/// and handles `_kiro.dev/*` custom notifications.
struct KiroAcpAdapter;

impl AcpAgentAdapter for KiroAcpAdapter {
    fn map_tool_kind(&self, kind: &str, raw_input: &Value) -> String {
        // Kiro sometimes sends tool name in `name` field instead of using standard ACP kinds.
        // Check raw_input for a `name` or `tool` field that overrides the kind.
        let name = raw_input
            .get("name")
            .or(raw_input.get("tool"))
            .and_then(|v| v.as_str())
            .unwrap_or("");

        // Map Kiro-specific tool names first
        match name {
            "fs_write" | "Write" => return "Edit".to_string(),
            "fs_read" | "Read" => return "Read".to_string(),
            "execute_bash" | "Bash" => return "Shell".to_string(),
            "grep" | "Grep" => return "Grep".to_string(),
            "glob" | "Glob" => return "Glob".to_string(),
            "web_search" => return "Grep".to_string(),
            "web_fetch" | "WebFetch" => return "WebFetch".to_string(),
            "TodoWrite" => return "UpdateTodos".to_string(),
            _ => {}
        }

        // Fall back to standard ACP kind mapping
        match kind {
            "execute" => "Shell",
            "read" => "Read",
            "write" | "edit" => "Edit",
            "search" => "Grep",
            "delete" => "Delete",
            "fetch" => "WebFetch",
            "other" => "Task",
            _ => kind,
        }
        .to_string()
    }

    fn handle_custom_notification(&mut self, method: &str, _params: &Value) -> Vec<ActivityChunk> {
        match method {
            "_kiro.dev/metadata" | "_kiro.dev/commands/available" => {
                // Silently consume — no chunks to emit
                vec![]
            }
            _ => vec![],
        }
    }
}

/// Run the ACP protocol with Kiro CLI.
#[allow(clippy::too_many_arguments)]
pub async fn run_acp_protocol(
    stdin: ChildStdin,
    stdout: ChildStdout,
    session_id: &str,
    task: &str,
    working_dir: &str,
    resume_session_id: Option<&str>,
    chunk_tx: mpsc::Sender<ActivityChunk>,
    image_paths: Vec<String>,
) -> Result<AcpSessionResult, String> {
    acp_common::run_acp_protocol(
        KiroAcpAdapter,
        stdin,
        stdout,
        session_id,
        task,
        working_dir,
        resume_session_id,
        chunk_tx,
        image_paths,
    )
    .await
}

// ============================================
// Proxy env var builder
// ============================================

/// Build Kiro-specific env vars for proxy mode.
///
/// The caller should also set `HOME` to the path returned by
/// `kiro::proxy_auth::setup_proxy_auth_db()` so Kiro reads the injected proxy token.
pub fn build_kiro_proxy_env(
    proxy_url: &str,
    ca_cert_path: &str,
    region: &str,
) -> HashMap<String, String> {
    let mut env = HashMap::new();
    env.insert("HTTPS_PROXY".into(), proxy_url.into());
    env.insert("https_proxy".into(), proxy_url.into());
    env.insert("SSL_CERT_FILE".into(), ca_cert_path.into());
    env.insert("KIRO_REGION".into(), region.into());
    env
}

// ============================================
// Session management (lock cleanup + listing)
// ============================================

fn kiro_sessions_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join(".kiro/sessions/cli")
}

/// Remove stale `.lock` file if the owning process is dead.
/// Call before `session/load` to prevent "session locked" errors.
pub fn clean_stale_lock(session_id: &str) {
    let lock_path = kiro_sessions_dir().join(format!("{}.lock", session_id));
    if !lock_path.exists() {
        return;
    }
    // A corrupt or unreadable lock file is meaningful here: the
    // upstream Kiro CLI session load will then fail with "session
    // locked" forever and the user has no way to recover via this
    // auto-clean path. Warn on read/parse failures (Rule 6) so the
    // cause is visible in logs while still skipping the auto-clean
    // (we won't kill processes based on a corrupt lock).
    let contents = match std::fs::read_to_string(&lock_path) {
        Ok(c) => c,
        Err(err) => {
            tracing::warn!(
                path = %lock_path.display(),
                error = %err,
                "kiro::clean_stale_lock: lock file read failed; auto-clean skipped"
            );
            return;
        }
    };
    let lock: Value = match serde_json::from_str(&contents) {
        Ok(v) => v,
        Err(err) => {
            tracing::warn!(
                path = %lock_path.display(),
                error = %err,
                "kiro::clean_stale_lock: lock JSON parse failed; auto-clean skipped"
            );
            return;
        }
    };
    let pid = lock.get("pid").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
    if pid <= 0 {
        return;
    }
    // Check if process is still alive
    #[cfg(unix)]
    let is_dead = unsafe { libc::kill(pid, 0) } != 0;
    #[cfg(windows)]
    let is_dead = {
        let mut command = std::process::Command::new("tasklist");
        command.args(["/FI", &format!("PID eq {}", pid), "/NH"]);
        // Suppress the `tasklist` console window.
        app_platform::hide_console(&mut command);
        let out = command.output();
        !out.map(|o| String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()))
            .unwrap_or(false)
    };
    if is_dead {
        let _ = std::fs::remove_file(&lock_path);
        tracing::info!(
            "[Kiro] Removed stale lock for session {} (pid {} dead)",
            session_id,
            pid
        );
    }
}

/// Metadata for a resumable Kiro session.
#[derive(Debug, Serialize)]
pub struct KiroSessionInfo {
    pub session_id: String,
    pub cwd: String,
    pub last_modified: u64, // unix timestamp
    pub is_locked: bool,
}

/// List resumable Kiro sessions from `~/.kiro/sessions/cli/*.json`.
pub fn list_kiro_sessions() -> Vec<KiroSessionInfo> {
    let dir = kiro_sessions_dir();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return vec![];
    };

    let mut sessions: Vec<KiroSessionInfo> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|ext| ext == "json"))
        .filter_map(|entry| {
            let path = entry.path();
            let session_id = path.file_stem()?.to_str()?.to_string();
            let modified = entry
                .metadata()
                .ok()?
                .modified()
                .ok()?
                .duration_since(std::time::UNIX_EPOCH)
                .ok()?
                .as_secs();

            // Try to read cwd from the session JSON. Falling back to an
            // empty cwd is intentional — a corrupt or unreadable Kiro
            // session file still needs to appear in the discovery list
            // so the user can see and clean it up — but warn so the
            // corruption is traceable instead of producing a silent
            // "(no cwd)" entry.
            let cwd = match std::fs::read_to_string(&path) {
                Ok(s) => match serde_json::from_str::<Value>(&s) {
                    Ok(v) => v
                        .get("cwd")
                        .and_then(|c| c.as_str())
                        .map(String::from)
                        .unwrap_or_default(),
                    Err(err) => {
                        tracing::warn!(
                            path = %path.display(),
                            error = %err,
                            "kiro::list_sessions: session JSON parse failed; falling back to empty cwd"
                        );
                        String::new()
                    }
                },
                Err(err) => {
                    tracing::warn!(
                        path = %path.display(),
                        error = %err,
                        "kiro::list_sessions: session JSON read failed; falling back to empty cwd"
                    );
                    String::new()
                }
            };

            let lock_path = dir.join(format!("{}.lock", session_id));
            let is_locked = lock_path.exists();

            Some(KiroSessionInfo {
                session_id,
                cwd,
                last_modified: modified,
                is_locked,
            })
        })
        .collect();

    sessions.sort_by_key(|session| std::cmp::Reverse(session.last_modified));
    sessions
}

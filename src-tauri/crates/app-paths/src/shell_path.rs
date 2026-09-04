//! Process `$PATH` augmentation from the user's interactive login shell,
//! plus the well-known executable directories that shell probe commonly
//! misses. No-op on Windows.

#[cfg(unix)]
use std::collections::HashSet;
#[cfg(unix)]
use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::process::{Command, Stdio};
#[cfg(unix)]
use std::time::Duration;

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

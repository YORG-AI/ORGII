//! System `git` executable discovery: candidate enumeration per platform,
//! the once-resolved process-wide cache, and the timeout-guarded
//! `git --version` probe used to validate a candidate.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

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

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    use super::*;

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

        assert!(candidates.contains(&PathBuf::from(r"C:\Program Files\Git\cmd\git.exe")));
        assert!(candidates.contains(&PathBuf::from(r"C:\Program Files\Git\bin\git.exe")));
        assert!(candidates.contains(&PathBuf::from(
            r"C:\Users\me\AppData\Local\Programs\Git\cmd\git.exe"
        )));
    }
}

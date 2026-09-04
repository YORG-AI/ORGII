//! Per-user system temp tree: the UID-isolated ORGII temp root, per-workspace
//! and per-session scratchpads, the hosted Kiro proxy HOME, and the path
//! sanitizers that turn workspace paths / ids into single path segments.

use std::path::{Path, PathBuf};

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

pub(crate) fn sanitize_path_segment(segment: &str) -> String {
    segment
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' => '_',
            '\0' => '_',
            other => other,
        })
        .collect()
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
}

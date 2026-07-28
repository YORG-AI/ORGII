//! OpenCode session-id parsing, database opening, and on-disk path discovery.

use super::*;

pub(super) fn opencode_source_id_from_session_id(session_id: &str) -> Result<&str, String> {
    let Some(source_session_id) = session_id.strip_prefix(OPENCODE_SESSION_PREFIX) else {
        return Err(format!("Invalid OpenCode session id: {session_id}"));
    };
    if source_session_id.trim().is_empty() {
        return Err("OpenCode session id is missing source id".to_string());
    }
    Ok(source_session_id)
}

pub(super) fn open_opencode_db() -> Result<Option<(Connection, PathBuf)>, String> {
    for path in opencode_db_candidate_paths() {
        if path.is_file() {
            let conn = Connection::open_with_flags(
                &path,
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
            )
            .map_err(|err| format!("Failed to open OpenCode database {}: {err}", path.display()))?;
            return Ok(Some((conn, path)));
        }
    }
    Ok(None)
}

fn opencode_db_candidate_paths() -> Vec<PathBuf> {
    let Some(home_dir) = dirs::home_dir() else {
        return Vec::new();
    };
    let mut paths = opencode_db_candidate_paths_for_home(&home_dir);
    // ORGII-managed OpenCode runs override HOME/XDG into per-account profile
    // dirs whose data lands under `<profile>/.local/share/opencode`.
    paths.extend(
        crate::sources::imported_history::managed_roots::profile_root_children(
            &app_paths::opencode_cli_profile_root(),
            &[".local", "share", "opencode"],
        )
        .into_iter()
        .map(|dir| dir.join(OPENCODE_DB_FILENAME)),
    );
    paths
}

pub(super) fn opencode_db_candidate_paths_for_home(home_dir: &Path) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    roots.push(home_dir.join(".local").join("share").join("opencode"));

    if let Some(data_local_dir) = dirs::data_local_dir() {
        roots.push(data_local_dir.join("opencode"));
    }
    if let Some(data_dir) = dirs::data_dir() {
        roots.push(data_dir.join("opencode"));
    }

    #[cfg(target_os = "macos")]
    {
        let app_support = home_dir.join("Library").join("Application Support");
        roots.push(app_support.join("opencode"));
        roots.push(app_support.join("OpenCode"));
        roots.push(app_support.join("ai.opencode.desktop"));
        roots.push(app_support.join("ai.opencode.desktop").join("opencode"));
    }

    #[cfg(target_os = "windows")]
    {
        roots.push(home_dir.join("AppData").join("Roaming").join("opencode"));
        roots.push(home_dir.join("AppData").join("Roaming").join("OpenCode"));
        roots.push(
            home_dir
                .join("AppData")
                .join("Roaming")
                .join("ai.opencode.desktop"),
        );
        roots.push(home_dir.join("AppData").join("Local").join("opencode"));
        roots.push(home_dir.join("AppData").join("Local").join("OpenCode"));
        roots.push(
            home_dir
                .join("AppData")
                .join("Local")
                .join("ai.opencode.desktop"),
        );
    }

    #[cfg(target_os = "linux")]
    {
        roots.push(home_dir.join(".config").join("opencode"));
    }

    let mut seen = HashSet::new();
    roots
        .into_iter()
        .filter(|root| seen.insert(root.clone()))
        .map(|root| root.join(OPENCODE_DB_FILENAME))
        .collect()
}

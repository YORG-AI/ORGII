//! Windsurf session-id parsing, database opening, and on-disk path discovery.

use super::*;

pub(super) fn windsurf_composer_id_from_session_id(session_id: &str) -> Result<&str, String> {
    let Some(composer_id) = session_id.strip_prefix(WINDSURF_SESSION_PREFIX) else {
        return Err(format!("Invalid Windsurf history session id: {session_id}"));
    };
    if composer_id.is_empty() {
        return Err("Windsurf history session id is missing composer id".to_string());
    }
    Ok(composer_id)
}

pub(super) fn open_windsurf_db() -> Option<(Connection, PathBuf)> {
    let path = windsurf_db_path()?;
    let conn = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    Some((conn, path))
}

fn windsurf_db_path() -> Option<PathBuf> {
    windsurf_db_candidate_paths()
        .into_iter()
        .find(|path| path.exists())
}

pub(super) fn windsurf_db_candidate_paths() -> Vec<PathBuf> {
    let home = app_paths::external_history_home_dir();

    let mut paths = Vec::new();

    #[cfg(target_os = "macos")]
    {
        let app_support = home.join("Library").join("Application Support");
        paths.push(windsurf_profile_db_path(app_support.join("Windsurf")));
    }

    #[cfg(target_os = "linux")]
    {
        let config = home.join(".config");
        paths.push(windsurf_profile_db_path(config.join("Windsurf")));
    }

    #[cfg(target_os = "windows")]
    {
        let appdata = home.join("AppData").join("Roaming");
        paths.push(windsurf_profile_db_path(appdata.join("Windsurf")));
    }

    paths.push(windsurf_profile_db_path(home.join(".windsurf")));
    imported_paths::dedupe_paths(paths)
}

fn windsurf_profile_db_path(root: PathBuf) -> PathBuf {
    root.join("User").join("globalStorage").join("state.vscdb")
}

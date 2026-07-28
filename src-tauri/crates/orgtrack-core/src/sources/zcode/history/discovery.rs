//! ZCode session-id parsing, database opening, and on-disk path discovery.

use super::*;

pub(super) fn zcode_source_id_from_session_id(session_id: &str) -> Result<&str, String> {
    let Some(source_session_id) = session_id.strip_prefix(ZCODE_SESSION_PREFIX) else {
        return Err(format!("Invalid ZCode session id: {session_id}"));
    };
    if source_session_id.trim().is_empty() {
        return Err("ZCode session id is missing source id".to_string());
    }
    Ok(source_session_id)
}

pub(super) fn open_zcode_db() -> Result<Option<(Connection, PathBuf)>, String> {
    for path in zcode_history_candidate_paths() {
        if path.is_file() {
            let conn = Connection::open_with_flags(
                &path,
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
            )
            .map_err(|err| format!("Failed to open ZCode database {}: {err}", path.display()))?;
            return Ok(Some((conn, path)));
        }
    }
    Ok(None)
}

pub(super) fn zcode_history_candidate_paths_for_home(home_dir: &Path) -> Vec<PathBuf> {
    // ZCode's CLI keeps its store at `~/.zcode/cli/db/db.sqlite` on every
    // platform (`%USERPROFILE%\.zcode\...` on Windows).
    vec![home_dir
        .join(".zcode")
        .join("cli")
        .join("db")
        .join("db.sqlite")]
}

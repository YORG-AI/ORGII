use rusqlite::{params, Result as SqliteResult};

use database::db::get_connection;

use super::session_crud::now_iso;

/// Store worktree info after creating an isolated session.
pub fn update_worktree_info(
    session_id: &str,
    worktree_path: &str,
    worktree_branch: &str,
    base_branch: &str,
) -> SqliteResult<bool> {
    let conn = get_connection()?;
    let affected = conn.execute(
        "UPDATE code_sessions SET worktree_path = ?2, worktree_branch = ?3, base_branch = ?4, \
         merge_status = 'pending', updated_at = ?5 WHERE session_id = ?1",
        params![
            session_id,
            worktree_path,
            worktree_branch,
            base_branch,
            now_iso()
        ],
    )?;
    Ok(affected > 0)
}

/// Store a user-managed linked worktree without marking it as mergeable or
/// removable session isolation. The session borrows this checkout; it does not
/// own its branch lifecycle.
pub fn update_existing_worktree_info(
    session_id: &str,
    worktree_path: &str,
    worktree_branch: &str,
) -> SqliteResult<bool> {
    let conn = get_connection()?;
    let affected = conn.execute(
        "UPDATE code_sessions SET worktree_path = ?2, worktree_branch = ?3, base_branch = NULL, \
         merge_status = NULL, updated_at = ?4 WHERE session_id = ?1",
        params![session_id, worktree_path, worktree_branch, now_iso()],
    )?;
    Ok(affected > 0)
}

/// Update merge status for a session.
pub fn update_merge_status(session_id: &str, merge_status: &str) -> SqliteResult<bool> {
    let conn = get_connection()?;
    let affected = conn.execute(
        "UPDATE code_sessions SET merge_status = ?2, updated_at = ?3 WHERE session_id = ?1",
        params![session_id, merge_status, now_iso()],
    )?;
    Ok(affected > 0)
}

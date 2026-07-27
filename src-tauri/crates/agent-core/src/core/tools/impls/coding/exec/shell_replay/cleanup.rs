//! Session-scoped shell replay cleanup: a crash-safe deletion queue and
//! retry of cleanup jobs left behind until the owning Session row is gone.

use std::fs;
use std::path::Path;

use chrono::Utc;
use rusqlite::params;

use super::active::ACTIVE_REPLAYS;
use super::{is_safe_relative_path, resolve_replay_root, safe_component};

/// Remove the manifest and artifact files for an explicitly deleted session.
/// The caller supplies the trusted replay root resolved from AppHandle.
pub fn ensure_session_replays_deletable(session_id: &str) -> Result<(), String> {
    let active_calls: Vec<String> = ACTIVE_REPLAYS
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(session_id)
        .map(|states| states.keys().cloned().collect())
        .unwrap_or_default();
    if active_calls.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "cannot delete session {session_id} while shell replay calls are active: {}",
            active_calls.join(", ")
        ))
    }
}

/// Persist the exact artifact paths before the owning Session row is removed.
/// If the process crashes after the Session commit but before file deletion,
/// startup can still retry from this queue without depending on that row.
pub fn queue_session_replay_cleanup(session_id: &str) -> Result<(), String> {
    ensure_session_replays_deletable(session_id)?;
    let now = Utc::now().to_rfc3339();
    database::db::with_sessions_writer(|| -> rusqlite::Result<()> {
        let conn = database::db::get_connection()?;
        let paths = {
            let mut stmt =
                conn.prepare("SELECT relative_path FROM shell_replays WHERE session_id = ?1")?;
            let paths = stmt
                .query_map([session_id], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            paths
        };
        let tx = database::db::begin_immediate(&conn)?;
        for relative_path in paths {
            let relative = Path::new(&relative_path);
            if !is_safe_relative_path(relative) {
                return Err(rusqlite::Error::ToSqlConversionFailure(Box::new(
                    std::io::Error::other(format!(
                        "refusing to queue unsafe shell replay path {relative_path}"
                    )),
                )));
            }
            tx.execute(
                "INSERT INTO shell_replay_cleanup_jobs (
                    session_id, relative_path, attempts, last_error, created_at, updated_at
                 ) VALUES (?1, ?2, 0, NULL, ?3, ?3)
                 ON CONFLICT(session_id, relative_path) DO NOTHING",
                params![session_id, relative_path, now],
            )?;
        }
        tx.commit()
    })
    .map_err(|err| err.to_string())
}

fn record_cleanup_failure(session_id: &str, relative_path: &str, error: &str) {
    let now = Utc::now().to_rfc3339();
    let _ = database::db::with_sessions_writer(|| -> rusqlite::Result<()> {
        let conn = database::db::get_connection()?;
        conn.execute(
            "UPDATE shell_replay_cleanup_jobs
             SET attempts = attempts + 1, last_error = ?3, updated_at = ?4
             WHERE session_id = ?1 AND relative_path = ?2",
            params![session_id, relative_path, error, now],
        )?;
        Ok(())
    });
}

fn process_queued_session_replay_cleanup(session_id: &str) -> Result<(), String> {
    ensure_session_replays_deletable(session_id)?;
    let replay_root = resolve_replay_root();
    let conn = database::db::get_connection().map_err(|err| err.to_string())?;
    let paths: Vec<String> = {
        let mut stmt = conn
            .prepare(
                "SELECT relative_path FROM shell_replay_cleanup_jobs
                 WHERE session_id = ?1 ORDER BY relative_path",
            )
            .map_err(|err| err.to_string())?;
        let paths = stmt
            .query_map([session_id], |row| row.get::<_, String>(0))
            .map_err(|err| err.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|err| err.to_string())?;
        paths
    };

    for relative_path in &paths {
        let relative = Path::new(relative_path);
        if !is_safe_relative_path(relative) {
            let error = format!("refusing to delete unsafe shell replay path {relative_path}");
            record_cleanup_failure(session_id, relative_path, &error);
            return Err(format!(
                "refusing to delete unsafe shell replay path {relative_path}"
            ));
        }
        let path = replay_root.join(relative);
        if let Err(err) = fs::remove_file(&path) {
            if err.kind() != std::io::ErrorKind::NotFound {
                let error = format!("delete shell replay {}: {err}", path.display());
                record_cleanup_failure(session_id, relative_path, &error);
                return Err(error);
            }
        }
    }

    // Keep the manifest until every artifact deletion has succeeded. A file
    // failure therefore leaves an exact row that can be retried or diagnosed,
    // instead of creating an unaddressable orphan.
    database::db::with_sessions_writer(|| -> rusqlite::Result<()> {
        let conn = database::db::get_connection()?;
        let tx = database::db::begin_immediate(&conn)?;
        tx.execute(
            "DELETE FROM shell_replay_pages WHERE session_id = ?1",
            [session_id],
        )?;
        tx.execute(
            "DELETE FROM shell_replays WHERE session_id = ?1",
            [session_id],
        )?;
        tx.execute(
            "DELETE FROM shell_replay_cleanup_jobs WHERE session_id = ?1",
            [session_id],
        )?;
        tx.commit()
    })
    .map_err(|err| err.to_string())?;
    // All manifests for a session share the exact safe-component directory.
    // Remove it only after deriving the non-traversable component ourselves;
    // never trust a path from SQLite for recursive deletion.
    let session_dir = replay_root.join(safe_component(session_id));
    if let Err(err) = fs::remove_dir(&session_dir) {
        if !matches!(
            err.kind(),
            std::io::ErrorKind::NotFound | std::io::ErrorKind::DirectoryNotEmpty
        ) {
            tracing::warn!(path = %session_dir.display(), error = %err, "failed to remove empty shell replay session directory");
        }
    }
    Ok(())
}

pub fn remove_session_replays(session_id: &str) -> Result<(), String> {
    queue_session_replay_cleanup(session_id)?;
    process_queued_session_replay_cleanup(session_id)
}

fn table_has_session(conn: &rusqlite::Connection, table: &str, session_id: &str) -> bool {
    let table_exists = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
            [table],
            |row| row.get::<_, bool>(0),
        )
        .unwrap_or(false);
    if !table_exists {
        return false;
    }
    let sql = format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE session_id = ?1)");
    conn.query_row(&sql, [session_id], |row| row.get::<_, bool>(0))
        .unwrap_or(true)
}

/// Retry cleanup jobs left by a crash. A job is processed only after both
/// possible owning Session rows are gone, so a failed Session transaction can
/// never cause startup to remove logs for a still-visible Session.
pub fn retry_pending_replay_cleanups() -> Result<(usize, usize), String> {
    let conn = database::db::get_connection().map_err(|err| err.to_string())?;
    let session_ids: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT DISTINCT session_id FROM shell_replay_cleanup_jobs")
            .map_err(|err| err.to_string())?;
        let session_ids = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|err| err.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|err| err.to_string())?;
        session_ids
    };
    let mut completed = 0usize;
    let mut failed = 0usize;
    for session_id in session_ids {
        if table_has_session(&conn, "agent_sessions", &session_id)
            || table_has_session(&conn, "code_sessions", &session_id)
        {
            continue;
        }
        match process_queued_session_replay_cleanup(&session_id) {
            Ok(()) => completed = completed.saturating_add(1),
            Err(error) => {
                failed = failed.saturating_add(1);
                tracing::warn!(session_id, error = %error, "shell replay cleanup retry failed");
            }
        }
    }
    Ok((completed, failed))
}

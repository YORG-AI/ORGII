//! Durable ownership index for CLI chat-image files.
//!
//! Native CLI transcripts are eventually consistent with the managed
//! session: the image file is needed before the child process starts, while
//! the native transcript may not be flushed until later. Recording ownership
//! here closes that gap and gives global housekeeping a provider-independent
//! source of truth.

use rusqlite::{params, Result as SqliteResult};

use database::db::get_connection;

use super::session_crud::now_iso;

/// Register every non-inline image path as owned by `session_id`.
///
/// Ownership is session-level on purpose. Native transcript forks can retain
/// older turns after a message edit, so per-turn deletion would again risk
/// removing a file that a surviving native fork still references.
pub fn record_session_image_refs(session_id: &str, image_paths: &[String]) -> SqliteResult<()> {
    if image_paths.is_empty() {
        return Ok(());
    }

    let mut conn = get_connection()?;
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let created_at = now_iso();
    for image_path in image_paths.iter().filter(|path| !path.starts_with("data:")) {
        tx.execute(
            "INSERT OR IGNORE INTO code_session_image_refs
                (session_id, image_path, created_at)
             VALUES (?1, ?2, ?3)",
            params![session_id, image_path, created_at],
        )?;
    }
    tx.commit()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::test_env;

    #[test]
    fn records_deduplicated_session_ownership() {
        let _sandbox = test_env::sandbox();
        let conn = get_connection().expect("connection");
        crate::agent_sessions::cli::init_cli_agent_tables(&conn).expect("CLI schema");
        let now = now_iso();
        conn.execute(
            "INSERT INTO code_sessions (session_id, created_at, updated_at)
             VALUES (?1, ?2, ?2)",
            params!["cliagent-image-owner", now],
        )
        .expect("session");

        let paths = vec![
            "/tmp/shared-image.png".to_string(),
            "/tmp/shared-image.png".to_string(),
            "data:image/png;base64,aGVsbG8=".to_string(),
        ];
        record_session_image_refs("cliagent-image-owner", &paths).expect("record refs");

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM code_session_image_refs WHERE session_id = ?1",
                ["cliagent-image-owner"],
                |row| row.get(0),
            )
            .expect("ref count");
        assert_eq!(count, 1, "duplicates and inline data must not add owners");

        conn.execute(
            "DELETE FROM code_sessions WHERE session_id = ?1",
            ["cliagent-image-owner"],
        )
        .expect("delete session");
        let count_after_delete: i64 = conn
            .query_row("SELECT COUNT(*) FROM code_session_image_refs", [], |row| {
                row.get(0)
            })
            .expect("remaining ref count");
        assert_eq!(count_after_delete, 0, "session deletion releases ownership");
    }
}

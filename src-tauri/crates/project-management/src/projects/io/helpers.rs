//! Shared helpers used across the project store IO layer.

use rusqlite::Result as SqliteResult;
use std::time::{SystemTime, UNIX_EPOCH};

use database::db::{get_projects_connection, PooledConnection};

/// Open a fresh `projects.db` connection.
///
/// Each IO call gets its own connection so callers don't have to pass one
/// around. `rusqlite`'s WAL + busy_timeout (set in `configure_connection`)
/// handles concurrent access cheaply, and SQLite's connection cost is
/// dominated by the file-open syscall — negligible for an interactive
/// app.
pub(crate) fn conn() -> Result<PooledConnection, String> {
    let connection = get_projects_connection().map_err(|err| format!("DB error: {}", err))?;
    #[cfg(test)]
    crate::projects::schema::init_project_tables(&connection)
        .map_err(|err| format!("DB error: {}", err))?;
    Ok(connection)
}

/// Current Unix-epoch milliseconds. Used for the `created_at` /
/// `updated_at` columns, which are stored as integers (the legacy file
/// layer used ISO-8601 strings; the wire types continue to expose
/// strings via `to_iso8601`).
pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|dur| dur.as_millis() as i64)
        .unwrap_or(0)
}

/// Convert epoch millis to an ISO-8601 string for wire compatibility
/// with `ProjectMeta::created_at` / `updated_at`, which are `String` in
/// the legacy frontmatter format that the frontend already consumes.
pub(super) fn to_iso8601(epoch_ms: i64) -> String {
    use chrono::DateTime;
    DateTime::from_timestamp_millis(epoch_ms)
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_else(|| epoch_ms.to_string())
}

/// Convert an ISO-8601 string back to epoch milliseconds. Falls back to
/// `now_ms()` when parsing fails — this matches the legacy file layer's
/// "best-effort" timestamp handling and prevents a malformed wire-side
/// date from poisoning DB rows.
pub(super) fn from_iso8601(value: &str) -> i64 {
    use chrono::DateTime;
    DateTime::parse_from_rfc3339(value)
        .map(|dt| dt.timestamp_millis())
        .unwrap_or_else(|_| now_ms())
}

/// Map any rusqlite error into a `String` — every public IO function
/// returns `Result<T, String>` so the Tauri command layer can wire it
/// directly to JS.
pub(super) fn map_db<T>(result: SqliteResult<T>) -> Result<T, String> {
    result.map_err(|err| format!("DB error: {}", err))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_roundtrip_is_lossless_within_millisecond() {
        let original = now_ms();
        let iso = to_iso8601(original);
        let back = from_iso8601(&iso);
        assert_eq!(original, back, "iso roundtrip should preserve epoch ms");
    }

    #[test]
    fn from_iso8601_falls_back_on_garbage() {
        let result = from_iso8601("not a real timestamp");
        // Should be close to `now` and definitely not zero.
        assert!(result > 0, "fallback should produce a positive epoch");
    }
}

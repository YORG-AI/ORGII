//! Per-round token usage persistence.
//!
//! Stores one row per chat round in `session_token_usage`.
//! Shared by code sessions and OS Agent sessions.

use chrono::Utc;
use rusqlite::{params, Result as SqliteResult};
use serde::{Deserialize, Serialize};

use super::connection::with_sessions_writer;
use super::get_connection;

// ============================================
// Types
// ============================================

/// A single per-round token usage record.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsageRecord {
    pub id: i64,
    pub session_id: String,
    pub session_type: String,
    pub model: Option<String>,
    pub account_id: Option<String>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub total_tokens: i64,
    /// Last LLM call's prompt tokens — represents actual context window fill level.
    pub context_tokens: i64,
    /// Serialized ContextUsageSnapshot from the final provider request.
    pub context_usage_json: Option<String>,
    pub created_at: String,
}

// ============================================
// CRUD
// ============================================

/// Insert a single per-round token usage record.
///
/// `session_type` should be `"sde"` or `"os"`.
#[allow(clippy::too_many_arguments)]
pub fn insert_token_usage_record(
    session_id: &str,
    session_type: &str,
    model: Option<&str>,
    account_id: Option<&str>,
    input_tokens: i64,
    output_tokens: i64,
    cache_read_tokens: i64,
    cache_write_tokens: i64,
    total_tokens: i64,
    context_tokens: i64,
    context_usage_json: Option<&str>,
) -> SqliteResult<i64> {
    with_sessions_writer(|| {
        let conn = get_connection()?;
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO session_token_usage
                (session_id, session_type, model, account_id,
                 input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                 total_tokens, context_tokens, context_usage_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                session_id,
                session_type,
                model,
                account_id,
                input_tokens,
                output_tokens,
                cache_read_tokens,
                cache_write_tokens,
                total_tokens,
                context_tokens,
                context_usage_json,
                now,
            ],
        )?;
        Ok(conn.last_insert_rowid())
    })
}

/// Get all per-round token usage records for a session, ordered by created_at.
pub fn get_token_usage_records(session_id: &str) -> SqliteResult<Vec<TokenUsageRecord>> {
    let conn = get_connection()?;
    let mut stmt = conn.prepare(
        "SELECT id, session_id, session_type, model, account_id,
                input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                total_tokens, context_tokens, context_usage_json, created_at
         FROM session_token_usage
         WHERE session_id = ?1
         ORDER BY created_at ASC",
    )?;
    let records = stmt
        .query_map([session_id], |row| {
            Ok(TokenUsageRecord {
                id: row.get(0)?,
                session_id: row.get(1)?,
                session_type: row.get(2)?,
                model: row.get(3)?,
                account_id: row.get(4)?,
                input_tokens: row.get(5)?,
                output_tokens: row.get(6)?,
                cache_read_tokens: row.get(7)?,
                cache_write_tokens: row.get(8)?,
                total_tokens: row.get(9)?,
                context_tokens: row.get(10)?,
                context_usage_json: row.get(11)?,
                created_at: row.get(12)?,
            })
        })?
        .collect::<SqliteResult<Vec<_>>>()?;
    Ok(records)
}

/// Delete all per-round token usage records for a session.
///
/// Called when a session is deleted to keep the table clean.
pub fn delete_token_usage_records(session_id: &str) -> SqliteResult<usize> {
    with_sessions_writer(|| {
        let conn = get_connection()?;
        let affected = conn.execute(
            "DELETE FROM session_token_usage WHERE session_id = ?1",
            [session_id],
        )?;
        Ok(affected)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    static ORGII_HOME_TEST_LOCK: StdMutex<()> = StdMutex::new(());

    fn with_temp_orgii_home<R>(run: impl FnOnce() -> R) -> R {
        let _guard = match ORGII_HOME_TEST_LOCK.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        let previous = std::env::var("ORGII_HOME").ok();
        let root = std::path::Path::new("/private/var/folders/10/t245s0211dv9d_5252w6y5wh0000gn/T/orgii-501/Users_junyu_github_ORGII/sdeagent-7fa054ca-ee9b-4c49-b96b-35024a069eaf/scratchpad")
            .join(format!("orgii-token-usage-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("create temp ORGII_HOME");
        std::env::set_var("ORGII_HOME", &root);
        {
            let conn = get_connection().expect("open sessions DB");
            super::super::schema::init_session_tables(&conn).expect("init session schema for test");
        }
        let result = run();
        match previous {
            Some(value) => std::env::set_var("ORGII_HOME", value),
            None => std::env::remove_var("ORGII_HOME"),
        }
        let _ = std::fs::remove_dir_all(&root);
        result
    }

    #[test]
    fn token_usage_round_trips_context_usage_json() {
        with_temp_orgii_home(|| {
            let context_usage_json = r#"{"usedTokens":1200,"sections":[{"category":"conversation","label":"Conversation"}],"warnings":[]}"#;
            insert_token_usage_record(
                "session-context-json",
                "sde",
                Some("model-1"),
                Some("account-1"),
                1100,
                100,
                25,
                5,
                1230,
                1200,
                Some(context_usage_json),
            )
            .expect("insert token usage");

            let records =
                get_token_usage_records("session-context-json").expect("load token usage records");
            assert_eq!(records.len(), 1);
            assert_eq!(records[0].context_tokens, 1200);
            assert_eq!(
                records[0].context_usage_json.as_deref(),
                Some(context_usage_json)
            );
        });
    }
}

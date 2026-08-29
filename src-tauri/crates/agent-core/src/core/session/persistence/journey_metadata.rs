//! Explicit metadata used by the read-only Journey projection.

use database::db::{get_connection, with_sessions_writer};
use rusqlite::{params, OptionalExtension, Result as SqliteResult};

/// Explicit, durable associations for the read-only Journey projection.
///
/// This is deliberately separate from the session record: callers must supply
/// these values, and no session title, path, branch, or event ordering is used
/// to populate them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExplicitJourneyMetadata {
    pub workspace_id: Option<String>,
    pub topic_tags: Vec<String>,
}

const JOURNEY_METADATA_DDL: &str = r#"
    CREATE TABLE IF NOT EXISTS session_journey_metadata (
        session_id TEXT PRIMARY KEY,
        workspace_id TEXT,
        topic_tags_json TEXT NOT NULL DEFAULT '[]'
    )
"#;

fn ensure_journey_metadata_table(conn: &rusqlite::Connection) -> SqliteResult<()> {
    conn.execute(JOURNEY_METADATA_DDL, [])?;
    Ok(())
}

/// Store associations supplied explicitly at session creation. The caller
/// decides whether absent metadata should be written; this helper never
/// synthesizes values from other session fields.
pub fn upsert_explicit_journey_metadata(
    session_id: &str,
    metadata: &ExplicitJourneyMetadata,
) -> SqliteResult<()> {
    with_sessions_writer(|| {
        let conn = get_connection()?;
        upsert_explicit_journey_metadata_with_conn(&conn, session_id, metadata)
    })
}

fn upsert_explicit_journey_metadata_with_conn(
    conn: &rusqlite::Connection,
    session_id: &str,
    metadata: &ExplicitJourneyMetadata,
) -> SqliteResult<()> {
    ensure_journey_metadata_table(conn)?;
    let topic_tags_json = serde_json::to_string(&metadata.topic_tags)
        .map_err(|err| rusqlite::Error::ToSqlConversionFailure(Box::new(err)))?;
    conn.execute(
        "INSERT INTO session_journey_metadata (session_id, workspace_id, topic_tags_json)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(session_id) DO UPDATE SET
                 workspace_id = excluded.workspace_id,
                 topic_tags_json = excluded.topic_tags_json",
        params![session_id, metadata.workspace_id, topic_tags_json],
    )?;
    Ok(())
}

/// Return only metadata a producer stored explicitly. `None` means historical
/// unknown, not a request to infer an association.
pub fn get_explicit_journey_metadata(
    session_id: &str,
) -> SqliteResult<Option<ExplicitJourneyMetadata>> {
    let conn = get_connection()?;
    get_explicit_journey_metadata_with_conn(&conn, session_id)
}

fn get_explicit_journey_metadata_with_conn(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> SqliteResult<Option<ExplicitJourneyMetadata>> {
    ensure_journey_metadata_table(conn)?;
    conn.query_row(
        "SELECT workspace_id, topic_tags_json FROM session_journey_metadata WHERE session_id = ?1",
        [session_id],
        |row| {
            let topic_tags_json: String = row.get(1)?;
            let topic_tags = serde_json::from_str(&topic_tags_json).map_err(|err| {
                rusqlite::Error::FromSqlConversionFailure(
                    1,
                    rusqlite::types::Type::Text,
                    Box::new(err),
                )
            })?;
            Ok(ExplicitJourneyMetadata {
                workspace_id: row.get(0)?,
                topic_tags,
            })
        },
    )
    .optional()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_journey_metadata_round_trips_without_session_field_inference() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        let metadata = ExplicitJourneyMetadata {
            workspace_id: Some("workspace-explicit".to_string()),
            topic_tags: vec!["release".to_string(), "journey".to_string()],
        };

        upsert_explicit_journey_metadata_with_conn(
            &conn,
            "session-title-must-not-matter",
            &metadata,
        )
        .unwrap();
        assert_eq!(
            get_explicit_journey_metadata_with_conn(&conn, "session-title-must-not-matter")
                .unwrap(),
            Some(metadata)
        );
        assert_eq!(
            get_explicit_journey_metadata_with_conn(&conn, "unseen-session").unwrap(),
            None
        );
    }
}

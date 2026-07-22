//! Rust-agent session impact projected from the canonical materialized turns.
//!
//! `session_turns` is the single source for both the per-round UI and the
//! whole-session file summary. Loading it lazily rebuilds old sessions when
//! the turn-index version changes, so historical sessions gain metadata
//! without a second transcript parser or a destructive migration.

use std::collections::BTreeSet;

use session_persistence::CachedTurnSummary;

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionImpactStats {
    pub files_changed: i64,
    pub lines_added: i64,
    pub lines_removed: i64,
    pub touched_files: Vec<String>,
}

pub fn get_session_impact(session_id: &str) -> Result<Option<SessionImpactStats>, String> {
    let turns = session_persistence::load_turn_index(session_id).map_err(|err| err.to_string())?;
    Ok(summarize_turns(&turns))
}

/// Read only already-materialized impact metadata.
///
/// Unlike `get_session_impact`, this never checks freshness and can therefore
/// never rebuild a turn index from transcript events. Snapshot-backed native
/// forks use it for sidebar metadata: snapshot publication deletes stale turn
/// rows, so no rows means "metadata unavailable" rather than "reparse all
/// inherited history".
pub fn get_persisted_session_impact(
    session_id: &str,
) -> Result<Option<SessionImpactStats>, String> {
    let conn = database::db::get_connection()
        .map_err(|error| format!("open persisted session impact database: {error}"))?;
    persisted_session_impact_from_connection(&conn, session_id)
}

fn persisted_session_impact_from_connection(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> Result<Option<SessionImpactStats>, String> {
    let mut statement = conn
        .prepare_cached(
            "SELECT modified_files_json FROM session_turns
             WHERE session_id=?1 ORDER BY start_sequence ASC",
        )
        .map_err(|error| format!("prepare persisted session impact: {error}"))?;
    let mut rows = statement
        .query([session_id])
        .map_err(|error| format!("query persisted session impact: {error}"))?;
    let mut touched_files = BTreeSet::new();
    let mut lines_added = 0_i64;
    let mut lines_removed = 0_i64;
    while let Some(row) = rows
        .next()
        .map_err(|error| format!("read persisted session impact: {error}"))?
    {
        let raw: String = row
            .get(0)
            .map_err(|error| format!("decode persisted session impact column: {error}"))?;
        let files = serde_json::from_str::<Vec<session_persistence::TurnModifiedFile>>(&raw)
            .map_err(|error| format!("decode persisted session impact JSON: {error}"))?;
        fold_modified_files(
            &mut touched_files,
            &mut lines_added,
            &mut lines_removed,
            &files,
        );
    }
    Ok(finish_impact(touched_files, lines_added, lines_removed))
}

fn summarize_turns(turns: &[CachedTurnSummary]) -> Option<SessionImpactStats> {
    let mut touched_files = BTreeSet::new();
    let mut lines_added = 0_i64;
    let mut lines_removed = 0_i64;

    for turn in turns {
        fold_modified_files(
            &mut touched_files,
            &mut lines_added,
            &mut lines_removed,
            &turn.modified_files,
        );
    }

    finish_impact(touched_files, lines_added, lines_removed)
}

fn fold_modified_files(
    touched_files: &mut BTreeSet<String>,
    lines_added: &mut i64,
    lines_removed: &mut i64,
    files: &[session_persistence::TurnModifiedFile],
) {
    for file in files {
        if file.path.trim().is_empty() {
            continue;
        }
        touched_files.insert(file.path.clone());
        *lines_added = lines_added.saturating_add(i64::from(file.additions));
        *lines_removed = lines_removed.saturating_add(i64::from(file.deletions));
    }
}

fn finish_impact(
    touched_files: BTreeSet<String>,
    lines_added: i64,
    lines_removed: i64,
) -> Option<SessionImpactStats> {
    if touched_files.is_empty() && lines_added == 0 && lines_removed == 0 {
        return None;
    }

    Some(SessionImpactStats {
        files_changed: touched_files.len() as i64,
        lines_added,
        lines_removed,
        touched_files: touched_files.into_iter().collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use session_persistence::TurnModifiedFile;

    fn turn(files: Vec<TurnModifiedFile>) -> CachedTurnSummary {
        CachedTurnSummary {
            session_id: "session-1".to_string(),
            turn_id: "turn-1".to_string(),
            start_sequence: 1,
            end_sequence: None,
            next_turn_id: None,
            started_at: "2026-07-15T00:00:00Z".to_string(),
            ended_at: None,
            duration_ms: None,
            user_event_ids: vec![],
            user_preview: String::new(),
            event_count: 0,
            body_event_count: 0,
            status: "completed".to_string(),
            interrupted: false,
            modified_files: files,
            resource_interactions: vec![],
            git_artifacts: vec![],
        }
    }

    #[test]
    fn folds_round_files_into_one_session_summary() {
        let summary = summarize_turns(&[
            turn(vec![TurnModifiedFile {
                path: "src/a.ts".to_string(),
                file_name: "a.ts".to_string(),
                status: "modified".to_string(),
                additions: 3,
                deletions: 1,
            }]),
            turn(vec![
                TurnModifiedFile {
                    path: "src/a.ts".to_string(),
                    file_name: "a.ts".to_string(),
                    status: "modified".to_string(),
                    additions: 2,
                    deletions: 0,
                },
                TurnModifiedFile {
                    path: "src/b.ts".to_string(),
                    file_name: "b.ts".to_string(),
                    status: "created".to_string(),
                    additions: 4,
                    deletions: 0,
                },
            ]),
        ])
        .expect("session impact");

        assert_eq!(summary.files_changed, 2);
        assert_eq!(summary.lines_added, 9);
        assert_eq!(summary.lines_removed, 1);
        assert_eq!(summary.touched_files, vec!["src/a.ts", "src/b.ts"]);
    }

    #[test]
    fn persisted_impact_streams_materialized_metadata_without_turn_index_refresh() {
        let conn = rusqlite::Connection::open_in_memory().expect("impact database");
        session_persistence::init_session_tables(&conn).expect("session schema");
        let files = serde_json::to_string(&vec![TurnModifiedFile {
            path: "src/persisted.ts".to_string(),
            file_name: "persisted.ts".to_string(),
            status: "modified".to_string(),
            additions: 7,
            deletions: 4,
        }])
        .expect("serialize materialized files");
        conn.execute(
            "INSERT INTO session_turns(
               session_id,turn_id,start_sequence,started_at,status,updated_at,
               modified_files_json
             ) VALUES('agentsession-cloud-fork','turn-1',0,
                      '2026-07-23T00:00:00Z','completed',
                      '2026-07-23T00:00:01Z',?1)",
            [files],
        )
        .expect("insert materialized turn metadata");

        let impact = persisted_session_impact_from_connection(&conn, "agentsession-cloud-fork")
            .expect("load persisted impact")
            .expect("persisted impact exists");
        assert_eq!(impact.files_changed, 1);
        assert_eq!(impact.lines_added, 7);
        assert_eq!(impact.lines_removed, 4);
        assert_eq!(impact.touched_files, vec!["src/persisted.ts"]);
        let index_state_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM session_turn_index_state
                 WHERE session_id='agentsession-cloud-fork'",
                [],
                |row| row.get(0),
            )
            .expect("count turn index states");
        assert_eq!(index_state_rows, 0);
    }
}

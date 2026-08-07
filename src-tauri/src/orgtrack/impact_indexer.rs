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

fn summarize_turns(turns: &[CachedTurnSummary]) -> Option<SessionImpactStats> {
    let mut touched_files = BTreeSet::new();
    let mut lines_added = 0_i64;
    let mut lines_removed = 0_i64;

    for turn in turns {
        for file in &turn.modified_files {
            if file.path.trim().is_empty() {
                continue;
            }
            touched_files.insert(file.path.clone());
            lines_added = lines_added.saturating_add(i64::from(file.additions));
            lines_removed = lines_removed.saturating_add(i64::from(file.deletions));
        }
    }

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
}

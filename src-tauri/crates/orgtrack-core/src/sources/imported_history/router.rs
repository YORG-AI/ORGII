//! Source-neutral bounded replay routing for backend consumers.
//!
//! This module intentionally exposes pages from the compact replay index. It
//! must never grow a provider-specific full-history fallback: adding a source
//! without a replay adapter is an error in the exhaustive replay registry.

use rusqlite::Connection;

use super::replay::{self, ImportedHistorySourceId, ReplayChunkScan, ReplayCursor, ReplayLimits};

/// Resolve one of the fifteen built-in imported-history sources from its
/// canonical session-id prefix. Unknown ids are left for third-party loaders.
pub fn source_for_session(session_id: &str) -> Option<ImportedHistorySourceId> {
    ImportedHistorySourceId::from_session_id(session_id)
}

/// Read the next bounded compact-index page for a built-in imported session.
///
/// `None` means the id is not owned by a built-in source. Passing no cursor
/// starts by boundedly materializing lazy turns and verifying a stable source,
/// then reads the first page from that strict generation/revision. A cursor
/// continues the same immutable compact snapshot; external changes are never
/// mixed into an in-progress consumer.
/// Each returned `Vec` is constrained by [`ReplayLimits`] and is never a full
/// transcript.
pub fn scan_activity_chunks_for_session(
    conn: &mut Connection,
    session_id: &str,
    cursor: Option<&ReplayCursor>,
    limits: ReplayLimits,
) -> Result<Option<ReplayChunkScan>, String> {
    let Some(source) = source_for_session(session_id) else {
        return Ok(None);
    };
    let scan = match cursor {
        Some(cursor) => {
            if cursor.source_id != source.as_str() || cursor.session_id != session_id {
                return Err("Replay cursor belongs to another source/session".to_string());
            }
            replay::scan_window_after_generation(
                conn,
                source,
                session_id,
                &cursor.generation,
                cursor.revision,
                cursor.through_sequence,
                limits,
            )?
        }
        None => {
            let prepared = replay::prepare_pinned_scan(conn, source, session_id, limits)?;
            replay::scan_window_after_generation(
                conn,
                source,
                session_id,
                &prepared.generation,
                prepared.revision,
                -1,
                limits,
            )?
        }
    };
    Ok(Some(scan))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_every_builtin_to_the_exhaustive_replay_registry() {
        let cases = [
            "claudecodeapp-id",
            "codexapp-id",
            "cursoride-id",
            "cursorcliapp-id",
            "opencodeapp-id",
            "windsurfapp-id",
            "workbuddyapp-id",
            "traeapp-id",
            "clineapp-id",
            "warpapp-id",
            "zcodeapp-id",
            "qoderapp-id",
            "mimocodeapp-id",
            "ompapp-id",
            "qodercliapp-id",
        ];

        assert_eq!(cases.len(), ImportedHistorySourceId::ALL.len());
        let mut routed = std::collections::HashSet::new();
        for session_id in cases {
            let source = source_for_session(session_id).expect(session_id);
            assert_eq!(source.validate_session_id(session_id), Ok(()));
            assert!(routed.insert(source), "duplicate route for {session_id}");
        }
        assert_eq!(
            routed,
            ImportedHistorySourceId::ALL.into_iter().collect(),
            "every built-in replay adapter must be reachable from its canonical prefix"
        );
        assert_eq!(source_for_session("org2-native-id"), None);
    }

    #[test]
    fn unknown_ids_do_not_touch_sqlite_or_fall_back() {
        let mut conn = Connection::open_in_memory().expect("in-memory DB");
        assert!(scan_activity_chunks_for_session(
            &mut conn,
            "plugin-owned-id",
            None,
            ReplayLimits::default(),
        )
        .expect("unknown route")
        .is_none());
    }

    #[test]
    fn continuation_rejects_a_cursor_from_another_session_before_reading() {
        let mut conn = Connection::open_in_memory().expect("in-memory DB");
        let cursor = ReplayCursor {
            source_id: ImportedHistorySourceId::CodexApp.as_str().to_string(),
            session_id: "codexapp-other".to_string(),
            generation: "generation".to_string(),
            revision: 1,
            through_sequence: 10,
        };
        let error = scan_activity_chunks_for_session(
            &mut conn,
            "codexapp-target",
            Some(&cursor),
            ReplayLimits::default(),
        )
        .expect_err("mismatched cursor");
        assert!(error.contains("another source/session"));
    }
}

use std::{
    collections::{HashSet, VecDeque},
    path::Path,
    sync::{Mutex, OnceLock},
};

use database::db::get_connection;
use orgtrack_core::pricing;
use orgtrack_core::sources::claude_code::history as claude_code_history;
use orgtrack_core::sources::cline::history as cline_history;
use orgtrack_core::sources::codex::app as codex_app;
use orgtrack_core::sources::copilot::history as copilot_history;
use orgtrack_core::sources::cursor_cli::history as cursor_cli_history;
use orgtrack_core::sources::cursor_ide::{
    db as cursor_db, disk_reads as cursor_disk_reads, history as cursor_db_history,
};
use orgtrack_core::sources::imported_history;
use orgtrack_core::sources::kimi::history as kimi_history;
use orgtrack_core::sources::mimo_code::history as mimo_code_history;
use orgtrack_core::sources::omp::history as omp_history;
use orgtrack_core::sources::opencode::history as opencode_history;
use orgtrack_core::sources::pi::history as pi_history;
use orgtrack_core::sources::qoder::history as qoder_history;
use orgtrack_core::sources::qoder_cli::history as qoder_cli_history;
use orgtrack_core::sources::qwen_code::history as qwen_code_history;
use orgtrack_core::sources::trae::history as trae_history;
use orgtrack_core::sources::warp::history as warp_history;
use orgtrack_core::sources::windsurf::history as windsurf_history;
use orgtrack_core::sources::workbuddy as workbuddy_history;
use orgtrack_core::sources::zcode::history as zcode_history;
use session_persistence::CachedTurnSummary;

use super::external_cli_detection::{self, ExternalCliSourceProbe};
use super::history_scan_coordinator::{
    ExternalHistoryScanCoordinator, ExternalHistoryScanJob, ExternalHistoryScanMode,
    ExternalHistorySourceScanOutcome, ExternalHistorySourceScanResult,
};

mod cursor;
mod imported_windows;
mod projection;
mod provider_commands;
mod provider_wrappers;
mod scan;

pub use cursor::*;
pub use imported_windows::*;
pub use projection::*;
pub use provider_commands::*;
pub use provider_wrappers::*;
pub use scan::*;

#[cfg(test)]
mod tests {
    use orgtrack_core::projectors::turn_metadata::ProjectedTurnMetadata;

    use super::scan::external_history_scan_mode;
    use super::*;

    fn projected(turn_id: &str, start_sequence: i64) -> ProjectedTurnMetadata {
        ProjectedTurnMetadata {
            turn_id: turn_id.to_string(),
            start_sequence,
            started_at: format!("2026-07-15T00:00:0{start_sequence}Z"),
            ended_at: None,
            status: "completed".to_string(),
            user_preview: turn_id.to_string(),
            event_count: 2,
            body_event_count: 1,
            modified_files: Vec::new(),
            resource_interactions: Vec::new(),
            git_artifacts: Vec::new(),
        }
    }

    #[test]
    fn projected_round_mapping_preserves_boundaries_and_next_turn() {
        let turns = projected_rounds_to_cached_turns(
            "codexapp-session",
            vec![projected("user-1", 0), projected("user-2", 3)],
        );

        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].turn_id, "user-1");
        assert_eq!(turns[0].end_sequence, Some(3));
        assert_eq!(turns[0].next_turn_id.as_deref(), Some("user-2"));
        assert_eq!(turns[1].turn_id, "user-2");
        assert_eq!(turns[1].end_sequence, None);
        assert_eq!(turns[1].next_turn_id, None);
    }

    #[test]
    fn projected_round_mapping_materializes_duration_from_its_timestamps() {
        let mut completed = projected("user-1", 0);
        completed.started_at = "2026-07-15T00:00:00Z".to_string();
        completed.ended_at = Some("2026-07-15T00:00:35Z".to_string());

        let turns = projected_rounds_to_cached_turns("codexapp-session", vec![completed]);

        assert_eq!(turns[0].duration_ms, Some(35_000));
    }

    #[test]
    fn projected_round_mapping_preserves_non_terminal_status() {
        let mut active = projected("user-active", 0);
        active.status = "pending".to_string();

        let turns = projected_rounds_to_cached_turns("codexapp-session", vec![active]);

        assert_eq!(turns[0].status, "pending");
        assert!(!turns[0].interrupted);
    }

    #[test]
    fn external_history_rebuild_requires_explicit_clear() {
        assert_eq!(
            external_history_scan_mode(false),
            ExternalHistoryScanMode::Incremental
        );
        assert_eq!(
            external_history_scan_mode(true),
            ExternalHistoryScanMode::Rebuild
        );
    }

    #[test]
    fn imported_projection_cache_is_bounded_and_rejects_stale_signatures() {
        let mut cache = ImportedTurnProjectionCache::default();
        for index in 0..=IMPORTED_TURN_PROJECTION_CACHE_CAPACITY {
            cache.insert(
                format!("codexapp-{index}"),
                (index as i64, index as u64),
                ProjectionQuality::Full,
                vec![projected(&format!("user-{index}"), index as i64)],
            );
        }

        assert_eq!(cache.entries.len(), IMPORTED_TURN_PROJECTION_CACHE_CAPACITY);
        assert!(cache
            .get("codexapp-0", (0, 0), ProjectionQuality::Full)
            .is_none());
        assert!(cache
            .get("codexapp-1", (999, 999), ProjectionQuality::Full)
            .is_none());
        assert!(cache
            .get("codexapp-2", (2, 2), ProjectionQuality::Full)
            .is_some());
    }

    #[test]
    fn imported_projection_cache_bounds_turns_per_session() {
        let mut cache = ImportedTurnProjectionCache::default();
        cache.insert(
            "codexapp-large".to_string(),
            (1, 2),
            ProjectionQuality::Full,
            (0..=IMPORTED_TURN_PROJECTION_LIMIT_PER_SESSION)
                .map(|index| projected(&format!("user-{index}"), index as i64))
                .collect(),
        );

        let projected = cache
            .get("codexapp-large", (1, 2), ProjectionQuality::Full)
            .expect("cached projection");
        assert_eq!(projected.len(), IMPORTED_TURN_PROJECTION_LIMIT_PER_SESSION);
        assert_eq!(
            projected.first().map(|turn| turn.turn_id.as_str()),
            Some("user-1")
        );
    }

    #[test]
    fn reduced_prewarm_never_displaces_full_projection_and_is_invisible_to_full_readers() {
        let mut cache = ImportedTurnProjectionCache::default();
        let full = vec![projected("user-full", 0)];
        let mut reduced_turn = projected("user-full", 0);
        reduced_turn.body_event_count = 0;
        let reduced = vec![reduced_turn];

        // A Reduced pre-warm alone: served to Reduced readers (Claude's
        // native fidelity), treated as a miss by Full readers, and NOT
        // evicted by that miss.
        cache.insert(
            "cursoride-a".to_string(),
            (1, 1),
            ProjectionQuality::Reduced,
            reduced.clone(),
        );
        assert!(cache
            .get("cursoride-a", (1, 1), ProjectionQuality::Full)
            .is_none());
        assert!(cache
            .get("cursoride-a", (1, 1), ProjectionQuality::Reduced)
            .is_some());

        // The Full recompute upgrades the entry in place…
        cache.insert(
            "cursoride-a".to_string(),
            (1, 1),
            ProjectionQuality::Full,
            full.clone(),
        );
        // …and a later Reduced pre-warm for the SAME signature (replay
        // opened after the metadata index ran) cannot downgrade it.
        cache.insert(
            "cursoride-a".to_string(),
            (1, 1),
            ProjectionQuality::Reduced,
            reduced,
        );
        let served = cache
            .get("cursoride-a", (1, 1), ProjectionQuality::Full)
            .expect("full projection retained");
        assert_eq!(served[0].body_event_count, 1);

        // A NEW signature always wins regardless of quality — staleness
        // beats fidelity.
        let mut newer_reduced = projected("user-newer", 5);
        newer_reduced.body_event_count = 0;
        cache.insert(
            "cursoride-a".to_string(),
            (2, 2),
            ProjectionQuality::Reduced,
            vec![newer_reduced],
        );
        assert!(cache
            .get("cursoride-a", (1, 1), ProjectionQuality::Reduced)
            .is_none());
        assert!(cache
            .get("cursoride-a", (2, 2), ProjectionQuality::Reduced)
            .is_some());
    }
}

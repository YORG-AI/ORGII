mod continuation;
mod lookup;
mod pins;
mod session_row;
mod sidebar;
mod signature;
mod source_queries;
mod write;

pub use continuation::{
    cached_session_continuation_status_from_conn, continuation_group_metadata_json,
    continuation_lineage_id_from_metadata_json, continuation_metadata_json,
    demote_superseded_continuations_from_conn, CONTINUATION_GROUP_KEY_FIELD,
    CONTINUATION_LINEAGE_ID_FIELD, CONTINUATION_MARKERS_FIELD, MAX_CONTINUATION_MARKERS,
};
pub use lookup::{
    get_cached_source_path_by_suffix_from_conn, get_cached_source_path_from_conn,
    query_cached_session_by_session_id_from_conn,
    query_cached_session_by_session_id_including_superseded_from_conn,
    query_cached_session_from_conn, stat_imported_transcript_by_session_id_from_conn,
};
pub use pins::{pinned_imported_session_ids_from_conn, set_imported_session_pinned_from_conn};
pub use session_row::ImportedHistoryCachedSession;
pub use sidebar::{
    query_imported_recent_paths_from_conn, query_imported_session_page_from_conn,
    query_imported_sidebar_page_from_conn,
};
pub use signature::{
    cached_record_signatures_from_conn, changed_records_from_conn, live_ids_from_signatures,
    record_matches_cached_signature,
};
pub use source_queries::{
    all_source_stats_from_conn, query_cached_sessions_for_repo_from_conn,
    query_cached_sessions_for_source_from_conn, query_cached_sessions_in_range_from_conn,
    query_recent_cached_sessions_for_source_from_conn, query_source_cache_signature_from_conn,
    ImportedHistorySourceStats,
};
pub use write::{
    current_epoch_ms, prune_missing_records_from_conn, sync_source_cache_from_conn,
    upsert_imported_session_cache_from_conn, write_session_rounds_from_conn,
};

#[cfg(test)]
#[path = "cache_tests.rs"]
mod tests;

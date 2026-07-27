//! Persistence layer types for session event caching
//!
//! `CachedEvent` mirrors the frontend `SessionEvent` JSON shape so events
//! round-trip without transformation. `TruncateResult` carries the before/after
//! event count returned by `editing::truncate_session`.

use serde::{Deserialize, Serialize};

/// A cached session event (matches frontend SessionEvent)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedEvent {
    pub id: String,
    pub session_id: String,
    pub event_type: String,
    pub function_name: Option<String>,
    pub thread_id: Option<String>,
    pub args_json: String,
    pub result_json: String,
    pub content: String, // Searchable text content
    pub created_at: String,
    pub meta_json: Option<String>, // Additional metadata (display hints, etc.)
    /// Monotonic sequence number for ordering and efficient deletion/editing
    /// Assigned automatically when saving events
    #[serde(default)]
    pub history_sequence: Option<i64>,
}

/// Session metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMetadata {
    pub session_id: String,
    pub event_count: i64,
    pub cached_at: i64,
    pub time_range_start: Option<String>,
    pub time_range_end: Option<String>,
    pub specs_json: Option<String>,
}

/// Full session data: events + metadata (specs + timeRange)
/// Used by `cache_save_session` and `cache_load_session` commands.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedSession {
    pub session_id: String,
    pub events: Vec<CachedEvent>,
    /// Serialized specs array (JSON string to avoid schema coupling)
    pub specs_json: Option<String>,
    pub time_range_start: Option<String>,
    pub time_range_end: Option<String>,
}

/// Search result with highlighted match
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub event: CachedEvent,
    pub rank: f64,
    pub snippet: String,
}

/// One cross-session search hit — one snippet per session that matched.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrossSessionSearchHit {
    pub session_id: String,
    pub snippet: String,
    pub timestamp: Option<String>,
    pub rank: f64,
}

/// Cache statistics
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-rs", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct CacheStats {
    pub total_sessions: i64,
    pub total_events: i64,
    pub db_size_bytes: i64,
}

/// Result of a truncate operation
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TruncateResult {
    /// Number of events deleted
    pub deleted_count: i64,
    /// IDs of deleted events
    pub deleted_ids: Vec<String>,
    /// History sequences of deleted events
    pub deleted_sequences: Vec<i64>,
}

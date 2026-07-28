//! Session History Queries
//!
//! Provides Rust-side filtering, sorting, grouping, and pagination
//! of session records. Replaces JS-side `useSessionHistory` logic
//! (~486 lines of filter/reduce/sort) with native Rust operations.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::agent_sessions::session_directory::status::is_active_status;

// ============================================================================
// Types
// ============================================================================

/// Session record — lightweight metadata for history listing.
/// Matches the shape stored in SQLite and sent from SDE/CLI adapters.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    pub session_id: String,
    pub name: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub session_type: String,
    #[serde(default)]
    pub repo_id: String,
    #[serde(default)]
    pub repo_name: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub event_count: usize,
    #[serde(default)]
    pub file_changes: FileChangeStats,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workflow_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assigned_agent: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeStats {
    pub added: usize,
    pub deleted: usize,
    pub modified: usize,
    pub insertion: usize,
    pub deletion: usize,
}

/// Query parameters for filtered session history.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryQuery {
    /// Filter by status (comma-separated for multiple, e.g. "running,completed")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_filter: Option<String>,
    /// Filter by session type (e.g. "sde", "cli", "os")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub type_filter: Option<String>,
    /// Filter by repo ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo_id: Option<String>,
    /// Text search in session name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search_text: Option<String>,
    /// Sort field: "updated_at" (default), "created_at", "name", "status"
    #[serde(default = "default_sort_field")]
    pub sort_by: String,
    /// Sort direction: "desc" (default), "asc"
    #[serde(default = "default_sort_dir")]
    pub sort_dir: String,
    /// Pagination offset
    #[serde(default)]
    pub offset: usize,
    /// Pagination limit (default 50, max 200)
    #[serde(default = "default_limit")]
    pub limit: usize,
}

fn default_sort_field() -> String {
    "updated_at".to_string()
}
fn default_sort_dir() -> String {
    "desc".to_string()
}
fn default_limit() -> usize {
    50
}

impl Default for HistoryQuery {
    fn default() -> Self {
        Self {
            status_filter: None,
            type_filter: None,
            repo_id: None,
            search_text: None,
            sort_by: default_sort_field(),
            sort_dir: default_sort_dir(),
            offset: 0,
            limit: default_limit(),
        }
    }
}

/// Result of a history query.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryResult {
    pub sessions: Vec<SessionRecord>,
    pub total_count: usize,
    pub ongoing_count: usize,
    pub completed_count: usize,
    pub failed_count: usize,
}

/// Grouped sessions (e.g. by date, by repo, by status).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionGroup {
    pub group_key: String,
    pub label: String,
    pub sessions: Vec<SessionRecord>,
    pub count: usize,
}

// ============================================================================
// Core Query Function
// ============================================================================

/// Filter, sort, and paginate session records.
pub fn query_sessions(sessions: &[SessionRecord], query: &HistoryQuery) -> HistoryResult {
    let mut filtered: Vec<&SessionRecord> = sessions.iter().collect();

    // Apply filters
    if let Some(ref status_filter) = query.status_filter {
        let statuses: Vec<&str> = status_filter.split(',').map(|s| s.trim()).collect();
        filtered.retain(|s| statuses.contains(&s.status.as_str()));
    }

    if let Some(ref type_filter) = query.type_filter {
        let types: Vec<&str> = type_filter.split(',').map(|s| s.trim()).collect();
        filtered.retain(|s| types.contains(&s.session_type.as_str()));
    }

    if let Some(ref repo_id) = query.repo_id {
        filtered.retain(|s| &s.repo_id == repo_id);
    }

    if let Some(ref search) = query.search_text {
        let search_lower = search.to_lowercase();
        filtered.retain(|s| s.name.to_lowercase().contains(&search_lower));
    }

    // Count categories before pagination
    let total_count = filtered.len();
    let ongoing_count = filtered
        .iter()
        .filter(|s| is_active_status(&s.status))
        .count();
    let completed_count = filtered.iter().filter(|s| s.status == "completed").count();
    let failed_count = filtered.iter().filter(|s| s.status == "failed").count();

    // Sort
    let ascending = query.sort_dir == "asc";
    filtered.sort_by(|a, b| {
        let ord = match query.sort_by.as_str() {
            "created_at" => a.created_at.cmp(&b.created_at),
            "name" => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
            "status" => a.status.cmp(&b.status),
            _ => a.updated_at.cmp(&b.updated_at), // default: updated_at
        };
        if ascending {
            ord
        } else {
            ord.reverse()
        }
    });

    // Paginate
    let limit = query.limit.clamp(1, 200);
    let paginated: Vec<SessionRecord> = filtered
        .into_iter()
        .skip(query.offset)
        .take(limit)
        .cloned()
        .collect();

    HistoryResult {
        sessions: paginated,
        total_count,
        ongoing_count,
        completed_count,
        failed_count,
    }
}

/// Get the N most recently updated sessions (for sidebar quick-access).
pub fn get_recent_sessions(sessions: &[SessionRecord], limit: usize) -> Vec<SessionRecord> {
    let mut sorted: Vec<&SessionRecord> = sessions.iter().collect();
    sorted.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    sorted.into_iter().take(limit).cloned().collect()
}

/// Group sessions by a field.
pub fn group_sessions(sessions: &[SessionRecord], group_by: &str) -> Vec<SessionGroup> {
    let mut groups: HashMap<String, Vec<SessionRecord>> = HashMap::new();

    for session in sessions {
        let key = match group_by {
            "status" => session.status.clone(),
            "type" => session.session_type.clone(),
            "repo" => session.repo_name.clone(),
            "date" => extract_date_group(&session.updated_at),
            _ => "other".to_string(),
        };

        groups.entry(key).or_default().push(session.clone());
    }

    let mut result: Vec<SessionGroup> = groups
        .into_iter()
        .map(|(key, sessions)| {
            let count = sessions.len();
            let label = format_group_label(group_by, &key);
            SessionGroup {
                group_key: key,
                label,
                sessions,
                count,
            }
        })
        .collect();

    result.sort_by_key(|entry| std::cmp::Reverse(entry.count));
    result
}

// ============================================================================
// Helpers
// ============================================================================

fn extract_date_group(timestamp: &str) -> String {
    if timestamp.len() >= 10 {
        timestamp[..10].to_string()
    } else {
        "unknown".to_string()
    }
}

fn format_group_label(group_by: &str, key: &str) -> String {
    match group_by {
        "status" => match key {
            "running" => "Running".to_string(),
            "completed" => "Completed".to_string(),
            "failed" => "Failed".to_string(),
            "pending" => "Pending".to_string(),
            "cancelled" => "Cancelled".to_string(),
            "paused" => "Paused".to_string(),
            _ => key.to_string(),
        },
        "type" => match key {
            "coding" | "sde" => "SDE Agent".to_string(),
            "cli" => "CLI Session".to_string(),
            "channel" | "os" => "OS Agent".to_string(),
            _ => key.to_string(),
        },
        _ => key.to_string(),
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
#[path = "tests/history_tests.rs"]
mod tests;

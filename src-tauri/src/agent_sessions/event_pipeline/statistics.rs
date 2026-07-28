//! Session Statistics Aggregation
//!
//! Computes aggregate statistics across session records without
//! needing to load the full event data. Works on session metadata only.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::agent_sessions::event_pipeline::history::{FileChangeStats, SessionRecord};

// ============================================================================
// Types
// ============================================================================

/// Aggregated statistics across multiple sessions.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatistics {
    /// Total number of sessions
    pub total_sessions: usize,
    /// Sessions by status
    pub by_status: Vec<StatusCount>,
    /// Sessions by type
    pub by_type: Vec<TypeCount>,
    /// Total file changes across all sessions
    pub total_file_changes: FileChangeStats,
    /// Total events across all sessions
    pub total_events: usize,
    /// Average events per session
    pub avg_events_per_session: f64,
    /// Most active repos
    pub top_repos: Vec<RepoActivity>,
    /// Most used models
    pub top_models: Vec<ModelUsage>,
    /// Activity over time (sessions bucketed by day)
    pub daily_activity: Vec<DailyActivity>,
    /// Sessions with most file changes
    pub most_impactful: Vec<ImpactfulSession>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusCount {
    pub status: String,
    pub count: usize,
    pub percentage: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeCount {
    pub session_type: String,
    pub count: usize,
    pub percentage: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoActivity {
    pub repo_id: String,
    pub repo_name: String,
    pub session_count: usize,
    pub total_events: usize,
    pub total_insertions: usize,
    pub total_deletions: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    pub model: String,
    pub session_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyActivity {
    /// Date in YYYY-MM-DD format
    pub date: String,
    pub session_count: usize,
    pub event_count: usize,
    pub insertions: usize,
    pub deletions: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImpactfulSession {
    pub session_id: String,
    pub name: String,
    pub total_changes: usize,
    pub insertions: usize,
    pub deletions: usize,
    pub files_changed: usize,
}

// ============================================================================
// Computation
// ============================================================================

/// Compute aggregate statistics from session records.
pub fn compute_session_statistics(sessions: &[SessionRecord]) -> SessionStatistics {
    if sessions.is_empty() {
        return empty_statistics();
    }

    let total = sessions.len();

    // Status counts
    let mut status_map: HashMap<String, usize> = HashMap::new();
    for session in sessions {
        *status_map.entry(session.status.clone()).or_insert(0) += 1;
    }
    let mut by_status: Vec<StatusCount> = status_map
        .into_iter()
        .map(|(status, count)| StatusCount {
            status,
            count,
            percentage: count as f64 / total as f64 * 100.0,
        })
        .collect();
    by_status.sort_by_key(|entry| std::cmp::Reverse(entry.count));

    // Type counts
    let mut type_map: HashMap<String, usize> = HashMap::new();
    for session in sessions {
        *type_map.entry(session.session_type.clone()).or_insert(0) += 1;
    }
    let mut by_type: Vec<TypeCount> = type_map
        .into_iter()
        .map(|(session_type, count)| TypeCount {
            session_type,
            count,
            percentage: count as f64 / total as f64 * 100.0,
        })
        .collect();
    by_type.sort_by_key(|entry| std::cmp::Reverse(entry.count));

    // File changes aggregate
    let mut total_file_changes = FileChangeStats::default();
    let mut total_events: usize = 0;

    for session in sessions {
        total_file_changes.added += session.file_changes.added;
        total_file_changes.deleted += session.file_changes.deleted;
        total_file_changes.modified += session.file_changes.modified;
        total_file_changes.insertion += session.file_changes.insertion;
        total_file_changes.deletion += session.file_changes.deletion;
        total_events += session.event_count;
    }

    let avg_events = total_events as f64 / total as f64;

    // Repo activity
    let mut repo_map: HashMap<String, RepoAccum> = HashMap::new();
    for session in sessions {
        let entry = repo_map
            .entry(session.repo_id.clone())
            .or_insert_with(|| RepoAccum {
                repo_name: session.repo_name.clone(),
                session_count: 0,
                total_events: 0,
                total_insertions: 0,
                total_deletions: 0,
            });
        entry.session_count += 1;
        entry.total_events += session.event_count;
        entry.total_insertions += session.file_changes.insertion;
        entry.total_deletions += session.file_changes.deletion;
    }
    let mut top_repos: Vec<RepoActivity> = repo_map
        .into_iter()
        .map(|(repo_id, acc)| RepoActivity {
            repo_id,
            repo_name: acc.repo_name,
            session_count: acc.session_count,
            total_events: acc.total_events,
            total_insertions: acc.total_insertions,
            total_deletions: acc.total_deletions,
        })
        .collect();
    top_repos.sort_by_key(|repo| std::cmp::Reverse(repo.session_count));
    top_repos.truncate(10);

    // Model usage
    let mut model_map: HashMap<String, usize> = HashMap::new();
    for session in sessions {
        if !session.model.is_empty() {
            *model_map.entry(session.model.clone()).or_insert(0) += 1;
        }
    }
    let mut top_models: Vec<ModelUsage> = model_map
        .into_iter()
        .map(|(model, count)| ModelUsage {
            model,
            session_count: count,
        })
        .collect();
    top_models.sort_by_key(|model| std::cmp::Reverse(model.session_count));

    // Daily activity
    let mut daily_map: HashMap<String, DailyAccum> = HashMap::new();
    for session in sessions {
        let date = if session.created_at.len() >= 10 {
            session.created_at[..10].to_string()
        } else {
            continue;
        };
        let entry = daily_map.entry(date).or_default();
        entry.session_count += 1;
        entry.event_count += session.event_count;
        entry.insertions += session.file_changes.insertion;
        entry.deletions += session.file_changes.deletion;
    }
    let mut daily_activity: Vec<DailyActivity> = daily_map
        .into_iter()
        .map(|(date, acc)| DailyActivity {
            date,
            session_count: acc.session_count,
            event_count: acc.event_count,
            insertions: acc.insertions,
            deletions: acc.deletions,
        })
        .collect();
    daily_activity.sort_by(|a, b| a.date.cmp(&b.date));

    // Most impactful sessions
    let mut impactful: Vec<ImpactfulSession> = sessions
        .iter()
        .map(|s| {
            let total_changes = s.file_changes.insertion + s.file_changes.deletion;
            ImpactfulSession {
                session_id: s.session_id.clone(),
                name: s.name.clone(),
                total_changes,
                insertions: s.file_changes.insertion,
                deletions: s.file_changes.deletion,
                files_changed: s.file_changes.added
                    + s.file_changes.deleted
                    + s.file_changes.modified,
            }
        })
        .collect();
    impactful.sort_by_key(|file| std::cmp::Reverse(file.total_changes));
    impactful.truncate(10);

    SessionStatistics {
        total_sessions: total,
        by_status,
        by_type,
        total_file_changes,
        total_events,
        avg_events_per_session: avg_events,
        top_repos,
        top_models,
        daily_activity,
        most_impactful: impactful,
    }
}

// ============================================================================
// Internal Accumulators
// ============================================================================

struct RepoAccum {
    repo_name: String,
    session_count: usize,
    total_events: usize,
    total_insertions: usize,
    total_deletions: usize,
}

#[derive(Default)]
struct DailyAccum {
    session_count: usize,
    event_count: usize,
    insertions: usize,
    deletions: usize,
}

fn empty_statistics() -> SessionStatistics {
    SessionStatistics {
        total_sessions: 0,
        by_status: Vec::new(),
        by_type: Vec::new(),
        total_file_changes: FileChangeStats::default(),
        total_events: 0,
        avg_events_per_session: 0.0,
        top_repos: Vec::new(),
        top_models: Vec::new(),
        daily_activity: Vec::new(),
        most_impactful: Vec::new(),
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
#[path = "tests/statistics_tests.rs"]
mod tests;

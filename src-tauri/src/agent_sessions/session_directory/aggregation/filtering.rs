//! `SessionFilter` predicates applied to merged directory rows.

use std::collections::HashSet;

use chrono::DateTime;
use core_types::key_source::KeySource;

use crate::agent_sessions::session_directory::display::matches_text_query;
use crate::agent_sessions::session_directory::types::{SessionAggregateRecord, SessionFilter};

// ============================================================================
// Filtering
// ============================================================================

fn parse_epoch_millis(timestamp: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(timestamp)
        .ok()
        .map(|parsed| parsed.timestamp_millis())
}

pub(super) fn apply_filters(
    sessions: &mut Vec<SessionAggregateRecord>,
    filter: &SessionFilter,
) -> Result<(), String> {
    if let Some(session_ids) = filter
        .session_ids
        .as_ref()
        .filter(|session_ids| !session_ids.is_empty())
    {
        let session_ids = session_ids
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        sessions.retain(|session| session_ids.contains(session.session_id.as_str()));
    }

    if let Some(ref category) = filter.category {
        let categories: Vec<&str> = category.split(',').map(|s| s.trim()).collect();
        sessions.retain(|session| {
            let cat_str = session.category.as_str();
            categories.contains(&cat_str)
                || (categories.contains(&"external_history")
                    && session.external_history_source.is_some())
        });
    }

    if let Some(ref external_history_source) = filter.external_history_source {
        sessions.retain(|session| {
            session.external_history_source.as_deref() == Some(external_history_source.as_str())
        });
    }

    if let Some(ref status) = filter.status {
        let statuses: Vec<&str> = status.split(',').map(|s| s.trim()).collect();
        sessions.retain(|session| statuses.contains(&session.status.as_str()));
    }

    if let Some(ref key_source) = filter.key_source {
        // Reject typo'd / unknown values instead of silently mapping them
        // to OwnKey, which would mis-filter the entire result set.
        let ks = KeySource::parse(key_source)
            .ok_or_else(|| format!("Unknown key_source filter: {key_source:?}"))?;
        sessions.retain(|session| session.key_source == ks);
    }

    if let Some(created_after_ms) = filter.created_after_ms {
        sessions.retain(|session| {
            parse_epoch_millis(&session.created_at)
                .map(|created_at_ms| created_at_ms >= created_after_ms)
                .unwrap_or(false)
        });
    }

    if let Some(created_before_ms) = filter.created_before_ms {
        sessions.retain(|session| {
            parse_epoch_millis(&session.created_at)
                .map(|created_at_ms| created_at_ms <= created_before_ms)
                .unwrap_or(false)
        });
    }

    if let Some(ref repo_path) = filter.repo_path {
        sessions.retain(|session| {
            session
                .repo_path
                .as_ref()
                .map(|p| p.starts_with(repo_path))
                .unwrap_or(false)
        });
    }

    if let Some(ref org_id) = filter.org_id {
        sessions.retain(|session| session.org_id.as_deref() == Some(org_id.as_str()));
    }

    if let Some(ref project_slug) = filter.project_slug {
        sessions.retain(|session| session.project_slug.as_deref() == Some(project_slug.as_str()));
    }

    if let Some(ref work_item_id) = filter.work_item_id {
        sessions.retain(|session| session.work_item_id.as_deref() == Some(work_item_id.as_str()));
    }

    // Text search filter
    if let Some(ref query) = filter.text_query {
        if !query.trim().is_empty() {
            sessions.retain(|session| matches_text_query(session, query));
        }
    }

    // Active only filter
    if filter.active_only == Some(true) {
        sessions.retain(|session| session.is_active);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_sessions::session_directory::aggregation::test_support::make_session;
    use crate::agent_sessions::session_directory::types::SessionCategory;

    #[test]
    fn apply_filters_accepts_known_key_source() {
        let mut sessions = vec![
            make_session("1", "running", SessionCategory::Cli, KeySource::OwnKey),
            make_session("2", "running", SessionCategory::Cli, KeySource::HostedKey),
        ];

        let filter = SessionFilter {
            key_source: Some("hosted_key".to_string()),
            ..Default::default()
        };
        apply_filters(&mut sessions, &filter).expect("known key_source must be Ok");

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, "2");
    }

    #[test]
    fn apply_filters_matches_canonical_session_ids_exactly() {
        let mut sessions = vec![
            make_session(
                "session-1",
                "completed",
                SessionCategory::Cli,
                KeySource::OwnKey,
            ),
            make_session(
                "session-10",
                "completed",
                SessionCategory::Cli,
                KeySource::OwnKey,
            ),
        ];
        let filter = SessionFilter {
            session_ids: Some(vec!["session-1".to_string()]),
            ..Default::default()
        };

        apply_filters(&mut sessions, &filter).expect("session ID filter");

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, "session-1");
    }

    #[test]
    fn apply_filters_rejects_unknown_key_source() {
        let mut sessions = vec![make_session(
            "1",
            "running",
            SessionCategory::Cli,
            KeySource::OwnKey,
        )];

        let filter = SessionFilter {
            // Typo: missing "_key" suffix. Previously silently mapped to
            // OwnKey and mis-filtered the entire response.
            key_source: Some("market".to_string()),
            ..Default::default()
        };
        let err =
            apply_filters(&mut sessions, &filter).expect_err("unknown key_source must be rejected");
        assert!(
            err.contains("Unknown key_source filter"),
            "expected explicit rejection, got: {err}"
        );
    }
}

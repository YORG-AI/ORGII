//! Offset/limit slicing for merged directory rows.

use crate::agent_sessions::session_directory::types::{SessionAggregateRecord, SessionFilter};

// ============================================================================
// Pagination
// ============================================================================

pub(super) fn apply_pagination(sessions: &mut Vec<SessionAggregateRecord>, filter: &SessionFilter) {
    if let Some(offset) = filter.offset {
        if offset < sessions.len() {
            *sessions = sessions.drain(offset..).collect();
        } else {
            sessions.clear();
        }
    }
    if let Some(limit) = filter.limit {
        sessions.truncate(limit);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_sessions::session_directory::aggregation::test_support::make_session;
    use crate::agent_sessions::session_directory::types::SessionCategory;
    use core_types::key_source::KeySource;

    #[test]
    fn pagination_does_not_append_org_member_children_for_visible_roots() {
        let root = make_session(
            "root-session",
            "running",
            SessionCategory::Agent,
            KeySource::OwnKey,
        );
        let mut paged_sessions = vec![root];
        let filter = SessionFilter {
            limit: Some(1),
            ..Default::default()
        };
        apply_pagination(&mut paged_sessions, &filter);

        assert_eq!(
            paged_sessions
                .iter()
                .map(|session| session.session_id.as_str())
                .collect::<Vec<_>>(),
            vec!["root-session"]
        );
    }
}

//! Ordering for merged directory rows.

use crate::agent_sessions::session_directory::types::{SessionAggregateRecord, SessionFilter};

// ============================================================================
// Sorting
// ============================================================================

pub(super) fn apply_sorting(
    sessions: &mut [SessionAggregateRecord],
    filter: Option<&SessionFilter>,
) {
    let sort_by = filter
        .as_ref()
        .and_then(|f| f.sort_by.as_deref())
        .unwrap_or("updated_at");
    let sort_desc = filter
        .as_ref()
        .and_then(|f| f.sort_order.as_deref())
        .map(|order| order != "asc")
        .unwrap_or(true);

    match sort_by {
        "created_at" => {
            if sort_desc {
                sessions.sort_by(|a, b| b.created_at.cmp(&a.created_at));
            } else {
                sessions.sort_by(|a, b| a.created_at.cmp(&b.created_at));
            }
        }
        "name" => {
            if sort_desc {
                sessions.sort_by_key(|session| std::cmp::Reverse(session.name.to_lowercase()));
            } else {
                sessions.sort_by_key(|a| a.name.to_lowercase());
            }
        }
        _ => {
            // Default: updated_at
            if sort_desc {
                sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
            } else {
                sessions.sort_by(|a, b| a.updated_at.cmp(&b.updated_at));
            }
        }
    }
}

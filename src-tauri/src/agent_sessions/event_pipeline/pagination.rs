//! Event Pagination — Cursor-based event loading with filtering
//!
//! Provides efficient paginated access to events stored in the EventStore.
//! Supports:
//! - Cursor-based pagination (forward/backward)
//! - Source filtering (user/assistant/system)
//! - Display variant filtering (tool_call, message, thinking, etc.)
//! - Combined filters
//!
//! All filtering and pagination happens in Rust, avoiding transferring
//! the full event array to the frontend.

use serde::{Deserialize, Serialize};

use crate::agent_sessions::event_pipeline::types::{
    EventDisplayVariant, EventSource, SessionEvent,
};

// ============================================================================
// Request / Response Types
// ============================================================================

/// Pagination request from the frontend.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaginationRequest {
    /// Maximum number of events to return
    pub limit: usize,
    /// Cursor: event ID to start after (forward) or before (backward).
    /// `None` means start from the beginning (forward) or end (backward).
    pub cursor: Option<String>,
    /// Direction of pagination
    #[serde(default)]
    pub direction: PaginationDirection,
    /// Optional filters
    #[serde(default)]
    pub filters: EventFilters,
}

/// Direction of cursor-based pagination.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum PaginationDirection {
    /// Newer events (default)
    #[default]
    Forward,
    /// Older events
    Backward,
}

/// Filters applied to the event stream before pagination.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventFilters {
    /// Filter by event source
    pub source: Option<EventSource>,
    /// Filter by display variant
    pub display_variant: Option<EventDisplayVariant>,
    /// Filter by function name (exact match)
    pub function_name: Option<String>,
    /// Only events with a file_path
    pub has_file_path: Option<bool>,
    /// Filter by file path prefix
    pub file_path_prefix: Option<String>,
    /// Text search in display_text (case-insensitive contains)
    pub text_query: Option<String>,
    /// Only events after this timestamp (inclusive, ISO 8601)
    pub after_timestamp: Option<String>,
    /// Only events before this timestamp (inclusive, ISO 8601)
    pub before_timestamp: Option<String>,
}

/// Paginated response sent to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaginatedEvents {
    /// The page of events
    pub events: Vec<SessionEvent>,
    /// Cursor to fetch the next page (None if no more)
    pub next_cursor: Option<String>,
    /// Cursor to fetch the previous page (None if at start)
    pub prev_cursor: Option<String>,
    /// Total number of events matching the filters (without pagination)
    pub total_matching: usize,
    /// Whether there are more events in the current direction
    pub has_more: bool,
}

// ============================================================================
// Implementation
// ============================================================================

/// Execute a paginated query over the event store.
///
/// 1. Apply filters to produce a filtered view
/// 2. Locate the cursor position
/// 3. Slice the requested page
/// 4. Return with next/prev cursors
pub fn paginate_events(events: &[SessionEvent], request: &PaginationRequest) -> PaginatedEvents {
    // Step 1: Filter
    let filtered: Vec<&SessionEvent> = events
        .iter()
        .filter(|evt| matches_filters(evt, &request.filters))
        .collect();

    let total_matching = filtered.len();

    if filtered.is_empty() || request.limit == 0 {
        return PaginatedEvents {
            events: Vec::new(),
            next_cursor: None,
            prev_cursor: None,
            total_matching,
            has_more: false,
        };
    }

    // Step 2: Find cursor position
    let cursor_idx = if let Some(ref cursor_id) = request.cursor {
        filtered.iter().position(|evt| evt.id == *cursor_id)
    } else {
        None
    };

    // Step 3: Slice based on direction
    let (page, has_more, has_prev) = match request.direction {
        PaginationDirection::Forward => {
            let start = match cursor_idx {
                Some(idx) => idx + 1, // start after cursor
                None => 0,            // start from beginning
            };
            if start >= filtered.len() {
                (Vec::new(), false, start > 0)
            } else {
                let end = (start + request.limit).min(filtered.len());
                let page: Vec<SessionEvent> =
                    filtered[start..end].iter().map(|e| (*e).clone()).collect();
                let has_more = end < filtered.len();
                let has_prev = start > 0;
                (page, has_more, has_prev)
            }
        }
        PaginationDirection::Backward => {
            let end = match cursor_idx {
                Some(idx) => idx, // end before cursor
                None => filtered.len(),
            };
            if end == 0 {
                (Vec::new(), false, false)
            } else {
                let start = end.saturating_sub(request.limit);
                let page: Vec<SessionEvent> =
                    filtered[start..end].iter().map(|e| (*e).clone()).collect();
                let has_more = start > 0;
                let has_prev = start > 0;
                (page, has_more, has_prev)
            }
        }
    };

    // Step 4: Build cursors
    let next_cursor = if has_more {
        page.last().map(|evt| evt.id.clone())
    } else {
        None
    };

    let prev_cursor = if has_prev {
        page.first().map(|evt| evt.id.clone())
    } else {
        None
    };

    PaginatedEvents {
        events: page,
        next_cursor,
        prev_cursor,
        total_matching,
        has_more,
    }
}

/// Count events matching filters without returning them.
pub fn count_matching_events(events: &[SessionEvent], filters: &EventFilters) -> usize {
    events
        .iter()
        .filter(|evt| matches_filters(evt, filters))
        .count()
}

/// Get distinct function names used in events.
pub fn get_distinct_functions(events: &[SessionEvent]) -> Vec<FunctionUsageCount> {
    let mut counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for event in events {
        if !event.function_name.is_empty() {
            *counts.entry(event.function_name.clone()).or_insert(0) += 1;
        }
    }
    let mut result: Vec<FunctionUsageCount> = counts
        .into_iter()
        .map(|(name, count)| FunctionUsageCount {
            function_name: name,
            count,
        })
        .collect();
    result.sort_by_key(|entry| std::cmp::Reverse(entry.count));
    result
}

/// Function name with usage count for filter dropdowns.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionUsageCount {
    pub function_name: String,
    pub count: usize,
}

// ============================================================================
// Filter Matching
// ============================================================================

fn matches_filters(event: &SessionEvent, filters: &EventFilters) -> bool {
    if let Some(ref source) = filters.source {
        if event.source != *source {
            return false;
        }
    }

    if let Some(ref variant) = filters.display_variant {
        if event.display_variant != *variant {
            return false;
        }
    }

    if let Some(ref fn_name) = filters.function_name {
        if event.function_name != *fn_name {
            return false;
        }
    }

    if let Some(has_fp) = filters.has_file_path {
        let event_has = event.file_path.as_ref().is_some_and(|p| !p.is_empty());
        if event_has != has_fp {
            return false;
        }
    }

    if let Some(ref prefix) = filters.file_path_prefix {
        match &event.file_path {
            Some(fp) if fp.starts_with(prefix.as_str()) => {}
            _ => return false,
        }
    }

    if let Some(ref query) = filters.text_query {
        let lower_query = query.to_lowercase();
        let lower_text = event.display_text.to_lowercase();
        if !lower_text.contains(&lower_query) {
            return false;
        }
    }

    if let Some(ref after) = filters.after_timestamp {
        if event.created_at.as_str() < after.as_str() {
            return false;
        }
    }

    if let Some(ref before) = filters.before_timestamp {
        if event.created_at.as_str() > before.as_str() {
            return false;
        }
    }

    true
}

#[cfg(test)]
#[path = "tests/pagination_tests.rs"]
mod tests;

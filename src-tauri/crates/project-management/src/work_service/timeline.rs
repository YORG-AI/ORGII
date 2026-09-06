//! Merged Work Item timeline: field history and Discussion comments in one
//! time-ordered stream for the `org2-pm work timeline` CLI.

use serde::Serialize;

use crate::projects::types::{CommentEntry, WorkItemData, WorkItemHistoryEvent};

#[derive(Debug, Clone, Copy, Default)]
pub struct TimelineFilter<'a> {
    pub since: Option<&'a str>,
    pub tail: Option<usize>,
    pub activity_only: bool,
    pub comments_only: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum TimelineEntry {
    #[serde(rename_all = "camelCase")]
    Activity {
        id: String,
        at: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        actor_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        actor_name: Option<String>,
        action: crate::projects::types::WorkItemHistoryAction,
        #[serde(skip_serializing_if = "Option::is_none")]
        summary: Option<String>,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        changes: Vec<crate::projects::types::WorkItemHistoryChange>,
    },
    #[serde(rename_all = "camelCase")]
    Comment {
        id: String,
        at: String,
        author: String,
        content: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        parent_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        thread_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        originator: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        resolved_at: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        edited_at: Option<String>,
    },
}

impl TimelineEntry {
    fn at(&self) -> &str {
        match self {
            TimelineEntry::Activity { at, .. } | TimelineEntry::Comment { at, .. } => at,
        }
    }

    fn from_history(event: &WorkItemHistoryEvent) -> Self {
        TimelineEntry::Activity {
            id: event.id.clone(),
            at: event.timestamp.clone(),
            actor_id: event.actor_id.clone(),
            actor_name: event.actor_name.clone(),
            action: event.action.clone(),
            summary: event.summary.clone(),
            changes: event.changes.clone(),
        }
    }

    fn from_comment(comment: &CommentEntry) -> Self {
        TimelineEntry::Comment {
            id: comment.id.clone(),
            at: comment.created_at.clone(),
            author: comment.author.clone(),
            content: comment.content.clone(),
            parent_id: comment.parent_id.clone(),
            thread_id: comment.thread_id.clone(),
            originator: comment.originator.clone(),
            resolved_at: comment.resolved_at.clone(),
            edited_at: comment.edited_at.clone(),
        }
    }
}

fn instant_ms(raw: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|value| value.timestamp_millis())
}

fn is_at_or_after(at: &str, since: &str) -> bool {
    match (instant_ms(at), instant_ms(since)) {
        (Some(at), Some(since)) => at >= since,
        _ => at >= since,
    }
}

/// Stable sort keeps history ahead of comments for equal instants so the
/// stream mirrors the desktop timeline ordering.
pub fn work_item_timeline(item: &WorkItemData, filter: TimelineFilter<'_>) -> Vec<TimelineEntry> {
    let mut entries = Vec::new();
    if !filter.comments_only {
        entries.extend(
            item.frontmatter
                .history
                .iter()
                .map(TimelineEntry::from_history),
        );
    }
    if !filter.activity_only {
        entries.extend(
            item.frontmatter
                .comments
                .iter()
                .filter(|comment| comment.deleted_at.is_none())
                .map(TimelineEntry::from_comment),
        );
    }
    entries.sort_by(
        |left, right| match (instant_ms(left.at()), instant_ms(right.at())) {
            (Some(left), Some(right)) => left.cmp(&right),
            _ => left.at().cmp(right.at()),
        },
    );
    if let Some(since) = filter.since {
        entries.retain(|entry| is_at_or_after(entry.at(), since));
    }
    if let Some(tail) = filter.tail {
        let skip = entries.len().saturating_sub(tail);
        entries.drain(..skip);
    }
    entries
}

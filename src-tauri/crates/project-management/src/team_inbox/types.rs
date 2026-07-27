use serde::{Deserialize, Serialize};

/// Sources supported by the stable Team Inbox wire contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamInboxFilter {
    All,
    Mentions,
    Assigned,
}

impl Default for TeamInboxFilter {
    fn default() -> Self {
        Self::All
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamInboxItemKind {
    CommentMention,
    WorkItemAssigned,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamInboxActor {
    pub id: String,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum TeamInboxTarget {
    Comment {
        session_id: String,
        comment_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        anchor: Option<String>,
    },
    WorkItem {
        work_item_id: String,
        short_id: String,
        org_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        project_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        project_slug: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum TeamInboxPayload {
    CommentMention {
        session_title: String,
        comment_excerpt: String,
        comment_count: u32,
    },
    WorkItemAssigned {
        title: String,
        status: String,
        priority: String,
        assignee_member_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        summary: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamInboxItem {
    pub id: String,
    pub kind: TeamInboxItemKind,
    pub occurred_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor: Option<TeamInboxActor>,
    pub target: TeamInboxTarget,
    pub payload: TeamInboxPayload,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamInboxCursor {
    pub occurred_at: i64,
    pub item_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamInboxPage {
    pub items: Vec<TeamInboxItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<TeamInboxCursor>,
    pub unread_count: u64,
}

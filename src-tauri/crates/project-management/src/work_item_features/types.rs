use serde::{Deserialize, Serialize};

use crate::projects::types::{CommentEntry, MentionTarget, WorkItemRun};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkItemScope {
    pub project_slug: Option<String>,
    #[serde(default = "default_org_id")]
    pub org_id: String,
    pub work_item_id: String,
}

fn default_org_id() -> String {
    "personal-org".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscussionPostRequest {
    #[serde(flatten)]
    pub scope: WorkItemScope,
    pub comment_id: String,
    pub author_id: String,
    pub author_name: String,
    pub content: String,
    #[serde(default)]
    pub mentioned_user_ids: Vec<String>,
    #[serde(default)]
    pub mentions: Vec<MentionTarget>,
    pub parent_id: Option<String>,
    pub target_session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscussionPostResult {
    pub comment: CommentEntry,
    pub run: Option<WorkItemRun>,
    pub thread_reopened: bool,
    pub wake_reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscussionTriggerPreview {
    pub will_wake: bool,
    pub reason: String,
    pub target_session_id: Option<String>,
    #[serde(default)]
    pub target_kind: Option<String>,
    #[serde(default)]
    pub will_coalesce: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscussionTriggerPreviewRequest {
    #[serde(flatten)]
    pub scope: WorkItemScope,
    pub content: String,
    #[serde(default)]
    pub mentions: Vec<MentionTarget>,
    #[serde(default)]
    pub parent_id: Option<String>,
    pub target_session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscussionThreadMutation {
    #[serde(flatten)]
    pub scope: WorkItemScope,
    pub thread_id: String,
    pub actor_id: String,
    pub conclusion_comment_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubscriptionReason {
    Creator,
    Assignee,
    Commenter,
    Mentioned,
    Manual,
    Agent,
    Delegated,
}

impl SubscriptionReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Creator => "creator",
            Self::Assignee => "assignee",
            Self::Commenter => "commenter",
            Self::Mentioned => "mentioned",
            Self::Manual => "manual",
            Self::Agent => "agent",
            Self::Delegated => "delegated",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkItemSubscription {
    pub subscriber_id: String,
    pub reason: SubscriptionReason,
    pub created_at: String,
    pub muted_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionMutation {
    #[serde(flatten)]
    pub scope: WorkItemScope,
    pub subscriber_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PropertyType {
    Text,
    Number,
    Select,
    MultiSelect,
    Date,
    Checkbox,
    Url,
}

impl PropertyType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Number => "number",
            Self::Select => "select",
            Self::MultiSelect => "multi_select",
            Self::Date => "date",
            Self::Checkbox => "checkbox",
            Self::Url => "url",
        }
    }
}

impl TryFrom<&str> for PropertyType {
    type Error = String;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "text" => Ok(Self::Text),
            "number" => Ok(Self::Number),
            "select" => Ok(Self::Select),
            "multi_select" => Ok(Self::MultiSelect),
            "date" => Ok(Self::Date),
            "checkbox" => Ok(Self::Checkbox),
            "url" => Ok(Self::Url),
            other => Err(format!("unknown property type '{other}'")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PropertyOption {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PropertyConfig {
    #[serde(default)]
    pub options: Vec<PropertyOption>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PropertyDefinition {
    pub id: String,
    pub org_id: String,
    pub name: String,
    pub property_type: PropertyType,
    pub description: Option<String>,
    pub config: PropertyConfig,
    pub position: i64,
    pub archived_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertPropertyDefinitionRequest {
    pub id: Option<String>,
    pub org_id: String,
    pub name: String,
    pub property_type: PropertyType,
    pub description: Option<String>,
    #[serde(default)]
    pub config: PropertyConfig,
    #[serde(default)]
    pub position: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkItemPropertyValue {
    pub definition: PropertyDefinition,
    pub value: serde_json::Value,
    pub updated_at: String,
}

/// Durable collaboration projection for one typed-property value.
///
/// A JSON `null` value is a tombstone. Keeping clears on the wire avoids
/// resurrecting an older value when another device pulls after the clear.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncedWorkItemPropertyValue {
    pub property_id: String,
    pub value: serde_json::Value,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TypedPropertyWireSnapshot {
    #[serde(default)]
    pub definitions: Vec<PropertyDefinition>,
    #[serde(default)]
    pub values: Vec<SyncedWorkItemPropertyValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetWorkItemPropertyValueRequest {
    #[serde(flatten)]
    pub scope: WorkItemScope,
    pub property_id: String,
    pub value: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrReadiness {
    pub state: String,
    pub pr_url: Option<String>,
    pub pr_status: Option<String>,
    pub is_draft: bool,
    pub mergeable: Option<bool>,
    pub ci_status: Option<String>,
    pub failed_checks: Vec<String>,
    pub other_open_prs: Vec<String>,
    pub snapshot_stale: bool,
    pub close_intent: bool,
    pub can_complete: bool,
    pub blockers: Vec<String>,
    pub evidence_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineWebhookInstallInfo {
    pub routine_name: String,
    pub url_path: String,
    pub secret: String,
    pub secret_hint: String,
    pub rotated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineWebhookStatus {
    pub routine_name: String,
    pub installed: bool,
    pub enabled: bool,
    pub secret_hint: Option<String>,
    pub consecutive_failures: u32,
    pub paused_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineWebhookDelivery {
    pub id: String,
    pub routine_name: String,
    pub provider: String,
    pub event_kind: String,
    pub idempotency_key: String,
    pub status: String,
    pub reason: Option<String>,
    pub routine_run_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

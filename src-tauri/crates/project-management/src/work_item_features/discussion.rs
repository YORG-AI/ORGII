use rusqlite::{params, TransactionBehavior};

use super::store::{append_audit, persist_extras, resolve_work_item};
use super::subscriptions;
use super::{
    DiscussionDeleteRequest, DiscussionEditRequest, DiscussionPostRequest, DiscussionPostResult,
    DiscussionThreadMutation, DiscussionTriggerPreview, DiscussionTriggerPreviewRequest,
    WorkItemScope,
};
use crate::projects::io::helpers::{conn, now_ms};
use crate::projects::types::{
    CommentEntry, EnqueueWorkItemRunRequest, LinkedSession, MentionTarget, OrchestratorConfig,
    WorkItemRunTarget, WorkItemRunTargetSnapshot, WorkItemRunTrigger,
};

fn is_note_only(content: &str) -> bool {
    let trimmed = content.trim_start();
    trimmed == "/note" || trimmed.starts_with("/note ") || trimmed.starts_with("/note\n")
}

fn latest_top_level_session(extras: &serde_json::Value) -> Option<String> {
    let mut sessions = extras
        .get("linked_sessions")
        .cloned()
        .and_then(|value| serde_json::from_value::<Vec<LinkedSession>>(value).ok())
        .unwrap_or_default()
        .into_iter()
        .filter(|session| session.parent_session_id.is_none())
        .collect::<Vec<_>>();
    sessions.sort_by(|left, right| right.started_at.cmp(&left.started_at));
    sessions.first().map(|session| session.session_id.clone())
}

fn orchestrator_config(extras: &serde_json::Value) -> Option<OrchestratorConfig> {
    extras
        .get("orchestrator_config")
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
}

#[derive(Debug, Clone, PartialEq)]
pub(super) enum RouteTarget {
    Resume { session_id: String },
    Start,
}

/// An execution target supplied by a trusted internal producer. Normal user
/// comments still pass through [`mention_route`], which only permits the Work
/// Item's configured agent. Quick Actions use this override because their
/// saved target is itself the authorized routing decision.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum StartTargetOverride {
    AgentDefinition(String),
    AgentOrg(String),
}

impl StartTargetOverride {
    fn apply_to_snapshot(&self, snapshot: &mut WorkItemRunTargetSnapshot) {
        match self {
            Self::AgentDefinition(id) => snapshot.agent_definition_id = Some(id.clone()),
            Self::AgentOrg(id) => snapshot.agent_org_id = Some(id.clone()),
        }
    }
}

#[derive(Debug, Clone)]
pub(super) struct RouteDecision {
    pub will_wake: bool,
    pub reason: String,
    pub target: Option<RouteTarget>,
}

impl RouteDecision {
    fn silent(reason: &str) -> Self {
        Self {
            will_wake: false,
            reason: reason.to_string(),
            target: None,
        }
    }

    fn wake(reason: &str, target: RouteTarget) -> Self {
        Self {
            will_wake: true,
            reason: reason.to_string(),
            target: Some(target),
        }
    }

    pub(super) fn resume_session_id(&self) -> Option<String> {
        match &self.target {
            Some(RouteTarget::Resume { session_id }) => Some(session_id.clone()),
            _ => None,
        }
    }

    fn initial_delay_ms(&self) -> i64 {
        if self.reason == "assignee_deferred" {
            ASSIGNEE_ESCALATION_DELAY_MS
        } else {
            DISCUSSION_WAKE_WINDOW_MS
        }
    }

    fn coalescing_cap_ms(&self) -> Option<i64> {
        (self.reason != "assignee_deferred").then_some(DISCUSSION_WAKE_CAP_MS)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum MentionAudience<'a> {
    Assigned,
    NoAgent { human_addressed: bool },
    Agent { id: &'a str },
    AgentOrg { id: &'a str },
}

#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
enum ConfiguredAgentAudience {
    None,
    Assigned,
    Explicit,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct MessageAudiencePolicy {
    default_agent_mode: ConfiguredAgentAudience,
    human_agent_mode: ConfiguredAgentAudience,
    explicit_agent_mode: ConfiguredAgentAudience,
    explicit_agent_wins: bool,
}

#[derive(Debug, serde::Deserialize)]
struct MessageAudiencePolicies {
    work_item_comment: MessageAudiencePolicy,
}

fn work_item_audience_policy() -> &'static MessageAudiencePolicy {
    static POLICIES: std::sync::OnceLock<MessageAudiencePolicies> = std::sync::OnceLock::new();
    &POLICIES
        .get_or_init(|| {
            serde_json::from_str(include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../../src/features/TeamCollaboration/messageAudienceRouting.policy.json"
            )))
            .expect("checked-in message audience policy must be valid")
        })
        .work_item_comment
}

fn configured_mention_audience<'a>(
    mode: ConfiguredAgentAudience,
    explicit_agent: Option<MentionAudience<'a>>,
    human_addressed: bool,
) -> MentionAudience<'a> {
    match mode {
        ConfiguredAgentAudience::None => MentionAudience::NoAgent { human_addressed },
        ConfiguredAgentAudience::Assigned => MentionAudience::Assigned,
        ConfiguredAgentAudience::Explicit => explicit_agent
            .expect("explicit Agent audience mode requires an Agent or Agent Org target"),
    }
}

/// Classify identity-stable mentions with the shared audience policy before
/// applying Work Item fallback rules. Identity parsing remains local; target
/// precedence and Agent execution modes come from the cross-surface contract.
pub(super) fn mention_audience(mentions: &[MentionTarget]) -> MentionAudience<'_> {
    let policy = work_item_audience_policy();
    let explicit_agent = mentions.iter().find_map(|mention| match mention {
        MentionTarget::Agent { id } => Some(MentionAudience::Agent { id }),
        MentionTarget::AgentOrg { id } => Some(MentionAudience::AgentOrg { id }),
        MentionTarget::Member { .. } | MentionTarget::All => None,
    });
    let human_addressed = mentions
        .iter()
        .any(|mention| matches!(mention, MentionTarget::Member { .. } | MentionTarget::All));
    if explicit_agent.is_some() && policy.explicit_agent_wins {
        return configured_mention_audience(
            policy.explicit_agent_mode,
            explicit_agent,
            human_addressed,
        );
    }
    if human_addressed {
        configured_mention_audience(policy.human_agent_mode, explicit_agent, true)
    } else {
        configured_mention_audience(policy.default_agent_mode, explicit_agent, false)
    }
}

/// Route the normalized mention audience. Human-directed comments deliberately
/// return a silent decision instead of falling through to the assigned Agent.
fn mention_audience_route(
    mentions: &[MentionTarget],
    extras: &serde_json::Value,
) -> Option<RouteDecision> {
    let config = orchestrator_config(extras);
    let matches_config = match mention_audience(mentions) {
        MentionAudience::Assigned => return None,
        MentionAudience::NoAgent {
            human_addressed: true,
        } => return Some(RouteDecision::silent("member_addressed")),
        MentionAudience::NoAgent {
            human_addressed: false,
        } => return Some(RouteDecision::silent("audience_none")),
        MentionAudience::Agent { id } => {
            config
                .as_ref()
                .and_then(|config| config.agent_definition_id.as_deref())
                == Some(id)
        }
        MentionAudience::AgentOrg { id } => {
            config.as_ref().and_then(|config| config.org_id.as_deref()) == Some(id)
        }
    };
    if !matches_config {
        return Some(RouteDecision::silent("mention_unroutable"));
    }
    Some(match latest_top_level_session(extras) {
        Some(session_id) => RouteDecision::wake("mention", RouteTarget::Resume { session_id }),
        None => RouteDecision::wake("mention_start", RouteTarget::Start),
    })
}

/// Route a reply through its thread: the session the thread root woke first,
/// falling back to the newest session referenced anywhere in the thread.
fn thread_route(comments: &[CommentEntry], parent_id: &str) -> Option<RouteDecision> {
    let root_id = comments
        .iter()
        .find(|comment| comment.id == parent_id)
        .map(|comment| {
            comment
                .thread_id
                .clone()
                .unwrap_or_else(|| comment.id.clone())
        })?;
    let in_thread = |comment: &&CommentEntry| {
        comment.id == root_id || comment.thread_id.as_deref() == Some(root_id.as_str())
    };
    if let Some(session_id) = comments
        .iter()
        .find(|comment| comment.id == root_id)
        .and_then(|comment| comment.agent_session_id.clone())
    {
        return Some(RouteDecision::wake(
            "thread_owner",
            RouteTarget::Resume { session_id },
        ));
    }
    if let Some(session_id) = comments
        .iter()
        .rev()
        .filter(in_thread)
        .find_map(|comment| comment.agent_session_id.clone())
    {
        return Some(RouteDecision::wake(
            "thread_continuation",
            RouteTarget::Resume { session_id },
        ));
    }
    None
}

fn assignee_route(extras: &serde_json::Value) -> Option<RouteDecision> {
    let config = orchestrator_config(extras)?;
    if config.agent_definition_id.is_none() && config.org_id.is_none() {
        return None;
    }
    Some(match latest_top_level_session(extras) {
        Some(session_id) => {
            RouteDecision::wake("assignee_deferred", RouteTarget::Resume { session_id })
        }
        None => RouteDecision::wake("assignee_deferred", RouteTarget::Start),
    })
}

/// The Discussion routing decision: who a comment wakes and why.
/// Precedence: `/note` > explicit session target > typed mention audience >
/// reply thread inference > agent assignee > latest linked session. Replies to
/// an explicitly human-addressed root remain human unless an Agent has joined.
pub(super) fn route_comment(
    content: &str,
    explicit_target: Option<&str>,
    mentions: &[MentionTarget],
    parent_id: Option<&str>,
    comments: &[CommentEntry],
    extras: &serde_json::Value,
) -> RouteDecision {
    if is_note_only(content) {
        return RouteDecision::silent("note_only");
    }
    if let Some(target) = explicit_target
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return RouteDecision::wake(
            "explicit_target",
            RouteTarget::Resume {
                session_id: target.to_string(),
            },
        );
    }
    if let Some(decision) = mention_audience_route(mentions, extras) {
        return decision;
    }
    if let Some(decision) = parent_id.and_then(|parent| thread_route(comments, parent)) {
        return decision;
    }
    // A reply whose thread has no agent participation is a conversation
    // between members; falling through would drag the assignee (or the
    // latest session) into a thread nobody addressed to an agent.
    if parent_id.is_some() {
        return RouteDecision::silent("member_thread");
    }
    if let Some(decision) = assignee_route(extras) {
        return decision;
    }
    if let Some(session_id) = latest_top_level_session(extras) {
        return RouteDecision::wake("latest_session", RouteTarget::Resume { session_id });
    }
    RouteDecision::silent("no_linked_session")
}

/// A context-exhausted Session must never receive another resume turn. Keep
/// the same owning agent from the failed Run snapshot, but route the next
/// Discussion turn through a fresh execution episode.
fn freshen_context_exhausted_target(
    connection: &rusqlite::Connection,
    mut decision: RouteDecision,
) -> Result<(RouteDecision, Option<StartTargetOverride>), String> {
    let Some(RouteTarget::Resume { session_id }) = decision.target.as_ref() else {
        return Ok((decision, None));
    };
    let Some(snapshot) =
        crate::work_run_service::context_exhausted_session_snapshot_in(connection, session_id)?
    else {
        return Ok((decision, None));
    };
    let target_override = snapshot
        .agent_definition_id
        .map(StartTargetOverride::AgentDefinition)
        .or_else(|| snapshot.agent_org_id.map(StartTargetOverride::AgentOrg));
    decision.target = Some(RouteTarget::Start);
    // Keep the assignee fallback's stable reason: it is the durable marker
    // used by both the five-minute delay and the cancellation fence. Only the
    // target changes from resume to a fresh start after context exhaustion.
    if decision.reason != "assignee_deferred" {
        decision.reason = format!("{}_fresh_after_context_overflow", decision.reason);
    }
    Ok((decision, target_override))
}

fn preview_from_decision(decision: &RouteDecision) -> DiscussionTriggerPreview {
    DiscussionTriggerPreview {
        will_wake: decision.will_wake,
        reason: decision.reason.clone(),
        target_session_id: decision.resume_session_id(),
        target_kind: decision.target.as_ref().map(|target| {
            match target {
                RouteTarget::Resume { .. } => "resume",
                RouteTarget::Start => "start",
            }
            .to_string()
        }),
        will_coalesce: false,
    }
}

fn open_wake_window_exists(
    connection: &rusqlite::Connection,
    scope_key: &str,
    work_item_id: &str,
    target: &WorkItemRunTarget,
) -> bool {
    let Ok(mut statement) = connection.prepare(
        "SELECT r.target_json FROM pm_work_item_runs r
           JOIN pm_dispatch_outbox d ON d.run_id = r.id AND d.status = 'pending'
          WHERE r.scope_key = ?1 AND r.work_item_id = ?2 AND r.status = 'queued'
            AND r.idempotency_key LIKE 'discussion-wake:%'",
    ) else {
        return false;
    };
    statement
        .query_map(params![scope_key, work_item_id], |row| {
            row.get::<_, String>(0)
        })
        .map(|rows| {
            rows.filter_map(Result::ok)
                .any(|target_json| same_wake_target(&target_json, target, None))
        })
        .unwrap_or(false)
}

/// Debounce window: a wake run stays merge-open this long after the latest
/// comment, so consecutive comments dispatch as one wake.
const DISCUSSION_WAKE_WINDOW_MS: i64 = 15_000;
/// Hard ceiling from the anchor comment — continuous typing cannot postpone
/// the wake forever.
const DISCUSSION_WAKE_CAP_MS: i64 = 120_000;
/// Unaddressed top-level comments give the assigned agent time to observe and
/// reply before the fallback run becomes dispatchable.
const ASSIGNEE_ESCALATION_DELAY_MS: i64 = 300_000;

fn same_wake_target(
    stored_target_json: &str,
    target: &WorkItemRunTarget,
    start_target_override: Option<&StartTargetOverride>,
) -> bool {
    serde_json::from_str::<WorkItemRunTargetSnapshot>(stored_target_json)
        .map(|snapshot| {
            let same_target = match (&snapshot.target, target) {
                (
                    WorkItemRunTarget::ResumeSession { session_id: stored },
                    WorkItemRunTarget::ResumeSession { session_id },
                ) => stored == session_id,
                (
                    WorkItemRunTarget::StartWorkItem { .. },
                    WorkItemRunTarget::StartWorkItem { .. },
                ) => true,
                _ => false,
            };
            same_target
                && match start_target_override {
                    Some(StartTargetOverride::AgentDefinition(id)) => {
                        snapshot.agent_definition_id.as_deref() == Some(id)
                    }
                    Some(StartTargetOverride::AgentOrg(id)) => {
                        snapshot.agent_org_id.as_deref() == Some(id)
                    }
                    None => true,
                }
        })
        .unwrap_or(false)
}

/// Merge a new waking comment into an open wake window: a queued
/// discussion run for the same target whose outbox row is still `pending`.
/// The conditional outbox update is the window gate — once the dispatcher
/// leases the row, the update misses and the caller opens a new window.
#[allow(clippy::too_many_arguments)]
fn merge_into_open_wake_window(
    tx: &rusqlite::Transaction<'_>,
    scope_key: &str,
    work_item_id: &str,
    target: &WorkItemRunTarget,
    start_target_override: Option<&StartTargetOverride>,
    delay_ms: i64,
    cap_ms: Option<i64>,
    comment: &CommentEntry,
    author_name: &str,
    short_id: &str,
    now: i64,
) -> Result<Option<String>, String> {
    let mut statement = tx
        .prepare(
            "SELECT id, input_json, target_json, created_at FROM pm_work_item_runs
              WHERE scope_key = ?1 AND work_item_id = ?2 AND status = 'queued'
                AND idempotency_key LIKE 'discussion-wake:%'
              ORDER BY created_at DESC",
        )
        .map_err(|err| format!("Discussion wake window query: {err}"))?;
    let candidates = statement
        .query_map(params![scope_key, work_item_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })
        .map_err(|err| format!("Discussion wake window rows: {err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("Discussion wake window rows: {err}"))?;
    drop(statement);

    for (run_id, input_json, target_json, created_at) in candidates {
        if !same_wake_target(&target_json, target, start_target_override) {
            continue;
        }
        let proposed_available_at = cap_ms.map_or_else(
            || now.saturating_add(delay_ms),
            |cap| {
                now.saturating_add(delay_ms)
                    .min(created_at.saturating_add(cap))
            },
        );
        let window_open = tx
            .execute(
                "UPDATE pm_dispatch_outbox
                    SET available_at = MAX(available_at, ?2), updated_at = ?3
                  WHERE run_id = ?1 AND status = 'pending'",
                params![run_id, proposed_available_at, now],
            )
            .map_err(|err| format!("Discussion wake window extend: {err}"))?;
        if window_open == 0 {
            continue;
        }
        let mut input: serde_json::Value = serde_json::from_str(&input_json)
            .map_err(|err| format!("Discussion wake input parse: {err}"))?;
        let already_merged = input
            .get("discussionCommentIds")
            .and_then(|value| value.as_array())
            .map(|ids| ids.iter().any(|id| id.as_str() == Some(&comment.id)))
            .unwrap_or(false);
        if !already_merged {
            let appended = format!(
                "{}\n\n{}",
                input.get("content").and_then(|v| v.as_str()).unwrap_or(""),
                build_forward_message(short_id, &comment.id, author_name, &comment.content)
            );
            input["content"] = serde_json::Value::String(appended);
            let ids = input
                .get("discussionCommentIds")
                .and_then(|value| value.as_array())
                .cloned()
                .unwrap_or_default();
            let mut ids = ids;
            ids.push(serde_json::Value::String(comment.id.clone()));
            let merged_count = ids.len();
            input["discussionCommentIds"] = serde_json::Value::Array(ids);
            input["displayText"] = serde_json::Value::String(format!("💬 {merged_count} comments"));
            tx.execute(
                "UPDATE pm_work_item_runs SET input_json = ?2, updated_at = ?3 WHERE id = ?1",
                params![
                    run_id,
                    serde_json::to_string(&input)
                        .map_err(|err| format!("Discussion wake input serialize: {err}"))?,
                    now
                ],
            )
            .map_err(|err| format!("Discussion wake input update: {err}"))?;
        }
        return Ok(Some(run_id));
    }
    Ok(None)
}

pub(super) fn preview(
    request: DiscussionTriggerPreviewRequest,
) -> Result<DiscussionTriggerPreview, String> {
    let connection = conn()?;
    let item = resolve_work_item(&connection, &request.scope)?;
    let comments = comments_from_extras(&item.extras);
    let decision = route_comment(
        &request.content,
        request.target_session_id.as_deref(),
        &request.mentions,
        request.parent_id.as_deref(),
        &comments,
        &item.extras,
    );
    let (decision, _) = freshen_context_exhausted_target(&connection, decision)?;
    let mut preview = preview_from_decision(&decision);
    if decision.will_wake {
        let run_target = match decision.target.clone() {
            Some(RouteTarget::Resume { session_id }) => {
                WorkItemRunTarget::ResumeSession { session_id }
            }
            _ => WorkItemRunTarget::StartWorkItem {
                account_id: None,
                model_id: None,
            },
        };
        preview.will_coalesce =
            open_wake_window_exists(&connection, &item.scope_key, &item.short_id, &run_target);
    }
    Ok(preview)
}

fn comments_from_extras(extras: &serde_json::Value) -> Vec<CommentEntry> {
    extras
        .get("comments")
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default()
}

fn store_comments(extras: &mut serde_json::Value, comments: &[CommentEntry]) -> Result<(), String> {
    let object = extras
        .as_object_mut()
        .ok_or_else(|| "work item extras must be a JSON object".to_string())?;
    object.insert(
        "comments".to_string(),
        serde_json::to_value(comments).map_err(|err| format!("Discussion serialization: {err}"))?,
    );
    Ok(())
}

fn build_forward_message(short_id: &str, comment_id: &str, author: &str, content: &str) -> String {
    [
        format!("[Work Item Discussion] {author} commented on {short_id}:"),
        String::new(),
        content.to_string(),
        String::new(),
        "This is a Reply turn. Answer on the Discussion with exactly one receipt:".to_string(),
        format!(
            "  org2-pm work note {short_id} --kind comment --parent-id {comment_id} --body \"<your reply>\""
        ),
        "(use --body-file for multi-line or shell-sensitive replies)".to_string(),
        "Do not change status or edit fields unless the comment explicitly asks for it."
            .to_string(),
    ]
    .join("\n")
}

fn validate_post_request(request: &DiscussionPostRequest) -> Result<(), String> {
    if request.comment_id.trim().is_empty()
        || request.author_id.trim().is_empty()
        || request.content.trim().is_empty()
    {
        return Err("commentId, authorId, and content are required".to_string());
    }
    Ok(())
}

fn post_in_transaction(
    tx: &rusqlite::Transaction<'_>,
    request: DiscussionPostRequest,
    start_target_override: Option<&StartTargetOverride>,
    preserve_content: bool,
    notify_subscribers: bool,
) -> Result<(DiscussionPostResult, bool), String> {
    validate_post_request(&request)?;
    let persisted_content = if preserve_content {
        request.content.clone()
    } else {
        request.content.trim().to_string()
    };
    let item = resolve_work_item(tx, &request.scope)?;
    let mut extras = item.extras.clone();
    let mut comments = comments_from_extras(&extras);

    if let Some(existing) = comments
        .iter()
        .find(|comment| comment.id == request.comment_id)
    {
        if existing.author != request.author_id || existing.content != persisted_content {
            return Err(format!(
                "PM_ERR:IDEMPOTENCY_CONFLICT:discussion:{}",
                request.comment_id
            ));
        }
        let decision = start_target_override.map_or_else(
            || {
                route_comment(
                    &request.content,
                    request.target_session_id.as_deref(),
                    &request.mentions,
                    request.parent_id.as_deref(),
                    &comments,
                    &extras,
                )
            },
            |_| RouteDecision::wake("quick_action", RouteTarget::Start),
        );
        let (decision, _) = freshen_context_exhausted_target(tx, decision)?;
        let run = tx
            .query_row(
                "SELECT id FROM pm_work_item_runs
                  WHERE scope_key = ?1 AND work_item_id = ?2
                    AND (idempotency_key IN (?3, ?4)
                         OR input_json LIKE ?5)
                  ORDER BY created_at DESC",
                params![
                    item.scope_key,
                    item.short_id,
                    format!("discussion-wake:{}", request.comment_id),
                    format!("discussion-comment:{}", request.comment_id),
                    format!("%\"{}\"%", request.comment_id)
                ],
                |row| row.get::<_, String>(0),
            )
            .ok()
            .and_then(|run_id| crate::work_run_service::read_in_transaction(tx, &run_id).ok());
        let result = DiscussionPostResult {
            comment: existing.clone(),
            run,
            thread_reopened: false,
            wake_reason: decision.reason,
        };
        return Ok((result, false));
    }

    let parent = request
        .parent_id
        .as_deref()
        .map(|parent_id| {
            comments
                .iter()
                .find(|comment| comment.id == parent_id)
                .cloned()
                .ok_or_else(|| format!("Discussion parent '{parent_id}' not found"))
        })
        .transpose()?;
    let thread_id = parent
        .as_ref()
        .and_then(|comment| comment.thread_id.clone())
        .or_else(|| parent.as_ref().map(|comment| comment.id.clone()))
        .unwrap_or_else(|| request.comment_id.clone());
    let mut thread_reopened = false;
    if parent.is_some() {
        if let Some(root) = comments.iter_mut().find(|comment| comment.id == thread_id) {
            if root.resolved_at.take().is_some() {
                thread_reopened = true;
            }
            root.resolved_by = None;
        }
        if thread_reopened {
            for existing in comments
                .iter_mut()
                .filter(|comment| comment.thread_id.as_deref() == Some(&thread_id))
            {
                existing.conclusion = false;
            }
        }
    }

    let decision = start_target_override.map_or_else(
        || {
            route_comment(
                &request.content,
                request.target_session_id.as_deref(),
                &request.mentions,
                request.parent_id.as_deref(),
                &comments,
                &extras,
            )
        },
        |_| RouteDecision::wake("quick_action", RouteTarget::Start),
    );
    let (decision, context_target_override) = freshen_context_exhausted_target(tx, decision)?;
    let start_target_override = start_target_override.or(context_target_override.as_ref());
    let now = now_ms();
    let comment = CommentEntry {
        id: request.comment_id.clone(),
        author: request.author_id.clone(),
        content: persisted_content,
        created_at: super::store::iso8601(now),
        revision: 0,
        mentioned_user_ids: request.mentioned_user_ids.clone(),
        mentions: request.mentions.clone(),
        parent_id: request.parent_id.clone(),
        thread_id: Some(thread_id.clone()),
        resolved_at: None,
        resolved_by: None,
        conclusion: false,
        agent_session_id: decision.resume_session_id(),
        originator: None,
        edited_at: None,
        deleted_at: None,
    };
    comments.push(comment.clone());
    store_comments(&mut extras, &comments)?;
    let revision = persist_extras(tx, &item, &extras, now)?;

    if notify_subscribers {
        subscriptions::notify_comment(
            tx,
            subscriptions::CommentNotification {
                scope_key: &item.scope_key,
                work_item_id: &item.short_id,
                title: &item.title,
                comment_id: &comment.id,
                author_id: &request.author_id,
                content: &comment.content,
                mentioned_user_ids: &comment.mentioned_user_ids,
                now,
            },
        )?;
    }

    let run = if decision.will_wake {
        let run_target = match decision.target.clone().expect("wake decision has a target") {
            RouteTarget::Resume { session_id } => WorkItemRunTarget::ResumeSession { session_id },
            RouteTarget::Start => WorkItemRunTarget::StartWorkItem {
                account_id: None,
                model_id: None,
            },
        };
        let merged_run_id = merge_into_open_wake_window(
            tx,
            &item.scope_key,
            &item.short_id,
            &run_target,
            start_target_override,
            decision.initial_delay_ms(),
            decision.coalescing_cap_ms(),
            &comment,
            &request.author_name,
            &item.short_id,
            now,
        )?;
        if let Some(run_id) = merged_run_id {
            Some(crate::work_run_service::read_in_transaction(tx, &run_id)?)
        } else {
            let mut target_snapshot = WorkItemRunTargetSnapshot::new(run_target);
            if let Some(target_override) = start_target_override {
                target_override.apply_to_snapshot(&mut target_snapshot);
            }
            Some(crate::work_run_service::enqueue_in_transaction(
                tx,
                EnqueueWorkItemRunRequest {
                    project_slug: item.project_slug.clone(),
                    org_id: item.org_id.clone(),
                    work_item_id: item.short_id.clone(),
                    trigger: WorkItemRunTrigger::DiscussionComment {
                        comment_id: comment.id.clone(),
                        author_id: Some(request.author_id.clone()),
                    },
                    target_snapshot,
                    input: serde_json::json!({
                        "content": build_forward_message(
                            &item.short_id,
                            &comment.id,
                            &request.author_name,
                            &comment.content,
                        ),
                        "displayText": format!("💬 {}", comment.content),
                        "discussionThreadId": thread_id,
                        "discussionCommentId": comment.id,
                        "discussionCommentIds": [comment.id],
                        "discussionWakeReason": decision.reason,
                    }),
                    idempotency_key: format!("discussion-wake:{}", comment.id),
                    max_attempts: 3,
                    parent_run_id: None,
                },
                decision.initial_delay_ms(),
            )?)
        }
    } else {
        None
    };

    append_audit(
        tx,
        &item,
        "work.discussion_comment",
        revision,
        Some(&request.author_id),
        serde_json::json!({
            "commentId": comment.id,
            "parentId": comment.parent_id,
            "threadId": thread_id,
            "mentionedUserIds": comment.mentioned_user_ids,
            "mentions": comment.mentions,
            "wakeReason": decision.reason,
            "runId": run.as_ref().map(|value| value.id.as_str()),
            "threadReopened": thread_reopened,
        }),
    )?;
    crate::sync::collab_bridge::record_work_item_payload_touch_in_connection(
        tx,
        &item.org_id,
        item.project_slug.as_deref(),
        &item.row_id,
        "comments",
    )?;
    let dispatch_ready = run.is_some();
    Ok((
        DiscussionPostResult {
            comment,
            run,
            thread_reopened,
            wake_reason: decision.reason,
        },
        dispatch_ready,
    ))
}

fn commit_post(
    tx: rusqlite::Transaction<'_>,
    result: DiscussionPostResult,
    dispatch_ready: bool,
) -> Result<DiscussionPostResult, String> {
    tx.commit()
        .map_err(|err| format!("Discussion commit: {err}"))?;
    if dispatch_ready {
        crate::projects::events::notify_work_item_dispatch_ready();
    }
    Ok(result)
}

pub(super) fn post(request: DiscussionPostRequest) -> Result<DiscussionPostResult, String> {
    validate_post_request(&request)?;
    let mut connection = conn()?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| format!("Discussion tx: {err}"))?;
    let (result, dispatch_ready) = post_in_transaction(&tx, request, None, false, true)?;
    commit_post(tx, result, dispatch_ready)
}

pub(super) fn post_for_quick_action_in_transaction(
    tx: &rusqlite::Transaction<'_>,
    request: DiscussionPostRequest,
    target: &StartTargetOverride,
) -> Result<(DiscussionPostResult, bool), String> {
    post_in_transaction(tx, request, Some(target), true, true)
}

/// Persist one deterministic parent Discussion comment for a child terminal
/// transition and route it through the same delayed-assignee machinery as a
/// member's top-level comment. The dedicated `child_completed` Inbox event is
/// written separately, so this system comment deliberately skips the generic
/// comment notification fan-out (and never creates a synthetic subscriber).
pub(crate) struct ChildTerminalSystemComment<'a> {
    pub(crate) project_slug: Option<&'a str>,
    pub(crate) org_id: &'a str,
    pub(crate) parent_short_id: &'a str,
    pub(crate) child_short_id: &'a str,
    pub(crate) child_title: &'a str,
    pub(crate) status: &'a str,
    pub(crate) child_revision: i64,
}

pub(crate) fn post_child_terminal_system_comment_in_transaction(
    tx: &rusqlite::Transaction<'_>,
    comment: ChildTerminalSystemComment<'_>,
) -> Result<bool, String> {
    let ChildTerminalSystemComment {
        project_slug,
        org_id,
        parent_short_id,
        child_short_id,
        child_title,
        status,
        child_revision,
    } = comment;
    let scope = WorkItemScope {
        project_slug: project_slug.map(str::to_string),
        org_id: org_id.to_string(),
        work_item_id: parent_short_id.to_string(),
    };
    match resolve_work_item(tx, &scope) {
        Ok(_) => {}
        Err(error) if error == format!("Work item '{parent_short_id}' not found") => {
            return Ok(false)
        }
        Err(error) => return Err(error),
    }

    let (result, dispatch_ready) = post_in_transaction(
        tx,
        DiscussionPostRequest {
            scope,
            comment_id: format!("system-child-terminal:{child_short_id}:{child_revision}"),
            author_id: "ORGII".to_string(),
            author_name: "ORGII".to_string(),
            content: format!(
                "Child {child_short_id} \u{201c}{child_title}\u{201d} reached {status}."
            ),
            mentioned_user_ids: Vec::new(),
            mentions: Vec::new(),
            parent_id: None,
            target_session_id: None,
        },
        None,
        false,
        false,
    )?;
    debug_assert!(result.comment.parent_id.is_none());
    Ok(dispatch_ready)
}

fn mutate_thread(
    request: DiscussionThreadMutation,
    resolved: bool,
) -> Result<Vec<CommentEntry>, String> {
    let mut connection = conn()?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| format!("Discussion tx: {err}"))?;
    let item = resolve_work_item(&tx, &request.scope)?;
    let mut extras = item.extras.clone();
    let mut comments = comments_from_extras(&extras);
    let root = comments
        .iter_mut()
        .find(|comment| comment.id == request.thread_id)
        .ok_or_else(|| format!("Discussion thread '{}' not found", request.thread_id))?;
    let now = now_ms();
    root.resolved_at = resolved.then(|| super::store::iso8601(now));
    root.resolved_by = resolved.then(|| request.actor_id.clone());
    if !resolved {
        for comment in comments
            .iter_mut()
            .filter(|comment| comment.thread_id.as_deref() == Some(&request.thread_id))
        {
            comment.conclusion = false;
        }
    }
    if let Some(conclusion_id) = request.conclusion_comment_id.as_deref() {
        let conclusion = comments
            .iter_mut()
            .find(|comment| {
                comment.id == conclusion_id
                    && comment.thread_id.as_deref() == Some(&request.thread_id)
            })
            .ok_or_else(|| format!("Conclusion comment '{conclusion_id}' is not in this thread"))?;
        conclusion.conclusion = resolved;
    }
    store_comments(&mut extras, &comments)?;
    let revision = persist_extras(&tx, &item, &extras, now)?;
    append_audit(
        &tx,
        &item,
        if resolved {
            "work.discussion_resolve"
        } else {
            "work.discussion_reopen"
        },
        revision,
        Some(&request.actor_id),
        serde_json::json!({
            "threadId": request.thread_id,
            "conclusionCommentId": request.conclusion_comment_id,
        }),
    )?;
    crate::sync::collab_bridge::record_work_item_payload_touch_in_connection(
        &tx,
        &item.org_id,
        item.project_slug.as_deref(),
        &item.row_id,
        "comments",
    )?;
    tx.commit()
        .map_err(|err| format!("Discussion commit: {err}"))?;
    Ok(comments)
}

pub(super) fn resolve_thread(
    request: DiscussionThreadMutation,
) -> Result<Vec<CommentEntry>, String> {
    mutate_thread(request, true)
}

pub(super) fn reopen_thread(
    request: DiscussionThreadMutation,
) -> Result<Vec<CommentEntry>, String> {
    mutate_thread(request, false)
}

/// Edit a comment's content in place. Author-only; never re-routes or
/// re-triggers a run — a wake already merged from the original content
/// keeps the text it captured.
pub(super) fn edit(request: DiscussionEditRequest) -> Result<Vec<CommentEntry>, String> {
    if request.comment_id.trim().is_empty()
        || request.actor_id.trim().is_empty()
        || request.content.trim().is_empty()
    {
        return Err("commentId, actorId, and content are required".to_string());
    }
    let mut connection = conn()?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| format!("Discussion tx: {err}"))?;
    let item = resolve_work_item(&tx, &request.scope)?;
    let mut extras = item.extras.clone();
    let mut comments = comments_from_extras(&extras);
    let now = now_ms();
    let comment = {
        let entry = comments
            .iter_mut()
            .find(|comment| comment.id == request.comment_id)
            .ok_or_else(|| format!("Discussion comment '{}' not found", request.comment_id))?;
        if entry.deleted_at.is_some() {
            return Err(format!(
                "Discussion comment '{}' is deleted",
                request.comment_id
            ));
        }
        if entry.author != request.actor_id {
            return Err("Only the comment author can edit it".to_string());
        }
        if let Some(expected_revision) = request.expected_revision {
            if expected_revision != entry.revision {
                return Err(crate::work_service::error::revision_conflict(
                    expected_revision,
                    entry.revision,
                ));
            }
        }
        let next = request.content.trim().to_string();
        if entry.content != next {
            entry.content = next;
            entry.edited_at = Some(super::store::iso8601(now));
            entry.revision += 1;
        }
        entry.clone()
    };
    store_comments(&mut extras, &comments)?;
    let revision = persist_extras(&tx, &item, &extras, now)?;
    append_audit(
        &tx,
        &item,
        "work.discussion_comment_edited",
        revision,
        Some(&request.actor_id),
        serde_json::json!({ "commentId": comment.id }),
    )?;
    crate::sync::collab_bridge::record_work_item_payload_touch_in_connection(
        &tx,
        &item.org_id,
        item.project_slug.as_deref(),
        &item.row_id,
        "comments",
    )?;
    tx.commit()
        .map_err(|err| format!("Discussion commit: {err}"))?;
    Ok(comments)
}

/// Tombstone a comment: content and mentions are cleared, the entry stays
/// so thread structure, audit trails, and idempotency keys keep resolving.
pub(super) fn delete(request: DiscussionDeleteRequest) -> Result<Vec<CommentEntry>, String> {
    if request.comment_id.trim().is_empty() || request.actor_id.trim().is_empty() {
        return Err("commentId and actorId are required".to_string());
    }
    let mut connection = conn()?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| format!("Discussion tx: {err}"))?;
    let item = resolve_work_item(&tx, &request.scope)?;
    let mut extras = item.extras.clone();
    let mut comments = comments_from_extras(&extras);
    let now = now_ms();
    let comment = {
        let entry = comments
            .iter_mut()
            .find(|comment| comment.id == request.comment_id)
            .ok_or_else(|| format!("Discussion comment '{}' not found", request.comment_id))?;
        if let Some(expected_revision) = request.expected_revision {
            if expected_revision != entry.revision {
                return Err(crate::work_service::error::revision_conflict(
                    expected_revision,
                    entry.revision,
                ));
            }
        }
        if entry.deleted_at.is_some() {
            drop(tx);
            return Ok(comments);
        }
        if entry.author != request.actor_id {
            return Err("Only the comment author can delete it".to_string());
        }
        entry.content = String::new();
        entry.mentioned_user_ids = Vec::new();
        entry.mentions = Vec::new();
        entry.deleted_at = Some(super::store::iso8601(now));
        entry.revision += 1;
        entry.clone()
    };
    store_comments(&mut extras, &comments)?;
    let revision = persist_extras(&tx, &item, &extras, now)?;
    append_audit(
        &tx,
        &item,
        "work.discussion_comment_deleted",
        revision,
        Some(&request.actor_id),
        serde_json::json!({ "commentId": comment.id }),
    )?;
    crate::sync::collab_bridge::record_work_item_payload_touch_in_connection(
        &tx,
        &item.org_id,
        item.project_slug.as_deref(),
        &item.row_id,
        "comments",
    )?;
    tx.commit()
        .map_err(|err| format!("Discussion commit: {err}"))?;
    Ok(comments)
}

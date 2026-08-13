use rusqlite::{params, TransactionBehavior};

use super::store::{append_audit, persist_extras, resolve_work_item};
use super::subscriptions;
use super::{
    DiscussionPostRequest, DiscussionPostResult, DiscussionThreadMutation,
    DiscussionTriggerPreview, DiscussionTriggerPreviewRequest,
};
use crate::projects::io::helpers::{conn, now_ms};
use crate::projects::types::{
    CommentEntry, EnqueueWorkItemRunRequest, LinkedSession, WorkItemRunTarget,
    WorkItemRunTargetSnapshot, WorkItemRunTrigger,
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

fn preview_for(
    content: &str,
    explicit_target: Option<&str>,
    extras: &serde_json::Value,
) -> DiscussionTriggerPreview {
    let target_session_id = explicit_target
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| latest_top_level_session(extras));
    if is_note_only(content) {
        return DiscussionTriggerPreview {
            will_wake: false,
            reason: "note_only".to_string(),
            target_session_id,
        };
    }
    if target_session_id.is_none() {
        return DiscussionTriggerPreview {
            will_wake: false,
            reason: "no_linked_session".to_string(),
            target_session_id,
        };
    }
    DiscussionTriggerPreview {
        will_wake: true,
        reason: "discussion_reply".to_string(),
        target_session_id,
    }
}

pub(super) fn preview(
    request: DiscussionTriggerPreviewRequest,
) -> Result<DiscussionTriggerPreview, String> {
    let connection = conn()?;
    let item = resolve_work_item(&connection, &request.scope)?;
    Ok(preview_for(
        &request.content,
        request.target_session_id.as_deref(),
        &item.extras,
    ))
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

pub(super) fn post(request: DiscussionPostRequest) -> Result<DiscussionPostResult, String> {
    if request.comment_id.trim().is_empty()
        || request.author_id.trim().is_empty()
        || request.content.trim().is_empty()
    {
        return Err("commentId, authorId, and content are required".to_string());
    }
    let mut connection = conn()?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| format!("Discussion tx: {err}"))?;
    let item = resolve_work_item(&tx, &request.scope)?;
    let mut extras = item.extras.clone();
    let mut comments = comments_from_extras(&extras);

    if let Some(existing) = comments
        .iter()
        .find(|comment| comment.id == request.comment_id)
    {
        if existing.author != request.author_id || existing.content != request.content.trim() {
            return Err(format!(
                "PM_ERR:IDEMPOTENCY_CONFLICT:discussion:{}",
                request.comment_id
            ));
        }
        let preview = preview_for(
            &request.content,
            request.target_session_id.as_deref(),
            &extras,
        );
        let run = tx
            .query_row(
                "SELECT id FROM pm_work_item_runs
                  WHERE scope_key = ?1 AND work_item_id = ?2
                    AND idempotency_key = ?3",
                params![
                    item.scope_key,
                    item.short_id,
                    format!("discussion-comment:{}", request.comment_id)
                ],
                |row| row.get::<_, String>(0),
            )
            .ok()
            .and_then(|run_id| crate::work_run_service::read(&run_id).ok());
        let result = DiscussionPostResult {
            comment: existing.clone(),
            run,
            thread_reopened: false,
            wake_reason: preview.reason,
        };
        tx.commit()
            .map_err(|err| format!("Discussion commit: {err}"))?;
        return Ok(result);
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

    let preview = preview_for(
        &request.content,
        request.target_session_id.as_deref(),
        &extras,
    );
    let now = now_ms();
    let comment = CommentEntry {
        id: request.comment_id.clone(),
        author: request.author_id.clone(),
        content: request.content.trim().to_string(),
        created_at: super::store::iso8601(now),
        mentioned_user_ids: request.mentioned_user_ids.clone(),
        parent_id: request.parent_id.clone(),
        thread_id: Some(thread_id.clone()),
        resolved_at: None,
        resolved_by: None,
        conclusion: false,
        agent_session_id: preview.target_session_id.clone(),
    };
    comments.push(comment.clone());
    store_comments(&mut extras, &comments)?;
    let revision = persist_extras(&tx, &item, &extras, now)?;

    subscriptions::notify_comment(
        &tx,
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

    let run = if preview.will_wake {
        let target_session_id = preview
            .target_session_id
            .clone()
            .expect("wake preview has a session");
        Some(crate::work_run_service::enqueue_in_transaction(
            &tx,
            EnqueueWorkItemRunRequest {
                project_slug: item.project_slug.clone(),
                org_id: item.org_id.clone(),
                work_item_id: item.short_id.clone(),
                trigger: WorkItemRunTrigger::DiscussionComment {
                    comment_id: comment.id.clone(),
                    author_id: Some(request.author_id.clone()),
                },
                target_snapshot: WorkItemRunTargetSnapshot::new(WorkItemRunTarget::ResumeSession {
                    session_id: target_session_id,
                }),
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
                }),
                idempotency_key: format!("discussion-comment:{}", comment.id),
                max_attempts: 3,
                parent_run_id: None,
            },
            0,
        )?)
    } else {
        None
    };

    append_audit(
        &tx,
        &item,
        "work.discussion_comment",
        revision,
        Some(&request.author_id),
        serde_json::json!({
            "commentId": comment.id,
            "parentId": comment.parent_id,
            "threadId": thread_id,
            "mentionedUserIds": comment.mentioned_user_ids,
            "wakeReason": preview.reason,
            "runId": run.as_ref().map(|value| value.id.as_str()),
            "threadReopened": thread_reopened,
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
    if run.is_some() {
        crate::projects::events::notify_work_item_dispatch_ready();
    }
    Ok(DiscussionPostResult {
        comment,
        run,
        thread_reopened,
        wake_reason: preview.reason,
    })
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

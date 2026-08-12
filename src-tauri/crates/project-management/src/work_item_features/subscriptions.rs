use std::collections::BTreeSet;

use rusqlite::{params, Transaction, TransactionBehavior};

use super::store::{iso8601, resolve_work_item};
use super::{SubscriptionMutation, SubscriptionReason, WorkItemScope, WorkItemSubscription};
use crate::projects::io::helpers::{conn, now_ms};
use crate::projects::types::WorkItemRun;

pub(super) fn ensure_subscription(
    tx: &Transaction<'_>,
    item_scope: &str,
    work_item_id: &str,
    subscriber_id: &str,
    reason: SubscriptionReason,
    now: i64,
) -> Result<(), String> {
    let subscriber_id = subscriber_id.trim();
    if subscriber_id.is_empty() {
        return Ok(());
    }
    tx.execute(
        "INSERT INTO pm_work_item_subscriptions (
             scope_key, work_item_id, subscriber_id, reason, created_at, muted_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, NULL)
         ON CONFLICT(scope_key, work_item_id, subscriber_id) DO UPDATE SET
             reason = CASE
                 WHEN pm_work_item_subscriptions.reason = 'manual' THEN 'manual'
                 ELSE excluded.reason
             END,
             muted_at = NULL",
        params![
            item_scope,
            work_item_id,
            subscriber_id,
            reason.as_str(),
            now
        ],
    )
    .map_err(|err| format!("work item subscription: {err}"))?;
    Ok(())
}

fn bootstrap_implicit_subscriptions(
    tx: &Transaction<'_>,
    scope: &WorkItemScope,
) -> Result<super::store::ResolvedWorkItem, String> {
    let item = resolve_work_item(tx, scope)?;
    let now = now_ms();
    if let Some(creator) = item.created_by.as_deref() {
        ensure_subscription(
            tx,
            &item.scope_key,
            &item.short_id,
            creator,
            SubscriptionReason::Creator,
            now,
        )?;
    }
    if let Some(assignee) = item.assigned_human_id.as_deref() {
        ensure_subscription(
            tx,
            &item.scope_key,
            &item.short_id,
            assignee,
            SubscriptionReason::Assignee,
            now,
        )?;
    }
    // Description mentions use durable member ids (`<@id>` or `@[id]`), so
    // display-name edits cannot silently retarget a subscription.
    for mentioned_id in description_mention_ids(&item.body) {
        ensure_subscription(
            tx,
            &item.scope_key,
            &item.short_id,
            &mentioned_id,
            SubscriptionReason::Mentioned,
            now,
        )?;
    }
    if matches!(
        item.status.trim().to_ascii_lowercase().as_str(),
        "completed" | "closed" | "cancelled" | "canceled" | "duplicate"
    ) {
        tx.execute(
            "UPDATE pm_work_item_inbox_events SET archived_at = COALESCE(archived_at, ?3)
              WHERE scope_key = ?1 AND work_item_id = ?2",
            params![item.scope_key, item.short_id, now],
        )
        .map_err(|err| format!("work item inbox event: {err}"))?;
    }
    Ok(item)
}

fn description_mention_ids(body: &str) -> BTreeSet<String> {
    let mut ids = BTreeSet::new();
    for (prefix, suffix) in [("<@", ">"), ("@[", "]")] {
        let mut remainder = body;
        while let Some(start) = remainder.find(prefix) {
            let after_prefix = &remainder[start + prefix.len()..];
            let Some(end) = after_prefix.find(suffix) else {
                break;
            };
            let id = after_prefix[..end].trim();
            if !id.is_empty()
                && id
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | ':' | '.'))
            {
                ids.insert(id.to_string());
            }
            remainder = &after_prefix[end + suffix.len()..];
        }
    }
    ids
}

pub(super) fn subscribe(
    request: SubscriptionMutation,
) -> Result<Vec<WorkItemSubscription>, String> {
    let mut connection = conn()?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| format!("work item subscription tx: {err}"))?;
    let item = bootstrap_implicit_subscriptions(&tx, &request.scope)?;
    ensure_subscription(
        &tx,
        &item.scope_key,
        &item.short_id,
        &request.subscriber_id,
        SubscriptionReason::Manual,
        now_ms(),
    )?;
    tx.commit()
        .map_err(|err| format!("work item subscription commit: {err}"))?;
    list(&request.scope)
}

pub(super) fn unsubscribe(
    request: SubscriptionMutation,
) -> Result<Vec<WorkItemSubscription>, String> {
    let mut connection = conn()?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| format!("work item subscription tx: {err}"))?;
    let item = resolve_work_item(&tx, &request.scope)?;
    tx.execute(
        "UPDATE pm_work_item_subscriptions
            SET muted_at = ?4
          WHERE scope_key = ?1 AND work_item_id = ?2 AND subscriber_id = ?3",
        params![
            item.scope_key,
            item.short_id,
            request.subscriber_id,
            now_ms()
        ],
    )
    .map_err(|err| format!("work item subscription: {err}"))?;
    tx.commit()
        .map_err(|err| format!("work item subscription commit: {err}"))?;
    list(&request.scope)
}

pub(super) fn list(scope: &WorkItemScope) -> Result<Vec<WorkItemSubscription>, String> {
    let mut connection = conn()?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| format!("work item subscription tx: {err}"))?;
    let item = bootstrap_implicit_subscriptions(&tx, scope)?;
    let mut statement = tx
        .prepare(
            "SELECT subscriber_id, reason, created_at, muted_at
               FROM pm_work_item_subscriptions
              WHERE scope_key = ?1 AND work_item_id = ?2
              ORDER BY created_at ASC, subscriber_id ASC",
        )
        .map_err(|err| format!("work item subscription: {err}"))?;
    let rows = statement
        .query_map(params![item.scope_key, item.short_id], |row| {
            let reason: String = row.get(1)?;
            Ok((
                row.get::<_, String>(0)?,
                reason,
                row.get::<_, i64>(2)?,
                row.get::<_, Option<i64>>(3)?,
            ))
        })
        .map_err(|err| format!("work item subscription: {err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("work item subscription: {err}"))?;
    drop(statement);
    tx.commit()
        .map_err(|err| format!("work item subscription commit: {err}"))?;
    rows.into_iter()
        .map(|(subscriber_id, reason, created_at, muted_at)| {
            Ok(WorkItemSubscription {
                subscriber_id,
                reason: parse_reason(&reason)?,
                created_at: iso8601(created_at),
                muted_at: muted_at.map(iso8601),
            })
        })
        .collect()
}

fn parse_reason(value: &str) -> Result<SubscriptionReason, String> {
    match value {
        "creator" => Ok(SubscriptionReason::Creator),
        "assignee" => Ok(SubscriptionReason::Assignee),
        "commenter" => Ok(SubscriptionReason::Commenter),
        "mentioned" => Ok(SubscriptionReason::Mentioned),
        "manual" => Ok(SubscriptionReason::Manual),
        "agent" => Ok(SubscriptionReason::Agent),
        "delegated" => Ok(SubscriptionReason::Delegated),
        other => Err(format!("unknown subscription reason '{other}'")),
    }
}

struct InboxEvent<'a> {
    scope_key: &'a str,
    work_item_id: &'a str,
    recipient_id: &'a str,
    kind: &'a str,
    actor_id: Option<&'a str>,
    payload: &'a serde_json::Value,
    coalesce_key: &'a str,
    now: i64,
}

pub(super) struct CommentNotification<'a> {
    pub(super) scope_key: &'a str,
    pub(super) work_item_id: &'a str,
    pub(super) title: &'a str,
    pub(super) comment_id: &'a str,
    pub(super) author_id: &'a str,
    pub(super) content: &'a str,
    pub(super) mentioned_user_ids: &'a [String],
    pub(super) now: i64,
}

fn upsert_inbox_event(tx: &Transaction<'_>, event: InboxEvent<'_>) -> Result<(), String> {
    let InboxEvent {
        scope_key,
        work_item_id,
        recipient_id,
        kind,
        actor_id,
        payload,
        coalesce_key,
        now,
    } = event;
    let raw = serde_json::to_string(payload)
        .map_err(|err| format!("inbox event payload serialization: {err}"))?;
    tx.execute(
        "INSERT INTO pm_work_item_inbox_events (
             id, scope_key, work_item_id, recipient_id, kind, actor_id,
             payload_json, coalesce_key, occurred_at, archived_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL)
         ON CONFLICT(recipient_id, coalesce_key) DO UPDATE SET
             id = excluded.id,
             kind = excluded.kind,
             actor_id = excluded.actor_id,
             payload_json = excluded.payload_json,
             occurred_at = excluded.occurred_at,
             archived_at = NULL",
        params![
            format!("wie_{}", uuid::Uuid::new_v4().simple()),
            scope_key,
            work_item_id,
            recipient_id,
            kind,
            actor_id,
            raw,
            coalesce_key,
            now
        ],
    )
    .map_err(|err| format!("work item inbox event: {err}"))?;
    Ok(())
}

pub(super) fn notify_comment(
    tx: &Transaction<'_>,
    notification: CommentNotification<'_>,
) -> Result<(), String> {
    let CommentNotification {
        scope_key,
        work_item_id,
        title,
        comment_id,
        author_id,
        content,
        mentioned_user_ids,
        now,
    } = notification;
    ensure_subscription(
        tx,
        scope_key,
        work_item_id,
        author_id,
        SubscriptionReason::Commenter,
        now,
    )?;
    let mentioned = mentioned_user_ids
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty() && *value != author_id)
        .map(str::to_string)
        .collect::<BTreeSet<_>>();
    for recipient in &mentioned {
        ensure_subscription(
            tx,
            scope_key,
            work_item_id,
            recipient,
            SubscriptionReason::Mentioned,
            now,
        )?;
        let payload = serde_json::json!({
            "title": title,
            "commentId": comment_id,
            "comment": content,
            "mentioned": true,
        });
        let coalesce_key = format!("mention:{comment_id}:{recipient}");
        upsert_inbox_event(
            tx,
            InboxEvent {
                scope_key,
                work_item_id,
                recipient_id: recipient,
                kind: "mention",
                actor_id: Some(author_id),
                payload: &payload,
                coalesce_key: &coalesce_key,
                now,
            },
        )?;
    }

    let mut statement = tx
        .prepare(
            "SELECT subscriber_id FROM pm_work_item_subscriptions
              WHERE scope_key = ?1 AND work_item_id = ?2 AND muted_at IS NULL",
        )
        .map_err(|err| format!("work item subscription: {err}"))?;
    let subscribers = statement
        .query_map(params![scope_key, work_item_id], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|err| format!("work item subscription: {err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("work item subscription: {err}"))?;
    drop(statement);
    for recipient in subscribers {
        if recipient == author_id || mentioned.contains(&recipient) {
            continue;
        }
        let payload = serde_json::json!({
            "title": title,
            "commentId": comment_id,
            "comment": content,
            "mentioned": false,
        });
        let coalesce_key = format!("work-item:{scope_key}:{work_item_id}");
        upsert_inbox_event(
            tx,
            InboxEvent {
                scope_key,
                work_item_id,
                recipient_id: &recipient,
                kind: "discussion_updated",
                actor_id: Some(author_id),
                payload: &payload,
                coalesce_key: &coalesce_key,
                now,
            },
        )?;
    }
    Ok(())
}

pub(crate) fn notify_run_terminal(run: &WorkItemRun) -> Result<(), String> {
    if run.status.as_str() != "failed" {
        return Ok(());
    }
    let mut connection = conn()?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| format!("work item inbox tx: {err}"))?;
    let scope = WorkItemScope {
        project_slug: run.project_slug.clone(),
        org_id: run.org_id.clone(),
        work_item_id: run.work_item_id.clone(),
    };
    let item = bootstrap_implicit_subscriptions(&tx, &scope)?;
    let mut statement = tx
        .prepare(
            "SELECT subscriber_id FROM pm_work_item_subscriptions
              WHERE scope_key = ?1 AND work_item_id = ?2 AND muted_at IS NULL",
        )
        .map_err(|err| format!("work item subscription: {err}"))?;
    let subscribers = statement
        .query_map(params![item.scope_key, item.short_id], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|err| format!("work item subscription: {err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("work item subscription: {err}"))?;
    drop(statement);
    let now = now_ms();
    for recipient in subscribers {
        let payload = serde_json::json!({
            "title": item.title,
            "runId": run.id,
            "failure": run.failure,
        });
        let coalesce_key = format!("work-item:{}:{}", item.scope_key, item.short_id);
        upsert_inbox_event(
            &tx,
            InboxEvent {
                scope_key: &item.scope_key,
                work_item_id: &item.short_id,
                recipient_id: &recipient,
                kind: "run_failed",
                actor_id: None,
                payload: &payload,
                coalesce_key: &coalesce_key,
                now,
            },
        )?;
    }
    tx.commit()
        .map_err(|err| format!("work item inbox commit: {err}"))?;
    Ok(())
}

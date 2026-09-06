use std::collections::BTreeSet;

use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};

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
    let effective_status = super::statuses::effective_status_in(tx, &item.org_id, &item.status);
    if matches!(
        effective_status.trim().to_ascii_lowercase().as_str(),
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

fn recipient_muted_kind(
    tx: &Transaction<'_>,
    recipient_id: &str,
    kind: &str,
) -> Result<bool, String> {
    tx.query_row(
        "SELECT 1 FROM pm_inbox_prefs WHERE recipient_id = ?1 AND kind = ?2",
        params![recipient_id, kind],
        |_| Ok(true),
    )
    .optional()
    .map(|found| found.unwrap_or(false))
    .map_err(|err| format!("inbox prefs: {err}"))
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
    if recipient_muted_kind(tx, recipient_id, kind)? {
        return Ok(());
    }
    let raw = serde_json::to_string(payload)
        .map_err(|err| format!("inbox event payload serialization: {err}"))?;
    tx.execute(
        "INSERT INTO pm_work_item_inbox_events (
             id, scope_key, work_item_id, recipient_id, kind, actor_id,
             payload_json, coalesce_key, occurred_at, archived_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL)
         ON CONFLICT(recipient_id, coalesce_key) DO UPDATE SET
             id = excluded.id,
             scope_key = excluded.scope_key,
             work_item_id = excluded.work_item_id,
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
        let coalesce_key = format!("mention:{scope_key}:{work_item_id}:{comment_id}");
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

pub(crate) struct FieldChangeNotification<'a> {
    pub scope_key: &'a str,
    pub work_item_id: &'a str,
    pub title: &'a str,
    pub actor_id: Option<&'a str>,
    pub status_change: Option<(&'a str, &'a str)>,
    pub assignee_change: Option<(Option<&'a str>, Option<&'a str>)>,
    pub priority_change: Option<(&'a str, &'a str)>,
    pub dates_changed: bool,
    pub now: i64,
}

fn unmuted_subscribers(
    tx: &Transaction<'_>,
    scope_key: &str,
    work_item_id: &str,
) -> Result<Vec<String>, String> {
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
    Ok(subscribers)
}

/// Inbox events for status / assignee / priority / date edits, written in
/// the same transaction as the mutation. The generic coalesce key keeps
/// one live row per item per recipient, so one edit emits ONE event whose
/// kind names its most significant change and whose payload carries all of
/// them — writing one event per field would just overwrite itself down to
/// the last field. The actor never notifies themselves.
pub(crate) fn notify_field_changes(
    tx: &Transaction<'_>,
    notification: FieldChangeNotification<'_>,
) -> Result<(), String> {
    let mut changes = serde_json::Map::new();
    if let Some((from, to)) = notification.status_change {
        changes.insert(
            "status".to_string(),
            serde_json::json!({ "from": from, "to": to }),
        );
    }
    if let Some((from, to)) = notification.assignee_change {
        changes.insert(
            "assignee".to_string(),
            serde_json::json!({ "from": from, "to": to }),
        );
    }
    if let Some((from, to)) = notification.priority_change {
        changes.insert(
            "priority".to_string(),
            serde_json::json!({ "from": from, "to": to }),
        );
    }
    if notification.dates_changed {
        changes.insert("dates".to_string(), serde_json::Value::Bool(true));
    }
    if changes.is_empty() {
        return Ok(());
    }
    let kind = if notification.status_change.is_some() {
        "status_changed"
    } else if notification.assignee_change.is_some() {
        "assignee_changed"
    } else if notification.priority_change.is_some() {
        "priority_changed"
    } else {
        "dates_changed"
    };
    let payload = serde_json::json!({
        "title": notification.title,
        "changes": serde_json::Value::Object(changes),
    });
    let subscribers = unmuted_subscribers(tx, notification.scope_key, notification.work_item_id)?;
    let coalesce_key = format!(
        "work-item:{}:{}",
        notification.scope_key, notification.work_item_id
    );
    for recipient in subscribers {
        if Some(recipient.as_str()) == notification.actor_id {
            continue;
        }
        upsert_inbox_event(
            tx,
            InboxEvent {
                scope_key: notification.scope_key,
                work_item_id: notification.work_item_id,
                recipient_id: &recipient,
                kind,
                actor_id: notification.actor_id,
                payload: &payload,
                coalesce_key: &coalesce_key,
                now: notification.now,
            },
        )?;
    }
    Ok(())
}

pub(crate) struct ChildTerminalNotification<'a> {
    pub scope_key: &'a str,
    pub parent_short_id: &'a str,
    pub child_short_id: &'a str,
    pub child_title: &'a str,
    pub status: &'a str,
    pub actor_id: Option<&'a str>,
    pub now: i64,
}

/// A child reaching a terminal status notifies the parent's subscribers.
/// Keyed per child so two finishing children never coalesce away.
pub(crate) fn notify_child_terminal(
    tx: &Transaction<'_>,
    notification: ChildTerminalNotification<'_>,
) -> Result<(), String> {
    let ChildTerminalNotification {
        scope_key,
        parent_short_id,
        child_short_id,
        child_title,
        status,
        actor_id,
        now,
    } = notification;
    let subscribers = unmuted_subscribers(tx, scope_key, parent_short_id)?;
    let payload = serde_json::json!({
        "title": child_title,
        "childShortId": child_short_id,
        "status": status,
    });
    for recipient in subscribers {
        if Some(recipient.as_str()) == actor_id {
            continue;
        }
        let coalesce_key = format!("child:{scope_key}:{parent_short_id}:{child_short_id}");
        upsert_inbox_event(
            tx,
            InboxEvent {
                scope_key,
                work_item_id: parent_short_id,
                recipient_id: &recipient,
                kind: "child_completed",
                actor_id,
                payload: &payload,
                coalesce_key: &coalesce_key,
                now,
            },
        )?;
    }
    Ok(())
}

/// Per-recipient inbox category mutes. `kind` matches the event kinds
/// written above plus `mention` / `discussion_updated` / `run_failed`.
pub(crate) fn list_muted_kinds(recipient_id: &str) -> Result<Vec<String>, String> {
    let connection = conn()?;
    let mut statement = connection
        .prepare("SELECT kind FROM pm_inbox_prefs WHERE recipient_id = ?1 ORDER BY kind ASC")
        .map_err(|err| format!("inbox prefs: {err}"))?;
    let kinds = statement
        .query_map(params![recipient_id], |row| row.get::<_, String>(0))
        .map_err(|err| format!("inbox prefs: {err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("inbox prefs: {err}"))?;
    Ok(kinds)
}

pub(crate) fn set_kind_muted(
    recipient_id: &str,
    kind: &str,
    muted: bool,
) -> Result<Vec<String>, String> {
    let connection = conn()?;
    if muted {
        connection
            .execute(
                "INSERT INTO pm_inbox_prefs (recipient_id, kind, muted_at)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(recipient_id, kind) DO UPDATE SET muted_at = excluded.muted_at",
                params![recipient_id, kind, now_ms()],
            )
            .map_err(|err| format!("inbox prefs: {err}"))?;
    } else {
        connection
            .execute(
                "DELETE FROM pm_inbox_prefs WHERE recipient_id = ?1 AND kind = ?2",
                params![recipient_id, kind],
            )
            .map_err(|err| format!("inbox prefs: {err}"))?;
    }
    list_muted_kinds(recipient_id)
}

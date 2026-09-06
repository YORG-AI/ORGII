use std::collections::BTreeSet;
use std::time::{SystemTime, UNIX_EPOCH};

use database::db::{get_projects_connection, PooledConnection};
use rusqlite::{
    params_from_iter, types::Value, Connection, OptionalExtension, TransactionBehavior,
};

use super::{
    schema::init_team_inbox_tables, TeamInboxActor, TeamInboxCursor, TeamInboxFilter,
    TeamInboxItem, TeamInboxItemKind, TeamInboxPage, TeamInboxPayload, TeamInboxTarget,
    TeamInboxUnreadCounts,
};
use crate::projects::types::{
    WorkItemHandoff, WorkItemHandoffStatus, WorkItemHistoryAction, WorkItemHistoryEvent,
};

const ASSIGNED_SOURCE_KIND: &str = "work_item_assigned";
const COMMENT_MENTION_SOURCE_KIND: &str = "work_item_comment_mention";
const SUBSCRIPTION_SOURCE_KIND: &str = "work_item_subscription_event";
const DEFAULT_PAGE_LIMIT: usize = 50;
const MAX_PAGE_LIMIT: usize = 100;
const ACTIONABLE_ASSIGNMENT_PREDICATE: &str =
    "LOWER(TRIM(COALESCE((SELECT sd.category FROM pm_status_definitions sd \
      WHERE sd.org_id = w.org_id AND sd.key = w.status), w.status))) \
      NOT IN ('completed', 'cancelled', 'canceled', 'duplicate', 'closed', 'done')";
/// Upper bound on the assigned-item summary so a long Work Item body never
/// bloats the inbox payload; the detail surface links back to the full item.
const SUMMARY_EXCERPT_MAX_CHARS: usize = 240;

/// Collapses a Work Item body into a single-line inbox summary. Whitespace runs
/// (including newlines) fold to single spaces, and the result is truncated on a
/// char boundary with an ellipsis. Empty bodies yield `None` so the DTO omits
/// the field entirely.
pub(crate) fn work_item_summary_excerpt(body: &str) -> Option<String> {
    let normalized = body.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return None;
    }
    let mut chars = normalized.chars();
    let head: String = chars.by_ref().take(SUMMARY_EXCERPT_MAX_CHARS).collect();
    if chars.next().is_some() {
        Some(format!("{head}…"))
    } else {
        Some(head)
    }
}

fn handoff_from_extras(extras_json: Option<&str>) -> Option<WorkItemHandoff> {
    let value = serde_json::from_str::<serde_json::Value>(extras_json?).ok()?;
    serde_json::from_value(value.get("handoff")?.clone()).ok()
}

fn handoff_actor(handoff: &WorkItemHandoff) -> TeamInboxActor {
    let (id, display_name) = match handoff.status {
        WorkItemHandoffStatus::Returned => (
            handoff.recipient_member_id.clone(),
            handoff.recipient_name.clone(),
        ),
        WorkItemHandoffStatus::Pending | WorkItemHandoffStatus::Accepted => (
            handoff.sender_member_id.clone(),
            handoff.sender_name.clone(),
        ),
    };
    TeamInboxActor {
        id,
        display_name,
        avatar_url: None,
    }
}

#[derive(serde::Deserialize)]
struct AssignmentHistoryProjection {
    #[serde(default)]
    history: Vec<WorkItemHistoryEvent>,
}

fn history_event_actor(event: &WorkItemHistoryEvent) -> Option<TeamInboxActor> {
    let actor_id = event
        .actor_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let actor_name = event
        .actor_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let id = actor_id.or(actor_name)?;
    Some(TeamInboxActor {
        id: id.to_string(),
        display_name: actor_name.unwrap_or(id).to_string(),
        avatar_url: None,
    })
}

/// Resolve the actor that produced the current human-assignment episode from
/// the canonical Work Item history. Later status/body edits must not replace
/// the assignment actor shown by Team Inbox.
fn assignment_actor(extras_json: Option<&str>, assignee_member_id: &str) -> Option<TeamInboxActor> {
    let history = serde_json::from_str::<AssignmentHistoryProjection>(extras_json?)
        .ok()?
        .history;
    let assignment_event = history.iter().rev().find(|event| {
        event.changes.iter().any(|change| {
            change.field == "assignee" && change.new_value.as_str() == Some(assignee_member_id)
        })
    });
    if let Some(event) = assignment_event {
        return history_event_actor(event);
    }

    history
        .iter()
        .find(|event| event.action == WorkItemHistoryAction::Created)
        .and_then(history_event_actor)
}

#[derive(Debug, Clone)]
pub struct TeamInboxListOptions {
    pub viewer_member_ids: Vec<String>,
    pub filter: TeamInboxFilter,
    pub cursor: Option<TeamInboxCursor>,
    pub limit: usize,
}

impl TeamInboxListOptions {
    pub fn new(viewer_member_ids: Vec<String>) -> Self {
        Self {
            viewer_member_ids,
            filter: TeamInboxFilter::All,
            cursor: None,
            limit: DEFAULT_PAGE_LIMIT,
        }
    }
}

pub fn list_page(options: TeamInboxListOptions) -> Result<TeamInboxPage, String> {
    let connection = open_connection()?;
    list_page_with_connection(&connection, options)
}

pub fn unread_count(
    viewer_member_ids: Vec<String>,
    filter: TeamInboxFilter,
) -> Result<u64, String> {
    let connection = open_connection()?;
    unread_count_with_connection(&connection, &viewer_member_ids, filter)
}

pub fn mark_read(viewer_member_ids: Vec<String>, item_id: &str) -> Result<bool, String> {
    let mut connection = open_connection()?;
    mark_read_with_connection(&mut connection, &viewer_member_ids, item_id, now_ms())
}

pub fn mark_all_read(
    viewer_member_ids: Vec<String>,
    filter: TeamInboxFilter,
) -> Result<u64, String> {
    let mut connection = open_connection()?;
    mark_all_read_with_connection(&mut connection, &viewer_member_ids, filter, now_ms())
}

pub fn mark_unread(viewer_member_ids: Vec<String>, item_id: &str) -> Result<bool, String> {
    let mut connection = open_connection()?;
    mark_unread_with_connection(&mut connection, &viewer_member_ids, item_id)
}

pub fn set_archived(
    viewer_member_ids: &[String],
    item_id: &str,
    archived: bool,
) -> Result<bool, String> {
    let mut connection = open_connection()?;
    set_archived_with_connection(
        &mut connection,
        viewer_member_ids,
        item_id,
        archived,
        now_ms(),
    )
}

fn open_connection() -> Result<PooledConnection, String> {
    let connection = get_projects_connection().map_err(db_error)?;
    init_team_inbox_tables(&connection).map_err(db_error)?;
    Ok(connection)
}

pub(crate) fn list_page_with_connection(
    connection: &Connection,
    options: TeamInboxListOptions,
) -> Result<TeamInboxPage, String> {
    init_team_inbox_tables(connection).map_err(db_error)?;
    let viewer_ids = normalized_viewer_ids(&options.viewer_member_ids)?;
    let archived_only = options.filter == TeamInboxFilter::Archived;
    let limit = options.limit.clamp(1, MAX_PAGE_LIMIT);
    let fetch_limit = limit + 1;
    let mut items = Vec::new();
    if options.filter != TeamInboxFilter::Mentions {
        items.extend(list_assigned_items(
            connection,
            &viewer_ids,
            options.cursor.as_ref(),
            fetch_limit,
            archived_only,
        )?);
    }
    if options.filter != TeamInboxFilter::Assigned {
        items.extend(list_work_item_comment_mentions(
            connection,
            &viewer_ids,
            options.cursor.as_ref(),
            fetch_limit,
            archived_only,
        )?);
    }
    if matches!(
        options.filter,
        TeamInboxFilter::All | TeamInboxFilter::Archived
    ) {
        items.extend(list_subscription_events(
            connection,
            &viewer_ids,
            options.cursor.as_ref(),
            fetch_limit,
            archived_only,
        )?);
    }
    items.sort_by(|left, right| {
        right
            .occurred_at
            .cmp(&left.occurred_at)
            .then_with(|| right.id.cmp(&left.id))
    });
    let has_more = items.len() > limit;
    items.truncate(limit);
    let next_cursor = has_more.then(|| {
        let last = items
            .last()
            .expect("a paginated page with overflow is non-empty");
        TeamInboxCursor {
            occurred_at: last.occurred_at,
            item_id: last.id.clone(),
        }
    });
    let unread_counts = unread_counts_with_connection(connection, &viewer_ids, options.filter)?;

    Ok(TeamInboxPage {
        items,
        next_cursor,
        unread_count: unread_counts.all,
        unread_counts,
    })
}

fn list_subscription_events(
    connection: &Connection,
    viewer_ids: &[String],
    cursor: Option<&TeamInboxCursor>,
    limit: usize,
    archived_only: bool,
) -> Result<Vec<TeamInboxItem>, String> {
    let placeholders = sql_placeholders(viewer_ids.len());
    let receipt_placeholders = sql_placeholders(viewer_ids.len());
    let item_id_expression = format!("'{SUBSCRIPTION_SOURCE_KIND}:' || event.id");
    let archive_predicate = archive_receipt_predicate(
        SUBSCRIPTION_SOURCE_KIND,
        "event.id",
        &receipt_placeholders,
        archived_only,
    );
    let cursor_predicate = if cursor.is_some() {
        format!(
            "AND (event.occurred_at < ? OR
                  (event.occurred_at = ? AND {item_id_expression} < ?))"
        )
    } else {
        String::new()
    };
    let sql = format!(
        "SELECT event.id, event.kind, event.actor_id, event.payload_json,
                event.occurred_at, w.id, w.org_id, w.project_id, p.slug,
                CASE WHEN json_valid(p.linked_repos_json)
                     THEN json_extract(p.linked_repos_json, '$[0]') ELSE NULL END,
                w.short_id, w.title, w.status, w.priority, event.recipient_id,
                (SELECT MAX(receipt.read_at) FROM team_inbox_read_receipts receipt
                  WHERE receipt.source_kind = '{SUBSCRIPTION_SOURCE_KIND}'
                    AND receipt.source_id = event.id
                    AND receipt.viewer_member_id IN ({receipt_placeholders}))
           FROM pm_work_item_inbox_events event
           JOIN workitems w ON w.short_id = event.work_item_id
           LEFT JOIN projects p ON p.id = w.project_id
          WHERE event.archived_at IS NULL
            AND event.kind <> 'mention'
            AND event.recipient_id IN ({placeholders})
            AND w.deleted_at IS NULL
            AND ((event.scope_key = 'project:' || p.slug)
                 OR (w.project_id IS NULL AND event.scope_key = 'org:' || w.org_id))
            AND {archive_predicate}
            {cursor_predicate}
          ORDER BY event.occurred_at DESC, {item_id_expression} DESC
          LIMIT ?"
    );
    let mut values = viewer_ids
        .iter()
        .chain(viewer_ids.iter())
        .cloned()
        .map(Value::from)
        .collect::<Vec<_>>();
    values.extend(viewer_ids.iter().cloned().map(Value::from));
    if let Some(cursor) = cursor {
        values.push(Value::from(cursor.occurred_at));
        values.push(Value::from(cursor.occurred_at));
        values.push(Value::from(cursor.item_id.clone()));
    }
    values.push(Value::from(limit as i64));
    let mut statement = connection.prepare(&sql).map_err(db_error)?;
    let rows = statement
        .query_map(params_from_iter(values), |row| {
            let event_id: String = row.get(0)?;
            let event_kind: String = row.get(1)?;
            let actor_id: Option<String> = row.get(2)?;
            let payload_raw: String = row.get(3)?;
            let payload: serde_json::Value = serde_json::from_str(&payload_raw).unwrap_or_default();
            let title = payload
                .get("title")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| row.get::<_, String>(11).unwrap_or_default());
            let summary = payload
                .get("comment")
                .and_then(serde_json::Value::as_str)
                .and_then(work_item_summary_excerpt)
                .or_else(|| {
                    payload
                        .get("failure")
                        .and_then(|failure| failure.get("message"))
                        .and_then(serde_json::Value::as_str)
                        .and_then(work_item_summary_excerpt)
                });
            Ok(TeamInboxItem {
                id: subscription_item_id(&event_id),
                kind: if event_kind == "run_failed" {
                    TeamInboxItemKind::WorkItemRunFailed
                } else {
                    TeamInboxItemKind::WorkItemUpdated
                },
                occurred_at: row.get(4)?,
                read_at: row.get(15)?,
                actor: actor_id.map(|id| TeamInboxActor {
                    display_name: id.clone(),
                    id,
                    avatar_url: None,
                }),
                target: TeamInboxTarget::WorkItem {
                    work_item_id: row.get(5)?,
                    org_id: row.get(6)?,
                    project_id: row.get(7)?,
                    project_slug: row.get(8)?,
                    repository: row.get(9)?,
                    short_id: row.get(10)?,
                },
                payload: TeamInboxPayload::WorkItemUpdated {
                    title,
                    event_kind,
                    status: row.get(12)?,
                    priority: row.get(13)?,
                    recipient_member_id: row.get(14)?,
                    summary,
                },
            })
        })
        .map_err(db_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(db_error)
}

fn list_assigned_items(
    connection: &Connection,
    viewer_ids: &[String],
    cursor: Option<&TeamInboxCursor>,
    limit: usize,
    archived_only: bool,
) -> Result<Vec<TeamInboxItem>, String> {
    let viewer_placeholders = sql_placeholders(viewer_ids.len());
    let assignment_predicate = assignment_predicate(&viewer_placeholders);
    let receipt_viewer_predicate = format!("r.viewer_member_id IN ({viewer_placeholders})");
    let archive_predicate = archive_receipt_predicate(
        ASSIGNED_SOURCE_KIND,
        "w.id",
        &viewer_placeholders,
        archived_only,
    );
    let cursor_predicate = if cursor.is_some() {
        format!(
            "AND (w.updated_at < ? OR
                   (w.updated_at = ? AND ('{ASSIGNED_SOURCE_KIND}:' || w.id) < ?))"
        )
    } else {
        String::new()
    };
    let sql = format!(
        "SELECT w.id, w.org_id, w.project_id, p.slug,
                CASE WHEN json_valid(p.linked_repos_json)
                     THEN json_extract(p.linked_repos_json, '$[0]')
                     ELSE NULL
                END AS repository,
                w.short_id, w.title, w.status, w.priority,
                COALESCE(w.assigned_human_id, w.assignee), w.updated_at,
                (SELECT MAX(r.read_at) FROM team_inbox_read_receipts r
                  WHERE r.source_kind = '{ASSIGNED_SOURCE_KIND}'
                    AND r.source_id = w.id AND {receipt_viewer_predicate}) AS read_at,
                w.body, e.extras_json
           FROM workitems w
           LEFT JOIN projects p ON p.id = w.project_id
           LEFT JOIN workitem_extras e ON e.work_item_id = w.id
          WHERE w.deleted_at IS NULL
            AND {ACTIONABLE_ASSIGNMENT_PREDICATE}
            AND {assignment_predicate}
            AND {archive_predicate}
          {cursor_predicate}
          ORDER BY w.updated_at DESC, w.id DESC
          LIMIT ?"
    );

    let mut values = assignment_values(viewer_ids);
    values.extend(viewer_ids.iter().cloned().map(Value::from));
    values.extend(viewer_ids.iter().cloned().map(Value::from));
    if let Some(cursor) = cursor {
        values.push(Value::from(cursor.occurred_at));
        values.push(Value::from(cursor.occurred_at));
        values.push(Value::from(cursor.item_id.clone()));
    }
    values.push(Value::from(limit as i64));

    let mut statement = connection.prepare(&sql).map_err(db_error)?;
    let rows = statement
        .query_map(params_from_iter(values), |row| {
            let work_item_id: String = row.get(0)?;
            let assignee_member_id: String = row.get(9)?;
            let body: String = row.get(12)?;
            let extras_json: Option<String> = row.get(13)?;
            let handoff = handoff_from_extras(extras_json.as_deref());
            let actor = handoff
                .as_ref()
                .map(handoff_actor)
                .or_else(|| assignment_actor(extras_json.as_deref(), &assignee_member_id));
            Ok(TeamInboxItem {
                id: assigned_item_id(&work_item_id),
                kind: TeamInboxItemKind::WorkItemAssigned,
                occurred_at: row.get(10)?,
                read_at: row.get(11)?,
                actor,
                target: TeamInboxTarget::WorkItem {
                    work_item_id,
                    org_id: row.get(1)?,
                    project_id: row.get(2)?,
                    project_slug: row.get(3)?,
                    repository: row.get(4)?,
                    short_id: row.get(5)?,
                },
                payload: TeamInboxPayload::WorkItemAssigned {
                    title: row.get(6)?,
                    status: row.get(7)?,
                    priority: row.get(8)?,
                    assignee_member_id,
                    summary: work_item_summary_excerpt(&body),
                    handoff,
                },
            })
        })
        .map_err(db_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(db_error)
}

fn list_work_item_comment_mentions(
    connection: &Connection,
    viewer_ids: &[String],
    cursor: Option<&TeamInboxCursor>,
    limit: usize,
    archived_only: bool,
) -> Result<Vec<TeamInboxItem>, String> {
    let placeholders = sql_placeholders(viewer_ids.len());
    let receipt_viewer_predicate = format!("r.viewer_member_id IN ({placeholders})");
    let occurred_expression =
        "CAST((julianday(json_extract(c.value, '$.created_at')) - 2440587.5) * 86400000 AS INTEGER)";
    let item_id_expression =
        format!("'{COMMENT_MENTION_SOURCE_KIND}:' || w.id || ':' || json_extract(c.value, '$.id')");
    let archive_predicate = archive_receipt_predicate(
        COMMENT_MENTION_SOURCE_KIND,
        "w.id || ':' || json_extract(c.value, '$.id')",
        &placeholders,
        archived_only,
    );
    let cursor_predicate = if cursor.is_some() {
        format!(
            "AND ({occurred_expression} < ? OR
                  ({occurred_expression} = ? AND {item_id_expression} < ?))"
        )
    } else {
        String::new()
    };
    let sql = format!(
        "SELECT w.id, w.org_id, w.project_id, p.slug, w.short_id, w.title,
                json_extract(c.value, '$.id'),
                json_extract(c.value, '$.author'),
                json_extract(c.value, '$.content'),
                {occurred_expression} AS occurred_at,
                (SELECT MAX(r.read_at) FROM team_inbox_read_receipts r
                  WHERE r.source_kind = '{COMMENT_MENTION_SOURCE_KIND}'
                    AND r.source_id = w.id || ':' || json_extract(c.value, '$.id')
                    AND {receipt_viewer_predicate}) AS read_at,
                json_array_length(COALESCE(json_extract(e.extras_json, '$.comments'), '[]'))
           FROM workitems w
           JOIN workitem_extras e ON e.work_item_id = w.id
           JOIN json_each(COALESCE(json_extract(e.extras_json, '$.comments'), '[]')) c
           LEFT JOIN projects p ON p.id = w.project_id
          WHERE w.deleted_at IS NULL
            AND EXISTS (
                SELECT 1
                  FROM json_each(COALESCE(json_extract(c.value, '$.mentioned_user_ids'), '[]')) m
                 WHERE CAST(m.value AS TEXT) IN ({placeholders})
            )
            AND {archive_predicate}
            {cursor_predicate}
          ORDER BY occurred_at DESC, {item_id_expression} DESC
          LIMIT ?"
    );
    let mut values = viewer_ids
        .iter()
        .cloned()
        .map(Value::from)
        .collect::<Vec<_>>();
    values.extend(viewer_ids.iter().cloned().map(Value::from));
    values.extend(viewer_ids.iter().cloned().map(Value::from));
    if let Some(cursor) = cursor {
        values.push(Value::from(cursor.occurred_at));
        values.push(Value::from(cursor.occurred_at));
        values.push(Value::from(cursor.item_id.clone()));
    }
    values.push(Value::from(limit as i64));

    let mut statement = connection.prepare(&sql).map_err(db_error)?;
    let rows = statement
        .query_map(params_from_iter(values), |row| {
            let work_item_id: String = row.get(0)?;
            let comment_id: String = row.get(6)?;
            let author: String = row.get(7)?;
            let content: String = row.get(8)?;
            Ok(TeamInboxItem {
                id: comment_mention_item_id(&work_item_id, &comment_id),
                kind: TeamInboxItemKind::CommentMention,
                occurred_at: row.get(9)?,
                read_at: row.get(10)?,
                actor: Some(TeamInboxActor {
                    id: author.clone(),
                    display_name: author,
                    avatar_url: None,
                }),
                target: TeamInboxTarget::WorkItemComment {
                    work_item_id,
                    org_id: row.get(1)?,
                    project_id: row.get(2)?,
                    project_slug: row.get(3)?,
                    short_id: row.get(4)?,
                    comment_id,
                },
                payload: TeamInboxPayload::CommentMention {
                    session_title: row.get(5)?,
                    comment_excerpt: work_item_summary_excerpt(&content).unwrap_or_default(),
                    comment_count: row.get::<_, i64>(11)?.max(0) as u32,
                },
            })
        })
        .map_err(db_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(db_error)
}

pub(crate) fn unread_count_with_connection(
    connection: &Connection,
    viewer_member_ids: &[String],
    filter: TeamInboxFilter,
) -> Result<u64, String> {
    Ok(unread_counts_with_connection(connection, viewer_member_ids, filter)?.all)
}

fn unread_counts_with_connection(
    connection: &Connection,
    viewer_member_ids: &[String],
    filter: TeamInboxFilter,
) -> Result<TeamInboxUnreadCounts, String> {
    init_team_inbox_tables(connection).map_err(db_error)?;
    let viewer_ids = normalized_viewer_ids(viewer_member_ids)?;
    if filter == TeamInboxFilter::Archived {
        return Ok(TeamInboxUnreadCounts::default());
    }
    let assigned_count = if filter == TeamInboxFilter::Mentions {
        0
    } else {
        assigned_unread_count(connection, &viewer_ids)?
    };
    let mention_count = if filter == TeamInboxFilter::Assigned {
        0
    } else {
        comment_mention_unread_count(connection, &viewer_ids)?
    };
    let updates_count = if filter == TeamInboxFilter::All {
        subscription_event_unread_count(connection, &viewer_ids)?
    } else {
        0
    };
    Ok(TeamInboxUnreadCounts {
        all: assigned_count + mention_count + updates_count,
        mentions: mention_count,
        assigned: assigned_count,
        updates: updates_count,
    })
}

fn subscription_event_unread_count(
    connection: &Connection,
    viewer_ids: &[String],
) -> Result<u64, String> {
    let placeholders = sql_placeholders(viewer_ids.len());
    let receipt_placeholders = sql_placeholders(viewer_ids.len());
    let sql = format!(
        "SELECT COUNT(*)
           FROM pm_work_item_inbox_events event
           JOIN workitems w ON w.short_id = event.work_item_id
           LEFT JOIN projects p ON p.id = w.project_id
          WHERE event.archived_at IS NULL
            AND event.kind <> 'mention'
            AND event.recipient_id IN ({placeholders})
            AND w.deleted_at IS NULL
            AND ((event.scope_key = 'project:' || p.slug)
                 OR (w.project_id IS NULL AND event.scope_key = 'org:' || w.org_id))
            AND NOT EXISTS (
                SELECT 1 FROM team_inbox_read_receipts receipt
                 WHERE receipt.source_kind = '{SUBSCRIPTION_SOURCE_KIND}'
                   AND receipt.source_id = event.id
                   AND receipt.viewer_member_id IN ({receipt_placeholders})
            )"
    );
    let values = viewer_ids
        .iter()
        .chain(viewer_ids.iter())
        .cloned()
        .map(Value::from)
        .collect::<Vec<_>>();
    let count: i64 = connection
        .query_row(&sql, params_from_iter(values), |row| row.get(0))
        .map_err(db_error)?;
    Ok(count.max(0) as u64)
}

fn assigned_unread_count(connection: &Connection, viewer_ids: &[String]) -> Result<u64, String> {
    let placeholders = sql_placeholders(viewer_ids.len());
    let sql = format!(
        "SELECT COUNT(*) FROM workitems w
          WHERE w.deleted_at IS NULL
            AND {ACTIONABLE_ASSIGNMENT_PREDICATE}
            AND {}
            AND NOT EXISTS (
                SELECT 1 FROM team_inbox_read_receipts r
                 WHERE r.source_kind = '{ASSIGNED_SOURCE_KIND}'
                   AND r.source_id = w.id
                   AND r.viewer_member_id IN ({placeholders})
            )",
        assignment_predicate(&placeholders)
    );
    let mut values = assignment_values(viewer_ids);
    values.extend(viewer_ids.iter().cloned().map(Value::from));
    let count: i64 = connection
        .query_row(&sql, params_from_iter(values), |row| row.get(0))
        .map_err(db_error)?;
    Ok(count.max(0) as u64)
}

fn comment_mention_unread_count(
    connection: &Connection,
    viewer_ids: &[String],
) -> Result<u64, String> {
    let placeholders = sql_placeholders(viewer_ids.len());
    let sql = format!(
        "SELECT COUNT(*)
           FROM workitems w
           JOIN workitem_extras e ON e.work_item_id = w.id
           JOIN json_each(COALESCE(json_extract(e.extras_json, '$.comments'), '[]')) c
          WHERE w.deleted_at IS NULL
            AND EXISTS (
                SELECT 1
                  FROM json_each(COALESCE(json_extract(c.value, '$.mentioned_user_ids'), '[]')) m
                 WHERE CAST(m.value AS TEXT) IN ({placeholders})
            )
            AND NOT EXISTS (
                SELECT 1 FROM team_inbox_read_receipts r
                 WHERE r.source_kind = '{COMMENT_MENTION_SOURCE_KIND}'
                   AND r.source_id = w.id || ':' || json_extract(c.value, '$.id')
                   AND r.viewer_member_id IN ({placeholders})
            )"
    );
    let mut values = viewer_ids
        .iter()
        .chain(viewer_ids.iter())
        .cloned()
        .map(Value::from)
        .collect::<Vec<_>>();
    let count: i64 = connection
        .query_row(&sql, params_from_iter(values.drain(..)), |row| row.get(0))
        .map_err(db_error)?;
    Ok(count.max(0) as u64)
}

struct AccessibleInboxSource {
    kind: &'static str,
    id: String,
    sql: String,
    values: Vec<Value>,
}

/// Resolve an inbox item id back to an authoritative, currently visible source.
/// Receipt writers use this inside their transaction so stale, orphaned, or
/// cross-viewer ids cannot manufacture durable read/archive state.
fn accessible_inbox_source(
    viewer_ids: &[String],
    item_id: &str,
) -> Result<AccessibleInboxSource, String> {
    let placeholders = sql_placeholders(viewer_ids.len());
    if let Some(source_id) = assigned_source_id(item_id) {
        let sql = format!(
            "SELECT 1 FROM workitems w
              WHERE w.id = ?
                AND w.deleted_at IS NULL
                AND {ACTIONABLE_ASSIGNMENT_PREDICATE}
                AND {}",
            assignment_predicate(&placeholders)
        );
        let mut values = vec![Value::from(source_id.to_string())];
        values.extend(assignment_values(viewer_ids));
        Ok(AccessibleInboxSource {
            kind: ASSIGNED_SOURCE_KIND,
            id: source_id.to_string(),
            sql,
            values,
        })
    } else if let Some(source_id) = comment_mention_source_id(item_id) {
        let sql = format!(
            "SELECT 1
               FROM workitems w
               JOIN workitem_extras e ON e.work_item_id = w.id
               JOIN json_each(COALESCE(json_extract(e.extras_json, '$.comments'), '[]')) c
              WHERE w.deleted_at IS NULL
                AND w.id || ':' || json_extract(c.value, '$.id') = ?
                AND EXISTS (
                    SELECT 1
                      FROM json_each(COALESCE(json_extract(c.value, '$.mentioned_user_ids'), '[]')) m
                     WHERE CAST(m.value AS TEXT) IN ({placeholders})
                )"
        );
        let mut values = vec![Value::from(source_id.to_string())];
        values.extend(viewer_ids.iter().cloned().map(Value::from));
        Ok(AccessibleInboxSource {
            kind: COMMENT_MENTION_SOURCE_KIND,
            id: source_id.to_string(),
            sql,
            values,
        })
    } else if let Some(source_id) = subscription_source_id(item_id) {
        let sql = format!(
            "SELECT 1
               FROM pm_work_item_inbox_events event
               JOIN workitems w ON w.short_id = event.work_item_id
               LEFT JOIN projects p ON p.id = w.project_id
              WHERE event.id = ?
                AND event.archived_at IS NULL
                AND event.recipient_id IN ({placeholders})
                AND w.deleted_at IS NULL
                AND ((event.scope_key = 'project:' || p.slug)
                     OR (w.project_id IS NULL AND event.scope_key = 'org:' || w.org_id))"
        );
        let mut values = vec![Value::from(source_id.to_string())];
        values.extend(viewer_ids.iter().cloned().map(Value::from));
        Ok(AccessibleInboxSource {
            kind: SUBSCRIPTION_SOURCE_KIND,
            id: source_id.to_string(),
            sql,
            values,
        })
    } else {
        Err(format!("Unsupported Team Inbox item id: {item_id}"))
    }
}

pub(crate) fn mark_read_with_connection(
    connection: &mut Connection,
    viewer_member_ids: &[String],
    item_id: &str,
    read_at: i64,
) -> Result<bool, String> {
    init_team_inbox_tables(connection).map_err(db_error)?;
    let viewer_ids = normalized_viewer_ids(viewer_member_ids)?;
    let source = accessible_inbox_source(&viewer_ids, item_id)?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let exists = tx
        .query_row(&source.sql, params_from_iter(source.values), |_| Ok(()))
        .optional()
        .map_err(db_error)?
        .is_some();
    if !exists {
        tx.commit().map_err(db_error)?;
        return Ok(false);
    }

    for viewer_id in &viewer_ids {
        tx.execute(
            "INSERT INTO team_inbox_read_receipts
                (viewer_member_id, source_kind, source_id, read_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(viewer_member_id, source_kind, source_id)
             DO UPDATE SET read_at = MAX(read_at, excluded.read_at)",
            (viewer_id, source.kind, &source.id, read_at),
        )
        .map_err(db_error)?;
    }
    tx.commit().map_err(db_error)?;
    Ok(true)
}

pub(crate) fn mark_all_read_with_connection(
    connection: &mut Connection,
    viewer_member_ids: &[String],
    filter: TeamInboxFilter,
    read_at: i64,
) -> Result<u64, String> {
    init_team_inbox_tables(connection).map_err(db_error)?;
    let viewer_ids = normalized_viewer_ids(viewer_member_ids)?;
    if filter == TeamInboxFilter::Archived {
        return Ok(0);
    }
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let before = unread_count_with_connection(&tx, &viewer_ids, filter)?;
    let placeholders = sql_placeholders(viewer_ids.len());
    let mut sources = Vec::<(&'static str, String)>::new();
    if filter != TeamInboxFilter::Mentions {
        // Only touch rows that are still unread for this viewer set.
        let query = format!(
            "SELECT w.id FROM workitems w
              WHERE w.deleted_at IS NULL
                AND {ACTIONABLE_ASSIGNMENT_PREDICATE}
                AND {}
                AND NOT EXISTS (
                    SELECT 1 FROM team_inbox_read_receipts r
                     WHERE r.source_kind = '{ASSIGNED_SOURCE_KIND}'
                       AND r.source_id = w.id
                       AND r.viewer_member_id IN ({placeholders})
                )",
            assignment_predicate(&placeholders)
        );
        let mut values = assignment_values(&viewer_ids);
        values.extend(viewer_ids.iter().cloned().map(Value::from));
        let mut statement = tx.prepare(&query).map_err(db_error)?;
        let rows = statement
            .query_map(params_from_iter(values), |row| row.get::<_, String>(0))
            .map_err(db_error)?;
        sources.extend(
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(db_error)?
                .into_iter()
                .map(|id| (ASSIGNED_SOURCE_KIND, id)),
        );
    }
    if filter != TeamInboxFilter::Assigned {
        let query = format!(
            "SELECT w.id || ':' || json_extract(c.value, '$.id')
               FROM workitems w
               JOIN workitem_extras e ON e.work_item_id = w.id
               JOIN json_each(COALESCE(json_extract(e.extras_json, '$.comments'), '[]')) c
              WHERE w.deleted_at IS NULL
                AND EXISTS (
                    SELECT 1
                      FROM json_each(COALESCE(json_extract(c.value, '$.mentioned_user_ids'), '[]')) m
                     WHERE CAST(m.value AS TEXT) IN ({placeholders})
                )
                AND NOT EXISTS (
                    SELECT 1 FROM team_inbox_read_receipts r
                     WHERE r.source_kind = '{COMMENT_MENTION_SOURCE_KIND}'
                       AND r.source_id = w.id || ':' || json_extract(c.value, '$.id')
                       AND r.viewer_member_id IN ({placeholders})
                )"
        );
        let values = viewer_ids
            .iter()
            .chain(viewer_ids.iter())
            .cloned()
            .map(Value::from)
            .collect::<Vec<_>>();
        let mut statement = tx.prepare(&query).map_err(db_error)?;
        let rows = statement
            .query_map(params_from_iter(values), |row| row.get::<_, String>(0))
            .map_err(db_error)?;
        sources.extend(
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(db_error)?
                .into_iter()
                .map(|id| (COMMENT_MENTION_SOURCE_KIND, id)),
        );
    }
    if filter == TeamInboxFilter::All {
        let query = format!(
            "SELECT event.id
               FROM pm_work_item_inbox_events event
               JOIN workitems w ON w.short_id = event.work_item_id
               LEFT JOIN projects p ON p.id = w.project_id
              WHERE event.archived_at IS NULL
                AND event.kind <> 'mention'
                AND event.recipient_id IN ({placeholders})
                AND w.deleted_at IS NULL
                AND ((event.scope_key = 'project:' || p.slug)
                     OR (w.project_id IS NULL AND event.scope_key = 'org:' || w.org_id))
                AND NOT EXISTS (
                    SELECT 1 FROM team_inbox_read_receipts receipt
                     WHERE receipt.source_kind = '{SUBSCRIPTION_SOURCE_KIND}'
                       AND receipt.source_id = event.id
                       AND receipt.viewer_member_id IN ({placeholders})
                )"
        );
        let values = viewer_ids
            .iter()
            .chain(viewer_ids.iter())
            .cloned()
            .map(Value::from)
            .collect::<Vec<_>>();
        let mut statement = tx.prepare(&query).map_err(db_error)?;
        let rows = statement
            .query_map(params_from_iter(values), |row| row.get::<_, String>(0))
            .map_err(db_error)?;
        sources.extend(
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(db_error)?
                .into_iter()
                .map(|id| (SUBSCRIPTION_SOURCE_KIND, id)),
        );
    }

    for (source_kind, source_id) in sources {
        for viewer_id in &viewer_ids {
            tx.execute(
                "INSERT INTO team_inbox_read_receipts
                    (viewer_member_id, source_kind, source_id, read_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(viewer_member_id, source_kind, source_id)
                 DO UPDATE SET read_at = MAX(read_at, excluded.read_at)",
                (viewer_id, source_kind, &source_id, read_at),
            )
            .map_err(db_error)?;
        }
    }
    tx.commit().map_err(db_error)?;
    Ok(before)
}

pub(crate) fn mark_unread_with_connection(
    connection: &mut Connection,
    viewer_member_ids: &[String],
    item_id: &str,
) -> Result<bool, String> {
    init_team_inbox_tables(connection).map_err(db_error)?;
    let viewer_ids = normalized_viewer_ids(viewer_member_ids)?;
    let (source_kind, source_id) = if let Some(source_id) = assigned_source_id(item_id) {
        (ASSIGNED_SOURCE_KIND, source_id)
    } else if let Some(source_id) = comment_mention_source_id(item_id) {
        (COMMENT_MENTION_SOURCE_KIND, source_id)
    } else if let Some(source_id) = subscription_source_id(item_id) {
        (SUBSCRIPTION_SOURCE_KIND, source_id)
    } else {
        return Err(format!("Unsupported Team Inbox item id: {item_id}"));
    };
    let placeholders = sql_placeholders(viewer_ids.len());
    let sql = format!(
        "DELETE FROM team_inbox_read_receipts
          WHERE source_kind = ?
            AND source_id = ?
            AND viewer_member_id IN ({placeholders})"
    );
    let mut values = vec![
        Value::from(source_kind.to_string()),
        Value::from(source_id.to_string()),
    ];
    values.extend(viewer_ids.iter().cloned().map(Value::from));
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let affected = tx
        .execute(&sql, params_from_iter(values))
        .map_err(db_error)?;
    tx.commit().map_err(db_error)?;
    Ok(affected > 0)
}

/// Archive is a per-viewer disposition on an inbox row, keyed exactly like
/// a read receipt. Archiving also marks the row read so unread counts stay
/// consistent without every counting query learning about archives.
pub(crate) fn set_archived_with_connection(
    connection: &mut Connection,
    viewer_member_ids: &[String],
    item_id: &str,
    archived: bool,
    archived_at: i64,
) -> Result<bool, String> {
    init_team_inbox_tables(connection).map_err(db_error)?;
    let viewer_ids = normalized_viewer_ids(viewer_member_ids)?;
    let source = accessible_inbox_source(&viewer_ids, item_id)?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let exists = tx
        .query_row(&source.sql, params_from_iter(source.values), |_| Ok(()))
        .optional()
        .map_err(db_error)?
        .is_some();
    if !exists {
        tx.commit().map_err(db_error)?;
        return Ok(false);
    }
    for viewer_id in &viewer_ids {
        if archived {
            tx.execute(
                "INSERT INTO team_inbox_archive_receipts
                    (viewer_member_id, source_kind, source_id, archived_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(viewer_member_id, source_kind, source_id)
                 DO UPDATE SET archived_at = excluded.archived_at",
                (viewer_id, source.kind, &source.id, archived_at),
            )
            .map_err(db_error)?;
            tx.execute(
                "INSERT INTO team_inbox_read_receipts
                    (viewer_member_id, source_kind, source_id, read_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(viewer_member_id, source_kind, source_id)
                 DO UPDATE SET read_at = MAX(read_at, excluded.read_at)",
                (viewer_id, source.kind, &source.id, archived_at),
            )
            .map_err(db_error)?;
        } else {
            tx.execute(
                "DELETE FROM team_inbox_archive_receipts
                  WHERE viewer_member_id = ?1 AND source_kind = ?2 AND source_id = ?3",
                (viewer_id, source.kind, &source.id),
            )
            .map_err(db_error)?;
        }
    }
    tx.commit().map_err(db_error)?;
    Ok(!viewer_ids.is_empty())
}

fn normalized_viewer_ids(viewer_member_ids: &[String]) -> Result<Vec<String>, String> {
    let ids = viewer_member_ids
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    if ids.is_empty() {
        return Err("viewerMemberIds must contain at least one non-empty member id".to_string());
    }
    Ok(ids)
}

fn assignment_predicate(placeholders: &str) -> String {
    format!(
        "(w.assigned_human_id IN ({placeholders}) OR
          (w.assignee IN ({placeholders}) AND
           (w.assignee_type IS NULL OR LOWER(w.assignee_type) IN ('member', 'human'))))"
    )
}

fn assignment_values(viewer_ids: &[String]) -> Vec<Value> {
    viewer_ids
        .iter()
        .chain(viewer_ids.iter())
        .cloned()
        .map(Value::from)
        .collect()
}

fn sql_placeholders(count: usize) -> String {
    std::iter::repeat_n("?", count)
        .collect::<Vec<_>>()
        .join(", ")
}

fn archive_receipt_predicate(
    source_kind: &str,
    source_id_expression: &str,
    viewer_placeholders: &str,
    archived_only: bool,
) -> String {
    let operator = if archived_only {
        "EXISTS"
    } else {
        "NOT EXISTS"
    };
    format!(
        "{operator} (
            SELECT 1 FROM team_inbox_archive_receipts archive
             WHERE archive.source_kind = '{source_kind}'
               AND archive.source_id = {source_id_expression}
               AND archive.viewer_member_id IN ({viewer_placeholders})
        )"
    )
}

fn assigned_item_id(source_id: &str) -> String {
    format!("{ASSIGNED_SOURCE_KIND}:{source_id}")
}

fn assigned_source_id(item_id: &str) -> Option<&str> {
    item_id
        .strip_prefix(ASSIGNED_SOURCE_KIND)
        .and_then(|value| value.strip_prefix(':'))
        .filter(|value| !value.is_empty())
}

fn comment_mention_item_id(work_item_id: &str, comment_id: &str) -> String {
    format!("{COMMENT_MENTION_SOURCE_KIND}:{work_item_id}:{comment_id}")
}

fn comment_mention_source_id(item_id: &str) -> Option<&str> {
    item_id
        .strip_prefix(COMMENT_MENTION_SOURCE_KIND)
        .and_then(|value| value.strip_prefix(':'))
        .filter(|value| value.split_once(':').is_some())
}

fn subscription_item_id(source_id: &str) -> String {
    format!("{SUBSCRIPTION_SOURCE_KIND}:{source_id}")
}

fn subscription_source_id(item_id: &str) -> Option<&str> {
    item_id
        .strip_prefix(SUBSCRIPTION_SOURCE_KIND)
        .and_then(|value| value.strip_prefix(':'))
        .filter(|value| !value.is_empty())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn db_error(error: rusqlite::Error) -> String {
    format!("DB error: {error}")
}

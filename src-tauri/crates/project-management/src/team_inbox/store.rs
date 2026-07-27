use std::collections::BTreeSet;
use std::time::{SystemTime, UNIX_EPOCH};

use database::db::get_projects_connection;
use rusqlite::{
    params_from_iter, types::Value, Connection, OptionalExtension, TransactionBehavior,
};

use super::{
    schema::init_team_inbox_tables, TeamInboxCursor, TeamInboxFilter, TeamInboxItem,
    TeamInboxItemKind, TeamInboxPage, TeamInboxPayload, TeamInboxTarget,
};

const ASSIGNED_SOURCE_KIND: &str = "work_item_assigned";
const DEFAULT_PAGE_LIMIT: usize = 50;
const MAX_PAGE_LIMIT: usize = 100;
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

fn open_connection() -> Result<Connection, String> {
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
    if options.filter == TeamInboxFilter::Mentions {
        return Ok(TeamInboxPage {
            items: Vec::new(),
            next_cursor: None,
            unread_count: 0,
        });
    }

    let limit = options.limit.clamp(1, MAX_PAGE_LIMIT);
    let cursor_source_id = options
        .cursor
        .as_ref()
        .map(|cursor| {
            assigned_source_id(&cursor.item_id)
                .map(ToOwned::to_owned)
                .ok_or_else(|| format!("Unsupported Team Inbox cursor item id: {}", cursor.item_id))
        })
        .transpose()?;
    let viewer_placeholders = sql_placeholders(viewer_ids.len());
    let assignment_predicate = assignment_predicate(&viewer_placeholders);
    let receipt_viewer_predicate = format!("r.viewer_member_id IN ({viewer_placeholders})");
    let cursor_predicate = if options.cursor.is_some() {
        "AND (w.updated_at < ? OR (w.updated_at = ? AND w.id < ?))"
    } else {
        ""
    };
    let sql = format!(
        "SELECT w.id, w.org_id, w.project_id, p.slug, w.short_id, w.title,
                w.status, w.priority, COALESCE(w.assigned_human_id, w.assignee),
                w.updated_at,
                (SELECT MAX(r.read_at) FROM team_inbox_read_receipts r
                  WHERE r.source_kind = '{ASSIGNED_SOURCE_KIND}'
                    AND r.source_id = w.id AND {receipt_viewer_predicate}) AS read_at,
                w.body
           FROM workitems w
           LEFT JOIN projects p ON p.id = w.project_id
          WHERE w.deleted_at IS NULL AND {assignment_predicate}
          {cursor_predicate}
          ORDER BY w.updated_at DESC, w.id DESC
          LIMIT ?"
    );

    let mut values = assignment_values(&viewer_ids);
    values.extend(viewer_ids.iter().cloned().map(Value::from));
    if let (Some(cursor), Some(source_id)) = (options.cursor.as_ref(), cursor_source_id) {
        values.push(Value::from(cursor.occurred_at));
        values.push(Value::from(cursor.occurred_at));
        values.push(Value::from(source_id));
    }
    values.push(Value::from((limit + 1) as i64));

    let mut statement = connection.prepare(&sql).map_err(db_error)?;
    let rows = statement
        .query_map(params_from_iter(values), |row| {
            let work_item_id: String = row.get(0)?;
            let assignee_member_id: String = row.get(8)?;
            let body: String = row.get(11)?;
            Ok(TeamInboxItem {
                id: assigned_item_id(&work_item_id),
                kind: TeamInboxItemKind::WorkItemAssigned,
                occurred_at: row.get(9)?,
                read_at: row.get(10)?,
                actor: None,
                target: TeamInboxTarget::WorkItem {
                    work_item_id,
                    org_id: row.get(1)?,
                    project_id: row.get(2)?,
                    project_slug: row.get(3)?,
                    short_id: row.get(4)?,
                },
                payload: TeamInboxPayload::WorkItemAssigned {
                    title: row.get(5)?,
                    status: row.get(6)?,
                    priority: row.get(7)?,
                    assignee_member_id,
                    summary: work_item_summary_excerpt(&body),
                },
            })
        })
        .map_err(db_error)?;
    let mut items = rows.collect::<Result<Vec<_>, _>>().map_err(db_error)?;
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
    let unread_count = unread_count_with_connection(connection, &viewer_ids, options.filter)?;

    Ok(TeamInboxPage {
        items,
        next_cursor,
        unread_count,
    })
}

pub(crate) fn unread_count_with_connection(
    connection: &Connection,
    viewer_member_ids: &[String],
    filter: TeamInboxFilter,
) -> Result<u64, String> {
    init_team_inbox_tables(connection).map_err(db_error)?;
    let viewer_ids = normalized_viewer_ids(viewer_member_ids)?;
    if filter == TeamInboxFilter::Mentions {
        return Ok(0);
    }
    let placeholders = sql_placeholders(viewer_ids.len());
    let sql = format!(
        "SELECT COUNT(*) FROM workitems w
          WHERE w.deleted_at IS NULL
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
    values.extend(viewer_ids.into_iter().map(Value::from));
    let count: i64 = connection
        .query_row(&sql, params_from_iter(values), |row| row.get(0))
        .map_err(db_error)?;
    Ok(count as u64)
}

pub(crate) fn mark_read_with_connection(
    connection: &mut Connection,
    viewer_member_ids: &[String],
    item_id: &str,
    read_at: i64,
) -> Result<bool, String> {
    init_team_inbox_tables(connection).map_err(db_error)?;
    let viewer_ids = normalized_viewer_ids(viewer_member_ids)?;
    let source_id = assigned_source_id(item_id)
        .ok_or_else(|| format!("Unsupported Team Inbox item id: {item_id}"))?;
    let placeholders = sql_placeholders(viewer_ids.len());
    let sql = format!(
        "SELECT 1 FROM workitems w WHERE w.id = ? AND w.deleted_at IS NULL AND {}",
        assignment_predicate(&placeholders)
    );
    let mut values = vec![Value::from(source_id.to_string())];
    values.extend(assignment_values(&viewer_ids));
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let exists = tx
        .query_row(&sql, params_from_iter(values), |_| Ok(()))
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
            (viewer_id, ASSIGNED_SOURCE_KIND, source_id, read_at),
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
    if filter == TeamInboxFilter::Mentions {
        return Ok(0);
    }
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let before = unread_count_with_connection(&tx, &viewer_ids, filter)?;
    let placeholders = sql_placeholders(viewer_ids.len());
    // Only touch rows that are still unread for this viewer set. Re-stamping
    // already-read receipts is wasted work (O(assigned × viewers) writes) and
    // this predicate mirrors `unread_count_with_connection`, so the post-state
    // is identical while the write set is bounded to what was actually unread.
    let query = format!(
        "SELECT w.id FROM workitems w
          WHERE w.deleted_at IS NULL
            AND {}
            AND NOT EXISTS (
                SELECT 1 FROM team_inbox_read_receipts r
                 WHERE r.source_kind = '{ASSIGNED_SOURCE_KIND}'
                   AND r.source_id = w.id
                   AND r.viewer_member_id IN ({placeholders})
            )",
        assignment_predicate(&placeholders)
    );
    let source_ids = {
        let mut values = assignment_values(&viewer_ids);
        values.extend(viewer_ids.iter().cloned().map(Value::from));
        let mut statement = tx.prepare(&query).map_err(db_error)?;
        let rows = statement
            .query_map(params_from_iter(values), |row| row.get::<_, String>(0))
            .map_err(db_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_error)?
    };

    for source_id in source_ids {
        for viewer_id in &viewer_ids {
            tx.execute(
                "INSERT INTO team_inbox_read_receipts
                    (viewer_member_id, source_kind, source_id, read_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(viewer_member_id, source_kind, source_id)
                 DO UPDATE SET read_at = MAX(read_at, excluded.read_at)",
                (viewer_id, ASSIGNED_SOURCE_KIND, &source_id, read_at),
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
    let source_id = assigned_source_id(item_id)
        .ok_or_else(|| format!("Unsupported Team Inbox item id: {item_id}"))?;
    let placeholders = sql_placeholders(viewer_ids.len());
    let sql = format!(
        "DELETE FROM team_inbox_read_receipts
          WHERE source_kind = '{ASSIGNED_SOURCE_KIND}'
            AND source_id = ?
            AND viewer_member_id IN ({placeholders})"
    );
    let mut values = vec![Value::from(source_id.to_string())];
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
    std::iter::repeat("?")
        .take(count)
        .collect::<Vec<_>>()
        .join(", ")
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

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn db_error(error: rusqlite::Error) -> String {
    format!("DB error: {error}")
}

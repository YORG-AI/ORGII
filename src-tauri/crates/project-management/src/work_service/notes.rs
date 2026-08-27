use crate::projects::io as project_io;
use crate::projects::types::WorkItemMutationActor;

/// Canonical `work.note` (`work.update.append`).
pub fn note_project_work_item(
    project_slug: &str,
    short_id: &str,
    kind: &str,
    body: &str,
    actor: Option<&WorkItemMutationActor>,
) -> Result<(), String> {
    note_project_work_item_threaded(project_slug, short_id, kind, body, None, actor, None)
}

/// Append a note as a reply in a persisted Discussion thread without waking
/// the linked Session again.
pub fn note_project_work_item_threaded(
    project_slug: &str,
    short_id: &str,
    kind: &str,
    body: &str,
    parent_id: Option<&str>,
    actor: Option<&WorkItemMutationActor>,
    agent_session_id: Option<&str>,
) -> Result<(), String> {
    let author = actor
        .map(|a| a.name.clone())
        .unwrap_or_else(|| "agent".to_string());
    let note_body = if kind == "comment" {
        body.to_string()
    } else {
        format!("[{}] {}", kind, body)
    };
    let reason = Some(kind.to_string());
    let body_owned = note_body;
    let parent_id = parent_id.map(str::to_string);
    let agent_session_id = agent_session_id.map(str::to_string);
    project_io::update_work_item_atomic_serviced(
        project_slug,
        short_id,
        actor,
        project_io::AtomicServiceOptions {
            operation: Some("work.note"),
            reason,
            ..Default::default()
        },
        move |frontmatter, _item_body| {
            let now = chrono::Utc::now().to_rfc3339();
            let thread_id = parent_id
                .as_deref()
                .map(|parent_id| {
                    frontmatter
                        .comments
                        .iter()
                        .find(|comment| comment.id == parent_id)
                        .map(|comment| {
                            comment
                                .thread_id
                                .clone()
                                .unwrap_or_else(|| comment.id.clone())
                        })
                        .ok_or_else(|| format!("Discussion parent '{parent_id}' not found"))
                })
                .transpose()?;
            frontmatter
                .comments
                .push(crate::projects::types::CommentEntry {
                    id: format!("note-{}", chrono::Utc::now().timestamp_millis()),
                    author,
                    content: body_owned,
                    created_at: now,
                    mentioned_user_ids: vec![],
                    parent_id,
                    thread_id,
                    agent_session_id,
                    ..Default::default()
                });
            Ok(())
        },
    )
}

/// Idempotent form of [`note_project_work_item`] for durable consumers.
pub fn note_project_work_item_idempotent(
    project_slug: &str,
    short_id: &str,
    note_id: &str,
    kind: &str,
    body: &str,
    actor: Option<&WorkItemMutationActor>,
) -> Result<(), String> {
    if note_id.trim().is_empty() {
        return Err("note_id is required".to_string());
    }
    let author = actor
        .map(|a| a.name.clone())
        .unwrap_or_else(|| "agent".to_string());
    let note_body = if kind == "comment" {
        body.to_string()
    } else {
        format!("[{}] {}", kind, body)
    };
    let stable_note_id = note_id.to_string();
    project_io::update_work_item_atomic_serviced(
        project_slug,
        short_id,
        actor,
        project_io::AtomicServiceOptions {
            operation: Some("work.note"),
            reason: Some(kind.to_string()),
            ..Default::default()
        },
        move |frontmatter, _item_body| {
            if frontmatter
                .comments
                .iter()
                .any(|comment| comment.id == stable_note_id)
            {
                return Ok(());
            }
            frontmatter
                .comments
                .push(crate::projects::types::CommentEntry {
                    id: stable_note_id,
                    author,
                    content: note_body,
                    created_at: chrono::Utc::now().to_rfc3339(),
                    mentioned_user_ids: vec![],
                    ..Default::default()
                });
            Ok(())
        },
    )
}

pub fn note_standalone_work_item(
    org_id: Option<&str>,
    short_id: &str,
    kind: &str,
    body: &str,
    actor: Option<&WorkItemMutationActor>,
) -> Result<(), String> {
    note_standalone_work_item_threaded(org_id, short_id, kind, body, None, actor, None)
}

pub fn note_standalone_work_item_threaded(
    org_id: Option<&str>,
    short_id: &str,
    kind: &str,
    body: &str,
    parent_id: Option<&str>,
    actor: Option<&WorkItemMutationActor>,
    agent_session_id: Option<&str>,
) -> Result<(), String> {
    let author = actor
        .map(|a| a.name.clone())
        .unwrap_or_else(|| "agent".to_string());
    let note_body = if kind == "comment" {
        body.to_string()
    } else {
        format!("[{}] {}", kind, body)
    };
    let parent_id = parent_id.map(str::to_string);
    let agent_session_id = agent_session_id.map(str::to_string);
    project_io::update_standalone_work_item_atomic_serviced(
        org_id,
        actor,
        project_io::AtomicServiceOptions {
            operation: Some("work.note"),
            reason: Some(kind.to_string()),
            ..Default::default()
        },
        short_id,
        move |frontmatter, _item_body| {
            let now = chrono::Utc::now().to_rfc3339();
            let thread_id = parent_id
                .as_deref()
                .map(|parent_id| {
                    frontmatter
                        .comments
                        .iter()
                        .find(|comment| comment.id == parent_id)
                        .map(|comment| {
                            comment
                                .thread_id
                                .clone()
                                .unwrap_or_else(|| comment.id.clone())
                        })
                        .ok_or_else(|| format!("Discussion parent '{parent_id}' not found"))
                })
                .transpose()?;
            frontmatter
                .comments
                .push(crate::projects::types::CommentEntry {
                    id: format!("note-{}", chrono::Utc::now().timestamp_millis()),
                    author,
                    content: note_body,
                    created_at: now,
                    mentioned_user_ids: vec![],
                    parent_id,
                    thread_id,
                    agent_session_id,
                    ..Default::default()
                });
            Ok(())
        },
    )
}

/// Standalone counterpart to [`note_project_work_item_idempotent`].
pub fn note_standalone_work_item_idempotent(
    org_id: Option<&str>,
    short_id: &str,
    note_id: &str,
    kind: &str,
    body: &str,
    actor: Option<&WorkItemMutationActor>,
) -> Result<(), String> {
    if note_id.trim().is_empty() {
        return Err("note_id is required".to_string());
    }
    let author = actor
        .map(|a| a.name.clone())
        .unwrap_or_else(|| "agent".to_string());
    let note_body = if kind == "comment" {
        body.to_string()
    } else {
        format!("[{}] {}", kind, body)
    };
    let stable_note_id = note_id.to_string();
    project_io::update_standalone_work_item_atomic_serviced(
        org_id,
        actor,
        project_io::AtomicServiceOptions {
            operation: Some("work.note"),
            reason: Some(kind.to_string()),
            ..Default::default()
        },
        short_id,
        move |frontmatter, _item_body| {
            if frontmatter
                .comments
                .iter()
                .any(|comment| comment.id == stable_note_id)
            {
                return Ok(());
            }
            frontmatter
                .comments
                .push(crate::projects::types::CommentEntry {
                    id: stable_note_id,
                    author,
                    content: note_body,
                    created_at: chrono::Utc::now().to_rfc3339(),
                    mentioned_user_ids: vec![],
                    ..Default::default()
                });
            Ok(())
        },
    )
}

/// True when `actor_id` appended a `work.note` audit row on the item at or
/// after `since_unix_ms`.
pub fn work_item_noted_by_actor_since(
    short_id: &str,
    actor_id: &str,
    since_unix_ms: i64,
) -> Result<bool, String> {
    let connection = project_io::helpers::conn()?;
    connection
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM pm_audit_events
                WHERE entity_type = 'work_item' AND entity_id = ?1
                  AND actor_id = ?2 AND operation = 'work.note'
                  AND occurred_at >= ?3)",
            rusqlite::params![short_id, actor_id, since_unix_ms],
            |row| row.get::<_, i64>(0),
        )
        .map(|value| value != 0)
        .map_err(|err| format!("pm audit read: {err}"))
}

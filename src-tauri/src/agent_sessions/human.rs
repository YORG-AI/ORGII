//! User-authored Human sessions backed by an append-only note timeline.

use agent_core::session::persistence::{self as session_persistence, session_type};
use chrono::Utc;
use core_types::key_source::KeySource;
use database::db::get_connection;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

const DEFAULT_TITLE: &str = "Human session";
const HUMAN_SESSION_ID_PREFIX: &str = "humansession-";
const MAX_ENTRY_CHARS: usize = 100_000;
const MAX_TITLE_CHARS: usize = 80;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HumanSessionEntry {
    pub id: String,
    pub body: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HumanSession {
    pub session_id: String,
    pub title: String,
    pub workspace_path: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub entries: Vec<HumanSessionEntry>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HumanSessionCreateRequest {
    pub body: String,
    pub title: Option<String>,
    pub workspace_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HumanSessionAppendRequest {
    pub session_id: String,
    pub body: String,
}

fn clean_optional(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim().to_string();
        (!value.is_empty()).then_some(value)
    })
}

fn validate_body(body: String) -> Result<String, String> {
    let body = body.trim().to_string();
    if body.is_empty() {
        return Err("Human session notes cannot be empty".to_string());
    }
    if body.chars().count() > MAX_ENTRY_CHARS {
        return Err(format!(
            "A Human session note is limited to {MAX_ENTRY_CHARS} characters"
        ));
    }
    Ok(body)
}

fn preview(body: &str, max_chars: usize) -> String {
    body.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max_chars)
        .collect()
}

fn title_from_body(body: &str) -> String {
    let title = preview(body, MAX_TITLE_CHARS);
    if title.is_empty() {
        DEFAULT_TITLE.to_string()
    } else {
        title
    }
}

fn resolve_title(title: Option<String>, body: &str) -> Result<String, String> {
    let Some(title) = clean_optional(title) else {
        return Ok(title_from_body(body));
    };
    if title.chars().count() > MAX_TITLE_CHARS {
        return Err(format!(
            "A Human session title is limited to {MAX_TITLE_CHARS} characters"
        ));
    }
    Ok(title)
}

fn validate_human_session_id(session_id: &str) -> Result<(), String> {
    let uuid = session_id
        .strip_prefix(HUMAN_SESSION_ID_PREFIX)
        .ok_or_else(|| format!("Invalid Human session ID: {session_id}"))?;
    Uuid::parse_str(uuid)
        .map(|_| ())
        .map_err(|_| format!("Invalid Human session ID: {session_id}"))
}

fn ensure_human_session(
    session_id: &str,
) -> Result<session_persistence::UnifiedSessionRecord, String> {
    validate_human_session_id(session_id)?;
    let session = session_persistence::get_session(session_id)
        .map_err(|err| err.to_string())?
        .ok_or_else(|| format!("Human session not found: {session_id}"))?;
    if session.session_type != session_type::HUMAN {
        return Err(format!("Session is not a Human session: {session_id}"));
    }
    Ok(session)
}

fn insert_entry(session_id: &str, body: &str, created_at: &str) -> Result<(), String> {
    let conn = get_connection().map_err(|err| err.to_string())?;
    conn.execute(
        "INSERT INTO human_session_entries (id, session_id, body, created_at)
         VALUES (?1, ?2, ?3, ?4)",
        params![
            format!("humanentry-{}", Uuid::new_v4()),
            session_id,
            body,
            created_at,
        ],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

fn create_sync(request: HumanSessionCreateRequest) -> Result<HumanSession, String> {
    let body = validate_body(request.body)?;
    let title = resolve_title(request.title, &body)?;
    let now = Utc::now().to_rfc3339();
    let session_id = format!("{HUMAN_SESSION_ID_PREFIX}{}", Uuid::new_v4());
    let record = session_persistence::UnifiedSessionRecord {
        session_id: session_id.clone(),
        name: title,
        status: "completed".to_string(),
        user_input: Some(preview(&body, 240)),
        created_at: now.clone(),
        updated_at: now.clone(),
        session_type: session_type::HUMAN.to_string(),
        workspace_path: clean_optional(request.workspace_path),
        key_source: KeySource::OwnKey,
        ..Default::default()
    };
    session_persistence::upsert_session(&record).map_err(|err| err.to_string())?;
    if let Err(err) = insert_entry(&session_id, &body, &now) {
        let _ = session_persistence::delete_session(&session_id);
        return Err(err);
    }
    get_sync(&session_id)
}

fn load_entries(session_id: &str) -> Result<Vec<HumanSessionEntry>, String> {
    let conn = get_connection().map_err(|err| err.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, body, created_at FROM human_session_entries
             WHERE session_id=?1 ORDER BY created_at ASC, rowid ASC",
        )
        .map_err(|err| err.to_string())?;
    let entries = stmt
        .query_map([session_id], |row| {
            Ok(HumanSessionEntry {
                id: row.get(0)?,
                body: row.get(1)?,
                created_at: row.get(2)?,
            })
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;
    Ok(entries)
}

fn get_sync(session_id: &str) -> Result<HumanSession, String> {
    let session = ensure_human_session(session_id)?;
    Ok(HumanSession {
        session_id: session.session_id,
        title: session.name,
        workspace_path: session.workspace_path,
        created_at: session.created_at,
        updated_at: session.updated_at,
        entries: load_entries(session_id)?,
    })
}

fn append_sync(request: HumanSessionAppendRequest) -> Result<HumanSession, String> {
    ensure_human_session(&request.session_id)?;
    let body = validate_body(request.body)?;
    let now = Utc::now().to_rfc3339();
    let mut conn = get_connection().map_err(|err| err.to_string())?;
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    tx.execute(
        "INSERT INTO human_session_entries (id, session_id, body, created_at)
         VALUES (?1, ?2, ?3, ?4)",
        params![
            format!("humanentry-{}", Uuid::new_v4()),
            request.session_id,
            body,
            now,
        ],
    )
    .map_err(|err| err.to_string())?;
    tx.execute(
        "UPDATE agent_sessions SET updated_at=?2 WHERE session_id=?1",
        params![request.session_id, now],
    )
    .map_err(|err| err.to_string())?;
    tx.commit().map_err(|err| err.to_string())?;
    get_sync(&request.session_id)
}

fn delete_sync(session_id: &str) -> Result<(), String> {
    ensure_human_session(session_id)?;
    session_persistence::delete_session(session_id).map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn human_session_create(
    request: HumanSessionCreateRequest,
) -> Result<HumanSession, String> {
    tokio::task::spawn_blocking(move || create_sync(request))
        .await
        .map_err(|err| format!("Human session create worker failed: {err}"))?
}

#[tauri::command]
pub async fn human_session_get(session_id: String) -> Result<HumanSession, String> {
    tokio::task::spawn_blocking(move || get_sync(&session_id))
        .await
        .map_err(|err| format!("Human session load worker failed: {err}"))?
}

#[tauri::command]
pub async fn human_session_append(
    request: HumanSessionAppendRequest,
) -> Result<HumanSession, String> {
    tokio::task::spawn_blocking(move || append_sync(request))
        .await
        .map_err(|err| format!("Human session append worker failed: {err}"))?
}

#[tauri::command]
pub async fn human_session_delete(session_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || delete_sync(&session_id))
        .await
        .map_err(|err| format!("Human session deletion worker failed: {err}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_notes() {
        assert!(validate_body("  \n ".to_string()).is_err());
    }

    #[test]
    fn derives_a_bounded_title_from_the_first_note() {
        let title = title_from_body(&"word ".repeat(100));
        assert_eq!(title.chars().count(), MAX_TITLE_CHARS);
    }

    #[test]
    fn prefers_a_trimmed_explicit_title() {
        assert_eq!(
            resolve_title(Some("  Release evidence  ".to_string()), "Fallback note").unwrap(),
            "Release evidence"
        );
    }

    #[test]
    fn blank_explicit_titles_fall_back_to_the_first_note() {
        assert_eq!(
            resolve_title(Some("  ".to_string()), "Fallback note").unwrap(),
            "Fallback note"
        );
    }

    #[test]
    fn rejects_titles_over_the_limit() {
        assert!(resolve_title(Some("x".repeat(MAX_TITLE_CHARS + 1)), "Fallback note").is_err());
    }

    #[test]
    fn rejects_noncanonical_human_session_ids() {
        assert!(
            validate_human_session_id(&format!("{HUMAN_SESSION_ID_PREFIX}{}", Uuid::new_v4()))
                .is_ok()
        );
        assert!(validate_human_session_id("humansession-../../notes").is_err());
    }
}

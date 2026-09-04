//! SQLite persistence for inbox messages.

use chrono::Utc;
use rusqlite::{params, Connection, Result as SqliteResult};
use serde::{Deserialize, Serialize};

use database::db::get_connection;

// ============================================
// Types
// ============================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxMessage {
    pub id: String,
    pub title: String,
    pub preview: String,
    pub content: String,
    pub category: String,
    pub priority: String,
    pub status: String,
    pub sender_name: Option<String>,
    /// JSON string of metadata object
    pub metadata: String,
    /// JSON string of labels array
    pub labels: String,
    pub created_at: String,
    pub updated_at: String,
}

// ============================================
// CRUD
// ============================================

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

/// Insert or update an inbox message, preserving existing read/unread status.
pub fn upsert_message(msg: &InboxMessage) -> SqliteResult<()> {
    let conn = get_connection()?;
    upsert_message_with_connection(&conn, msg)
}

fn upsert_message_with_connection(conn: &Connection, msg: &InboxMessage) -> SqliteResult<()> {
    conn.execute(
        "INSERT INTO inbox_messages
            (id, title, preview, content, category, priority, status,
             sender_name, metadata, labels, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            preview = excluded.preview,
            content = excluded.content,
            category = excluded.category,
            priority = excluded.priority,
            sender_name = excluded.sender_name,
            metadata = excluded.metadata,
            labels = excluded.labels,
            updated_at = excluded.updated_at",
        params![
            msg.id,
            msg.title,
            msg.preview,
            msg.content,
            msg.category,
            msg.priority,
            msg.status,
            msg.sender_name,
            msg.metadata,
            msg.labels,
            msg.created_at,
            now_iso(),
        ],
    )?;
    Ok(())
}

/// List all inbox messages, newest first. Capped at 200.
pub fn list_messages() -> SqliteResult<Vec<InboxMessage>> {
    let conn = get_connection()?;
    list_messages_with_connection(&conn)
}

fn list_messages_with_connection(conn: &Connection) -> SqliteResult<Vec<InboxMessage>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, preview, content, category, priority, status,
                sender_name, metadata, labels, created_at, updated_at
         FROM inbox_messages
         ORDER BY created_at DESC
         LIMIT 200",
    )?;

    let rows = stmt.query_map([], |row| {
        Ok(InboxMessage {
            id: row.get(0)?,
            title: row.get(1)?,
            preview: row.get(2)?,
            content: row.get(3)?,
            category: row.get(4)?,
            priority: row.get(5)?,
            status: row.get(6)?,
            sender_name: row.get(7)?,
            metadata: row.get(8)?,
            labels: row.get(9)?,
            created_at: row.get(10)?,
            updated_at: row.get(11)?,
        })
    })?;

    rows.collect()
}

/// Update the status of a message (read, archived, etc.).
pub fn update_status(id: &str, status: &str) -> SqliteResult<()> {
    let conn = get_connection()?;
    update_status_with_connection(&conn, id, status)
}

fn update_status_with_connection(conn: &Connection, id: &str, status: &str) -> SqliteResult<()> {
    conn.execute(
        "UPDATE inbox_messages SET status = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, status, now_iso()],
    )?;
    Ok(())
}

/// Delete a message by ID.
pub fn delete_message(id: &str) -> SqliteResult<()> {
    let conn = get_connection()?;
    delete_message_with_connection(&conn, id)
}

fn delete_message_with_connection(conn: &Connection, id: &str) -> SqliteResult<()> {
    conn.execute("DELETE FROM inbox_messages WHERE id = ?1", params![id])?;
    Ok(())
}

/// Delete all messages with a given status (e.g., purge archived).
pub fn delete_by_status(status: &str) -> SqliteResult<usize> {
    let conn = get_connection()?;
    delete_by_status_with_connection(&conn, status)
}

fn delete_by_status_with_connection(conn: &Connection, status: &str) -> SqliteResult<usize> {
    let count = conn.execute(
        "DELETE FROM inbox_messages WHERE status = ?1",
        params![status],
    )?;
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    fn test_connection() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory database");
        crate::init_inbox_tables(&conn).expect("inbox schema");
        conn
    }

    fn message(id: &str, status: &str, created_at: &str) -> InboxMessage {
        InboxMessage {
            id: id.to_string(),
            title: format!("Title {id}"),
            preview: format!("Preview {id}"),
            content: format!("Content {id}"),
            category: "git".to_string(),
            priority: "normal".to_string(),
            status: status.to_string(),
            sender_name: Some("Agent".to_string()),
            metadata: r#"{"source":"test"}"#.to_string(),
            labels: r#"["coverage"]"#.to_string(),
            created_at: created_at.to_string(),
            updated_at: "caller-supplied-updated-at".to_string(),
        }
    }

    #[test]
    fn upsert_inserts_every_field_and_uses_a_fresh_updated_at() {
        let conn = test_connection();
        let expected = message("message-1", "unread", "2026-01-02T03:04:05Z");

        upsert_message_with_connection(&conn, &expected).expect("insert message");
        let messages = list_messages_with_connection(&conn).expect("list messages");

        assert_eq!(messages.len(), 1);
        let actual = &messages[0];
        assert_eq!(actual.id, expected.id);
        assert_eq!(actual.title, expected.title);
        assert_eq!(actual.preview, expected.preview);
        assert_eq!(actual.content, expected.content);
        assert_eq!(actual.category, expected.category);
        assert_eq!(actual.priority, expected.priority);
        assert_eq!(actual.status, expected.status);
        assert_eq!(actual.sender_name, expected.sender_name);
        assert_eq!(actual.metadata, expected.metadata);
        assert_eq!(actual.labels, expected.labels);
        assert_eq!(actual.created_at, expected.created_at);
        assert_ne!(actual.updated_at, expected.updated_at);
        chrono::DateTime::parse_from_rfc3339(&actual.updated_at).expect("RFC 3339 updated_at");
    }

    #[test]
    fn upsert_updates_content_but_preserves_status_and_created_at() {
        let conn = test_connection();
        let original_created_at = "2025-02-03T04:05:06Z";
        let original = message("message-1", "read", original_created_at);
        upsert_message_with_connection(&conn, &original).expect("insert original");

        let mut replacement = message("message-1", "unread", "2030-01-01T00:00:00Z");
        replacement.title = "Replacement title".to_string();
        replacement.preview = "Replacement preview".to_string();
        replacement.content = "Replacement content".to_string();
        replacement.category = "work-item".to_string();
        replacement.priority = "high".to_string();
        replacement.sender_name = None;
        replacement.metadata = r#"{"replacement":true}"#.to_string();
        replacement.labels = r#"["updated"]"#.to_string();

        upsert_message_with_connection(&conn, &replacement).expect("upsert replacement");
        let actual = list_messages_with_connection(&conn)
            .expect("list messages")
            .pop()
            .expect("stored message");

        assert_eq!(actual.title, replacement.title);
        assert_eq!(actual.preview, replacement.preview);
        assert_eq!(actual.content, replacement.content);
        assert_eq!(actual.category, replacement.category);
        assert_eq!(actual.priority, replacement.priority);
        assert_eq!(actual.sender_name, None);
        assert_eq!(actual.metadata, replacement.metadata);
        assert_eq!(actual.labels, replacement.labels);
        assert_eq!(actual.status, "read");
        assert_eq!(actual.created_at, original_created_at);
    }

    #[test]
    fn list_messages_returns_newest_first_and_caps_results_at_two_hundred() {
        let conn = test_connection();
        let base =
            chrono::DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z").expect("base timestamp");

        for index in 0..205 {
            let created_at = (base + Duration::seconds(index)).to_rfc3339();
            upsert_message_with_connection(
                &conn,
                &message(&format!("message-{index:03}"), "unread", &created_at),
            )
            .expect("insert message");
        }

        let messages = list_messages_with_connection(&conn).expect("list messages");

        assert_eq!(messages.len(), 200);
        assert_eq!(messages.first().expect("newest").id, "message-204");
        assert_eq!(messages.last().expect("oldest retained").id, "message-005");
        assert!(messages
            .windows(2)
            .all(|pair| pair[0].created_at >= pair[1].created_at));
    }

    #[test]
    fn status_and_delete_operations_only_affect_matching_messages() {
        let conn = test_connection();
        upsert_message_with_connection(&conn, &message("keep", "unread", "2026-01-03T00:00:00Z"))
            .expect("insert keep");
        upsert_message_with_connection(
            &conn,
            &message("archive-1", "archived", "2026-01-02T00:00:00Z"),
        )
        .expect("insert archive 1");
        upsert_message_with_connection(
            &conn,
            &message("archive-2", "unread", "2026-01-01T00:00:00Z"),
        )
        .expect("insert archive 2");

        update_status_with_connection(&conn, "archive-2", "archived").expect("update status");
        update_status_with_connection(&conn, "missing", "read").expect("missing update is a no-op");
        delete_message_with_connection(&conn, "keep").expect("delete keep");
        delete_message_with_connection(&conn, "missing").expect("missing delete is a no-op");

        assert_eq!(
            delete_by_status_with_connection(&conn, "archived").expect("purge archived"),
            2
        );
        assert_eq!(
            delete_by_status_with_connection(&conn, "archived").expect("purge again"),
            0
        );
        assert!(list_messages_with_connection(&conn)
            .expect("list messages")
            .is_empty());
    }
}

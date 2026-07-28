//! `agent_inbox` table DDL, column back-fills, and receipt self-heal.

use rusqlite::{Connection, Result as SqliteResult};

use crate::coordination::agent_org_payload_limits as limits;

/// Initialize the `agent_inbox` table.
///
/// Hot-path indexes:
/// - `(recipient_member_id, read_at, created_at)` — materialized org member drain query.
/// - `(recipient_agent_id, read_at, created_at)` — coordinator / legacy drain query.
/// - `(org_run_id, created_at)` — bounded debug / E2E history pages.
/// - `(request_id)` — RPC correlation lookups.
pub fn init_schema(conn: &Connection) -> SqliteResult<()> {
    create_agent_inbox_table(conn)?;
    ensure_agent_inbox_column(conn, "causation_inbox_id", "INTEGER")?;
    ensure_agent_inbox_column(conn, "display_text", "TEXT")?;
    let schema = format!(
        "CREATE TABLE IF NOT EXISTS agent_inbox_materializations (
            inbox_id INTEGER PRIMARY KEY,
            session_id TEXT NOT NULL,
            transcript_message_id TEXT NOT NULL,
            transcript_intent_id TEXT NOT NULL,
            materialized_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS agent_inbox_delivery_resolutions (
            inbox_id INTEGER PRIMARY KEY,
            org_run_id TEXT NOT NULL,
            resolution_kind TEXT NOT NULL
                CHECK(resolution_kind IN ('cancelled', 'superseded')),
            resolved_by_member_id TEXT NOT NULL,
            reason TEXT NOT NULL,
            replacement_inbox_id INTEGER,
            replacement_task_id TEXT,
            created_at TEXT NOT NULL,
            CHECK(
                (resolution_kind='cancelled'
                    AND replacement_inbox_id IS NULL
                    AND replacement_task_id IS NULL)
                OR
                (resolution_kind='superseded'
                    AND ((replacement_inbox_id IS NOT NULL)
                         <> (replacement_task_id IS NOT NULL)))
            )
        );
        CREATE INDEX IF NOT EXISTS idx_agent_inbox_delivery_resolutions_run
            ON agent_inbox_delivery_resolutions(org_run_id, inbox_id);
        CREATE INDEX IF NOT EXISTS idx_agent_inbox_materializations_session
            ON agent_inbox_materializations(session_id, inbox_id);
        CREATE INDEX IF NOT EXISTS idx_agent_inbox_recipient_member_unread
            ON agent_inbox(recipient_member_id, read_at, created_at);
        CREATE INDEX IF NOT EXISTS idx_agent_inbox_recipient_unread
            ON agent_inbox(recipient_agent_id, read_at, created_at);
        CREATE INDEX IF NOT EXISTS idx_agent_inbox_org_run
            ON agent_inbox(org_run_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_agent_inbox_org_run_id
            ON agent_inbox(org_run_id, id);
        CREATE INDEX IF NOT EXISTS idx_agent_inbox_run_unread_recipient
            ON agent_inbox(org_run_id, recipient_member_id, recipient_agent_id, id)
            WHERE read_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_agent_inbox_run_kind_id
            ON agent_inbox(org_run_id, payload_kind, id);
        CREATE INDEX IF NOT EXISTS idx_agent_inbox_run_task_assignment_v4
            ON agent_inbox(
                org_run_id,
                recipient_member_id,
                json_extract(
                    CASE WHEN length(CAST(payload_json AS BLOB))<={payload_max}
                                   AND json_valid(payload_json)
                         THEN payload_json ELSE '{{}}' END,
                    '$.task_id'
                )
            )
            WHERE payload_kind='task_assigned'
              AND CASE WHEN length(CAST(payload_json AS BLOB))<={payload_max}
                       THEN json_valid(payload_json) ELSE 0 END
              AND json_type(
                    CASE WHEN length(CAST(payload_json AS BLOB))<={payload_max}
                                   AND json_valid(payload_json)
                         THEN payload_json ELSE '{{}}' END,
                    '$.task_id'
                  )='text';
        DROP INDEX IF EXISTS idx_agent_inbox_run_task_assignment_v3;
        DROP INDEX IF EXISTS idx_agent_inbox_run_task_assignment_v2;
        CREATE INDEX IF NOT EXISTS idx_agent_inbox_request_id
            ON agent_inbox(request_id);
        DROP INDEX IF EXISTS idx_agent_inbox_causation_once;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_inbox_causation_recipient_once
            ON agent_inbox(
                causation_inbox_id,
                payload_kind,
                recipient_agent_id,
                COALESCE(recipient_member_id, '')
            )
            WHERE causation_inbox_id IS NOT NULL;",
        payload_max = limits::AGENT_INBOX_PAYLOAD_MAX_BYTES,
    );
    conn.execute_batch(&schema)?;
    // Self-heal only provably dangling receipts. Source Inbox rows remain
    // unread, allowing a healthy replacement Session to materialize them.
    let transcript_tables_exist: bool = conn.query_row(
        "SELECT COUNT(*)=2 FROM sqlite_master
         WHERE type='table' AND name IN ('agent_messages', 'agent_sessions')",
        [],
        |row| row.get(0),
    )?;
    if transcript_tables_exist {
        conn.execute(
            "DELETE FROM agent_inbox_materializations AS receipt
             WHERE NOT EXISTS (
                       SELECT 1 FROM agent_inbox inbox
                       WHERE inbox.id=receipt.inbox_id
                         AND inbox.read_at IS NULL
                         AND NOT EXISTS (
                             SELECT 1 FROM agent_inbox_delivery_resolutions resolution
                             WHERE resolution.inbox_id=inbox.id
                         )
                   )
                OR NOT EXISTS (
                       SELECT 1 FROM agent_messages message
                       WHERE message.id=receipt.transcript_message_id
                         AND message.session_id=receipt.session_id
                   )
                OR NOT EXISTS (
                       SELECT 1 FROM agent_sessions session
                       WHERE session.session_id=receipt.session_id
                   )",
            [],
        )?;
    }
    Ok(())
}

fn ensure_agent_inbox_column(
    conn: &Connection,
    column_name: &str,
    column_definition: &str,
) -> SqliteResult<()> {
    let mut stmt = conn.prepare("PRAGMA table_info(agent_inbox)")?;
    let columns = stmt.query_map([], |row| row.get::<_, String>(1))?;
    for column in columns {
        if column? == column_name {
            return Ok(());
        }
    }
    conn.execute(
        &format!("ALTER TABLE agent_inbox ADD COLUMN {column_name} {column_definition}"),
        [],
    )?;
    Ok(())
}

fn create_agent_inbox_table(conn: &Connection) -> SqliteResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_inbox (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            recipient_agent_id TEXT NOT NULL,
            recipient_member_id TEXT,
            sender_agent_id TEXT NOT NULL,
            sender_member_id TEXT,
            org_run_id TEXT,
            payload_kind TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            request_id TEXT,
            created_at TEXT NOT NULL,
            read_at TEXT,
            causation_inbox_id INTEGER,
            display_text TEXT
        );",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn init_schema_adds_group_chat_display_text_to_legacy_inbox() {
        let conn = rusqlite::Connection::open_in_memory().expect("open in-memory database");
        conn.execute_batch(
            "CREATE TABLE agent_inbox (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                recipient_agent_id TEXT NOT NULL,
                recipient_member_id TEXT,
                sender_agent_id TEXT NOT NULL,
                sender_member_id TEXT,
                org_run_id TEXT,
                payload_kind TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                request_id TEXT,
                created_at TEXT NOT NULL,
                read_at TEXT
            );",
        )
        .expect("create legacy inbox table");

        init_schema(&conn).expect("upgrade legacy inbox schema");

        let mut stmt = conn
            .prepare("PRAGMA table_info(agent_inbox)")
            .expect("inspect inbox schema");
        let columns = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .expect("query inbox columns")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("collect inbox columns");
        assert!(columns.iter().any(|column| column == "causation_inbox_id"));
        assert!(columns.iter().any(|column| column == "display_text"));
    }
}

use rusqlite::{Connection, Result as SqliteResult};

/// Canonical read receipts for Team Inbox projections.
///
/// A receipt belongs to an explicit viewer identity and a stable source item.
/// Source rows remain authoritative; deleting a Work Item cascades neither
/// business state nor unrelated viewers' receipts.
pub fn init_team_inbox_tables(conn: &Connection) -> SqliteResult<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS team_inbox_read_receipts (
            viewer_member_id TEXT NOT NULL,
            source_kind      TEXT NOT NULL,
            source_id        TEXT NOT NULL,
            read_at          INTEGER NOT NULL,
            PRIMARY KEY (viewer_member_id, source_kind, source_id)
        );
        CREATE INDEX IF NOT EXISTS idx_team_inbox_receipts_source
            ON team_inbox_read_receipts(source_kind, source_id);
        "#,
    )?;
    Ok(())
}

use rusqlite::{params, Connection, OptionalExtension};

use super::RecordStore;
use crate::canonical::{
    ActivityRecord, CommitLinkRecord, FileChangeRecord, ScanCheckpoint,
    SessionCheckpointFileStateRecord, SessionCheckpointRecord, SessionDiffChunkRecord,
    SessionEditArtifactRecord, SessionFinalDiffRecord, SessionRecord,
};

pub struct SqliteRecordStore<'conn> {
    conn: &'conn Connection,
}

fn ensure_column(
    conn: &Connection,
    table_name: &str,
    column_name: &str,
    column_definition: &str,
) -> rusqlite::Result<()> {
    let mut statement = conn.prepare(&format!("PRAGMA table_info({table_name})"))?;
    let rows = statement.query_map([], |row| row.get::<_, String>(1))?;
    for row in rows {
        if row? == column_name {
            return Ok(());
        }
    }
    conn.execute(
        &format!("ALTER TABLE {table_name} ADD COLUMN {column_name} {column_definition}"),
        [],
    )?;
    Ok(())
}

impl<'conn> SqliteRecordStore<'conn> {
    pub fn new(conn: &'conn Connection) -> Self {
        Self { conn }
    }

    pub fn init_tables(conn: &Connection) -> rusqlite::Result<()> {
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS orgtrack_core_sessions (
                session_id          TEXT PRIMARY KEY,
                source              TEXT NOT NULL,
                source_session_id   TEXT NOT NULL,
                workspace_path      TEXT,
                title               TEXT NOT NULL,
                created_at          TEXT,
                updated_at          TEXT,
                completed_at        TEXT,
                branch              TEXT,
                project_id          TEXT,
                workspace_id        TEXT,
                work_item_id        TEXT,
                agent_identity      TEXT,
                agent_band          TEXT,
                topic_tags_json     TEXT NOT NULL DEFAULT '[]',
                payload_json        TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_orgtrack_core_sessions_source
                ON orgtrack_core_sessions(source, source_session_id);
            CREATE INDEX IF NOT EXISTS idx_orgtrack_core_sessions_workspace
                ON orgtrack_core_sessions(workspace_path);

            CREATE TABLE IF NOT EXISTS orgtrack_core_activities (
                record_id       TEXT PRIMARY KEY,
                source          TEXT NOT NULL,
                session_id      TEXT,
                timestamp       TEXT NOT NULL,
                workspace_path  TEXT,
                file_path       TEXT,
                kind            TEXT NOT NULL,
                payload_json    TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_orgtrack_core_activities_session
                ON orgtrack_core_activities(session_id, timestamp);
            CREATE INDEX IF NOT EXISTS idx_orgtrack_core_activities_workspace
                ON orgtrack_core_activities(workspace_path, timestamp);

            CREATE TABLE IF NOT EXISTS orgtrack_core_file_changes (
                record_id       TEXT PRIMARY KEY,
                source          TEXT NOT NULL,
                session_id      TEXT NOT NULL,
                workspace_path  TEXT,
                file_path       TEXT NOT NULL,
                path_hash       TEXT NOT NULL,
                timestamp       INTEGER NOT NULL,
                payload_json    TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_orgtrack_core_file_changes_session
                ON orgtrack_core_file_changes(session_id, timestamp);
            CREATE INDEX IF NOT EXISTS idx_orgtrack_core_file_changes_workspace
                ON orgtrack_core_file_changes(workspace_path, timestamp);
            CREATE INDEX IF NOT EXISTS idx_orgtrack_core_file_changes_path
                ON orgtrack_core_file_changes(file_path, timestamp);

            CREATE TABLE IF NOT EXISTS orgtrack_core_commit_links (
                record_id       TEXT PRIMARY KEY,
                commit_sha      TEXT NOT NULL,
                linked_at       TEXT NOT NULL,
                payload_json    TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_orgtrack_core_commit_links_sha
                ON orgtrack_core_commit_links(commit_sha);

            CREATE TABLE IF NOT EXISTS orgtrack_core_checkpoints (
                source          TEXT PRIMARY KEY,
                parser_version  INTEGER NOT NULL,
                updated_at      TEXT,
                payload_json    TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS orgtrack_core_edit_artifacts (
                record_id       TEXT PRIMARY KEY,
                source          TEXT NOT NULL,
                session_id      TEXT NOT NULL,
                source_event_id TEXT,
                execution_turn_id TEXT,
                sequence_index  INTEGER NOT NULL,
                workspace_path  TEXT,
                file_path       TEXT NOT NULL,
                path_hash       TEXT NOT NULL,
                quality         TEXT NOT NULL,
                payload_json    TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_orgtrack_core_edit_artifacts_session
                ON orgtrack_core_edit_artifacts(source, session_id, sequence_index);
            CREATE INDEX IF NOT EXISTS idx_orgtrack_core_edit_artifacts_workspace
                ON orgtrack_core_edit_artifacts(workspace_path, sequence_index);
            CREATE INDEX IF NOT EXISTS idx_orgtrack_core_edit_artifacts_path
                ON orgtrack_core_edit_artifacts(file_path, sequence_index);

            CREATE TABLE IF NOT EXISTS orgtrack_core_diff_chunks (
                record_id       TEXT PRIMARY KEY,
                edit_record_id  TEXT NOT NULL,
                source          TEXT NOT NULL,
                session_id      TEXT NOT NULL,
                source_event_id TEXT,
                sequence_index  INTEGER NOT NULL,
                chunk_index     INTEGER NOT NULL,
                file_path       TEXT NOT NULL,
                quality         TEXT NOT NULL,
                payload_json    TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_orgtrack_core_diff_chunks_session
                ON orgtrack_core_diff_chunks(source, session_id, sequence_index, chunk_index);
            CREATE INDEX IF NOT EXISTS idx_orgtrack_core_diff_chunks_edit
                ON orgtrack_core_diff_chunks(edit_record_id);

            CREATE TABLE IF NOT EXISTS orgtrack_core_final_diffs (
                record_id       TEXT PRIMARY KEY,
                source          TEXT NOT NULL,
                session_id      TEXT NOT NULL,
                file_path       TEXT NOT NULL,
                quality         TEXT NOT NULL,
                computed_at     TEXT NOT NULL,
                payload_json    TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_orgtrack_core_final_diffs_session
                ON orgtrack_core_final_diffs(source, session_id, file_path);

            CREATE TABLE IF NOT EXISTS orgtrack_core_session_checkpoints (
                checkpoint_id   TEXT PRIMARY KEY,
                source          TEXT NOT NULL,
                session_id      TEXT NOT NULL,
                sequence_index  INTEGER NOT NULL,
                source_event_id TEXT,
                checkpoint_kind TEXT NOT NULL,
                quality         TEXT NOT NULL,
                undo_supported  INTEGER NOT NULL,
                payload_json    TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_orgtrack_core_session_checkpoints_session
                ON orgtrack_core_session_checkpoints(source, session_id, sequence_index);

            CREATE TABLE IF NOT EXISTS orgtrack_core_checkpoint_file_states (
                record_id       TEXT PRIMARY KEY,
                checkpoint_id   TEXT NOT NULL,
                session_id      TEXT NOT NULL,
                file_path       TEXT NOT NULL,
                quality         TEXT NOT NULL,
                payload_json    TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_orgtrack_core_checkpoint_file_states_checkpoint
                ON orgtrack_core_checkpoint_file_states(checkpoint_id, file_path);
            ",
        )?;
        // Schema-only upgrade: historical metadata stays NULL/empty.
        for (table, column, definition) in [
            ("orgtrack_core_sessions", "project_id", "TEXT"),
            ("orgtrack_core_sessions", "workspace_id", "TEXT"),
            ("orgtrack_core_sessions", "work_item_id", "TEXT"),
            ("orgtrack_core_sessions", "agent_identity", "TEXT"),
            ("orgtrack_core_sessions", "agent_band", "TEXT"),
            (
                "orgtrack_core_sessions",
                "topic_tags_json",
                "TEXT NOT NULL DEFAULT '[]'",
            ),
            ("orgtrack_core_edit_artifacts", "execution_turn_id", "TEXT"),
        ] {
            ensure_column(conn, table, column, definition)?;
        }
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_orgtrack_core_sessions_project
                ON orgtrack_core_sessions(project_id);
             CREATE INDEX IF NOT EXISTS idx_orgtrack_core_edit_artifacts_execution_turn
                ON orgtrack_core_edit_artifacts(session_id, execution_turn_id);",
        )?;
        Ok(())
    }

    pub fn init_source_cache_tables(conn: &Connection) -> rusqlite::Result<()> {
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS cursor_ide_turn_summaries (
                session_id          TEXT NOT NULL,
                composer_id         TEXT NOT NULL,
                turn_id             TEXT NOT NULL,
                next_turn_id        TEXT,
                turn_index          INTEGER NOT NULL,
                started_at          TEXT NOT NULL,
                ended_at            TEXT,
                duration_ms         INTEGER,
                user_preview        TEXT NOT NULL DEFAULT '',
                event_count         INTEGER NOT NULL DEFAULT 0,
                body_event_count    INTEGER NOT NULL DEFAULT 0,
                source_updated_at   INTEGER NOT NULL DEFAULT 0,
                source_bubble_count INTEGER NOT NULL DEFAULT 0,
                source_fingerprint  TEXT NOT NULL DEFAULT '',
                updated_at          TEXT NOT NULL,
                PRIMARY KEY (session_id, turn_id)
            );
            CREATE INDEX IF NOT EXISTS idx_cursor_ide_turns_session_index
                ON cursor_ide_turn_summaries(session_id, turn_index);

            CREATE TABLE IF NOT EXISTS claude_session_cache (
                id              TEXT PRIMARY KEY,
                name            TEXT NOT NULL DEFAULT '',
                created_at      INTEGER NOT NULL DEFAULT 0,
                last_active_at  INTEGER NOT NULL DEFAULT 0,
                message_count   INTEGER NOT NULL DEFAULT 0,
                model           TEXT NOT NULL DEFAULT '',
                workspace_path  TEXT NOT NULL DEFAULT '',
                git_branch      TEXT NOT NULL DEFAULT '',
                input_tokens    INTEGER NOT NULL DEFAULT 0,
                output_tokens   INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_claude_cache_created
                ON claude_session_cache(created_at);

            CREATE TABLE IF NOT EXISTS cli_session_cache (
                id              TEXT PRIMARY KEY,
                tool            TEXT NOT NULL DEFAULT '',
                name            TEXT NOT NULL DEFAULT '',
                created_at      INTEGER NOT NULL DEFAULT 0,
                last_active_at  INTEGER NOT NULL DEFAULT 0,
                message_count   INTEGER NOT NULL DEFAULT 0,
                model           TEXT NOT NULL DEFAULT '',
                workspace_path  TEXT NOT NULL DEFAULT '',
                input_tokens    INTEGER NOT NULL DEFAULT 0,
                output_tokens   INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_cli_cache_created
                ON cli_session_cache(created_at);
            CREATE INDEX IF NOT EXISTS idx_cli_cache_tool
                ON cli_session_cache(tool);

            CREATE TABLE IF NOT EXISTS imported_history_session_cache (
                source              TEXT NOT NULL,
                source_session_id   TEXT NOT NULL,
                session_id          TEXT NOT NULL,
                source_path         TEXT NOT NULL DEFAULT '',
                source_record_key   TEXT NOT NULL DEFAULT '',
                source_mtime_ms     INTEGER NOT NULL DEFAULT 0,
                source_size_bytes   INTEGER NOT NULL DEFAULT 0,
                source_fingerprint  TEXT NOT NULL DEFAULT '',
                parser_version      INTEGER NOT NULL DEFAULT 0,
                name                TEXT NOT NULL DEFAULT '',
                created_at_ms       INTEGER NOT NULL DEFAULT 0,
                updated_at_ms       INTEGER NOT NULL DEFAULT 0,
                model               TEXT NOT NULL DEFAULT '',
                input_tokens        INTEGER NOT NULL DEFAULT 0,
                output_tokens       INTEGER NOT NULL DEFAULT 0,
                repo_path           TEXT NOT NULL DEFAULT '',
                branch              TEXT NOT NULL DEFAULT '',
                files_changed       INTEGER NOT NULL DEFAULT 0,
                lines_added         INTEGER NOT NULL DEFAULT 0,
                lines_removed       INTEGER NOT NULL DEFAULT 0,
                touched_files_json  TEXT NOT NULL DEFAULT '[]',
                listable            INTEGER NOT NULL DEFAULT 1,
                source_metadata_json TEXT NOT NULL DEFAULT '',
                parent_session_id   TEXT NOT NULL DEFAULT '',
                updated_at          TEXT NOT NULL DEFAULT '',
                PRIMARY KEY (source, source_session_id)
            );
            CREATE INDEX IF NOT EXISTS idx_imported_history_source_updated
                ON imported_history_session_cache(source, updated_at_ms DESC);
            CREATE INDEX IF NOT EXISTS idx_imported_history_source_repo
                ON imported_history_session_cache(source, repo_path);
            CREATE INDEX IF NOT EXISTS idx_imported_history_source_path
                ON imported_history_session_cache(source, source_path);
            ",
        )?;
        ensure_column(
            conn,
            "imported_history_session_cache",
            "files_changed",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        ensure_column(
            conn,
            "imported_history_session_cache",
            "lines_added",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        ensure_column(
            conn,
            "imported_history_session_cache",
            "lines_removed",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        ensure_column(
            conn,
            "imported_history_session_cache",
            "touched_files_json",
            "TEXT NOT NULL DEFAULT '[]'",
        )?;
        ensure_column(
            conn,
            "imported_history_session_cache",
            "source_metadata_json",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column(
            conn,
            "imported_history_session_cache",
            "parent_session_id",
            "TEXT NOT NULL DEFAULT ''",
        )
    }

    fn to_json<T: serde::Serialize>(value: &T) -> Result<String, String> {
        serde_json::to_string(value).map_err(|err| err.to_string())
    }

    fn from_json<T: serde::de::DeserializeOwned>(value: String) -> Result<T, String> {
        serde_json::from_str(&value).map_err(|err| err.to_string())
    }

    fn list_by_scope<T: serde::de::DeserializeOwned>(
        &self,
        table_name: &str,
        source: Option<&str>,
        session_id: Option<&str>,
        order_by: &str,
    ) -> Result<Vec<T>, String> {
        let mut records = Vec::new();
        let query = match (source, session_id) {
            (Some(_), Some(_)) => format!(
                "SELECT payload_json FROM {table_name} WHERE source = ?1 AND session_id = ?2 ORDER BY {order_by}"
            ),
            (Some(_), None) => format!(
                "SELECT payload_json FROM {table_name} WHERE source = ?1 ORDER BY {order_by}"
            ),
            (None, Some(_)) => format!(
                "SELECT payload_json FROM {table_name} WHERE session_id = ?1 ORDER BY {order_by}"
            ),
            (None, None) => format!("SELECT payload_json FROM {table_name} ORDER BY {order_by}"),
        };
        let mut stmt = self.conn.prepare(&query).map_err(|err| err.to_string())?;
        match (source, session_id) {
            (Some(source), Some(session_id)) => {
                let rows = stmt
                    .query_map(params![source, session_id], |row| row.get::<_, String>(0))
                    .map_err(|err| err.to_string())?;
                for row in rows {
                    records.push(Self::from_json(row.map_err(|err| err.to_string())?)?);
                }
            }
            (Some(source), None) => {
                let rows = stmt
                    .query_map(params![source], |row| row.get::<_, String>(0))
                    .map_err(|err| err.to_string())?;
                for row in rows {
                    records.push(Self::from_json(row.map_err(|err| err.to_string())?)?);
                }
            }
            (None, Some(session_id)) => {
                let rows = stmt
                    .query_map(params![session_id], |row| row.get::<_, String>(0))
                    .map_err(|err| err.to_string())?;
                for row in rows {
                    records.push(Self::from_json(row.map_err(|err| err.to_string())?)?);
                }
            }
            (None, None) => {
                let rows = stmt
                    .query_map([], |row| row.get::<_, String>(0))
                    .map_err(|err| err.to_string())?;
                for row in rows {
                    records.push(Self::from_json(row.map_err(|err| err.to_string())?)?);
                }
            }
        }
        Ok(records)
    }
}

impl RecordStore for SqliteRecordStore<'_> {
    fn upsert_session(&self, record: &SessionRecord) -> Result<(), String> {
        let payload = Self::to_json(record)?;
        self.conn
            .execute(
                "INSERT INTO orgtrack_core_sessions (
                    session_id, source, source_session_id, workspace_path, title,
                    created_at, updated_at, completed_at, branch, project_id, workspace_id,
                    work_item_id, agent_identity, agent_band, topic_tags_json, payload_json
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
                ON CONFLICT(session_id) DO UPDATE SET
                    source=excluded.source,
                    source_session_id=excluded.source_session_id,
                    workspace_path=excluded.workspace_path,
                    title=excluded.title,
                    created_at=excluded.created_at,
                    updated_at=excluded.updated_at,
                    completed_at=excluded.completed_at,
                    branch=excluded.branch,
                    project_id=excluded.project_id,
                    workspace_id=excluded.workspace_id,
                    work_item_id=excluded.work_item_id,
                    agent_identity=excluded.agent_identity,
                    agent_band=excluded.agent_band,
                    topic_tags_json=excluded.topic_tags_json,
                    payload_json=excluded.payload_json",
                params![
                    record.session_id,
                    record.source,
                    record.source_session_id,
                    record.workspace_path,
                    record.title,
                    record.created_at,
                    record.updated_at,
                    record.completed_at,
                    record.branch,
                    record.journey.project_id,
                    record.journey.workspace_id,
                    record.journey.work_item_id,
                    record.journey.agent_identity,
                    record.journey.agent_band,
                    Self::to_json(&record.journey.topic_tags)?,
                    payload
                ],
            )
            .map_err(|err| err.to_string())?;
        Ok(())
    }

    fn append_activity(&self, record: &ActivityRecord) -> Result<(), String> {
        let payload = Self::to_json(record)?;
        self.conn
            .execute(
                "INSERT OR IGNORE INTO orgtrack_core_activities (
                    record_id, source, session_id, timestamp, workspace_path, file_path, kind, payload_json
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    record.record_id,
                    record.source,
                    record.session_id,
                    record.timestamp,
                    record.workspace_path,
                    record.file_path,
                    format!("{:?}", record.kind),
                    payload
                ],
            )
            .map_err(|err| err.to_string())?;
        Ok(())
    }

    fn upsert_file_change(&self, record: &FileChangeRecord) -> Result<(), String> {
        let payload = Self::to_json(record)?;
        self.conn
            .execute(
                "INSERT INTO orgtrack_core_file_changes (
                    record_id, source, session_id, workspace_path, file_path, path_hash, timestamp, payload_json
                ) VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, ?7)
                ON CONFLICT(record_id) DO UPDATE SET
                    source=excluded.source,
                    session_id=excluded.session_id,
                    file_path=excluded.file_path,
                    path_hash=excluded.path_hash,
                    timestamp=excluded.timestamp,
                    payload_json=excluded.payload_json",
                params![
                    record.record_id,
                    record.source,
                    record.session_id,
                    record.file_path,
                    record.path_hash,
                    record.timestamp,
                    payload
                ],
            )
            .map_err(|err| err.to_string())?;
        Ok(())
    }

    fn upsert_commit_link(&self, record: &CommitLinkRecord) -> Result<(), String> {
        let payload = Self::to_json(record)?;
        self.conn
            .execute(
                "INSERT INTO orgtrack_core_commit_links (record_id, commit_sha, linked_at, payload_json)
                VALUES (?1, ?2, ?3, ?4)
                ON CONFLICT(record_id) DO UPDATE SET
                    commit_sha=excluded.commit_sha,
                    linked_at=excluded.linked_at,
                    payload_json=excluded.payload_json",
                params![record.record_id, record.commit_sha, record.linked_at, payload],
            )
            .map_err(|err| err.to_string())?;
        Ok(())
    }

    fn upsert_edit_artifact(&self, record: &SessionEditArtifactRecord) -> Result<(), String> {
        let payload = Self::to_json(record)?;
        self.conn
            .execute(
                "INSERT INTO orgtrack_core_edit_artifacts (
                    record_id, source, session_id, source_event_id, execution_turn_id, sequence_index,
                    workspace_path, file_path, path_hash, quality, payload_json
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                ON CONFLICT(record_id) DO UPDATE SET
                    source=excluded.source,
                    session_id=excluded.session_id,
                    source_event_id=excluded.source_event_id,
                    execution_turn_id=excluded.execution_turn_id,
                    sequence_index=excluded.sequence_index,
                    workspace_path=excluded.workspace_path,
                    file_path=excluded.file_path,
                    path_hash=excluded.path_hash,
                    quality=excluded.quality,
                    payload_json=excluded.payload_json",
                params![
                    record.record_id,
                    record.source,
                    record.session_id,
                    record.source_event_id,
                    record.execution_turn_id,
                    record.sequence_index,
                    record.workspace_path,
                    record.file_path,
                    record.path_hash,
                    format!("{:?}", record.quality),
                    payload
                ],
            )
            .map_err(|err| err.to_string())?;
        Ok(())
    }

    fn upsert_diff_chunk(&self, record: &SessionDiffChunkRecord) -> Result<(), String> {
        let payload = Self::to_json(record)?;
        self.conn
            .execute(
                "INSERT INTO orgtrack_core_diff_chunks (
                    record_id, edit_record_id, source, session_id, source_event_id,
                    sequence_index, chunk_index, file_path, quality, payload_json
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                ON CONFLICT(record_id) DO UPDATE SET
                    edit_record_id=excluded.edit_record_id,
                    source=excluded.source,
                    session_id=excluded.session_id,
                    source_event_id=excluded.source_event_id,
                    sequence_index=excluded.sequence_index,
                    chunk_index=excluded.chunk_index,
                    file_path=excluded.file_path,
                    quality=excluded.quality,
                    payload_json=excluded.payload_json",
                params![
                    record.record_id,
                    record.edit_record_id,
                    record.source,
                    record.session_id,
                    record.source_event_id,
                    record.sequence_index,
                    record.chunk_index,
                    record.file_path,
                    format!("{:?}", record.quality),
                    payload
                ],
            )
            .map_err(|err| err.to_string())?;
        Ok(())
    }

    fn upsert_final_diff(&self, record: &SessionFinalDiffRecord) -> Result<(), String> {
        let payload = Self::to_json(record)?;
        self.conn
            .execute(
                "INSERT INTO orgtrack_core_final_diffs (
                    record_id, source, session_id, file_path, quality, computed_at, payload_json
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                ON CONFLICT(record_id) DO UPDATE SET
                    source=excluded.source,
                    session_id=excluded.session_id,
                    file_path=excluded.file_path,
                    quality=excluded.quality,
                    computed_at=excluded.computed_at,
                    payload_json=excluded.payload_json",
                params![
                    record.record_id,
                    record.source,
                    record.session_id,
                    record.file_path,
                    format!("{:?}", record.quality),
                    record.computed_at,
                    payload
                ],
            )
            .map_err(|err| err.to_string())?;
        Ok(())
    }

    fn upsert_session_checkpoint(&self, record: &SessionCheckpointRecord) -> Result<(), String> {
        let payload = Self::to_json(record)?;
        self.conn
            .execute(
                "INSERT INTO orgtrack_core_session_checkpoints (
                    checkpoint_id, source, session_id, sequence_index, source_event_id,
                    checkpoint_kind, quality, undo_supported, payload_json
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                ON CONFLICT(checkpoint_id) DO UPDATE SET
                    source=excluded.source,
                    session_id=excluded.session_id,
                    sequence_index=excluded.sequence_index,
                    source_event_id=excluded.source_event_id,
                    checkpoint_kind=excluded.checkpoint_kind,
                    quality=excluded.quality,
                    undo_supported=excluded.undo_supported,
                    payload_json=excluded.payload_json",
                params![
                    record.checkpoint_id,
                    record.source,
                    record.session_id,
                    record.sequence_index,
                    record.source_event_id,
                    format!("{:?}", record.checkpoint_kind),
                    format!("{:?}", record.quality),
                    record.undo_supported,
                    payload
                ],
            )
            .map_err(|err| err.to_string())?;
        Ok(())
    }

    fn upsert_checkpoint_file_state(
        &self,
        record: &SessionCheckpointFileStateRecord,
    ) -> Result<(), String> {
        let payload = Self::to_json(record)?;
        self.conn
            .execute(
                "INSERT INTO orgtrack_core_checkpoint_file_states (
                    record_id, checkpoint_id, session_id, file_path, quality, payload_json
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                ON CONFLICT(record_id) DO UPDATE SET
                    checkpoint_id=excluded.checkpoint_id,
                    session_id=excluded.session_id,
                    file_path=excluded.file_path,
                    quality=excluded.quality,
                    payload_json=excluded.payload_json",
                params![
                    record.record_id,
                    record.checkpoint_id,
                    record.session_id,
                    record.file_path,
                    format!("{:?}", record.quality),
                    payload
                ],
            )
            .map_err(|err| err.to_string())?;
        Ok(())
    }

    fn delete_session_artifacts(&self, source: &str, session_id: &str) -> Result<(), String> {
        let checkpoint_ids = self
            .list_session_checkpoints(Some(source), Some(session_id))?
            .into_iter()
            .map(|checkpoint| checkpoint.checkpoint_id)
            .collect::<Vec<_>>();
        for checkpoint_id in checkpoint_ids {
            self.conn
                .execute(
                    "DELETE FROM orgtrack_core_checkpoint_file_states WHERE checkpoint_id = ?1",
                    params![checkpoint_id],
                )
                .map_err(|err| err.to_string())?;
        }
        for table_name in [
            "orgtrack_core_edit_artifacts",
            "orgtrack_core_diff_chunks",
            "orgtrack_core_final_diffs",
            "orgtrack_core_session_checkpoints",
        ] {
            self.conn
                .execute(
                    &format!("DELETE FROM {table_name} WHERE source = ?1 AND session_id = ?2"),
                    params![source, session_id],
                )
                .map_err(|err| err.to_string())?;
        }
        self.conn
            .execute(
                "DELETE FROM orgtrack_core_file_changes WHERE source = ?1 AND session_id = ?2",
                params![source, session_id],
            )
            .map_err(|err| err.to_string())?;
        self.conn
            .execute(
                "DELETE FROM orgtrack_core_commit_links WHERE EXISTS (
                    SELECT 1 FROM json_each(orgtrack_core_commit_links.payload_json, '$.sessionIds')
                    WHERE json_each.value = ?1
                )",
                params![session_id],
            )
            .map_err(|err| err.to_string())?;
        Ok(())
    }

    fn delete_session_derived_artifacts(
        &self,
        source: &str,
        session_id: &str,
    ) -> Result<(), String> {
        let checkpoint_ids = self
            .list_session_checkpoints(Some(source), Some(session_id))?
            .into_iter()
            .map(|checkpoint| checkpoint.checkpoint_id)
            .collect::<Vec<_>>();
        for checkpoint_id in checkpoint_ids {
            self.conn
                .execute(
                    "DELETE FROM orgtrack_core_checkpoint_file_states WHERE checkpoint_id = ?1",
                    params![checkpoint_id],
                )
                .map_err(|err| err.to_string())?;
        }
        for table_name in [
            "orgtrack_core_final_diffs",
            "orgtrack_core_session_checkpoints",
        ] {
            self.conn
                .execute(
                    &format!("DELETE FROM {table_name} WHERE source = ?1 AND session_id = ?2"),
                    params![source, session_id],
                )
                .map_err(|err| err.to_string())?;
        }
        self.conn
            .execute(
                "DELETE FROM orgtrack_core_file_changes WHERE source = ?1 AND session_id = ?2",
                params![source, session_id],
            )
            .map_err(|err| err.to_string())?;
        self.conn
            .execute(
                "DELETE FROM orgtrack_core_commit_links WHERE EXISTS (
                    SELECT 1 FROM json_each(orgtrack_core_commit_links.payload_json, '$.sessionIds')
                    WHERE json_each.value = ?1
                )",
                params![session_id],
            )
            .map_err(|err| err.to_string())?;
        Ok(())
    }

    fn list_edit_artifacts(
        &self,
        source: Option<&str>,
        session_id: Option<&str>,
    ) -> Result<Vec<SessionEditArtifactRecord>, String> {
        self.list_by_scope(
            "orgtrack_core_edit_artifacts",
            source,
            session_id,
            "sequence_index ASC",
        )
    }

    fn list_diff_chunks(
        &self,
        source: Option<&str>,
        session_id: Option<&str>,
    ) -> Result<Vec<SessionDiffChunkRecord>, String> {
        self.list_by_scope(
            "orgtrack_core_diff_chunks",
            source,
            session_id,
            "sequence_index ASC, chunk_index ASC",
        )
    }

    fn list_final_diffs(
        &self,
        source: Option<&str>,
        session_id: Option<&str>,
    ) -> Result<Vec<SessionFinalDiffRecord>, String> {
        self.list_by_scope(
            "orgtrack_core_final_diffs",
            source,
            session_id,
            "file_path ASC",
        )
    }

    fn list_session_checkpoints(
        &self,
        source: Option<&str>,
        session_id: Option<&str>,
    ) -> Result<Vec<SessionCheckpointRecord>, String> {
        self.list_by_scope(
            "orgtrack_core_session_checkpoints",
            source,
            session_id,
            "sequence_index ASC",
        )
    }

    fn list_checkpoint_file_states(
        &self,
        checkpoint_id: &str,
    ) -> Result<Vec<SessionCheckpointFileStateRecord>, String> {
        let mut records = Vec::new();
        let mut stmt = self
            .conn
            .prepare(
                "SELECT payload_json FROM orgtrack_core_checkpoint_file_states WHERE checkpoint_id = ?1 ORDER BY file_path ASC",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(params![checkpoint_id], |row| row.get::<_, String>(0))
            .map_err(|err| err.to_string())?;
        for row in rows {
            records.push(Self::from_json(row.map_err(|err| err.to_string())?)?);
        }
        Ok(records)
    }

    fn list_commit_links(&self) -> Result<Vec<CommitLinkRecord>, String> {
        let mut records = Vec::new();
        let mut stmt = self
            .conn
            .prepare("SELECT payload_json FROM orgtrack_core_commit_links ORDER BY linked_at DESC")
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|err| err.to_string())?;
        for row in rows {
            records.push(Self::from_json(row.map_err(|err| err.to_string())?)?);
        }
        Ok(records)
    }

    fn list_commit_links_for_session(
        &self,
        session_id: &str,
    ) -> Result<Vec<CommitLinkRecord>, String> {
        let mut records = Vec::new();
        let mut stmt = self
            .conn
            .prepare(
                "SELECT payload_json FROM orgtrack_core_commit_links WHERE EXISTS (
                    SELECT 1 FROM json_each(orgtrack_core_commit_links.payload_json, '$.sessionIds')
                    WHERE json_each.value = ?1
                ) ORDER BY linked_at DESC",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(params![session_id], |row| row.get::<_, String>(0))
            .map_err(|err| err.to_string())?;
        for row in rows {
            records.push(Self::from_json(row.map_err(|err| err.to_string())?)?);
        }
        Ok(records)
    }

    fn get_checkpoint(&self, source: &str) -> Result<Option<ScanCheckpoint>, String> {
        self.conn
            .query_row(
                "SELECT payload_json FROM orgtrack_core_checkpoints WHERE source = ?1",
                params![source],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|err| err.to_string())?
            .map(Self::from_json)
            .transpose()
    }

    fn put_checkpoint(&self, checkpoint: &ScanCheckpoint) -> Result<(), String> {
        let payload = Self::to_json(checkpoint)?;
        self.conn
            .execute(
                "INSERT INTO orgtrack_core_checkpoints (source, parser_version, updated_at, payload_json)
                VALUES (?1, ?2, ?3, ?4)
                ON CONFLICT(source) DO UPDATE SET
                    parser_version=excluded.parser_version,
                    updated_at=excluded.updated_at,
                    payload_json=excluded.payload_json",
                params![checkpoint.source, checkpoint.parser_version, checkpoint.updated_at, payload],
            )
            .map_err(|err| err.to_string())?;
        Ok(())
    }

    fn list_sessions(&self, workspace_path: Option<&str>) -> Result<Vec<SessionRecord>, String> {
        let mut records = Vec::new();
        if let Some(workspace_path) = workspace_path {
            let mut stmt = self.conn
                .prepare("SELECT payload_json FROM orgtrack_core_sessions WHERE workspace_path = ?1 ORDER BY updated_at DESC")
                .map_err(|err| err.to_string())?;
            let rows = stmt
                .query_map(params![workspace_path], |row| row.get::<_, String>(0))
                .map_err(|err| err.to_string())?;
            for row in rows {
                records.push(Self::from_json(row.map_err(|err| err.to_string())?)?);
            }
            return Ok(records);
        }

        let mut stmt = self
            .conn
            .prepare("SELECT payload_json FROM orgtrack_core_sessions ORDER BY updated_at DESC")
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|err| err.to_string())?;
        for row in rows {
            records.push(Self::from_json(row.map_err(|err| err.to_string())?)?);
        }
        Ok(records)
    }

    fn list_file_changes(
        &self,
        workspace_path: Option<&str>,
    ) -> Result<Vec<FileChangeRecord>, String> {
        let mut records = Vec::new();
        if let Some(workspace_path) = workspace_path {
            let mut stmt = self.conn
                .prepare("SELECT payload_json FROM orgtrack_core_file_changes WHERE workspace_path = ?1 ORDER BY timestamp DESC")
                .map_err(|err| err.to_string())?;
            let rows = stmt
                .query_map(params![workspace_path], |row| row.get::<_, String>(0))
                .map_err(|err| err.to_string())?;
            for row in rows {
                records.push(Self::from_json(row.map_err(|err| err.to_string())?)?);
            }
            return Ok(records);
        }

        let mut stmt = self
            .conn
            .prepare("SELECT payload_json FROM orgtrack_core_file_changes ORDER BY timestamp DESC")
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|err| err.to_string())?;
        for row in rows {
            records.push(Self::from_json(row.map_err(|err| err.to_string())?)?);
        }
        Ok(records)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::canonical::{
        AgentMetadata, ArtifactQuality, JourneyMetadata, SessionEditArtifactRecord,
        SessionEditKind, SessionRecord,
    };
    use crate::privacy::ORGTRACK_SCHEMA_VERSION;

    fn fixture_store() -> SqliteRecordStore<'static> {
        let conn = Connection::open_in_memory().expect("in-memory sqlite");
        SqliteRecordStore::init_tables(&conn).expect("init tables");
        SqliteRecordStore::new(Box::leak(Box::new(conn)))
    }

    #[test]
    fn edit_artifacts_are_upserted_listed_and_deleted_by_session() {
        let store = fixture_store();
        let record = SessionEditArtifactRecord {
            schema_version: ORGTRACK_SCHEMA_VERSION,
            record_id: "edit-1".to_string(),
            source: "cursor_ide".to_string(),
            source_session_id: Some("source-1".to_string()),
            session_id: "session-1".to_string(),
            source_event_id: Some("event-1".to_string()),
            turn_id: Some("turn-1".to_string()),
            execution_turn_id: Some("execution-turn-1".to_string()),
            sequence_index: 1,
            timestamp: Some("2026-06-15T00:00:00Z".to_string()),
            workspace_path: Some("/repo".to_string()),
            file_path: "src/lib.rs".to_string(),
            path_hash: "hash".to_string(),
            edit_kind: SessionEditKind::Patch,
            old_start_line: Some(1),
            new_start_line: Some(1),
            start_line: Some(1),
            end_line: Some(2),
            lines_added: 2,
            lines_removed: 1,
            quality: ArtifactQuality::PatchReversible,
            metadata: AgentMetadata::default(),
        };
        store
            .upsert_edit_artifact(&record)
            .expect("upsert edit artifact");
        let records = store
            .list_edit_artifacts(Some("cursor_ide"), Some("session-1"))
            .expect("list edit artifacts");
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].record_id, "edit-1");
        assert_eq!(
            records[0].execution_turn_id.as_deref(),
            Some("execution-turn-1")
        );

        store
            .delete_session_artifacts("cursor_ide", "session-1")
            .expect("delete session artifacts");
        let records = store
            .list_edit_artifacts(Some("cursor_ide"), Some("session-1"))
            .expect("list edit artifacts after delete");
        assert!(records.is_empty());
    }

    #[test]
    fn journey_metadata_is_durable_and_absent_values_remain_empty() {
        let store = fixture_store();
        let record = SessionRecord {
            schema_version: ORGTRACK_SCHEMA_VERSION,
            source: "test".to_string(),
            source_session_id: "source-1".to_string(),
            session_id: "session-1".to_string(),
            title: "test".to_string(),
            status: None,
            created_at: None,
            updated_at: None,
            completed_at: None,
            workspace_path: None,
            branch: None,
            parent_session_id: None,
            org_member_id: None,
            metadata: AgentMetadata::default(),
            journey: JourneyMetadata {
                project_id: Some("project-1".to_string()),
                workspace_id: None,
                work_item_id: Some("work-1".to_string()),
                agent_identity: Some("agent-1".to_string()),
                agent_band: None,
                topic_tags: vec!["explicit".to_string()],
            },
        };
        store.upsert_session(&record).expect("upsert session");
        let (project_id, workspace_id, work_item_id, agent_identity, agent_band, tags):
            (Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, String) =
            store.conn.query_row(
                "SELECT project_id, workspace_id, work_item_id, agent_identity, agent_band, topic_tags_json
                 FROM orgtrack_core_sessions WHERE session_id = ?1",
                ["session-1"],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
            ).expect("read durable journey metadata");
        assert_eq!(project_id.as_deref(), Some("project-1"));
        assert_eq!(workspace_id, None);
        assert_eq!(work_item_id.as_deref(), Some("work-1"));
        assert_eq!(agent_identity.as_deref(), Some("agent-1"));
        assert_eq!(agent_band, None);
        assert_eq!(tags, r#"["explicit"]"#);

        let loaded = store
            .list_sessions(None)
            .expect("read durable journey metadata");
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].journey, record.journey);
    }
}

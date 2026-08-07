use rusqlite::{params, Connection, OptionalExtension};

use super::{FileResourceInteractionPage, RecentHookSignal, RecordStore};
use crate::canonical::{
    ActivityRecord, CommitLinkRecord, FileChangeRecord, FileResourceRecord,
    ResourceInteractionRecord, ScanCheckpoint, SessionActorRecord,
    SessionCheckpointFileStateRecord, SessionCheckpointRecord, SessionDiffChunkRecord,
    SessionEditArtifactRecord, SessionFinalDiffRecord, SessionRecord,
};
use crate::session_usage::SessionUsageRecord;

pub struct SqliteRecordStore<'conn> {
    conn: &'conn Connection,
}

/// Run the two-table file-resource write atomically without assuming whether
/// the caller already owns a transaction. SQLite savepoints work both inside
/// an existing transaction and in autocommit mode, so this hot-path upsert is
/// safely composable in larger reconciliation transactions.
fn with_file_resource_savepoint<T>(
    conn: &Connection,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    const BEGIN: &str = "SAVEPOINT orgtrack_file_resource_write";
    const COMMIT: &str = "RELEASE SAVEPOINT orgtrack_file_resource_write";
    const ROLLBACK: &str = "ROLLBACK TO SAVEPOINT orgtrack_file_resource_write;
                            RELEASE SAVEPOINT orgtrack_file_resource_write";
    conn.execute_batch(BEGIN).map_err(|err| err.to_string())?;

    match operation() {
        Ok(value) => {
            conn.execute_batch(COMMIT).map_err(|err| err.to_string())?;
            Ok(value)
        }
        Err(operation_error) => {
            let rollback = conn.execute_batch(ROLLBACK);
            match rollback {
                Ok(()) => Err(operation_error),
                Err(rollback_error) => Err(format!(
                    "{operation_error}; failed to roll back store savepoint: {rollback_error}"
                )),
            }
        }
    }
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

    /// Remove the local read model for one collaboration replay.
    ///
    /// File resources are shared across sessions and intentionally remain;
    /// only the replay-owned session, actors, interactions, and reconciliation
    /// checkpoint are deleted. This is used when the user explicitly hides
    /// and discards a cached Team Session.
    pub fn delete_collaboration_session_provenance(
        &self,
        source: &str,
        session_id: &str,
    ) -> Result<(), String> {
        self.conn
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(|err| err.to_string())?;
        let result = (|| {
            self.conn
                .execute(
                    "DELETE FROM orgtrack_core_resource_interactions
                     WHERE source = ?1 AND session_id = ?2",
                    params![source, session_id],
                )
                .map_err(|err| err.to_string())?;
            self.conn
                .execute(
                    "DELETE FROM orgtrack_core_session_actors
                     WHERE source = ?1 AND session_id = ?2",
                    params![source, session_id],
                )
                .map_err(|err| err.to_string())?;
            self.conn
                .execute(
                    "DELETE FROM orgtrack_core_interaction_import_checkpoints
                     WHERE source = ?1 AND session_id = ?2",
                    params![source, session_id],
                )
                .map_err(|err| err.to_string())?;
            self.conn
                .execute(
                    "DELETE FROM orgtrack_core_sessions
                     WHERE source = ?1 AND session_id = ?2",
                    params![source, session_id],
                )
                .map_err(|err| err.to_string())?;
            Ok::<(), String>(())
        })();
        match result {
            Ok(()) => self
                .conn
                .execute_batch("COMMIT")
                .map_err(|err| err.to_string()),
            Err(err) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(err)
            }
        }
    }

    pub fn init_tables(conn: &Connection) -> rusqlite::Result<()> {
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS orgtrack_core_sessions (
                session_id          TEXT PRIMARY KEY,
                source              TEXT NOT NULL,
                source_session_id   TEXT NOT NULL,
                workspace_path      TEXT,
                parent_session_id   TEXT,
                title               TEXT NOT NULL,
                status              TEXT,
                created_at          TEXT,
                updated_at          TEXT,
                completed_at        TEXT,
                branch              TEXT,
                payload_json        TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_orgtrack_core_sessions_source
                ON orgtrack_core_sessions(source, source_session_id);
            CREATE INDEX IF NOT EXISTS idx_orgtrack_core_sessions_workspace
                ON orgtrack_core_sessions(workspace_path);
            CREATE INDEX IF NOT EXISTS idx_orgtrack_core_sessions_updated
                ON orgtrack_core_sessions(updated_at DESC);

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

            CREATE TABLE IF NOT EXISTS orgtrack_core_resources (
                resource_id         TEXT PRIMARY KEY,
                resource_kind       TEXT NOT NULL,
                canonical_locator   TEXT NOT NULL,
                display_locator     TEXT NOT NULL,
                payload_json        TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_orgtrack_core_resources_locator
                ON orgtrack_core_resources(resource_kind, canonical_locator);

            CREATE TABLE IF NOT EXISTS orgtrack_core_file_resources (
                resource_id         TEXT PRIMARY KEY,
                repository_id       TEXT,
                workspace_path      TEXT NOT NULL,
                repo_relative_path  TEXT NOT NULL,
                path_hash           TEXT NOT NULL,
                FOREIGN KEY(resource_id) REFERENCES orgtrack_core_resources(resource_id)
            );
            CREATE INDEX IF NOT EXISTS idx_orgtrack_core_file_resources_repo
                ON orgtrack_core_file_resources(repository_id, repo_relative_path);
            CREATE INDEX IF NOT EXISTS idx_orgtrack_core_file_resources_workspace
                ON orgtrack_core_file_resources(workspace_path, repo_relative_path);

            CREATE TABLE IF NOT EXISTS orgtrack_core_resource_interactions (
                interaction_id       TEXT PRIMARY KEY,
                source               TEXT NOT NULL,
                source_session_id    TEXT,
                source_event_id      TEXT,
                session_id           TEXT NOT NULL,
                turn_id              TEXT,
                actor_id             TEXT,
                resource_id          TEXT NOT NULL,
                action               TEXT NOT NULL,
                outcome              TEXT NOT NULL,
                occurred_at          TEXT NOT NULL,
                capture_method       TEXT NOT NULL,
                attribution_precision TEXT NOT NULL,
                payload_json         TEXT NOT NULL,
                FOREIGN KEY(resource_id) REFERENCES orgtrack_core_resources(resource_id)
            );
            CREATE INDEX IF NOT EXISTS idx_orgtrack_core_resource_interactions_resource
                ON orgtrack_core_resource_interactions(resource_id, occurred_at DESC);
            CREATE INDEX IF NOT EXISTS idx_orgtrack_core_resource_interactions_session
                ON orgtrack_core_resource_interactions(session_id, occurred_at DESC);
            -- A hook observation and a later transcript reconciliation may
            -- describe the same source event with different attribution
            -- precision. Keep both immutable observations; the read model
            -- selects the strongest one. Older builds created this as UNIQUE,
            -- which prevented an exact child-session observation from being
            -- recorded after a session-only hook observation.
            DROP INDEX IF EXISTS idx_orgtrack_core_resource_interactions_source_event;
            CREATE INDEX IF NOT EXISTS idx_orgtrack_core_resource_interactions_observation
                ON orgtrack_core_resource_interactions(source, source_event_id, resource_id, action)
                WHERE source_event_id IS NOT NULL;

            -- Durable invalidation clock. SQLite triggers cover every writer
            -- (native runtime, managed hooks, historical reconciliation, and
            -- collaboration replay) without an in-process cache or event bus.
            CREATE TABLE IF NOT EXISTS orgtrack_core_resource_revisions (
                resource_id  TEXT PRIMARY KEY,
                revision     INTEGER NOT NULL,
                updated_at   TEXT NOT NULL
            );
            CREATE TRIGGER IF NOT EXISTS orgtrack_core_resource_revision_insert
            AFTER INSERT ON orgtrack_core_resource_interactions
            BEGIN
                INSERT INTO orgtrack_core_resource_revisions(resource_id, revision, updated_at)
                VALUES (NEW.resource_id, 1, NEW.occurred_at)
                ON CONFLICT(resource_id) DO UPDATE SET
                    revision = revision + 1,
                    updated_at = excluded.updated_at;
            END;
            CREATE TRIGGER IF NOT EXISTS orgtrack_core_resource_revision_delete
            AFTER DELETE ON orgtrack_core_resource_interactions
            BEGIN
                INSERT INTO orgtrack_core_resource_revisions(resource_id, revision, updated_at)
                VALUES (OLD.resource_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                ON CONFLICT(resource_id) DO UPDATE SET
                    revision = revision + 1,
                    updated_at = excluded.updated_at;
            END;

            CREATE TABLE IF NOT EXISTS orgtrack_core_session_actors (
                actor_record_id        TEXT PRIMARY KEY,
                source                 TEXT NOT NULL,
                source_session_id      TEXT NOT NULL,
                session_id             TEXT NOT NULL,
                turn_id                TEXT,
                actor_id               TEXT NOT NULL,
                actor_type             TEXT,
                started_at             TEXT,
                stopped_at             TEXT,
                transcript_session_id  TEXT,
                transcript_path        TEXT,
                payload_json           TEXT NOT NULL,
                UNIQUE(source, source_session_id, actor_id)
            );
            CREATE INDEX IF NOT EXISTS idx_orgtrack_core_session_actors_session
                ON orgtrack_core_session_actors(source, session_id, turn_id);
            CREATE INDEX IF NOT EXISTS idx_orgtrack_core_session_actors_transcript
                ON orgtrack_core_session_actors(source, transcript_session_id)
                WHERE transcript_session_id IS NOT NULL;

            CREATE TABLE IF NOT EXISTS orgtrack_core_interaction_import_checkpoints (
                source              TEXT NOT NULL,
                session_id          TEXT NOT NULL,
                source_fingerprint  TEXT NOT NULL,
                parser_version      INTEGER NOT NULL,
                reconciled_at       TEXT NOT NULL,
                PRIMARY KEY (source, session_id)
            );

            -- Repository-scoped historical indexing state. This replaces an
            -- in-process job cache, making progress/recovery restart-safe and
            -- queryable without retaining transcript state in RAM.
            CREATE TABLE IF NOT EXISTS orgtrack_core_interaction_backfill_jobs (
                repo_key            TEXT PRIMARY KEY,
                status              TEXT NOT NULL,
                indexed_sessions    INTEGER NOT NULL,
                total_sessions      INTEGER NOT NULL,
                failed_sessions     INTEGER NOT NULL,
                last_error          TEXT,
                run_token           TEXT NOT NULL,
                updated_at_ms       INTEGER NOT NULL
            );

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

            -- Per-session usage/cost projection, recomputed from the token
            -- stores (see crate::session_usage for the read rules). A derived
            -- read model: safe to drop and re-backfill at any time.
            CREATE TABLE IF NOT EXISTS orgtrack_core_session_usage (
                session_id          TEXT PRIMARY KEY,
                source              TEXT NOT NULL,
                model               TEXT,
                account_id          TEXT,
                key_source          TEXT,
                input_tokens        INTEGER NOT NULL DEFAULT 0,
                output_tokens       INTEGER NOT NULL DEFAULT 0,
                cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
                cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
                total_tokens        INTEGER NOT NULL DEFAULT 0,
                context_tokens      INTEGER NOT NULL DEFAULT 0,
                recorded_cost_usd   REAL NOT NULL DEFAULT 0,
                estimated_cost_usd  REAL NOT NULL DEFAULT 0,
                cost_usd            REAL NOT NULL DEFAULT 0,
                tokens_source       TEXT NOT NULL DEFAULT 'none',
                computed_at         TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_orgtrack_core_session_usage_model
                ON orgtrack_core_session_usage(model);
            CREATE INDEX IF NOT EXISTS idx_orgtrack_core_session_usage_source
                ON orgtrack_core_session_usage(source);
            ",
        )?;

        // Older databases predate the normalized parent column. Keep the
        // migration independent of SQLite JSON extensions by decoding the
        // canonical payload with the same Rust type used by normal reads.
        ensure_column(conn, "orgtrack_core_sessions", "parent_session_id", "TEXT")?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_orgtrack_core_sessions_parent
             ON orgtrack_core_sessions(parent_session_id)",
            [],
        )?;
        let legacy_parents = {
            let mut statement = conn.prepare(
                "SELECT session_id, payload_json FROM orgtrack_core_sessions
                 WHERE parent_session_id IS NULL",
            )?;
            let rows = statement.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            rows.filter_map(Result::ok)
                .filter_map(|(session_id, payload)| {
                    serde_json::from_str::<SessionRecord>(&payload)
                        .ok()
                        .and_then(|record| {
                            record.parent_session_id.map(|parent| (session_id, parent))
                        })
                })
                .collect::<Vec<_>>()
        };
        for (session_id, parent_session_id) in legacy_parents {
            conn.execute(
                "UPDATE orgtrack_core_sessions SET parent_session_id = ?1 WHERE session_id = ?2",
                params![parent_session_id, session_id],
            )?;
        }

        // Same migration pattern for the normalized status column: decode the
        // canonical payload in Rust so SQLite JSON extensions stay optional.
        ensure_column(conn, "orgtrack_core_sessions", "status", "TEXT")?;
        let legacy_statuses = {
            let mut statement = conn.prepare(
                "SELECT session_id, payload_json FROM orgtrack_core_sessions
                 WHERE status IS NULL",
            )?;
            let rows = statement.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            rows.filter_map(Result::ok)
                .filter_map(|(session_id, payload)| {
                    serde_json::from_str::<SessionRecord>(&payload)
                        .ok()
                        .and_then(|record| record.status.map(|status| (session_id, status)))
                })
                .collect::<Vec<_>>()
        };
        for (session_id, status) in legacy_statuses {
            conn.execute(
                "UPDATE orgtrack_core_sessions SET status = ?1 WHERE session_id = ?2",
                params![status, session_id],
            )?;
        }
        // Existing interaction rows were created before the revision trigger.
        // Seed them once; subsequent writes are incremented transactionally.
        conn.execute(
            "INSERT OR IGNORE INTO orgtrack_core_resource_revisions(resource_id, revision, updated_at)
             SELECT resource_id, COUNT(*), COALESCE(MAX(occurred_at), '')
             FROM orgtrack_core_resource_interactions
             GROUP BY resource_id",
            [],
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
            CREATE INDEX IF NOT EXISTS idx_imported_history_sidebar_order
                ON imported_history_session_cache(
                    source,
                    updated_at_ms DESC,
                    created_at_ms DESC,
                    source_session_id ASC
                )
                WHERE listable = 1 AND parent_session_id = '';
            CREATE INDEX IF NOT EXISTS idx_imported_history_source_repo
                ON imported_history_session_cache(source, repo_path);
            CREATE INDEX IF NOT EXISTS idx_imported_history_source_path
                ON imported_history_session_cache(source, source_path);
            CREATE INDEX IF NOT EXISTS idx_imported_history_session_id
                ON imported_history_session_cache(session_id);
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

    /// Whether a historical transcript has already been reconciled with the
    /// same source fingerprint and interaction parser version.
    pub fn interaction_import_is_current(
        &self,
        source: &str,
        session_id: &str,
        source_fingerprint: &str,
        parser_version: i64,
    ) -> Result<bool, String> {
        self.conn
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM orgtrack_core_interaction_import_checkpoints
                    WHERE source = ?1 AND session_id = ?2
                      AND source_fingerprint = ?3 AND parser_version = ?4
                )",
                params![source, session_id, source_fingerprint, parser_version],
                |row| row.get::<_, bool>(0),
            )
            .map_err(|err| err.to_string())
    }

    /// Mark a historical transcript as fully reconciled. Callers only invoke
    /// this after every extracted interaction has been persisted.
    pub fn mark_interaction_imported(
        &self,
        source: &str,
        session_id: &str,
        source_fingerprint: &str,
        parser_version: i64,
        reconciled_at: &str,
    ) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO orgtrack_core_interaction_import_checkpoints (
                    source, session_id, source_fingerprint, parser_version, reconciled_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(source, session_id) DO UPDATE SET
                    source_fingerprint = excluded.source_fingerprint,
                    parser_version = excluded.parser_version,
                    reconciled_at = excluded.reconciled_at",
                params![
                    source,
                    session_id,
                    source_fingerprint,
                    parser_version,
                    reconciled_at
                ],
            )
            .map(|_| ())
            .map_err(|err| err.to_string())
    }

    /// Remove only facts derived from a previous transcript reconciliation.
    /// Live hook/native facts for the same session remain authoritative.
    pub fn delete_reconciled_resource_interactions(
        &self,
        source: &str,
        session_id: &str,
    ) -> Result<usize, String> {
        self.conn
            .execute(
                "DELETE FROM orgtrack_core_resource_interactions
                 WHERE source = ?1 AND session_id = ?2 AND capture_method = 'reconciled'",
                params![source, session_id],
            )
            .map_err(|err| err.to_string())
    }

    /// The most recently received hook-captured file interactions, newest
    /// first, joined with their file resource for a displayable path. Powers
    /// the Session Provenance "recent signals" table. Only `capture_method =
    /// 'hook'` rows are returned — native/reconciled facts are excluded.
    pub fn list_recent_hook_signals(&self, limit: usize) -> Result<Vec<RecentHookSignal>, String> {
        let limit = limit.clamp(1, 1000) as i64;
        let mut statement = self
            .conn
            .prepare(
                "SELECT interaction.source, interaction.session_id, interaction.actor_id,
                        file_resource.repo_relative_path, file_resource.workspace_path,
                        interaction.action, interaction.outcome, interaction.occurred_at,
                        interaction.capture_method,
                        CASE
                          WHEN session.title IS NULL OR session.title = ''
                            THEN NULL
                          WHEN session.title = interaction.source_session_id
                            THEN NULL
                          WHEN session.title = interaction.session_id
                            THEN NULL
                          ELSE session.title
                        END AS session_title
                 FROM orgtrack_core_resource_interactions interaction
                 JOIN orgtrack_core_file_resources file_resource
                   ON file_resource.resource_id = interaction.resource_id
                 LEFT JOIN orgtrack_core_sessions session
                   ON session.session_id = interaction.session_id
                 WHERE interaction.capture_method = 'hook'
                 ORDER BY interaction.occurred_at DESC, interaction.interaction_id DESC
                 LIMIT ?1",
            )
            .map_err(|err| err.to_string())?;
        let rows = statement
            .query_map(params![limit], |row| {
                Ok(RecentHookSignal {
                    source: row.get(0)?,
                    session_id: row.get(1)?,
                    actor_id: row.get(2)?,
                    file_path: row.get(3)?,
                    workspace_path: row.get(4)?,
                    action: row.get(5)?,
                    outcome: row.get(6)?,
                    occurred_at: row.get(7)?,
                    capture_method: row.get(8)?,
                    session_title: row.get(9)?,
                })
            })
            .map_err(|err| err.to_string())?;
        let mut signals = Vec::new();
        for row in rows {
            signals.push(row.map_err(|err| err.to_string())?);
        }
        Ok(signals)
    }

    /// Upsert one session's usage/cost projection row. The projection is
    /// derived state — writers always replace the full row rather than
    /// patching columns, so a recompute can never leave mixed generations.
    pub fn upsert_session_usage(&self, record: &SessionUsageRecord) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO orgtrack_core_session_usage (
                    session_id, source, model, account_id, key_source,
                    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                    total_tokens, context_tokens, recorded_cost_usd, estimated_cost_usd,
                    cost_usd, tokens_source, computed_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
                ON CONFLICT(session_id) DO UPDATE SET
                    source=excluded.source,
                    model=excluded.model,
                    account_id=excluded.account_id,
                    key_source=excluded.key_source,
                    input_tokens=excluded.input_tokens,
                    output_tokens=excluded.output_tokens,
                    cache_read_tokens=excluded.cache_read_tokens,
                    cache_write_tokens=excluded.cache_write_tokens,
                    total_tokens=excluded.total_tokens,
                    context_tokens=excluded.context_tokens,
                    recorded_cost_usd=excluded.recorded_cost_usd,
                    estimated_cost_usd=excluded.estimated_cost_usd,
                    cost_usd=excluded.cost_usd,
                    tokens_source=excluded.tokens_source,
                    computed_at=excluded.computed_at",
                params![
                    record.session_id,
                    record.source,
                    record.model,
                    record.account_id,
                    record.key_source,
                    record.input_tokens,
                    record.output_tokens,
                    record.cache_read_tokens,
                    record.cache_write_tokens,
                    record.total_tokens,
                    record.context_tokens,
                    record.recorded_cost_usd,
                    record.estimated_cost_usd,
                    record.cost_usd,
                    record.tokens_source,
                    record.computed_at
                ],
            )
            .map(|_| ())
            .map_err(|err| err.to_string())
    }

    pub fn get_session_usage(
        &self,
        session_id: &str,
    ) -> Result<Option<SessionUsageRecord>, String> {
        self.conn
            .query_row(
                "SELECT session_id, source, model, account_id, key_source,
                        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                        total_tokens, context_tokens, recorded_cost_usd, estimated_cost_usd,
                        cost_usd, tokens_source, computed_at
                 FROM orgtrack_core_session_usage
                 WHERE session_id = ?1",
                params![session_id],
                |row| {
                    Ok(SessionUsageRecord {
                        session_id: row.get(0)?,
                        source: row.get(1)?,
                        model: row.get(2)?,
                        account_id: row.get(3)?,
                        key_source: row.get(4)?,
                        input_tokens: row.get(5)?,
                        output_tokens: row.get(6)?,
                        cache_read_tokens: row.get(7)?,
                        cache_write_tokens: row.get(8)?,
                        total_tokens: row.get(9)?,
                        context_tokens: row.get(10)?,
                        recorded_cost_usd: row.get(11)?,
                        estimated_cost_usd: row.get(12)?,
                        cost_usd: row.get(13)?,
                        tokens_source: row.get(14)?,
                        computed_at: row.get(15)?,
                    })
                },
            )
            .optional()
            .map_err(|err| err.to_string())
    }

    pub fn delete_session_usage(&self, session_id: &str) -> Result<(), String> {
        self.conn
            .execute(
                "DELETE FROM orgtrack_core_session_usage WHERE session_id = ?1",
                params![session_id],
            )
            .map(|_| ())
            .map_err(|err| err.to_string())
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
                    session_id, source, source_session_id, workspace_path,
                    parent_session_id, title, status, created_at, updated_at,
                    completed_at, branch, payload_json
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                ON CONFLICT(session_id) DO UPDATE SET
                    source=excluded.source,
                    source_session_id=excluded.source_session_id,
                    workspace_path=excluded.workspace_path,
                    parent_session_id=excluded.parent_session_id,
                    title=excluded.title,
                    status=excluded.status,
                    created_at=excluded.created_at,
                    updated_at=excluded.updated_at,
                    completed_at=excluded.completed_at,
                    branch=excluded.branch,
                    payload_json=excluded.payload_json",
                params![
                    record.session_id,
                    record.source,
                    record.source_session_id,
                    record.workspace_path,
                    record.parent_session_id,
                    record.title,
                    record.status,
                    record.created_at,
                    record.updated_at,
                    record.completed_at,
                    record.branch,
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

    fn upsert_file_resource(&self, record: &FileResourceRecord) -> Result<(), String> {
        let payload = Self::to_json(record)?;
        let canonical_locator = match record.repository_id.as_deref() {
            Some(repository_id) => format!("repo:{repository_id}:{}", record.repo_relative_path),
            None => format!(
                "workspace:{}:{}",
                record.workspace_path, record.repo_relative_path
            ),
        };
        with_file_resource_savepoint(self.conn, || {
            self.conn
                .execute(
                    "INSERT INTO orgtrack_core_resources (
                    resource_id, resource_kind, canonical_locator, display_locator, payload_json
                ) VALUES (?1, 'file', ?2, ?3, ?4)
                ON CONFLICT(resource_id) DO UPDATE SET
                    canonical_locator=excluded.canonical_locator,
                    display_locator=excluded.display_locator,
                    payload_json=excluded.payload_json",
                    params![
                        record.resource_id,
                        canonical_locator,
                        record.display_path,
                        payload
                    ],
                )
                .map_err(|err| err.to_string())?;
            self.conn
                .execute(
                    "INSERT INTO orgtrack_core_file_resources (
                    resource_id, repository_id, workspace_path, repo_relative_path, path_hash
                ) VALUES (?1, ?2, ?3, ?4, ?5)
                ON CONFLICT(resource_id) DO UPDATE SET
                    repository_id=excluded.repository_id,
                    workspace_path=excluded.workspace_path,
                    repo_relative_path=excluded.repo_relative_path,
                    path_hash=excluded.path_hash",
                    params![
                        record.resource_id,
                        record.repository_id,
                        record.workspace_path,
                        record.repo_relative_path,
                        record.path_hash
                    ],
                )
                .map_err(|err| err.to_string())?;
            Ok(())
        })
    }

    fn append_resource_interaction(
        &self,
        record: &ResourceInteractionRecord,
    ) -> Result<(), String> {
        let payload = Self::to_json(record)?;
        self.conn
            .execute(
                "INSERT OR IGNORE INTO orgtrack_core_resource_interactions (
                    interaction_id, source, source_session_id, source_event_id, session_id,
                    turn_id, actor_id, resource_id, action, outcome, occurred_at,
                    capture_method, attribution_precision, payload_json
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                params![
                    record.interaction_id,
                    record.source,
                    record.source_session_id,
                    record.source_event_id,
                    record.session_id,
                    record.turn_id,
                    record.actor_id,
                    record.resource_id,
                    record.action.as_str(),
                    record.outcome.as_str(),
                    record.occurred_at,
                    record.capture_method.as_str(),
                    record.attribution_precision.as_str(),
                    payload
                ],
            )
            .map_err(|err| err.to_string())?;
        Ok(())
    }

    fn upsert_session_actor(&self, record: &SessionActorRecord) -> Result<(), String> {
        let payload = Self::to_json(record)?;
        self.conn
            .execute(
                "INSERT INTO orgtrack_core_session_actors (
                    actor_record_id, source, source_session_id, session_id, turn_id,
                    actor_id, actor_type, started_at, stopped_at,
                    transcript_session_id, transcript_path, payload_json
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                ON CONFLICT(source, source_session_id, actor_id) DO UPDATE SET
                    actor_record_id = excluded.actor_record_id,
                    session_id = excluded.session_id,
                    turn_id = excluded.turn_id,
                    actor_type = excluded.actor_type,
                    started_at = excluded.started_at,
                    stopped_at = excluded.stopped_at,
                    transcript_session_id = excluded.transcript_session_id,
                    transcript_path = excluded.transcript_path,
                    payload_json = excluded.payload_json",
                params![
                    record.actor_record_id,
                    record.source,
                    record.source_session_id,
                    record.session_id,
                    record.turn_id,
                    record.actor_id,
                    record.actor_type,
                    record.started_at,
                    record.stopped_at,
                    record.transcript_session_id,
                    record.transcript_path,
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
                    record_id, source, session_id, source_event_id, sequence_index,
                    workspace_path, file_path, path_hash, quality, payload_json
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                ON CONFLICT(record_id) DO UPDATE SET
                    source=excluded.source,
                    session_id=excluded.session_id,
                    source_event_id=excluded.source_event_id,
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

    fn list_file_resource_interactions_page(
        &self,
        repository_id: Option<&str>,
        workspace_path: &str,
        repo_relative_path: &str,
        limit: usize,
        offset: usize,
    ) -> Result<FileResourceInteractionPage, String> {
        let limit = limit.clamp(1, 100) as i64;
        let offset = offset.min(i64::MAX as usize) as i64;
        let match_clause = "file_resource.repo_relative_path = ?1
             AND ((?2 IS NOT NULL AND file_resource.repository_id = ?2)
                  OR file_resource.workspace_path = ?3)";
        let total_sessions = self
            .conn
            .query_row(
                &format!(
                    "SELECT COUNT(DISTINCT COALESCE(session.parent_session_id, interaction.session_id))
                     FROM orgtrack_core_resource_interactions interaction
                     JOIN orgtrack_core_file_resources file_resource
                       ON file_resource.resource_id = interaction.resource_id
                     LEFT JOIN orgtrack_core_sessions session
                       ON session.session_id = interaction.session_id
                     WHERE {match_clause}"
                ),
                params![repo_relative_path, repository_id, workspace_path],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|err| err.to_string())?
            .max(0) as usize;

        let query = format!(
            "WITH matching_roots AS (
                SELECT COALESCE(session.parent_session_id, interaction.session_id) AS root_session_id,
                       MAX(interaction.occurred_at) AS last_interaction_at
                FROM orgtrack_core_resource_interactions interaction
                JOIN orgtrack_core_file_resources file_resource
                  ON file_resource.resource_id = interaction.resource_id
                LEFT JOIN orgtrack_core_sessions session
                  ON session.session_id = interaction.session_id
                WHERE {match_clause}
                GROUP BY root_session_id
                ORDER BY last_interaction_at DESC, root_session_id ASC
                LIMIT ?4 OFFSET ?5
             )
             SELECT interaction.payload_json
             FROM orgtrack_core_resource_interactions interaction
             JOIN orgtrack_core_file_resources file_resource
               ON file_resource.resource_id = interaction.resource_id
             LEFT JOIN orgtrack_core_sessions session
               ON session.session_id = interaction.session_id
             JOIN matching_roots page
               ON page.root_session_id = COALESCE(session.parent_session_id, interaction.session_id)
             WHERE {match_clause}
             ORDER BY interaction.occurred_at DESC, interaction.interaction_id DESC"
        );
        let mut statement = self.conn.prepare(&query).map_err(|err| err.to_string())?;
        let rows = statement
            .query_map(
                params![
                    repo_relative_path,
                    repository_id,
                    workspace_path,
                    limit,
                    offset
                ],
                |row| row.get::<_, String>(0),
            )
            .map_err(|err| err.to_string())?;
        let mut interactions = Vec::new();
        for row in rows {
            interactions.push(Self::from_json(row.map_err(|err| err.to_string())?)?);
        }
        Ok(FileResourceInteractionPage {
            interactions,
            total_sessions,
            offset: offset as usize,
            limit: limit as usize,
        })
    }

    fn get_file_resource_revision(
        &self,
        repository_id: Option<&str>,
        workspace_path: &str,
        repo_relative_path: &str,
    ) -> Result<u64, String> {
        let revision = self
            .conn
            .query_row(
                "SELECT COALESCE(SUM(revision.revision), 0)
                 FROM orgtrack_core_file_resources file_resource
                 LEFT JOIN orgtrack_core_resource_revisions revision
                   ON revision.resource_id = file_resource.resource_id
                 WHERE file_resource.repo_relative_path = ?1
                   AND ((?2 IS NOT NULL AND file_resource.repository_id = ?2)
                        OR file_resource.workspace_path = ?3)",
                params![repo_relative_path, repository_id, workspace_path],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|err| err.to_string())?;
        Ok(revision.max(0) as u64)
    }

    fn get_session(&self, session_id: &str) -> Result<Option<SessionRecord>, String> {
        let payload = self
            .conn
            .query_row(
                "SELECT payload_json FROM orgtrack_core_sessions WHERE session_id = ?1",
                params![session_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|err| err.to_string())?;
        payload.map(Self::from_json).transpose()
    }

    fn get_session_actor(
        &self,
        source: &str,
        session_id: &str,
        actor_id: &str,
    ) -> Result<Option<SessionActorRecord>, String> {
        let payload = self
            .conn
            .query_row(
                "SELECT payload_json FROM orgtrack_core_session_actors
                 WHERE source = ?1 AND session_id = ?2 AND actor_id = ?3",
                params![source, session_id, actor_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|err| err.to_string())?;
        payload.map(Self::from_json).transpose()
    }

    fn get_session_actor_by_source_identity(
        &self,
        source: &str,
        source_session_id: &str,
        actor_id: &str,
    ) -> Result<Option<SessionActorRecord>, String> {
        let payload = self
            .conn
            .query_row(
                "SELECT payload_json FROM orgtrack_core_session_actors
                 WHERE source = ?1 AND source_session_id = ?2 AND actor_id = ?3",
                params![source, source_session_id, actor_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|err| err.to_string())?;
        payload.map(Self::from_json).transpose()
    }

    fn list_session_actors(
        &self,
        source: &str,
        session_id: &str,
    ) -> Result<Vec<SessionActorRecord>, String> {
        let mut statement = self
            .conn
            .prepare(
                "SELECT payload_json FROM orgtrack_core_session_actors
                 WHERE source = ?1 AND session_id = ?2
                 ORDER BY COALESCE(started_at, stopped_at, ''), actor_id",
            )
            .map_err(|err| err.to_string())?;
        let rows = statement
            .query_map(params![source, session_id], |row| row.get::<_, String>(0))
            .map_err(|err| err.to_string())?;
        let mut records = Vec::new();
        for row in rows {
            records.push(Self::from_json(row.map_err(|err| err.to_string())?)?);
        }
        Ok(records)
    }

    fn get_session_actor_by_transcript_session_id(
        &self,
        source: &str,
        transcript_session_id: &str,
    ) -> Result<Option<SessionActorRecord>, String> {
        let payload = self
            .conn
            .query_row(
                "SELECT payload_json FROM orgtrack_core_session_actors
                 WHERE source = ?1 AND transcript_session_id = ?2
                 ORDER BY COALESCE(stopped_at, started_at, '') DESC LIMIT 1",
                params![source, transcript_session_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|err| err.to_string())?;
        payload.map(Self::from_json).transpose()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::canonical::{
        AgentMetadata, ArtifactQuality, AttributionPrecision, FileResourceRecord, ResourceAction,
        ResourceInteractionCaptureMethod, ResourceInteractionOutcome, ResourceInteractionRecord,
        SessionEditArtifactRecord, SessionEditKind, SessionRecord,
        RESOURCE_INTERACTION_SCHEMA_VERSION,
    };
    use crate::privacy::ORGTRACK_SCHEMA_VERSION;

    fn fixture_store() -> SqliteRecordStore<'static> {
        let conn = Connection::open_in_memory().expect("in-memory sqlite");
        SqliteRecordStore::init_tables(&conn).expect("init tables");
        SqliteRecordStore::new(Box::leak(Box::new(conn)))
    }

    fn list_file_interactions(
        store: &SqliteRecordStore<'_>,
        repository_id: Option<&str>,
        workspace_path: &str,
        repo_relative_path: &str,
    ) -> Vec<ResourceInteractionRecord> {
        store
            .list_file_resource_interactions_page(
                repository_id,
                workspace_path,
                repo_relative_path,
                100,
                0,
            )
            .expect("list file interactions")
            .interactions
    }

    #[test]
    fn init_tables_replaces_legacy_unique_source_event_index() {
        let conn = Connection::open_in_memory().expect("in-memory sqlite");
        SqliteRecordStore::init_tables(&conn).expect("init current tables");
        conn.execute_batch(
            "
            DROP INDEX idx_orgtrack_core_resource_interactions_observation;
            CREATE UNIQUE INDEX idx_orgtrack_core_resource_interactions_source_event
                ON orgtrack_core_resource_interactions(
                    source,
                    source_event_id,
                    resource_id,
                    action
                )
                WHERE source_event_id IS NOT NULL;
            ",
        )
        .expect("install legacy unique index");

        SqliteRecordStore::init_tables(&conn).expect("migrate legacy index");

        let legacy_index: Option<String> = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?1",
                ["idx_orgtrack_core_resource_interactions_source_event"],
                |row| row.get(0),
            )
            .optional()
            .expect("query legacy index");
        assert!(legacy_index.is_none());

        let observation_index: String = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?1",
                ["idx_orgtrack_core_resource_interactions_observation"],
                |row| row.get(0),
            )
            .expect("query replacement index");
        assert!(!observation_index.to_ascii_uppercase().contains("UNIQUE"));
    }

    #[test]
    fn init_tables_backfills_parent_identity_before_creating_parent_index() {
        let conn = Connection::open_in_memory().expect("in-memory sqlite");
        conn.execute_batch(
            "CREATE TABLE orgtrack_core_sessions (
                session_id TEXT PRIMARY KEY,
                source TEXT NOT NULL,
                source_session_id TEXT NOT NULL,
                workspace_path TEXT,
                title TEXT NOT NULL,
                created_at TEXT,
                updated_at TEXT,
                completed_at TEXT,
                branch TEXT,
                payload_json TEXT NOT NULL
             );",
        )
        .expect("create legacy sessions table");
        let child = SessionRecord {
            schema_version: ORGTRACK_SCHEMA_VERSION,
            source: "claude_code".to_string(),
            source_session_id: "child".to_string(),
            session_id: "child".to_string(),
            title: "Child".to_string(),
            status: None,
            created_at: None,
            updated_at: None,
            completed_at: None,
            workspace_path: Some("/repo".to_string()),
            branch: None,
            parent_session_id: Some("root".to_string()),
            org_member_id: None,
            collaboration_origin: None,
            metadata: AgentMetadata::default(),
        };
        let child_payload = serde_json::to_string(&child).expect("serialize child");
        conn.execute(
            "INSERT INTO orgtrack_core_sessions (
                session_id, source, source_session_id, workspace_path, title, payload_json
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                &child.session_id,
                &child.source,
                &child.source_session_id,
                &child.workspace_path,
                &child.title,
                child_payload
            ],
        )
        .expect("insert legacy child");

        SqliteRecordStore::init_tables(&conn).expect("migrate legacy sessions table");
        let parent: Option<String> = conn
            .query_row(
                "SELECT parent_session_id FROM orgtrack_core_sessions WHERE session_id = 'child'",
                [],
                |row| row.get(0),
            )
            .expect("query migrated parent");
        assert_eq!(parent.as_deref(), Some("root"));
    }

    #[test]
    fn init_tables_seeds_revisions_for_existing_interactions() {
        let conn = Connection::open_in_memory().expect("in-memory sqlite");
        SqliteRecordStore::init_tables(&conn).expect("initialize current schema");
        conn.execute_batch(
            "DROP TRIGGER orgtrack_core_resource_revision_insert;
             DROP TRIGGER orgtrack_core_resource_revision_delete;
             DROP TABLE orgtrack_core_resource_revisions;",
        )
        .expect("simulate pre-revision schema");
        let store = SqliteRecordStore::new(&conn);
        store
            .upsert_file_resource(&FileResourceRecord {
                schema_version: RESOURCE_INTERACTION_SCHEMA_VERSION,
                resource_id: "legacy-resource".to_string(),
                repository_id: Some("legacy-repo".to_string()),
                workspace_path: "/legacy/repo".to_string(),
                repo_relative_path: "src/legacy.rs".to_string(),
                display_path: "src/legacy.rs".to_string(),
                path_hash: "legacy-hash".to_string(),
            })
            .expect("insert legacy resource");
        store
            .append_resource_interaction(&ResourceInteractionRecord {
                schema_version: RESOURCE_INTERACTION_SCHEMA_VERSION,
                interaction_id: "legacy-interaction".to_string(),
                source: "cursor_ide".to_string(),
                source_session_id: Some("legacy-session".to_string()),
                source_event_id: Some("legacy-event".to_string()),
                session_id: "legacy-session".to_string(),
                turn_id: None,
                actor_id: None,
                resource_id: "legacy-resource".to_string(),
                action: ResourceAction::Read,
                outcome: ResourceInteractionOutcome::Succeeded,
                occurred_at: "2026-07-15T00:00:00Z".to_string(),
                capture_method: ResourceInteractionCaptureMethod::Hook,
                attribution_precision: AttributionPrecision::SessionOnly,
            })
            .expect("insert interaction without revision trigger");

        SqliteRecordStore::init_tables(&conn).expect("migrate revision schema");
        assert_eq!(
            SqliteRecordStore::new(&conn)
                .get_file_resource_revision(
                    Some("legacy-repo"),
                    "/different/worktree",
                    "src/legacy.rs"
                )
                .expect("query seeded revision"),
            1
        );
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

        store
            .delete_session_artifacts("cursor_ide", "session-1")
            .expect("delete session artifacts");
        let records = store
            .list_edit_artifacts(Some("cursor_ide"), Some("session-1"))
            .expect("list edit artifacts after delete");
        assert!(records.is_empty());
    }

    #[test]
    fn file_resource_interactions_are_idempotent_and_queryable_by_repo() {
        let store = fixture_store();
        let resource = FileResourceRecord {
            schema_version: RESOURCE_INTERACTION_SCHEMA_VERSION,
            resource_id: "file-1".to_string(),
            repository_id: Some("repo-1".to_string()),
            workspace_path: "/repo/worktree".to_string(),
            repo_relative_path: "src/lib.rs".to_string(),
            display_path: "src/lib.rs".to_string(),
            path_hash: "hash-1".to_string(),
        };
        store
            .upsert_file_resource(&resource)
            .expect("upsert file resource");

        let interaction = ResourceInteractionRecord {
            schema_version: RESOURCE_INTERACTION_SCHEMA_VERSION,
            interaction_id: "interaction-1".to_string(),
            source: "claude_code".to_string(),
            source_session_id: Some("source-1".to_string()),
            source_event_id: Some("tool-1".to_string()),
            session_id: "claudecodeapp-source-1".to_string(),
            turn_id: Some("turn-1".to_string()),
            actor_id: Some("agent-1".to_string()),
            resource_id: resource.resource_id.clone(),
            action: ResourceAction::Read,
            outcome: ResourceInteractionOutcome::Succeeded,
            occurred_at: "2026-07-14T00:00:00Z".to_string(),
            capture_method: ResourceInteractionCaptureMethod::Hook,
            attribution_precision: AttributionPrecision::Exact,
        };
        store
            .append_resource_interaction(&interaction)
            .expect("append interaction");
        store
            .append_resource_interaction(&interaction)
            .expect("repeat interaction is idempotent");
        assert_eq!(
            store
                .get_file_resource_revision(Some("repo-1"), "/different/worktree", "src/lib.rs")
                .expect("read durable revision"),
            1
        );

        let records =
            list_file_interactions(&store, Some("repo-1"), "/different/worktree", "src/lib.rs");
        assert_eq!(records, vec![interaction.clone()]);

        let mut stronger_observation = interaction.clone();
        stronger_observation.interaction_id = "interaction-stronger".to_string();
        stronger_observation.session_id = "claudecodeapp-child-1".to_string();
        stronger_observation.capture_method = ResourceInteractionCaptureMethod::Reconciled;
        store
            .append_resource_interaction(&stronger_observation)
            .expect("preserve stronger observation of the same source event");
        assert_eq!(
            list_file_interactions(&store, Some("repo-1"), "/different/worktree", "src/lib.rs",)
                .len(),
            2
        );

        let mut reconciled = interaction.clone();
        reconciled.interaction_id = "interaction-2".to_string();
        reconciled.source_event_id = Some("tool-2".to_string());
        reconciled.capture_method = ResourceInteractionCaptureMethod::Reconciled;
        store
            .append_resource_interaction(&reconciled)
            .expect("append reconciled interaction");
        assert_eq!(
            store
                .delete_reconciled_resource_interactions("claude_code", "claudecodeapp-source-1")
                .expect("delete reconciled interactions"),
            1
        );
        assert_eq!(
            store
                .delete_reconciled_resource_interactions("claude_code", "claudecodeapp-child-1")
                .expect("delete child reconciled observation"),
            1
        );
        let records =
            list_file_interactions(&store, Some("repo-1"), "/different/worktree", "src/lib.rs");
        assert_eq!(records, vec![interaction]);
        assert_eq!(
            store
                .get_file_resource_revision(Some("repo-1"), "/different/worktree", "src/lib.rs")
                .expect("read revision after inserts and deletes"),
            5
        );
    }

    #[test]
    fn file_resource_interaction_pages_keep_root_and_child_sessions_together() {
        let store = fixture_store();
        let resource = FileResourceRecord {
            schema_version: RESOURCE_INTERACTION_SCHEMA_VERSION,
            resource_id: "file-page".to_string(),
            repository_id: Some("repo-page".to_string()),
            workspace_path: "/repo/page".to_string(),
            repo_relative_path: "src/page.rs".to_string(),
            display_path: "src/page.rs".to_string(),
            path_hash: "hash-page".to_string(),
        };
        store
            .upsert_file_resource(&resource)
            .expect("upsert page resource");

        for (session_id, parent_session_id) in [
            ("root-1", None),
            ("child-1", Some("root-1")),
            ("root-2", None),
            ("root-3", None),
        ] {
            store
                .upsert_session(&SessionRecord {
                    schema_version: ORGTRACK_SCHEMA_VERSION,
                    source: "codex_app".to_string(),
                    source_session_id: session_id.to_string(),
                    session_id: session_id.to_string(),
                    title: session_id.to_string(),
                    status: None,
                    created_at: None,
                    updated_at: None,
                    completed_at: None,
                    workspace_path: Some("/repo/page".to_string()),
                    branch: None,
                    parent_session_id: parent_session_id.map(str::to_string),
                    org_member_id: None,
                    collaboration_origin: None,
                    metadata: AgentMetadata::default(),
                })
                .expect("upsert paged session");
        }

        for (interaction_id, session_id, occurred_at) in [
            ("root-1-read", "root-1", "2026-07-14T01:00:00Z"),
            ("child-1-write", "child-1", "2026-07-14T02:00:00Z"),
            ("root-2-read", "root-2", "2026-07-14T03:00:00Z"),
            ("root-3-read", "root-3", "2026-07-14T04:00:00Z"),
        ] {
            store
                .append_resource_interaction(&ResourceInteractionRecord {
                    schema_version: RESOURCE_INTERACTION_SCHEMA_VERSION,
                    interaction_id: interaction_id.to_string(),
                    source: "codex_app".to_string(),
                    source_session_id: Some(session_id.to_string()),
                    source_event_id: Some(interaction_id.to_string()),
                    session_id: session_id.to_string(),
                    turn_id: None,
                    actor_id: None,
                    resource_id: resource.resource_id.clone(),
                    action: ResourceAction::Read,
                    outcome: ResourceInteractionOutcome::Succeeded,
                    occurred_at: occurred_at.to_string(),
                    capture_method: ResourceInteractionCaptureMethod::Hook,
                    attribution_precision: AttributionPrecision::SessionOnly,
                })
                .expect("append paged interaction");
        }

        let first = store
            .list_file_resource_interactions_page(
                Some("repo-page"),
                "/different/worktree",
                "src/page.rs",
                2,
                0,
            )
            .expect("load first root page");
        assert_eq!(first.total_sessions, 3);
        assert_eq!(
            first
                .interactions
                .iter()
                .map(|record| record.session_id.as_str())
                .collect::<Vec<_>>(),
            vec!["root-3", "root-2"]
        );

        let second = store
            .list_file_resource_interactions_page(
                Some("repo-page"),
                "/different/worktree",
                "src/page.rs",
                2,
                2,
            )
            .expect("load second root page");
        assert_eq!(second.total_sessions, 3);
        assert_eq!(
            second
                .interactions
                .iter()
                .map(|record| record.session_id.as_str())
                .collect::<Vec<_>>(),
            vec!["child-1", "root-1"]
        );
    }

    #[test]
    fn recent_hook_signals_return_newest_hook_facts_with_paths() {
        let store = fixture_store();
        let resource = FileResourceRecord {
            schema_version: RESOURCE_INTERACTION_SCHEMA_VERSION,
            resource_id: "file-signal".to_string(),
            repository_id: Some("repo-1".to_string()),
            workspace_path: "/repo/worktree".to_string(),
            repo_relative_path: "src/app.rs".to_string(),
            display_path: "src/app.rs".to_string(),
            path_hash: "hash-signal".to_string(),
        };
        store
            .upsert_file_resource(&resource)
            .expect("upsert file resource");

        let base = ResourceInteractionRecord {
            schema_version: RESOURCE_INTERACTION_SCHEMA_VERSION,
            interaction_id: "sig-1".to_string(),
            source: "qwen_code".to_string(),
            source_session_id: Some("qwen-1".to_string()),
            source_event_id: Some("tool-1".to_string()),
            session_id: "qwencodeapp-qwen-1".to_string(),
            turn_id: None,
            actor_id: None,
            resource_id: resource.resource_id.clone(),
            action: ResourceAction::Read,
            outcome: ResourceInteractionOutcome::Succeeded,
            occurred_at: "2026-07-14T00:00:00Z".to_string(),
            capture_method: ResourceInteractionCaptureMethod::Hook,
            attribution_precision: AttributionPrecision::SessionOnly,
        };
        let mut newer = base.clone();
        newer.interaction_id = "sig-2".to_string();
        newer.action = ResourceAction::Write;
        newer.occurred_at = "2026-07-14T01:00:00Z".to_string();
        let mut reconciled = base.clone();
        reconciled.interaction_id = "sig-3".to_string();
        reconciled.occurred_at = "2026-07-14T02:00:00Z".to_string();
        reconciled.capture_method = ResourceInteractionCaptureMethod::Reconciled;

        for record in [&base, &newer, &reconciled] {
            store
                .append_resource_interaction(record)
                .expect("append interaction");
        }

        let signals = store
            .list_recent_hook_signals(50)
            .expect("list recent hook signals");
        // Only the two hook facts, newest first; the reconciled one is excluded.
        assert_eq!(signals.len(), 2);
        assert_eq!(signals[0].action, "write");
        assert_eq!(signals[0].occurred_at, "2026-07-14T01:00:00Z");
        assert_eq!(signals[0].file_path, "src/app.rs");
        assert_eq!(signals[0].source, "qwen_code");
        assert_eq!(signals[0].capture_method, "hook");
        assert_eq!(signals[1].action, "read");
        // No session row has been reconciled yet, so there is no human title to
        // show — the UI falls back to a shortened id.
        assert_eq!(signals[0].session_title, None);

        let session_with_title = |title: &str| SessionRecord {
            schema_version: 1,
            source: "qwen_code".to_string(),
            source_session_id: "qwen-1".to_string(),
            session_id: "qwencodeapp-qwen-1".to_string(),
            title: title.to_string(),
            status: None,
            created_at: None,
            updated_at: None,
            completed_at: None,
            workspace_path: Some("/repo/worktree".to_string()),
            branch: None,
            parent_session_id: None,
            org_member_id: None,
            collaboration_origin: None,
            metadata: AgentMetadata::default(),
        };

        // A placeholder title (equal to the raw source id) is suppressed so a
        // raw id never masquerades as a name.
        store
            .upsert_session(&session_with_title("qwen-1"))
            .expect("upsert placeholder session");
        let placeholder = store
            .list_recent_hook_signals(50)
            .expect("list recent hook signals with placeholder title");
        assert_eq!(placeholder[0].session_title, None);

        // A reconciled, human-readable title resolves through the LEFT JOIN.
        store
            .upsert_session(&session_with_title("Refactor the auth flow"))
            .expect("upsert titled session");
        let titled = store
            .list_recent_hook_signals(50)
            .expect("list recent hook signals with title");
        assert_eq!(
            titled[0].session_title.as_deref(),
            Some("Refactor the auth flow")
        );
    }

    #[test]
    fn file_resource_upsert_composes_with_outer_transaction() {
        let conn = Connection::open_in_memory().expect("in-memory sqlite");
        SqliteRecordStore::init_tables(&conn).expect("init tables");
        conn.execute_batch("BEGIN IMMEDIATE")
            .expect("begin reconciliation transaction");

        let store = SqliteRecordStore::new(&conn);
        store
            .upsert_file_resource(&FileResourceRecord {
                schema_version: RESOURCE_INTERACTION_SCHEMA_VERSION,
                resource_id: "nested-file-1".to_string(),
                repository_id: Some("repo-1".to_string()),
                workspace_path: "/repo/worktree".to_string(),
                repo_relative_path: "package.json".to_string(),
                display_path: "package.json".to_string(),
                path_hash: "nested-hash-1".to_string(),
            })
            .expect("upsert file resource inside outer transaction");
        conn.execute_batch("COMMIT")
            .expect("commit reconciliation transaction");

        let resource_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM orgtrack_core_resources WHERE resource_id = ?1",
                ["nested-file-1"],
                |row| row.get(0),
            )
            .expect("query resource row");
        let file_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM orgtrack_core_file_resources WHERE resource_id = ?1",
                ["nested-file-1"],
                |row| row.get(0),
            )
            .expect("query file resource row");
        assert_eq!((resource_count, file_count), (1, 1));
    }

    #[test]
    fn interaction_import_checkpoints_change_with_fingerprint_or_parser() {
        let store = fixture_store();
        assert!(!store
            .interaction_import_is_current("claude_code", "session-1", "fingerprint-1", 1)
            .expect("query empty checkpoint"));

        store
            .mark_interaction_imported(
                "claude_code",
                "session-1",
                "fingerprint-1",
                1,
                "2026-07-14T00:00:00Z",
            )
            .expect("mark checkpoint");

        assert!(store
            .interaction_import_is_current("claude_code", "session-1", "fingerprint-1", 1)
            .expect("query matching checkpoint"));
        assert!(!store
            .interaction_import_is_current("claude_code", "session-1", "fingerprint-2", 1)
            .expect("query changed fingerprint"));
        assert!(!store
            .interaction_import_is_current("claude_code", "session-1", "fingerprint-1", 2)
            .expect("query changed parser"));
    }
}

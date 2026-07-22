use rusqlite::{params, Connection};

use super::SqliteRecordStore;
use crate::canonical::SessionRecord;

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

impl SqliteRecordStore<'_> {
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
                cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
                cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
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
        )?;
        // Cache portion contained within `input_tokens` (which stays
        // cache-inclusive). The usage projection subtracts these to recover
        // fresh input + price cache reads at the cheaper cache rate.
        ensure_column(
            conn,
            "imported_history_session_cache",
            "cache_read_tokens",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        ensure_column(
            conn,
            "imported_history_session_cache",
            "cache_write_tokens",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        ensure_column(
            conn,
            "imported_history_session_cache",
            "listable",
            "INTEGER NOT NULL DEFAULT 1",
        )?;

        // The sidebar-order partial index filters on `listable` and
        // `parent_session_id`, both of which are added by the migrations above on
        // databases that predate them. It must therefore be created *after* the
        // `ensure_column` calls — creating it inside the initial `CREATE TABLE`
        // batch fails with "no such column: parent_session_id" on any existing
        // cache table, aborting the whole batch (and blocking session_launch).
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_imported_history_sidebar_order
                ON imported_history_session_cache(
                    source,
                    updated_at_ms DESC,
                    created_at_ms DESC,
                    source_session_id ASC
                )
                WHERE listable = 1 AND parent_session_id = '';",
        )?;

        // Per-round token usage for imported sessions (one row per assistant
        // round / LLM call), mirroring the native `session_token_usage` grain so
        // the Usage dashboard can render a per-round request log. `input_tokens`
        // is FRESH (cache excluded); the cache columns are separate.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS imported_history_round_usage (
                source             TEXT NOT NULL,
                source_session_id  TEXT NOT NULL,
                session_id         TEXT NOT NULL,
                seq                INTEGER NOT NULL,
                model              TEXT NOT NULL DEFAULT '',
                input_tokens       INTEGER NOT NULL DEFAULT 0,
                output_tokens      INTEGER NOT NULL DEFAULT 0,
                cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
                cache_write_tokens INTEGER NOT NULL DEFAULT 0,
                created_at_ms      INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (session_id, seq)
            );
            CREATE INDEX IF NOT EXISTS idx_imported_round_session
                ON imported_history_round_usage(session_id);
            CREATE INDEX IF NOT EXISTS idx_imported_round_created
                ON imported_history_round_usage(created_at_ms DESC);
            CREATE INDEX IF NOT EXISTS idx_imported_round_source
                ON imported_history_round_usage(source);",
        )?;

        // #443: compact, rebuildable replay index for external CLI histories.
        //
        // These tables intentionally live in ORGII's sessions.db rather than
        // in any provider-owned JSONL/SQLite store.  Event rows contain only
        // bounded previews and locators. Payloads that cannot be truly range
        // read (JSONL/manifest/protobuf) may have one generation-scoped,
        // rebuildable artifact; the provider transcript remains the source
        // of truth and directly addressable bodies are still read on demand.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS imported_replay_state (
                source              TEXT NOT NULL,
                source_session_id   TEXT NOT NULL,
                generation          TEXT NOT NULL,
                revision            INTEGER NOT NULL DEFAULT 0,
                parser_version      INTEGER NOT NULL,
                source_identity     TEXT NOT NULL,
                driver_cursor_json  TEXT NOT NULL DEFAULT '{}',
                indexed_size_bytes  INTEGER NOT NULL DEFAULT 0,
                indexed_mtime_ns    INTEGER NOT NULL DEFAULT 0,
                total_events        INTEGER NOT NULL DEFAULT 0,
                total_turns         INTEGER NOT NULL DEFAULT 0,
                valid               INTEGER NOT NULL DEFAULT 1,
                updated_at          TEXT NOT NULL,
                PRIMARY KEY (source, source_session_id)
            );
            CREATE INDEX IF NOT EXISTS idx_imported_replay_state_generation
                ON imported_replay_state(source, source_session_id, generation);

            CREATE TABLE IF NOT EXISTS imported_replay_turns (
                source              TEXT NOT NULL,
                source_session_id   TEXT NOT NULL,
                generation          TEXT NOT NULL,
                turn_index          INTEGER NOT NULL,
                turn_id             TEXT NOT NULL,
                start_sequence      INTEGER NOT NULL,
                end_sequence        INTEGER,
                started_at          TEXT NOT NULL,
                ended_at            TEXT,
                event_count         INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (source, source_session_id, generation, turn_index)
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_imported_replay_turn_id
                ON imported_replay_turns(source, source_session_id, generation, turn_id);

            CREATE TABLE IF NOT EXISTS imported_replay_events (
                source              TEXT NOT NULL,
                source_session_id   TEXT NOT NULL,
                generation          TEXT NOT NULL,
                sequence            INTEGER NOT NULL,
                event_id            TEXT NOT NULL,
                turn_index          INTEGER NOT NULL,
                action_type         TEXT NOT NULL,
                function_name       TEXT NOT NULL,
                created_at          TEXT NOT NULL,
                args_preview_json   TEXT NOT NULL DEFAULT '{}',
                result_preview_json TEXT NOT NULL DEFAULT '{}',
                args_size_bytes     INTEGER NOT NULL DEFAULT 0,
                result_size_bytes   INTEGER NOT NULL DEFAULT 0,
                thread_id           TEXT,
                process_id          TEXT,
                source_start        INTEGER NOT NULL DEFAULT 0,
                source_end          INTEGER NOT NULL DEFAULT 0,
                payloads_json       TEXT NOT NULL DEFAULT '[]',
                content_hash        TEXT NOT NULL,
                event_revision      INTEGER NOT NULL DEFAULT 1,
                PRIMARY KEY (source, source_session_id, generation, sequence),
                UNIQUE (source, source_session_id, generation, event_id)
            );
            CREATE INDEX IF NOT EXISTS idx_imported_replay_events_turn
                ON imported_replay_events(
                    source, source_session_id, generation, turn_index, sequence
                );

            CREATE TABLE IF NOT EXISTS imported_replay_source_rows (
                source              TEXT NOT NULL,
                source_session_id   TEXT NOT NULL,
                generation          TEXT NOT NULL,
                source_key          TEXT NOT NULL,
                content_hash        TEXT NOT NULL,
                event_id            TEXT,
                sequence            INTEGER,
                source_order        INTEGER NOT NULL,
                seen_revision       INTEGER NOT NULL,
                PRIMARY KEY (source, source_session_id, generation, source_key)
            );
            CREATE INDEX IF NOT EXISTS idx_imported_replay_source_rows_seen
                ON imported_replay_source_rows(
                    source, source_session_id, generation, seen_revision
                );

            CREATE TABLE IF NOT EXISTS imported_replay_structured_rows (
                source              TEXT NOT NULL,
                source_session_id   TEXT NOT NULL,
                generation          TEXT NOT NULL,
                source_key          TEXT NOT NULL,
                content_hash        TEXT NOT NULL,
                seen_revision       INTEGER NOT NULL,
                PRIMARY KEY (source, source_session_id, generation, source_key)
            );
            CREATE TABLE IF NOT EXISTS imported_replay_structured_events (
                source              TEXT NOT NULL,
                source_session_id   TEXT NOT NULL,
                generation          TEXT NOT NULL,
                source_key          TEXT NOT NULL,
                local_key           TEXT NOT NULL,
                event_id            TEXT NOT NULL,
                sequence            INTEGER NOT NULL,
                PRIMARY KEY (
                    source, source_session_id, generation, source_key, local_key
                )
            );
            CREATE TABLE IF NOT EXISTS imported_replay_payload_artifacts (
                source              TEXT NOT NULL,
                source_session_id   TEXT NOT NULL,
                generation          TEXT NOT NULL,
                content_hash        TEXT NOT NULL,
                payload             BLOB NOT NULL,
                PRIMARY KEY (
                    source, source_session_id, generation, content_hash
                )
            );
            CREATE TABLE IF NOT EXISTS imported_replay_payload_artifact_refs (
                source              TEXT NOT NULL,
                source_session_id   TEXT NOT NULL,
                generation          TEXT NOT NULL,
                event_id            TEXT NOT NULL,
                field_path          TEXT NOT NULL,
                content_hash        TEXT NOT NULL,
                PRIMARY KEY (
                    source, source_session_id, generation, event_id, field_path
                )
            );

            CREATE TABLE IF NOT EXISTS imported_replay_changes (
                source              TEXT NOT NULL,
                source_session_id   TEXT NOT NULL,
                generation          TEXT NOT NULL,
                change_revision     INTEGER NOT NULL,
                event_id            TEXT NOT NULL,
                change_kind         TEXT NOT NULL,
                sequence            INTEGER,
                PRIMARY KEY(source, source_session_id, generation, change_revision)
            );
            CREATE INDEX IF NOT EXISTS idx_imported_replay_changes_event
                ON imported_replay_changes(
                    source, source_session_id, generation, event_id
                );",
        )?;
        ensure_column(
            conn,
            "imported_replay_events",
            "event_revision",
            "INTEGER NOT NULL DEFAULT 1",
        )
    }
}

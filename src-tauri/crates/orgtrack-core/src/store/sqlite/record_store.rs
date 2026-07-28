use rusqlite::{params, OptionalExtension};

use super::support::with_file_resource_savepoint;
use super::SqliteRecordStore;
use crate::canonical::{
    ActivityRecord, CommitLinkRecord, FileChangeRecord, FileResourceRecord,
    ResourceInteractionRecord, ScanCheckpoint, SessionActorRecord,
    SessionCheckpointFileStateRecord, SessionCheckpointRecord, SessionDiffChunkRecord,
    SessionEditArtifactRecord, SessionFinalDiffRecord, SessionRecord,
};
use crate::store::{FileResourceInteractionPage, RecordStore};

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

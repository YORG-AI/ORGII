use rusqlite::params;

use super::SqliteRecordStore;
use crate::store::RecentHookSignal;

impl SqliteRecordStore<'_> {
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
}

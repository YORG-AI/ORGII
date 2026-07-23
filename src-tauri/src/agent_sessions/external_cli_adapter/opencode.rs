use database::db::get_connection;
use orgtrack_core::sources::imported_history::replay::{
    self, ImportedHistorySourceId, ReplayLimits,
};
use rusqlite::{Connection, OptionalExtension};

use crate::agent_sessions::event_pipeline::ingestion::prompt_backfill;
use crate::agent_sessions::external_cli_adapter::ExternalCliAdapter;

pub const OPENCODE_SOURCE: &str = "opencode";
pub const OPENCODE_CLI_AGENT_TYPE: &str = "opencode";
pub const OPENCODE_IMPORTED_SESSION_PREFIX: &str = "opencodeapp-";

pub static OPENCODE_ADAPTER: OpenCodeAdapter = OpenCodeAdapter;

pub struct OpenCodeAdapter;

impl OpenCodeAdapter {
    fn resolve_subagent_prompt_from_replay(&self, child_session_id: &str) -> Option<String> {
        let _writer = database::db::sessions_writer_guard();
        let mut conn = get_connection().ok()?;
        let batch = replay::scan_window_after(
            &mut conn,
            ImportedHistorySourceId::OpenCode,
            child_session_id,
            -1,
            ReplayLimits {
                max_turns: 1,
                max_events: 32,
                max_ipc_bytes: 256 * 1024,
            },
        )
        .ok()?;
        let chunks = batch
            .chunks
            .into_iter()
            .map(|indexed| indexed.chunk)
            .collect::<Vec<_>>();
        prompt_backfill::prompt_from_history_chunks(&chunks)
    }

    fn resolve_subagent_prompt_from_conn(
        &self,
        conn: &Connection,
        child_session_id: &str,
    ) -> Option<String> {
        if let Ok(Some(prompt)) = conn
            .query_row(
                "SELECT user_input FROM code_sessions WHERE session_id = ?1 AND cli_agent_type = 'opencode'",
                [child_session_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
        {
            if let Some(prompt) = prompt_backfill::non_generic_subagent_prompt(prompt) {
                return Some(prompt);
            }
        }

        if let Ok(Some(name)) = conn
            .query_row(
                "SELECT name FROM imported_history_session_cache WHERE session_id = ?1 AND source = 'opencode'",
                [child_session_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
        {
            if let Some(name) = prompt_backfill::non_generic_subagent_prompt(name) {
                return Some(name);
            }
        }

        None
    }

    fn imported_parent_session_id_from_conn(
        &self,
        conn: &Connection,
        managed_parent_session_id: &str,
    ) -> Result<Option<String>, String> {
        match conn.query_row(
            "SELECT cli_session_id FROM code_sessions WHERE session_id = ?1 AND cli_agent_type = 'opencode'",
            [managed_parent_session_id],
            |row| row.get::<_, Option<String>>(0),
        ) {
            Ok(Some(cli_session_id)) if !cli_session_id.trim().is_empty() => Ok(Some(
                self.imported_session_id_from_native(cli_session_id.trim()),
            )),
            Ok(_) | Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(err) => Err(format!(
                "Failed to query OpenCode CLI session id for {managed_parent_session_id}: {err}"
            )),
        }
    }
}

impl ExternalCliAdapter for OpenCodeAdapter {
    fn source(&self) -> &'static str {
        OPENCODE_SOURCE
    }

    fn cli_agent_type(&self) -> &'static str {
        OPENCODE_CLI_AGENT_TYPE
    }

    fn imported_session_prefix(&self) -> &'static str {
        OPENCODE_IMPORTED_SESSION_PREFIX
    }

    fn matches_imported_session(&self, session_id: &str) -> bool {
        session_id.starts_with(self.imported_session_prefix())
    }

    fn imported_session_id_from_native(&self, native_session_id: &str) -> String {
        format!("{}{}", self.imported_session_prefix(), native_session_id)
    }

    fn native_session_id_from_imported<'a>(&self, imported_session_id: &'a str) -> Option<&'a str> {
        imported_session_id.strip_prefix(self.imported_session_prefix())
    }

    fn resolve_subagent_prompt(&self, child_session_id: &str) -> Option<String> {
        if !self.matches_imported_session(child_session_id) {
            return None;
        }
        if let Some(prompt) = self.resolve_subagent_prompt_from_replay(child_session_id) {
            return Some(prompt);
        }
        let conn = get_connection().ok()?;
        self.resolve_subagent_prompt_from_conn(&conn, child_session_id)
    }

    fn imported_parent_session_id(
        &self,
        managed_parent_session_id: &str,
    ) -> Result<Option<String>, String> {
        if self.matches_imported_session(managed_parent_session_id) {
            return Ok(None);
        }
        let conn =
            get_connection().map_err(|err| format!("Failed to open CLI session DB: {err}"))?;
        self.imported_parent_session_id_from_conn(&conn, managed_parent_session_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("open fixture db");
        conn.execute_batch(
            "CREATE TABLE code_sessions (
                session_id TEXT PRIMARY KEY,
                cli_agent_type TEXT,
                cli_session_id TEXT,
                user_input TEXT
            );
            CREATE TABLE imported_history_session_cache (
                session_id TEXT PRIMARY KEY,
                source TEXT,
                name TEXT
            );",
        )
        .expect("create fixture schema");
        conn
    }

    #[test]
    fn matches_and_converts_opencode_imported_session_ids() {
        let adapter = OpenCodeAdapter;

        assert!(adapter.matches_imported_session("opencodeapp-ses_123"));
        assert!(!adapter.matches_imported_session("cliagent-123"));
        assert_eq!(
            adapter.native_session_id_from_imported("opencodeapp-ses_123"),
            Some("ses_123")
        );
        assert_eq!(
            adapter.imported_session_id_from_native("ses_123"),
            "opencodeapp-ses_123"
        );
    }

    #[test]
    fn imported_parent_session_id_uses_managed_cli_session_id() {
        let conn = fixture_conn();
        conn.execute(
            "INSERT INTO code_sessions (session_id, cli_agent_type, cli_session_id, user_input)
             VALUES (?1, ?2, ?3, ?4)",
            ("cliagent-parent", "opencode", "ses_parent", "Parent prompt"),
        )
        .expect("insert managed session");

        let adapter = OpenCodeAdapter;
        let imported_parent = adapter
            .imported_parent_session_id_from_conn(&conn, "cliagent-parent")
            .expect("resolve imported parent");

        assert_eq!(imported_parent.as_deref(), Some("opencodeapp-ses_parent"));
    }

    #[test]
    fn imported_parent_session_id_ignores_empty_or_non_opencode_cli_session_id() {
        let conn = fixture_conn();
        conn.execute(
            "INSERT INTO code_sessions (session_id, cli_agent_type, cli_session_id, user_input)
             VALUES (?1, ?2, ?3, ?4), (?5, ?6, ?7, ?8)",
            (
                "cliagent-empty",
                "opencode",
                "",
                "Prompt",
                "cliagent-codex",
                "codex",
                "ses_codex",
                "Prompt",
            ),
        )
        .expect("insert sessions");

        let adapter = OpenCodeAdapter;

        assert_eq!(
            adapter
                .imported_parent_session_id_from_conn(&conn, "cliagent-empty")
                .expect("resolve empty"),
            None
        );
        assert_eq!(
            adapter
                .imported_parent_session_id_from_conn(&conn, "cliagent-codex")
                .expect("resolve codex"),
            None
        );
    }

    #[test]
    fn resolve_subagent_prompt_from_conn_prefers_user_input_over_imported_name() {
        let conn = fixture_conn();
        conn.execute(
            "INSERT INTO code_sessions (session_id, cli_agent_type, cli_session_id, user_input)
             VALUES (?1, ?2, ?3, ?4)",
            (
                "opencodeapp-ses_child",
                "opencode",
                "ses_child",
                "Review the auth module for edge cases",
            ),
        )
        .expect("insert child session");
        conn.execute(
            "INSERT INTO imported_history_session_cache (session_id, source, name)
             VALUES (?1, ?2, ?3)",
            ("opencodeapp-ses_child", "opencode", "Generic Subagent"),
        )
        .expect("insert imported name");

        let adapter = OpenCodeAdapter;
        let prompt = adapter
            .resolve_subagent_prompt_from_conn(&conn, "opencodeapp-ses_child")
            .expect("prompt");

        assert_eq!(prompt, "Review the auth module for edge cases");
    }

    #[test]
    fn resolve_subagent_prompt_from_conn_uses_non_generic_imported_name_fallback() {
        let conn = fixture_conn();
        conn.execute(
            "INSERT INTO imported_history_session_cache (session_id, source, name)
             VALUES (?1, ?2, ?3)",
            (
                "opencodeapp-ses_child",
                "opencode",
                "Summarize database migration risks",
            ),
        )
        .expect("insert imported name");

        let adapter = OpenCodeAdapter;
        let prompt = adapter
            .resolve_subagent_prompt_from_conn(&conn, "opencodeapp-ses_child")
            .expect("prompt");

        assert_eq!(prompt, "Summarize database migration risks");
    }
}

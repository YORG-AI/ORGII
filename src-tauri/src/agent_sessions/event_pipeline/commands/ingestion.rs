//! Ingestion Pipeline Commands
//!
//! Raw chunk ingestion: consolidate → normalize → merge tool calls → store.


use crate::agent_sessions::event_pipeline::ingestion;
use crate::agent_sessions::event_pipeline::ingestion::types::{IngestionResult, RawActivityChunk};
use crate::agent_sessions::event_pipeline::types::SessionEvent;


/// Process raw activity chunks through the full pipeline (consolidate → normalize →
/// merge tool calls) WITHOUT storing in the EventStore.
#[tauri::command]
pub async fn es_process_chunks(
    session_id: String,
    chunks: Vec<RawActivityChunk>,
) -> Result<IngestionResult, String> {
    process_chunks_with_external_replays(chunks, session_id).await
}

/// Normalize a single raw chunk without consolidation (for streaming path).
#[tauri::command]
pub async fn es_normalize_chunk(
    session_id: String,
    chunk: RawActivityChunk,
) -> Result<SessionEvent, String> {
    tokio::task::spawn_blocking(move || {
        let mut event = ingestion::normalize_single(&chunk, &session_id);
        agent_core::tools::impls::coding::exec::external_replay::persist_external_shell_replays(
            std::slice::from_mut(&mut event),
        );
        event
    })
    .await
    .map_err(|err| format!("normalize external activity chunk: {err}"))
}

async fn process_chunks_with_external_replays(
    chunks: Vec<RawActivityChunk>,
    session_id: String,
) -> Result<IngestionResult, String> {
    tokio::task::spawn_blocking(move || {
        let mut result = ingestion::ingest_raw_chunks(&chunks, &session_id);
        agent_core::tools::impls::coding::exec::external_replay::persist_external_shell_replays(
            &mut result.events,
        );
        result
    })
    .await
    .map_err(|err| format!("process external activity chunks: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_sessions::event_pipeline::store::EventStore;
    use core_types::session_event::ShellReplayStatus;

    #[tokio::test]
    async fn external_cli_shell_survives_parser_to_event_store_compaction() {
        let _sandbox = test_helpers::test_env::sandbox();
        let conn = database::db::get_connection().expect("test database");
        database::init_shell_replay_tables(&conn).expect("shell replay schema");

        let output = format!("EXTERNAL_HEAD\n{}\nEXTERNAL_TAIL", "x".repeat(96 * 1024));
        let expected_bytes = output.len() as u64;
        let chunks = vec![RawActivityChunk {
            chunk_id: Some("external-shell-result".to_string()),
            action_type: Some("tool_result".to_string()),
            function: Some("Bash".to_string()),
            args: Some(serde_json::json!({"command": "emit external"})),
            result: Some(serde_json::json!({"stdout": output, "exit_code": 0})),
            created_at: Some("2026-07-19T12:00:00Z".to_string()),
            call_id: Some("external-shell-call".to_string()),
            ..Default::default()
        }];

        let result =
            process_chunks_with_external_replays(chunks, "external-shell-session".to_string())
                .await
                .expect("ingestion succeeds");
        assert_eq!(result.events.len(), 1);
        assert_eq!(
            result.events[0].ui_canonical,
            core_types::tool_names::RUN_SHELL
        );
        assert_eq!(
            result.events[0]
                .shell_replay
                .as_ref()
                .expect("replay created before EventStore")
                .bookmark
                .visible_bytes,
            expected_bytes
        );

        let event_id = result.events[0].id.clone();
        let mut store = EventStore::new();
        store.append(result.events);
        let stored = store.get_by_id(&event_id).expect("stored event");
        let replay = stored.shell_replay.as_ref().expect("replay retained");
        assert_eq!(replay.status, ShellReplayStatus::Complete);
        assert_eq!(replay.bookmark.visible_bytes, expected_bytes);
        assert!(replay.terminal_preview.ends_with("EXTERNAL_TAIL"));
        assert!(stored.result.get("stdout").is_none());
    }
}

use std::io::Read;

use flate2::read::GzDecoder;

use super::*;

fn event(id: &str, session_id: &str, content: &str) -> SessionEvent {
    ingestion::normalize_single(
        &RawActivityChunk {
            chunk_id: Some(id.to_string()),
            session_id: Some(session_id.to_string()),
            action_type: Some("assistant".to_string()),
            function: Some("assistant".to_string()),
            result: Some(serde_json::json!({"content":content})),
            created_at: Some("2026-07-22T00:00:00Z".to_string()),
            ..RawActivityChunk::default()
        },
        session_id,
    )
}

mod cloud;
mod collaboration;
mod managed_chunks;
mod shell;
mod window_export;

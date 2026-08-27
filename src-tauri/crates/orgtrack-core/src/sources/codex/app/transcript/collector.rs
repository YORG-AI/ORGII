use std::collections::VecDeque;

use core_types::activity::ActivityChunk;
use serde_json::{json, Value};

use crate::projectors::turn_metadata::{project_activity_chunks, ProjectedTurnMetadata};
use crate::sources::imported_history;

use super::cache::{
    bounded_codex_turn_preview, CodexTurnOffset, CODEX_INITIAL_TURN_LIMIT,
    CODEX_TURN_OFFSET_LIMIT_PER_SESSION,
};

pub(super) enum CodexTranscriptCollectionMode<'a> {
    Full,
    Initial { recent_turn_count: usize },
    Turn { turn_id: &'a str },
    FirstTurn,
}

struct CompletedCodexTurn {
    chunks: Vec<ActivityChunk>,
    summary: ProjectedTurnMetadata,
    next_turn_id: Option<String>,
}

pub(super) struct CodexTranscriptCollector<'a> {
    session_id: &'a str,
    mode: CodexTranscriptCollectionMode<'a>,
    output: Vec<ActivityChunk>,
    pub(super) current: Vec<ActivityChunk>,
    compacted: VecDeque<Vec<ActivityChunk>>,
    recent: VecDeque<CompletedCodexTurn>,
    turns: VecDeque<ProjectedTurnMetadata>,
    turn_offsets: VecDeque<CodexTurnOffset>,
    selected_turn_found: bool,
}

impl<'a> CodexTranscriptCollector<'a> {
    pub(super) fn new(session_id: &'a str, mode: CodexTranscriptCollectionMode<'a>) -> Self {
        Self {
            session_id,
            mode,
            output: Vec::new(),
            current: Vec::new(),
            compacted: VecDeque::new(),
            recent: VecDeque::new(),
            turns: VecDeque::new(),
            turn_offsets: VecDeque::new(),
            selected_turn_found: false,
        }
    }

    pub(super) fn record_turn_offset(
        &mut self,
        turn_id: String,
        byte_offset: u64,
        sequence: usize,
    ) {
        if self.turn_offsets.len() >= CODEX_TURN_OFFSET_LIMIT_PER_SESSION {
            self.turn_offsets.pop_front();
        }
        self.turn_offsets.push_back(CodexTurnOffset {
            turn_id,
            byte_offset,
            sequence,
        });
    }

    pub(super) fn start_turn(&mut self, user_chunk: ActivityChunk) -> bool {
        if self.current.iter().any(is_codex_user_chunk) {
            self.finish_current(Some(user_chunk.chunk_id.clone()));
            if self.selected_turn_found {
                return true;
            }
        }
        self.current.push(user_chunk);
        false
    }

    fn finish_current(&mut self, next_turn_id: Option<String>) {
        let Some(user_chunk) = self.current.iter().find(|chunk| is_codex_user_chunk(chunk)) else {
            if matches!(self.mode, CodexTranscriptCollectionMode::Full) {
                self.output.append(&mut self.current);
            }
            return;
        };
        let turn_id = user_chunk.chunk_id.clone();
        match &self.mode {
            CodexTranscriptCollectionMode::Full => {
                self.output.append(&mut self.current);
                return;
            }
            CodexTranscriptCollectionMode::Turn {
                turn_id: requested_turn_id,
            } => {
                if turn_id == *requested_turn_id {
                    self.output.append(&mut self.current);
                    self.selected_turn_found = true;
                } else {
                    self.current.clear();
                }
                return;
            }
            CodexTranscriptCollectionMode::FirstTurn => {
                self.output.append(&mut self.current);
                self.selected_turn_found = true;
                return;
            }
            CodexTranscriptCollectionMode::Initial { .. } => {}
        }

        let mut summary = project_activity_chunks(&self.current)
            .into_iter()
            .next()
            .unwrap_or_else(|| ProjectedTurnMetadata {
                turn_id: turn_id.clone(),
                start_sequence: codex_sequence_from_chunk_id(&turn_id).unwrap_or_default(),
                started_at: user_chunk.created_at.clone(),
                ended_at: Some(user_chunk.created_at.clone()),
                status: "completed".to_string(),
                user_preview: String::new(),
                event_count: 1,
                body_event_count: 0,
                modified_files: Vec::new(),
                resource_interactions: Vec::new(),
                git_artifacts: Vec::new(),
            });
        if let Some(sequence) = codex_sequence_from_chunk_id(&turn_id) {
            summary.start_sequence = sequence;
        }

        let CodexTranscriptCollectionMode::Initial { recent_turn_count } = &self.mode else {
            unreachable!("full and selected-turn modes returned above");
        };
        let recent_turn_count = (*recent_turn_count).clamp(1, CODEX_INITIAL_TURN_LIMIT);
        if self.turns.len() >= CODEX_INITIAL_TURN_LIMIT {
            self.turns.pop_front();
        }
        self.turns.push_back(summary.clone());
        self.recent.push_back(CompletedCodexTurn {
            chunks: std::mem::take(&mut self.current),
            summary,
            next_turn_id,
        });
        while self.recent.len() > recent_turn_count {
            if let Some(completed) = self.recent.pop_front() {
                self.compact_completed_turn(completed);
            }
        }
    }

    fn compact_completed_turn(&mut self, completed: CompletedCodexTurn) {
        let last_agent_preview = last_assistant_preview_from_chunks(&completed.chunks);
        if let Some(user_chunk) = completed.chunks.into_iter().find(is_codex_user_chunk) {
            let compacted_limit = match &self.mode {
                CodexTranscriptCollectionMode::Initial { recent_turn_count } => {
                    CODEX_INITIAL_TURN_LIMIT
                        .saturating_sub((*recent_turn_count).clamp(1, CODEX_INITIAL_TURN_LIMIT))
                }
                _ => 0,
            };
            if compacted_limit == 0 {
                return;
            }
            if self.compacted.len() >= compacted_limit {
                self.compacted.pop_front();
            }
            self.compacted.push_back(vec![
                user_chunk,
                build_unloaded_turn_placeholder_chunk(
                    self.session_id,
                    &completed.summary,
                    completed.next_turn_id,
                    last_agent_preview.as_deref(),
                ),
            ]);
        }
    }

    pub(super) fn finish(
        mut self,
    ) -> (
        Vec<ActivityChunk>,
        Vec<ProjectedTurnMetadata>,
        Vec<CodexTurnOffset>,
    ) {
        self.finish_current(None);
        while let Some(compacted) = self.compacted.pop_front() {
            self.output.extend(compacted);
        }
        while let Some(completed) = self.recent.pop_front() {
            self.output.extend(completed.chunks);
        }
        (
            self.output,
            self.turns.into_iter().collect(),
            self.turn_offsets.into_iter().collect(),
        )
    }
}

fn is_codex_user_chunk(chunk: &ActivityChunk) -> bool {
    chunk.function == imported_history::FUNCTION_USER_MESSAGE
}

fn last_assistant_preview_from_chunks(chunks: &[ActivityChunk]) -> Option<String> {
    chunks.iter().rev().find_map(|chunk| {
        if chunk.function != imported_history::FUNCTION_ASSISTANT {
            return None;
        }
        chunk
            .result
            .get("observation")
            .or_else(|| chunk.result.get("content"))
            .and_then(Value::as_str)
            .filter(|message| !message.trim().is_empty())
            .map(bounded_codex_turn_preview)
    })
}

fn codex_sequence_from_chunk_id(chunk_id: &str) -> Option<i64> {
    chunk_id.rsplit('-').next()?.parse().ok()
}

pub(super) fn build_unloaded_turn_placeholder_chunk(
    session_id: &str,
    turn: &ProjectedTurnMetadata,
    next_turn_id: Option<String>,
    last_agent_preview: Option<&str>,
) -> ActivityChunk {
    let internal_placeholder = format!("Codex turn {} is not loaded yet.", turn.turn_id);
    let display_content = last_agent_preview.unwrap_or(&internal_placeholder);
    let mut chunk = ActivityChunk::new(session_id, "assistant", "assistant");
    chunk.chunk_id = format!("codex-unloaded-turn-{}", turn.turn_id);
    chunk.created_at = turn
        .ended_at
        .clone()
        .unwrap_or_else(|| turn.started_at.clone());
    if last_agent_preview.is_some() {
        chunk.args = json!({ "turnPreviewOnly": true });
    }
    chunk.result = json!({
        "observation": display_content,
        "content": display_content,
        "role": "assistant",
        "is_delta": false,
        "is_full_content": true,
        "unloadedTurn": {
            "turnId": turn.turn_id,
            "nextTurnId": next_turn_id,
            "startedAt": turn.started_at,
            "endedAt": turn.ended_at,
            "durationMs": Value::Null,
            "eventCount": turn.event_count,
            "bodyEventCount": turn.body_event_count,
        },
    });
    chunk
}

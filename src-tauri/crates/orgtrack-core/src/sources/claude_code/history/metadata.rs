use std::collections::{BTreeSet, HashSet, VecDeque};

use serde::{Deserialize, Serialize};

use std::path::Path;

use crate::sources::imported_history::{
    self, cache as imported_cache, client_origin,
    metadata::{
        ImportedHistoryCacheInput, ImportedHistoryDiscoveredRecord, ImportedHistoryImpactStats,
        StoredRoundUsage, SOURCE_CLAUDE_CODE,
    },
    watermark::{ImportedParseWatermark, WatermarkedTranscriptReader},
};

#[cfg(test)]
use super::discovery::claude_session_title_for_record;
use super::replay::{claude_content_items, claude_content_text};
use super::tools::{collect_claude_impact_from_item, collect_claude_impact_from_tool_result};
use super::types::{is_harness_injected_user_line, ClaudeCodeHistoryMeta, ClaudeJsonlLine};
use super::{
    CLAUDE_CODE_METADATA_PARSER_VERSION, CLAUDE_CODE_SESSION_PREFIX, MAX_COMPACT_BOUNDARY_MARKERS,
};

/// Resumable accumulator for one transcript's meta scan. Every field is
/// exactly the per-file state the old single-pass loop kept in locals, so it
/// can be frozen into a parse watermark's `state_json` at a complete-line
/// boundary and resumed against only the appended suffix.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct ClaudeSessionMetaState {
    created_at_ms: i64,
    updated_at_ms: i64,
    /// First transcript `summary` title; the fresh sessions-dir title
    /// (external, re-read each parse) still wins.
    summary_title: String,
    ai_title: String,
    custom_title: String,
    first_prompt: String,
    model: Option<String>,
    repo_path: Option<String>,
    branch: Option<String>,
    /// Client surface that wrote the transcript, from the records' own
    /// `entrypoint`. First non-empty value wins.
    #[serde(default)]
    entrypoint: String,
    input_tokens: i64,
    output_tokens: i64,
    cache_read_tokens: i64,
    cache_write_tokens: i64,
    rounds: Vec<StoredRoundUsage>,
    // One API response spans several assistant lines that repeat the same
    // `usage`; count each `message.id` once.
    seen_message_ids: HashSet<String>,
    // Primary impact source: exact counts from tool_use_result.structuredPatch.
    impact: ImportedHistoryImpactStats,
    touched_files: BTreeSet<String>,
    // Fallback for transcripts old enough to lack structuredPatch: the coarse
    // old_string/new_string line count. Only used when no patch data is found.
    fallback_impact: ImportedHistoryImpactStats,
    fallback_touched: BTreeSet<String>,
    // Subagent transcripts (`<parent-uuid>/subagents/agent-*.jsonl`) tag every
    // line `isSidechain: true` and carry the spawning session's UUID in
    // `sessionId`. Capturing it lets us subsume the child under its parent the
    // same way Codex does, instead of listing it as a top-level session.
    parent_source_session_id: Option<String>,
    first_user_uuid: Option<String>,
    /// Keep the newest compact boundaries; the first-user marker consumes the
    /// remaining slot in the 64-marker cache metadata budget.
    compact_boundary_uuids: VecDeque<String>,
}

impl ClaudeSessionMetaState {
    fn feed(&mut self, trimmed: &str, record: &ImportedHistoryDiscoveredRecord) {
        let parsed: ClaudeJsonlLine = match serde_json::from_str(trimmed) {
            Ok(parsed) => parsed,
            Err(_) => return,
        };
        if self.entrypoint.is_empty() && !parsed.entrypoint.trim().is_empty() {
            self.entrypoint = parsed.entrypoint.trim().to_string();
        }
        let line_ms = parsed
            .timestamp
            .as_deref()
            .and_then(imported_history::parse_iso_to_epoch_ms_opt)
            .unwrap_or(0);
        if let Some(timestamp) = parsed
            .timestamp
            .as_deref()
            .and_then(imported_history::parse_iso_to_epoch_ms_opt)
        {
            if self.created_at_ms == 0 || timestamp < self.created_at_ms {
                self.created_at_ms = timestamp;
            }
            if timestamp > self.updated_at_ms {
                self.updated_at_ms = timestamp;
            }
        }
        if self.repo_path.is_none() && !parsed.cwd.trim().is_empty() {
            self.repo_path = Some(parsed.cwd.clone());
        }
        if self.branch.is_none() && !parsed.git_branch.trim().is_empty() {
            self.branch = Some(parsed.git_branch.clone());
        }
        // A sidechain line whose `sessionId` differs from this file's own stem
        // is a subagent pointing at its spawning session. Guard against a self
        // reference so a malformed line can never make a session its own parent.
        if self.parent_source_session_id.is_none() && parsed.is_sidechain {
            let candidate = parsed.session_id.trim();
            if !candidate.is_empty() && candidate != record.source_session_id {
                self.parent_source_session_id = Some(candidate.to_string());
            }
        }
        // Claude Code persists the session title inside the transcript. Titles are
        // re-emitted as the conversation evolves, so the last write wins.
        match parsed.r#type.as_str() {
            "summary" if self.summary_title.is_empty() => {
                let summary = parsed.summary.trim();
                if !summary.is_empty() {
                    self.summary_title = imported_history::truncate_name(summary, 200);
                }
            }
            "ai-title" => {
                let title = parsed.ai_title.trim();
                if !title.is_empty() {
                    self.ai_title = imported_history::truncate_name(title, 200);
                }
            }
            "custom-title" => {
                let title = parsed.custom_title.trim();
                if !title.is_empty() {
                    self.custom_title = imported_history::truncate_name(title, 200);
                }
            }
            _ => {}
        }
        // Exact diff stats come from the tool-result's structuredPatch.
        if let Some(result) = parsed.tool_use_result.as_ref() {
            collect_claude_impact_from_tool_result(
                result,
                &mut self.impact,
                &mut self.touched_files,
            );
        }
        if self.first_user_uuid.is_none()
            && parsed.r#type == "user"
            && !parsed.uuid.trim().is_empty()
        {
            self.first_user_uuid = Some(parsed.uuid.trim().to_string());
        }
        if parsed.r#type == "system"
            && parsed.subtype == "compact_boundary"
            && !parsed.uuid.trim().is_empty()
        {
            let marker = parsed.uuid.trim();
            if !self
                .compact_boundary_uuids
                .iter()
                .any(|existing| existing == marker)
            {
                if self.compact_boundary_uuids.len() >= MAX_COMPACT_BOUNDARY_MARKERS {
                    self.compact_boundary_uuids.pop_front();
                }
                self.compact_boundary_uuids.push_back(marker.to_string());
            }
        }
        let harness_injected = is_harness_injected_user_line(&parsed);
        if let Some(message) = parsed.message {
            if self.first_prompt.is_empty() && parsed.r#type == "user" && !harness_injected {
                if let Some(text) = claude_content_text(&message.content) {
                    // GUI-launched runs prefix the first prompt with the
                    // exec-mode briefing; bridge-only text is no title
                    // candidate at all.
                    let text = imported_history::strip_orgii_exec_mode_bridge(&text);
                    if !text.trim().is_empty() {
                        self.first_prompt = imported_history::truncate_name(text, 200);
                    }
                }
            }
            if self.model.is_none()
                && !message.model.trim().is_empty()
                && !message.model.starts_with('<')
            {
                self.model = Some(message.model.clone());
            }
            if parsed.r#type == "assistant" {
                for item in claude_content_items(&message.content) {
                    collect_claude_impact_from_item(
                        item,
                        &mut self.fallback_impact,
                        &mut self.fallback_touched,
                    );
                }
            }
            // Skip repeated lines of the same API response (same message.id),
            // which would otherwise triple both totals and rounds.
            let usage_is_new =
                message.id.is_empty() || self.seen_message_ids.insert(message.id.clone());
            if let Some(usage) = message.usage.filter(|_| usage_is_new) {
                // input_tokens stays cache-inclusive (fresh + both cache kinds);
                // the cache portion is tracked separately for the cost split.
                self.input_tokens += usage.input_tokens
                    + usage.cache_read_input_tokens
                    + usage.cache_creation_input_tokens;
                self.output_tokens += usage.output_tokens;
                self.cache_read_tokens += usage.cache_read_input_tokens;
                self.cache_write_tokens += usage.cache_creation_input_tokens;
                // One round per assistant message that reports usage. `input`
                // here is FRESH (round convention), cache tracked separately.
                if usage.input_tokens > 0
                    || usage.output_tokens > 0
                    || usage.cache_read_input_tokens > 0
                    || usage.cache_creation_input_tokens > 0
                {
                    self.rounds.push(StoredRoundUsage {
                        seq: self.rounds.len() as i64,
                        model: self.model.clone(),
                        input_tokens: usage.input_tokens,
                        output_tokens: usage.output_tokens,
                        cache_read_tokens: usage.cache_read_input_tokens,
                        cache_write_tokens: usage.cache_creation_input_tokens,
                        created_at_ms: line_ms,
                    });
                }
            }
        }
    }

    fn finish(
        mut self,
        record: &ImportedHistoryDiscoveredRecord,
        external_title: String,
    ) -> Option<ClaudeCodeHistoryMeta> {
        // Prefer the precise structuredPatch counts; fall back to the coarse
        // old_string/new_string heuristic only when no patch data was present.
        if self.touched_files.is_empty()
            && self.impact.lines_added == 0
            && self.impact.lines_removed == 0
        {
            self.impact = self.fallback_impact;
            self.touched_files = self.fallback_touched;
        }
        self.impact.touched_files = self.touched_files.into_iter().collect();
        self.impact.files_changed = self.impact.touched_files.len() as i64;

        if self.created_at_ms == 0 && record.source_mtime_ms == 0 {
            return None;
        }

        let derived_title = if external_title.is_empty() {
            self.summary_title
        } else {
            external_title
        };
        let session_id = super::super::canonical_session_id(&record.source_session_id);
        let rounds = self
            .rounds
            .into_iter()
            .map(|round| {
                round.into_round_usage(SOURCE_CLAUDE_CODE, &record.source_session_id, &session_id)
            })
            .collect();
        Some(ClaudeCodeHistoryMeta {
            entrypoint: self.entrypoint,
            source_session_id: record.source_session_id.clone(),
            session_id,
            source_path: record.source_path.to_string_lossy().to_string(),
            source_record_key: record.source_record_key.clone(),
            source_mtime_ms: record.source_mtime_ms,
            source_size_bytes: record.source_size_bytes,
            source_fingerprint: record.source_fingerprint.clone(),
            // Mirror the Claude Code app's own precedence: a user-set custom title
            // wins, then the AI-generated title, then the derived/summary title,
            // then the first prompt, and finally the raw session id.
            name: if !self.custom_title.is_empty() {
                self.custom_title
            } else if !self.ai_title.is_empty() {
                self.ai_title
            } else if !derived_title.is_empty() {
                derived_title
            } else if !self.first_prompt.is_empty() {
                self.first_prompt
            } else {
                record.source_record_key.clone()
            },
            created_at_ms: if self.created_at_ms > 0 {
                self.created_at_ms
            } else {
                record.source_mtime_ms
            },
            updated_at_ms: if self.updated_at_ms > 0 {
                self.updated_at_ms
            } else {
                record.source_mtime_ms
            },
            model: self.model,
            repo_path: self.repo_path,
            branch: self.branch,
            input_tokens: self.input_tokens,
            output_tokens: self.output_tokens,
            cache_read_tokens: self.cache_read_tokens,
            cache_write_tokens: self.cache_write_tokens,
            rounds,
            impact: self.impact,
            parent_session_id: self
                .parent_source_session_id
                .map(|uuid| format!("{CLAUDE_CODE_SESSION_PREFIX}{uuid}")),
            first_user_uuid: self.first_user_uuid,
            continuation_markers: self.compact_boundary_uuids.into_iter().collect(),
        })
    }
}

pub(super) struct ClaudeSessionMetaParse {
    pub(super) meta: Option<ClaudeCodeHistoryMeta>,
    pub(super) watermark: ImportedParseWatermark,
    #[cfg_attr(not(test), allow(dead_code))]
    pub(super) resumed: bool,
}

pub(super) fn parse_claude_session_meta_with_title(
    record: &ImportedHistoryDiscoveredRecord,
    watermark: Option<&ImportedParseWatermark>,
    external_title: String,
) -> Result<ClaudeSessionMetaParse, String> {
    let mut reader = WatermarkedTranscriptReader::open(
        &record.source_path,
        "Claude",
        watermark,
        CLAUDE_CODE_METADATA_PARSER_VERSION,
        record.source_mtime_ms,
        record.source_size_bytes,
    )?;
    let mut state = ClaudeSessionMetaState::default();
    let mut resumed = false;
    if let Some(state_json) = reader.resume_state_json() {
        match serde_json::from_str::<ClaudeSessionMetaState>(state_json) {
            Ok(parsed) => {
                state = parsed;
                resumed = true;
            }
            Err(_) => {
                reader = WatermarkedTranscriptReader::open(
                    &record.source_path,
                    "Claude",
                    None,
                    CLAUDE_CODE_METADATA_PARSER_VERSION,
                    record.source_mtime_ms,
                    record.source_size_bytes,
                )?;
            }
        }
    }
    let mut tail_state: Option<ClaudeSessionMetaState> = None;
    while let Some(line) = reader.next_line()? {
        let trimmed = line.text.trim();
        if trimmed.is_empty() {
            continue;
        }
        if line.terminated {
            state.feed(trimmed, record);
        } else {
            let mut snapshot = state.clone();
            snapshot.feed(trimmed, record);
            tail_state = Some(snapshot);
        }
    }
    let state_json = serde_json::to_string(&state)
        .map_err(|err| format!("Failed to serialize Claude parse state: {err}"))?;
    let next_watermark = reader.into_watermark(
        CLAUDE_CODE_METADATA_PARSER_VERSION,
        record.source_mtime_ms,
        record.source_size_bytes,
        state_json,
    );
    let meta = tail_state.unwrap_or(state).finish(record, external_title);
    Ok(ClaudeSessionMetaParse {
        meta,
        watermark: next_watermark,
        resumed,
    })
}

#[cfg(test)]
pub(super) fn parse_claude_session_meta_incremental(
    record: &ImportedHistoryDiscoveredRecord,
    watermark: Option<&ImportedParseWatermark>,
) -> Result<ClaudeSessionMetaParse, String> {
    let external_title = claude_session_title_for_record(record)?;
    parse_claude_session_meta_with_title(record, watermark, external_title)
}

#[cfg(test)]
pub(super) fn parse_claude_session_meta(
    record: &ImportedHistoryDiscoveredRecord,
) -> Result<Option<ClaudeCodeHistoryMeta>, String> {
    Ok(parse_claude_session_meta_incremental(record, None)?.meta)
}

pub(super) fn session_meta_to_cache_input(
    meta: ClaudeCodeHistoryMeta,
) -> ImportedHistoryCacheInput {
    // Computed before the literal below moves `meta.source_path`.
    let client_origin = client_origin::classify_claude_transcript(
        &meta.entrypoint,
        Some(Path::new(&meta.source_path)),
    );
    ImportedHistoryCacheInput {
        source: SOURCE_CLAUDE_CODE,
        source_session_id: meta.source_session_id,
        session_id: meta.session_id,
        source_path: meta.source_path,
        source_record_key: meta.source_record_key,
        source_mtime_ms: meta.source_mtime_ms,
        source_size_bytes: meta.source_size_bytes,
        source_fingerprint: meta.source_fingerprint,
        parser_version: CLAUDE_CODE_METADATA_PARSER_VERSION,
        name: meta.name,
        created_at_ms: meta.created_at_ms,
        updated_at_ms: meta.updated_at_ms,
        model: meta.model,
        input_tokens: meta.input_tokens,
        output_tokens: meta.output_tokens,
        cache_read_tokens: meta.cache_read_tokens,
        cache_write_tokens: meta.cache_write_tokens,
        repo_path: meta.repo_path,
        branch: meta.branch,
        impact: meta.impact,
        listable: true,
        source_metadata_json: imported_cache::continuation_metadata_json(
            meta.first_user_uuid.as_deref(),
            &meta.continuation_markers,
        ),
        parent_session_id: meta.parent_session_id,
        // Path-aware: ORGII spawns the Claude CLI, so its own sessions report
        // `cli`/`sdk-cli` like any terminal run and are separable only by the
        // managed profile root they are stored under.
        client_origin,
        client_origin_raw: (!meta.entrypoint.trim().is_empty()).then_some(meta.entrypoint),
    }
}

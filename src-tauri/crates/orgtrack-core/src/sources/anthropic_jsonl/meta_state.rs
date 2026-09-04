use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::sources::imported_history::{
    self,
    metadata::{ImportedHistoryDiscoveredRecord, ImportedHistoryImpactStats},
    ImportedToolCall,
};

use super::config::AnthropicJsonlSource;
use super::model::{is_harness_injected_line, JsonlLine, SessionMeta};
use super::tool_call::normalize_tool_call;
use super::value::{
    block_type, content_blocks, effective_role, first_content_text, timestamp_ms, usage_tokens,
};

const MAX_PENDING_EDIT_IMPACTS: usize = 1_024;
const MAX_TOUCHED_FILES: usize = 4_096;
const MAX_STATE_ID_BYTES: usize = 1_024;
const MAX_STATE_PATH_BYTES: usize = 4_096;
const MAX_STATE_LABEL_BYTES: usize = 1_024;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub(super) struct PendingEditImpact {
    call_id: String,
    impact: ImportedHistoryImpactStats,
}

/// Compact metadata accumulator persisted behind the append watermark. It
/// deliberately stores no chat text or tool output. Only unresolved edit-call
/// impacts remain pending until their result arrives; completed calls collapse
/// into aggregate counters and a de-duplicated touched-file set.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub(super) struct SessionMetaState {
    declared_session_id: Option<String>,
    created_at_ms: i64,
    updated_at_ms: i64,
    repo_path: Option<String>,
    branch: Option<String>,
    model: Option<String>,
    input_tokens: i64,
    output_tokens: i64,
    cache_read_tokens: i64,
    cache_write_tokens: i64,
    first_user_text: Option<String>,
    impact: ImportedHistoryImpactStats,
    pending_edits: Vec<PendingEditImpact>,
}

impl SessionMetaState {
    pub(super) fn feed(&mut self, line: &str) -> Result<(), String> {
        let Ok(parsed) = serde_json::from_str::<JsonlLine>(line) else {
            return Ok(());
        };
        if parsed.line_type == "session" && !parsed.id.trim().is_empty() {
            ensure_bounded_state_value("session id", parsed.id.trim(), MAX_STATE_ID_BYTES)?;
            self.declared_session_id = Some(parsed.id.trim().to_string());
        }
        if let Some(ms) = timestamp_ms(&parsed.timestamp) {
            if self.created_at_ms == 0 || ms < self.created_at_ms {
                self.created_at_ms = ms;
            }
            self.updated_at_ms = self.updated_at_ms.max(ms);
        }
        if self.repo_path.is_none() && !parsed.cwd.trim().is_empty() {
            ensure_bounded_state_value("repository path", parsed.cwd.trim(), MAX_STATE_PATH_BYTES)?;
            self.repo_path = Some(parsed.cwd.trim().to_string());
        }
        if self.branch.is_none() && !parsed.git_branch.trim().is_empty() {
            ensure_bounded_state_value("branch", parsed.git_branch.trim(), MAX_STATE_LABEL_BYTES)?;
            self.branch = Some(parsed.git_branch.trim().to_string());
        }
        if self.model.is_none() && !parsed.model_id.trim().is_empty() {
            ensure_bounded_state_value("model", parsed.model_id.trim(), MAX_STATE_LABEL_BYTES)?;
            self.model = Some(parsed.model_id.trim().to_string());
        }
        let harness_injected = is_harness_injected_line(&parsed);
        let Some(message) = parsed.message else {
            return Ok(());
        };
        if self.model.is_none() && !message.model.trim().is_empty() {
            ensure_bounded_state_value("model", message.model.trim(), MAX_STATE_LABEL_BYTES)?;
            self.model = Some(message.model.trim().to_string());
        }
        let (input, output, cache_read, cache_write) = usage_tokens(&message.usage);
        self.input_tokens = self.input_tokens.saturating_add(input);
        self.output_tokens = self.output_tokens.saturating_add(output);
        self.cache_read_tokens = self.cache_read_tokens.saturating_add(cache_read);
        self.cache_write_tokens = self.cache_write_tokens.saturating_add(cache_write);
        let role = effective_role(&parsed.line_type, &message.role);
        if self.first_user_text.is_none() && role == "user" && !harness_injected {
            self.first_user_text = first_content_text(&message.content)
                .map(|text| imported_history::truncate_name(&text, 200));
        }
        self.feed_tool_impacts(&message.content)
    }

    fn feed_tool_impacts(&mut self, content: &Value) -> Result<(), String> {
        for block in content_blocks(content) {
            match block_type(&block) {
                "tool_result" => {
                    let Some(call_id) = block
                        .get("tool_use_id")
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty())
                    else {
                        continue;
                    };
                    let Some(index) = self
                        .pending_edits
                        .iter()
                        .position(|pending| pending.call_id == call_id)
                    else {
                        continue;
                    };
                    let pending = self.pending_edits.remove(index);
                    if block.get("is_error").and_then(Value::as_bool) != Some(true) {
                        merge_impact(&mut self.impact, &pending.impact)?;
                    }
                }
                "tool_use" => {
                    let raw_name = block.get("name").and_then(Value::as_str).unwrap_or("tool");
                    let (canonical_name, args) = normalize_tool_call(
                        raw_name,
                        block.get("input").cloned().unwrap_or(Value::Null),
                    );
                    if canonical_name != imported_history::FUNCTION_EDIT_FILE {
                        continue;
                    }
                    let call_id = block
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    ensure_bounded_state_value("tool call id", &call_id, MAX_STATE_ID_BYTES)?;
                    let call = ImportedToolCall {
                        call_id: call_id.clone(),
                        raw_name: raw_name.to_string(),
                        canonical_name,
                        args,
                        created_at: String::new(),
                    };
                    let chunk = imported_history::tool_call_chunk("", "", 0, &call, "");
                    let impact = imported_history::impact_from_edit_chunks(&[chunk]);
                    validate_impact_bounds(&impact)?;
                    if call_id.is_empty() {
                        merge_impact(&mut self.impact, &impact)?;
                    } else {
                        self.pending_edits
                            .retain(|pending| pending.call_id != call_id);
                        if self.pending_edits.len() >= MAX_PENDING_EDIT_IMPACTS {
                            return Err(format!(
                                "Incremental history state exceeds the \
                                 {MAX_PENDING_EDIT_IMPACTS}-pending-edit safety limit"
                            ));
                        }
                        self.pending_edits
                            .push(PendingEditImpact { call_id, impact });
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }

    pub(super) fn validate_bounds(&self) -> Result<(), String> {
        if [
            self.input_tokens,
            self.output_tokens,
            self.cache_read_tokens,
            self.cache_write_tokens,
        ]
        .into_iter()
        .any(|value| value < 0)
        {
            return Err("Incremental history state contains negative token totals".to_string());
        }
        if let Some(value) = self.declared_session_id.as_deref() {
            ensure_bounded_state_value("session id", value, MAX_STATE_ID_BYTES)?;
        }
        if let Some(value) = self.repo_path.as_deref() {
            ensure_bounded_state_value("repository path", value, MAX_STATE_PATH_BYTES)?;
        }
        if let Some(value) = self.branch.as_deref() {
            ensure_bounded_state_value("branch", value, MAX_STATE_LABEL_BYTES)?;
        }
        if let Some(value) = self.model.as_deref() {
            ensure_bounded_state_value("model", value, MAX_STATE_LABEL_BYTES)?;
        }
        if self.pending_edits.len() > MAX_PENDING_EDIT_IMPACTS {
            return Err("Incremental history state has too many pending edits".to_string());
        }
        validate_impact_bounds(&self.impact)?;
        for pending in &self.pending_edits {
            ensure_bounded_state_value("tool call id", &pending.call_id, MAX_STATE_ID_BYTES)?;
            validate_impact_bounds(&pending.impact)?;
        }
        Ok(())
    }

    pub(super) fn finish(
        mut self,
        config: &AnthropicJsonlSource,
        record: &ImportedHistoryDiscoveredRecord,
    ) -> Result<SessionMeta, String> {
        for pending in std::mem::take(&mut self.pending_edits) {
            merge_impact(&mut self.impact, &pending.impact)?;
        }
        let fallback_ms = record.source_mtime_ms / 1_000_000;
        let identity = if config.session_id_from_header {
            self.declared_session_id
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| record.source_session_id.clone())
        } else {
            record.source_session_id.clone()
        };
        Ok(SessionMeta {
            source_session_id: record.source_session_id.clone(),
            session_id: format!("{}{}", config.session_prefix, identity),
            source_path: record.source_path.to_string_lossy().to_string(),
            source_record_key: record.source_record_key.clone(),
            source_mtime_ms: record.source_mtime_ms,
            source_size_bytes: record.source_size_bytes,
            name: self
                .first_user_text
                .map(|value| imported_history::truncate_name(&value, 200))
                .unwrap_or_else(|| record.source_record_key.clone()),
            created_at_ms: if self.created_at_ms > 0 {
                self.created_at_ms
            } else {
                fallback_ms
            },
            updated_at_ms: if self.updated_at_ms > 0 {
                self.updated_at_ms
            } else {
                fallback_ms
            },
            model: self.model,
            input_tokens: self.input_tokens,
            output_tokens: self.output_tokens,
            cache_read_tokens: self.cache_read_tokens,
            cache_write_tokens: self.cache_write_tokens,
            repo_path: self.repo_path,
            branch: self.branch,
            impact: self.impact,
        })
    }
}

fn ensure_bounded_state_value(label: &str, value: &str, max_bytes: usize) -> Result<(), String> {
    if value.len() > max_bytes {
        return Err(format!(
            "Incremental history {label} exceeds the {max_bytes}-byte safety limit"
        ));
    }
    Ok(())
}

fn validate_impact_bounds(impact: &ImportedHistoryImpactStats) -> Result<(), String> {
    if impact.touched_files.len() > MAX_TOUCHED_FILES {
        return Err(format!(
            "Incremental history state exceeds the {MAX_TOUCHED_FILES}-file safety limit"
        ));
    }
    if impact
        .touched_files
        .iter()
        .any(|path| path.len() > MAX_STATE_PATH_BYTES)
    {
        return Err(format!(
            "Incremental history touched path exceeds the {MAX_STATE_PATH_BYTES}-byte safety limit"
        ));
    }
    Ok(())
}

fn merge_impact(
    target: &mut ImportedHistoryImpactStats,
    incoming: &ImportedHistoryImpactStats,
) -> Result<(), String> {
    validate_impact_bounds(target)?;
    validate_impact_bounds(incoming)?;
    target.lines_added = target.lines_added.saturating_add(incoming.lines_added);
    target.lines_removed = target.lines_removed.saturating_add(incoming.lines_removed);
    let mut paths = target
        .touched_files
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    paths.extend(incoming.touched_files.iter().cloned());
    if paths.len() > MAX_TOUCHED_FILES {
        return Err(format!(
            "Incremental history state exceeds the {MAX_TOUCHED_FILES}-file safety limit"
        ));
    }
    target.touched_files = paths.into_iter().collect();
    target.files_changed = target.touched_files.len() as i64;
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn incremental_state_rejects_oversized_identity_and_pending_sets() {
        let mut state = SessionMetaState::default();
        let oversized_id = "x".repeat(MAX_STATE_ID_BYTES + 1);
        let line = json!({"type":"session","id":oversized_id}).to_string();
        assert!(state
            .feed(&line)
            .expect_err("oversized id")
            .contains("session id"));

        state.pending_edits = vec![PendingEditImpact::default(); MAX_PENDING_EDIT_IMPACTS + 1];
        assert!(state
            .validate_bounds()
            .expect_err("oversized pending state")
            .contains("pending edits"));
    }
}

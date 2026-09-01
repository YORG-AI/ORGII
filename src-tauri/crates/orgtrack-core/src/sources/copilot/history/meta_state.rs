//! The resumable `events.jsonl` scan accumulator: folds one event at a time
//! into the session's timestamps, title, model, cwd, and edit impact.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::sources::imported_history::{
    self, metadata::ImportedHistoryImpactStats, ImportedToolCall,
};

use super::bounded::{bounded_data_str, bounded_nonempty};
use super::tools::map_copilot_tool_call;
use super::types::CopilotEventLine;
use super::{
    COPILOT_PROVIDER_SLUG, MAX_ID_BYTES, MAX_MODEL_BYTES, MAX_PATH_BYTES, MAX_PENDING_TOOL_CALLS,
    MAX_TOOL_REQUESTS_PER_EVENT, MAX_TOUCHED_FILES,
};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct CopilotMetaState {
    pub(super) session_start_cwd: Option<String>,
    pub(super) start_time_ms: Option<i64>,
    pub(super) first_event_ms: Option<i64>,
    pub(super) last_event_ms: Option<i64>,
    pub(super) first_user_text: Option<String>,
    pub(super) last_assistant_model: Option<String>,
    pub(super) last_model_change: Option<String>,
    pub(super) impact: ImportedHistoryImpactStats,
    pub(super) pending_tool_impacts: HashMap<String, ImportedHistoryImpactStats>,
}

impl CopilotMetaState {
    pub(super) fn feed(&mut self, event: &CopilotEventLine) -> Result<(), String> {
        if let Some(timestamp_ms) =
            imported_history::parse_iso_to_epoch_ms_opt(event.timestamp.trim())
        {
            self.first_event_ms.get_or_insert(timestamp_ms);
            self.last_event_ms = Some(timestamp_ms);
        }
        match event.r#type.as_str() {
            "session.start" => {
                if self.session_start_cwd.is_none() {
                    self.session_start_cwd = event
                        .data
                        .get("context")
                        .and_then(|context| context.get("cwd"))
                        .and_then(Value::as_str)
                        .and_then(|value| bounded_nonempty(value, MAX_PATH_BYTES));
                }
                if self.start_time_ms.is_none() {
                    self.start_time_ms = event
                        .data
                        .get("startTime")
                        .and_then(Value::as_str)
                        .and_then(imported_history::parse_iso_to_epoch_ms_opt);
                }
            }
            "session.model_change" => {
                if let Some(model) = bounded_data_str(&event.data, "newModel", MAX_MODEL_BYTES) {
                    self.last_model_change = Some(model);
                }
            }
            "user.message" => {
                if self.first_user_text.is_none() {
                    self.first_user_text = bounded_data_str(&event.data, "content", 1_024)
                        .map(|text| imported_history::truncate_name(&text, 200));
                }
            }
            "assistant.message" => {
                if let Some(model) = bounded_data_str(&event.data, "model", MAX_MODEL_BYTES) {
                    self.last_assistant_model = Some(model);
                }
                let requests = event
                    .data
                    .get("toolRequests")
                    .and_then(Value::as_array)
                    .map(Vec::as_slice)
                    .unwrap_or_default();
                if requests.len() > MAX_TOOL_REQUESTS_PER_EVENT {
                    return Err(format!(
                        "Copilot event exceeds the {MAX_TOOL_REQUESTS_PER_EVENT}-tool safety limit"
                    ));
                }
                for request in requests {
                    let Some(call_id) = request
                        .get("toolCallId")
                        .and_then(Value::as_str)
                        .and_then(|value| bounded_nonempty(value, MAX_ID_BYTES))
                    else {
                        continue;
                    };
                    let raw_name = request
                        .get("name")
                        .and_then(Value::as_str)
                        .and_then(|value| bounded_nonempty(value, MAX_ID_BYTES))
                        .unwrap_or_else(|| "tool".to_string());
                    let arguments = request.get("arguments").unwrap_or(&Value::Null);
                    let (canonical_name, args) = map_copilot_tool_call(&raw_name, arguments);
                    if canonical_name != imported_history::FUNCTION_EDIT_FILE {
                        continue;
                    }
                    let call = ImportedToolCall {
                        call_id: call_id.clone(),
                        raw_name,
                        canonical_name,
                        args,
                        created_at: event.timestamp.clone(),
                    };
                    let chunk = imported_history::tool_call_chunk(
                        "copilot-meta",
                        COPILOT_PROVIDER_SLUG,
                        0,
                        &call,
                        "",
                    );
                    let impact = imported_history::impact_from_edit_chunks(&[chunk]);
                    if impact.files_changed == 0 {
                        continue;
                    }
                    if !self.pending_tool_impacts.contains_key(&call_id)
                        && self.pending_tool_impacts.len() >= MAX_PENDING_TOOL_CALLS
                    {
                        return Err(format!(
                            "Copilot metadata exceeds the {MAX_PENDING_TOOL_CALLS}-pending-tool safety limit"
                        ));
                    }
                    self.pending_tool_impacts.insert(call_id, impact);
                }
            }
            "tool.execution_complete" => {
                let Some(call_id) = event
                    .data
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .filter(|value| value.len() <= MAX_ID_BYTES)
                else {
                    return Ok(());
                };
                let Some(impact) = self.pending_tool_impacts.remove(call_id) else {
                    return Ok(());
                };
                if event.data.get("success").and_then(Value::as_bool) != Some(false) {
                    merge_impact(&mut self.impact, impact)?;
                }
            }
            _ => {}
        }
        Ok(())
    }

    pub(super) fn validate(&self) -> Result<(), String> {
        if self
            .session_start_cwd
            .as_ref()
            .is_some_and(|value| value.len() > MAX_PATH_BYTES)
            || self
                .first_user_text
                .as_ref()
                .is_some_and(|value| value.len() > 1_024)
            || self
                .last_assistant_model
                .as_ref()
                .is_some_and(|value| value.len() > MAX_MODEL_BYTES)
            || self
                .last_model_change
                .as_ref()
                .is_some_and(|value| value.len() > MAX_MODEL_BYTES)
            || self.pending_tool_impacts.len() > MAX_PENDING_TOOL_CALLS
            || self.impact.touched_files.len() > MAX_TOUCHED_FILES
        {
            return Err("Copilot parse state contains an oversized field".to_string());
        }
        for (call_id, impact) in &self.pending_tool_impacts {
            if call_id.is_empty()
                || call_id.len() > MAX_ID_BYTES
                || impact.touched_files.len() > MAX_TOUCHED_FILES
                || impact
                    .touched_files
                    .iter()
                    .any(|path| path.len() > MAX_PATH_BYTES)
            {
                return Err("Copilot parse state contains invalid tool impact".to_string());
            }
        }
        if self
            .impact
            .touched_files
            .iter()
            .any(|path| path.len() > MAX_PATH_BYTES)
        {
            return Err("Copilot parse state contains an oversized path".to_string());
        }
        Ok(())
    }
}

fn merge_impact(
    target: &mut ImportedHistoryImpactStats,
    incoming: ImportedHistoryImpactStats,
) -> Result<(), String> {
    target.lines_added = target.lines_added.saturating_add(incoming.lines_added);
    target.lines_removed = target.lines_removed.saturating_add(incoming.lines_removed);
    let mut seen = target.touched_files.iter().cloned().collect::<HashSet<_>>();
    for path in incoming.touched_files {
        if path.len() > MAX_PATH_BYTES {
            continue;
        }
        if seen.insert(path.clone()) {
            if target.touched_files.len() >= MAX_TOUCHED_FILES {
                return Err(format!(
                    "Copilot metadata exceeds the {MAX_TOUCHED_FILES}-file safety limit"
                ));
            }
            target.touched_files.push(path);
        }
    }
    target.touched_files.sort();
    target.files_changed = target.touched_files.len() as i64;
    Ok(())
}

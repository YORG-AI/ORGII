//! Tool Call Merger
//!
//! Merges tool_call start/end pairs into single events.
//! When historical data arrives, tool calls may come as separate "start"
//! (with args) and "end" (with result) chunks sharing the same `call_id`.
//! This module pairs them into unified events.

use std::collections::HashMap;

use crate::agent_sessions::event_pipeline::store::monotonic_shell_replay_state;
use crate::agent_sessions::event_pipeline::types::SessionEvent;

// ============================================================================
// Public API
// ============================================================================

/// Merge tool call start/end pairs in a batch of events.
///
/// For events sharing the same `call_id`, the start event's args are combined
/// with the end event's result. The merged event uses the start's timestamp
/// and the end's display_status.
pub fn merge_tool_call_pairs(events: Vec<SessionEvent>) -> Vec<SessionEvent> {
    let mut tool_calls: Vec<(usize, &SessionEvent)> = Vec::new();
    let mut other_indices: Vec<usize> = Vec::new();

    for (idx, event) in events.iter().enumerate() {
        if is_tool_call_event(event) {
            tool_calls.push((idx, event));
        } else {
            other_indices.push(idx);
        }
    }

    if tool_calls.is_empty() {
        return events;
    }

    // Group by call_id
    let mut by_call_id: HashMap<String, Vec<(usize, &SessionEvent)>> = HashMap::new();
    let mut orphaned: Vec<usize> = Vec::new();

    for (idx, event) in &tool_calls {
        if let Some(ref cid) = event.call_id {
            if !cid.is_empty() {
                by_call_id
                    .entry(cid.clone())
                    .or_default()
                    .push((*idx, event));
                continue;
            }
        }
        orphaned.push(*idx);
    }

    // Build merged events
    let mut merged_map: HashMap<String, SessionEvent> = HashMap::new();
    let mut consumed_indices: std::collections::HashSet<usize> = std::collections::HashSet::new();

    for (call_id, group) in &by_call_id {
        if group.len() < 2 {
            // Single event, no merging needed
            continue;
        }

        let start = group.iter().find(|(_, e)| is_tool_call_start(e));
        let end = group.iter().find(|(_, e)| is_tool_call_end(e));

        if let (Some((start_idx, start_event)), Some((end_idx, end_event))) = (start, end) {
            let merged = merge_start_end(start_event, end_event);
            merged_map.insert(call_id.clone(), merged);
            consumed_indices.insert(*start_idx);
            consumed_indices.insert(*end_idx);
        }
    }

    // Rebuild output preserving original order
    let mut result = Vec::with_capacity(events.len() - consumed_indices.len() + merged_map.len());
    let mut emitted_call_ids: std::collections::HashSet<String> = std::collections::HashSet::new();

    for (idx, event) in events.into_iter().enumerate() {
        if consumed_indices.contains(&idx) {
            // Emit merged event at the position of the start event
            if let Some(ref cid) = event.call_id {
                if !emitted_call_ids.contains(cid) {
                    if let Some(merged) = merged_map.remove(cid) {
                        result.push(merged);
                        emitted_call_ids.insert(cid.clone());
                    }
                }
            }
            continue;
        }
        result.push(event);
    }

    result
}

// ============================================================================
// Classification
// ============================================================================

fn is_tool_call_event(event: &SessionEvent) -> bool {
    event.action_type == "tool_call"
        || event.action_type == "tool_result"
        || (event.call_id.is_some()
            && event
                .call_id
                .as_ref()
                .map(|c| !c.is_empty())
                .unwrap_or(false))
}

fn is_tool_call_start(event: &SessionEvent) -> bool {
    if event.action_type == "tool_call" {
        return true;
    }
    // Has args but empty/null result → likely start
    if let Some(obj) = event.args.as_object() {
        if !obj.is_empty() {
            if let Some(robj) = event.result.as_object() {
                if robj.is_empty() {
                    return true;
                }
            }
            if event.result.is_null() {
                return true;
            }
        }
    }
    false
}

fn is_tool_call_end(event: &SessionEvent) -> bool {
    if event.action_type == "tool_result" {
        return true;
    }
    // Has result content → likely end
    if let Some(obj) = event.result.as_object() {
        if obj.contains_key("content")
            || obj.contains_key("output")
            || obj.contains_key("success")
            || obj.contains_key("observation")
        {
            return true;
        }
    }
    false
}

// ============================================================================
// Merging
// ============================================================================

fn merge_start_end(start: &SessionEvent, end: &SessionEvent) -> SessionEvent {
    let mut merged = start.clone();

    // Take result from end event
    merged.result = end.result.clone();

    // Merge args: start's args take priority, but include any extra from end
    if let (Some(start_args), Some(end_args)) = (start.args.as_object(), end.args.as_object()) {
        let mut combined = end_args.clone();
        for (key, value) in start_args {
            combined.insert(key.clone(), value.clone());
        }
        merged.args = serde_json::Value::Object(combined);
    }

    // Use end's display status and text (has final result)
    merged.display_status = end.display_status.clone();
    if !end.display_text.is_empty() && end.display_text != "Activity" {
        merged.display_text = end.display_text.clone();
    }

    // Keep file_path and command from whichever has it
    if merged.file_path.is_none() {
        merged.file_path = end.file_path.clone();
    }
    if merged.command.is_none() {
        merged.command = end.command.clone();
    }

    // Mark as non-delta
    merged.is_delta = None;

    // The start event owns the immutable timeline bookmark, while the end
    // event may carry a newer mutable/final replay state.
    if let Some(end_state) = end.shell_replay.clone() {
        merged.shell_replay = Some(monotonic_shell_replay_state(
            merged.shell_replay.as_ref(),
            end_state,
        ));
    }

    merged
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
#[path = "tests/tool_call_merger_tests.rs"]
mod tests;

use std::collections::BTreeSet;

use core_types::activity::ActivityChunk;
use serde_json::{json, Value};

use crate::sources::imported_history::{
    self, metadata::ImportedHistoryImpactStats, ImportedToolCall,
};

/// Accumulate exact diff stats from a tool result's `structuredPatch`.
///
/// Claude Code attaches a `toolUseResult` sidecar to Edit/MultiEdit/Write tool
/// results containing a unified-diff-style `structuredPatch`. Each hunk's `lines`
/// are prefixed with `+` (added), `-` (removed), or ` ` (context), so this yields
/// the same counts a `git diff` would — unlike the old_string/new_string heuristic.
pub(super) fn collect_claude_impact_from_tool_result(
    result: &Value,
    impact: &mut ImportedHistoryImpactStats,
    touched_files: &mut BTreeSet<String>,
) {
    let Some(hunks) = result.get("structuredPatch").and_then(Value::as_array) else {
        return;
    };
    if let Some(file_path) = result
        .get("filePath")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        touched_files.insert(file_path.to_string());
    }
    for hunk in hunks {
        let Some(lines) = hunk.get("lines").and_then(Value::as_array) else {
            continue;
        };
        for line in lines {
            match line.as_str().and_then(|text| text.as_bytes().first()) {
                Some(b'+') => impact.lines_added += 1,
                Some(b'-') => impact.lines_removed += 1,
                _ => {}
            }
        }
    }
}

pub(super) fn collect_claude_impact_from_item(
    item: &Value,
    impact: &mut ImportedHistoryImpactStats,
    touched_files: &mut BTreeSet<String>,
) {
    if item.get("type").and_then(Value::as_str) != Some("tool_use") {
        return;
    }
    let Some(tool_name) = item.get("name").and_then(Value::as_str) else {
        return;
    };
    if !matches!(tool_name, "Edit" | "MultiEdit" | "Write") {
        return;
    }
    let Some(input) = item.get("input") else {
        return;
    };
    let Some(file_path) = input
        .get("file_path")
        .and_then(Value::as_str)
        .or_else(|| input.get("path").and_then(Value::as_str))
        .map(str::trim)
        .filter(|path| !path.is_empty())
    else {
        return;
    };
    touched_files.insert(file_path.to_string());
    match tool_name {
        "Write" => {
            if let Some(content) = input.get("content").and_then(Value::as_str) {
                impact.lines_added += count_text_lines(content);
            }
        }
        "Edit" => {
            accumulate_claude_edit_input(input, impact);
        }
        "MultiEdit" => {
            if let Some(edits) = input.get("edits").and_then(Value::as_array) {
                for edit in edits {
                    accumulate_claude_edit_input(edit, impact);
                }
            }
        }
        _ => {}
    }
}

fn accumulate_claude_edit_input(input: &Value, impact: &mut ImportedHistoryImpactStats) {
    if let Some(old_string) = input.get("old_string").and_then(Value::as_str) {
        impact.lines_removed += count_text_lines(old_string);
    }
    if let Some(new_string) = input.get("new_string").and_then(Value::as_str) {
        impact.lines_added += count_text_lines(new_string);
    }
}

fn count_text_lines(text: &str) -> i64 {
    if text.is_empty() {
        0
    } else {
        text.lines().count() as i64
    }
}

pub(super) fn claude_tool_call_from_item(
    item: &Value,
    created_at: &str,
) -> Option<ImportedToolCall> {
    let call_id = item.get("id")?.as_str()?.to_string();
    let raw_name = item.get("name")?.as_str()?.to_string();
    let args = item.get("input").cloned().unwrap_or_else(|| json!({}));
    let (canonical_name, args) = normalize_claude_tool_call(&raw_name, args);
    Some(ImportedToolCall {
        call_id,
        raw_name,
        canonical_name,
        args,
        created_at: created_at.to_string(),
    })
}

fn normalize_claude_tool_call(raw_name: &str, args: Value) -> (String, Value) {
    match raw_name {
        "Bash" => (
            imported_history::FUNCTION_RUN_COMMAND_LINE.to_string(),
            normalize_shell_args(args),
        ),
        "Edit" | "MultiEdit" | "Write" => (
            imported_history::FUNCTION_EDIT_FILE.to_string(),
            normalize_edit_args(raw_name, args),
        ),
        _ => (raw_name.to_string(), args),
    }
}

fn normalize_shell_args(args: Value) -> Value {
    let command = args
        .get("command")
        .and_then(Value::as_str)
        .or_else(|| args.get("cmd").and_then(Value::as_str))
        .unwrap_or_default();
    json!({
        "command": command,
        "cmd": command,
    })
}

fn normalize_edit_args(raw_name: &str, args: Value) -> Value {
    let file_path = args
        .get("file_path")
        .and_then(Value::as_str)
        .or_else(|| args.get("path").and_then(Value::as_str))
        .unwrap_or_default();
    // `create` for new-file Writes (so the diff card can tag it as new), `edit`
    // otherwise. Old/new text is intentionally NOT carried on the args: the exact
    // diff is threaded onto the result from the tool's `structuredPatch` at
    // result-pairing time (see `apply_claude_edit_diff`), and keeping old/new off
    // the args lets the frontend render that context-rich diff rather than a bare
    // old_string→new_string snippet.
    let action = if raw_name == "Write" {
        "create"
    } else {
        "edit"
    };
    json!({
        "action": action,
        "file_path": file_path,
    })
}

/// Attach the exact edit diff to a tool-result chunk.
///
/// Edit/MultiEdit/Write results carry a `toolUseResult.structuredPatch`; convert
/// it to a unified diff (with surrounding context) and store it on the chunk
/// result as `diff` plus exact `linesAdded`/`linesRemoved`, so the frontend diff
/// card renders the real change. When no patch is present (rare/older
/// transcripts) fall back to the authoritative `oldString`/`newString` (or a
/// Write's `content`) so at least a snippet still renders.
pub(super) fn apply_claude_edit_diff(chunk: &mut ActivityChunk, tool_use_result: Option<&Value>) {
    let Some(result) = tool_use_result else {
        return;
    };

    if let Some((diff, added, removed)) = claude_unified_diff_from_patch(result) {
        if let Some(obj) = chunk.result.as_object_mut() {
            obj.insert("diff".to_string(), Value::String(diff));
            obj.insert("linesAdded".to_string(), json!(added));
            obj.insert("linesRemoved".to_string(), json!(removed));
        }
        return;
    }

    let old_string = result
        .get("oldString")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let new_string = result
        .get("newString")
        .or_else(|| result.get("content"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    if old_string.is_empty() && new_string.is_empty() {
        return;
    }
    if let Some(obj) = chunk.args.as_object_mut() {
        obj.insert("old_string".to_string(), json!(old_string));
        obj.insert("new_string".to_string(), json!(new_string));
    }
}

/// Convert a `toolUseResult.structuredPatch` into a unified diff string plus its
/// added/removed line counts. Returns `None` when no (non-empty) patch is present.
///
/// Each hunk's `lines` are already prefixed with `+`/`-`/` `, so this yields a
/// standard unified diff that the frontend diff extractor parses directly.
fn claude_unified_diff_from_patch(result: &Value) -> Option<(String, i64, i64)> {
    let hunks = result.get("structuredPatch").and_then(Value::as_array)?;
    if hunks.is_empty() {
        return None;
    }
    let path = result.get("filePath").and_then(Value::as_str).unwrap_or("");
    let mut diff = format!("--- {path}\n+++ {path}\n");
    let mut added = 0i64;
    let mut removed = 0i64;
    for hunk in hunks {
        let old_start = hunk.get("oldStart").and_then(Value::as_i64).unwrap_or(0);
        let old_lines = hunk.get("oldLines").and_then(Value::as_i64).unwrap_or(0);
        let new_start = hunk.get("newStart").and_then(Value::as_i64).unwrap_or(0);
        let new_lines = hunk.get("newLines").and_then(Value::as_i64).unwrap_or(0);
        diff.push_str(&format!(
            "@@ -{old_start},{old_lines} +{new_start},{new_lines} @@\n"
        ));
        let Some(lines) = hunk.get("lines").and_then(Value::as_array) else {
            continue;
        };
        for line in lines {
            let Some(text) = line.as_str() else {
                continue;
            };
            match text.as_bytes().first() {
                Some(b'+') => added += 1,
                Some(b'-') => removed += 1,
                _ => {}
            }
            diff.push_str(text);
            diff.push('\n');
        }
    }
    Some((diff, added, removed))
}

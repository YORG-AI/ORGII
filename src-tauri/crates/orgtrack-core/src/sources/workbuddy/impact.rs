//! Edit-impact collection: tallying touched files and added/removed lines from
//! assistant tool-use blocks and function calls.

use super::*;

pub(super) fn collect_impact_from_item(
    item: &Value,
    impact: &mut ImportedHistoryImpactStats,
    touched_files: &mut BTreeSet<String>,
) {
    let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
    if item_type != "tool_use" && item_type != "function_call" {
        return;
    }
    let Some(raw_name) = item
        .get("name")
        .and_then(Value::as_str)
        .or_else(|| item.get("tool").and_then(Value::as_str))
    else {
        return;
    };
    let args = item
        .get("input")
        .or_else(|| item.get("arguments"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    collect_edit_impact(raw_name, &args, impact, touched_files);
}

pub(super) fn collect_impact_from_function_call(
    call: &WorkBuddyFunctionCall,
    impact: &mut ImportedHistoryImpactStats,
    touched_files: &mut BTreeSet<String>,
) {
    collect_edit_impact(&call.name, &call.arguments, impact, touched_files);
    collect_edit_impact(&call.name, &call.input, impact, touched_files);
}

pub(super) fn collect_edit_impact(
    raw_name: &str,
    args: &Value,
    impact: &mut ImportedHistoryImpactStats,
    touched_files: &mut BTreeSet<String>,
) {
    if !matches!(
        raw_name,
        "Edit"
            | "MultiEdit"
            | "Write"
            | "edit_file"
            | "edit_file_v2"
            | "write_file"
            | "apply_patch"
    ) {
        return;
    }
    if let Some(file_path) = args
        .get("file_path")
        .and_then(Value::as_str)
        .or_else(|| args.get("path").and_then(Value::as_str))
        .or_else(|| args.get("targetFile").and_then(Value::as_str))
        .or_else(|| args.get("relativeWorkspacePath").and_then(Value::as_str))
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        touched_files.insert(file_path.to_string());
    }
    if raw_name == "Write" || raw_name == "write_file" {
        if let Some(content) = args.get("content").and_then(Value::as_str) {
            impact.lines_added += count_text_lines(content);
        }
    }
    if let Some(old_string) = args.get("old_string").and_then(Value::as_str) {
        impact.lines_removed += count_text_lines(old_string);
    }
    if let Some(new_string) = args.get("new_string").and_then(Value::as_str) {
        impact.lines_added += count_text_lines(new_string);
    }
    if let Some(edits) = args.get("edits").and_then(Value::as_array) {
        for edit in edits {
            if let Some(old_string) = edit.get("old_string").and_then(Value::as_str) {
                impact.lines_removed += count_text_lines(old_string);
            }
            if let Some(new_string) = edit.get("new_string").and_then(Value::as_str) {
                impact.lines_added += count_text_lines(new_string);
            }
        }
    }
}

pub(super) fn count_text_lines(text: &str) -> i64 {
    if text.is_empty() {
        0
    } else {
        text.lines().count() as i64
    }
}

//! Content, diff, todo and tool-result normalization helpers.
//!
//! Pure functions shared by the notification parser and the JSON-RPC
//! reader — no I/O, no protocol state.

use serde_json::Value;

use super::parser::PendingToolCall;

/// Truncate a string to at most `max_chars` characters (UTF-8 safe).
/// Appends "..." if truncated.
pub(crate) fn truncate_str_safe(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        text.to_string()
    } else {
        let truncated: String = text.chars().take(max_chars).collect();
        format!("{}...", truncated)
    }
}

// ============================================
// Tool Result Helpers
// ============================================

pub(crate) fn count_diff_lines(diff: &str) -> (usize, usize) {
    let mut added: usize = 0;
    let mut removed: usize = 0;
    for line in diff.lines() {
        if line.starts_with('+') && !line.starts_with("+++") {
            added += 1;
        } else if line.starts_with('-') && !line.starts_with("---") {
            removed += 1;
        }
    }
    (added, removed)
}

pub(crate) fn extract_edit_content(raw_input: &Value) -> Option<String> {
    for key in &[
        "new_string",
        "newString",
        "newStr",
        "new_text",
        "newText",
        "content",
        "text",
        "file_text",
        "fileText",
        "fileContent",
        "file_content",
        "body",
    ] {
        if let Some(text) = raw_input.get(*key).and_then(|v| v.as_str()) {
            if !text.is_empty() {
                return Some(text.to_string());
            }
        }
    }
    None
}

const SYNTHETIC_DIFF_CONTEXT_LINES: usize = 2;

pub(crate) fn synthesize_diff(
    path: &str,
    old_text: &str,
    new_text: &str,
) -> (String, usize, usize) {
    let result = perf_utils::diff_patch::compute_diff(
        old_text.to_string(),
        new_text.to_string(),
        Some(format!("a/{}", path)),
        Some(format!("b/{}", path)),
        Some(perf_utils::diff_patch::DiffOptions {
            algorithm: None,
            context_lines: Some(SYNTHETIC_DIFF_CONTEXT_LINES),
            format: None,
        }),
    )
    .expect("synthetic diff computation should not fail");

    (
        result.diff,
        result.stats.lines_added,
        result.stats.lines_removed,
    )
}

pub(crate) fn normalize_tool_result(
    cursor_name: &str,
    result_text: &str,
    detailed_text: &str,
    is_error: bool,
    pending: Option<&PendingToolCall>,
) -> Value {
    match cursor_name {
        "Shell" => {
            if is_error {
                serde_json::json!({"error": {"stdout": result_text, "stderr": ""}})
            } else {
                serde_json::json!({"success": {"exitCode": 0, "stdout": result_text, "stderr": ""}})
            }
        }
        "Edit" => {
            let file_path = pending.map(|pt| pt.file_path.as_str()).unwrap_or("");
            let diff_source = if !detailed_text.is_empty() {
                detailed_text
            } else {
                result_text
            };
            let (lines_added, lines_removed) = count_diff_lines(diff_source);

            if lines_added > 0 || lines_removed > 0 {
                serde_json::json!({
                    "success": {
                        "path": file_path,
                        "linesAdded": lines_added,
                        "linesRemoved": lines_removed,
                        "diffString": diff_source,
                    }
                })
            } else {
                let new_content = pending.and_then(|pt| extract_edit_content(&pt.raw_input));
                let old_content = pending.and_then(|pt| {
                    pt.raw_input
                        .get("old_string")
                        .or(pt.raw_input.get("oldString"))
                        .or(pt.raw_input.get("oldStr"))
                        .or(pt.raw_input.get("old_text"))
                        .or(pt.raw_input.get("oldText"))
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                        .map(|s| s.to_string())
                });
                if let Some(new_text) = new_content {
                    let old_text = old_content.as_deref().unwrap_or("");
                    let (diff_string, synth_added, synth_removed) =
                        synthesize_diff(file_path, old_text, &new_text);
                    serde_json::json!({
                        "success": {
                            "path": file_path,
                            "linesAdded": synth_added,
                            "linesRemoved": synth_removed,
                            "diffString": diff_string,
                        }
                    })
                } else {
                    serde_json::json!({
                        "success": {
                            "path": file_path,
                            "linesAdded": 0,
                            "linesRemoved": 0,
                            "diffString": result_text,
                            "message": result_text,
                        }
                    })
                }
            }
        }
        "Read" => {
            let file_path = pending.map(|pt| pt.file_path.as_str()).unwrap_or("");
            serde_json::json!({"success": {"path": file_path, "content": result_text, "totalLines": 0, "fileSize": 0}})
        }
        _ => {
            if is_error {
                serde_json::json!({"error": {"message": result_text}})
            } else {
                serde_json::json!({"success": true, "content": result_text})
            }
        }
    }
}

// ============================================
// Markdown Todo Parser
// ============================================

pub(crate) fn parse_markdown_todos(markdown: &str) -> Value {
    let mut todos = Vec::new();
    let mut id_counter: u32 = 0;

    for line in markdown.lines() {
        let trimmed = line.trim();
        let (checked, rest) = if let Some(rest) = trimmed
            .strip_prefix("- [x] ")
            .or_else(|| trimmed.strip_prefix("- [X] "))
        {
            (true, rest)
        } else if let Some(rest) = trimmed.strip_prefix("- [ ] ") {
            (false, rest)
        } else {
            continue;
        };

        id_counter += 1;
        let content = if let Some(dot_pos) = rest.find(". ") {
            let prefix = &rest[..dot_pos];
            if prefix.chars().all(|ch| ch.is_ascii_digit()) {
                &rest[dot_pos + 2..]
            } else {
                rest
            }
        } else {
            rest
        };
        let status = if checked { "completed" } else { "pending" };
        todos.push(serde_json::json!({
            "id": id_counter.to_string(),
            "content": content.trim(),
            "status": status,
        }));
    }
    Value::Array(todos)
}

// ============================================
// Tool Call Content Extraction
// ============================================

pub(crate) fn extract_tool_call_content(update: &Value) -> (String, String) {
    let mut content = String::new();
    let mut detailed = String::new();

    if let Some(raw_output) = update.get("rawOutput") {
        if let Some(text) = raw_output.get("content").and_then(|v| v.as_str()) {
            if !text.is_empty() {
                content = text.to_string();
            }
        }
        if let Some(text) = raw_output.get("detailedContent").and_then(|v| v.as_str()) {
            if !text.is_empty() {
                detailed = text.to_string();
            }
        }
        // Kiro ACP format: rawOutput.items[] with {"Text": "..."} or {"Json": {...}}
        if content.is_empty() && detailed.is_empty() {
            if let Some(items) = raw_output.get("items").and_then(|v| v.as_array()) {
                let mut texts = Vec::new();
                for item in items {
                    if let Some(text) = item.get("Text").and_then(|v| v.as_str()) {
                        texts.push(text.to_string());
                    } else if let Some(json_val) = item.get("Json") {
                        if let Some(stdout) = json_val.get("stdout").and_then(|v| v.as_str()) {
                            texts.push(stdout.to_string());
                        } else {
                            // `json_val` is a `serde_json::Value`, so
                            // serialization is infallible (Rule 41).
                            texts.push(
                                serde_json::to_string(json_val)
                                    .expect("acp_common: serde_json::Value must serialize"),
                            );
                        }
                    }
                }
                if !texts.is_empty() {
                    content = texts.join("\n");
                }
            }
        }
    }
    if !content.is_empty() || !detailed.is_empty() {
        return (content, detailed);
    }

    if let Some(content_val) = update.get("content") {
        if let Some(text) = content_val.as_str() {
            return (text.to_string(), String::new());
        }
        if let Some(arr) = content_val.as_array() {
            let texts: Vec<&str> = arr
                .iter()
                .filter_map(|item| {
                    let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    match item_type {
                        "content" => item
                            .get("content")
                            .and_then(|c| c.get("text"))
                            .and_then(|v| v.as_str()),
                        "text" => item.get("text").and_then(|v| v.as_str()),
                        _ => None,
                    }
                })
                .collect();
            if !texts.is_empty() {
                return (texts.join("\n"), String::new());
            }
        }
    }
    (String::new(), String::new())
}

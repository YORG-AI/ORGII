use std::collections::BTreeSet;

use core_types::activity::ActivityChunk;
use serde_json::Value;

use super::metadata::ImportedHistoryImpactStats;
use super::{ACTION_TYPE_TOOL_CALL, FUNCTION_EDIT_FILE};

/// Derive conservative file-impact metadata from normalized edit tool calls.
///
/// Source loaders remain responsible for recognizing their native tool names and
/// reshaping them to [`FUNCTION_EDIT_FILE`]. This collector intentionally ignores
/// failed edits and only counts line changes when the source exposes a diff or
/// before/after text.
pub fn impact_from_edit_chunks(chunks: &[ActivityChunk]) -> ImportedHistoryImpactStats {
    let mut touched_files = BTreeSet::new();
    let mut lines_added = 0_i64;
    let mut lines_removed = 0_i64;

    for chunk in chunks {
        if chunk.action_type != ACTION_TYPE_TOOL_CALL
            || chunk.function != FUNCTION_EDIT_FILE
            || edit_chunk_failed(chunk)
        {
            continue;
        }

        collect_edit_paths(&chunk.args, &mut touched_files);

        if let Some(patch) = find_string(&chunk.args, &["patch", "diff"]) {
            collect_patch_paths(patch, &mut touched_files);
            let (added, removed) = count_patch_lines(patch);
            lines_added += added;
            lines_removed += removed;
            continue;
        }

        let old = find_string(
            &chunk.args,
            &[
                "old_string",
                "oldString",
                "old_text",
                "oldText",
                "old_content",
                "oldContent",
            ],
        )
        .or_else(|| {
            find_string(
                &chunk.result,
                &[
                    "old_content",
                    "oldContent",
                    "before_content",
                    "beforeContent",
                ],
            )
        });
        let new = find_string(
            &chunk.args,
            &[
                "new_string",
                "newString",
                "new_text",
                "newText",
                "new_content",
                "newContent",
                "content",
            ],
        )
        .or_else(|| {
            find_string(
                &chunk.result,
                &["new_content", "newContent", "after_content", "afterContent"],
            )
        });

        if old.is_some() || new.is_some() {
            lines_removed += old.map(nonempty_line_count).unwrap_or_default();
            lines_added += new.map(nonempty_line_count).unwrap_or_default();
        }
    }

    let touched_files = touched_files.into_iter().collect::<Vec<_>>();
    ImportedHistoryImpactStats {
        files_changed: touched_files.len() as i64,
        lines_added,
        lines_removed,
        touched_files,
    }
}

fn edit_chunk_failed(chunk: &ActivityChunk) -> bool {
    if chunk.result.get("success").and_then(Value::as_bool) == Some(false) {
        return true;
    }
    chunk
        .result
        .get("status")
        .and_then(Value::as_str)
        .is_some_and(|status| {
            matches!(
                status.trim().to_ascii_lowercase().as_str(),
                "failed" | "error" | "cancelled" | "canceled" | "rejected"
            )
        })
}

fn collect_edit_paths(value: &Value, paths: &mut BTreeSet<String>) {
    const PATH_KEYS: &[&str] = &[
        "file_path",
        "filePath",
        "path",
        "targetFile",
        "relativeWorkspacePath",
    ];
    let Some(object) = value.as_object() else {
        return;
    };
    for key in PATH_KEYS {
        if let Some(path) = object.get(*key).and_then(Value::as_str) {
            insert_touched_path(path, paths);
        }
    }
    if let Some(payload) = object.get("payload") {
        collect_edit_paths(payload, paths);
    }
}

fn find_string<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a str> {
    let object = value.as_object()?;
    for key in keys {
        if let Some(text) = object.get(*key).and_then(Value::as_str) {
            return Some(text);
        }
    }
    object
        .get("payload")
        .and_then(|payload| find_string(payload, keys))
}

fn collect_patch_paths(patch: &str, paths: &mut BTreeSet<String>) {
    for line in patch.lines() {
        let candidate = line
            .strip_prefix("*** Add File: ")
            .or_else(|| line.strip_prefix("*** Update File: "))
            .or_else(|| line.strip_prefix("*** Delete File: "))
            .or_else(|| line.strip_prefix("*** Move to: "))
            .or_else(|| line.strip_prefix("rename from "))
            .or_else(|| line.strip_prefix("rename to "))
            .or_else(|| line.strip_prefix("+++ "))
            .or_else(|| line.strip_prefix("--- "));
        if let Some(candidate) = candidate {
            insert_touched_path(candidate, paths);
        }
    }
}

fn insert_touched_path(path: &str, paths: &mut BTreeSet<String>) {
    let path = path.trim().trim_matches('"');
    let path = path
        .strip_prefix("a/")
        .or_else(|| path.strip_prefix("b/"))
        .unwrap_or(path);
    if !path.is_empty() && path != "/dev/null" {
        paths.insert(path.to_string());
    }
}

fn count_patch_lines(patch: &str) -> (i64, i64) {
    patch.lines().fold((0, 0), |(added, removed), line| {
        if line.starts_with("+++") || line.starts_with("---") {
            (added, removed)
        } else if line.starts_with('+') {
            (added + 1, removed)
        } else if line.starts_with('-') {
            (added, removed + 1)
        } else {
            (added, removed)
        }
    })
}

fn nonempty_line_count(text: &str) -> i64 {
    if text.is_empty() {
        0
    } else {
        text.lines().count() as i64
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn impact_collector_counts_normalized_edit_and_patch_paths() {
        let edit = ActivityChunk::new("session", ACTION_TYPE_TOOL_CALL, FUNCTION_EDIT_FILE)
            .with_args(json!({
                "file_path": "src/main.rs",
                "old_string": "old\nline",
                "new_string": "new\nline\nadded"
            }))
            .with_result(json!({"success": true, "status": "completed"}));
        let patch = ActivityChunk::new("session", ACTION_TYPE_TOOL_CALL, FUNCTION_EDIT_FILE)
            .with_args(json!({
                "payload": {"patch": "*** Update File: src/lib.rs\n*** Move to: src/moved.rs\n-old\n+new\n+extra"}
            }))
            .with_result(json!({"success": true}));

        let impact = impact_from_edit_chunks(&[edit, patch]);

        assert_eq!(
            impact.touched_files,
            vec!["src/lib.rs", "src/main.rs", "src/moved.rs"]
        );
        assert_eq!(impact.files_changed, 3);
        assert_eq!(impact.lines_added, 5);
        assert_eq!(impact.lines_removed, 3);
    }

    #[test]
    fn impact_collector_ignores_failed_edits() {
        let failed = ActivityChunk::new("session", ACTION_TYPE_TOOL_CALL, FUNCTION_EDIT_FILE)
            .with_args(json!({"file_path": "src/failed.rs", "new_string": "new"}))
            .with_result(json!({"success": true, "status": "failed"}));

        assert_eq!(impact_from_edit_chunks(&[failed]).files_changed, 0);
    }
}

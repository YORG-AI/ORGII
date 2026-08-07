//! File-resource interaction extraction shared by live hooks and history.
//!
//! Imported histories from Claude Code, Codex, Cursor, and ORG2's own event
//! cache all converge on [`ActivityChunk`]. Live hook adapters reduce vendor
//! payloads to the same tool-name/input/result boundary. Keeping the path and
//! action classifier here prevents capture methods from drifting apart.

use core_types::activity::ActivityChunk;
use serde_json::Value;

use crate::canonical::{ResourceAction, ResourceInteractionOutcome};
use crate::sources::imported_history::ACTION_TYPE_TOOL_CALL;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileInteractionCandidate {
    pub file_path: String,
    pub action: ResourceAction,
}

pub fn file_interactions_from_activity_chunk(
    chunk: &ActivityChunk,
) -> Vec<FileInteractionCandidate> {
    if chunk.action_type != ACTION_TYPE_TOOL_CALL {
        return Vec::new();
    }

    let mut interactions =
        file_interactions_from_tool(&chunk.function, &chunk.args, Some(&chunk.result));
    interactions.sort_by(|left, right| {
        left.file_path
            .cmp(&right.file_path)
            .then(left.action.as_str().cmp(right.action.as_str()))
    });
    interactions.dedup();
    interactions
}

pub fn interaction_outcome_from_activity_chunk(
    chunk: &ActivityChunk,
) -> ResourceInteractionOutcome {
    interaction_outcome_from_tool_result(&chunk.result)
}

/// Normalize the outcome fields used by every imported provider and ORG2's
/// native event cache. Keeping this independent from [`ActivityChunk`] lets
/// materialized turn projections share the exact same success semantics.
pub fn interaction_outcome_from_tool_result(result: &Value) -> ResourceInteractionOutcome {
    if result.get("success").and_then(Value::as_bool) == Some(false)
        || result
            .get("status")
            .and_then(Value::as_str)
            .is_some_and(|status| {
                matches!(
                    status.trim().to_ascii_lowercase().as_str(),
                    "failed" | "error" | "cancelled" | "canceled" | "rejected"
                )
            })
        || ["output", "content", "observation"]
            .into_iter()
            .filter_map(|field| result.get(field).and_then(Value::as_str))
            .any(|text| text.trim_start().to_ascii_lowercase().starts_with("error"))
    {
        ResourceInteractionOutcome::Failed
    } else {
        ResourceInteractionOutcome::Succeeded
    }
}

pub fn activity_chunk_source_event_id(
    chunk: &ActivityChunk,
    interaction: &FileInteractionCandidate,
) -> String {
    let base = chunk
        .result
        .get("call_id")
        .or_else(|| chunk.result.get("callId"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(&chunk.chunk_id);
    format!(
        "{base}:{}:{}",
        interaction.action.as_str(),
        interaction.file_path
    )
}

/// Extract file-resource candidates from the normalized tool boundary.
///
/// This intentionally accepts only already-isolated tool metadata. Callers
/// must not persist the raw values: they can contain commands or file content.
pub fn file_interactions_from_tool(
    tool_name: &str,
    tool_input: &Value,
    tool_result: Option<&Value>,
) -> Vec<FileInteractionCandidate> {
    let Some(default_action) = action_for_tool_name(tool_name) else {
        return Vec::new();
    };
    let successful_result = tool_result.and_then(|result| result.get("success"));
    let mut interactions = patch_text(tool_input)
        .or_else(|| tool_result.and_then(patch_text))
        .or_else(|| successful_result.and_then(patch_text))
        .map(patch_file_interactions)
        .unwrap_or_default();
    if interactions.is_empty() {
        interactions.extend(
            explicit_file_paths(tool_input)
                .into_iter()
                .chain(tool_result.into_iter().flat_map(explicit_file_paths))
                .chain(successful_result.into_iter().flat_map(explicit_file_paths))
                .map(|file_path| FileInteractionCandidate {
                    file_path,
                    action: default_action,
                }),
        );
    }
    // search-rows: turn cards surface only writes and reads, so search results
    // are no longer harvested. Restore with the sibling `search-rows` sites.
    // if default_action == ResourceAction::Search {
    //     interactions.extend(
    //         tool_result
    //             .into_iter()
    //             .chain(successful_result)
    //             .flat_map(search_result_paths)
    //             .map(|file_path| FileInteractionCandidate {
    //                 file_path,
    //                 action: ResourceAction::Search,
    //             }),
    //     );
    // }
    interactions.sort_by(|left, right| {
        left.file_path
            .cmp(&right.file_path)
            .then(left.action.as_str().cmp(right.action.as_str()))
    });
    interactions.dedup();
    interactions.truncate(1_000);
    interactions
}

pub fn action_for_tool_name(tool_name: &str) -> Option<ResourceAction> {
    let normalized = tool_name.to_ascii_lowercase();
    if normalized.contains("delete") || normalized.contains("remove_file") {
        Some(ResourceAction::Delete)
    } else if normalized.contains("rename") || normalized.contains("move_file") {
        Some(ResourceAction::Rename)
    } else if normalized.contains("create") {
        // Factory Droid uses the bare `Create` name while most providers use
        // `create_file`. A candidate is emitted only when a path is present,
        // so similarly named non-file tools remain harmless.
        Some(ResourceAction::Create)
    } else if normalized.contains("write")
        || normalized.contains("edit")
        || normalized.contains("patch")
        || normalized.contains("notebook")
        // `replace` covers the Gemini-family (Qwen Code) in-place edit tool.
        || normalized.contains("replace")
    {
        Some(ResourceAction::Write)
    } else if normalized.contains("read") || normalized.contains("view_file") {
        Some(ResourceAction::Read)
    // search-rows: classifying grep/search/glob as Search is disabled so the
    // interactions are never captured. Restore with the sibling `search-rows`
    // sites.
    // } else if normalized.contains("grep")
    //     || normalized.contains("search")
    //     || normalized.contains("glob")
    // {
    //     Some(ResourceAction::Search)
    } else {
        None
    }
}

pub fn explicit_file_paths(value: &Value) -> Vec<String> {
    const PATH_FIELDS: &[&str] = &[
        "file_path",
        "filePath",
        "path",
        "notebook_path",
        "notebookPath",
        "target_file",
        "targetFile",
        "relativeWorkspacePath",
    ];
    let mut paths = Vec::new();
    if let Some(object) = value.as_object() {
        for field in PATH_FIELDS {
            match object.get(*field) {
                Some(Value::String(path)) if !path.trim().is_empty() => paths.push(path.clone()),
                Some(Value::Array(values)) => paths.extend(
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .filter(|path| !path.trim().is_empty())
                        .map(str::to_string),
                ),
                _ => {}
            }
        }
    }
    paths.sort();
    paths.dedup();
    paths
}

// search-rows: kept intact but unused while search capture is disabled in
// `file_interactions_from_tool`. Drop the attribute when restoring.
#[allow(dead_code)]
fn search_result_paths(value: &Value) -> Vec<String> {
    const COLLECTION_FIELDS: &[&str] = &["matches", "results", "files", "filePaths"];
    const ITEM_PATH_FIELDS: &[&str] = &[
        "file",
        "path",
        "file_path",
        "filePath",
        "relativeWorkspacePath",
    ];
    let mut paths = Vec::new();
    let Some(object) = value.as_object() else {
        return paths;
    };
    for collection_field in COLLECTION_FIELDS {
        let Some(items) = object.get(*collection_field).and_then(Value::as_array) else {
            continue;
        };
        for item in items {
            if let Some(path) = item.as_str().filter(|path| !path.trim().is_empty()) {
                paths.push(path.to_string());
                continue;
            }
            let Some(item) = item.as_object() else {
                continue;
            };
            if let Some(path) = ITEM_PATH_FIELDS.iter().find_map(|field| {
                item.get(*field)
                    .and_then(Value::as_str)
                    .filter(|path| !path.trim().is_empty())
            }) {
                paths.push(path.to_string());
            }
        }
    }
    paths.sort();
    paths.dedup();
    paths
}

fn patch_text(value: &Value) -> Option<&str> {
    [
        "patch",
        "patch_text",
        "patchText",
        "diff",
        "command",
        "input",
    ]
    .into_iter()
    .find_map(|field| value.get(field).and_then(Value::as_str))
}

pub fn patch_file_interactions(patch: &str) -> Vec<FileInteractionCandidate> {
    let mut interactions = Vec::new();
    for line in patch.lines() {
        let trimmed = line.trim();
        let candidate = [
            ("*** Add File:", ResourceAction::Create),
            ("*** Update File:", ResourceAction::Write),
            ("*** Delete File:", ResourceAction::Delete),
            ("*** Move to:", ResourceAction::Rename),
        ]
        .into_iter()
        .find_map(|(prefix, action)| {
            trimmed
                .strip_prefix(prefix)
                .map(|path| (path.trim(), action))
        });
        if let Some((path, action)) = candidate {
            if !path.is_empty() {
                interactions.push(FileInteractionCandidate {
                    file_path: path.to_string(),
                    action,
                });
            }
        }
    }
    interactions
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sources::imported_history::{FUNCTION_EDIT_FILE, FUNCTION_READ_FILE};
    use serde_json::json;

    fn chunk(function: &str, args: Value) -> ActivityChunk {
        let mut chunk = ActivityChunk::new("session-1", ACTION_TYPE_TOOL_CALL, function);
        chunk.chunk_id = "chunk-1".to_string();
        chunk.args = args;
        chunk.result = json!({"success": true, "call_id": "tool-1"});
        chunk
    }

    #[test]
    fn extracts_normalized_read_and_stable_source_event_id() {
        let chunk = chunk(FUNCTION_READ_FILE, json!({"filePath": "src/lib.rs"}));
        let interactions = file_interactions_from_activity_chunk(&chunk);
        assert_eq!(
            interactions,
            vec![FileInteractionCandidate {
                file_path: "src/lib.rs".to_string(),
                action: ResourceAction::Read,
            }]
        );
        assert_eq!(
            activity_chunk_source_event_id(&chunk, &interactions[0]),
            "tool-1:read:src/lib.rs"
        );
    }

    #[test]
    fn preserves_per_file_patch_actions() {
        let chunk = chunk(
            FUNCTION_EDIT_FILE,
            json!({
                "patch": "*** Begin Patch\n*** Add File: src/new.rs\n+x\n*** Delete File: src/old.rs\n*** End Patch"
            }),
        );
        let interactions = file_interactions_from_activity_chunk(&chunk);
        assert_eq!(interactions.len(), 2);
        assert_eq!(interactions[0].action, ResourceAction::Create);
        assert_eq!(interactions[1].action, ResourceAction::Delete);
    }

    #[test]
    fn create_and_replace_tool_names_keep_protocol_actions() {
        // Factory Droid `Create` is a creation; Gemini-family (Qwen)
        // `replace` remains an in-place write.
        assert_eq!(action_for_tool_name("Create"), Some(ResourceAction::Create));
        assert_eq!(action_for_tool_name("replace"), Some(ResourceAction::Write));
        // A non-file tool that merely contains the word yields no path, so the
        // higher-level extractor drops it — but the classifier itself is lenient.
        assert!(
            file_interactions_from_tool("create_memory", &json!({"note": "x"}), None).is_empty()
        );
    }

    #[test]
    fn rename_keeps_protocol_action_and_search_is_not_captured() {
        assert_eq!(
            action_for_tool_name("rename_file"),
            Some(ResourceAction::Rename)
        );
        let renamed =
            file_interactions_from_tool("rename_file", &json!({"file_path": "src/old.rs"}), None);
        assert_eq!(renamed[0].action, ResourceAction::Rename);

        // search-rows: search tools are unclassified, so neither the queried
        // path nor the nested result paths become interactions.
        assert_eq!(action_for_tool_name("search_files"), None);
        let searched = file_interactions_from_tool(
            "search_files",
            &json!({"path": "src"}),
            Some(&json!({"success": {"results": [{"filePath": "src/lib.rs"}]}})),
        );
        assert!(searched.is_empty());
    }

    #[test]
    fn shared_tool_extraction_supports_hook_patch_commands() {
        let interactions = file_interactions_from_tool(
            "apply_patch",
            &json!({"command": "*** Begin Patch\n*** Update File: src/lib.rs\n+x\n*** End Patch"}),
            None,
        );
        assert_eq!(
            interactions,
            vec![FileInteractionCandidate {
                file_path: "src/lib.rs".to_string(),
                action: ResourceAction::Write,
            }]
        );
    }

    #[test]
    fn maps_failed_tool_results_to_failed_outcome() {
        let mut chunk = chunk(FUNCTION_EDIT_FILE, json!({"path": "src/lib.rs"}));
        chunk.result = json!({"success": false});
        assert_eq!(
            interaction_outcome_from_activity_chunk(&chunk),
            ResourceInteractionOutcome::Failed
        );
    }
}

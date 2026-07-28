//! Provider-neutral per-round resource and development metadata projection.
//!
//! Host applications feed normalized tool metadata into this projector and
//! may materialize the result in their own turn cache. Provider adapters do
//! not leak into the projection: Claude, Codex, Cursor, ORG2, and future
//! providers all converge on tool name/input/result plus a timestamp.
//!
//! The projection keeps both the full resource interaction summary
//! (read/search/write/create/delete/rename) and the edit-only file summary
//! used by review UI. Malformed JSON in one event is skipped rather than
//! failing the whole round.

use std::collections::HashMap;

use core_types::activity::ActivityChunk;
use core_types::extracted::{ExtractedGitArtifactData, GitArtifactKind};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::canonical::{ResourceAction, ResourceInteractionOutcome};
use crate::development_artifact::parse_git_artifacts_from_tool_payload;
use crate::resource_interaction::{
    action_for_tool_name, file_interactions_from_tool, interaction_outcome_from_tool_result,
};

const STATUS_CREATED: &str = "created";
const STATUS_DELETED: &str = "deleted";
const STATUS_MODIFIED: &str = "modified";

/// One file the round wrote to, with summed line stats. Serialized as the
/// camelCase shape the frontend `FileChangeInfo` expects.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TurnModifiedFile {
    pub path: String,
    pub file_name: String,
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
}

/// One privacy-safe aggregate for a path/action pair inside a round. Repeated
/// tool observations increment `count`; raw commands, results, query text, and
/// file contents never enter this projection.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TurnResourceInteraction {
    pub path: String,
    pub file_name: String,
    pub action: ResourceAction,
    pub outcome: ResourceInteractionOutcome,
    pub count: u32,
    pub first_occurred_at: String,
    pub last_occurred_at: String,
}

/// Owned per-round projection produced directly from an imported provider's
/// normalized activity stream. Hosts may map this into their own read cache or
/// wire type without persisting the provider transcript.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedTurnMetadata {
    pub turn_id: String,
    pub start_sequence: i64,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub status: String,
    pub user_preview: String,
    pub event_count: i64,
    pub body_event_count: i64,
    pub modified_files: Vec<TurnModifiedFile>,
    pub resource_interactions: Vec<TurnResourceInteraction>,
    pub git_artifacts: Vec<ExtractedGitArtifactData>,
}

/// Mutable, order-preserving Orgtrack projection for one conversational
/// round. It is provider-neutral and safe to embed in a host's materialized
/// turn cache.
#[derive(Debug, Default, Clone)]
pub struct TurnMetadataAccumulator {
    modified_files: Vec<TurnModifiedFile>,
    resource_interactions: Vec<TurnResourceInteraction>,
    resource_index: HashMap<(String, ResourceAction, ResourceInteractionOutcome), usize>,
    git_artifacts: Vec<ExtractedGitArtifactData>,
    artifact_index: HashMap<String, usize>,
}

impl TurnMetadataAccumulator {
    pub fn new() -> Self {
        Self::default()
    }

    /// Fold one normalized tool event when no source timestamp is available.
    pub fn add_event(&mut self, function_name: Option<&str>, args_json: &str, result_json: &str) {
        self.add_event_at(function_name, args_json, result_json, "");
    }

    /// Fold one normalized tool event into the round projection.
    pub fn add_event_at(
        &mut self,
        function_name: Option<&str>,
        args_json: &str,
        result_json: &str,
        occurred_at: &str,
    ) {
        let Some(function_name) = function_name else {
            return;
        };
        let args = serde_json::from_str::<Value>(args_json).unwrap_or(Value::Null);
        let result = serde_json::from_str::<Value>(result_json).unwrap_or(Value::Null);
        let outcome = interaction_outcome_from_tool_result(&result);

        for interaction in file_interactions_from_tool(function_name, &args, Some(&result)) {
            self.merge_resource_interaction(
                interaction.file_path,
                interaction.action,
                outcome,
                occurred_at,
            );
        }

        if outcome != ResourceInteractionOutcome::Failed {
            for change in extract_event_files(function_name, &args, &result) {
                self.merge_modified_file(change);
            }
        }

        for artifact in parse_git_artifacts_from_tool_payload(args_json, result_json) {
            self.merge_artifact(artifact);
        }
    }

    fn merge_modified_file(&mut self, change: TurnModifiedFile) {
        if change.path.is_empty() {
            return;
        }
        if let Some(existing) = self
            .modified_files
            .iter_mut()
            .find(|file| file.path == change.path)
        {
            existing.additions = existing.additions.saturating_add(change.additions);
            existing.deletions = existing.deletions.saturating_add(change.deletions);
            // Latest event wins for status: a create-then-edit shows the net
            // "created"/"modified" as it last appeared chronologically.
            existing.status = change.status;
            if existing.file_name.is_empty() {
                existing.file_name = change.file_name;
            }
        } else {
            self.modified_files.push(change);
        }
    }

    fn merge_resource_interaction(
        &mut self,
        path: String,
        action: ResourceAction,
        outcome: ResourceInteractionOutcome,
        occurred_at: &str,
    ) {
        if path.trim().is_empty() {
            return;
        }
        let key = (path.clone(), action, outcome);
        if let Some(index) = self.resource_index.get(&key).copied() {
            let existing = &mut self.resource_interactions[index];
            existing.count = existing.count.saturating_add(1);
            if existing.first_occurred_at.is_empty()
                || (!occurred_at.is_empty() && occurred_at < existing.first_occurred_at.as_str())
            {
                existing.first_occurred_at = occurred_at.to_string();
            }
            if occurred_at > existing.last_occurred_at.as_str() {
                existing.last_occurred_at = occurred_at.to_string();
            }
            return;
        }
        self.resource_index
            .insert(key, self.resource_interactions.len());
        self.resource_interactions.push(TurnResourceInteraction {
            file_name: file_name_for(&path),
            path,
            action,
            outcome,
            count: 1,
            first_occurred_at: occurred_at.to_string(),
            last_occurred_at: occurred_at.to_string(),
        });
    }

    fn merge_artifact(&mut self, artifact: ExtractedGitArtifactData) {
        let Some(key) = artifact_key(&artifact) else {
            return;
        };
        if let Some(index) = self.artifact_index.get(&key).copied() {
            merge_missing_artifact_fields(&mut self.git_artifacts[index], artifact);
            return;
        }
        self.artifact_index.insert(key, self.git_artifacts.len());
        self.git_artifacts.push(artifact);
    }

    pub fn modified_files(&self) -> &[TurnModifiedFile] {
        &self.modified_files
    }

    /// Compatibility name for hosts that only consume the edit projection.
    pub fn files(&self) -> &[TurnModifiedFile] {
        self.modified_files()
    }

    pub fn resource_interactions(&self) -> &[TurnResourceInteraction] {
        &self.resource_interactions
    }

    pub fn git_artifacts(&self) -> &[ExtractedGitArtifactData] {
        &self.git_artifacts
    }
}

#[derive(Debug)]
struct ImportedTurnDraft {
    turn_id: String,
    start_sequence: i64,
    started_at: String,
    ended_at: Option<String>,
    status: String,
    user_preview: String,
    event_count: i64,
    body_event_count: i64,
    metadata: TurnMetadataAccumulator,
}

impl ImportedTurnDraft {
    fn finish(self) -> ProjectedTurnMetadata {
        ProjectedTurnMetadata {
            turn_id: self.turn_id,
            start_sequence: self.start_sequence,
            started_at: self.started_at,
            ended_at: self.ended_at,
            status: self.status,
            user_preview: self.user_preview,
            event_count: self.event_count,
            body_event_count: self.body_event_count,
            modified_files: self.metadata.modified_files,
            resource_interactions: self.metadata.resource_interactions,
            git_artifacts: self.metadata.git_artifacts,
        }
    }
}

/// Project every user-message-bounded round from an existing imported-history
/// loader. Actor/execution-thread ids stay on their own dimension and are never
/// reused as conversational turn ids.
pub fn project_activity_chunks(chunks: &[ActivityChunk]) -> Vec<ProjectedTurnMetadata> {
    let mut rounds = Vec::new();
    let mut current: Option<ImportedTurnDraft> = None;

    for (sequence, chunk) in chunks.iter().enumerate() {
        if chunk.function == crate::sources::imported_history::FUNCTION_USER_MESSAGE {
            if let Some(mut completed) = current.take() {
                if completed.status == "pending" {
                    completed.status = "interrupted".to_string();
                    completed.ended_at = Some(chunk.created_at.clone());
                }
                rounds.push(completed.finish());
            }
            if chunk.chunk_id.trim().is_empty() {
                continue;
            }
            current = Some(ImportedTurnDraft {
                turn_id: chunk.chunk_id.clone(),
                start_sequence: sequence as i64,
                started_at: chunk.created_at.clone(),
                ended_at: Some(chunk.created_at.clone()),
                // Imported providers without explicit lifecycle events are
                // historical snapshots, so preserve their settled behavior.
                // Providers such as Codex immediately override this with the
                // hidden task_start marker emitted after the user message.
                status: "completed".to_string(),
                user_preview: activity_chunk_text(chunk),
                event_count: 1,
                body_event_count: 0,
                metadata: TurnMetadataAccumulator::new(),
            });
            continue;
        }

        let Some(turn) = current.as_mut() else {
            continue;
        };

        match chunk.action_type.as_str() {
            crate::sources::imported_history::ACTION_TYPE_TASK_START => {
                turn.status = "pending".to_string();
                turn.ended_at = None;
                continue;
            }
            crate::sources::imported_history::ACTION_TYPE_TASK_COMPLETED => {
                turn.status = "completed".to_string();
                turn.ended_at = Some(chunk.created_at.clone());
                continue;
            }
            crate::sources::imported_history::ACTION_TYPE_TASK_FAILED => {
                turn.status = "failed".to_string();
                turn.ended_at = Some(chunk.created_at.clone());
                continue;
            }
            _ => {}
        }

        turn.event_count = turn.event_count.saturating_add(1);
        turn.body_event_count = turn.body_event_count.saturating_add(1);
        if turn.status != "pending"
            && !chunk.created_at.is_empty()
            && turn
                .ended_at
                .as_deref()
                .is_none_or(|ended_at| chunk.created_at.as_str() > ended_at)
        {
            turn.ended_at = Some(chunk.created_at.clone());
        }
        let args_json = serde_json::to_string(&chunk.args).unwrap_or_else(|_| "null".to_string());
        let result_json =
            serde_json::to_string(&chunk.result).unwrap_or_else(|_| "null".to_string());
        turn.metadata.add_event_at(
            Some(&chunk.function),
            &args_json,
            &result_json,
            &chunk.created_at,
        );
    }

    if let Some(completed) = current {
        rounds.push(completed.finish());
    }
    rounds
}

fn activity_chunk_text(chunk: &ActivityChunk) -> String {
    ["content", "message", "prompt", "text", "query"]
        .into_iter()
        .find_map(|field| chunk.args.get(field).and_then(Value::as_str))
        .or_else(|| chunk.args.as_str())
        .unwrap_or_default()
        .to_string()
}

/// Provider-neutral modification predicate used by tests and host adapters.
pub fn is_file_modify_function(name: &str) -> bool {
    action_for_tool_name(name).is_some_and(is_modifying_action)
}

fn is_modifying_action(action: ResourceAction) -> bool {
    matches!(
        action,
        ResourceAction::Write
            | ResourceAction::Create
            | ResourceAction::Delete
            | ResourceAction::Rename
    )
}

fn status_for_interaction(name: &str, action: ResourceAction) -> &'static str {
    match action {
        ResourceAction::Create => STATUS_CREATED,
        ResourceAction::Delete => STATUS_DELETED,
        _ if name.to_ascii_lowercase().contains("create") => STATUS_CREATED,
        _ => STATUS_MODIFIED,
    }
}

fn file_name_for(path: &str) -> String {
    path.rsplit(['/', '\\']).next().unwrap_or(path).to_string()
}

/// Read a non-negative line count from `result_json`, checking top-level and
/// the nested `success` object the file extractors write to.
fn read_lines(result: &serde_json::Value, key: &str) -> u32 {
    let direct = result.get(key).and_then(serde_json::Value::as_u64);
    let nested = result
        .get("success")
        .and_then(|success| success.get(key))
        .and_then(serde_json::Value::as_u64);
    direct.or(nested).unwrap_or(0) as u32
}

fn content_line_count(args: &serde_json::Value) -> u32 {
    args.get("new_string")
        .and_then(serde_json::Value::as_str)
        .or_else(|| args.get("content").and_then(serde_json::Value::as_str))
        .or_else(|| args.get("insert_text").and_then(serde_json::Value::as_str))
        .or_else(|| args.get("file_text").and_then(serde_json::Value::as_str))
        .map(|content| content.lines().count().max(1) as u32)
        .unwrap_or(0)
}

fn fallback_line_stats(
    function_name: &str,
    action: ResourceAction,
    args: &serde_json::Value,
) -> (u32, u32) {
    let line_count = content_line_count(args);
    if line_count == 0 {
        return (0, 0);
    }

    let normalized = function_name.to_ascii_lowercase();
    match action {
        ResourceAction::Delete => (0, line_count),
        _ if normalized.contains("edit") || normalized.contains("replace") => {
            let removed = args
                .get("old_string")
                .and_then(serde_json::Value::as_str)
                .or_else(|| args.get("old_str").and_then(serde_json::Value::as_str))
                .map(|content| content.lines().count().max(1) as u32)
                .unwrap_or(0);
            (line_count, removed)
        }
        _ => (line_count, 0),
    }
}

fn extract_event_files(function_name: &str, args: &Value, result: &Value) -> Vec<TurnModifiedFile> {
    let is_patch = function_name.to_ascii_lowercase().contains("patch")
        || args
            .get("action")
            .and_then(Value::as_str)
            .is_some_and(|action| action.to_ascii_lowercase().contains("patch"))
        || args.get("patch_text").is_some()
        || args.get("patch").is_some();
    if is_patch {
        return extract_patch_files(args, result);
    }

    file_interactions_from_tool(function_name, args, Some(result))
        .into_iter()
        .filter(|interaction| is_modifying_action(interaction.action))
        .map(|interaction| {
            let result_additions = read_lines(result, "linesAdded");
            let result_deletions = read_lines(result, "linesRemoved");
            let (fallback_additions, fallback_deletions) =
                if result_additions == 0 && result_deletions == 0 {
                    fallback_line_stats(function_name, interaction.action, args)
                } else {
                    (0, 0)
                };
            TurnModifiedFile {
                file_name: file_name_for(&interaction.file_path),
                status: status_for_interaction(function_name, interaction.action).to_string(),
                additions: result_additions.saturating_add(fallback_additions),
                deletions: result_deletions.saturating_add(fallback_deletions),
                path: interaction.file_path,
            }
        })
        .collect()
}

/// apply_patch can touch multiple files. Prefer the structured `segments`
/// result (carries per-file line stats), then parse `patch_text` so fallback
/// rows still carry per-file line stats. Use `filePaths` only when the patch
/// text is unavailable.
fn extract_patch_files(
    args: &serde_json::Value,
    result: &serde_json::Value,
) -> Vec<TurnModifiedFile> {
    if let Some(segments) = result
        .get("segments")
        .or_else(|| {
            result
                .get("success")
                .and_then(|value| value.get("segments"))
        })
        .and_then(serde_json::Value::as_array)
    {
        let mut files = Vec::new();
        for segment in segments {
            let path = segment
                .get("filePath")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_string();
            if path.is_empty() {
                continue;
            }
            let is_deleted = segment
                .get("isDeleted")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            files.push(TurnModifiedFile {
                file_name: file_name_for(&path),
                status: if is_deleted {
                    STATUS_DELETED
                } else {
                    STATUS_MODIFIED
                }
                .to_string(),
                additions: read_lines(segment, "linesAdded"),
                deletions: read_lines(segment, "linesRemoved"),
                path,
            });
        }
        if !files.is_empty() {
            return files;
        }
    }

    let patch_text = args
        .get("patch_text")
        .or_else(|| args.get("patch"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let patch_files = extract_files_from_patch_text(patch_text);
    if !patch_files.is_empty() {
        return patch_files;
    }

    if let Some(paths) = result
        .get("filePaths")
        .and_then(serde_json::Value::as_array)
    {
        let collected: Vec<TurnModifiedFile> = paths
            .iter()
            .filter_map(serde_json::Value::as_str)
            .filter(|path| !path.is_empty())
            .map(|path| TurnModifiedFile {
                file_name: file_name_for(path),
                status: STATUS_MODIFIED.to_string(),
                additions: 0,
                deletions: 0,
                path: path.to_string(),
            })
            .collect();
        if !collected.is_empty() {
            return collected;
        }
    }

    Vec::new()
}

fn extract_files_from_patch_text(patch_text: &str) -> Vec<TurnModifiedFile> {
    let mut files: Vec<TurnModifiedFile> = Vec::new();
    let mut current_path: Option<String> = None;

    for line in patch_text.lines() {
        let trimmed = line.trim();
        let header_path = trimmed
            .strip_prefix("*** Add File:")
            .or_else(|| trimmed.strip_prefix("*** Update File:"))
            .or_else(|| trimmed.strip_prefix("*** Delete File:"))
            .or_else(|| trimmed.strip_prefix("+++ b/"))
            .or_else(|| trimmed.strip_prefix("--- a/"))
            .map(str::trim)
            .filter(|path| !path.is_empty() && *path != "/dev/null");

        if let Some(path) = header_path {
            let path = path.to_string();
            if !files.iter().any(|seen| seen.path == path) {
                files.push(TurnModifiedFile {
                    file_name: file_name_for(&path),
                    status: STATUS_MODIFIED.to_string(),
                    additions: 0,
                    deletions: 0,
                    path: path.clone(),
                });
            }
            current_path = Some(path);
            continue;
        }

        let Some(path) = current_path.as_deref() else {
            continue;
        };
        if line.starts_with('+') && !line.starts_with("+++") {
            if let Some(file) = files.iter_mut().find(|file| file.path == path) {
                file.additions = file.additions.saturating_add(1);
            }
        } else if line.starts_with('-') && !line.starts_with("---") {
            if let Some(file) = files.iter_mut().find(|file| file.path == path) {
                file.deletions = file.deletions.saturating_add(1);
            }
        }
    }

    files
}

fn artifact_key(artifact: &ExtractedGitArtifactData) -> Option<String> {
    match artifact.kind {
        GitArtifactKind::Commit => artifact
            .sha
            .as_ref()
            .filter(|sha| !sha.trim().is_empty())
            .map(|sha| format!("commit:{}", sha.to_ascii_lowercase())),
        GitArtifactKind::PullRequest => artifact
            .repo_full_name
            .as_ref()
            .zip(artifact.pr_number)
            .map(|(repo, number)| format!("pr:{}#{number}", repo.to_ascii_lowercase()))
            .or_else(|| artifact.url.as_ref().map(|url| format!("pr:{url}"))),
    }
}

fn merge_missing_artifact_fields(
    existing: &mut ExtractedGitArtifactData,
    incoming: ExtractedGitArtifactData,
) {
    if existing.url.is_none() {
        existing.url = incoming.url;
    }
    if existing.repo_full_name.is_none() {
        existing.repo_full_name = incoming.repo_full_name;
    }
    if existing.sha.is_none() {
        existing.sha = incoming.sha;
    }
    if existing.short_sha.is_none() {
        existing.short_sha = incoming.short_sha;
    }
    if existing.subject.is_none() {
        existing.subject = incoming.subject;
    }
    if existing.pr_number.is_none() {
        existing.pr_number = incoming.pr_number;
    }
    if existing.pr_title.is_none() {
        existing.pr_title = incoming.pr_title;
    }
    if existing.source_branch.is_none() {
        existing.source_branch = incoming.source_branch;
    }
    if existing.target_branch.is_none() {
        existing.target_branch = incoming.target_branch;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignores_read_only_and_unknown_tools() {
        let mut acc = TurnMetadataAccumulator::new();
        acc.add_event(Some("read_file"), r#"{"file_path":"a.rs"}"#, "{}");
        acc.add_event(None, "{}", "{}");
        assert!(acc.files().is_empty());
    }

    #[test]
    fn edit_file_extracts_path_and_line_stats() {
        let mut acc = TurnMetadataAccumulator::new();
        acc.add_event(
            Some("edit_file"),
            r#"{"file_path":"src/foo.rs"}"#,
            r#"{"success":{"linesAdded":3,"linesRemoved":1}}"#,
        );
        let files = acc.files();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "src/foo.rs");
        assert_eq!(files[0].file_name, "foo.rs");
        assert_eq!(files[0].status, "modified");
        assert_eq!(files[0].additions, 3);
        assert_eq!(files[0].deletions, 1);
    }

    #[test]
    fn create_and_delete_status_mapping() {
        let mut acc = TurnMetadataAccumulator::new();
        acc.add_event(Some("create_file"), r#"{"file_path":"new.ts"}"#, "{}");
        acc.add_event(Some("delete_file"), r#"{"file_path":"old.ts"}"#, "{}");
        let files = acc.files();
        assert_eq!(files[0].status, "created");
        assert_eq!(files[1].status, "deleted");
    }

    #[test]
    fn file_name_supports_provider_paths_from_both_platforms() {
        assert_eq!(file_name_for("src/lib.rs"), "lib.rs");
        assert_eq!(file_name_for(r"C:\repo\src\lib.rs"), "lib.rs");
    }

    #[test]
    fn create_file_falls_back_to_content_line_count() {
        let mut acc = TurnMetadataAccumulator::new();
        acc.add_event(
            Some("create_file"),
            r#"{"file_path":"note.md","content":"one\ntwo\nthree"}"#,
            "{}",
        );
        let files = acc.files();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].status, "created");
        assert_eq!(files[0].additions, 3);
        assert_eq!(files[0].deletions, 0);
    }

    #[test]
    fn duplicate_path_merges_and_sums() {
        let mut acc = TurnMetadataAccumulator::new();
        acc.add_event(
            Some("edit_file"),
            r#"{"file_path":"a.rs"}"#,
            r#"{"linesAdded":2,"linesRemoved":0}"#,
        );
        acc.add_event(
            Some("edit_file"),
            r#"{"file_path":"a.rs"}"#,
            r#"{"linesAdded":5,"linesRemoved":3}"#,
        );
        let files = acc.files();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].additions, 7);
        assert_eq!(files[0].deletions, 3);
    }

    #[test]
    fn error_result_is_skipped() {
        let mut acc = TurnMetadataAccumulator::new();
        acc.add_event(
            Some("edit_file"),
            r#"{"file_path":"a.rs"}"#,
            r#"{"content":"Error: permission denied"}"#,
        );
        assert!(acc.files().is_empty());
    }

    #[test]
    fn apply_patch_uses_segments() {
        let mut acc = TurnMetadataAccumulator::new();
        acc.add_event(
            Some("apply_patch"),
            r#"{"patch_text":"*** Update File: a.rs\n"}"#,
            r#"{"segments":[
                {"filePath":"a.rs","linesAdded":4,"linesRemoved":1},
                {"filePath":"b.rs","isDeleted":true}
            ]}"#,
        );
        let files = acc.files();
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].path, "a.rs");
        assert_eq!(files[0].additions, 4);
        assert_eq!(files[1].path, "b.rs");
        assert_eq!(files[1].status, "deleted");
    }

    #[test]
    fn apply_patch_falls_back_to_patch_text_with_line_stats() {
        let mut acc = TurnMetadataAccumulator::new();
        acc.add_event(
            Some("apply_patch"),
            r#"{"patch_text":"*** Add File: x.rs\n+one\n+two\n*** Update File: y.rs\n-old\n+new\n context\n"}"#,
            "{}",
        );
        let files = acc.files();
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["x.rs", "y.rs"]);
        assert_eq!(files[0].additions, 2);
        assert_eq!(files[0].deletions, 0);
        assert_eq!(files[1].additions, 1);
        assert_eq!(files[1].deletions, 1);
    }

    #[test]
    fn apply_patch_prefers_patch_text_stats_over_file_paths() {
        let mut acc = TurnMetadataAccumulator::new();
        acc.add_event(
            Some("apply_patch"),
            r#"{"patch_text":"*** Update File: a.rs\n-old\n+new\n+extra\n"}"#,
            r#"{"filePaths":["a.rs"]}"#,
        );
        let files = acc.files();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "a.rs");
        assert_eq!(files[0].additions, 2);
        assert_eq!(files[0].deletions, 1);
    }

    #[test]
    fn normalized_codex_edit_file_keeps_apply_patch_line_stats() {
        let mut acc = TurnMetadataAccumulator::new();
        acc.add_event(
            Some("edit_file_by_replace"),
            r#"{"action":"apply_patch","patch_text":"*** Update File: src/app.ts\n-old\n+new\n+extra\n"}"#,
            r#"{"filePaths":["src/app.ts"]}"#,
        );

        let files = acc.files();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "src/app.ts");
        assert_eq!(files[0].additions, 2);
        assert_eq!(files[0].deletions, 1);
    }

    #[test]
    fn malformed_json_is_tolerated() {
        let mut acc = TurnMetadataAccumulator::new();
        acc.add_event(Some("edit_file"), "{not json", "{also not json");
        assert!(acc.files().is_empty());
    }

    #[test]
    fn folds_read_metadata_and_drops_searches_across_provider_tool_names() {
        let mut acc = TurnMetadataAccumulator::new();
        acc.add_event_at(
            Some("Read"),
            r#"{"file_path":"src/lib.rs"}"#,
            "{}",
            "2026-07-15T00:00:01Z",
        );
        acc.add_event_at(
            Some("Grep"),
            r#"{"path":"src"}"#,
            r#"{"matches":[{"file":"src/lib.rs"},{"path":"src/main.rs"}]}"#,
            "2026-07-15T00:00:02Z",
        );

        // search-rows: only the read survives — the Grep contributes neither its
        // queried path nor the paths named in its matches.
        let interactions = acc.resource_interactions();
        assert_eq!(interactions.len(), 1);
        assert!(interactions.iter().any(|item| {
            item.path == "src/lib.rs"
                && item.action == ResourceAction::Read
                && item.outcome == ResourceInteractionOutcome::Succeeded
        }));
        assert!(!interactions
            .iter()
            .any(|item| item.action == ResourceAction::Search));
    }

    #[test]
    fn records_failed_observation_but_does_not_claim_a_modification() {
        let mut acc = TurnMetadataAccumulator::new();
        acc.add_event_at(
            Some("replace"),
            r#"{"file_path":"src/lib.rs","new_string":"replacement"}"#,
            r#"{"content":"Error: permission denied"}"#,
            "2026-07-15T00:00:03Z",
        );

        assert!(acc.modified_files().is_empty());
        assert_eq!(acc.resource_interactions().len(), 1);
        assert_eq!(
            acc.resource_interactions()[0].outcome,
            ResourceInteractionOutcome::Failed
        );
    }

    #[test]
    fn shell_artifacts_are_projected_without_host_tool_constants() {
        let mut acc = TurnMetadataAccumulator::new();
        acc.add_event(
            Some("Bash"),
            r#"{"command":"git commit -m metadata"}"#,
            r#"{"success":{"command":"git commit -m metadata","stdout":"[feature abc1234] metadata","exitCode":0}}"#,
        );

        assert_eq!(acc.git_artifacts().len(), 1);
        assert_eq!(acc.git_artifacts()[0].sha.as_deref(), Some("abc1234"));
    }

    #[test]
    fn imported_activity_projection_uses_user_messages_not_execution_threads() {
        let mut first_user = ActivityChunk::new("session-1", "raw", "user_message");
        first_user.chunk_id = "user-1".to_string();
        first_user.created_at = "2026-07-15T00:00:00Z".to_string();
        first_user.args = serde_json::json!({"content": "inspect the code"});
        let mut read = ActivityChunk::new("session-1", "tool_call", "Read");
        read.chunk_id = "read-1".to_string();
        read.thread_id = Some("subagent-9".to_string());
        read.created_at = "2026-07-15T00:00:01Z".to_string();
        read.args = serde_json::json!({"file_path": "src/lib.rs"});
        let mut second_user = ActivityChunk::new("session-1", "raw", "user_message");
        second_user.chunk_id = "user-2".to_string();
        second_user.created_at = "2026-07-15T00:01:00Z".to_string();
        second_user.args = serde_json::json!({"content": "now edit it"});
        let mut edit = ActivityChunk::new("session-1", "tool_call", "replace");
        edit.chunk_id = "edit-1".to_string();
        edit.thread_id = Some("subagent-10".to_string());
        edit.created_at = "2026-07-15T00:01:01Z".to_string();
        edit.args = serde_json::json!({
            "file_path": "src/lib.rs",
            "old_string": "old",
            "new_string": "new"
        });

        let rounds = project_activity_chunks(&[first_user, read, second_user, edit]);

        assert_eq!(rounds.len(), 2);
        assert_eq!(rounds[0].turn_id, "user-1");
        assert_eq!(rounds[1].turn_id, "user-2");
        assert_eq!(
            rounds[0].resource_interactions[0].action,
            ResourceAction::Read
        );
        assert_eq!(rounds[1].modified_files[0].path, "src/lib.rs");
    }

    #[test]
    fn lifecycle_markers_keep_active_tail_pending_until_completion() {
        let mut user = ActivityChunk::new("session-1", "raw", "user_message");
        user.chunk_id = "user-1".to_string();
        user.created_at = "2026-07-15T00:00:00Z".to_string();
        user.args = serde_json::json!({"content": "edit it"});
        let mut start = ActivityChunk::new("session-1", "task_start", "task_start");
        start.created_at = "2026-07-15T00:00:00Z".to_string();
        let mut edit = ActivityChunk::new("session-1", "tool_call", "edit_file");
        edit.created_at = "2026-07-15T00:00:01Z".to_string();
        edit.args = serde_json::json!({"file_path": "src/lib.rs", "content": "new"});

        let active = project_activity_chunks(&[user.clone(), start.clone(), edit.clone()]);
        assert_eq!(active[0].status, "pending");
        assert_eq!(active[0].ended_at, None);

        let mut complete = ActivityChunk::new("session-1", "task_completed", "task_completed");
        complete.created_at = "2026-07-15T00:00:02Z".to_string();
        let completed = project_activity_chunks(&[user, start, edit, complete]);
        assert_eq!(completed[0].status, "completed");
        assert_eq!(
            completed[0].ended_at.as_deref(),
            Some("2026-07-15T00:00:02Z")
        );
        assert_eq!(completed[0].event_count, 2);
    }
}

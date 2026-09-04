//! Unified file editing tool — create/overwrite OR search-and-replace with 9 fallback strategies.
//!
//! Two modes:
//! - **Create/Overwrite**: Provide `file_path` + `content` → writes the entire file.
//! - **Search-Replace**: Provide `file_path` + `old_string` + `new_string` → fuzzy find-and-replace.
//!
//! See [`strategies`] for the 9 replacement strategies.

use async_trait::async_trait;
use parking_lot::RwLock;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;

use crate::session::workspace::SessionWorkspace;
use crate::tools::names as tool_names;
use crate::tools::traits::{params_schema, parse_params, Tool, ToolError};

type WorkspaceStateHandle = Arc<RwLock<SessionWorkspace>>;

pub(crate) mod strategies;

use strategies::replace;

fn is_notebook_path(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("ipynb"))
}

/// Parameters for the edit_file tool.
///
/// Two modes of operation:
/// - **Create/Overwrite**: Provide `file_path` + `content`
/// - **Edit (search-replace)**: Provide `file_path` + `old_string` + `new_string`
#[derive(Debug, Deserialize, JsonSchema)]
pub struct EditFileParams {
    /// Absolute path to the file
    pub file_path: String,

    /// Full content to write (create/overwrite mode). Omit when using edit mode.
    #[serde(default)]
    pub content: Option<String>,

    /// The text to find and replace (edit mode). Must exist in the file.
    #[serde(default)]
    pub old_string: Option<String>,

    /// The replacement text (edit mode). Must differ from old_string.
    #[serde(default)]
    pub new_string: Option<String>,

    /// Replace all occurrences instead of requiring a unique match (default: false)
    #[serde(default)]
    pub replace_all: bool,
}

/// Edit tool: create/overwrite files OR fuzzy search-and-replace.
#[derive(Default)]
pub struct EditTool {
    workspace: Option<PathBuf>,
    /// Static extras pinned at construction (scratchpad).
    additional_allowed_dirs: Vec<PathBuf>,
    /// Live session workspace — merged with the static extras at call
    /// time so `/add-dir` mutations land without registry rebuilds.
    workspace_state: Option<WorkspaceStateHandle>,
}

impl EditTool {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_workspace(mut self, workspace: PathBuf) -> Self {
        self.workspace = Some(workspace);
        self
    }

    pub fn with_scratchpad(mut self, scratchpad_dir: PathBuf) -> Self {
        self.additional_allowed_dirs.push(scratchpad_dir);
        self
    }

    /// Attach the session's live `SessionWorkspace` so that directories
    /// added via `/add-dir` become writeable without rebuilding the
    /// tool registry.
    pub fn with_workspace_state(mut self, state: WorkspaceStateHandle) -> Self {
        self.workspace_state = Some(state);
        self
    }
}

#[async_trait]
impl Tool for EditTool {
    fn name(&self) -> &str {
        tool_names::EDIT_FILE
    }

    fn description(&self) -> &str {
        "Create, overwrite, or edit files with fuzzy search-and-replace.\n\n\
         **Create/Overwrite mode**: provide `file_path` + `content`.\n\
         Creates the file and parent directories if they don't exist. Overwrites if the file exists.\n\n\
         **Edit mode** (search-and-replace): provide `file_path` + `old_string` + `new_string`.\n\
         - You MUST use read_file at least once before editing. Never edit blind.\n\
         - Preserve the exact indentation (tabs/spaces) as it appears in the file.\n\
         - The edit will FAIL if old_string is not found in the file.\n\
         - The edit will FAIL if old_string matches multiple locations (provide more context).\n\
         - The tool tries 9 fuzzy matching strategies (whitespace, indentation, escapes).\n\
         - Use replace_all: true to rename variables or replace all occurrences.\n\
         - Only use emojis if the user explicitly requests them."
    }

    fn llm_description(&self) -> Option<String> {
        let workspace = self.workspace.as_ref().map(|p| p.display().to_string())?;
        Some(format!(
            "Create, overwrite, or edit files in {workspace} with fuzzy search-and-replace. \
             ALWAYS use this tool for file modifications — NEVER use `sed`, `awk`, `echo >`, or heredocs \
             through the shell tool.\n\n\
             **Create/Overwrite mode**: provide `file_path` + `content`.\n\
             **Edit mode**: provide `file_path` + `old_string` + `new_string`.\n\
             - You MUST use read_file at least once before editing. Never edit blind.\n\
             - Preserve exact indentation (tabs/spaces) as in the file.\n\
             - FAIL if old_string not found — re-read the file and copy the exact text.\n\
             - FAIL if old_string matches multiple locations — include more surrounding lines to make it \
             unique, or pass replace_all: true to change every occurrence (e.g. renaming a variable).\n\
             - Fuzzy matching (9 strategies) tolerates whitespace/indentation drift, not content differences.\n\
             - old_string must differ from new_string.\n\
             - read_file output has a line-number prefix (e.g. \"     1│\") — \
             never include this prefix in old_string; use only the actual file content after the │."
        ))
    }

    fn category(&self) -> &str {
        crate::tools::categories::CODING
    }

    fn parameters(&self) -> Value {
        params_schema::<EditFileParams>()
    }

    async fn execute_text(
        &self,
        params: Value,
        _ctx: &crate::tools::traits::CallContext,
    ) -> Result<String, ToolError> {
        let params: EditFileParams = parse_params(params)?;

        let file_path = params.file_path;
        let content = params.content;
        let old_string = params.old_string;
        let new_string = params.new_string;
        let replace_all = params.replace_all;

        // Disambiguate mode when a caller leaks both `content` and edit fields
        // (some providers emit sibling optional fields even for a pure
        // search-replace). Overwrite is destructive, so it must NOT be the
        // default resolution of an ambiguous call: only treat `content` as a
        // whole-file write when no non-empty edit fields are present. Empty
        // optional placeholders are ignored.
        let has_edit_fields = old_string.as_ref().is_some_and(|value| !value.is_empty())
            || new_string.as_ref().is_some_and(|value| !value.is_empty());
        let content = if has_edit_fields { None } else { content };

        if content.is_none() && old_string.as_deref() == Some("") {
            return Err(ToolError::InvalidParams(
                "'old_string' must not be empty".to_string(),
            ));
        }

        // Validate path against the live session workspace (single source
        // of truth): primary root = live working_dir(); extras = every
        // effective root (workspace_root, worktree working_dir, `/add-dir`
        // grants) + static scratchpad.
        let extras: Vec<PathBuf> = {
            let mut out = self.additional_allowed_dirs.clone();
            if let Some(ref state) = self.workspace_state {
                out.extend(state.read().effective_roots());
            }
            out
        };
        let allowed_dir = if self.workspace.is_some() {
            self.workspace_state
                .as_ref()
                .map(|state| state.read().working_dir().to_path_buf())
                .or_else(|| self.workspace.clone())
        } else {
            None
        };
        let resolved = crate::tool_infra::file::resolve_path_with_extras(
            &file_path,
            allowed_dir.as_deref(),
            &extras,
        )
        .map_err(|err| {
            if err.contains("outside the allowed directory") || err.contains("null byte") {
                ToolError::PermissionDenied(err)
            } else {
                ToolError::ExecutionFailed(err)
            }
        })?;

        // String-replacement edits on notebooks are unsafe: read_file renders
        // notebook cells as text while the file on disk is JSON, so
        // old_string can never match reliably. Full-content writes are fine —
        // they don't depend on the rendered view.
        if is_notebook_path(&resolved) && content.is_none() {
            return Err(ToolError::InvalidParams(
                "edit_file cannot do string-replacement edits on .ipynb notebooks: read_file renders notebook cells as text while the file on disk is JSON, so old_string will not match the raw file. Either rewrite the whole notebook by calling edit_file with the full JSON in `content`, or use run_shell (e.g. python/jq) for cell-level edits.".to_string(),
            ));
        }

        // Mode 1: Create/Overwrite
        if let Some(content) = content {
            if let Some(parent) = resolved.parent() {
                if !parent.as_os_str().is_empty() {
                    tokio::fs::create_dir_all(parent).await.map_err(|err| {
                        ToolError::ExecutionFailed(format!(
                            "Failed to create directories for {}: {}",
                            file_path, err
                        ))
                    })?;
                }
            }

            tokio::fs::write(&resolved, &content).await.map_err(|err| {
                ToolError::ExecutionFailed(format!("Failed to write {}: {}", file_path, err))
            })?;

            return Ok(format!("Written {} bytes to {}", content.len(), file_path));
        }

        // Mode 2: Edit (search-and-replace)
        let old_str = old_string.ok_or_else(|| {
            ToolError::InvalidParams(
                "Either 'content' (create/overwrite) or 'old_string'+'new_string' (edit) is required".to_string(),
            )
        })?;
        let new_str = new_string.unwrap_or_default();

        if old_str == new_str {
            return Err(ToolError::InvalidParams(
                "old_string and new_string are identical — no changes to apply".to_string(),
            ));
        }

        let file_content = tokio::fs::read_to_string(&resolved).await.map_err(|err| {
            ToolError::ExecutionFailed(format!("Failed to read {}: {}", file_path, err))
        })?;

        let new_content = replace(&file_content, &old_str, &new_str, replace_all)
            .map_err(ToolError::ExecutionFailed)?;

        tokio::fs::write(&resolved, &new_content)
            .await
            .map_err(|err| {
                ToolError::ExecutionFailed(format!("Failed to write {}: {}", file_path, err))
            })?;

        let diff_snippet = generate_edit_diff(&file_content, &new_content);
        Ok(format!("Edit applied to {}\n\n{}", file_path, diff_snippet))
    }
}

const MAX_DIFF_CHARS: usize = 2000;
const EDIT_DIFF_CONTEXT_LINES: usize = 2;

fn generate_edit_diff(old_content: &str, new_content: &str) -> String {
    use similar::TextDiff;

    let diff = TextDiff::from_lines(old_content, new_content)
        .unified_diff()
        .context_radius(EDIT_DIFF_CONTEXT_LINES)
        .to_string();

    let mut output = String::from("```diff\n");
    if diff.len() > MAX_DIFF_CHARS {
        let mut end = MAX_DIFF_CHARS;
        while !diff.is_char_boundary(end) && end > 0 {
            end -= 1;
        }
        output.push_str(&diff[..end]);
        if !output.ends_with('\n') {
            output.push('\n');
        }
        output.push_str("... (diff truncated)\n");
    } else {
        output.push_str(&diff);
        if !output.ends_with('\n') {
            output.push('\n');
        }
    }
    output.push_str("```");
    output
}

#[cfg(test)]
mod tests;

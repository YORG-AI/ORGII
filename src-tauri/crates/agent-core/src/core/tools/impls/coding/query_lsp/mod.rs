//! LSP tool — exposes language server features to the coding agent.
//!
//! Bridges the existing `lsp::LspManager` into the agent's tool loop.
//! Actions: diagnostics, definition, references, hover, document_symbol,
//! workspace_symbol.
//!
//! Layout:
//! - [`language`]  — file extension → LSP language ID + workspace root
//!   inference.
//! - [`format`]    — pure formatters for diagnostics / locations / hover
//!   responses.
//! - [`post_edit`] — `get_post_edit_diagnostics` hook called by the
//!   processor after every edit/write/patch tool.
//!
//! `mod.rs` itself owns the `LspTool` struct, document-version bookkeeping,
//! and the `Tool` impl that dispatches the four actions.

mod format;
mod language;
mod post_edit;
mod version;

use async_trait::async_trait;
use ignore::WalkBuilder;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tauri::AppHandle;
use tokio::sync::Mutex;

use crate::tools::names as tool_names;
use crate::tools::traits::{required_string, Tool, ToolError};
use lsp::LspManager;

// Bring submodule helpers into scope so the tool impl below reads naturally,
// and so unit tests in `tests.rs` can keep their `super::language_for_file`
// (etc.) call sites unchanged.
use format::{
    format_diagnostics, format_document_symbols, format_hover, format_locations,
    format_reference_locations, format_workspace_symbols,
};
use language::{
    document_language_id_for_file, infer_workspace_root, language_for_file, path_to_uri,
};
use version::DocumentVersionTracker;

pub use post_edit::get_post_edit_diagnostics;

#[cfg(test)]
mod tests;

/// LSP tool for the coding agent.
pub struct LspTool {
    lsp_manager: Arc<Mutex<LspManager>>,
    app_handle: AppHandle,
    workspace_root: PathBuf,
    document_versions: DocumentVersionTracker,
}

impl LspTool {
    pub fn new(
        lsp_manager: Arc<Mutex<LspManager>>,
        app_handle: AppHandle,
        workspace_root: PathBuf,
    ) -> Self {
        Self {
            lsp_manager,
            app_handle,
            workspace_root,
            document_versions: DocumentVersionTracker::new(),
        }
    }

    async fn ensure_server_ready(
        &self,
        manager: &LspManager,
        language: &str,
        file_path: &str,
    ) -> Result<bool, ToolError> {
        if manager.is_server_running(language).await {
            return Ok(false);
        }

        let root_path = infer_workspace_root(file_path, &self.workspace_root);
        let root_path_str = root_path.to_string_lossy().to_string();
        manager
            .start_server(language, &root_path_str, self.app_handle.clone())
            .await
            .map_err(|error| {
                ToolError::ExecutionFailed(format!(
                    "Failed to start LSP server for '{}': {}",
                    language, error
                ))
            })?;

        self.document_versions.reset(language).await;
        tokio::time::sleep(Duration::from_millis(250)).await;
        Ok(true)
    }

    async fn sync_document(
        &self,
        manager: &LspManager,
        language: &str,
        file_path: &str,
        uri: &str,
    ) -> Result<(), ToolError> {
        let content = tokio::fs::read_to_string(file_path)
            .await
            .map_err(|error| {
                ToolError::ExecutionFailed(format!(
                    "Failed to read '{}' for LSP sync: {}",
                    file_path, error
                ))
            })?;
        let document_language_id = document_language_id_for_file(file_path).ok_or_else(|| {
            ToolError::InvalidParams(format!(
                "Cannot determine document language for file: {}",
                file_path
            ))
        })?;
        let version = self.document_versions.next(language, uri).await;

        if version == 1 {
            manager
                .did_open(document_language_id, uri, version, &content)
                .await
                .map_err(|error| {
                    ToolError::ExecutionFailed(format!(
                        "Failed to open '{}' in LSP: {}",
                        file_path, error
                    ))
                })
        } else {
            manager
                .did_change(language, uri, version, &content)
                .await
                .map_err(|error| {
                    ToolError::ExecutionFailed(format!(
                        "Failed to update '{}' in LSP: {}",
                        file_path, error
                    ))
                })
        }
    }
}

#[async_trait]
impl Tool for LspTool {
    fn name(&self) -> &str {
        tool_names::QUERY_LSP
    }

    fn description(&self) -> &str {
        "Query language server for code intelligence.\n\n\
         Actions:\n\
         - `diagnostics` — get errors/warnings for one or more paths. `paths` accepts a list of \
           absolute file or directory paths; directories are walked recursively (gitignore-aware) \
           for files whose language is supported.\n\
         - `definition` — go to definition of symbol at line:character (requires `file_path`)\n\
         - `references` — find all references to symbol at line:character (requires `file_path`)\n\
         - `hover` — get type/documentation info at line:character (requires `file_path`)\n\
         - `document_symbol` — list symbols in a file (requires `file_path`)\n\
         - `workspace_symbol` — search symbols across the workspace (requires `file_path`; optional `query`)\n\n\
         Starts the language server on demand for each target file when needed. \
         Positions are 1-indexed (line 1, character 1 = first char of first line).\n\
         Use `diagnostics` after making changes to check for errors."
    }

    fn category(&self) -> &str {
        crate::tools::categories::CODING
    }

    fn parameters(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["diagnostics", "definition", "references", "hover", "document_symbol", "workspace_symbol"],
                    "description": "The LSP action to perform"
                },
                "paths": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Absolute file or directory paths. Required for action=diagnostics; directories are walked recursively honoring .gitignore."
                },
                "file_path": {
                    "type": "string",
                    "description": "Absolute path to the file. Required for action=definition/references/hover."
                },
                "line": {
                    "type": "integer",
                    "description": "Line number (1-indexed). Required for definition/references/hover."
                },
                "character": {
                    "type": "integer",
                    "description": "Character position (1-indexed). Required for definition/references/hover."
                },
                "query": {
                    "type": "string",
                    "description": "Search query for action=workspace_symbol. Empty string asks the server for all symbols it is willing to return."
                }
            },
            "required": ["action"]
        })
    }

    async fn execute_text(
        &self,
        params: Value,
        ctx: &crate::tools::traits::CallContext,
    ) -> Result<String, ToolError> {
        ctx.require_tool_authority(self.name())?;
        let action = required_string(&params, "action")?;

        match action.as_str() {
            "diagnostics" => self.run_diagnostics(&params).await,
            "definition" | "references" | "hover" | "document_symbol" | "workspace_symbol" => {
                self.run_code_intelligence_action(&action, &params).await
            }
            _ => Err(ToolError::InvalidParams(format!(
                "Unknown action '{}'. Use: diagnostics, definition, references, hover, document_symbol, workspace_symbol",
                action
            ))),
        }
    }
}

impl LspTool {
    async fn run_diagnostics(&self, params: &Value) -> Result<String, ToolError> {
        let raw_paths = extract_paths_param(params)?;
        let files = expand_diagnostic_paths(&raw_paths)?;
        if files.is_empty() {
            return Err(ToolError::InvalidParams(
                "No supported source files found under `paths`. \
                 Pass file paths directly or directories containing supported files."
                    .to_string(),
            ));
        }

        let manager = self.lsp_manager.lock().await;
        let mut blocks: Vec<String> = Vec::new();
        let mut total_diagnostics: usize = 0;
        let mut skipped: Vec<String> = Vec::new();

        for file_path in &files {
            let Some(language) = language_for_file(file_path) else {
                skipped.push(format!("{} (unsupported extension)", file_path));
                continue;
            };

            let uri = path_to_uri(file_path);
            let server_started = self
                .ensure_server_ready(&manager, language, file_path)
                .await?;
            self.sync_document(&manager, language, file_path, &uri)
                .await?;
            if server_started {
                tokio::time::sleep(Duration::from_millis(350)).await;
            }

            let diagnostics = manager
                .get_file_diagnostics(language, &uri)
                .await
                .map_err(ToolError::ExecutionFailed)?;
            if diagnostics.is_empty() {
                continue;
            }
            total_diagnostics += diagnostics.len();
            blocks.push(format!(
                "Diagnostics for {}:\n{}",
                file_path,
                format_diagnostics(&diagnostics)
            ));
        }

        if blocks.is_empty() {
            let mut output = format!("No diagnostics for {} file(s) checked.", files.len());
            if !skipped.is_empty() {
                output.push_str("\nSkipped:\n");
                for entry in &skipped {
                    output.push_str("  ");
                    output.push_str(entry);
                    output.push('\n');
                }
            }
            return Ok(output);
        }

        let mut output = blocks.join("\n\n");
        output.push_str(&format!(
            "\n\nSummary: {} diagnostic(s) across {} file(s) (checked {}).",
            total_diagnostics,
            blocks.len(),
            files.len()
        ));
        if !skipped.is_empty() {
            output.push_str("\nSkipped:\n");
            for entry in &skipped {
                output.push_str("  ");
                output.push_str(entry);
                output.push('\n');
            }
        }
        Ok(output)
    }

    async fn run_code_intelligence_action(
        &self,
        action: &str,
        params: &Value,
    ) -> Result<String, ToolError> {
        let file_path = required_string(params, "file_path").map_err(|_| {
            ToolError::InvalidParams(format!(
                "action '{}' requires `file_path` (absolute path to a single file)",
                action
            ))
        })?;

        let language = language_for_file(&file_path).ok_or_else(|| {
            ToolError::InvalidParams(format!(
                "Cannot determine language for file: {}. Unsupported file extension.",
                file_path
            ))
        })?;

        let uri = path_to_uri(&file_path);
        let manager = self.lsp_manager.lock().await;
        let server_started = self
            .ensure_server_ready(&manager, language, &file_path)
            .await?;
        self.sync_document(&manager, language, &file_path, &uri)
            .await?;
        if server_started {
            tokio::time::sleep(Duration::from_millis(350)).await;
        }

        match action {
            "definition" => {
                let (line, character) = extract_position(params)?;
                let result = manager
                    .goto_definition(language, &uri, line, character)
                    .await
                    .map_err(ToolError::ExecutionFailed)?;

                Ok(format!(
                    "Definition of symbol at {}:{}:{}:\n{}",
                    file_path,
                    line + 1,
                    character + 1,
                    format_locations(&result)
                ))
            }
            "references" => {
                let (line, character) = extract_position(params)?;
                let result = manager
                    .find_references(language, &uri, line, character, true)
                    .await
                    .map_err(ToolError::ExecutionFailed)?;

                let count = result.as_ref().map(|locs| locs.len()).unwrap_or(0);
                Ok(format!(
                    "References to symbol at {}:{}:{} ({} found):\n{}",
                    file_path,
                    line + 1,
                    character + 1,
                    count,
                    format_reference_locations(&result)
                ))
            }
            "hover" => {
                let (line, character) = extract_position(params)?;
                let result = manager
                    .hover(language, &uri, line, character)
                    .await
                    .map_err(ToolError::ExecutionFailed)?;

                Ok(format!(
                    "Hover info at {}:{}:{}:\n{}",
                    file_path,
                    line + 1,
                    character + 1,
                    format_hover(&result)
                ))
            }
            "document_symbol" => {
                let result = manager
                    .document_symbol(language, &uri)
                    .await
                    .map_err(ToolError::ExecutionFailed)?;

                Ok(format!(
                    "Document symbols for {}:\n{}",
                    file_path,
                    format_document_symbols(&result)
                ))
            }
            "workspace_symbol" => {
                let query = params.get("query").and_then(Value::as_str).unwrap_or("");
                let result = manager
                    .workspace_symbol(language, query)
                    .await
                    .map_err(ToolError::ExecutionFailed)?;

                Ok(format!(
                    "Workspace symbols matching {:?} from {}:\n{}",
                    query,
                    file_path,
                    format_workspace_symbols(&result)
                ))
            }
            other => Err(ToolError::InvalidParams(format!(
                "Unknown code intelligence action '{}'",
                other
            ))),
        }
    }
}

/// Read the `paths` parameter and return non-empty string entries.
/// Accepts a JSON array of strings, or a single string for convenience.
fn extract_paths_param(params: &Value) -> Result<Vec<String>, ToolError> {
    let raw = params.get("paths").ok_or_else(|| {
        ToolError::InvalidParams(
            "missing required parameter: paths (array of file or directory paths)".to_string(),
        )
    })?;

    let collected: Vec<String> = match raw {
        Value::Array(items) => items
            .iter()
            .filter_map(|value| value.as_str())
            .map(|entry| entry.trim().to_string())
            .filter(|entry| !entry.is_empty())
            .collect(),
        Value::String(single) => {
            let trimmed = single.trim();
            if trimmed.is_empty() {
                Vec::new()
            } else {
                vec![trimmed.to_string()]
            }
        }
        _ => {
            return Err(ToolError::InvalidParams(
                "`paths` must be an array of strings".to_string(),
            ))
        }
    };

    if collected.is_empty() {
        return Err(ToolError::InvalidParams(
            "`paths` must contain at least one non-empty path".to_string(),
        ));
    }
    Ok(collected)
}

/// Expand a mix of file and directory paths into a deduplicated, ordered
/// list of files whose language is supported. Directory walks are
/// gitignore-aware. Non-existent entries are returned as-is so the caller
/// can surface a precise error.
pub(super) fn expand_diagnostic_paths(raw_paths: &[String]) -> Result<Vec<String>, ToolError> {
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut files: Vec<String> = Vec::new();

    for entry in raw_paths {
        let path = Path::new(entry);
        if !path.exists() {
            return Err(ToolError::InvalidParams(format!(
                "Path does not exist: {}",
                entry
            )));
        }

        if path.is_file() {
            push_unique_file(entry.clone(), &mut seen, &mut files);
            continue;
        }

        if !path.is_dir() {
            continue;
        }

        let walker = WalkBuilder::new(path)
            .hidden(false)
            .git_ignore(true)
            .git_exclude(true)
            .parents(true)
            .build();
        for result in walker {
            let dir_entry = match result {
                Ok(value) => value,
                Err(_) => continue,
            };
            if !dir_entry
                .file_type()
                .is_some_and(|file_type| file_type.is_file())
            {
                continue;
            }
            let candidate = dir_entry.path().to_string_lossy().to_string();
            if language_for_file(&candidate).is_none() {
                continue;
            }
            push_unique_file(candidate, &mut seen, &mut files);
        }
    }

    Ok(files)
}

fn push_unique_file(
    candidate: String,
    seen: &mut std::collections::HashSet<String>,
    files: &mut Vec<String>,
) {
    if seen.insert(candidate.clone()) {
        files.push(candidate);
    }
}

/// Extract 1-indexed line/character from params, convert to 0-indexed for LSP.
fn extract_position(params: &Value) -> Result<(u32, u32), ToolError> {
    let line = params
        .get("line")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| ToolError::InvalidParams("missing required parameter: line".to_string()))?;
    let character = params
        .get("character")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| {
            ToolError::InvalidParams("missing required parameter: character".to_string())
        })?;

    if line == 0 {
        return Err(ToolError::InvalidParams(
            "line must be >= 1 (1-indexed)".to_string(),
        ));
    }
    if character == 0 {
        return Err(ToolError::InvalidParams(
            "character must be >= 1 (1-indexed)".to_string(),
        ));
    }

    Ok(((line - 1) as u32, (character - 1) as u32))
}

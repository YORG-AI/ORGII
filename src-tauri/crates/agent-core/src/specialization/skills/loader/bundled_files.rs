//! Bundled file management for skills.
//!
//! Single-file IPC entries (`skills_read_file`, `skills_write_file`,
//! `skills_delete_file`) were retired — the editor only ever talks to
//! the batch endpoints, and bundled-file deletion has no UI surface.

use std::fs;

use serde::{Deserialize, Serialize};

use super::helpers::{resolve_skill_dir, validate_relative_path};
use crate::session::prompt::cache::PromptCacheInvalidationReason;
use crate::skills::provenance::{is_internal_metadata, refresh_existing_consent};
use crate::state::AgentAppState;

// ============================================
// Batch File Operations
// ============================================

/// Result of reading a bundled file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundledFileContent {
    pub relative_path: String,
    pub content: String,
    pub error: Option<String>,
}

/// Read multiple bundled files from a skill directory in a single IPC call.
///
/// One IPC + one filesystem walk per call, regardless of file count.
#[tauri::command]
pub async fn skills_read_files_batch(
    skill_name: String,
    relative_paths: Vec<String>,
    workspace_path: Option<String>,
) -> Result<Vec<BundledFileContent>, String> {
    let skill_dir = resolve_skill_dir(&skill_name, workspace_path.as_deref())?;

    let results: Vec<BundledFileContent> = relative_paths
        .into_iter()
        .map(|relative_path| {
            if let Err(err) = validate_relative_path(&relative_path) {
                return BundledFileContent {
                    relative_path,
                    content: String::new(),
                    error: Some(err),
                };
            }

            let target = skill_dir.join(&relative_path);
            match fs::read_to_string(&target) {
                Ok(content) => BundledFileContent {
                    relative_path,
                    content,
                    error: None,
                },
                Err(err) => BundledFileContent {
                    relative_path,
                    content: String::new(),
                    error: Some(format!("File not found or unreadable: {}", err)),
                },
            }
        })
        .collect();

    Ok(results)
}

/// File to write in a batch operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundledFileWrite {
    pub relative_path: String,
    pub content: String,
}

/// Result of writing a bundled file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundledFileWriteResult {
    pub relative_path: String,
    pub success: bool,
    pub error: Option<String>,
}

/// Write multiple bundled files to a skill directory in a single IPC call.
///
/// One IPC + one filesystem walk per call, regardless of file count.
#[tauri::command]
pub async fn skills_write_files_batch(
    app_state: tauri::State<'_, AgentAppState>,
    skill_name: String,
    files: Vec<BundledFileWrite>,
    workspace_path: Option<String>,
) -> Result<Vec<BundledFileWriteResult>, String> {
    let skill_dir = resolve_skill_dir(&skill_name, workspace_path.as_deref())?;

    let results: Vec<BundledFileWriteResult> = files
        .into_iter()
        .map(|file| {
            if let Err(err) = validate_relative_path(&file.relative_path) {
                return BundledFileWriteResult {
                    relative_path: file.relative_path,
                    success: false,
                    error: Some(err),
                };
            }
            if is_internal_metadata(std::path::Path::new(&file.relative_path)) {
                return BundledFileWriteResult {
                    relative_path: file.relative_path,
                    success: false,
                    error: Some("Skill provenance/cache metadata is managed by ORGII".to_string()),
                };
            }

            let target = skill_dir.join(&file.relative_path);

            if let Some(parent) = target.parent() {
                if let Err(err) = fs::create_dir_all(parent) {
                    return BundledFileWriteResult {
                        relative_path: file.relative_path,
                        success: false,
                        error: Some(format!("Failed to create directory: {}", err)),
                    };
                }
            }

            match fs::write(&target, &file.content) {
                Ok(()) => BundledFileWriteResult {
                    relative_path: file.relative_path,
                    success: true,
                    error: None,
                },
                Err(err) => BundledFileWriteResult {
                    relative_path: file.relative_path,
                    success: false,
                    error: Some(format!("Failed to write file: {}", err)),
                },
            }
        })
        .collect();

    if results.iter().any(|result| result.success) {
        refresh_existing_consent(&skill_dir)?;
        super::scanner::SkillsLoader::invalidate_all_caches();
        app_state
            .invalidate_prompt_caches(PromptCacheInvalidationReason::SkillCatalogChanged)
            .await;
    }
    Ok(results)
}

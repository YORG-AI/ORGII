//! Tauri Commands for Component Index
//!
//! Provides commands for source-location indexing and global token scanning.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::RwLock;
use std::time::Instant;

use tauri::State;

use super::indexer::UiIndexer;
use super::parser::{TokenDefinitionExtractor, TokenDefinitionsResult};
use super::types::{ComponentLocation, UiIndex, UiIndexStats};

/// State for managing component indexes across repositories
pub struct UiIndexState {
    /// Map: repo_path → UiIndex
    pub indexes: RwLock<HashMap<PathBuf, UiIndex>>,
}

impl UiIndexState {
    /// Create a new empty state
    pub fn new() -> Self {
        Self {
            indexes: RwLock::new(HashMap::new()),
        }
    }
}

impl Default for UiIndexState {
    fn default() -> Self {
        Self::new()
    }
}

/// Index all components in a repository
///
/// # Arguments
/// * `repo_path` - Absolute path to the repository root
///
/// # Returns
/// Statistics about the indexing operation
#[tauri::command]
pub async fn ui_index_build_repo(
    repo_path: String,
    state: State<'_, UiIndexState>,
) -> Result<UiIndexStats, String> {
    let path = PathBuf::from(&repo_path);

    if !path.exists() {
        return Err(format!("Repository path does not exist: {}", repo_path));
    }

    let start = Instant::now();

    // Run indexing in blocking task to not block async runtime
    let index = tokio::task::spawn_blocking(move || {
        let indexer = UiIndexer::new();
        indexer.index_directory(&path)
    })
    .await
    .map_err(|e| format!("Indexing task failed: {}", e))??;

    let elapsed_ms = start.elapsed().as_millis() as u64;
    let stats = UiIndexer::get_stats(&index, elapsed_ms);

    // Store index
    let path = PathBuf::from(&repo_path);
    state.indexes.write().unwrap().insert(path, index);

    log::info!(
        "[UiIndexer] Indexed repo: {} components in {} files ({}ms)",
        stats.total_components,
        stats.total_files,
        stats.index_time_ms
    );

    Ok(stats)
}

/// Look up a component by name
///
/// # Arguments
/// * `repo_path` - Repository path where the index was created
/// * `component_name` - Name of the component to look up (case-insensitive)
///
/// # Returns
/// List of source locations where the component is defined or used
#[tauri::command]
pub async fn ui_index_lookup_component(
    repo_path: String,
    component_name: String,
    state: State<'_, UiIndexState>,
) -> Result<Vec<ComponentLocation>, String> {
    let path = PathBuf::from(&repo_path);
    let indexes = state.indexes.read().unwrap();

    let index = indexes
        .get(&path)
        .ok_or_else(|| format!("Repository not indexed: {}", repo_path))?;

    let results = index.lookup_prioritized(&component_name);

    log::debug!(
        "[UiIndexer] Lookup '{}': {} results",
        component_name,
        results.len()
    );

    Ok(results)
}

/// Update index for a single file (incremental)
///
/// # Arguments
/// * `repo_path` - Repository path
/// * `file_path` - Path to the file that changed
#[tauri::command]
pub async fn ui_index_update_file(
    repo_path: String,
    file_path: String,
    state: State<'_, UiIndexState>,
) -> Result<(), String> {
    let repo = PathBuf::from(&repo_path);
    let file = PathBuf::from(&file_path);

    let mut indexes = state.indexes.write().unwrap();
    let index = indexes
        .get_mut(&repo)
        .ok_or_else(|| format!("Repository not indexed: {}", repo_path))?;

    let indexer = UiIndexer::new();
    indexer.index_file(index, &file)?;

    log::debug!("[UiIndexer] Updated file: {}", file_path);

    Ok(())
}

/// Clear index for a repository
///
/// # Arguments
/// * `repo_path` - Repository path to clear
#[tauri::command]
pub async fn ui_index_clear(
    repo_path: String,
    state: State<'_, UiIndexState>,
) -> Result<(), String> {
    let path = PathBuf::from(&repo_path);
    state.indexes.write().unwrap().remove(&path);

    log::info!("[UiIndexer] Cleared index for: {}", repo_path);

    Ok(())
}

/// Check if a repository is indexed
///
/// # Arguments
/// * `repo_path` - Repository path to check
#[tauri::command]
pub async fn ui_index_is_repo_indexed(
    repo_path: String,
    state: State<'_, UiIndexState>,
) -> Result<bool, String> {
    let path = PathBuf::from(&repo_path);
    let indexes = state.indexes.read().unwrap();
    Ok(indexes.contains_key(&path))
}

/// Get index statistics for a repository
///
/// # Arguments
/// * `repo_path` - Repository path
#[tauri::command]
pub async fn ui_index_get_stats(
    repo_path: String,
    state: State<'_, UiIndexState>,
) -> Result<Option<UiIndexStats>, String> {
    let path = PathBuf::from(&repo_path);
    let indexes = state.indexes.read().unwrap();

    Ok(indexes.get(&path).map(|index| {
        let mut stats = index.stats();
        stats.index_time_ms = 0; // Not applicable for cached stats
        stats
    }))
}

// ============================================
// Global Token Commands
// ============================================

/// Scan a repository for CSS variable definitions
///
/// Scans CSS/SCSS files in the repo to find all defined design tokens.
/// Returns token names with their values and source files.
///
/// # Arguments
/// - `repo_path`: Path to the repository root
/// - `max_depth`: Maximum directory depth to scan (default: 5)
#[tauri::command]
pub async fn scan_global_tokens(
    repo_path: String,
    max_depth: Option<usize>,
) -> Result<TokenDefinitionsResult, String> {
    let path = PathBuf::from(&repo_path);

    if !path.exists() {
        return Err(format!("Repository path not found: {}", repo_path));
    }

    let depth = max_depth.unwrap_or(5);
    let extractor = TokenDefinitionExtractor::new();

    println!("[Global Tokens] Scanning {} (depth: {})", repo_path, depth);

    let result = extractor.scan_directory(&path, depth);

    println!("[Global Tokens] Found {} tokens", result.tokens.len());

    Ok(result)
}

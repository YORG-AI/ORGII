//! Incremental semantic re-indexing of changed files.

#[cfg(feature = "semantic-search")]
use std::path::PathBuf;

#[cfg(feature = "semantic-search")]
use super::index_state::{ensure_semantic_index, get_or_create_semantic_index};
#[cfg(feature = "semantic-search")]
use super::lang::get_lang_from_extension;
use crate::commands::types::IncrementalResult;
use crate::semantic::is_semantic_available;

// ── Incremental Semantic Indexing ────────────────────────────────────────

#[cfg(feature = "semantic-search")]
#[tauri::command]
pub async fn incremental_index_semantic(
    repo_id: String,
    repo_path: String,
    file_paths: Vec<String>,
    _model_id: Option<String>,
) -> Result<IncrementalResult, String> {
    use crate::semantic::{chunk_code, CodeChunkPayload, SemanticConfig};

    if !is_semantic_available() {
        return Err("Semantic search is not available".to_string());
    }

    ensure_semantic_index().await?;

    let index_mutex = get_or_create_semantic_index().await?;
    let guard = index_mutex.lock().await;
    let index = guard
        .as_ref()
        .ok_or_else(|| "Semantic index not initialized".to_string())?;

    let config = SemanticConfig::default();
    let path = PathBuf::from(&repo_path);
    let mut files_updated = 0;
    let mut files_failed = 0;
    let mut failed_paths = Vec::new();

    index
        .delete_file_chunks(&repo_id, &file_paths)
        .await
        .map_err(|e| format!("Failed to delete old chunks: {}", e))?;

    for rel_path in &file_paths {
        let file_path = path.join(rel_path);
        let content = match std::fs::read_to_string(&file_path) {
            Ok(c) => c,
            Err(_) => {
                files_failed += 1;
                failed_paths.push(rel_path.clone());
                continue;
            }
        };

        let lang = get_lang_from_extension(&file_path).unwrap_or_else(|| "unknown".to_string());
        let chunks = chunk_code(&content, config.chunk_size, config.chunk_overlap);

        let payloads: Vec<CodeChunkPayload> = chunks
            .into_iter()
            .map(|chunk| CodeChunkPayload {
                repo_id: repo_id.clone(),
                repo_path: repo_path.clone(),
                relative_path: rel_path.clone(),
                language: lang.to_string(),
                content: chunk.content,
                start_line: chunk.start_line as u64,
                end_line: chunk.end_line as u64,
                content_hash: chunk.hash,
            })
            .collect();

        if payloads.is_empty() {
            files_updated += 1;
            continue;
        }

        match index.batch_index_chunks(payloads).await {
            Ok(_) => files_updated += 1,
            Err(err) => {
                tracing::warn!("Failed to embed {}: {}", rel_path, err);
                files_failed += 1;
                failed_paths.push(rel_path.clone());
            }
        }
    }

    if let Err(e) = index.save() {
        tracing::warn!(
            "Failed to save semantic index after incremental update: {}",
            e
        );
    }

    println!(
        "🔄 [Semantic] Incremental: {} updated, {} failed out of {} files",
        files_updated,
        files_failed,
        file_paths.len()
    );

    Ok(IncrementalResult {
        files_updated,
        files_failed,
        failed_paths,
    })
}

#[cfg(not(feature = "semantic-search"))]
#[tauri::command]
pub async fn incremental_index_semantic(
    _repo_id: String,
    _repo_path: String,
    _file_paths: Vec<String>,
    _model_id: Option<String>,
) -> Result<IncrementalResult, String> {
    Err("Semantic search is not enabled. Build with --features semantic-search".to_string())
}

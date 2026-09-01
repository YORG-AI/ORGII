//! Removal of a repository's semantic embeddings.

#[cfg(feature = "semantic-search")]
use super::index_state::{ensure_semantic_index, get_or_create_semantic_index};
use crate::semantic::is_semantic_available;

// ── Semantic Repository Management ──────────────────────────────────────

#[cfg(feature = "semantic-search")]
#[tauri::command]
pub async fn remove_repository_semantic(repo_id: String) -> Result<(), String> {
    if !is_semantic_available() {
        return Err("Semantic search is not available".to_string());
    }

    ensure_semantic_index().await?;

    let index_mutex = get_or_create_semantic_index().await?;
    let guard = index_mutex.lock().await;

    let index = guard
        .as_ref()
        .ok_or_else(|| "Semantic index not initialized".to_string())?;

    index
        .delete_repo(&repo_id)
        .await
        .map_err(|e| format!("Failed to delete repo vectors: {}", e))?;

    if let Err(e) = index.save() {
        println!("⚠️ [Semantic] Failed to save index after deletion: {}", e);
    }

    println!("🗑️ [Semantic] Removed embeddings for repo_id: {}", repo_id);

    Ok(())
}

#[cfg(not(feature = "semantic-search"))]
#[tauri::command]
pub async fn remove_repository_semantic(_repo_id: String) -> Result<(), String> {
    Err("Semantic search is not enabled. Build with --features semantic-search".to_string())
}

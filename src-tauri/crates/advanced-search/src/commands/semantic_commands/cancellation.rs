//! Embedding cancellation registry and embedder shutdown control.

#[cfg(feature = "semantic-search")]
use std::collections::HashMap;
#[cfg(feature = "semantic-search")]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(feature = "semantic-search")]
use std::sync::{Arc, RwLock};
#[cfg(feature = "semantic-search")]
use tauri::Emitter;

#[cfg(feature = "semantic-search")]
use super::index_state::get_or_create_semantic_index;

// ── Embedding Cancellation Registry ─────────────────────────────────────

#[cfg(feature = "semantic-search")]
lazy_static::lazy_static! {
    static ref ACTIVE_EMBEDDINGS: RwLock<HashMap<String, Arc<AtomicBool>>> = RwLock::new(HashMap::new());
}

#[cfg(feature = "semantic-search")]
pub(super) fn register_embedding(repo_id: &str) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    ACTIVE_EMBEDDINGS
        .write()
        .unwrap()
        .insert(repo_id.to_string(), flag.clone());
    flag
}

#[cfg(feature = "semantic-search")]
pub(super) fn unregister_embedding(repo_id: &str) {
    ACTIVE_EMBEDDINGS.write().unwrap().remove(repo_id);
}

#[cfg(feature = "semantic-search")]
pub(super) fn is_embedding_active(repo_id: &str) -> bool {
    ACTIVE_EMBEDDINGS.read().unwrap().contains_key(repo_id)
}

// ── Cancellation & Embedder Control ─────────────────────────────────────

#[cfg(feature = "semantic-search")]
#[tauri::command]
pub async fn cancel_semantic_indexing(
    repo_id: String,
    window: tauri::Window,
) -> Result<bool, String> {
    println!("🛑 [Semantic] Cancel requested for repo_id: {}", repo_id);

    let cancelled = {
        let embeddings = ACTIVE_EMBEDDINGS.read().unwrap();
        if let Some(flag) = embeddings.get(&repo_id) {
            flag.store(true, Ordering::SeqCst);
            println!(
                "🛑 [Semantic] Cancellation flag set for repo_id: {}",
                repo_id
            );
            true
        } else {
            println!(
                "⚠️ [Semantic] No active embedding job found for repo_id: {}",
                repo_id
            );
            false
        }
    };

    if cancelled {
        let _ = window.emit(
            "semantic-indexing-cancelled",
            serde_json::json!({
                "repo_id": repo_id,
                "status": "cancellation_requested",
            }),
        );
    }

    Ok(cancelled)
}

#[cfg(not(feature = "semantic-search"))]
#[tauri::command]
pub async fn cancel_semantic_indexing(
    _repo_id: String,
    _window: tauri::Window,
) -> Result<bool, String> {
    Err("Semantic search is not enabled. Build with --features semantic-search".to_string())
}

#[cfg(feature = "semantic-search")]
#[tauri::command]
pub async fn stop_embedder() -> Result<(), String> {
    println!("🛑 [Embedder] Stop requested - releasing semantic index to terminate subprocess");

    let index_mutex = get_or_create_semantic_index().await?;
    let mut guard = index_mutex.lock().await;

    if guard.is_some() {
        *guard = None;
        println!("✅ [Embedder] Semantic index released, subprocess will terminate");
    } else {
        println!("ℹ️ [Embedder] No active embedder to stop");
    }

    Ok(())
}

#[cfg(not(feature = "semantic-search"))]
#[tauri::command]
pub async fn stop_embedder() -> Result<(), String> {
    Ok(())
}

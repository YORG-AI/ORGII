//! Semantic index introspection for debugging.

#[cfg(feature = "semantic-search")]
use super::index_state::{ensure_semantic_index, get_or_create_semantic_index};

// ── Debug ───────────────────────────────────────────────────────────────

#[cfg(feature = "semantic-search")]
#[tauri::command]
pub async fn debug_qdrant_collection_info() -> Result<String, String> {
    ensure_semantic_index().await?;

    let index_mutex = get_or_create_semantic_index().await?;
    let guard = index_mutex.lock().await;

    let index = guard
        .as_ref()
        .ok_or_else(|| "Semantic index not initialized".to_string())?;

    let info_map = index.get_info();

    let mut info = String::new();
    info.push_str("📊 USearch Index Info:\n");
    info.push_str(&format!(
        "   Vector count: {}\n",
        info_map
            .get("vector_count")
            .unwrap_or(&serde_json::json!(0))
    ));
    info.push_str(&format!(
        "   Capacity: {}\n",
        info_map.get("capacity").unwrap_or(&serde_json::json!(0))
    ));
    info.push_str(&format!(
        "   Dimensions: {}\n",
        info_map
            .get("dimensions")
            .unwrap_or(&serde_json::json!(768))
    ));
    info.push_str(&format!(
        "   Index path: {}\n",
        info_map
            .get("index_path")
            .unwrap_or(&serde_json::json!("unknown"))
    ));
    info.push_str(&format!(
        "   Idle seconds: {}\n",
        info_map
            .get("idle_seconds")
            .unwrap_or(&serde_json::json!(0))
    ));

    println!("{}", info);
    Ok(info)
}

#[cfg(not(feature = "semantic-search"))]
#[tauri::command]
pub async fn debug_qdrant_collection_info() -> Result<String, String> {
    Err("Semantic search is not enabled".to_string())
}

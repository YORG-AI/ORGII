//! Semantic vector search command.

#[cfg(feature = "semantic-search")]
use super::index_state::{ensure_semantic_index, get_or_create_semantic_index};
use crate::semantic::SemanticHit;

// ── Semantic Search ─────────────────────────────────────────────────────

#[cfg(feature = "semantic-search")]
#[tauri::command]
pub async fn search_semantic(
    query: String,
    repo_filter: Option<String>,
    limit: Option<usize>,
    _model_id: Option<String>,
    offset: Option<usize>,
) -> Result<Vec<SemanticHit>, String> {
    println!("🔍 [Command] search_semantic called:");
    println!("   query: '{}'", query);
    println!("   repo_filter: {:?}", repo_filter);
    println!("   limit: {:?}", limit);

    ensure_semantic_index().await?;

    let index_mutex = get_or_create_semantic_index().await?;
    let guard = index_mutex.lock().await;

    let index = guard
        .as_ref()
        .ok_or_else(|| "Semantic index not initialized".to_string())?;

    let limit = limit.unwrap_or(20);
    let offset = offset.unwrap_or(0);

    let results = index
        .search(&query, repo_filter.as_deref(), limit + offset + 1)
        .await
        .map_err(|e| format!("Semantic search failed: {}", e))?;

    let paginated_results: Vec<_> = results.into_iter().skip(offset).take(limit).collect();

    println!(
        "   ✅ Returning {} results (offset: {})",
        paginated_results.len(),
        offset
    );

    Ok(paginated_results)
}

#[cfg(not(feature = "semantic-search"))]
#[tauri::command]
pub async fn search_semantic(
    _query: String,
    _repo_filter: Option<String>,
    _limit: Option<usize>,
    _model_id: Option<String>,
    _offset: Option<usize>,
) -> Result<Vec<SemanticHit>, String> {
    Err("Semantic search is not enabled. Build with --features semantic-search".to_string())
}

//! Rendering Data Extraction Commands
//!
//! Extract pre-computed rendering data and string processing utilities.

use tauri::State;

use crate::agent_sessions::event_pipeline::extractors;
use crate::agent_sessions::event_pipeline::extractors::ExtractedData;
use perf_utils::diff_patch::{convert_patch_to_unified, PatchConversionResult};

use super::EventStoreState;

/// Extract rendering data for a bounded event window.
#[tauri::command]
pub async fn es_extract_event_data_window(
    state: State<'_, EventStoreState>,
    session_id: Option<String>,
    offset: usize,
    limit: usize,
) -> Result<Vec<(String, ExtractedData)>, String> {
    let sid = state.resolve_session_id(session_id)?;
    let bounded_limit = limit.clamp(1, 250);
    Ok(state
        .with_store_opt(&sid, |store| {
            let events = store.events();
            if offset >= events.len() {
                return Vec::new();
            }
            let end = offset.saturating_add(bounded_limit).min(events.len());
            extractors::extract_batch(&events[offset..end])
        })
        .unwrap_or_default())
}

// ============================================================================
// String Processing Commands
// ============================================================================

/// Convert apply_patch format to unified diff.
#[tauri::command]
pub async fn es_convert_patch_to_diff(patch_text: String) -> Result<PatchConversionResult, String> {
    Ok(convert_patch_to_unified(patch_text))
}

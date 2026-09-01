//! DOM Editor Commands
//!
//! Provides CRUD operations for DOM manipulation in webviews.
//! This enables DOM-based design editing as an alternative to custom canvas rendering.
//!
//! ## Operations
//! - Insert: Add new elements to the DOM
//! - Delete: Remove elements from the DOM
//! - Update: Modify element attributes
//! - Clone: Duplicate elements
//! - Move: Reorder elements in the DOM tree
//! - Undo/Redo: History management for all operations
//! - Serialize: Export DOM to HTML

use tauri::{AppHandle, Manager};

use super::logging::eval_js_with_result;

// ============================================
// Element CRUD Commands
// ============================================

// ============================================
// Undo/Redo Commands
// ============================================

/// History state for undo/redo
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HistoryState {
    pub undo_count: u32,
    pub redo_count: u32,
    pub can_undo: bool,
    pub can_redo: bool,
}

// ============================================
// Serialization Commands
// ============================================

// ============================================
// Multi-Select Commands
// ============================================

// ============================================
// Element Bounds Commands
// ============================================

/// Bounding rectangle of an element.
#[derive(serde::Serialize, serde::Deserialize, Debug)]
pub struct ElementBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    pub left: f64,
}

// ============================================
// Resize/Position Commands
// ============================================

// ============================================
// Save HTML to File
// ============================================

/// Get the full HTML document (including doctype) ready for saving.
///
/// This is useful for previewing what will be saved.
#[tauri::command]
pub async fn get_full_html_document(app: AppHandle, label: String) -> Result<String, String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Webview '{}' not found", label))?;

    let script = r#"
        (function() {
            return '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
        })()
    "#;

    let html_content = eval_js_with_result(&webview, script, "").await;

    if html_content.is_empty() {
        return Err("Failed to get HTML document".to_string());
    }

    Ok(html_content)
}

//! Browser Window Management
//!
//! Standalone browser windows for viewing external websites.
//! Each window is independent with its own navigation history.

use tauri::{AppHandle, Manager};





/// Get the current URL of an existing webview window.
///
/// Do not call `.url()` on inline child webviews. On macOS/WKWebView, wry
/// unwraps `WKWebView.URL()` internally and can panic while the page is still
/// loading. That panic happens on the main thread, outside this command's
/// `catch_unwind`, and poisons Tauri's runtime mutex. Inline browser sessions
/// keep their URL state on the frontend, so returning `None` is safer.
#[tauri::command]
pub fn get_webview_url(app: AppHandle, label: String) -> Result<Option<String>, String> {
    if app.get_webview(&label).is_some() {
        return Ok(None);
    }

    // Avoid `.url()` for webview windows too; it uses the same wry WKWebView
    // getter and can panic when URL is temporarily unavailable.
    let _ = app.get_webview_window(&label);
    Ok(None)
}

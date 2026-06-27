//! Webview Logging and Inspection
//!
//! Console and network log capture from inline webviews.
//! Element inspection for selecting and analyzing DOM elements.
//! Uses platform-specific APIs to retrieve data from the webview context.

use tauri::{AppHandle, Manager};

use super::types::{ConsoleLogEntry, ElementInfo, NetworkLogEntry};

// ============================================
// Platform-specific JavaScript Evaluation
// ============================================

/// Evaluate JavaScript in a webview and return the result as a string.
///
/// This is a helper function that handles the platform-specific details
/// of retrieving JavaScript evaluation results from webviews.
///
/// # Platform Support
///
/// - **macOS**: Uses WKWebView's `evaluateJavaScript` via Objective-C runtime
/// - **Windows**: Uses WebView2's `ExecuteScript` completion callback
/// - **Other platforms**: Returns the default value (not yet implemented)
#[cfg(target_os = "macos")]
pub async fn eval_js_with_result(webview: &tauri::Webview, script: &str, default: &str) -> String {
    use block2::RcBlock;
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    use std::ffi::CString;
    use std::sync::mpsc;

    let (tx, rx) = mpsc::channel::<String>();
    let default_owned = default.to_string();
    let script_owned = script.to_string();

    let result = webview.with_webview(move |wv| {
        // SAFETY: This block uses Objective-C runtime interop to call WKWebView APIs.
        // - wv.inner() returns a valid WKWebView pointer when on macOS
        // - All msg_send! calls use documented Cocoa selectors
        // - NSString created from valid UTF-8 CString
        // - `RcBlock` retains the block on the heap until the completion handler runs
        // - Null checks are performed before dereferencing any pointer
        unsafe {
            let wk_webview: *mut AnyObject = wv.inner() as *mut AnyObject;
            if wk_webview.is_null() {
                let _ = tx.send(default_owned.clone());
                return;
            }

            // Create NSString from C string (must be null-terminated)
            let script_cstr = match CString::new(script_owned.as_str()) {
                Ok(s) => s,
                Err(_) => {
                    let _ = tx.send(default_owned.clone());
                    return;
                }
            };
            let nsstring_class = AnyClass::get(c"NSString").expect("NSString");
            let script_ns: *mut AnyObject =
                msg_send![nsstring_class, stringWithUTF8String: script_cstr.as_ptr()];

            if script_ns.is_null() {
                let _ = tx.send(default_owned.clone());
                return;
            }

            // Create completion handler block
            let tx_clone = tx.clone();
            let default_for_block = default_owned.clone();
            let block = RcBlock::new(move |result: *mut AnyObject, _error: *mut AnyObject| {
                let result_str = if result.is_null() {
                    default_for_block.clone()
                } else {
                    let utf8: *const i8 = msg_send![result, UTF8String];
                    if utf8.is_null() {
                        default_for_block.clone()
                    } else {
                        std::ffi::CStr::from_ptr(utf8)
                            .to_str()
                            .unwrap_or(&default_for_block)
                            .to_string()
                    }
                };
                let _ = tx_clone.send(result_str);
            });

            let _: () = msg_send![
                wk_webview,
                evaluateJavaScript: script_ns,
                completionHandler: &*block,
            ];
        }
    });

    if result.is_err() {
        return default.to_string();
    }

    // Wait for result with timeout
    rx.recv_timeout(std::time::Duration::from_secs(2))
        .unwrap_or_else(|_| default.to_string())
}

#[cfg(any(target_os = "windows", test))]
fn normalize_webview2_eval_result(raw: &str, default: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return default.to_string();
    }

    match serde_json::from_str::<serde_json::Value>(trimmed) {
        Ok(serde_json::Value::String(value)) => value,
        Ok(value) => value.to_string(),
        Err(_) => trimmed.to_string(),
    }
}

#[cfg(target_os = "windows")]
pub async fn eval_js_with_result(webview: &tauri::Webview, script: &str, default: &str) -> String {
    use std::sync::mpsc;
    use std::time::Duration;
    use webview2_com::ExecuteScriptCompletedHandler;
    use windows::core::HSTRING;

    let (tx, rx) = mpsc::channel::<String>();
    let default_owned = default.to_string();
    let script_owned = script.to_string();

    let result = webview.with_webview(move |wv| {
        let controller = wv.controller();
        let core_webview = match unsafe { controller.CoreWebView2() } {
            Ok(webview) => webview,
            Err(err) => {
                let _ = tx.send(default_owned.clone());
                tracing::warn!(
                    error = %err,
                    "browser::logging: failed to get WebView2 core webview"
                );
                return;
            }
        };

        let js = HSTRING::from(script_owned);
        let tx_callback = tx.clone();
        let default_for_callback = default_owned.clone();
        let handler = ExecuteScriptCompletedHandler::create(Box::new(move |_error_code, raw| {
            let value = if raw.trim().is_empty() {
                default_for_callback.clone()
            } else {
                raw
            };
            let _ = tx_callback.send(value);
            Ok(())
        }));

        let execute_result = unsafe { core_webview.ExecuteScript(&js, &handler) };
        if let Err(err) = execute_result {
            let _ = tx.send(default_owned);
            tracing::warn!(
                error = %err,
                "browser::logging: WebView2 ExecuteScript failed"
            );
        }
    });

    if let Err(err) = result {
        tracing::warn!(
            error = %err,
            "browser::logging: failed to dispatch WebView2 JavaScript evaluation"
        );
        return default.to_string();
    }

    let raw = match rx.recv_timeout(Duration::from_secs(2)) {
        Ok(value) => value,
        Err(err) => {
            tracing::warn!(
                error = %err,
                "browser::logging: WebView2 JavaScript evaluation timed out"
            );
            return default.to_string();
        }
    };

    normalize_webview2_eval_result(&raw, default)
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
pub async fn eval_js_with_result(
    _webview: &tauri::Webview,
    _script: &str,
    default: &str,
) -> String {
    // For other platforms, we can't easily get eval results
    // Return default for now - this needs platform-specific implementation
    default.to_string()
}

// ============================================
// Console Log Commands
// ============================================

/// Get and clear console logs from an inline webview.
///
/// Calls the injected `__ORGII_GET_AND_CLEAR_LOGS__()` function to retrieve
/// stored console logs and clears them from the webview's memory.
#[tauri::command]
pub async fn get_webview_console_logs(
    app: AppHandle,
    label: String,
) -> Result<Vec<ConsoleLogEntry>, String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Webview '{}' not found", label))?;

    // Trigger the log collection and store in global variable
    let _ = webview.eval(
        r#"
        if (typeof window.__ORGII_GET_AND_CLEAR_LOGS__ === 'function') {
            window.__ORGII_LAST_LOG_FETCH__ = window.__ORGII_GET_AND_CLEAR_LOGS__();
        } else {
            window.__ORGII_LAST_LOG_FETCH__ = '[]';
        }
    "#,
    );

    // Small delay to ensure script executes
    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;

    // Retrieve the result
    let logs_json =
        eval_js_with_result(&webview, "window.__ORGII_LAST_LOG_FETCH__ || '[]'", "[]").await;

    // Parse the JSON. A silent empty Vec would make the user see
    // "no logs" while the webview's injected hook genuinely had
    // them — masking a JS-side regression or an injection script
    // version mismatch. Warn so the failure is visible.
    let logs: Vec<ConsoleLogEntry> = match serde_json::from_str(&logs_json) {
        Ok(v) => v,
        Err(err) => {
            tracing::warn!(
                label = %label,
                error = %err,
                len = logs_json.len(),
                "browser::logging: console logs JSON parse failed; returning empty list"
            );
            Vec::new()
        }
    };

    Ok(logs)
}

// ============================================
// Network Log Commands
// ============================================

/// Get and clear network logs from an inline webview.
///
/// Calls the injected `__ORGII_GET_AND_CLEAR_NETWORK_LOGS__()` function to retrieve
/// stored network logs and clears them from the webview's memory.
#[tauri::command]
pub async fn get_webview_network_logs(
    app: AppHandle,
    label: String,
) -> Result<Vec<NetworkLogEntry>, String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Webview '{}' not found", label))?;

    // Trigger the log collection and store in global variable
    let _ = webview.eval(
        r#"
        if (typeof window.__ORGII_GET_AND_CLEAR_NETWORK_LOGS__ === 'function') {
            window.__ORGII_LAST_NETWORK_FETCH__ = window.__ORGII_GET_AND_CLEAR_NETWORK_LOGS__();
        } else {
            window.__ORGII_LAST_NETWORK_FETCH__ = '[]';
        }
    "#,
    );

    // Small delay to ensure script executes
    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;

    // Retrieve the result
    let logs_json = eval_js_with_result(
        &webview,
        "window.__ORGII_LAST_NETWORK_FETCH__ || '[]'",
        "[]",
    )
    .await;

    // Parse the JSON. Same rationale as the console-log path:
    // silent empty Vec masks a JS-side injection regression.
    let logs: Vec<NetworkLogEntry> = match serde_json::from_str(&logs_json) {
        Ok(v) => v,
        Err(err) => {
            tracing::warn!(
                label = %label,
                error = %err,
                len = logs_json.len(),
                "browser::logging: network logs JSON parse failed; returning empty list"
            );
            Vec::new()
        }
    };

    Ok(logs)
}

// ============================================
// Element Inspector Commands
// ============================================

/// Toggle element inspect mode in a webview.
///
/// When enabled, hovering over elements shows a highlight overlay
/// and clicking an element selects it for inspection.
///
/// Returns the new state: true if enabled, false if disabled.
#[tauri::command]
pub async fn toggle_webview_inspect_mode(app: AppHandle, label: String) -> Result<bool, String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Webview '{}' not found", label))?;

    // Toggle inspect mode
    let _ = webview.eval(
        r#"
        if (typeof window.__ORGII_TOGGLE_INSPECT_MODE__ === 'function') {
            window.__ORGII_INSPECT_MODE_STATE__ = window.__ORGII_TOGGLE_INSPECT_MODE__();
        } else {
            window.__ORGII_INSPECT_MODE_STATE__ = false;
        }
    "#,
    );

    // Small delay to ensure script executes
    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;

    // Get the state
    let state_str = eval_js_with_result(
        &webview,
        "String(window.__ORGII_INSPECT_MODE_STATE__ || false)",
        "false",
    )
    .await;

    Ok(state_str == "true")
}

/// Enable element inspect mode in a webview.
#[tauri::command]
pub async fn enable_webview_inspect_mode(app: AppHandle, label: String) -> Result<(), String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Webview '{}' not found", label))?;

    let _ = webview.eval(
        r#"
        if (typeof window.__ORGII_ENABLE_INSPECT_MODE__ === 'function') {
            window.__ORGII_ENABLE_INSPECT_MODE__();
        }
    "#,
    );

    Ok(())
}

/// Disable element inspect mode in a webview.
#[tauri::command]
pub async fn disable_webview_inspect_mode(app: AppHandle, label: String) -> Result<(), String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Webview '{}' not found", label))?;

    let _ = webview.eval(
        r#"
        if (typeof window.__ORGII_DISABLE_INSPECT_MODE__ === 'function') {
            window.__ORGII_DISABLE_INSPECT_MODE__();
        }
    "#,
    );

    Ok(())
}

/// Get information about the currently selected element.
///
/// Returns None if no element is selected.
#[tauri::command]
pub async fn get_selected_element_info(
    app: AppHandle,
    label: String,
) -> Result<Option<ElementInfo>, String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Webview '{}' not found", label))?;

    // Get selected element info
    let _ = webview.eval(
        r#"
        if (typeof window.__ORGII_GET_SELECTED_ELEMENT__ === 'function') {
            window.__ORGII_LAST_ELEMENT_INFO__ = window.__ORGII_GET_SELECTED_ELEMENT__();
        } else {
            window.__ORGII_LAST_ELEMENT_INFO__ = 'null';
        }
    "#,
    );

    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;

    let info_json = eval_js_with_result(
        &webview,
        "window.__ORGII_LAST_ELEMENT_INFO__ || 'null'",
        "null",
    )
    .await;

    if info_json == "null" || info_json.is_empty() {
        return Ok(None);
    }

    // Try to parse the JSON
    match serde_json::from_str::<ElementInfo>(&info_json) {
        Ok(info) => Ok(Some(info)),
        Err(_) => Ok(None),
    }
}

/// Clear the element selection in a webview.
#[tauri::command]
pub async fn clear_element_selection(app: AppHandle, label: String) -> Result<(), String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Webview '{}' not found", label))?;

    let _ = webview.eval(
        r#"
        if (typeof window.__ORGII_CLEAR_SELECTION__ === 'function') {
            window.__ORGII_CLEAR_SELECTION__();
        }
    "#,
    );

    Ok(())
}

// ============================================
// Native DevTools Commands
// ============================================

/// Open the native DevTools for a webview.
///
/// Only available in debug builds. In release builds, this is a no-op
/// to prevent end users from inspecting the application internals.
#[tauri::command]
pub async fn open_webview_devtools(app: AppHandle, label: String) -> Result<(), String> {
    #[cfg(debug_assertions)]
    {
        let webview = app
            .get_webview(&label)
            .ok_or_else(|| format!("Webview '{}' not found", label))?;
        webview.open_devtools();
        println!("[DevTools] Opened for webview: {}", label);
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = (&app, &label);
    }
    Ok(())
}

/// Close the native DevTools for a webview.
///
/// No-op in release builds.
#[tauri::command]
pub async fn close_webview_devtools(app: AppHandle, label: String) -> Result<(), String> {
    #[cfg(debug_assertions)]
    {
        let webview = app
            .get_webview(&label)
            .ok_or_else(|| format!("Webview '{}' not found", label))?;
        webview.close_devtools();
        println!("[DevTools] Closed for webview: {}", label);
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = (&app, &label);
    }
    Ok(())
}

/// Check if DevTools is open for a webview.
///
/// Always returns false in release builds.
#[tauri::command]
pub async fn is_webview_devtools_open(app: AppHandle, label: String) -> Result<bool, String> {
    #[cfg(debug_assertions)]
    {
        let webview = app
            .get_webview(&label)
            .ok_or_else(|| format!("Webview '{}' not found", label))?;
        Ok(webview.is_devtools_open())
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = (&app, &label);
        Ok(false)
    }
}

// ============================================
// DOM Tree Commands (for React inspector panel)
// ============================================

/// Get the DOM tree from a webview.
///
/// Returns a hierarchical tree structure of DOM elements
/// for display in the React inspector panel.
#[tauri::command]
pub async fn get_webview_dom_tree(
    app: AppHandle,
    label: String,
    max_depth: Option<u32>,
) -> Result<Option<super::types::DOMTreeNode>, String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Webview '{}' not found", label))?;

    let depth = max_depth.unwrap_or(12);

    // Build and return the tree in a single `evaluateJavaScript:` call so the
    // completion handler waits for JSON.stringify to finish. The previous
    // fire-and-forget + 50ms sleep pattern raced against large pages
    // (YouTube, Google results) where the synchronous walk + serialize can
    // take hundreds of ms, causing the read to fire before the write and
    // returning an empty tree.
    let script = format!(
        r#"
        (function() {{
            try {{
                if (typeof window.__ORGII_GET_DOM_TREE__ !== 'function') return 'null';
                var json = window.__ORGII_GET_DOM_TREE__({});
                return (typeof json === 'string' && json) ? json : 'null';
            }} catch (e) {{
                return 'null';
            }}
        }})()
        "#,
        depth
    );

    let tree_json = eval_js_with_result(&webview, &script, "null").await;

    if tree_json == "null" || tree_json.is_empty() {
        return Ok(None);
    }

    match serde_json::from_str(&tree_json) {
        Ok(tree) => Ok(Some(tree)),
        Err(e) => {
            println!("[DOMTree] Failed to parse: {}", e);
            Ok(None)
        }
    }
}

/// Check whether the webview's DOM has mutated since the last tree fetch.
///
/// Atomic read-and-clear of `window.__ORGII_DOM_DIRTY__`, set by the
/// MutationObserver installed in `inspector-dom-tree.js`. Used by React to
/// cheaply decide whether to re-run `get_webview_dom_tree` on SPA pages
/// that mutate the DOM without changing the URL (YouTube results,
/// Twitter/X feed, Slack, etc.).
///
/// Returns `true` if dirty (and clears the flag), `false` otherwise.
#[tauri::command]
pub async fn check_webview_dom_dirty(app: AppHandle, label: String) -> Result<bool, String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Webview '{}' not found", label))?;

    // Read-and-clear in a single eval so we never miss a mutation that
    // lands between the read and a separate clear call.
    let script = r#"
        (function() {
            var dirty = window.__ORGII_DOM_DIRTY__ === true;
            window.__ORGII_DOM_DIRTY__ = false;
            return dirty ? 'true' : 'false';
        })()
    "#;

    let result = eval_js_with_result(&webview, script, "false").await;
    Ok(result == "true")
}

/// Highlight an element by its XPath.
///
/// Used for hover preview when the user hovers over a tree node
/// in the React inspector panel.
#[tauri::command]
pub async fn highlight_element_by_xpath(
    app: AppHandle,
    label: String,
    xpath: String,
) -> Result<bool, String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Webview '{}' not found", label))?;

    // Escape the xpath for JavaScript
    let escaped_xpath = xpath.replace('\\', "\\\\").replace('\'', "\\'");
    let script = format!(
        r#"
        if (typeof window.__ORGII_HIGHLIGHT_BY_XPATH__ === 'function') {{
            window.__ORGII_HIGHLIGHT_RESULT__ = window.__ORGII_HIGHLIGHT_BY_XPATH__('{}');
        }} else {{
            window.__ORGII_HIGHLIGHT_RESULT__ = false;
        }}
        "#,
        escaped_xpath
    );

    let _ = webview.eval(&script);

    // No need to wait for result for hover highlight
    Ok(true)
}

/// Select an element by its XPath.
///
/// Used when the user clicks on a tree node in the React inspector panel.
/// Returns the element info for the selected element.
#[tauri::command]
pub async fn select_element_by_xpath(
    app: AppHandle,
    label: String,
    xpath: String,
) -> Result<Option<ElementInfo>, String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Webview '{}' not found", label))?;

    // Escape the xpath for JavaScript
    let escaped_xpath = xpath.replace('\\', "\\\\").replace('\'', "\\'");
    let script = format!(
        r#"
        if (typeof window.__ORGII_SELECT_BY_XPATH__ === 'function') {{
            window.__ORGII_SELECT_RESULT__ = window.__ORGII_SELECT_BY_XPATH__('{}');
        }} else {{
            window.__ORGII_SELECT_RESULT__ = 'null';
        }}
        "#,
        escaped_xpath
    );

    let _ = webview.eval(&script);
    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;

    let info_json =
        eval_js_with_result(&webview, "window.__ORGII_SELECT_RESULT__ || 'null'", "null").await;

    if info_json == "null" || info_json.is_empty() {
        return Ok(None);
    }

    match serde_json::from_str(&info_json) {
        Ok(info) => Ok(Some(info)),
        Err(e) => {
            println!("[SelectByXPath] Failed to parse: {}", e);
            Ok(None)
        }
    }
}

/// Clear the element highlight overlay.
///
/// Called when the mouse leaves the tree panel in the React inspector.
#[tauri::command]
pub async fn clear_element_highlight(app: AppHandle, label: String) -> Result<(), String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Webview '{}' not found", label))?;

    let _ = webview.eval(
        r#"
        if (typeof window.__ORGII_CLEAR_HIGHLIGHT__ === 'function') {
            window.__ORGII_CLEAR_HIGHLIGHT__();
        }
    "#,
    );

    Ok(())
}

// ============================================
// Style Editing Commands
// ============================================

/// Set a CSS style property on an element.
///
/// Used for live editing from the Design/CSS panels.
/// The property can be in camelCase or kebab-case.
#[tauri::command]
pub async fn set_element_style(
    app: AppHandle,
    label: String,
    xpath: String,
    property: String,
    value: String,
) -> Result<bool, String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Webview '{}' not found", label))?;

    // Escape strings for JavaScript
    let escaped_xpath = xpath.replace('\\', "\\\\").replace('\'', "\\'");
    let escaped_property = property.replace('\\', "\\\\").replace('\'', "\\'");
    let escaped_value = value.replace('\\', "\\\\").replace('\'', "\\'");

    let script = format!(
        r#"
        if (typeof window.__ORGII_SET_ELEMENT_STYLE__ === 'function') {{
            window.__ORGII_SET_STYLE_RESULT__ = window.__ORGII_SET_ELEMENT_STYLE__('{}', '{}', '{}');
        }} else {{
            window.__ORGII_SET_STYLE_RESULT__ = false;
        }}
        "#,
        escaped_xpath, escaped_property, escaped_value
    );

    let _ = webview.eval(&script);
    tokio::time::sleep(tokio::time::Duration::from_millis(30)).await;

    let result_str = eval_js_with_result(
        &webview,
        "String(window.__ORGII_SET_STYLE_RESULT__ || false)",
        "false",
    )
    .await;

    Ok(result_str == "true")
}

/// Get full computed styles for the currently selected element.
///
/// Returns comprehensive style information for the Design/CSS panels.
#[tauri::command]
pub async fn get_element_computed_styles(
    app: AppHandle,
    label: String,
) -> Result<Option<super::types::FullComputedStyles>, String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Webview '{}' not found", label))?;

    let _ = webview.eval(
        r#"
        if (typeof window.__ORGII_GET_FULL_COMPUTED_STYLES__ === 'function') {
            window.__ORGII_LAST_COMPUTED_STYLES__ = window.__ORGII_GET_FULL_COMPUTED_STYLES__();
        } else {
            window.__ORGII_LAST_COMPUTED_STYLES__ = 'null';
        }
    "#,
    );

    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;

    let styles_json = eval_js_with_result(
        &webview,
        "window.__ORGII_LAST_COMPUTED_STYLES__ || 'null'",
        "null",
    )
    .await;

    if styles_json == "null" || styles_json.is_empty() {
        return Ok(None);
    }

    match serde_json::from_str(&styles_json) {
        Ok(styles) => Ok(Some(styles)),
        Err(e) => {
            println!("[ComputedStyles] Failed to parse: {}", e);
            println!(
                "[ComputedStyles] JSON was: {}...",
                &styles_json[..styles_json.len().min(200)]
            );
            Ok(None)
        }
    }
}

/// Get the path of xpaths from root to the currently selected element.
///
/// Used to expand the tree to show the selected element.
#[tauri::command]
pub async fn get_element_path(
    app: AppHandle,
    label: String,
) -> Result<Option<Vec<String>>, String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Webview '{}' not found", label))?;

    let _ = webview.eval(
        r#"
        if (typeof window.__ORGII_GET_ELEMENT_PATH__ === 'function') {
            window.__ORGII_ELEMENT_PATH__ = window.__ORGII_GET_ELEMENT_PATH__();
        } else {
            window.__ORGII_ELEMENT_PATH__ = 'null';
        }
    "#,
    );

    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;

    let path_json =
        eval_js_with_result(&webview, "window.__ORGII_ELEMENT_PATH__ || 'null'", "null").await;

    if path_json == "null" || path_json.is_empty() {
        return Ok(None);
    }

    match serde_json::from_str(&path_json) {
        Ok(paths) => Ok(Some(paths)),
        Err(e) => {
            println!("[ElementPath] Failed to parse: {}", e);
            Ok(None)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::normalize_webview2_eval_result;

    #[test]
    fn normalize_webview2_eval_result_keeps_json_literals() {
        assert_eq!(normalize_webview2_eval_result("true", "fallback"), "true");
        assert_eq!(normalize_webview2_eval_result("false", "fallback"), "false");
        assert_eq!(normalize_webview2_eval_result("null", "fallback"), "null");
        assert_eq!(normalize_webview2_eval_result("[]", "fallback"), "[]");
    }

    #[test]
    fn normalize_webview2_eval_result_unwraps_json_strings() {
        assert_eq!(
            normalize_webview2_eval_result("\"hello\"", "fallback"),
            "hello"
        );
        assert_eq!(
            normalize_webview2_eval_result("\"{\\\"tagName\\\":\\\"img\\\"}\"", "fallback"),
            "{\"tagName\":\"img\"}"
        );
    }

    #[test]
    fn normalize_webview2_eval_result_uses_default_for_empty_raw_result() {
        assert_eq!(normalize_webview2_eval_result("", "fallback"), "fallback");
        assert_eq!(
            normalize_webview2_eval_result("   ", "fallback"),
            "fallback"
        );
    }

    #[test]
    fn normalize_webview2_eval_result_preserves_unparseable_values() {
        assert_eq!(
            normalize_webview2_eval_result("not valid json", "fallback"),
            "not valid json"
        );
    }
}

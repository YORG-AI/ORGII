//! Internal Browser Tauri Commands
//!
//! Direct frontend access to internal browser automation for testing and debugging.
//! These commands expose the `window.__PAGE_AGENT__` API injected into inline webviews.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Manager};
use tokio::time::{Duration, Instant};
use uuid::Uuid;

use super::logging::eval_js_with_result;

const PAGE_AGENT_PENDING_RESULT: &str = "__ORGII_PAGE_AGENT_PENDING__";
const PAGE_AGENT_POLL_INTERVAL_MS: u64 = 50;

// ============================================================================
// Types
// ============================================================================

/// Browser state returned by internal browser automation
#[derive(Debug, Serialize, Deserialize)]
pub struct InternalBrowserState {
    pub url: String,
    pub title: String,
    pub header: String,
    pub content: String,
    pub footer: String,
}

/// Result from internal browser actions
#[derive(Debug, Serialize, Deserialize)]
pub struct InternalBrowserActionResult {
    pub success: bool,
    pub message: String,
}

/// Lightweight browser location state, without rebuilding the Page Agent DOM tree.
#[derive(Debug, Serialize, Deserialize)]
pub struct InternalBrowserLocation {
    pub url: String,
    pub title: String,
}

fn page_agent_missing_action() -> serde_json::Value {
    json!({
        "success": false,
        "message": "Page Agent not initialized"
    })
}

async fn eval_browser_call<T>(
    webview: &tauri::Webview,
    expression: String,
    timeout_ms: u64,
) -> Result<T, String>
where
    T: DeserializeOwned,
{
    let call_id = Uuid::new_v4().to_string();
    let call_id_literal = serde_json::to_string(&call_id)
        .map_err(|err| format!("Failed to encode browser eval call id: {err}"))?;

    let script = format!(
        r#"
        (async () => {{
            const callId = {call_id_literal};
            window.__PAGE_AGENT_RESULTS__ = window.__PAGE_AGENT_RESULTS__ || {{}};
            try {{
                window.__PAGE_AGENT_RESULTS__[callId] = await ({expression});
            }} catch (error) {{
                window.__PAGE_AGENT_RESULTS__[callId] = {{
                    success: false,
                    message: `Browser eval failed: ${{error?.message || String(error)}}`
                }};
            }}
        }})();
        "#
    );

    webview
        .eval(&script)
        .map_err(|err| format!("Failed to evaluate browser script: {err}"))?;

    let pending_literal = serde_json::to_string(PAGE_AGENT_PENDING_RESULT)
        .map_err(|err| format!("Failed to encode browser eval pending marker: {err}"))?;
    let read_script = format!(
        r#"
        (() => {{
            const callId = {call_id_literal};
            const store = window.__PAGE_AGENT_RESULTS__;
            if (!store || !Object.prototype.hasOwnProperty.call(store, callId)) {{
                return {pending_literal};
            }}
            const value = store[callId];
            delete store[callId];
            return JSON.stringify(value);
        }})()
        "#
    );

    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        let result = eval_js_with_result(webview, &read_script, PAGE_AGENT_PENDING_RESULT).await;
        if result != PAGE_AGENT_PENDING_RESULT {
            return serde_json::from_str(&result)
                .map_err(|err| format!("Failed to parse browser eval result: {err}"));
        }

        if Instant::now() >= deadline {
            return Err(format!(
                "Timed out waiting for browser eval result after {timeout_ms}ms"
            ));
        }

        tokio::time::sleep(Duration::from_millis(PAGE_AGENT_POLL_INTERVAL_MS)).await;
    }
}

async fn eval_page_agent_call<T>(
    webview: &tauri::Webview,
    expression: String,
    missing_value: serde_json::Value,
    timeout_ms: u64,
) -> Result<T, String>
where
    T: DeserializeOwned,
{
    let missing_literal = serde_json::to_string(&missing_value)
        .map_err(|err| format!("Failed to encode Page Agent fallback: {err}"))?;
    let guarded_expression = format!(
        r#"
        (async () => {{
            if (!window.__PAGE_AGENT__) {{
                return {missing_literal};
            }}
            return await ({expression});
        }})()
        "#
    );

    eval_browser_call(webview, guarded_expression, timeout_ms).await
}

// ============================================================================
// Commands
// ============================================================================

/// Get the browser state from a webview using Page Agent.
///
/// Returns the DOM tree with interactive elements highlighted and indexed.
pub async fn internal_browser_get_state(
    app: AppHandle,
    label: String,
) -> Result<InternalBrowserState, String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Webview '{}' not found", label))?;

    eval_browser_call(
        &webview,
        r#"
        (async () => {
            if (!window.__PAGE_AGENT__) {
                return {
                    url: window.location.href,
                    title: document.title || "",
                    header: "Page Agent not initialized",
                    content: "",
                    footer: ""
                };
            }
            return window.__PAGE_AGENT__.getBrowserState();
        })()
        "#
        .to_string(),
        2_000,
    )
    .await
}

/// Get the current URL/title without invoking the Page Agent DOM snapshot path.
pub async fn internal_browser_get_location(
    app: AppHandle,
    label: String,
) -> Result<InternalBrowserLocation, String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Webview '{}' not found", label))?;

    eval_browser_call(
        &webview,
        r#"(() => ({
            url: window.location.href,
            title: document.title || ""
        }))()"#
            .to_string(),
        1_000,
    )
    .await
}

/// Click an element by its highlight index.
pub async fn internal_browser_click(
    app: AppHandle,
    label: String,
    index: i64,
) -> Result<InternalBrowserActionResult, String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Webview '{}' not found", label))?;

    eval_page_agent_call(
        &webview,
        format!("window.__PAGE_AGENT__.clickElement({index})"),
        page_agent_missing_action(),
        2_000,
    )
    .await
}

/// Input text into an element by its highlight index.
pub async fn internal_browser_input(
    app: AppHandle,
    label: String,
    index: i64,
    text: String,
) -> Result<InternalBrowserActionResult, String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Webview '{}' not found", label))?;

    let text_literal = serde_json::to_string(&text)
        .map_err(|err| format!("Failed to encode input text: {err}"))?;

    eval_page_agent_call(
        &webview,
        format!("window.__PAGE_AGENT__.inputText({index}, {text_literal})"),
        page_agent_missing_action(),
        2_000,
    )
    .await
}

/// Select an option from a dropdown by its highlight index.
pub async fn internal_browser_select(
    app: AppHandle,
    label: String,
    index: i64,
    option: String,
) -> Result<InternalBrowserActionResult, String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Webview '{}' not found", label))?;

    let option_literal = serde_json::to_string(&option)
        .map_err(|err| format!("Failed to encode option text: {err}"))?;

    eval_page_agent_call(
        &webview,
        format!("window.__PAGE_AGENT__.selectOption({index}, {option_literal})"),
        page_agent_missing_action(),
        2_000,
    )
    .await
}

/// Scroll the page or an element.
pub async fn internal_browser_scroll(
    app: AppHandle,
    label: String,
    direction: String,
    pages: Option<f64>,
    element_index: Option<i64>,
) -> Result<InternalBrowserActionResult, String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Webview '{}' not found", label))?;

    let pages_val = pages.unwrap_or(1.0);
    let element_arg = match element_index {
        Some(idx) => idx.to_string(),
        None => "null".to_string(),
    };
    let direction_literal = serde_json::to_string(&direction)
        .map_err(|err| format!("Failed to encode scroll direction: {err}"))?;

    eval_page_agent_call(
        &webview,
        format!("window.__PAGE_AGENT__.scroll({direction_literal}, {pages_val}, {element_arg})"),
        page_agent_missing_action(),
        2_000,
    )
    .await
}

/// Show the user takeover mask (blocks user interaction).
pub async fn internal_browser_show_mask(
    app: AppHandle,
    label: String,
) -> Result<InternalBrowserActionResult, String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Webview '{}' not found", label))?;

    eval_page_agent_call(
        &webview,
        r#"(() => {
            window.__PAGE_AGENT__.showMask();
            return { success: true, message: "Showed the Page Agent mask." };
        })()"#
            .to_string(),
        page_agent_missing_action(),
        2_000,
    )
    .await
}

/// Hide the user takeover mask (allows user interaction).
pub async fn internal_browser_hide_mask(
    app: AppHandle,
    label: String,
) -> Result<InternalBrowserActionResult, String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Webview '{}' not found", label))?;

    eval_page_agent_call(
        &webview,
        r#"(() => {
            window.__PAGE_AGENT__.hideMask();
            return { success: true, message: "Hid the Page Agent mask." };
        })()"#
            .to_string(),
        page_agent_missing_action(),
        2_000,
    )
    .await
}

/// Clean up element highlights.
pub async fn internal_browser_clean_up(
    app: AppHandle,
    label: String,
) -> Result<InternalBrowserActionResult, String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Webview '{}' not found", label))?;

    eval_page_agent_call(
        &webview,
        r#"(() => {
            window.__PAGE_AGENT__.cleanUpHighlights();
            return { success: true, message: "Cleaned up Page Agent highlights and overlays." };
        })()"#
            .to_string(),
        page_agent_missing_action(),
        2_000,
    )
    .await
}

/// Check if Page Agent is initialized in a webview.
pub async fn internal_browser_is_ready(app: AppHandle, label: String) -> Result<bool, String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Webview '{}' not found", label))?;

    eval_page_agent_call(
        &webview,
        "(typeof window.__PAGE_AGENT__ !== 'undefined')".to_string(),
        json!(false),
        1_000,
    )
    .await
}

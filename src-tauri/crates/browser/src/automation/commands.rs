//! Tauri commands for browser automation control.
//!
//! These commands are called from the frontend (not the agent) to manage
//! the browser automation lifecycle and user takeover flow.

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

use shared_state::{AgentBrowserController, ScreenshotStore};

/// Status information for the browser automation controller.
#[derive(Debug, Clone, Serialize)]
pub struct BrowserAutomationStatus {
    pub running: bool,
    pub paused: bool,
    pub port: u16,
    pub current_url: Option<String>,
}

/// Event payload for browser:status Tauri events.
#[derive(Debug, Clone, Serialize)]
struct BrowserStatusEventPayload {
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// Emit a browser:status event to the frontend.
fn emit_browser_status(app: &AppHandle, status: &str, port: Option<u16>, error: Option<String>) {
    let _ = app.emit(
        "browser:status",
        BrowserStatusEventPayload {
            status: status.to_string(),
            port,
            error,
        },
    );
}

/// Start the browser automation controller and launch the selected browser backend.
#[tauri::command]
pub async fn browser_automation_start(
    app: AppHandle,
    agent_browser: State<'_, Arc<Mutex<AgentBrowserController>>>,
) -> Result<BrowserAutomationStatus, String> {
    emit_browser_status(&app, "starting", None, None);

    let mut controller = agent_browser.lock().await;
    controller.start().await.inspect_err(|err| {
        emit_browser_status(&app, "error", None, Some(err.clone()));
    })?;

    controller
        .request("POST", "/start", None)
        .await
        .map_err(|err| {
            let msg = format!("Failed to start browser: {}", err);
            emit_browser_status(&app, "error", Some(controller.port()), Some(msg.clone()));
            msg
        })?;

    let _ = controller
        .request(
            "POST",
            "/screencast/start",
            Some(serde_json::json!({ "maxFps": 5 })),
        )
        .await;
    controller.start_screencast_polling(app.clone());

    let port = controller.port();
    emit_browser_status(&app, "running", Some(port), None);

    Ok(BrowserAutomationStatus {
        running: controller.is_running(),
        paused: controller.is_paused(),
        port,
        current_url: None,
    })
}

/// Stop Chrome and the browser automation controller.
#[tauri::command]
pub async fn browser_automation_stop(
    app: AppHandle,
    agent_browser: State<'_, Arc<Mutex<AgentBrowserController>>>,
) -> Result<(), String> {
    let mut controller = agent_browser.lock().await;

    if controller.is_running() {
        // Stop screencast, then Chrome
        let _ = controller.request("POST", "/screencast/stop", None).await;
        let _ = controller.request("POST", "/stop", None).await;
    }

    controller.stop().await;
    emit_browser_status(&app, "idle", None, None);
    Ok(())
}

/// Pause agent automation and bring Chrome to the foreground for user takeover.
///
/// Flow:
/// 1. Mark controller as paused (agent's browser tool will refuse actions)
/// 2. Show Chrome window on-screen via CDP Browser.setWindowBounds
/// 3. Emit browser:status "paused" event to frontend
#[tauri::command]
pub async fn browser_automation_takeover(
    app: AppHandle,
    agent_browser: State<'_, Arc<Mutex<AgentBrowserController>>>,
) -> Result<(), String> {
    let controller = agent_browser.lock().await;

    if !controller.is_running() {
        return Err("Browser automation is not running".to_string());
    }

    controller.pause();

    // Show Chrome window on-screen for user interaction
    let _ = controller.request("POST", "/window/show", None).await;

    emit_browser_status(&app, "paused", Some(controller.port()), None);
    Ok(())
}

/// Retrieve a screenshot by its store ID as a base64 string.
///
/// Used by the frontend to resolve `[screenshot:ID]` markers when the
/// JS-side FIFO cache has evicted the entry.
#[tauri::command]
pub async fn browser_screenshot_get(
    id: String,
    screenshot_store: State<'_, Arc<ScreenshotStore>>,
) -> Result<Option<String>, String> {
    Ok(screenshot_store.get(&id).map(|(bytes, _url, _ts)| {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    }))
}

/// Resume agent automation after user takeover.
///
/// Flow:
/// 1. Hide Chrome window (move off-screen via CDP)
/// 2. Take a fresh snapshot so the agent sees post-takeover page state
/// 3. Unpause the controller (agent's browser tool resumes accepting actions)
/// 4. Emit browser:status "running" event to frontend
/// 5. Return the snapshot text for the agent to process
#[tauri::command]
pub async fn browser_automation_resume(
    app: AppHandle,
    agent_browser: State<'_, Arc<Mutex<AgentBrowserController>>>,
) -> Result<String, String> {
    let controller = agent_browser.lock().await;

    if !controller.is_running() {
        return Err("Browser automation is not running".to_string());
    }

    // Hide Chrome window before resuming agent control
    let _ = controller.request("POST", "/window/hide", None).await;

    // Take a fresh snapshot BEFORE unpausing — agent sees what user did
    let query = vec![("format".to_string(), "ai".to_string())];
    let snapshot = controller.get_with_query("/snapshot", &query).await?;

    let snapshot_text = snapshot
        .get("snapshot")
        .and_then(|val| val.as_str())
        .unwrap_or("(no snapshot)")
        .to_string();

    // Now unpause
    controller.resume();
    emit_browser_status(&app, "running", Some(controller.port()), None);

    Ok(snapshot_text)
}

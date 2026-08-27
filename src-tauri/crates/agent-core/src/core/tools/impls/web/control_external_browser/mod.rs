//! Browser automation tool for agents with desktop capabilities.
//!
//! Proxies browser actions to the selected agent browser engine, providing
//! browser control with role-based element references.
//!
//! Emits `browser:frame` Tauri events on screenshot/navigate/act so the
//! frontend can display live browser state.

use std::sync::Arc;

use async_trait::async_trait;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

use crate::tools::categories as tool_categories;
use crate::tools::names as tool_names;
use crate::tools::traits::{optional_string, required_string, Tool, ToolError};
use shared_state::AgentBrowserController;
use shared_state::ScreenshotStore;

mod actions;
use actions::*;

/// Payload emitted to the frontend via `browser:frame` events.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserFramePayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    screenshot: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    action: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target_id: Option<String>,
    /// Screenshot store ID for resolving `[screenshot:ID]` markers in chat history.
    #[serde(skip_serializing_if = "Option::is_none")]
    screenshot_id: Option<String>,
}

/// External browser automation tool — controls a browser through the selected agent browser engine.
///
/// Actions: navigate, snapshot, screenshot, act, tabs, console, stop
pub struct ExternalBrowserTool {
    agent_browser: Arc<Mutex<AgentBrowserController>>,
    app_handle: Option<AppHandle>,
    screenshot_store: Option<Arc<ScreenshotStore>>,
}

impl ExternalBrowserTool {
    pub fn new(
        agent_browser: Arc<Mutex<AgentBrowserController>>,
        app_handle: Option<AppHandle>,
        screenshot_store: Option<Arc<ScreenshotStore>>,
    ) -> Self {
        Self {
            agent_browser,
            app_handle,
            screenshot_store,
        }
    }

    /// Emit a `browser:frame` event to the frontend.
    fn emit_frame(&self, payload: BrowserFramePayload) {
        if let Some(ref handle) = self.app_handle {
            let _ = handle.emit("browser:frame", payload);
        }
    }

    /// Emit a `browser:status` event to the frontend.
    fn emit_status(&self, status: &str, port: Option<u16>) {
        if let Some(ref handle) = self.app_handle {
            let _ = handle.emit(
                "browser:status",
                serde_json::json!({ "status": status, "port": port }),
            );
        }
    }

    /// Store a base64 screenshot in the ScreenshotStore, emit `browser:frame`,
    /// and return the `[screenshot:<id>]` marker for the LLM tool result.
    fn store_and_emit(
        &self,
        screenshot_b64: &str,
        url: &str,
        action: &str,
        target_id: Option<String>,
    ) -> String {
        let store_id = if let Some(ref store) = self.screenshot_store {
            let bytes = BASE64.decode(screenshot_b64).unwrap_or_default();
            if bytes.is_empty() {
                None
            } else {
                Some(store.store(bytes, url))
            }
        } else {
            None
        };

        self.emit_frame(BrowserFramePayload {
            screenshot: Some(screenshot_b64.to_string()),
            url: Some(url.to_string()),
            action: Some(action.to_string()),
            target_id,
            screenshot_id: store_id.clone(),
        });

        match store_id {
            Some(id) => format!("[screenshot:{}]", id),
            None => "[screenshot captured]".to_string(),
        }
    }

    /// Ensure the agent browser is running, starting it lazily if needed.
    /// Also starts CDP screencast so the frontend gets a live frame stream.
    async fn ensure_agent_browser(&self) -> Result<(), ToolError> {
        let mut agent_browser = self.agent_browser.lock().await;
        if !agent_browser.is_running() {
            self.emit_status("starting", None);
            agent_browser.start().await.map_err(|err| {
                self.emit_status("error", None);
                ToolError::ExecutionFailed(format!("Failed to start agent browser: {}", err))
            })?;

            // Start CDP screencast + Rust-side long-poll so the Simulator
            // gets continuous frames, not just per-action screenshots.
            let _ = agent_browser
                .request(
                    "POST",
                    "/screencast/start",
                    Some(serde_json::json!({ "maxFps": 5 })),
                )
                .await;
            if let Some(ref handle) = self.app_handle {
                agent_browser.start_screencast_polling(handle.clone());
            }

            self.emit_status("running", Some(agent_browser.port()));
        }
        Ok(())
    }
}

#[async_trait]
impl Tool for ExternalBrowserTool {
    fn name(&self) -> &str {
        tool_names::CONTROL_EXTERNAL_BROWSER
    }

    fn category(&self) -> &str {
        tool_categories::WEB
    }

    fn description(&self) -> &str {
        r#"Control a Chrome browser for web navigation, interaction, and data extraction.
Chrome launches automatically on first use — no need to call `start` explicitly.

## Workflow
1. Use `navigate` to go to a URL (Chrome starts automatically if needed)
2. Use `snapshot` to see the page structure with element refs (e.g., e1, e2)
3. Use `act` to interact: click, type, hover, press keys, etc.
4. Use `screenshot` to capture visual state

## Element References
Snapshots annotate elements with `[ref=e1]`. Use these refs in act commands:
- `{"action": "act", "request": {"kind": "click", "ref": "e1"}}`
- `{"action": "act", "request": {"kind": "type", "ref": "e3", "text": "hello"}}`

## Tips
- Always `snapshot` before acting — refs change between page loads
- Use `snapshot` with `snapshotFormat: "ai"` for the most useful format
- For forms, use `act` with `kind: "fill"` and `fields` array
- Check `console` for JavaScript errors if something isn't working"#
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["navigate", "snapshot", "screenshot", "act", "tabs", "console", "stop"],
                    "description": "The browser action to perform. Chrome starts automatically — just use navigate directly."
                },
                "targetUrl": {
                    "type": "string",
                    "description": "URL for navigate action"
                },
                "targetId": {
                    "type": "string",
                    "description": "Tab target ID (optional, defaults to active tab)"
                },
                "snapshotFormat": {
                    "type": "string",
                    "enum": ["ai", "aria"],
                    "description": "Snapshot format (default: ai)"
                },
                "mode": {
                    "type": "string",
                    "enum": ["efficient"],
                    "description": "Snapshot mode — 'efficient' returns a smaller snapshot"
                },
                "refs": {
                    "type": "string",
                    "enum": ["role", "aria"],
                    "description": "Ref annotation style (default: role)"
                },
                "interactive": {
                    "type": "boolean",
                    "description": "Only include interactive elements in snapshot"
                },
                "compact": {
                    "type": "boolean",
                    "description": "Compact snapshot format"
                },
                "selector": {
                    "type": "string",
                    "description": "CSS selector to scope snapshot to a subtree"
                },
                "fullPage": {
                    "type": "boolean",
                    "description": "Capture full page screenshot (not just viewport)"
                },
                "request": {
                    "type": "object",
                    "description": "Act request object with kind and parameters",
                    "properties": {
                        "kind": {
                            "type": "string",
                            "enum": ["click", "type", "press", "hover", "drag", "select", "fill", "resize", "wait", "evaluate", "close"],
                            "description": "Type of interaction"
                        },
                        "ref": {
                            "type": "string",
                            "description": "Element ref from snapshot (e.g., 'e1')"
                        },
                        "text": {
                            "type": "string",
                            "description": "Text to type"
                        },
                        "key": {
                            "type": "string",
                            "description": "Key to press (e.g., 'Enter', 'Tab')"
                        },
                        "submit": {
                            "type": "boolean",
                            "description": "Press Enter after typing"
                        },
                        "doubleClick": {
                            "type": "boolean",
                            "description": "Double-click instead of single click"
                        },
                        "startRef": {
                            "type": "string",
                            "description": "Start ref for drag"
                        },
                        "endRef": {
                            "type": "string",
                            "description": "End ref for drag"
                        },
                        "values": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "Values for select"
                        },
                        "fields": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "ref": { "type": "string" },
                                    "type": { "type": "string" },
                                    "value": { "type": "string" }
                                }
                            },
                            "description": "Fields array for fill"
                        },
                        "width": {
                            "type": "number",
                            "description": "Width for resize"
                        },
                        "height": {
                            "type": "number",
                            "description": "Height for resize"
                        },
                        "timeMs": {
                            "type": "number",
                            "description": "Wait time in milliseconds"
                        },
                        "fn": {
                            "type": "string",
                            "description": "JavaScript function for evaluate"
                        }
                    },
                    "required": ["kind"]
                }
            },
            "required": ["action"]
        })
    }

    async fn execute_text(
        &self,
        params: Value,
        ctx: &crate::tools::traits::CallContext,
    ) -> Result<String, ToolError> {
        ctx.require_tool_authority(self.name())?;
        let action = required_string(&params, "action")?;

        // Auto-start agent_browser for actions that need it
        match action.as_str() {
            "stop" => {}
            _ => self.ensure_agent_browser().await?,
        }

        let agent_browser = self.agent_browser.lock().await;

        // Check pause state
        if agent_browser.is_paused() {
            return Err(ToolError::ExecutionFailed(
                "Browser automation is paused (user takeover in progress). Wait for the user to return control.".to_string(),
            ));
        }

        let target_id = optional_string(&params, "targetId");

        // For screenshot action, store in ScreenshotStore and return lightweight marker
        if action == "screenshot" {
            let (text, screenshot_b64, url) =
                execute_screenshot_with_data(&agent_browser, &params, target_id.as_deref()).await?;
            let marker =
                self.store_and_emit(&screenshot_b64, &url, "screenshot", target_id.clone());
            return Ok(format!("{}\n{}", text, marker));
        }

        let result = match action.as_str() {
            "start" => execute_start(&agent_browser).await,
            "stop" => {
                let res = execute_stop(&agent_browser).await;
                if res.is_ok() {
                    self.emit_status("idle", None);
                }
                res
            }
            "navigate" => execute_navigate(&agent_browser, &params).await,
            "snapshot" => execute_snapshot(&agent_browser, &params).await,
            "act" => execute_act(&agent_browser, &params, target_id.as_deref()).await,
            "tabs" => execute_tabs(&agent_browser).await,
            "console" => execute_console(&agent_browser, target_id.as_deref()).await,
            _ => Err(ToolError::InvalidParams(format!(
                "Unknown browser action: {}",
                action
            ))),
        };

        // After navigate or act, take an automatic screenshot, store it,
        // and append the lightweight marker to the tool result.
        if result.is_ok() && matches!(action.as_str(), "navigate" | "act") {
            if let Ok(auto_shot) = agent_browser.request("POST", "/screenshot", None).await {
                let screenshot = auto_shot
                    .get("screenshot")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                let url = auto_shot
                    .get("url")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                if !screenshot.is_empty() {
                    let tid = auto_shot
                        .get("targetId")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    let marker = self.store_and_emit(screenshot, url, &action, tid);
                    let text = result.unwrap_or_default();
                    return Ok(format!("{}\n{}", text, marker));
                }
            }
        }

        result
    }
}

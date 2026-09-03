//! Agent-facing internal browser tool.
//!
//! The tool only resolves the currently visible ORGII internal browser
//! WebView. Agents do not provide arbitrary labels; all actions go through the
//! active target tracked by the frontend-owned BrowserSessionWebview lifecycle.

use async_trait::async_trait;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::time::{sleep, Duration, Instant};

use crate::tools::categories as tool_categories;
use crate::tools::names as tool_names;
use crate::tools::traits::{params_schema, parse_params_described, Tool, ToolError, ToolPriority};

const INTERNAL_BROWSER_NOT_READY_MESSAGE: &str =
    "Internal browser automation requires a running Tauri app handle.";
const ACTION_URL_REFRESH_TIMEOUT_MS: u64 = 700;
const ACTION_URL_REFRESH_POLL_MS: u64 = 100;

#[derive(Debug, Clone, Copy, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum InternalBrowserAction {
    /// List known internal browser targets and the currently active target.
    List,
    /// Check whether the active internal browser Page Agent is ready.
    IsReady,
    /// Read the active internal browser DOM state.
    GetState,
    /// Click an indexed element in the active internal browser.
    Click,
    /// Replace text in an indexed input, textarea, or contenteditable element.
    Input,
    /// Select an option by visible text in an indexed select element.
    Select,
    /// Scroll the active page or an indexed scrollable element.
    Scroll,
    /// Show the Page Agent mask in the active internal browser.
    ShowMask,
    /// Hide the Page Agent mask in the active internal browser.
    HideMask,
    /// Clean up Page Agent highlights and overlays in the active internal browser.
    CleanUp,
}

#[derive(Debug, Clone, Copy, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum InternalBrowserScrollDirection {
    Up,
    Down,
    Left,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UrlRefreshMode {
    None,
    Immediate,
    WaitForChange,
}

impl InternalBrowserScrollDirection {
    fn as_page_agent_str(self) -> &'static str {
        match self {
            Self::Up => "up",
            Self::Down => "down",
            Self::Left => "left",
            Self::Right => "right",
        }
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InternalBrowserParams {
    /// Internal browser action to perform.
    action: InternalBrowserAction,
    /// Highlight index from get_state. Required for click, input, and select.
    #[serde(default)]
    index: Option<i64>,
    /// Text to write into the target element. Required for input.
    #[serde(default)]
    text: Option<String>,
    /// Visible option text to select. Required for select.
    #[serde(default)]
    option: Option<String>,
    /// Direction to scroll. Required for scroll.
    #[serde(default)]
    direction: Option<InternalBrowserScrollDirection>,
    /// Number of viewport pages to scroll. Defaults to 1.0.
    #[serde(default)]
    pages: Option<f64>,
    /// Optional highlight index of a scrollable element. Omit to scroll the page.
    #[serde(default)]
    element_index: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct InternalBrowserToolTarget {
    browser_session_id: String,
    label: String,
    url: String,
    active_webview_exists: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct InternalBrowserTargetSummary {
    label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    browser_session_id: Option<String>,
    is_active: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InternalBrowserListResponse {
    success: bool,
    action: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    active: Option<InternalBrowserToolTarget>,
    active_webview_exists: bool,
    webviews: Vec<InternalBrowserTargetSummary>,
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InternalBrowserReadyResponse {
    success: bool,
    action: &'static str,
    ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    target: Option<InternalBrowserToolTarget>,
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InternalBrowserStateResponse {
    success: bool,
    action: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    target: Option<InternalBrowserToolTarget>,
    #[serde(skip_serializing_if = "Option::is_none")]
    state: Option<browser::InternalBrowserState>,
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InternalBrowserActionResponse {
    success: bool,
    action: &'static str,
    target: InternalBrowserToolTarget,
    before_url: String,
    actual_url: String,
    actual_url_changed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    url_refresh_error: Option<String>,
    result: browser::InternalBrowserActionResult,
    message: String,
}

pub struct InternalBrowserTool {
    app_handle: Option<AppHandle>,
}

impl InternalBrowserTool {
    pub fn new(app_handle: Option<AppHandle>) -> Self {
        Self { app_handle }
    }

    fn app_handle(&self) -> Result<AppHandle, ToolError> {
        self.app_handle
            .clone()
            .ok_or_else(|| ToolError::ExecutionFailed(INTERNAL_BROWSER_NOT_READY_MESSAGE.into()))
    }

    fn response_text<T: Serialize>(response: &T) -> Result<String, ToolError> {
        serde_json::to_string_pretty(response).map_err(|err| {
            ToolError::ExecutionFailed(format!(
                "Failed to serialize internal browser response: {err}"
            ))
        })
    }

    async fn resolve_ready_target(
        &self,
    ) -> Result<(AppHandle, InternalBrowserToolTarget), ToolError> {
        let app = self.app_handle()?;
        let targets = browser::list_internal_browser_targets(app.clone()).map_err(|err| {
            ToolError::ExecutionFailed(format!("Failed to list internal browser targets: {err}"))
        })?;
        let Some(target) = resolvable_active_target(&targets) else {
            return Err(ToolError::ExecutionFailed(inactive_target_message(
                &targets,
            )));
        };

        let ready = browser::internal_browser_is_ready(app.clone(), target.label.clone())
            .await
            .map_err(|err| {
                ToolError::ExecutionFailed(format!("Failed to check Page Agent readiness: {err}"))
            })?;
        if !ready {
            return Err(ToolError::ExecutionFailed(
                "Page Agent is not ready in the active internal browser.".to_string(),
            ));
        }

        Ok((app, target))
    }

    async fn execute_list(&self) -> Result<String, ToolError> {
        let app = self.app_handle()?;
        let targets = browser::list_internal_browser_targets(app).map_err(|err| {
            ToolError::ExecutionFailed(format!("Failed to list internal browser targets: {err}"))
        })?;
        let active = active_target(&targets);
        let response = InternalBrowserListResponse {
            success: true,
            action: "list",
            active,
            active_webview_exists: targets.active_webview_exists,
            webviews: targets
                .webviews
                .into_iter()
                .map(|target| InternalBrowserTargetSummary {
                    label: target.label,
                    browser_session_id: target.browser_session_id,
                    is_active: target.is_active,
                })
                .collect(),
            message: "Listed internal browser targets.".to_string(),
        };
        Self::response_text(&response)
    }

    async fn execute_is_ready(&self) -> Result<String, ToolError> {
        let app = self.app_handle()?;
        let targets = browser::list_internal_browser_targets(app.clone()).map_err(|err| {
            ToolError::ExecutionFailed(format!("Failed to list internal browser targets: {err}"))
        })?;
        let Some(target) = resolvable_active_target(&targets) else {
            let response = InternalBrowserReadyResponse {
                success: false,
                action: "is_ready",
                ready: false,
                target: active_target(&targets),
                message: inactive_target_message(&targets),
            };
            return Self::response_text(&response);
        };

        let ready = browser::internal_browser_is_ready(app, target.label.clone())
            .await
            .map_err(|err| {
                ToolError::ExecutionFailed(format!("Failed to check Page Agent readiness: {err}"))
            })?;
        let response = InternalBrowserReadyResponse {
            success: true,
            action: "is_ready",
            ready,
            target: Some(target),
            message: if ready {
                "Page Agent is ready in the active internal browser.".to_string()
            } else {
                "Page Agent is not ready in the active internal browser.".to_string()
            },
        };
        Self::response_text(&response)
    }

    async fn execute_get_state(&self) -> Result<String, ToolError> {
        let app = self.app_handle()?;
        let targets = browser::list_internal_browser_targets(app.clone()).map_err(|err| {
            ToolError::ExecutionFailed(format!("Failed to list internal browser targets: {err}"))
        })?;
        let Some(target) = resolvable_active_target(&targets) else {
            let response = InternalBrowserStateResponse {
                success: false,
                action: "get_state",
                target: active_target(&targets),
                state: None,
                message: inactive_target_message(&targets),
            };
            return Self::response_text(&response);
        };

        let ready = browser::internal_browser_is_ready(app.clone(), target.label.clone())
            .await
            .map_err(|err| {
                ToolError::ExecutionFailed(format!("Failed to check Page Agent readiness: {err}"))
            })?;
        if !ready {
            let response = InternalBrowserStateResponse {
                success: false,
                action: "get_state",
                target: Some(target),
                state: None,
                message: "Page Agent is not ready in the active internal browser.".to_string(),
            };
            return Self::response_text(&response);
        }

        let state = browser::internal_browser_get_state(app, target.label.clone())
            .await
            .map_err(|err| {
                ToolError::ExecutionFailed(format!("Failed to read internal browser state: {err}"))
            })?;
        let response = InternalBrowserStateResponse {
            success: true,
            action: "get_state",
            target: Some(target),
            state: Some(state),
            message: "Read active internal browser state.".to_string(),
        };
        Self::response_text(&response)
    }

    async fn execute_click(&self, params: &InternalBrowserParams) -> Result<String, ToolError> {
        let index = required_index(params, "click")?;
        let (app, target) = self.resolve_ready_target().await?;
        let result = browser::internal_browser_click(app.clone(), target.label.clone(), index)
            .await
            .map_err(|err| ToolError::ExecutionFailed(format!("Failed to click element: {err}")))?;
        self.action_response(app, "click", target, result, UrlRefreshMode::WaitForChange)
            .await
    }

    async fn execute_input(&self, params: &InternalBrowserParams) -> Result<String, ToolError> {
        let index = required_index(params, "input")?;
        let text = params
            .text
            .clone()
            .ok_or_else(|| ToolError::InvalidParams("input requires text".to_string()))?;
        let (app, target) = self.resolve_ready_target().await?;
        let result =
            browser::internal_browser_input(app.clone(), target.label.clone(), index, text)
                .await
                .map_err(|err| {
                    ToolError::ExecutionFailed(format!("Failed to input text: {err}"))
                })?;
        self.action_response(app, "input", target, result, UrlRefreshMode::Immediate)
            .await
    }

    async fn execute_select(&self, params: &InternalBrowserParams) -> Result<String, ToolError> {
        let index = required_index(params, "select")?;
        let option = params
            .option
            .clone()
            .ok_or_else(|| ToolError::InvalidParams("select requires option".to_string()))?;
        let (app, target) = self.resolve_ready_target().await?;
        let result =
            browser::internal_browser_select(app.clone(), target.label.clone(), index, option)
                .await
                .map_err(|err| {
                    ToolError::ExecutionFailed(format!("Failed to select option: {err}"))
                })?;
        self.action_response(app, "select", target, result, UrlRefreshMode::Immediate)
            .await
    }

    async fn execute_scroll(&self, params: &InternalBrowserParams) -> Result<String, ToolError> {
        let direction = params
            .direction
            .ok_or_else(|| ToolError::InvalidParams("scroll requires direction".to_string()))?;
        validate_scroll_pages(params.pages)?;
        if let Some(element_index) = params.element_index {
            validate_index(element_index, "elementIndex")?;
        }

        let (app, target) = self.resolve_ready_target().await?;
        let result = browser::internal_browser_scroll(
            app.clone(),
            target.label.clone(),
            direction.as_page_agent_str().to_string(),
            params.pages,
            params.element_index,
        )
        .await
        .map_err(|err| ToolError::ExecutionFailed(format!("Failed to scroll: {err}")))?;
        self.action_response(app, "scroll", target, result, UrlRefreshMode::Immediate)
            .await
    }

    async fn execute_show_mask(&self) -> Result<String, ToolError> {
        let (app, target) = self.resolve_ready_target().await?;
        let result = browser::internal_browser_show_mask(app.clone(), target.label.clone())
            .await
            .map_err(|err| ToolError::ExecutionFailed(format!("Failed to show mask: {err}")))?;
        self.action_response(app, "show_mask", target, result, UrlRefreshMode::None)
            .await
    }

    async fn execute_hide_mask(&self) -> Result<String, ToolError> {
        let (app, target) = self.resolve_ready_target().await?;
        let result = browser::internal_browser_hide_mask(app.clone(), target.label.clone())
            .await
            .map_err(|err| ToolError::ExecutionFailed(format!("Failed to hide mask: {err}")))?;
        self.action_response(app, "hide_mask", target, result, UrlRefreshMode::None)
            .await
    }

    async fn execute_clean_up(&self) -> Result<String, ToolError> {
        let (app, target) = self.resolve_ready_target().await?;
        let result = browser::internal_browser_clean_up(app.clone(), target.label.clone())
            .await
            .map_err(|err| {
                ToolError::ExecutionFailed(format!("Failed to clean up overlays: {err}"))
            })?;
        self.action_response(app, "clean_up", target, result, UrlRefreshMode::None)
            .await
    }

    async fn action_response(
        &self,
        app: AppHandle,
        action: &'static str,
        target: InternalBrowserToolTarget,
        result: browser::InternalBrowserActionResult,
        refresh_url: UrlRefreshMode,
    ) -> Result<String, ToolError> {
        let before_url = target.url.clone();
        let mut actual_url = before_url.clone();
        let mut actual_title: Option<String> = None;
        let mut url_refresh_error = None;

        match Self::refresh_location_after_action(
            app.clone(),
            target.label.clone(),
            &before_url,
            refresh_url,
        )
        .await
        {
            Ok(Some(location)) => {
                actual_url = location.url;
                actual_title = Some(location.title);
            }
            Ok(None) => {}
            Err(err) => {
                url_refresh_error = Some(err);
            }
        }

        let actual_url_changed = actual_url != before_url;
        if actual_url_changed {
            let _ = app.emit(
                "internal-browser:url-changed",
                json!({
                    "browserSessionId": target.browser_session_id.clone(),
                    "label": target.label.clone(),
                    "url": actual_url.clone(),
                    "title": actual_title.clone(),
                    "source": "agent-dom-action"
                }),
            );
        }

        let response = InternalBrowserActionResponse {
            success: result.success,
            action,
            target,
            before_url,
            actual_url,
            actual_url_changed,
            url_refresh_error,
            message: result.message.clone(),
            result,
        };
        Self::response_text(&response)
    }

    async fn refresh_location_after_action(
        app: AppHandle,
        label: String,
        before_url: &str,
        mode: UrlRefreshMode,
    ) -> Result<Option<browser::InternalBrowserLocation>, String> {
        match mode {
            UrlRefreshMode::None => Ok(None),
            UrlRefreshMode::Immediate => browser::internal_browser_get_location(app, label)
                .await
                .map(Some),
            UrlRefreshMode::WaitForChange => {
                let deadline =
                    Instant::now() + Duration::from_millis(ACTION_URL_REFRESH_TIMEOUT_MS);
                let mut last_location = None;
                let mut last_error = None;

                loop {
                    match browser::internal_browser_get_location(app.clone(), label.clone()).await {
                        Ok(location) => {
                            if location.url != before_url {
                                return Ok(Some(location));
                            }
                            last_location = Some(location);
                        }
                        Err(err) => {
                            last_error = Some(err);
                        }
                    }

                    if Instant::now() >= deadline {
                        return if let Some(location) = last_location {
                            Ok(Some(location))
                        } else {
                            Err(last_error.unwrap_or_else(|| {
                                "Timed out refreshing internal browser URL after action."
                                    .to_string()
                            }))
                        };
                    }

                    sleep(Duration::from_millis(ACTION_URL_REFRESH_POLL_MS)).await;
                }
            }
        }
    }
}

fn required_index(params: &InternalBrowserParams, action: &str) -> Result<i64, ToolError> {
    let index = params
        .index
        .ok_or_else(|| ToolError::InvalidParams(format!("{action} requires index")))?;
    validate_index(index, "index")?;
    Ok(index)
}

fn validate_index(index: i64, field: &str) -> Result<(), ToolError> {
    if index < 0 {
        return Err(ToolError::InvalidParams(format!(
            "{field} must be greater than or equal to 0"
        )));
    }
    Ok(())
}

fn validate_scroll_pages(pages: Option<f64>) -> Result<(), ToolError> {
    if let Some(pages) = pages {
        if !pages.is_finite() || pages <= 0.0 {
            return Err(ToolError::InvalidParams(
                "scroll pages must be a positive finite number".to_string(),
            ));
        }
    }
    Ok(())
}

fn active_target(
    targets: &browser::InternalBrowserTargetList,
) -> Option<InternalBrowserToolTarget> {
    targets
        .active
        .as_ref()
        .map(|active| InternalBrowserToolTarget {
            browser_session_id: active.browser_session_id.clone(),
            label: active.label.clone(),
            url: active.url.clone(),
            active_webview_exists: targets.active_webview_exists,
        })
}

fn resolvable_active_target(
    targets: &browser::InternalBrowserTargetList,
) -> Option<InternalBrowserToolTarget> {
    if !targets.active_webview_exists {
        return None;
    }
    active_target(targets)
}

fn inactive_target_message(targets: &browser::InternalBrowserTargetList) -> String {
    if targets.active.is_none() {
        "No active internal browser WebView is available. Open an internal Browser tab first."
            .to_string()
    } else if !targets.active_webview_exists {
        "The tracked active internal browser WebView no longer exists. Activate a Browser tab again."
            .to_string()
    } else {
        "No resolvable active internal browser WebView is available.".to_string()
    }
}

#[async_trait]
impl Tool for InternalBrowserTool {
    fn name(&self) -> &str {
        tool_names::CONTROL_INTERNAL_BROWSER
    }

    fn category(&self) -> &str {
        tool_categories::WEB
    }

    fn description(&self) -> &str {
        "Inspect and control the currently visible ORGII internal Browser WebView. Resolves only the active internal browser target and supports list, is_ready, get_state, click, input, select, scroll, show_mask, hide_mask, and clean_up. Call get_state before indexed actions; indexes are page-state snapshots and may become stale after DOM changes, scrolling, or navigation."
    }

    fn is_ready(&self) -> bool {
        self.app_handle.is_some()
    }

    fn not_ready_reason(&self) -> Option<&str> {
        if self.app_handle.is_some() {
            None
        } else {
            Some(INTERNAL_BROWSER_NOT_READY_MESSAGE)
        }
    }

    fn search_hint(&self) -> &str {
        "internal browser webview tauri webview2 dom page agent get_state click input select scroll show_mask hide_mask clean_up is_ready"
    }

    fn parameters(&self) -> Value {
        params_schema::<InternalBrowserParams>()
    }

    async fn execute_text(
        &self,
        params: Value,
        ctx: &crate::tools::traits::CallContext,
    ) -> Result<String, ToolError> {
        ctx.require_tool_authority(self.name())?;
        let params: InternalBrowserParams = parse_params_described(params)?;
        match params.action {
            InternalBrowserAction::List => self.execute_list().await,
            InternalBrowserAction::IsReady => self.execute_is_ready().await,
            InternalBrowserAction::GetState => self.execute_get_state().await,
            InternalBrowserAction::Click => self.execute_click(&params).await,
            InternalBrowserAction::Input => self.execute_input(&params).await,
            InternalBrowserAction::Select => self.execute_select(&params).await,
            InternalBrowserAction::Scroll => self.execute_scroll(&params).await,
            InternalBrowserAction::ShowMask => self.execute_show_mask().await,
            InternalBrowserAction::HideMask => self.execute_hide_mask().await,
            InternalBrowserAction::CleanUp => self.execute_clean_up().await,
        }
    }

    fn priority(&self) -> ToolPriority {
        ToolPriority::Always
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn active_state(session_id: &str) -> browser::ActiveInternalBrowserState {
        browser::ActiveInternalBrowserState {
            browser_session_id: session_id.to_string(),
            label: format!("browser-session-{session_id}"),
            url: "https://example.com".to_string(),
            visible: true,
            updated_at: 10,
        }
    }

    fn target_list(
        active: Option<browser::ActiveInternalBrowserState>,
        active_webview_exists: bool,
    ) -> browser::InternalBrowserTargetList {
        browser::InternalBrowserTargetList {
            active,
            active_webview_exists,
            webviews: Vec::new(),
        }
    }

    #[test]
    fn resolves_active_target_only_when_webview_exists() {
        let targets = target_list(Some(active_state("abc")), true);
        let target = resolvable_active_target(&targets).expect("target should resolve");

        assert_eq!(target.browser_session_id, "abc");
        assert_eq!(target.label, "browser-session-abc");
        assert!(target.active_webview_exists);
    }

    #[test]
    fn refuses_stale_active_target_without_webview() {
        let targets = target_list(Some(active_state("abc")), false);

        assert!(resolvable_active_target(&targets).is_none());
        assert!(inactive_target_message(&targets).contains("no longer exists"));
    }

    #[test]
    fn reports_missing_active_target() {
        let targets = target_list(None, false);

        assert!(resolvable_active_target(&targets).is_none());
        assert!(inactive_target_message(&targets).contains("No active"));
    }

    #[test]
    fn validates_required_action_index() {
        let params = InternalBrowserParams {
            action: InternalBrowserAction::Click,
            index: None,
            text: None,
            option: None,
            direction: None,
            pages: None,
            element_index: None,
        };

        assert!(required_index(&params, "click").is_err());
    }

    #[test]
    fn rejects_negative_action_index() {
        let params = InternalBrowserParams {
            action: InternalBrowserAction::Click,
            index: Some(-1),
            text: None,
            option: None,
            direction: None,
            pages: None,
            element_index: None,
        };

        assert!(required_index(&params, "click").is_err());
    }

    #[test]
    fn validates_scroll_pages() {
        assert!(validate_scroll_pages(None).is_ok());
        assert!(validate_scroll_pages(Some(1.0)).is_ok());
        assert!(validate_scroll_pages(Some(0.0)).is_err());
        assert!(validate_scroll_pages(Some(f64::NAN)).is_err());
    }

    #[test]
    fn maps_scroll_direction_for_page_agent() {
        assert_eq!(InternalBrowserScrollDirection::Up.as_page_agent_str(), "up");
        assert_eq!(
            InternalBrowserScrollDirection::Down.as_page_agent_str(),
            "down"
        );
        assert_eq!(
            InternalBrowserScrollDirection::Left.as_page_agent_str(),
            "left"
        );
        assert_eq!(
            InternalBrowserScrollDirection::Right.as_page_agent_str(),
            "right"
        );
    }

    #[test]
    fn parses_overlay_actions() {
        for (action, expected) in [
            ("show_mask", InternalBrowserAction::ShowMask),
            ("hide_mask", InternalBrowserAction::HideMask),
            ("clean_up", InternalBrowserAction::CleanUp),
        ] {
            let params: InternalBrowserParams =
                serde_json::from_value(serde_json::json!({ "action": action }))
                    .expect("overlay action should parse");
            assert_eq!(params.action, expected);
        }
    }
}

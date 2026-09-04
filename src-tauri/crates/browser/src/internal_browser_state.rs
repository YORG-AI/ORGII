//! Active internal browser target state.
//!
//! This is a small bridge from the frontend-owned inline WebView lifecycle to
//! Rust. Agent-facing tools can later resolve "the current internal browser"
//! without guessing from a generic active session id.

use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const BROWSER_SESSION_LABEL_PREFIX: &str = "browser-session-";
const ABOUT_BLANK_URL: &str = "about:blank";

static ACTIVE_INTERNAL_BROWSER: OnceLock<Mutex<Option<ActiveInternalBrowserState>>> =
    OnceLock::new();

fn active_state() -> &'static Mutex<Option<ActiveInternalBrowserState>> {
    ACTIVE_INTERNAL_BROWSER.get_or_init(|| Mutex::new(None))
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn browser_session_id_from_label(label: &str) -> Option<String> {
    label
        .strip_prefix(BROWSER_SESSION_LABEL_PREFIX)
        .filter(|session_id| !session_id.is_empty())
        .map(str::to_string)
}

fn expected_label_for_session(browser_session_id: &str) -> String {
    format!("{BROWSER_SESSION_LABEL_PREFIX}{browser_session_id}")
}

fn validate_active_state(state: &ActiveInternalBrowserState) -> Result<(), String> {
    if state.browser_session_id.trim().is_empty() {
        return Err("browser_session_id is required".to_string());
    }
    if state.label.trim().is_empty() {
        return Err("label is required".to_string());
    }
    if !state.label.starts_with(BROWSER_SESSION_LABEL_PREFIX) {
        return Err(format!(
            "internal browser label must start with '{BROWSER_SESSION_LABEL_PREFIX}'"
        ));
    }
    let expected_label = expected_label_for_session(&state.browser_session_id);
    if state.label != expected_label {
        return Err(format!(
            "label '{}' does not match browser_session_id '{}'",
            state.label, state.browser_session_id
        ));
    }
    if !state.visible {
        return Err("active internal browser state must be visible".to_string());
    }
    let normalized_url = state.url.trim().to_ascii_lowercase();
    if normalized_url.is_empty() || normalized_url.starts_with(ABOUT_BLANK_URL) {
        return Err("active internal browser url must be navigable".to_string());
    }
    Ok(())
}

fn should_clear(
    current: &ActiveInternalBrowserState,
    label: Option<&str>,
    browser_session_id: Option<&str>,
    updated_at: Option<u64>,
) -> bool {
    if let Some(label) = label {
        if current.label != label {
            return false;
        }
    }

    if let Some(browser_session_id) = browser_session_id {
        if current.browser_session_id != browser_session_id {
            return false;
        }
    }

    if let Some(updated_at) = updated_at {
        if current.updated_at > updated_at {
            return false;
        }
    }

    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActiveInternalBrowserState {
    pub browser_session_id: String,
    pub label: String,
    pub url: String,
    pub visible: bool,
    #[serde(default)]
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InternalBrowserTargetInfo {
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub browser_session_id: Option<String>,
    pub is_active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InternalBrowserTargetList {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active: Option<ActiveInternalBrowserState>,
    pub active_webview_exists: bool,
    pub webviews: Vec<InternalBrowserTargetInfo>,
}

/// Set the currently visible internal browser target.
#[tauri::command]
pub fn set_active_internal_browser_state(
    mut state: ActiveInternalBrowserState,
) -> Result<ActiveInternalBrowserState, String> {
    if state.updated_at == 0 {
        state.updated_at = now_millis();
    }
    validate_active_state(&state)?;

    let mut guard = active_state()
        .lock()
        .map_err(|err| format!("active internal browser state lock failed: {err}"))?;
    *guard = Some(state.clone());

    Ok(state)
}

/// Clear the active internal browser target.
///
/// When label/session/timestamp filters are provided, stale clear calls will not
/// clear a newer active target that replaced the old one.
#[tauri::command]
pub fn clear_active_internal_browser_state(
    label: Option<String>,
    browser_session_id: Option<String>,
    #[allow(unused_variables)] reason: Option<String>,
    updated_at: Option<u64>,
) -> Result<Option<ActiveInternalBrowserState>, String> {
    let mut guard = active_state()
        .lock()
        .map_err(|err| format!("active internal browser state lock failed: {err}"))?;

    let should_remove = guard.as_ref().is_some_and(|current| {
        should_clear(
            current,
            label.as_deref(),
            browser_session_id.as_deref(),
            updated_at,
        )
    });

    if should_remove {
        *guard = None;
    }

    Ok(guard.clone())
}

/// Return the active internal browser target, if any.
pub fn get_active_internal_browser_state() -> Result<Option<ActiveInternalBrowserState>, String> {
    active_state()
        .lock()
        .map(|guard| guard.clone())
        .map_err(|err| format!("active internal browser state lock failed: {err}"))
}

/// List inline WebViews that look like ORGII browser sessions.
pub fn list_internal_browser_targets(app: AppHandle) -> Result<InternalBrowserTargetList, String> {
    let active = get_active_internal_browser_state()?;
    let webviews = app.webviews();

    let mut targets: Vec<InternalBrowserTargetInfo> = webviews
        .keys()
        .filter(|label| label.starts_with(BROWSER_SESSION_LABEL_PREFIX))
        .map(|label| InternalBrowserTargetInfo {
            label: label.clone(),
            browser_session_id: browser_session_id_from_label(label),
            is_active: active
                .as_ref()
                .is_some_and(|active_state| active_state.label == *label),
        })
        .collect();

    targets.sort_by(|left, right| left.label.cmp(&right.label));

    let active_webview_exists = active
        .as_ref()
        .is_some_and(|active_state| webviews.contains_key(&active_state.label));

    Ok(InternalBrowserTargetList {
        active,
        active_webview_exists,
        webviews: targets,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(session_id: &str, updated_at: u64) -> ActiveInternalBrowserState {
        ActiveInternalBrowserState {
            browser_session_id: session_id.to_string(),
            label: expected_label_for_session(session_id),
            url: "https://example.com".to_string(),
            visible: true,
            updated_at,
        }
    }

    #[test]
    fn validates_matching_browser_session_label() {
        assert!(validate_active_state(&state("abc", 1)).is_ok());

        let mut invalid = state("abc", 1);
        invalid.label = "browser-session-other".to_string();

        assert!(validate_active_state(&invalid).is_err());
    }

    #[test]
    fn rejects_blank_active_browser_urls() {
        let mut empty = state("abc", 1);
        empty.url = "   ".to_string();
        assert!(validate_active_state(&empty).is_err());

        let mut about_blank = state("abc", 1);
        about_blank.url = "about:blank#blocked".to_string();
        assert!(validate_active_state(&about_blank).is_err());
    }

    #[test]
    fn stale_clear_does_not_remove_newer_state() {
        let current = state("abc", 20);

        assert!(!should_clear(
            &current,
            Some("browser-session-abc"),
            Some("abc"),
            Some(10)
        ));
    }

    #[test]
    fn matching_clear_removes_current_state() {
        let current = state("abc", 20);

        assert!(should_clear(
            &current,
            Some("browser-session-abc"),
            Some("abc"),
            Some(20)
        ));
    }

    #[test]
    fn clear_for_other_label_is_ignored() {
        let current = state("abc", 20);

        assert!(!should_clear(
            &current,
            Some("browser-session-other"),
            Some("other"),
            Some(25)
        ));
    }
}

//! Inline Webview Management
//!
//! Webviews embedded within the main application window.
//! Used for displaying web content inline (e.g., embedded browser panels).
//!
//! ## Single-owner model
//!
//! My Station is the sole owner of every native webview. Control Tower is a
//! secondary viewer that publishes its container rect via `controlTowerBrowserRectAtom`
//! (frontend) so My Station can reposition the webview into CT's pane when CT
//! is active. CT never calls `create_inline_webview` itself.
//!
//! The ref-count registry (`WEBVIEW_REF_COUNTS`) is retained as a safety net
//! for any future multi-caller scenario and to guard against double-close races
//! during fast tab open/close sequences.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use tauri::webview::WebviewBuilder;
use tauri::WebviewUrl;
use tauri::{AppHandle, Emitter, Manager};
use tracing::{debug, warn};

use super::scripts::{
    ANTI_BOT_DETECTION_SCRIPT, CONSOLE_CAPTURE_SCRIPT, ELEMENT_INSPECTOR_SCRIPT,
    NETWORK_CAPTURE_SCRIPT, PAGE_AGENT_SCRIPT, SHORTCUT_FORWARDING_SCRIPT,
};

/// Global ref-count table: label → number of active React instances that have
/// called `create_inline_webview` and not yet called `close_inline_webview`.
static WEBVIEW_REF_COUNTS: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();

/// Latest frontend lifecycle generation per webview label.
static WEBVIEW_GENERATIONS: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();

/// Cancelled generations per webview label. A create that finishes after its
/// generation has been cancelled must never become visible.
static WEBVIEW_CANCELLED_GENERATIONS: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();

const OFFSCREEN_POSITION: f64 = -10000.0;
const OFFSCREEN_MIN_SIZE: f64 = 1.0;

fn frame_from_corners(
    x: f64,
    y: f64,
    a: Option<f64>,
    b: Option<f64>,
    width: f64,
    height: f64,
) -> (f64, f64, f64, f64) {
    let resolved_width = a
        .map(|right| (right - x).max(OFFSCREEN_MIN_SIZE))
        .unwrap_or(width);
    let resolved_height = b
        .map(|bottom| (bottom - y).max(OFFSCREEN_MIN_SIZE))
        .unwrap_or(height);
    (x, y, resolved_width, resolved_height)
}

fn ref_counts() -> &'static Mutex<HashMap<String, u32>> {
    WEBVIEW_REF_COUNTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn generations() -> &'static Mutex<HashMap<String, u64>> {
    WEBVIEW_GENERATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cancelled_generations() -> &'static Mutex<HashMap<String, u64>> {
    WEBVIEW_CANCELLED_GENERATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn set_generation(label: &str, generation: u64) {
    if generation == 0 {
        return;
    }
    {
        let mut map = generations().lock().unwrap();
        map.insert(label.to_string(), generation);
    }
    let mut cancelled = cancelled_generations().lock().unwrap();
    if cancelled
        .get(label)
        .is_some_and(|cancelled_generation| *cancelled_generation < generation)
    {
        cancelled.remove(label);
    }
}

fn cancel_generation(label: &str, generation: Option<u64>) {
    let Some(generation) = generation else {
        return;
    };
    if generation == 0 {
        return;
    }
    let mut map = cancelled_generations().lock().unwrap();
    let entry = map.entry(label.to_string()).or_insert(0);
    *entry = (*entry).max(generation);
}

fn is_generation_cancelled(label: &str, generation: u64) -> bool {
    if generation == 0 {
        return false;
    }
    let map = cancelled_generations().lock().unwrap();
    map.get(label)
        .is_some_and(|cancelled| *cancelled >= generation)
}

fn is_current_generation(label: &str, generation: Option<u64>) -> bool {
    let Some(generation) = generation else {
        return true;
    };
    if generation == 0 {
        return true;
    }
    let map = generations().lock().unwrap();
    map.get(label).is_some_and(|current| *current == generation)
}

fn clear_generation(label: &str) {
    let mut map = generations().lock().unwrap();
    map.remove(label);
}

fn increment_ref(label: &str) -> u32 {
    let mut map = ref_counts().lock().unwrap();
    let count = map.entry(label.to_string()).or_insert(0);
    *count += 1;
    *count
}

/// Decrements the ref count for a label. Returns the new count (0 means destroy).
fn decrement_ref(label: &str) -> u32 {
    let mut map = ref_counts().lock().unwrap();
    let count = map.entry(label.to_string()).or_insert(0);
    if *count > 0 {
        *count -= 1;
    }
    let new_count = *count;
    if new_count == 0 {
        map.remove(label);
    }
    new_count
}

fn reset_ref(label: &str) {
    let mut map = ref_counts().lock().unwrap();
    map.remove(label);
}

#[cfg(test)]
fn get_ref_count(label: &str) -> u32 {
    let map = ref_counts().lock().unwrap();
    *map.get(label).unwrap_or(&0)
}

/// Create an inline webview embedded within the main window.
///
/// Features:
/// - Positioned within the app UI (x, y, width, height)
/// - Anti-bot detection scripts (realistic browser fingerprint)
/// - Console and network log capture
/// - New window request handling (blocks popups, emits events)
/// - Optional incognito mode and custom user agent
///
/// # Events Emitted
///
/// - `webview-new-window-request`: When the webview tries to open a popup
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn create_inline_webview(
    app: AppHandle,
    parent_window: String,
    label: String,
    url: String,
    x: f64,
    y: f64,
    a: Option<f64>,
    b: Option<f64>,
    width: f64,
    height: f64,
    user_agent: Option<String>,
    incognito: bool,
    generation: Option<u64>,
    visible: bool,
) -> Result<(), String> {
    let (x, y, width, height) = frame_from_corners(x, y, a, b, width, height);
    debug!(
        label = %label,
        x, y, width, height,
        parent_window = %parent_window,
        "browser::inline: creating webview"
    );

    // Get the parent window
    let window = app.get_window(&parent_window).ok_or_else(|| {
        let windows: Vec<_> = app.windows().keys().cloned().collect();
        debug!(windows = ?windows, "browser::inline: parent window not found");
        format!(
            "Parent window '{}' not found. Available: {:?}",
            parent_window, windows
        )
    })?;

    if let Some(generation) = generation {
        set_generation(&label, generation);
    }

    // Increment ref count. Under the single-owner model only My Station calls
    // this, but the count guards against double-create races on fast navigation.
    let ref_count = increment_ref(&label);
    debug!(label = %label, ref_count, "browser::inline: ref count incremented");

    // When a webview with this label already exists, reuse it. Respect the
    // caller's initial visibility so inactive restored tabs stay offscreen
    // instead of covering an active empty tab.
    if let Some(existing) = app.get_webview(&label) {
        let should_show = visible;
        debug!(
            label = %label,
            ref_count,
            visible = should_show,
            "browser::inline: reusing existing webview"
        );
        let (target_x, target_y, target_width, target_height) = if should_show {
            (x, y, width, height)
        } else {
            (
                OFFSCREEN_POSITION,
                OFFSCREEN_POSITION,
                OFFSCREEN_MIN_SIZE,
                OFFSCREEN_MIN_SIZE,
            )
        };
        let pos = tauri::Position::Logical(tauri::LogicalPosition::new(target_x, target_y));
        let size = tauri::Size::Logical(tauri::LogicalSize::new(target_width, target_height));
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            existing.set_position(pos)?;
            existing.set_size(size)?;
            if should_show {
                existing.show()?;
            }
            Ok::<(), tauri::Error>(())
        }));
        return match result {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) => Err(format!("Failed to reuse webview: {}", e)),
            Err(_) => Ok(()),
        };
    }

    let label_for_closure = label.clone();
    let app_for_closure = app.clone();

    // Build the webview with anti-bot detection, console/network capture, element inspector,
    // page agent (DOM automation), and new window handling
    let mut builder = WebviewBuilder::new(
        &label,
        WebviewUrl::External(url.parse().map_err(|e| format!("Invalid URL: {}", e))?),
    )
    .initialization_script(ANTI_BOT_DETECTION_SCRIPT)
    .initialization_script(CONSOLE_CAPTURE_SCRIPT)
    .initialization_script(NETWORK_CAPTURE_SCRIPT)
    .initialization_script(ELEMENT_INSPECTOR_SCRIPT)
    .initialization_script(PAGE_AGENT_SCRIPT)
    .initialization_script(SHORTCUT_FORWARDING_SCRIPT)
    .on_new_window(move |new_window_url, _cookies| {
        let url_str = new_window_url.to_string();
        debug!(url = %url_str, "browser::inline: new window requested");

        if new_window_url.scheme() == "orgii-shortcut" {
            if let Some(shortcut) = new_window_url.host_str() {
                let _ = app_for_closure.emit(
                    "inline-webview-shortcut",
                    serde_json::json!({
                        "shortcut": shortcut,
                        "keys": ""
                    }),
                );
            }
            return tauri::webview::NewWindowResponse::Deny;
        }

        let _ = app_for_closure.emit(
            "webview-new-window-request",
            serde_json::json!({
                "url": url_str,
                "webviewLabel": label_for_closure
            }),
        );

        tauri::webview::NewWindowResponse::Deny
    });

    // Set user agent if provided
    if let Some(ua) = user_agent {
        builder = builder.user_agent(&ua);
    }

    // Set incognito mode
    if incognito {
        builder = builder.incognito(true);
    }

    // Create offscreen but keep the real viewport size. Tauri/wry creates child
    // webviews visible by default, and calling hide() during the creation window
    // can poison wry's internal runtime mutex. Offscreen creation avoids a
    // visible white pane, while the real size lets sites such as Bing initialize
    // responsive layout/scripts correctly instead of seeing a 1x1 viewport.
    let position = tauri::Position::Logical(tauri::LogicalPosition::new(
        OFFSCREEN_POSITION,
        OFFSCREEN_POSITION,
    ));
    let size = tauri::Size::Logical(tauri::LogicalSize::new(
        width.max(OFFSCREEN_MIN_SIZE),
        height.max(OFFSCREEN_MIN_SIZE),
    ));

    let ownership_observation = perf_utils::begin_webview_ownership_observation(label.clone());
    let webview = window.add_child(builder, position, size).map_err(|e| {
        // Roll back the ref increment — this caller never successfully opened the webview.
        decrement_ref(&label);
        format!("Failed to create webview: {}", e)
    })?;

    if let Some(generation) = generation {
        if is_generation_cancelled(&label, generation)
            || !is_current_generation(&label, Some(generation))
        {
            debug!(
                label = %label,
                generation,
                "browser::inline: create finished after cancel; closing offscreen webview"
            );
            decrement_ref(&label);
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| webview.close()));
            return Ok(());
        }
    }

    ownership_observation.commit();

    debug!(
        label = %webview.label(),
        "browser::inline: successfully created webview (offscreen until frontend shows it)"
    );

    Ok(())
}

/// Update the position and size of an inline webview.
///
/// Uses catch_unwind to handle wry panics when webview is in invalid state.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn update_inline_webview_position(
    app: AppHandle,
    label: String,
    x: f64,
    y: f64,
    a: Option<f64>,
    b: Option<f64>,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let (x, y, width, height) = frame_from_corners(x, y, a, b, width, height);
    if let Some(webview) = app.get_webview(&label) {
        let pos = tauri::Position::Logical(tauri::LogicalPosition::new(x, y));
        let size = tauri::Size::Logical(tauri::LogicalSize::new(width, height));

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            webview.set_position(pos)?;
            webview.set_size(size)?;
            Ok::<(), tauri::Error>(())
        }));

        match result {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) => Err(format!("Failed to update position: {}", e)),
            Err(_) => {
                // Silently ignore - position updates are frequent and webview might be closing
                Ok(())
            }
        }
    } else {
        // Webview not yet created or already destroyed — not an error.
        // This is expected during the creation race (CT becomes active before
        // My Station's BrowserSessionWebview finishes create_inline_webview).
        Ok(())
    }
}

/// Show or hide an inline webview.
///
/// Uses catch_unwind to handle wry panics when webview is in invalid state.
#[tauri::command]
pub fn set_inline_webview_visibility(
    app: AppHandle,
    label: String,
    visible: bool,
) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        // Use catch_unwind to handle wry panics when webview is in invalid state
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            if visible {
                webview.show()
            } else {
                webview.hide()
            }
        }));

        match result {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) => Err(format!("Failed to set visibility: {}", e)),
            Err(_) => {
                // Caught panic from wry - webview is likely in invalid state
                warn!(
                    label = %label,
                    "browser::inline: visibility change panicked; webview may be invalid"
                );
                Ok(())
            }
        }
    } else {
        // Not an error — webview not yet created or already destroyed.
        Ok(())
    }
}

/// Atomically reposition a webview and make it visible in a single command.
///
/// Combines `update_inline_webview_position` + `set_inline_webview_visibility`
/// so the two operations are guaranteed to be applied in order on the same
/// thread, preventing a race where the webview flashes at an old position
/// before the separate reposition call arrives.
///
/// If the webview does not exist yet (still being created), returns `Ok(())`
/// silently — the caller should retry when `isWebviewCreated` becomes true.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn reposition_and_show_webview(
    app: AppHandle,
    label: String,
    x: f64,
    y: f64,
    a: Option<f64>,
    b: Option<f64>,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let (x, y, width, height) = frame_from_corners(x, y, a, b, width, height);
    if let Some(webview) = app.get_webview(&label) {
        let pos = tauri::Position::Logical(tauri::LogicalPosition::new(x, y));
        let size = tauri::Size::Logical(tauri::LogicalSize::new(width, height));

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            webview.set_position(pos)?;
            webview.set_size(size)?;
            webview.show()?;
            Ok::<(), tauri::Error>(())
        }));

        match result {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) => Err(format!("Failed to reposition_and_show: {}", e)),
            Err(_) => Ok(()), // wry panic — webview closing, ignore
        }
    } else {
        Ok(()) // not yet created or already destroyed
    }
}

/// Close/destroy an inline webview.
///
/// Uses a ref-count registry so that shared webviews (same label used by both
/// My Station and Agent Station) are only destroyed when every React instance
/// that opened them has also closed them. A single panel unmounting will
/// decrement the count but not destroy the webview if another panel is still
/// using it.
///
/// Uses catch_unwind to handle wry panics when webview is in invalid state.
#[tauri::command]
pub fn close_inline_webview(
    app: AppHandle,
    label: String,
    generation: Option<u64>,
) -> Result<(), String> {
    cancel_generation(&label, generation);
    let remaining = decrement_ref(&label);
    debug!(
        label = %label,
        remaining,
        "browser::inline: close_inline_webview"
    );

    if remaining > 0 {
        debug!(
            label = %label,
            remaining,
            "browser::inline: skipping destroy; refs still active"
        );
        return Ok(());
    }

    if let Some(webview) = app.get_webview(&label) {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| webview.close()));

        clear_generation(&label);
        match result {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) => Err(format!("Failed to close: {}", e)),
            Err(_) => {
                warn!(
                    label = %label,
                    "browser::inline: close panicked; webview may be invalid"
                );
                Ok(())
            }
        }
    } else {
        clear_generation(&label);
        Ok(()) // Webview already gone
    }
}

/// Hide all inline webviews.
///
/// Used by error pages to ensure webviews don't block UI.
/// Native webviews render at the OS level and don't respect CSS z-index,
/// so they must be explicitly hidden to allow overlay UI to be clickable.
///
/// Uses catch_unwind to handle wry panics when webviews are in invalid state.
#[tauri::command]
pub fn hide_all_inline_webviews(app: AppHandle) -> Result<Vec<String>, String> {
    let mut hidden_labels = Vec::new();

    // Get all webviews in the app
    let webviews = app.webviews();

    for (label, webview) in webviews.iter() {
        // Skip the main webview (it's the app itself)
        if label == "main" {
            continue;
        }

        // Clone webview for catch_unwind (needs 'static lifetime)
        let webview_clone = webview.clone();
        let result =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| webview_clone.hide()));

        match result {
            Ok(Ok(())) => {
                debug!(label = %label, "browser::inline: hidden webview");
                hidden_labels.push(label.clone());
            }
            Ok(Err(e)) => {
                warn!(label = %label, error = %e, "browser::inline: failed to hide webview");
            }
            Err(_) => {
                warn!(label = %label, "browser::inline: hide panicked; skipping");
            }
        }
    }

    Ok(hidden_labels)
}

/// Close all inline webviews (browser panels, tabs, etc).
///
/// Used during hot reload to destroy all webviews before React re-mounts.
/// Native webviews don't automatically clean up when React components unmount
/// during HMR, causing orphaned webviews that overlap the reloaded UI.
///
/// Bypasses the ref-count registry and resets all counts, because HMR tears
/// down every React instance simultaneously so no caller will follow up with
/// individual close calls.
///
/// Excludes app windows (shell-*, app-window-*, window-*) which should persist
/// across HMR to avoid closing user's open windows.
///
/// Uses catch_unwind to handle wry panics when webviews are in invalid state.
#[tauri::command]
pub fn close_all_inline_webviews(app: AppHandle) -> Result<Vec<String>, String> {
    let mut closed_labels = Vec::new();

    // Get all webviews in the app
    let webviews = app.webviews();

    for (label, webview) in webviews.iter() {
        // Skip the main webview (it's the app itself)
        if label == "main" {
            continue;
        }

        // Skip app windows - these should persist across HMR
        // shell-* : preloaded shells for new windows
        // app-window-* : dynamically created app windows
        // window-* : shell keys used by windowManager
        if label.starts_with("shell-")
            || label.starts_with("app-window-")
            || label.starts_with("window-")
        {
            continue;
        }

        // Reset lifecycle state so the next create starts fresh.
        reset_ref(label);
        clear_generation(label);

        // Clone webview for catch_unwind (needs 'static lifetime)
        let webview_clone = webview.clone();
        let result =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| webview_clone.close()));

        match result {
            Ok(Ok(())) => {
                debug!(label = %label, "browser::inline: closed webview");
                closed_labels.push(label.clone());
            }
            Ok(Err(e)) => {
                warn!(label = %label, error = %e, "browser::inline: failed to close webview");
            }
            Err(_) => {
                warn!(label = %label, "browser::inline: close panicked; skipping");
            }
        }
    }

    Ok(closed_labels)
}

/// Navigate an inline webview to a new URL.
///
/// Uses catch_unwind to handle wry panics when webview is in invalid state.
#[tauri::command]
pub fn navigate_inline_webview(app: AppHandle, label: String, url: String) -> Result<(), String> {
    let parsed_url: url::Url = url.parse().map_err(|e| format!("Invalid URL: {}", e))?;

    if let Some(webview) = app.get_webview(&label) {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            webview.navigate(parsed_url)
        }));

        match result {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) => Err(format!("Failed to navigate: {}", e)),
            Err(_) => {
                warn!(
                    label = %label,
                    "browser::inline: navigate panicked; webview may be invalid"
                );
                Err("Navigation failed - webview in invalid state".to_string())
            }
        }
    } else {
        Err(format!("Webview '{}' not found", label))
    }
}

/// Reload an inline webview without destroying or repositioning it.
///
/// Uses catch_unwind to handle wry panics when webview is in invalid state.
#[tauri::command]
pub fn reload_inline_webview(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| webview.reload()));

        match result {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) => Err(format!("Failed to reload: {}", e)),
            Err(_) => {
                warn!(
                    label = %label,
                    "browser::inline: reload panicked; webview may be invalid"
                );
                Err("Reload failed - webview in invalid state".to_string())
            }
        }
    } else {
        Err(format!("Webview '{}' not found", label))
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests — ref-count registry logic only (no Tauri AppHandle needed)
// ─────────────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;

    // Each test uses a unique label to avoid cross-test pollution in the global
    // WEBVIEW_REF_COUNTS map.  Tests run in the same process and the OnceLock
    // is shared; unique labels give isolation without locking the whole suite.
    fn ulabel(suffix: &str) -> String {
        use std::sync::atomic::{AtomicU64, Ordering};
        static CTR: AtomicU64 = AtomicU64::new(0);
        format!("test-{}-{}", suffix, CTR.fetch_add(1, Ordering::Relaxed))
    }

    #[test]
    fn increment_starts_at_one() {
        let label = ulabel("inc-start");
        assert_eq!(increment_ref(&label), 1);
        reset_ref(&label);
    }

    #[test]
    fn increment_accumulates() {
        let label = ulabel("inc-acc");
        increment_ref(&label);
        increment_ref(&label);
        let count = increment_ref(&label);
        assert_eq!(count, 3);
        reset_ref(&label);
    }

    #[test]
    fn decrement_returns_remaining_count() {
        let label = ulabel("dec-remaining");
        increment_ref(&label);
        increment_ref(&label);
        let remaining = decrement_ref(&label);
        assert_eq!(remaining, 1);
        reset_ref(&label);
    }

    #[test]
    fn decrement_to_zero_removes_entry() {
        let label = ulabel("dec-zero");
        increment_ref(&label);
        let remaining = decrement_ref(&label);
        assert_eq!(remaining, 0);
        assert_eq!(get_ref_count(&label), 0);
    }

    #[test]
    fn decrement_below_zero_stays_at_zero() {
        let label = ulabel("dec-underflow");
        let result = decrement_ref(&label);
        assert_eq!(result, 0);
    }

    #[test]
    fn reset_clears_any_count() {
        let label = ulabel("reset");
        increment_ref(&label);
        increment_ref(&label);
        increment_ref(&label);
        reset_ref(&label);
        assert_eq!(get_ref_count(&label), 0);
    }

    // Panel-switch scenario: My Station + Control Tower both call create → ref=2.
    // One panel unmounts → ref=1 (webview must NOT be destroyed).
    // Second panel closes → ref=0 (now safe to destroy).
    #[test]
    fn shared_webview_survives_first_close_destroyed_on_second() {
        let label = ulabel("shared");
        increment_ref(&label);
        increment_ref(&label);
        assert_eq!(get_ref_count(&label), 2);

        let after_first = decrement_ref(&label);
        assert_eq!(after_first, 1, "webview must survive the first close");

        let after_second = decrement_ref(&label);
        assert_eq!(
            after_second, 0,
            "webview must be destroyable after second close"
        );
        assert_eq!(get_ref_count(&label), 0);
    }

    // "Close tab before page loads" regression: create succeeded (ref +1) but
    // the React instance unmounted before isWebviewCreated became true.
    // The fix issues an immediate close (ref -1) → count returns to 0.
    #[test]
    fn early_close_after_in_flight_create_reaches_zero() {
        let label = ulabel("early-close");
        increment_ref(&label);
        assert_eq!(get_ref_count(&label), 1);

        let remaining = decrement_ref(&label);
        assert_eq!(remaining, 0);
        assert_eq!(get_ref_count(&label), 0);
    }

    // Navigate error-recovery: instance releases slot (decrement) before
    // closing and re-creating. Subsequent create re-increments → still 1 holder.
    #[test]
    fn navigate_recovery_cycle_keeps_count_at_one() {
        let label = ulabel("nav-recovery");
        increment_ref(&label);
        assert_eq!(get_ref_count(&label), 1);

        decrement_ref(&label);
        assert_eq!(get_ref_count(&label), 0);

        increment_ref(&label);
        assert_eq!(get_ref_count(&label), 1);

        reset_ref(&label);
    }
}

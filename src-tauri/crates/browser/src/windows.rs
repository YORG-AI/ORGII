//! Browser Window Management
//!
//! Standalone browser windows for viewing external websites.
//! Each window is independent with its own navigation history.

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

#[cfg(target_os = "macos")]
use tauri::{LogicalPosition, Position, TitleBarStyle};

#[cfg(target_os = "macos")]
use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};

#[cfg(target_os = "macos")]
use app_window::{set_traffic_light_position, TRAFFIC_LIGHT_X, TRAFFIC_LIGHT_Y};

use super::scripts::SPA_NAVIGATION_SCRIPT;

/// Create a standalone browser window.
///
/// Features:
/// - Independent window with decorations
/// - SPA navigation detection (emits `browser-navigation` events)
/// - macOS vibrancy effect
///
/// If a window with the same ID already exists, it will be focused
/// and navigated to the new URL instead of creating a new window.
#[tauri::command]
pub async fn open_browser_window(
    app: AppHandle,
    url: String,
    window_id: Option<String>,
) -> Result<String, String> {
    let id = window_id.unwrap_or_else(|| format!("browser-{}", uuid::Uuid::new_v4()));
    let id_for_closure = id.clone();
    let app_for_closure = app.clone();

    // Extract hostname for title
    let title = if let Ok(parsed) = url.parse::<url::Url>() {
        format!("{} - Orgii Browser", parsed.host_str().unwrap_or("Browser"))
    } else {
        "Orgii Browser".to_string()
    };

    // Check if window already exists
    if let Some(existing) = app.get_webview_window(&id) {
        existing
            .navigate(url.parse().map_err(|e| format!("Invalid URL: {}", e))?)
            .map_err(|e| format!("Failed to navigate: {}", e))?;
        let _ = existing.set_title(&title);
        existing
            .show()
            .map_err(|e| format!("Failed to show window: {}", e))?;
        existing
            .set_focus()
            .map_err(|e| format!("Failed to focus window: {}", e))?;
        return Ok(id);
    }

    // Base builder shared across all platforms
    let builder = WebviewWindowBuilder::new(
        &app,
        &id,
        WebviewUrl::External(url.parse().map_err(|e| format!("Invalid URL: {}", e))?),
    )
    .title(&title)
    .inner_size(1200.0, 800.0)
    .min_inner_size(400.0, 300.0)
    .resizable(true)
    .visible(true)
    .decorations(true)
    .initialization_script(SPA_NAVIGATION_SCRIPT)
    .on_navigation(move |navigation_url: &url::Url| {
        let url_str = navigation_url.to_string();
        println!("[Browser] Navigation detected: {}", url_str);

        let _ = app_for_closure.emit(
            "browser-navigation",
            serde_json::json!({
                "windowId": id_for_closure,
                "url": url_str,
                "navType": "navigation"
            }),
        );

        true
    });

    // macOS-only: overlay title bar + traffic light position
    #[cfg(target_os = "macos")]
    let builder = builder
        .hidden_title(true)
        .title_bar_style(TitleBarStyle::Overlay)
        .traffic_light_position(Position::Logical(LogicalPosition::new(
            TRAFFIC_LIGHT_X,
            TRAFFIC_LIGHT_Y,
        )));

    let ownership_observation = perf_utils::begin_webview_ownership_observation(id.clone());
    let window = builder
        .build()
        .map_err(|e| format!("Failed to create browser window: {}", e))?;
    ownership_observation.commit();

    #[cfg(target_os = "macos")]
    {
        let _ = apply_vibrancy(&window, NSVisualEffectMaterial::HudWindow, None, Some(26.0));
        // Manually set traffic light position (Tauri's builder method doesn't always work)
        set_traffic_light_position(&window, TRAFFIC_LIGHT_X, TRAFFIC_LIGHT_Y);
    }

    app_window::apply_host_desktop_decorated_window_corners(&window);

    #[cfg(all(not(target_os = "macos"), not(windows)))]
    let _ = window;

    Ok(id)
}

/// Close a browser window by ID.
#[tauri::command]
pub fn close_browser_window(app: AppHandle, window_id: String) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&window_id) {
        window
            .close()
            .map_err(|e| format!("Failed to close window: {}", e))?;
    }
    Ok(())
}

/// Navigate an existing browser window to a new URL.
#[tauri::command]
pub fn navigate_browser_window(
    app: AppHandle,
    window_id: String,
    url: String,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&window_id) {
        window
            .navigate(url.parse().map_err(|e| format!("Invalid URL: {}", e))?)
            .map_err(|e| format!("Failed to navigate: {}", e))?;
    } else {
        return Err(format!("Window {} not found", window_id));
    }
    Ok(())
}

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

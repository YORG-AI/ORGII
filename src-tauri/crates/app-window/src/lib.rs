//! Native window helpers for Tauri windows.
//!
//! Centralised so `app`, `browser`, and other leaf crates can apply
//! consistent native chrome (macOS traffic-light positioning + liquid glass,
//! Windows DWM rounded corners) and recreate the main window
//! from the Tauri menu without each consumer reimplementing the platform
//! glue. All operations are synchronous against a `tauri::AppHandle` /
//! `WebviewWindow` — no async runtime, no IoC hooks.

use serde::Deserialize;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

#[cfg(target_os = "macos")]
use tauri::{LogicalPosition, Position, TitleBarStyle};

#[cfg(target_os = "macos")]
use objc2::msg_send;
#[cfg(target_os = "macos")]
use objc2::runtime::{AnyClass, AnyObject};
#[cfg(target_os = "macos")]
use objc2_app_kit::NSWindowButton;
#[cfg(target_os = "macos")]
use tauri_plugin_liquid_glass::{GlassMaterialVariant, LiquidGlassConfig, LiquidGlassExt};

#[cfg(windows)]
mod windows_corner;

// ============================================
// macOS window background color
// ============================================

/// Set the NSWindow `backgroundColor` and enable WKWebView background
/// drawing so the window shows a solid colour before the webview CSS
/// paints its first frame. Without this, `transparent: true` windows
/// flash fully transparent at startup.
#[cfg(target_os = "macos")]
pub fn apply_window_background_color(window: &tauri::WebviewWindow) {
    let ns_window_ptr = match window.ns_window() {
        Ok(ptr) => ptr,
        Err(_) => return,
    };
    let ns_window_addr = ns_window_ptr as usize;

    let run = move || {
        use objc2::msg_send;
        use objc2::runtime::{AnyClass, AnyObject};

        let ns_win = ns_window_addr as *mut AnyObject;

        unsafe {
            let ns_color_class = AnyClass::get(c"NSColor").expect("NSColor");
            let bg: *mut AnyObject = msg_send![
                ns_color_class,
                colorWithSRGBRed: (0x0d as f64 / 255.0),
                green: (0x0d as f64 / 255.0),
                blue: (0x0d as f64 / 255.0),
                alpha: 1.0_f64,
            ];
            let _: () = msg_send![ns_win, setBackgroundColor: bg];

            let content_view: *mut AnyObject = msg_send![ns_win, contentView];
            if !content_view.is_null() {
                set_draws_background_recursive(content_view, true);
            }
        }
    };

    if is_main_thread() {
        run();
    } else {
        dispatch2::DispatchQueue::main().exec_sync(run);
    }
}

/// Remove the startup background: clear the NSWindow backgroundColor,
/// disable WKWebView background drawing. Called from the frontend once
/// the React app finishes loading and CSS backgrounds are painted.
#[cfg(target_os = "macos")]
pub fn remove_window_background_color(window: &tauri::WebviewWindow) {
    let ns_window_ptr = match window.ns_window() {
        Ok(ptr) => ptr,
        Err(_) => return,
    };
    let ns_window_addr = ns_window_ptr as usize;

    let run = move || {
        use objc2::msg_send;
        use objc2::runtime::{AnyClass, AnyObject};

        let ns_win = ns_window_addr as *mut AnyObject;

        unsafe {
            let ns_color_class = AnyClass::get(c"NSColor").expect("NSColor");
            let clear: *mut AnyObject = msg_send![ns_color_class, clearColor];
            let _: () = msg_send![ns_win, setBackgroundColor: clear];

            let content_view: *mut AnyObject = msg_send![ns_win, contentView];
            if !content_view.is_null() {
                set_draws_background_recursive(content_view, false);
            }
        }
    };

    if is_main_thread() {
        run();
    } else {
        dispatch2::DispatchQueue::main().exec_sync(run);
    }
}

/// Recursively search for WKWebView subviews and set _drawsBackground.
#[cfg(target_os = "macos")]
unsafe fn set_draws_background_recursive(view: *mut AnyObject, draws: bool) {
    use objc2::runtime::Bool;

    let class_name: *mut AnyObject = msg_send![view, className];
    let class_str: *const std::os::raw::c_char = msg_send![class_name, UTF8String];
    if !class_str.is_null() {
        let name = std::ffi::CStr::from_ptr(class_str).to_string_lossy();
        if name.contains("WKWebView") {
            let val: Bool = Bool::new(draws);
            let _: () = msg_send![view, _setDrawsBackground: val];
            return;
        }
    }

    let subviews: *mut AnyObject = msg_send![view, subviews];
    let count: usize = msg_send![subviews, count];
    for idx in 0..count {
        let subview: *mut AnyObject = msg_send![subviews, objectAtIndex: idx];
        set_draws_background_recursive(subview, draws);
    }
}

// ============================================
// Configuration Constants
// ============================================

/// Default traffic light position for native macOS window chrome.
pub const TRAFFIC_LIGHT_X: f64 = 20.0;
pub const TRAFFIC_LIGHT_Y: f64 = 28.0;

// ============================================
// macOS Traffic Light Positioning
// ============================================

/// Set the traffic light button positions on a macOS window.
///
/// This replicates tao's `inset_traffic_lights` function to position the buttons.
/// Must be called AFTER window creation because Tauri's `traffic_light_position`
/// doesn't reliably work for dynamically created windows.
///
/// The x/y coordinates are measured from the top-left of the window content area,
/// matching Tauri's trafficLightPosition config format.
#[cfg(target_os = "macos")]
pub fn set_traffic_light_position(window: &tauri::WebviewWindow, x: f64, y: f64) {
    let ns_window_ptr = match window.ns_window() {
        Ok(ptr) => ptr,
        Err(_) => return,
    };

    let ns_window_addr = ns_window_ptr as usize;
    let run = move || {
        let ns_window = ns_window_addr as *mut AnyObject;

        unsafe {
            use objc2_foundation::NSRect;

            let close: *mut AnyObject =
                msg_send![ns_window, standardWindowButton: NSWindowButton::CloseButton];
            let miniaturize: *mut AnyObject =
                msg_send![ns_window, standardWindowButton: NSWindowButton::MiniaturizeButton];
            let zoom: *mut AnyObject =
                msg_send![ns_window, standardWindowButton: NSWindowButton::ZoomButton];

            if close.is_null() || miniaturize.is_null() || zoom.is_null() {
                return;
            }

            let close_superview: *mut AnyObject = msg_send![close, superview];
            if close_superview.is_null() {
                return;
            }
            let title_bar_container_view: *mut AnyObject = msg_send![close_superview, superview];
            if title_bar_container_view.is_null() {
                return;
            }

            let window_frame: NSRect = msg_send![ns_window, frame];
            let close_rect: NSRect = msg_send![close, frame];
            let title_bar_frame_height = close_rect.size.height + y;

            let mut title_bar_rect: NSRect = msg_send![title_bar_container_view, frame];
            title_bar_rect.size.height = title_bar_frame_height;
            title_bar_rect.origin.y = window_frame.size.height - title_bar_frame_height;
            let _: () = msg_send![title_bar_container_view, setFrame: title_bar_rect];

            let miniaturize_rect: NSRect = msg_send![miniaturize, frame];
            let space_between = miniaturize_rect.origin.x - close_rect.origin.x;

            let buttons = [close, miniaturize, zoom];
            for (i, button) in buttons.iter().enumerate() {
                let mut rect: NSRect = msg_send![*button, frame];
                rect.origin.x = x + (i as f64 * space_between);
                let _: () = msg_send![*button, setFrameOrigin: rect.origin];
            }
        }
    };

    if is_main_thread() {
        run();
    } else {
        dispatch2::DispatchQueue::main().exec_sync(run);
    }
}

#[cfg(target_os = "macos")]
fn is_main_thread() -> bool {
    unsafe {
        let Some(cls) = AnyClass::get(c"NSThread") else {
            return false;
        };
        let is_main: bool = msg_send![cls, isMainThread];
        is_main
    }
}

/// Default window sizes
const DEFAULT_WIDTH: f64 = 1200.0;
const DEFAULT_HEIGHT: f64 = 800.0;
const DEFAULT_MIN_WIDTH: f64 = 450.0;
const DEFAULT_MIN_HEIGHT: f64 = 300.0;

/// Host-native window chrome so the OS frame matches frontend corner radii.
///
/// - **Windows 11+:** `DWMWCP_ROUNDSMALL` via DWM (pairs with `--radius-page` in the web layer).
/// - **macOS:** Applied separately through [`apply_macos_window_material`].
/// - **Linux / others:** No-op.
pub fn apply_host_desktop_window_chrome(
    #[cfg_attr(not(windows), allow(unused_variables))] window: &tauri::WebviewWindow,
) {
    #[cfg(windows)]
    windows_corner::apply_dwm_rounded_corner_preference(window);
}

/// Apply the native macOS AbuttedSidebar material underneath the transparent webview.
/// macOS 26+ uses NSGlassEffectView; older releases fall back to
/// NSVisualEffectView. AppKit owns the outer window clipping; a subtle native
/// tint keeps the sidebar legible without covering the desktop color.
#[cfg(target_os = "macos")]
pub fn apply_macos_window_material(window: &tauri::WebviewWindow) {
    let config = LiquidGlassConfig {
        corner_radius: 0.0,
        tint_color: Some("#ffffff18".into()),
        variant: GlassMaterialVariant::AbuttedSidebar,
        ..Default::default()
    };
    if let Err(error) = window.liquid_glass().set_effect(window, config) {
        tracing::warn!(%error, "Failed to apply macOS liquid-glass material");
    }
}

/// Remove the native macOS material on AppKit's main thread.
#[cfg(target_os = "macos")]
pub fn clear_macos_window_material(window: &tauri::WebviewWindow) {
    let config = LiquidGlassConfig {
        enabled: false,
        ..Default::default()
    };
    if let Err(error) = window.liquid_glass().set_effect(window, config) {
        tracing::warn!(%error, "Failed to clear macOS liquid-glass material");
    }
}

// ============================================
// Types
// ============================================

/// Options for creating a new app window
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWindowOptions {
    /// Window label (unique identifier)
    pub label: String,
    /// URL to load in the window
    pub url: String,
    /// Window title
    #[serde(default)]
    pub title: Option<String>,
    /// Window width
    #[serde(default)]
    pub width: Option<f64>,
    /// Window height
    #[serde(default)]
    pub height: Option<f64>,
    /// Minimum window width
    #[serde(default)]
    pub min_width: Option<f64>,
    /// Minimum window height
    #[serde(default)]
    pub min_height: Option<f64>,
    /// Whether to center the window
    #[serde(default = "app_utils::default_true")]
    pub center: bool,
    /// Whether to focus the window
    #[serde(default = "app_utils::default_true")]
    pub focus: bool,
    /// Whether the window is resizable
    #[serde(default = "app_utils::default_true")]
    pub resizable: bool,
    /// X position (if not centering)
    #[serde(default)]
    pub x: Option<f64>,
    /// Y position (if not centering)
    #[serde(default)]
    pub y: Option<f64>,
}

// ============================================
// Core Window Creation
// ============================================

/// Create a new app window with consistent native styling.
///
/// - **macOS:** Hidden title, overlay title bar, traffic lights, and native vibrancy.
/// - **Windows 11+:** DWM small rounded corners (see [`apply_host_desktop_window_chrome`]).
/// - **All platforms:** Decorated, transparent client area where supported.
pub fn create_window(app: &AppHandle, options: CreateWindowOptions) -> Result<(), String> {
    let width = options.width.unwrap_or(DEFAULT_WIDTH);
    let height = options.height.unwrap_or(DEFAULT_HEIGHT);
    let min_width = options.min_width.unwrap_or(DEFAULT_MIN_WIDTH);
    let min_height = options.min_height.unwrap_or(DEFAULT_MIN_HEIGHT);
    let title = options.title.as_deref().unwrap_or(&options.label);

    // Check if window already exists
    if let Some(existing) = app.get_webview_window(&options.label) {
        // Focus existing window
        existing
            .set_focus()
            .map_err(|e| format!("Failed to focus window: {}", e))?;
        return Ok(());
    }

    // Parse URL
    let parsed_url: url::Url = options
        .url
        .parse()
        .map_err(|e| format!("Invalid URL '{}': {}", options.url, e))?;

    // Build window with consistent native styling
    let mut builder =
        WebviewWindowBuilder::new(app, &options.label, WebviewUrl::External(parsed_url))
            .title(title)
            .inner_size(width, height)
            .min_inner_size(min_width, min_height)
            .resizable(options.resizable)
            .visible(true)
            .decorations(true);

    // macOS-specific styling
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .transparent(true)
            .hidden_title(true)
            .title_bar_style(TitleBarStyle::Overlay)
            .traffic_light_position(Position::Logical(LogicalPosition::new(
                TRAFFIC_LIGHT_X,
                TRAFFIC_LIGHT_Y,
            )));
    }

    // Handle positioning
    if let (Some(x), Some(y)) = (options.x, options.y) {
        builder = builder.position(x, y);
    } else if options.center {
        builder = builder.center();
    }

    // Build the window
    let window = builder
        .build()
        .map_err(|e| format!("Failed to create window: {}", e))?;

    // Manually set traffic light position (Tauri's builder method doesn't always work)
    #[cfg(target_os = "macos")]
    {
        set_traffic_light_position(&window, TRAFFIC_LIGHT_X, TRAFFIC_LIGHT_Y);
        apply_macos_window_material(&window);
    }

    apply_host_desktop_window_chrome(&window);

    // Focus if requested
    if options.focus {
        let _ = window.set_focus();
    }

    #[cfg(all(not(target_os = "macos"), not(windows)))]
    let _ = window;

    Ok(())
}

// ============================================
// New App Window (for File > New Window)
// ============================================

/// Recreate the main window with label "main" and default app URL.
///
/// Used when the main window was somehow destroyed and needs to be restored.
/// Unlike `create_new_app_window` (which generates a unique label for File > New Window),
/// this always uses the "main" label so all code that references `get_webview_window("main")`
/// continues to work (tray events, menu events, handle_opened_urls, etc.).
pub fn recreate_main_window(app: &AppHandle) -> Result<(), String> {
    // Safety: if "main" already exists, just focus it
    if let Some(existing) = app.get_webview_window("main") {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    println!("📦 [Window] Recreating main window");

    let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
        .title("ORGII")
        .inner_size(DEFAULT_WIDTH, DEFAULT_HEIGHT)
        .min_inner_size(DEFAULT_MIN_WIDTH, DEFAULT_MIN_HEIGHT)
        .resizable(true)
        .visible(true)
        .decorations(true)
        .center();

    #[cfg(target_os = "macos")]
    let builder = builder
        .transparent(true)
        .hidden_title(true)
        .title_bar_style(TitleBarStyle::Overlay)
        .traffic_light_position(Position::Logical(LogicalPosition::new(
            TRAFFIC_LIGHT_X,
            TRAFFIC_LIGHT_Y,
        )));

    let window = builder
        .build()
        .map_err(|e| format!("Failed to recreate main window: {}", e))?;

    #[cfg(target_os = "macos")]
    {
        set_traffic_light_position(&window, TRAFFIC_LIGHT_X, TRAFFIC_LIGHT_Y);
        apply_window_background_color(&window);
        apply_macos_window_material(&window);
    }

    apply_host_desktop_window_chrome(&window);

    let _ = window.set_focus();

    println!("✅ [Window] Main window recreated");
    Ok(())
}

/// Create a new app window that loads the frontend application.
///
/// Used by File > New Window menu action. Generates a unique label
/// and loads the default app URL (devUrl in dev, bundled frontend in production).
pub fn create_new_app_window(app: &AppHandle) -> Result<(), String> {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let label = format!("app-{}", timestamp);

    println!("📦 [Window] Creating new app window: {}", label);

    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::default())
        .title("ORGII")
        .inner_size(DEFAULT_WIDTH, DEFAULT_HEIGHT)
        .min_inner_size(DEFAULT_MIN_WIDTH, DEFAULT_MIN_HEIGHT)
        .resizable(true)
        .visible(true)
        .decorations(true)
        .center();

    #[cfg(target_os = "macos")]
    let builder = builder
        .transparent(true)
        .hidden_title(true)
        .title_bar_style(TitleBarStyle::Overlay)
        .traffic_light_position(Position::Logical(LogicalPosition::new(
            TRAFFIC_LIGHT_X,
            TRAFFIC_LIGHT_Y,
        )));

    let window = builder
        .build()
        .map_err(|e| format!("Failed to create app window: {}", e))?;

    #[cfg(target_os = "macos")]
    {
        set_traffic_light_position(&window, TRAFFIC_LIGHT_X, TRAFFIC_LIGHT_Y);
        apply_macos_window_material(&window);
    }

    apply_host_desktop_window_chrome(&window);

    let _ = window.set_focus();

    println!("✅ [Window] New app window created: {}", label);
    Ok(())
}

// Tauri commands live in `commands.rs` to avoid an `E0255 __cmd__<fn>
// defined multiple times` collision that fires when `#[tauri::command]`
// is applied to functions at the crate root. See `commands.rs` for the
// full explanation. Re-export so `app::commands::handler_list` can keep
// referencing them at `app_window::create_app_window` etc.
pub mod commands;
pub use commands::*;

//! Native window helpers for Tauri windows.
//!
//! Centralised so `app`, `browser`, and other leaf crates can apply
//! consistent native chrome (macOS traffic-light positioning + menu vibrancy,
//! Windows DWM rounded corners) and recreate the main window
//! from the Tauri menu without each consumer reimplementing the platform
//! glue. All operations are synchronous against a `tauri::AppHandle` /
//! `WebviewWindow` — no async runtime, no IoC hooks.

use tauri::{AppHandle, Manager, WebviewWindowBuilder};

#[cfg(target_os = "macos")]
use objc2::msg_send;
#[cfg(target_os = "macos")]
use objc2::runtime::{AnyClass, AnyObject};
#[cfg(target_os = "macos")]
use objc2_app_kit::NSWindowButton;
#[cfg(target_os = "macos")]
mod macos_material;

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

/// Host-native chrome for the frameless, transparent main window.
///
/// - **Windows 11+:** DWM rounded corners + translucent acrylic backdrop.
/// - **Windows 10:** opaque background, no acrylic (drag lag), no DWM shadow
///   (renders as a 1px border artifact on transparent frameless windows).
/// - **macOS:** Applied separately through [`apply_macos_window_material`].
/// - **Linux / others:** No-op.
pub fn apply_host_desktop_window_chrome(
    #[cfg_attr(not(windows), allow(unused_variables))] window: &tauri::WebviewWindow,
) {
    #[cfg(windows)]
    windows_corner::apply_frameless_window_chrome(window);
}

/// Rounded corners only, for decorated secondary windows (e.g. browser).
/// Decorated windows keep their native frame, shadow, and opaque backdrop.
///
/// - **Windows 11+:** `DWMWCP_ROUND` via DWM.
/// - **Windows 10 / macOS / Linux:** No-op.
pub fn apply_host_desktop_decorated_window_corners(
    #[cfg_attr(not(windows), allow(unused_variables))] window: &tauri::WebviewWindow,
) {
    #[cfg(windows)]
    windows_corner::apply_rounded_corners(window);
}

/// Apply native menu vibrancy underneath the transparent webview.
/// Uses the same public AppKit material on all supported macOS versions;
/// AppKit owns outer window clipping, appearance, and accessibility behavior.
#[cfg(target_os = "macos")]
pub fn apply_macos_window_material(window: &tauri::WebviewWindow) {
    if let Err(error) = macos_material::set_enabled(window, true) {
        tracing::warn!(%error, "Failed to apply macOS menu vibrancy");
    }
}

/// Remove the native macOS material on AppKit's main thread.
#[cfg(target_os = "macos")]
pub fn clear_macos_window_material(window: &tauri::WebviewWindow) {
    if let Err(error) = macos_material::set_enabled(window, false) {
        tracing::warn!(%error, "Failed to clear macOS menu vibrancy");
    }
}

// ============================================
// Main Window Recovery
// ============================================

/// Recreate the main window from the platform-merged Tauri configuration.
///
/// Used when the main window was somehow destroyed and needs to be restored.
/// Reusing the startup configuration keeps platform-specific chrome in parity:
/// macOS overlay/transparency and the Windows frameless backdrop must not disappear
/// after a tray or menu recovery.
pub fn recreate_main_window(app: &AppHandle) -> Result<(), String> {
    // Safety: if "main" already exists, just focus it
    if let Some(existing) = app.get_webview_window("main") {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    println!("📦 [Window] Recreating main window");

    let main_config = app
        .config()
        .app
        .windows
        .iter()
        .find(|config| config.label == "main")
        .ok_or("Main window configuration not found")?;
    let builder = WebviewWindowBuilder::from_config(app, main_config)
        .map_err(|error| format!("Failed to load main window configuration: {error}"))?;

    let ownership_observation = perf_utils::begin_webview_ownership_observation("main");
    let window = builder
        .build()
        .map_err(|e| format!("Failed to recreate main window: {}", e))?;
    ownership_observation.commit();

    #[cfg(target_os = "macos")]
    {
        set_traffic_light_position(&window, TRAFFIC_LIGHT_X, TRAFFIC_LIGHT_Y);
        apply_window_background_color(&window);
        apply_macos_window_material(&window);
    }

    apply_host_desktop_window_chrome(&window);

    // The main window starts hidden (visible:false in the platform config)
    // so chrome can be applied before first paint; show it now that the
    // opaque background + shadow policy are in place.
    let _ = window.show();

    let _ = window.set_focus();

    println!("✅ [Window] Main window recreated");
    Ok(())
}

// Tauri commands live in `commands.rs` to avoid an `E0255 __cmd__<fn>
// defined multiple times` collision that fires when `#[tauri::command]`
// is applied to functions at the crate root. See `commands.rs` for the
// full explanation. Re-export the command module for the app handler list.
pub mod commands;
pub use commands::*;

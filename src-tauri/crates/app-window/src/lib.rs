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

pub mod root_tint;
pub mod startup_backdrop;

// ============================================
// macOS window backdrop
// ============================================

/// Clear the native backdrop of a macOS window: the NSWindow
/// `backgroundColor` goes to clear, WKWebView background drawing is turned
/// off, and the webview's under-page colour is pinned to clear so the page
/// composites straight onto whatever sits behind the webview (the vibrancy
/// material mounted by [`apply_macos_window_material`]).
///
/// Every macOS window gets this right after its chrome is mounted and before
/// it is shown — the main window at setup and on recreate, detached session
/// windows in `open_session_window` — so the very first frame is already the
/// surface the window settles on. The frontend invokes it again through the
/// `remove_window_background` command once React has painted; that re-pin is
/// what keeps the setting across a navigation, which re-derives WebKit's
/// default, and it re-asserts the traffic-light inset.
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
            if !content_view.is_null()
                && !set_webview_background_recursive(content_view, false, clear)
            {
                tracing::warn!(
                    "No WKWebView under the window's contentView; the webview keeps whatever \
                     background it had and the window will not be transparent"
                );
            }
        }
    };

    if is_main_thread() {
        run();
    } else {
        dispatch2::DispatchQueue::main().exec_sync(run);
    }
}

/// Recursively search for WKWebView subviews and pin their background.
///
/// Two levers, because `_setDrawsBackground:` alone is not enough:
///
/// - `_setDrawsBackground:` decides WHETHER the webview paints a base layer
///   under the document.
/// - `underPageBackgroundColor` decides WHAT that base layer is. Left unset,
///   WebKit derives it from the document — and before the first document has
///   painted there is nothing to derive from, so it falls back to WHITE. That
///   fallback is visible for the entire load of a freshly created window,
///   underneath a page whose own background is transparent, and it is the
///   white flash this function exists to prevent. Pinning it is also what
///   makes the setting survive a navigation, which re-derives the default.
///
/// `underPageBackgroundColor` is public API from macOS 12; the bundle targets
/// 10.15, so it is probed with `respondsToSelector:` rather than assumed.
///
/// Returns whether a WKWebView was actually found. Callers apply this right
/// after `build()`, where a silent miss looks exactly like a working fix.
#[cfg(target_os = "macos")]
unsafe fn set_webview_background_recursive(
    view: *mut AnyObject,
    draws: bool,
    color: *mut AnyObject,
) -> bool {
    use objc2::runtime::Bool;
    use objc2::sel;

    if view.is_null() {
        return false;
    }

    let class_name: *mut AnyObject = msg_send![view, className];
    let class_str: *const std::os::raw::c_char = msg_send![class_name, UTF8String];
    if !class_str.is_null() {
        let name = std::ffi::CStr::from_ptr(class_str).to_string_lossy();
        if name.contains("WKWebView") {
            let val: Bool = Bool::new(draws);
            let _: () = msg_send![view, _setDrawsBackground: val];

            let responds: Bool =
                msg_send![view, respondsToSelector: sel!(setUnderPageBackgroundColor:)];
            if responds.as_bool() {
                let _: () = msg_send![view, setUnderPageBackgroundColor: color];
            }
            return true;
        }
    }

    let subviews: *mut AnyObject = msg_send![view, subviews];
    let count: usize = msg_send![subviews, count];
    let mut found = false;
    for idx in 0..count {
        let subview: *mut AnyObject = msg_send![subviews, objectAtIndex: idx];
        found |= set_webview_background_recursive(subview, draws, color);
    }
    found
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

/// Show a window once the native work already queued on the main thread has
/// run, so its first frame is at its final size.
///
/// tao applies the config's `maximized: true` through an *asynchronous*
/// main-queue dispatch at creation (`set_maximized_async` → `zoom:`). A
/// synchronous `show()` from the setup hook therefore orders the window in
/// at its configured 1200×800 and the zoom lands a frame later, animated — a
/// visible jump now that the first frame is the frosted material rather than
/// a clear window that hid it. The main dispatch queue is FIFO, so a show
/// enqueued here runs after that zoom. Only for windows built `maximized`;
/// `open_session_window` shows synchronously on purpose.
#[cfg(target_os = "macos")]
pub fn show_after_queued_native_layout(window: &tauri::WebviewWindow) {
    let window = window.clone();
    dispatch2::DispatchQueue::main().exec_async(move || {
        let _ = window.show();
        let _ = window.set_focus();
    });
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

/// Paint the app's root tint natively under the webview (see
/// `macos_material::set_root_tint`). `None` removes it.
#[cfg(target_os = "macos")]
pub fn set_macos_window_root_tint(window: &tauri::WebviewWindow, color: Option<[f64; 4]>) {
    if let Err(error) = macos_material::set_root_tint(window, color) {
        tracing::warn!(%error, "Failed to apply macOS root tint");
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
        // Same order as the setup hook and `open_session_window`: material
        // behind the webview, then the config's opaque backdrop cleared so
        // the webview composites onto the material from its first frame.
        set_traffic_light_position(&window, TRAFFIC_LIGHT_X, TRAFFIC_LIGHT_Y);
        apply_macos_window_material(&window);
        remove_window_background_color(&window);
    }

    apply_host_desktop_window_chrome(&window);

    // The main window starts hidden (visible:false in tauri.conf.json) so
    // chrome can be applied before first paint; show it now that the
    // backdrop + shadow policy are in place — on macOS behind the queued
    // `maximized` zoom, so it never appears at its pre-zoom size.
    #[cfg(target_os = "macos")]
    show_after_queued_native_layout(&window);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window.show();
        let _ = window.set_focus();
    }

    println!("✅ [Window] Main window recreated");
    Ok(())
}

// Tauri commands live in `commands.rs` to avoid an `E0255 __cmd__<fn>
// defined multiple times` collision that fires when `#[tauri::command]`
// is applied to functions at the crate root. See `commands.rs` for the
// full explanation. Re-export the command module for the app handler list.
pub mod commands;
pub use commands::*;

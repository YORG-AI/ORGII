//! Tauri commands for window management.
//!
//! Lives in a submodule (rather than inline in `lib.rs`) because
//! `#[tauri::command]` emits a `#[macro_export] macro_rules! __cmd__<fn>`
//! plus a sibling `pub use __cmd__<fn>;`. When the function lives at the
//! crate root the two paths collapse onto the same name in the macro
//! namespace and rustc reports `E0255 __cmd__<fn> defined multiple
//! times`. Putting them in a child module keeps the `pub use` scoped to
//! `app_window::commands::__cmd__<fn>` while `#[macro_export]` still
//! reaches the crate root for `tauri::generate_handler!` to find. Same
//! pattern key-vault and integrations use.

use tauri::{AppHandle, Manager};

#[cfg(target_os = "macos")]
use objc2::msg_send;
#[cfg(target_os = "macos")]
use objc2::runtime::{AnyClass, AnyObject};

use super::{create_window, CreateWindowOptions};

/// Set the native zoom factor for the main application WebView.
#[tauri::command]
pub async fn set_main_webview_zoom(app: AppHandle, scale_factor: f64) -> Result<(), String> {
    let webview = app.get_webview("main").ok_or("Main WebView not found")?;

    webview
        .set_zoom(scale_factor)
        .map_err(|err| format!("Failed to set main WebView zoom: {}", err))?;

    Ok(())
}

/// Create a new app window from the frontend.
///
/// This is the primary entry point for window creation from JavaScript.
/// All options are passed as a single object for flexibility.
#[tauri::command]
pub async fn create_app_window(app: AppHandle, options: CreateWindowOptions) -> Result<(), String> {
    println!("📦 [Window] Creating window: {}", options.label);
    create_window(&app, options)?;
    println!("✅ [Window] Window created successfully");
    Ok(())
}

/// Show an existing window or create it fresh if it doesn't exist yet.
///
/// Unlike `create_app_window` (which errors when the label already exists),
/// this command implements the prewarm/reuse pattern for any window with a
/// **stable label** (e.g. "mode-selection", "new-project"):
///
/// - **Hot path** — window already exists: `show()` + optional reposition +
///   `set_focus()` (when `options.focus` is true). O(1), no webview spin-up.
/// - **Cold path** — window does not exist: behaves exactly like
///   `create_app_window`. On macOS applies Glass + traffic lights.
#[tauri::command]
pub async fn show_or_create_app_window(
    app: AppHandle,
    options: CreateWindowOptions,
) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(&options.label) {
        if let (Some(x), Some(y)) = (options.x, options.y) {
            let _ =
                existing.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(x, y)));
        } else if options.center {
            let _ = existing.center();
        }
        existing
            .show()
            .map_err(|err| format!("Failed to show window '{}': {}", options.label, err))?;
        if options.focus {
            existing
                .set_focus()
                .map_err(|err| format!("Failed to focus window '{}': {}", options.label, err))?;
        }
        return Ok(());
    }
    create_window(&app, options)?;
    Ok(())
}

/// Close a window by label.
#[tauri::command]
pub async fn close_app_window(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&label) {
        window
            .close()
            .map_err(|e| format!("Failed to close window: {}", e))?;
    }
    Ok(())
}

/// Focus a window by label.
#[tauri::command]
pub async fn focus_app_window(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&label) {
        window
            .set_focus()
            .map_err(|e| format!("Failed to focus window: {}", e))?;
    } else {
        return Err(format!("Window '{}' not found", label));
    }
    Ok(())
}

/// Toggle vibrancy and webview transparency on the main window.
///
/// Used before navigating to external pages (e.g. Stripe Checkout)
/// that don't have full-page opaque backgrounds. Both the vibrancy layer
/// and the WKWebView's drawsBackground must be toggled to prevent
/// the desktop from bleeding through.
///
/// Accepts either a base64-encoded wallpaper image or a solid RGB color
/// to set as the native window background while the external page is shown.
#[tauri::command]
pub async fn set_window_vibrancy(
    app: AppHandle,
    enabled: bool,
    bg_color: Option<[u8; 3]>,
    bg_image_base64: Option<String>,
) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Main window not found")?;

    #[cfg(target_os = "macos")]
    {
        use base64::Engine as _;

        if enabled {
            super::apply_macos_window_material(&window);
        } else {
            super::clear_macos_window_material(&window);
        }

        let image_bytes: Option<Vec<u8>> = bg_image_base64
            .and_then(|b64| base64::engine::general_purpose::STANDARD.decode(b64).ok());

        let ns_window_ptr = window
            .ns_window()
            .map_err(|e| format!("Failed to get NSWindow: {}", e))?;
        let ns_window_addr = ns_window_ptr as usize;
        let draws_bg = !enabled;
        let rgb = bg_color.unwrap_or([255, 255, 255]);

        dispatch2::DispatchQueue::main().exec_sync(move || {
            let ns_win = ns_window_addr as *mut AnyObject;
            unsafe {
                remove_bg_image_view(ns_win);

                let ns_color_class = AnyClass::get(c"NSColor").expect("NSColor");
                if draws_bg {
                    if let Some(ref bytes) = image_bytes {
                        add_bg_image_view(ns_win, bytes);
                    }
                    let r = rgb[0] as f64 / 255.0;
                    let g = rgb[1] as f64 / 255.0;
                    let b = rgb[2] as f64 / 255.0;
                    let bg: *mut AnyObject = msg_send![
                        ns_color_class,
                        colorWithSRGBRed: r,
                        green: g,
                        blue: b,
                        alpha: 1.0_f64,
                    ];
                    let _: () = msg_send![ns_win, setBackgroundColor: bg];
                } else {
                    let clear: *mut AnyObject = msg_send![ns_color_class, clearColor];
                    let _: () = msg_send![ns_win, setBackgroundColor: clear];
                }

                let content_view: *mut AnyObject = msg_send![ns_win, contentView];
                set_draws_background_recursive(content_view, draws_bg);
            }
        });
    }

    #[cfg(not(target_os = "macos"))]
    let _ = (window, enabled, bg_color, bg_image_base64);

    Ok(())
}

// ============================================
// macOS background-image helpers
// ============================================

#[cfg(target_os = "macos")]
const BG_IMAGE_VIEW_TAG: isize = 98765;

/// Create an NSImageView from raw image bytes and insert it behind all
/// other subviews of the window's contentView.
#[cfg(target_os = "macos")]
unsafe fn add_bg_image_view(ns_win: *mut AnyObject, image_bytes: &[u8]) {
    use objc2_foundation::NSRect;

    let ns_data_class = AnyClass::get(c"NSData").expect("NSData");
    let ns_data: *mut AnyObject = msg_send![
        ns_data_class,
        dataWithBytes: image_bytes.as_ptr(),
        length: image_bytes.len(),
    ];
    if ns_data.is_null() {
        return;
    }

    let ns_image_class = AnyClass::get(c"NSImage").expect("NSImage");
    let ns_image: *mut AnyObject = msg_send![ns_image_class, alloc];
    let ns_image: *mut AnyObject = msg_send![ns_image, initWithData: ns_data];
    if ns_image.is_null() {
        return;
    }

    let content_view: *mut AnyObject = msg_send![ns_win, contentView];
    let bounds: NSRect = msg_send![content_view, bounds];

    let image_view_class = AnyClass::get(c"NSImageView").expect("NSImageView");
    let image_view: *mut AnyObject = msg_send![image_view_class, alloc];
    let image_view: *mut AnyObject = msg_send![image_view, initWithFrame: bounds];
    if image_view.is_null() {
        return;
    }

    let _: () = msg_send![image_view, setImage: ns_image];
    // NSImageScaleAxesIndependently = 1 (stretch to fill frame)
    let _: () = msg_send![image_view, setImageScaling: 1_usize];
    // NSViewWidthSizable | NSViewHeightSizable = 2 | 16
    let _: () = msg_send![image_view, setAutoresizingMask: 18_usize];
    let _: () = msg_send![image_view, setTag: BG_IMAGE_VIEW_TAG];

    let subviews: *mut AnyObject = msg_send![content_view, subviews];
    let count: usize = msg_send![subviews, count];
    if count > 0 {
        let first: *mut AnyObject = msg_send![subviews, objectAtIndex: 0_usize];
        // NSWindowBelow = -1 → insert behind existing views
        let _: () = msg_send![
            content_view,
            addSubview: image_view,
            positioned: -1_isize,
            relativeTo: first,
        ];
    } else {
        let _: () = msg_send![content_view, addSubview: image_view];
    }
}

/// Remove the background image view (if any) from the window's contentView.
#[cfg(target_os = "macos")]
unsafe fn remove_bg_image_view(ns_win: *mut AnyObject) {
    let content_view: *mut AnyObject = msg_send![ns_win, contentView];
    let tagged: *mut AnyObject = msg_send![content_view, viewWithTag: BG_IMAGE_VIEW_TAG];
    if !tagged.is_null() {
        let _: () = msg_send![tagged, removeFromSuperview];
    }
}

/// Recursively find WKWebView subviews and set their _drawsBackground property.
#[cfg(target_os = "macos")]
unsafe fn set_draws_background_recursive(view: *mut AnyObject, draws: bool) {
    use objc2::runtime::Bool;

    if view.is_null() {
        return;
    }

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

/// Remove the startup background from the main window. Called from the
/// frontend once the React app finishes loading and CSS backgrounds are
/// painted — this restores the normal transparent glass appearance.
#[tauri::command]
pub async fn remove_window_background(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Main window not found")?;

    #[cfg(target_os = "macos")]
    {
        super::remove_window_background_color(&window);
        super::set_traffic_light_position(&window, super::TRAFFIC_LIGHT_X, super::TRAFFIC_LIGHT_Y);
    }

    #[cfg(not(target_os = "macos"))]
    let _ = window;

    Ok(())
}

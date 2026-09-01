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

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

#[cfg(target_os = "macos")]
use objc2::msg_send;
#[cfg(target_os = "macos")]
use objc2::runtime::{AnyClass, AnyObject};
#[cfg(target_os = "macos")]
use tauri::{LogicalPosition, Position, TitleBarStyle};

/// Set the native zoom factor for the main application WebView.
#[tauri::command]
pub async fn set_main_webview_zoom(app: AppHandle, scale_factor: f64) -> Result<(), String> {
    let webview = app.get_webview("main").ok_or("Main WebView not found")?;

    webview
        .set_zoom(scale_factor)
        .map_err(|err| format!("Failed to set main WebView zoom: {}", err))?;

    Ok(())
}

/// Set the native zoom factor for the CALLING window's own WebView.
///
/// Per-window replacement for [`set_main_webview_zoom`]: with detached
/// session windows, each window must zoom its own webview instead of
/// re-zooming "main". Tauri injects the invoking [`tauri::Webview`], so
/// no label lookup is needed and the command can never target another
/// window. The main-window variant is kept for compatibility.
#[tauri::command]
pub async fn set_webview_zoom(webview: tauri::Webview, scale_factor: f64) -> Result<(), String> {
    webview
        .set_zoom(scale_factor)
        .map_err(|err| format!("Failed to set WebView zoom: {}", err))?;

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

/// Remove the startup background from the CALLING window. Every window's
/// frontend invokes this once React finishes loading and CSS backgrounds are
/// painted — restoring the transparent glass appearance and re-asserting the
/// traffic-light inset (the post-paint re-apply is what keeps the buttons
/// stable on macOS). Tauri injects the invoking window, so main and detached
/// session windows each clear their own backdrop.
#[tauri::command]
pub async fn remove_window_background(window: tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        super::remove_window_background_color(&window);
        super::set_traffic_light_position(&window, super::TRAFFIC_LIGHT_X, super::TRAFFIC_LIGHT_Y);
    }

    #[cfg(not(target_os = "macos"))]
    let _ = window;

    Ok(())
}

// ============================================
// Detached session windows
// ============================================

/// Label prefix for detached session windows. Matches the `app-window-*`
/// glob in `capabilities/default.json`, so these windows inherit the full
/// default permission set without a capability (and thus Rust schema) change.
pub const SESSION_WINDOW_LABEL_PREFIX: &str = "app-window-session-";

/// Session ids are `<source-prefix>-<uuid>` shaped. The id is embedded
/// verbatim in both the window label and the app-route path, so anything
/// outside the shared safe charset is refused rather than escaped — escaping
/// differently per context would let label and URL disagree about identity.
fn is_window_safe_session_id(session_id: &str) -> bool {
    !session_id.is_empty()
        && session_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn session_window_label(session_id: &str) -> String {
    format!("{SESSION_WINDOW_LABEL_PREFIX}{session_id}")
}

/// Open (or focus) the detached window showing exactly one session.
///
/// The window loads the standalone `/orgii/app/session/<id>` route — the same
/// bundle as the main window, rendering only the session surface. There is no
/// prewarmed window pool: the window is built on demand and visible from the
/// first frame (the splash), which is the fastest honest feedback we can give.
///
/// Chrome follows the decorated-secondary-window recipe used by
/// `browser::open_browser_window`: native decorations everywhere, macOS
/// overlay title bar with repositioned traffic lights (the builder option
/// alone is unreliable for dynamically created windows — see
/// `set_traffic_light_position`), and Win11 DWM rounded corners.
///
/// `async` on purpose: on Windows, building a window from a synchronous
/// command deadlocks the main thread.
#[tauri::command]
pub async fn open_session_window(
    app: AppHandle,
    session_id: String,
    title: Option<String>,
) -> Result<String, String> {
    if !is_window_safe_session_id(&session_id) {
        return Err(format!(
            "Session id contains characters unsafe for a window label: {session_id}"
        ));
    }

    let label = session_window_label(&session_id);
    let window_title = title
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "ORG2".to_string());

    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.set_title(&window_title);
        existing
            .show()
            .map_err(|e| format!("Failed to show session window: {e}"))?;
        existing
            .set_focus()
            .map_err(|e| format!("Failed to focus session window: {e}"))?;
        return Ok(label);
    }

    let route = format!("orgii/app/session/{session_id}");
    let builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(route.into()))
        .title(&window_title)
        .inner_size(1100.0, 800.0)
        .min_inner_size(450.0, 300.0)
        .resizable(true)
        .visible(true)
        .decorations(true)
        // Match the main window's startup backdrop so the pre-paint frame is
        // never a white flash. The page paints its own background on top.
        .background_color(tauri::window::Color(0x0d, 0x0d, 0x0d, 0xff));

    // Same chrome contract as the main window's config: a TRANSPARENT
    // NSWindow under the overlay title bar. Without transparency, macOS
    // draws an opaque titlebar band across the top and the repositioned
    // traffic lights sit against a mismatched strip instead of over the
    // app's own header.
    #[cfg(target_os = "macos")]
    let builder = builder
        .hidden_title(true)
        .title_bar_style(TitleBarStyle::Overlay)
        .transparent(true)
        .traffic_light_position(Position::Logical(LogicalPosition::new(
            super::TRAFFIC_LIGHT_X,
            super::TRAFFIC_LIGHT_Y,
        )));

    let ownership_observation = perf_utils::begin_webview_ownership_observation(label.clone());
    let window = builder
        .build()
        .map_err(|e| format!("Failed to create session window: {e}"))?;
    ownership_observation.commit();

    // Same post-build sequence as `recreate_main_window`: reposition the
    // traffic lights (the builder option alone is unreliable for dynamically
    // created windows), paint the startup background so the transparent
    // window never shows the desktop through, and mount the same vibrancy
    // material the main window uses. The frontend clears the startup
    // background via `remove_window_background` once React paints — that
    // command operates on the calling window, so this window gets the same
    // post-paint traffic-light re-apply main does.
    #[cfg(target_os = "macos")]
    {
        super::set_traffic_light_position(&window, super::TRAFFIC_LIGHT_X, super::TRAFFIC_LIGHT_Y);
        super::apply_window_background_color(&window);
        super::apply_macos_window_material(&window);
    }

    super::apply_host_desktop_decorated_window_corners(&window);

    let _ = window.set_focus();

    Ok(label)
}

#[cfg(test)]
mod session_window_tests {
    use super::{is_window_safe_session_id, session_window_label};

    #[test]
    fn accepts_prefixed_uuid_session_ids() {
        assert!(is_window_safe_session_id(
            "osagent-1f2e3d4c-5b6a-7980-a1b2-c3d4e5f60718"
        ));
        assert!(is_window_safe_session_id("humansession-abc_123"));
    }

    #[test]
    fn rejects_ids_unsafe_for_labels_or_paths() {
        assert!(!is_window_safe_session_id(""));
        assert!(!is_window_safe_session_id("osagent-1234/../../etc"));
        assert!(!is_window_safe_session_id("osagent 1234"));
        assert!(!is_window_safe_session_id("osagent-1234?x=1"));
        assert!(!is_window_safe_session_id("osagent-1234.json"));
    }

    #[test]
    fn label_matches_the_capability_glob() {
        assert_eq!(
            session_window_label("osagent-1"),
            "app-window-session-osagent-1"
        );
        assert!(session_window_label("x").starts_with("app-window-"));
    }
}

/// Whether the main window has a translucent native backdrop (Windows 11
/// acrylic). The frontend mirrors this as `<html data-windows-chrome>` so
/// CSS can relax its opaque fail-safe background. Always `false` on
/// Windows 10 (acrylic disabled — drag lag) and non-Windows hosts (macOS
/// vibrancy uses its own `data-host-desktop="macos"` CSS path).
#[tauri::command]
pub fn main_window_chrome_is_acrylic() -> bool {
    #[cfg(windows)]
    {
        super::windows_corner::current_policy().acrylic
    }
    #[cfg(not(windows))]
    {
        false
    }
}

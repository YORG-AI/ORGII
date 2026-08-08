//! Inline Webview Z-Order Layering (macOS)
//!
//! Controls the NSView subview ordering of an inline WKWebView relative to
//! its siblings (in particular, the React "main" webview). On macOS, all
//! child webviews of a Tauri window are sibling NSViews under the window's
//! contentView, and their z-order is determined by subview order — last
//! added draws on top. Clicks and pointer events also follow this order:
//! the front-most subview in the click region receives the event.
//!
//! This module exposes two operations:
//!
//! - [`browser_webview_send_to_back`]: move the given webview's NSView to
//!   the back of its superview's subviews. Other siblings (React UI) will
//!   draw above it and intercept clicks in their bounds. Used when a React
//!   overlay (dropdown, modal, tooltip) temporarily needs to cover the
//!   browser region.
//!
//! - [`browser_webview_bring_to_front`]: move it to the front. This is the
//!   default state: the browser is interactive and draws above any
//!   overlapping React surface.
//!
//! ## Pointer events
//!
//! This approach works because we only reorder when the React UI genuinely
//! wants to occupy the region (it has visible opaque pixels). We never
//! leave React "transparently" on top of the browser, which would steal
//! clicks the user intended for the page. See the design discussion in the
//! agent transcript that produced this module.
//!
//! ## Platforms
//!
//! macOS only for now. Windows (WebView2) and Linux (WebKitGTK) have
//! different windowing stacks; add platform branches when needed.

use tauri::{AppHandle, Manager};

/// Move the given inline webview's native NSView to the back of its
/// superview's subview stack, so React surfaces draw above it.
#[tauri::command]
pub fn browser_webview_send_to_back(app: AppHandle, label: String) -> Result<(), String> {
    reorder_webview(&app, &label, Order::Back)
}

/// Move the given inline webview's native NSView to the front of its
/// superview's subview stack, so it draws above all other children of the
/// window's contentView (default state — fully interactive).
#[tauri::command]
pub fn browser_webview_bring_to_front(app: AppHandle, label: String) -> Result<(), String> {
    reorder_webview(&app, &label, Order::Front)
}

/// Reorder every inline browser webview at once. Used by the global overlay
/// layering bridge (React-side) to drop all inline webviews behind portals
/// when any overlay opens, and lift them back on close.
///
/// Matches labels that begin with `"browser-session-"` — the prefix used by
/// `BrowserSessionWebview` in the frontend. Preview webviews and
/// other inline webviews are intentionally excluded because they don't
/// occupy the same regions where selectors/sidebars render.
///
/// Returns the list of labels actually reordered.
#[tauri::command]
pub fn browser_webviews_set_layer_for_all(
    app: AppHandle,
    send_to_back: bool,
) -> Result<Vec<String>, String> {
    let order = if send_to_back {
        Order::Back
    } else {
        Order::Front
    };
    let mut reordered: Vec<String> = Vec::new();

    for label in app.webviews().keys() {
        if !label.starts_with("browser-session-") {
            continue;
        }

        if let Err(err) = reorder_webview(&app, label, order) {
            // Not fatal — a webview might be mid-teardown. Log and continue.
            eprintln!(
                "[browser_webviews_set_layer_for_all] '{}' skipped: {}",
                label, err
            );
            continue;
        }
        reordered.push(label.clone());
    }

    Ok(reordered)
}

#[derive(Clone, Copy)]
enum Order {
    Front,
    Back,
}

fn reorder_webview(app: &AppHandle, label: &str, order: Order) -> Result<(), String> {
    let webview = app
        .get_webview(label)
        .ok_or_else(|| format!("Webview '{}' not found", label))?;

    #[cfg(target_os = "macos")]
    {
        reorder_macos(&webview, order).map_err(|e| format!("reorder failed: {}", e))
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = webview;
        let _ = order;
        Err("webview z-order control is only implemented on macOS".to_string())
    }
}

#[cfg(target_os = "macos")]
fn reorder_macos(webview: &tauri::Webview, order: Order) -> Result<(), String> {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use std::sync::{Arc, Mutex};

    // NSWindowOrderingMode constants used by addSubview:positioned:relativeTo:
    // NSWindowAbove = 1, NSWindowBelow = -1
    const NS_WINDOW_ABOVE: i64 = 1;
    const NS_WINDOW_BELOW: i64 = -1;

    let positioned: i64 = match order {
        Order::Front => NS_WINDOW_ABOVE,
        Order::Back => NS_WINDOW_BELOW,
    };

    // `with_webview` hops to the main thread and takes a closure that
    // returns `()`, so we capture the outcome through a shared Mutex.
    let outcome: Arc<Mutex<Result<(), String>>> =
        Arc::new(Mutex::new(Err("reorder closure did not run".to_string())));
    let outcome_for_closure = Arc::clone(&outcome);

    // SAFETY: Objective-C runtime access on a valid WKWebView* obtained
    // from `wv.inner()`. We read its `superview` (the window's contentView),
    // then re-add the WKWebView at the requested ordering. NSView allows a
    // subview to be re-added via `addSubview:positioned:relativeTo:`; it is
    // removed from its previous position and inserted at the new one
    // without losing its retain count or event wiring.
    //
    // All pointers are null-checked. Passing a nil `relativeTo` places the
    // subview at the extreme front (NSWindowAbove) or back (NSWindowBelow).
    webview
        .with_webview(move |wv| unsafe {
            let wk_webview: *mut AnyObject = wv.inner() as *mut AnyObject;
            if wk_webview.is_null() {
                *outcome_for_closure.lock().unwrap() = Err("WKWebView pointer is null".to_string());
                return;
            }

            let superview: *mut AnyObject = msg_send![wk_webview, superview];
            if superview.is_null() {
                *outcome_for_closure.lock().unwrap() =
                    Err("WKWebView has no superview yet".to_string());
                return;
            }

            let relative_to: *mut AnyObject = std::ptr::null_mut();
            let _: () = msg_send![
                superview,
                addSubview: wk_webview,
                positioned: positioned,
                relativeTo: relative_to,
            ];

            *outcome_for_closure.lock().unwrap() = Ok(());
        })
        .map_err(|e| format!("with_webview failed: {}", e))?;

    let guard = outcome.lock().unwrap();
    guard.clone()
}

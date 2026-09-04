//! Public AppKit menu vibrancy, available before our macOS 10.15 minimum.
//!
//! The content view owns the material view. Its identifier makes repeated enable
//! calls idempotent without a global registry, observers, or retained windows.
//! Do not use NSGlassEffectView or the undocumented NSVisualEffectView
//! `setCornerRadius:` selector: AppKit clips the decorated window itself.

use objc2::msg_send;
use objc2::runtime::{AnyClass, AnyObject};
use objc2_app_kit::{
    NSAutoresizingMaskOptions, NSUserInterfaceItemIdentification, NSView,
    NSVisualEffectBlendingMode, NSVisualEffectMaterial, NSVisualEffectState, NSVisualEffectView,
    NSWindow, NSWindowOrderingMode,
};
use objc2_foundation::{MainThreadMarker, NSString};

const MATERIAL_IDENTIFIER: &str = "org2.window.menu-vibrancy";
const ROOT_TINT_IDENTIFIER: &str = "org2.window.root-tint";

/// Complete the native mutation before returning, including when called by an
/// async Tauri command. Looking up the NSWindow inside the main-thread closure
/// avoids carrying an unretained native pointer across a dispatch boundary.
pub(super) fn set_enabled(window: &tauri::WebviewWindow, enabled: bool) -> Result<(), String> {
    with_content_view(window, move |content_view, mtm| {
        set_on_content_view(content_view, enabled, mtm)
    })
}

/// Run `mutate` against the window's content view on the AppKit main thread,
/// synchronously, whether or not the caller is already there.
fn with_content_view(
    window: &tauri::WebviewWindow,
    mutate: impl FnOnce(&NSView, MainThreadMarker) + Send,
) -> Result<(), String> {
    let mut mutate = Some(mutate);
    let mut result = Ok(());
    let mut run = || {
        result = (|| {
            let mtm = MainThreadMarker::new().ok_or("Window material requires the main thread")?;
            let pointer = window
                .ns_window()
                .map_err(|error| format!("Failed to get native window: {error}"))?;
            // SAFETY: Tauri supplies the NSWindow for this live window. The
            // lookup and all uses stay in one synchronous main-thread call.
            let native_window = unsafe { pointer.cast::<NSWindow>().as_ref() }
                .ok_or("Native window is unavailable")?;
            let content_view = native_window
                .contentView()
                .ok_or("Native window has no content view")?;
            if let Some(mutate) = mutate.take() {
                mutate(&content_view, mtm);
            }
            Ok(())
        })();
    };

    if MainThreadMarker::new().is_some() {
        run();
    } else {
        dispatch2::DispatchQueue::main().exec_sync(run);
    }
    result
}

fn find_subview(
    content_view: &NSView,
    identifier: &NSString,
) -> Option<objc2::rc::Retained<NSView>> {
    content_view
        .subviews()
        .iter()
        .find(|view| view.identifier().as_deref() == Some(identifier))
}

/// Paint (or remove) the app's root tint as a native layer directly under the
/// webview and above the vibrancy material.
///
/// The page's root surfaces on macOS are translucent tints over the material
/// (`html[data-host-desktop="macos"]` in `src/index.scss`). When the window
/// grows, AppKit resizes the window and the WKWebView's view synchronously,
/// but the page pixels arrive from the WebContent process one or more frames
/// later; the newly exposed strip shows whatever sits behind the webview.
/// With the tint living in CSS that strip was raw material, visibly lighter
/// than the page. Hosting the same composite tint natively makes the strip
/// match the page, and the frontend then drops its CSS tint
/// (`data-native-root-tint`) so the two never stack.
///
/// `color` is sRGB `[r, g, b, a]` in `0.0..=1.0`. `None` removes the layer.
pub(super) fn set_root_tint(
    window: &tauri::WebviewWindow,
    color: Option<[f64; 4]>,
) -> Result<(), String> {
    with_content_view(window, move |content_view, mtm| {
        set_root_tint_on_content_view(content_view, color, mtm)
    })
}

fn set_root_tint_on_content_view(
    content_view: &NSView,
    color: Option<[f64; 4]>,
    mtm: MainThreadMarker,
) {
    let identifier = NSString::from_str(ROOT_TINT_IDENTIFIER);
    let existing = find_subview(content_view, &identifier);
    let Some([r, g, b, a]) = color else {
        if let Some(view) = existing {
            view.removeFromSuperview();
        }
        return;
    };

    let tint = match existing {
        Some(view) => view,
        None => {
            let view = NSView::initWithFrame(mtm.alloc(), content_view.bounds());
            view.setIdentifier(Some(&identifier));
            view.setAutoresizingMask(
                NSAutoresizingMaskOptions::ViewWidthSizable
                    | NSAutoresizingMaskOptions::ViewHeightSizable,
            );
            // Own an explicit layer rather than relying on `wantsLayer` to
            // create one lazily: the colour below is set immediately, and a
            // nil layer would leave an invisible view and no fix.
            // SAFETY: plain class-method sends on the main thread.
            unsafe {
                let layer_class = AnyClass::get(c"CALayer").expect("CALayer");
                let layer: *mut AnyObject = msg_send![layer_class, layer];
                let _: () = msg_send![&*view, setLayer: layer];
            }
            view.setWantsLayer(true);
            // Above the material when it is mounted, otherwise at the very
            // bottom: `set_on_content_view` always inserts the material at the
            // bottom, so the tint stays above it across vibrancy toggles.
            match find_subview(content_view, &NSString::from_str(MATERIAL_IDENTIFIER)) {
                Some(material) => content_view.addSubview_positioned_relativeTo(
                    &view,
                    NSWindowOrderingMode::Above,
                    Some(&material),
                ),
                None => content_view.addSubview_positioned_relativeTo(
                    &view,
                    NSWindowOrderingMode::Below,
                    None,
                ),
            }
            view
        }
    };

    // SAFETY: plain AppKit / CoreAnimation message sends on the main thread
    // against objects this function owns or just created.
    unsafe {
        let ns_color_class = AnyClass::get(c"NSColor").expect("NSColor");
        let ns_color: *mut AnyObject = msg_send![
            ns_color_class,
            colorWithSRGBRed: r,
            green: g,
            blue: b,
            alpha: a,
        ];
        let cg_color: *mut AnyObject = msg_send![ns_color, CGColor];
        let layer: *mut AnyObject = msg_send![&*tint, layer];
        if !layer.is_null() {
            let _: () = msg_send![layer, setBackgroundColor: cg_color];
        }
    }
}

fn set_on_content_view(content_view: &NSView, enabled: bool, mtm: MainThreadMarker) {
    let identifier = NSString::from_str(MATERIAL_IDENTIFIER);
    let subviews = content_view.subviews();
    for view in subviews.iter() {
        if view.identifier().as_deref() == Some(&*identifier) {
            if !enabled {
                view.removeFromSuperview();
            }
            return;
        }
    }
    if !enabled {
        return;
    }

    let material = NSVisualEffectView::initWithFrame(mtm.alloc(), content_view.bounds());
    material.setIdentifier(Some(&identifier));
    material.setMaterial(NSVisualEffectMaterial::Menu);
    material.setBlendingMode(NSVisualEffectBlendingMode::BehindWindow);
    material.setState(NSVisualEffectState::FollowsWindowActiveState);
    material.setAutoresizingMask(
        NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable,
    );
    content_view.addSubview_positioned_relativeTo(&material, NSWindowOrderingMode::Below, None);
}

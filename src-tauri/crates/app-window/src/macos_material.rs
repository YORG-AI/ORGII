//! Public AppKit menu vibrancy, available before our macOS 10.15 minimum.
//!
//! The content view owns the material view. Its identifier makes repeated enable
//! calls idempotent without a global registry, observers, or retained windows.
//! Do not use NSGlassEffectView or the undocumented NSVisualEffectView
//! `setCornerRadius:` selector: AppKit clips the decorated window itself.

use objc2_app_kit::{
    NSAutoresizingMaskOptions, NSUserInterfaceItemIdentification, NSView,
    NSVisualEffectBlendingMode, NSVisualEffectMaterial, NSVisualEffectState, NSVisualEffectView,
    NSWindow, NSWindowOrderingMode,
};
use objc2_foundation::{ns_string, MainThreadMarker};

/// Complete the native mutation before returning, including when called by an
/// async Tauri command. Looking up the NSWindow inside the main-thread closure
/// avoids carrying an unretained native pointer across a dispatch boundary.
pub(super) fn set_enabled(window: &tauri::WebviewWindow, enabled: bool) -> Result<(), String> {
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
            set_on_content_view(&content_view, enabled, mtm);
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

fn set_on_content_view(content_view: &NSView, enabled: bool, mtm: MainThreadMarker) {
    let identifier = ns_string!("org2.window.menu-vibrancy");
    let subviews = content_view.subviews();
    for view in subviews.iter() {
        if view.identifier().as_deref() == Some(identifier) {
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
    material.setIdentifier(Some(identifier));
    material.setMaterial(NSVisualEffectMaterial::Menu);
    material.setBlendingMode(NSVisualEffectBlendingMode::BehindWindow);
    material.setState(NSVisualEffectState::FollowsWindowActiveState);
    material.setAutoresizingMask(
        NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable,
    );
    content_view.addSubview_positioned_relativeTo(&material, NSWindowOrderingMode::Below, None);
}

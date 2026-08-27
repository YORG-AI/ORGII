//! Windows native chrome: version-aware acrylic, corner, and shadow policy.
//!
//! Win10's DWM cannot round frameless windows, draws the window shadow as a
//! visible 1px border around transparent windows, and recomposits acrylic on
//! every frame while dragging (visible lag). Win11 (build 22000+) supports
//! all three natively. The policy is decided once from the OS build number
//! and applied from Rust only — the frontend reads the resulting policy via
//! the `main_window_chrome_is_acrylic` command and mirrors it as
//! `<html data-windows-chrome="acrylic">` so CSS can relax its opaque
//! fail-safe background (see `src/index.scss`).

use std::ffi::c_void;

use tauri::WebviewWindow;
use tracing::warn;
use windows::Win32::Graphics::Dwm::{
    DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
};

/// Native chrome capabilities for a given Windows build.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct WindowsChromePolicy {
    /// Translucent acrylic backdrop behind the frameless main window.
    pub acrylic: bool,
    /// DWM rounded corners (`DWMWCP_ROUND`, 8 px at 100 % DPI — pairs with
    /// the frontend's `--border-radius-window`, see `windowChromeRadius.ts`).
    pub rounded_corners: bool,
    /// DWM window shadow. On Win10 it renders as a 1px border artifact
    /// around transparent frameless windows, so it is disabled there.
    pub shadow: bool,
}

const WINDOWS_11_FIRST_BUILD: u32 = 22000;

/// Pure build-number → policy mapping. Build 0 (version lookup failed)
/// deliberately falls into the conservative Win10 branch.
const fn policy_for_build(build: u32) -> WindowsChromePolicy {
    let win11 = build >= WINDOWS_11_FIRST_BUILD;
    WindowsChromePolicy {
        acrylic: win11,
        rounded_corners: win11,
        shadow: win11,
    }
}

/// Policy for the Windows version this process is running on.
pub(super) fn current_policy() -> WindowsChromePolicy {
    policy_for_build(windows_version::OsVersion::current().build)
}

/// Rounded corners only — for decorated secondary windows (e.g. browser).
/// Decorated windows keep their native frame, shadow, and opaque backdrop,
/// so the acrylic/shadow parts of the policy do not apply to them.
pub(super) fn apply_rounded_corners(window: &WebviewWindow) {
    if current_policy().rounded_corners {
        set_dwm_rounded_corners(window);
    }
}

/// Full chrome for the frameless, transparent main window.
///
/// **Win11+:** DWM rounded corners + translucent acrylic backdrop.
/// **Win10:** no acrylic (drag lag), no DWM shadow (1px border artifact),
///   opaque native background so `transparent: true` does not punch a hole
///   through to the desktop.
pub(super) fn apply_frameless_window_chrome(window: &WebviewWindow) {
    let policy = current_policy();

    if policy.rounded_corners {
        set_dwm_rounded_corners(window);
    }

    if policy.acrylic {
        // Semi-transparent dark tint over the system backdrop; an alpha of
        // 255 would make the acrylic fully opaque and thus invisible.
        if let Err(err) = window_vibrancy::apply_acrylic(window, Some((13, 13, 13, 125))) {
            warn!(
                target: "app_lib::window",
                "apply_acrylic failed (non-fatal, continuing without acrylic): {}",
                err
            );
        }
    } else {
        // Clear any acrylic left over from a previous run/config layer, and
        // paint an opaque native background as the pre-CSS fallback.
        let _ = window_vibrancy::clear_acrylic(window);
        let _ = window.set_background_color(Some(tauri::window::Color(13, 13, 13, 255)));
    }

    if !policy.shadow {
        let _ = window.set_shadow(false);
    }
}

fn set_dwm_rounded_corners(window: &WebviewWindow) {
    let hwnd = match window.hwnd() {
        Ok(handle) => handle,
        Err(err) => {
            warn!(
                target: "app_lib::window",
                "WebviewWindow::hwnd failed (skipping DWM corner preference): {}",
                err
            );
            return;
        }
    };

    let preference = DWMWCP_ROUND;
    let set_result = unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            std::ptr::from_ref(&preference).cast::<c_void>(),
            std::mem::size_of_val(&preference) as u32,
        )
    };

    if let Err(err) = set_result {
        warn!(
            target: "app_lib::window",
            "DwmSetWindowAttribute(DWMWA_WINDOW_CORNER_PREFERENCE) failed: {}",
            err
        );
    }
}

#[cfg(all(test, windows))]
#[path = "tests/windows_corner_tests.rs"]
mod windows_corner_tests;

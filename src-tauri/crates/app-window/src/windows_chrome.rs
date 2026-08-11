//! Version-aware native window chrome for Windows.
//!
//! Windows 11 keeps the configured Acrylic backdrop and DWM-rounded frame.
//! Windows 10 uses an opaque main-window fallback: the Acrylic implementation
//! is expensive while moving/resizing and the default shadow on a frameless
//! window creates a visible one-pixel border.

use std::ffi::c_void;

use tauri::utils::config::WindowEffectsConfig;
use tauri::{Webview, WebviewWindow};
use tracing::{info, warn};
use windows::Win32::Graphics::Dwm::{
    DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
};
use windows_version::OsVersion;

use crate::windows_chrome_policy::requires_opaque_fallback;

const WINDOWS_10_OPAQUE_PAGE_SCRIPT: &str =
    r#"document.documentElement?.setAttribute("data-windows-chrome", "opaque");"#;

pub(super) fn apply_main_window_chrome(window: &WebviewWindow) {
    let version = OsVersion::current();
    if requires_opaque_fallback(version.major, version.minor, version.build) {
        apply_windows_10_fallback(window, version);
    } else {
        apply_dwm_rounded_corner_preference_for_supported_host(window);
    }
}

pub(super) fn apply_dwm_rounded_corner_preference(window: &WebviewWindow) {
    let version = OsVersion::current();
    if requires_opaque_fallback(version.major, version.minor, version.build) {
        return;
    }

    apply_dwm_rounded_corner_preference_for_supported_host(window);
}

pub(super) fn apply_main_window_page_chrome(webview: &Webview) {
    let version = OsVersion::current();
    if !requires_opaque_fallback(version.major, version.minor, version.build) {
        return;
    }

    if let Err(error) = webview.eval(WINDOWS_10_OPAQUE_PAGE_SCRIPT) {
        warn!(%error, "Failed to mark the Windows 10 page as opaque");
    }
}

fn apply_windows_10_fallback(window: &WebviewWindow, version: OsVersion) {
    if let Err(error) = window.set_effects(Option::<WindowEffectsConfig>::None) {
        warn!(%error, "Failed to clear Windows 10 window effects");
    }
    if let Err(error) = window.set_shadow(false) {
        warn!(%error, "Failed to disable the Windows 10 frameless-window border");
    }

    info!(
        windows_major = version.major,
        windows_minor = version.minor,
        windows_build = version.build,
        "Applied Windows 10 opaque main-window chrome fallback"
    );
}

fn apply_dwm_rounded_corner_preference_for_supported_host(window: &WebviewWindow) {
    let hwnd = match window.hwnd() {
        Ok(handle) => handle,
        Err(error) => {
            warn!(
                target: "app_lib::window",
                %error,
                "WebviewWindow::hwnd failed (skipping DWM corner preference)"
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

    if let Err(error) = set_result {
        warn!(
            target: "app_lib::window",
            %error,
            "DwmSetWindowAttribute(DWMWA_WINDOW_CORNER_PREFERENCE) failed"
        );
    }
}

#[cfg(all(test, windows))]
#[path = "tests/windows_chrome_tests.rs"]
mod windows_chrome_tests;

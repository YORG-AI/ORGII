//! The opaque colour a window paints before its webview has painted anything.
//!
//! Hosts whose secondary windows are opaque (Windows, Linux) show this colour
//! for the whole gap between the window appearing and the page's first frame.
//! A fixed dark value is wrong half the time: on a light theme the window
//! opens dark, then the splash plate repaints it white, then the app paints.
//! Two flashes, neither of them the app's colour.
//!
//! The values below mirror `--splash-bg` in `public/index.html` exactly, so
//! the native backdrop and the first thing the page paints are the same
//! colour and the seam is invisible.
//!
//! Skin caveat: a non-baseline skin overrides `--splash-bg` from
//! `localStorage["orgii_skin_surface"]`, which `useAppSkin` mirrors for the
//! splash. Nothing derives those tokens outside the bundle — the derivation
//! lives in TS (`deriveSkinTokens`) — so a skinned app gets ORGII's base
//! surface here rather than the skin's. That keeps the light/dark polarity
//! right, which is what removes the flash; matching the exact skin surface
//! would mean duplicating the skin registry in Rust.

use tauri::{AppHandle, Manager};

/// sRGB triples mirroring `--splash-bg` in `public/index.html`.
pub const LIGHT_BACKDROP: (u8, u8, u8) = (0xff, 0xff, 0xff);
pub const DARK_BACKDROP: (u8, u8, u8) = (0x14, 0x14, 0x14);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Appearance {
    Light,
    Dark,
}

/// Resolve a stored `general.theme` value to an appearance.
///
/// Mirrors `normalizeGlobalThemePreference` + `LEGACY_THEME_ALIASES` in
/// `src/config/appearance/globalThemes.ts`. `None` means "follow the OS":
/// the explicit `system` preference, an absent setting, and any unrecognised
/// value all land there, matching the TS default of
/// `DEFAULT_GLOBAL_THEME_PREFERENCE = system`.
pub fn appearance_for_preference(preference: Option<&str>) -> Option<Appearance> {
    match preference?.trim() {
        "light" | "github-light" | "/orgii_main.css" => Some(Appearance::Light),
        "dark"
        | "github-dark"
        | "orgii-high-contrast"
        | "/orgii_dark.css"
        | "/orgii_high_contrast.css" => Some(Appearance::Dark),
        // "system", "", and anything unrecognised follow the OS.
        _ => None,
    }
}

/// The user's stored global theme preference, if the settings file has one.
fn stored_theme_preference() -> Option<String> {
    settings::file_io::read_settings()
        .ok()?
        .get("general.theme")?
        .as_str()
        .map(str::to_owned)
}

/// The OS appearance, read off the main window (Tauri reports the system
/// theme for a window that has not overridden it). Falls back to light, which
/// matches `getSystemColorScheme()`'s own fallback in the frontend.
fn os_appearance(app: &AppHandle) -> Appearance {
    match app
        .get_webview_window("main")
        .and_then(|window| window.theme().ok())
    {
        Some(tauri::Theme::Dark) => Appearance::Dark,
        _ => Appearance::Light,
    }
}

/// The colour a freshly built window should paint until its page does.
pub fn startup_backdrop(app: &AppHandle) -> (u8, u8, u8) {
    let appearance = appearance_for_preference(stored_theme_preference().as_deref())
        .unwrap_or_else(|| os_appearance(app));

    match appearance {
        Appearance::Light => LIGHT_BACKDROP,
        Appearance::Dark => DARK_BACKDROP,
    }
}

#[cfg(test)]
mod tests {
    use super::{appearance_for_preference, Appearance};

    #[test]
    fn resolves_the_current_theme_ids() {
        assert_eq!(
            appearance_for_preference(Some("light")),
            Some(Appearance::Light)
        );
        assert_eq!(
            appearance_for_preference(Some("dark")),
            Some(Appearance::Dark)
        );
    }

    #[test]
    fn resolves_the_legacy_aliases_the_frontend_still_accepts() {
        // Kept in step with LEGACY_THEME_ALIASES in globalThemes.ts: a
        // settings.jsonc written before skins landed still holds these.
        for light in ["github-light", "/orgii_main.css"] {
            assert_eq!(
                appearance_for_preference(Some(light)),
                Some(Appearance::Light),
                "{light} should resolve light"
            );
        }
        for dark in [
            "github-dark",
            "orgii-high-contrast",
            "/orgii_dark.css",
            "/orgii_high_contrast.css",
        ] {
            assert_eq!(
                appearance_for_preference(Some(dark)),
                Some(Appearance::Dark),
                "{dark} should resolve dark"
            );
        }
    }

    #[test]
    fn defers_to_the_os_when_there_is_no_usable_preference() {
        // The TS default preference is "system", and an unrecognised value
        // normalizes to it rather than to a hardcoded light/dark.
        assert_eq!(appearance_for_preference(Some("system")), None);
        assert_eq!(appearance_for_preference(None), None);
        assert_eq!(appearance_for_preference(Some("")), None);
        assert_eq!(appearance_for_preference(Some("solarized")), None);
    }
}

//! Sanity checks for DWM corner preference enum values (Win32 docs).

use windows::Win32::Graphics::Dwm::{DWMWCP_DONOTROUND, DWMWCP_ROUND, DWMWCP_ROUNDSMALL};

#[test]
fn dwm_corner_preference_enum_matches_win32_docs() {
    assert_eq!(DWMWCP_ROUND.0, 2);
    assert_eq!(DWMWCP_ROUNDSMALL.0, 3);
    assert_eq!(DWMWCP_DONOTROUND.0, 1);
}

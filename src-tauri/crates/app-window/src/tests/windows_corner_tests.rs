//! Windows chrome policy tests + DWM corner preference enum sanity checks.

use windows::Win32::Graphics::Dwm::{DWMWCP_DONOTROUND, DWMWCP_ROUND, DWMWCP_ROUNDSMALL};

use super::policy_for_build;

#[test]
fn dwm_corner_preference_enum_matches_win32_docs() {
    assert_eq!(DWMWCP_ROUND.0, 2);
    assert_eq!(DWMWCP_ROUNDSMALL.0, 3);
    assert_eq!(DWMWCP_DONOTROUND.0, 1);
}

#[test]
fn win10_builds_get_conservative_chrome() {
    // 19045 = Win10 22H2 final build.
    let policy = policy_for_build(19045);
    assert!(!policy.acrylic);
    assert!(!policy.rounded_corners);
    assert!(!policy.shadow);
}

#[test]
fn win11_builds_get_full_chrome() {
    // 22000 = first Win11 build; 26100 = Win11 24H2.
    for build in [22000, 26100] {
        let policy = policy_for_build(build);
        assert!(policy.acrylic);
        assert!(policy.rounded_corners);
        assert!(policy.shadow);
    }
}

#[test]
fn failed_version_lookup_falls_back_to_win10_chrome() {
    let policy = policy_for_build(0);
    assert!(!policy.acrylic);
    assert!(!policy.rounded_corners);
    assert!(!policy.shadow);
}

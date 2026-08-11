//! Pure Windows chrome policy, kept platform-independent for unit coverage.

/// First Windows 11 build. Earlier builds use the Windows 10 compatibility
/// path for the main window.
const WINDOWS_11_MINIMUM: (u32, u32, u32) = (10, 0, 22_000);

pub(super) fn requires_opaque_fallback(major: u32, minor: u32, build: u32) -> bool {
    (major, minor, build) < WINDOWS_11_MINIMUM
}

#[cfg(test)]
mod tests {
    use super::requires_opaque_fallback;

    #[test]
    fn windows_10_builds_use_opaque_fallback() {
        assert!(requires_opaque_fallback(10, 0, 19_045));
    }

    #[test]
    fn windows_11_and_newer_keep_modern_chrome() {
        assert!(!requires_opaque_fallback(10, 0, 22_000));
        assert!(!requires_opaque_fallback(10, 0, 26_100));
        assert!(!requires_opaque_fallback(11, 0, 1));
    }
}

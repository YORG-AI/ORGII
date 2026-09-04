//! Validation for the native root tint the frontend pushes on macOS.
//!
//! Platform-neutral so the contract is unit-tested everywhere, even though
//! only `macos_material::set_root_tint` consumes the result.

/// Normalise an sRGB `[r, g, b, a]` tint from the wire.
///
/// Components are expected in `0.0..=1.0`; anything finite is clamped there,
/// while a non-finite component rejects the whole colour so a NaN from a
/// failed CSS parse can never reach CoreAnimation.
pub fn normalize_root_tint(color: [f64; 4]) -> Option<[f64; 4]> {
    if color.iter().any(|component| !component.is_finite()) {
        return None;
    }
    Some(color.map(|component| component.clamp(0.0, 1.0)))
}

#[cfg(test)]
mod tests {
    use super::normalize_root_tint;

    #[test]
    fn keeps_in_range_components() {
        assert_eq!(
            normalize_root_tint([0.05, 0.5, 1.0, 0.386]),
            Some([0.05, 0.5, 1.0, 0.386])
        );
    }

    #[test]
    fn clamps_out_of_range_components() {
        assert_eq!(
            normalize_root_tint([-0.2, 1.7, 0.3, 2.0]),
            Some([0.0, 1.0, 0.3, 1.0])
        );
    }

    #[test]
    fn rejects_non_finite_components() {
        assert_eq!(normalize_root_tint([f64::NAN, 0.0, 0.0, 1.0]), None);
        assert_eq!(normalize_root_tint([0.0, f64::INFINITY, 0.0, 1.0]), None);
    }
}

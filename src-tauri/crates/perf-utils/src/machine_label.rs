//! Human-readable machine label for member-runtime sharing.
//!
//! The label rides along with `cloud_device_identity` and is the only
//! machine-liveness detail the hourly push carries — live CPU/RAM/GPU load
//! is deliberately NOT sampled or synced (total RAM ships as a rounded
//! whole-GB figure inside the hardware identity instead).

use sysinfo::System;

/// Cap on the human-readable machine label (see [`machine_label`]).
pub const MACHINE_LABEL_MAX_CHARS: usize = 64;

/// Human-readable machine label for the `cloud_device_identity` command: the
/// host name when available, else a "<chip> <os>" fallback built from
/// [`super::process_metrics::get_system_info`]. Trimmed and capped at
/// [`MACHINE_LABEL_MAX_CHARS`] characters.
pub fn machine_label() -> String {
    let host_name = System::host_name().unwrap_or_default();
    let trimmed = host_name.trim();
    let label = if trimmed.is_empty() {
        fallback_machine_label()
    } else {
        trimmed.to_string()
    };
    truncate_label(label)
}

fn fallback_machine_label() -> String {
    let info = super::process_metrics::get_system_info();
    format!("{} {}", info.chip_type, info.os_name)
        .trim()
        .to_string()
}

fn truncate_label(label: String) -> String {
    if label.chars().count() <= MACHINE_LABEL_MAX_CHARS {
        label
    } else {
        label.chars().take(MACHINE_LABEL_MAX_CHARS).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn machine_label_is_present_trimmed_and_capped() {
        let label = machine_label();
        assert!(!label.is_empty());
        assert_eq!(label, label.trim());
        assert!(label.chars().count() <= MACHINE_LABEL_MAX_CHARS);
    }

    #[test]
    fn fallback_label_and_truncation() {
        assert!(!fallback_machine_label().is_empty());
        assert_eq!(truncate_label("  ok".to_string()), "  ok");
        let long: String = "é".repeat(MACHINE_LABEL_MAX_CHARS + 10);
        let capped = truncate_label(long);
        assert_eq!(capped.chars().count(), MACHINE_LABEL_MAX_CHARS);
    }
}

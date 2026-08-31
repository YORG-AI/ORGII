//! Linux PSS and smaps-rollup metrics.

#[cfg(target_os = "linux")]
use super::super::types::{
    EffectiveProcessMemory, MemoryBreakdown, MemoryBreakdownKind, MemoryMetricKind,
    ProcessDescriptor,
};

/// Parsed subset of `/proc/<pid>/smaps_rollup` (Linux ≥ 4.14), in bytes.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(in crate::app_memory) struct SmapsRollup {
    pub(in crate::app_memory) pss: u64,
    pub(in crate::app_memory) private_clean: u64,
    pub(in crate::app_memory) private_dirty: u64,
    pub(in crate::app_memory) swap_pss: u64,
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(in crate::app_memory) fn parse_smaps_rollup(text: &str) -> Option<SmapsRollup> {
    let mut rollup = SmapsRollup::default();
    let mut saw_pss = false;
    for line in text.lines() {
        let Some((key, rest)) = line.split_once(':') else {
            continue;
        };
        let mut fields = rest.split_whitespace();
        let Some(value) = fields.next().and_then(|value| value.parse::<u64>().ok()) else {
            continue;
        };
        let bytes = match fields.next() {
            Some("kB") | Some("KB") => value.saturating_mul(1024),
            Some("mB") | Some("MB") => value.saturating_mul(1024 * 1024),
            Some(_) | None => value,
        };
        match key.trim() {
            "Pss" => {
                rollup.pss = bytes;
                saw_pss = true;
            }
            "Private_Clean" => rollup.private_clean = bytes,
            "Private_Dirty" => rollup.private_dirty = bytes,
            "SwapPss" => rollup.swap_pss = bytes,
            _ => {}
        }
    }
    saw_pss.then_some(rollup)
}

#[cfg(target_os = "linux")]
fn linux_smaps_rollup(pid: u32) -> Option<SmapsRollup> {
    let text = std::fs::read_to_string(format!("/proc/{pid}/smaps_rollup")).ok()?;
    parse_smaps_rollup(&text)
}

#[cfg(target_os = "linux")]
pub(super) fn collect_effective_memory(descriptor: &ProcessDescriptor) -> EffectiveProcessMemory {
    match linux_smaps_rollup(descriptor.pid) {
        Some(rollup) => {
            let resident_private_bytes = rollup.private_clean.saturating_add(rollup.private_dirty);
            EffectiveProcessMemory {
                bytes: rollup.pss,
                kind: MemoryMetricKind::Pss,
                birth_token: descriptor.start_time_secs,
                breakdown: MemoryBreakdown {
                    resident_private_bytes,
                    resident_shared_bytes: rollup.pss.saturating_sub(resident_private_bytes),
                    swapped_bytes: rollup.swap_pss,
                    kind: MemoryBreakdownKind::SmapsRollup,
                },
                peak_bytes: None,
            }
        }
        None => EffectiveProcessMemory::rss_fallback(descriptor, descriptor.start_time_secs),
    }
}

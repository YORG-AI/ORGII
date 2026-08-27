use super::*;

fn process(pid: u32, bytes: u64, kind: MemoryMetricKind) -> AppMemoryProcess {
    AppMemoryProcess {
        pid,
        parent_pid: Some(1),
        process_instance_id: format!("{pid}:{pid}"),
        name: format!("process-{pid}"),
        role: if pid == 1 {
            AppMemoryProcessRole::Backend
        } else {
            AppMemoryProcessRole::Renderer
        },
        effective_memory_bytes: bytes,
        metric_kind: kind,
        rss_bytes: bytes.saturating_add(10),
        resident_private_bytes: bytes / 2,
        resident_shared_bytes: 5,
        swapped_bytes: bytes - bytes / 2,
        breakdown_kind: MemoryBreakdownKind::VmRegionWalk,
        peak_effective_memory_bytes: Some(bytes.saturating_mul(2)),
    }
}

#[test]
fn aggregate_native_snapshot() {
    let snapshot = aggregate_snapshot(
        10,
        vec![
            process(1, 100, MemoryMetricKind::PhysicalFootprint),
            process(2, 50, MemoryMetricKind::PhysicalFootprint),
        ],
        AttributionStatus::Complete,
        Vec::new(),
    );
    assert_eq!(snapshot.measurement, EffectiveMeasurement::Native);
    assert_eq!(snapshot.effective_total_bytes, 150);
    assert_eq!(snapshot.rss_mapped_total_bytes, 170);
    assert_eq!(snapshot.resident_private_total_bytes, 75);
    assert_eq!(snapshot.resident_shared_total_bytes, 10);
    assert_eq!(snapshot.swapped_total_bytes, 75);
}

#[test]
fn aggregate_treats_pss_as_native() {
    let snapshot = aggregate_snapshot(
        10,
        vec![process(1, 100, MemoryMetricKind::Pss)],
        AttributionStatus::Complete,
        Vec::new(),
    );
    assert_eq!(snapshot.measurement, EffectiveMeasurement::Native);
}

#[test]
fn aggregate_split_totals_saturate() {
    let mut huge = process(1, u64::MAX, MemoryMetricKind::RssFallback);
    huge.resident_private_bytes = u64::MAX;
    huge.swapped_bytes = u64::MAX;
    let mut other = process(2, 1, MemoryMetricKind::RssFallback);
    other.resident_private_bytes = 1;
    other.swapped_bytes = 1;
    let snapshot = aggregate_snapshot(
        10,
        vec![huge, other],
        AttributionStatus::Complete,
        Vec::new(),
    );
    assert_eq!(snapshot.resident_private_total_bytes, u64::MAX);
    assert_eq!(snapshot.swapped_total_bytes, u64::MAX);
}

#[test]
fn smaps_rollup_parser_reads_pss_private_and_swap() {
    let text = "\
00400000-7fff0000 ---p 00000000 00:00 0                          [rollup]
Rss:              123456 kB
Pss:               98304 kB
Pss_Dirty:         90000 kB
Pss_Anon:          80000 kB
Shared_Clean:      20000 kB
Private_Clean:      4096 kB
Private_Dirty:     81920 kB
Swap:              12288 kB
SwapPss:            8192 kB
";
    let rollup = parse_smaps_rollup(text).expect("rollup parses");
    assert_eq!(rollup.pss, 98304 * 1024);
    assert_eq!(rollup.private_clean, 4096 * 1024);
    assert_eq!(rollup.private_dirty, 81920 * 1024);
    assert_eq!(rollup.swap_pss, 8192 * 1024);
}

#[test]
fn smaps_rollup_parser_requires_pss() {
    assert_eq!(
        parse_smaps_rollup("Rss: 10 kB\nPrivate_Dirty: 5 kB\n"),
        None
    );
    assert_eq!(parse_smaps_rollup(""), None);
}

#[test]
fn aggregate_compatibility_snapshot() {
    let snapshot = aggregate_snapshot(
        10,
        vec![process(1, 100, MemoryMetricKind::PrivateBytes)],
        AttributionStatus::Complete,
        Vec::new(),
    );
    assert_eq!(snapshot.measurement, EffectiveMeasurement::Compatibility);
}

#[test]
fn aggregate_mixed_snapshot() {
    let snapshot = aggregate_snapshot(
        10,
        vec![
            process(1, 100, MemoryMetricKind::PhysicalFootprint),
            process(2, 50, MemoryMetricKind::RssFallback),
        ],
        AttributionStatus::Partial,
        vec![9, 9, 8],
    );
    assert_eq!(snapshot.measurement, EffectiveMeasurement::Mixed);
    assert_eq!(snapshot.attribution, AttributionStatus::Partial);
    assert_eq!(snapshot.skipped_ambiguous_pids, vec![8, 9]);
}

#[test]
fn aggregate_rss_fallback_snapshot() {
    let snapshot = aggregate_snapshot(
        10,
        vec![
            process(1, 100, MemoryMetricKind::RssFallback),
            process(2, 50, MemoryMetricKind::RssFallback),
        ],
        AttributionStatus::Complete,
        Vec::new(),
    );
    assert_eq!(snapshot.measurement, EffectiveMeasurement::RssFallback);
}

#[test]
fn aggregate_empty_snapshot_is_unavailable() {
    let snapshot = aggregate_snapshot(10, Vec::new(), AttributionStatus::Partial, vec![7]);
    assert_eq!(snapshot.measurement, EffectiveMeasurement::Unavailable);
    assert_eq!(snapshot.skipped_ambiguous_pids, vec![7]);
}

#[test]
fn aggregate_deduplicates_pid_and_saturates_totals() {
    let snapshot = aggregate_snapshot(
        10,
        vec![
            process(1, u64::MAX, MemoryMetricKind::RssFallback),
            process(1, 99, MemoryMetricKind::RssFallback),
            process(2, 1, MemoryMetricKind::RssFallback),
        ],
        AttributionStatus::Complete,
        Vec::new(),
    );
    assert_eq!(snapshot.processes.len(), 2);
    assert_eq!(snapshot.effective_total_bytes, u64::MAX);
}

#[test]
fn wire_contract_uses_explicit_snake_case_fields() {
    let snapshot = aggregate_snapshot(
        42,
        vec![process(1, 100, MemoryMetricKind::PhysicalFootprint)],
        AttributionStatus::Partial,
        vec![22],
    );
    let value = serde_json::to_value(snapshot).expect("snapshot serializes");
    assert_eq!(value["schema_version"], 2);
    assert_eq!(value["measurement"], "native");
    assert_eq!(value["attribution"], "partial");
    assert_eq!(value["processes"][0]["metric_kind"], "physical_footprint");
    assert_eq!(value["processes"][0]["breakdown_kind"], "vm_region_walk");
    assert_eq!(value["processes"][0]["resident_private_bytes"], 50);
    assert_eq!(value["processes"][0]["swapped_bytes"], 50);
    assert_eq!(value["processes"][0]["peak_effective_memory_bytes"], 200);
    assert_eq!(value["resident_private_total_bytes"], 50);
    assert_eq!(value["swapped_total_bytes"], 50);
    assert!(value["processes"][0].get("memory_mb").is_none());
}

#[test]
fn wire_contract_serializes_missing_peak_as_null() {
    let mut no_peak = process(1, 100, MemoryMetricKind::Pss);
    no_peak.peak_effective_memory_bytes = None;
    let value = serde_json::to_value(no_peak).expect("process serializes");
    assert!(value["peak_effective_memory_bytes"].is_null());
    assert_eq!(value["metric_kind"], "pss");
}

#[cfg(target_os = "macos")]
fn macos_webkit_descriptor(pid: u32, name: &str) -> ProcessDescriptor {
    ProcessDescriptor {
            pid,
            parent_pid: Some(1),
            start_time_secs: u64::from(pid),
            name: name.to_string(),
            executable: Some(format!(
                "/System/Library/Frameworks/WebKit.framework/XPCServices/{name}.xpc/Contents/MacOS/{name}"
            )),
            rss_bytes: 1,
            virtual_memory_bytes: 1,
            belongs_to_current_user: true,
        }
}

#[cfg(target_os = "macos")]
#[test]
fn macos_webkit_candidate_requires_current_user_and_system_xpc_path() {
    let trusted = macos_webkit_descriptor(4_000_001, "com.apple.WebKit.WebContent");
    assert!(is_trusted_macos_webkit_candidate(&trusted));

    let mut wrong_executable = trusted.clone();
    wrong_executable.executable = Some("/Applications/Safari.app/WebContent".to_string());
    assert!(!is_trusted_macos_webkit_candidate(&wrong_executable));

    let mut wrong_user = trusted;
    wrong_user.belongs_to_current_user = false;
    assert!(!is_trusted_macos_webkit_candidate(&wrong_user));
}

#[cfg(target_os = "macos")]
#[test]
fn macos_service_ownership_excludes_unlisted_webkit_processes() {
    let owned_renderer = macos_webkit_descriptor(4_000_001, "com.apple.WebKit.WebContent");
    let other_app_renderer = macos_webkit_descriptor(4_000_002, "com.apple.WebKit.WebContent");
    let inventory = vec![owned_renderer, other_app_renderer];
    let service_roles = HashMap::from([(4_000_001, AppMemoryProcessRole::Renderer)]);

    let (owned, skipped, attribution) = resolve_macos_service_ownership(&inventory, service_roles);

    assert_eq!(owned.len(), 1);
    assert!(owned.keys().any(|key| key.pid == 4_000_001));
    assert!(!owned.keys().any(|key| key.pid == 4_000_002));
    assert!(skipped.is_empty());
    assert_eq!(attribution, AttributionStatus::Complete);
}

#[cfg(target_os = "macos")]
#[test]
fn macos_service_ownership_rejects_role_mismatch() {
    let inventory = vec![macos_webkit_descriptor(
        4_000_001,
        "com.apple.WebKit.WebContent",
    )];
    let service_roles = HashMap::from([(4_000_001, AppMemoryProcessRole::Gpu)]);

    let (owned, skipped, attribution) = resolve_macos_service_ownership(&inventory, service_roles);

    assert!(owned.is_empty());
    assert_eq!(skipped, vec![4_000_001]);
    assert_eq!(attribution, AttributionStatus::Partial);
}

#[cfg(target_os = "macos")]
#[test]
fn macos_current_process_has_physical_footprint() {
    let usage = macos_rusage(std::process::id()).expect("current process rusage");
    assert!(usage.ri_phys_footprint > 0);
    assert!(usage.ri_proc_start_abstime > 0);
    assert!(usage.ri_lifetime_max_phys_footprint >= usage.ri_phys_footprint);
}

#[cfg(target_os = "macos")]
#[test]
fn macos_region_walk_splits_current_process() {
    // Dirty a private allocation so the walk has something unambiguous to
    // find. Under memory pressure the kernel may compress these pages
    // immediately, so the invariant is "resident or swapped", never
    // "resident" alone.
    const PINNED: u64 = 32 * 1024 * 1024;
    let pinned = vec![7_u8; PINNED as usize];
    std::hint::black_box(&pinned);
    let breakdown = macos_region_breakdown(std::process::id());
    assert_eq!(breakdown.kind, MemoryBreakdownKind::VmRegionWalk);
    let private = breakdown
        .resident_private_bytes
        .saturating_add(breakdown.swapped_bytes);
    assert!(
        private >= PINNED,
        "private resident {} + swapped {} should cover the pinned 32 MiB",
        breakdown.resident_private_bytes,
        breakdown.swapped_bytes
    );
    assert!(
        breakdown.resident_shared_bytes > 0,
        "dyld cache must be shared-resident"
    );
    // A struct-layout mismatch would read addresses or sizes as page
    // counts and produce absurd totals; the real split stays in the same
    // order of magnitude as the kernel's own footprint ledger.
    let usage = macos_rusage(std::process::id()).expect("current process rusage");
    let ceiling = usage
        .ri_phys_footprint
        .saturating_mul(2)
        .saturating_add(64 * 1024 * 1024);
    assert!(
        private <= ceiling,
        "split {private} is implausibly larger than footprint {}",
        usage.ri_phys_footprint
    );
    drop(pinned);
}

/// Manual cross-check against a live process, e.g. a WebContent helper
/// owned by a running ORG2:
/// `ORG2_MEMORY_PROBE_PID=<pid> cargo test -p perf_utils probe_live -- --ignored --nocapture`
/// then compare with `/usr/bin/footprint -p <pid> --swapped --noCategories`.
#[cfg(target_os = "macos")]
#[test]
#[ignore]
fn macos_region_walk_probe_live_pid() {
    let pid: u32 = std::env::var("ORG2_MEMORY_PROBE_PID")
        .ok()
        .and_then(|value| value.parse().ok())
        .expect("set ORG2_MEMORY_PROBE_PID");
    let usage = macos_rusage(pid).expect("rusage for probe pid");
    let breakdown = macos_region_breakdown(pid);
    let mib = |bytes: u64| bytes as f64 / (1024.0 * 1024.0);
    println!(
            "pid {pid}: footprint {:.0} MiB (peak {:.0}) | resident private {:.0} MiB, shared {:.0} MiB, swapped {:.0} MiB [{:?}]",
            mib(usage.ri_phys_footprint),
            mib(usage.ri_lifetime_max_phys_footprint),
            mib(breakdown.resident_private_bytes),
            mib(breakdown.resident_shared_bytes),
            mib(breakdown.swapped_bytes),
            breakdown.kind
        );
    assert_eq!(breakdown.kind, MemoryBreakdownKind::VmRegionWalk);
}

#[cfg(target_os = "macos")]
#[test]
fn macos_region_walk_reports_unavailable_for_dead_pid() {
    // PID 0 is the kernel task; proc_pidinfo refuses it for user callers.
    assert_eq!(
        macos_region_breakdown(0).kind,
        MemoryBreakdownKind::Unavailable
    );
}

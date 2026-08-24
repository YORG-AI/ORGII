//! Stable schema-v2 wire types and internal process measurement records.

use serde::Serialize;

pub(super) const SNAPSHOT_SCHEMA_VERSION: u16 = 2;

/// The metric used as the effective-memory value for one process.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryMetricKind {
    /// macOS `ri_phys_footprint` — Activity Monitor's "Memory" column.
    PhysicalFootprint,
    /// Windows `PrivateWorkingSetSize` — Task Manager's "Memory" column.
    PrivateWorkingSet,
    /// Windows `PrivateUsage` (commit charge) when EX2 counters are unavailable.
    PrivateBytes,
    /// Linux proportional set size from `/proc/<pid>/smaps_rollup`.
    Pss,
    RssFallback,
}

/// How the resident / swapped split of one process was measured.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryBreakdownKind {
    /// macOS `proc_pidinfo(PROC_PIDREGIONINFO)` walk over the process VM map.
    VmRegionWalk,
    /// Linux `/proc/<pid>/smaps_rollup`.
    SmapsRollup,
    /// Windows working-set vs. private-commit counters.
    WorkingSetCommit,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct MemoryBreakdown {
    pub(super) resident_private_bytes: u64,
    pub(super) resident_shared_bytes: u64,
    pub(super) swapped_bytes: u64,
    pub(super) kind: MemoryBreakdownKind,
}

impl MemoryBreakdown {
    pub(super) const UNAVAILABLE: Self = Self {
        resident_private_bytes: 0,
        resident_shared_bytes: 0,
        swapped_bytes: 0,
        kind: MemoryBreakdownKind::Unavailable,
    };
}

/// Summary of how the effective total was measured.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EffectiveMeasurement {
    Native,
    Compatibility,
    Mixed,
    RssFallback,
    Unavailable,
}

/// Whether every relevant WebView helper could be safely attributed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AttributionStatus {
    Complete,
    Partial,
}

/// Product role of a process included in the top-level app total.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AppMemoryProcessRole {
    Backend,
    Renderer,
    Gpu,
    Network,
    Browser,
    Utility,
}

/// One process included in the ORG2 application-memory boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AppMemoryProcess {
    pub pid: u32,
    pub parent_pid: Option<u32>,
    pub process_instance_id: String,
    pub name: String,
    pub role: AppMemoryProcessRole,
    pub effective_memory_bytes: u64,
    pub metric_kind: MemoryMetricKind,
    pub rss_bytes: u64,
    pub resident_private_bytes: u64,
    pub resident_shared_bytes: u64,
    pub swapped_bytes: u64,
    pub breakdown_kind: MemoryBreakdownKind,
    pub peak_effective_memory_bytes: Option<u64>,
}

/// Atomic application-memory snapshot consumed by every frontend surface.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AppMemorySnapshot {
    pub schema_version: u16,
    pub captured_at_ms: u64,
    pub processes: Vec<AppMemoryProcess>,
    pub effective_total_bytes: u64,
    pub rss_mapped_total_bytes: u64,
    pub resident_private_total_bytes: u64,
    pub resident_shared_total_bytes: u64,
    pub swapped_total_bytes: u64,
    pub measurement: EffectiveMeasurement,
    pub attribution: AttributionStatus,
    pub skipped_ambiguous_pids: Vec<u32>,
}

impl AppMemorySnapshot {
    pub(super) fn unavailable(captured_at_ms: u64, attribution: AttributionStatus) -> Self {
        Self {
            schema_version: SNAPSHOT_SCHEMA_VERSION,
            captured_at_ms,
            processes: Vec::new(),
            effective_total_bytes: 0,
            rss_mapped_total_bytes: 0,
            resident_private_total_bytes: 0,
            resident_shared_total_bytes: 0,
            swapped_total_bytes: 0,
            measurement: EffectiveMeasurement::Unavailable,
            attribution,
            skipped_ambiguous_pids: Vec::new(),
        }
    }
}

/// Classification for a descendant shown only in Settings diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolProcessCategory {
    Terminal,
    AgentCli,
    McpOrTool,
}

/// RSS-only diagnostic for an owned tool process.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ToolProcessMemoryDiagnostic {
    pub pid: u32,
    pub parent_pid: Option<u32>,
    pub process_instance_id: String,
    pub name: String,
    pub category: ToolProcessCategory,
    pub rss_bytes: u64,
    pub virtual_memory_bytes: u64,
    pub depth: u32,
}

#[derive(Debug, Clone)]
pub(super) struct ProcessDescriptor {
    pub(super) pid: u32,
    pub(super) parent_pid: Option<u32>,
    pub(super) start_time_secs: u64,
    pub(super) name: String,
    #[cfg(target_os = "macos")]
    pub(super) executable: Option<String>,
    pub(super) rss_bytes: u64,
    pub(super) virtual_memory_bytes: u64,
    #[cfg(unix)]
    pub(super) belongs_to_current_user: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(super) struct ProcessInstanceKey {
    pub(super) pid: u32,
    pub(super) birth_token: u64,
}

impl ProcessInstanceKey {
    pub(super) fn wire_id(self) -> String {
        format!("{}:{}", self.pid, self.birth_token)
    }
}

#[derive(Debug, Clone, Copy)]
pub(super) struct EffectiveProcessMemory {
    pub(super) bytes: u64,
    pub(super) kind: MemoryMetricKind,
    pub(super) birth_token: u64,
    pub(super) breakdown: MemoryBreakdown,
    pub(super) peak_bytes: Option<u64>,
}

impl EffectiveProcessMemory {
    pub(super) fn rss_fallback(descriptor: &ProcessDescriptor, birth_token: u64) -> Self {
        Self {
            bytes: descriptor.rss_bytes,
            kind: MemoryMetricKind::RssFallback,
            birth_token,
            breakdown: MemoryBreakdown::UNAVAILABLE,
            peak_bytes: None,
        }
    }
}

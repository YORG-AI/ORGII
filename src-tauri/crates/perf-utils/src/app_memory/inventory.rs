//! Bounded process inventory cache and process-tree traversal.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(unix)]
use sysinfo::UpdateKind;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

pub(super) use super::types::ProcessDescriptor;

const INVENTORY_CACHE_TTL: Duration = Duration::from_millis(750);

#[derive(Debug)]
struct ProcessInventoryCache {
    system: System,
    captured_at: Option<Instant>,
    descriptors: Vec<ProcessDescriptor>,
}

impl ProcessInventoryCache {
    fn new() -> Self {
        Self {
            system: System::new(),
            captured_at: None,
            descriptors: Vec::new(),
        }
    }

    fn snapshot(&mut self, force: bool) -> Vec<ProcessDescriptor> {
        if !force
            && self
                .captured_at
                .is_some_and(|captured_at| captured_at.elapsed() < INVENTORY_CACHE_TTL)
        {
            return self.descriptors.clone();
        }

        let refresh_kind = ProcessRefreshKind::nothing().with_memory();
        #[cfg(target_os = "macos")]
        let refresh_kind = refresh_kind.with_exe(UpdateKind::OnlyIfNotSet);
        #[cfg(unix)]
        let refresh_kind = refresh_kind.with_user(UpdateKind::OnlyIfNotSet);
        self.system
            .refresh_processes_specifics(ProcessesToUpdate::All, true, refresh_kind);

        #[cfg(unix)]
        let current_uid = sysinfo::Uid::try_from(unsafe { libc::getuid() } as usize).ok();

        self.descriptors = self
            .system
            .processes()
            .values()
            .map(|process| ProcessDescriptor {
                pid: process.pid().as_u32(),
                parent_pid: process.parent().map(Pid::as_u32),
                start_time_secs: process.start_time(),
                name: process.name().to_string_lossy().to_string(),
                #[cfg(target_os = "macos")]
                executable: process.exe().map(|path| path.to_string_lossy().to_string()),
                rss_bytes: process.memory(),
                virtual_memory_bytes: process.virtual_memory(),
                #[cfg(unix)]
                belongs_to_current_user: current_uid
                    .as_ref()
                    .is_some_and(|uid| process.user_id() == Some(uid)),
            })
            .collect();
        self.captured_at = Some(Instant::now());
        self.descriptors.clone()
    }
}

static PROCESS_INVENTORY: OnceLock<Mutex<ProcessInventoryCache>> = OnceLock::new();

pub(super) fn collect_process_inventory(force: bool) -> Vec<ProcessDescriptor> {
    let cache = PROCESS_INVENTORY.get_or_init(|| Mutex::new(ProcessInventoryCache::new()));
    match cache.lock() {
        Ok(mut guard) => guard.snapshot(force),
        Err(error) => {
            tracing::warn!(%error, "app-memory process inventory mutex poisoned");
            Vec::new()
        }
    }
}

pub(super) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

pub(super) fn descendant_depth(
    pid: u32,
    root_pid: u32,
    inventory: &[ProcessDescriptor],
) -> Option<u32> {
    if pid == root_pid {
        return None;
    }
    let by_pid: HashMap<u32, &ProcessDescriptor> = inventory
        .iter()
        .map(|descriptor| (descriptor.pid, descriptor))
        .collect();
    let mut current = pid;
    let mut seen = HashSet::new();
    let mut depth = 0_u32;
    while seen.insert(current) {
        let descriptor = by_pid.get(&current)?;
        let parent = descriptor.parent_pid?;
        depth = depth.saturating_add(1);
        if parent == root_pid {
            return Some(depth);
        }
        current = parent;
    }
    None
}

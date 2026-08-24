//! macOS Activity Monitor parity and VM-region breakdowns.

use super::super::types::{
    EffectiveProcessMemory, MemoryBreakdown, MemoryBreakdownKind, MemoryMetricKind,
    ProcessDescriptor, ProcessInstanceKey,
};

/// Upper bound on VM regions walked per process. Real processes have a few
/// thousand regions; the bound only guards against a kernel that never
/// advances the cursor.
const MACOS_MAX_VM_REGIONS: usize = 200_000;

pub(super) fn macos_rusage(pid: u32) -> Option<libc::rusage_info_v4> {
    let mut usage = std::mem::MaybeUninit::<libc::rusage_info_v4>::zeroed();
    let result = unsafe {
        libc::proc_pid_rusage(
            pid as libc::c_int,
            libc::RUSAGE_INFO_V4,
            usage.as_mut_ptr().cast(),
        )
    };
    (result == 0).then(|| unsafe { usage.assume_init() })
}

/// `struct proc_regioninfo` from `<sys/proc_info.h>`.
#[repr(C)]
#[derive(Default, Clone, Copy)]
struct ProcRegionInfo {
    pri_protection: u32,
    pri_max_protection: u32,
    pri_inheritance: u32,
    pri_flags: u32,
    pri_offset: u64,
    pri_behavior: u32,
    pri_user_wired_count: u32,
    pri_user_tag: u32,
    pri_pages_resident: u32,
    pri_pages_shared_now_private: u32,
    pri_pages_swapped_out: u32,
    pri_pages_dirtied: u32,
    pri_ref_count: u32,
    pri_shadow_depth: u32,
    pri_share_mode: u32,
    pri_private_pages_resident: u32,
    pri_shared_pages_resident: u32,
    pri_obj_id: u32,
    pri_depth: u32,
    pri_address: u64,
    pri_size: u64,
}

const PROC_PIDREGIONINFO: libc::c_int = 7;
const SM_COW: u32 = 1;
const SM_PRIVATE: u32 = 2;
const SM_PRIVATE_ALIASED: u32 = 6;
const SM_LARGE_PAGE: u32 = 8;

/// Walk the VM map with the same bounded, unprivileged region query used by
/// the original app-memory implementation.
pub(super) fn macos_region_breakdown(pid: u32) -> MemoryBreakdown {
    let page_size = unsafe { libc::vm_page_size } as u64;
    let mut address: u64 = 0;
    let mut resident_pages: u64 = 0;
    let mut private_pages: u64 = 0;
    let mut swapped_pages: u64 = 0;
    let mut regions = 0_usize;
    loop {
        let mut info = ProcRegionInfo::default();
        let size = std::mem::size_of::<ProcRegionInfo>() as libc::c_int;
        let written = unsafe {
            libc::proc_pidinfo(
                pid as libc::c_int,
                PROC_PIDREGIONINFO,
                address,
                (&mut info as *mut ProcRegionInfo).cast(),
                size,
            )
        };
        if written != size {
            break;
        }
        regions += 1;
        resident_pages += u64::from(info.pri_pages_resident);
        private_pages += u64::from(info.pri_private_pages_resident);
        if matches!(
            info.pri_share_mode,
            SM_COW | SM_PRIVATE | SM_PRIVATE_ALIASED | SM_LARGE_PAGE
        ) {
            swapped_pages += u64::from(info.pri_pages_swapped_out);
        }
        let next = info.pri_address.saturating_add(info.pri_size);
        if next <= address || regions >= MACOS_MAX_VM_REGIONS {
            break;
        }
        address = next;
    }
    if regions == 0 {
        return MemoryBreakdown::UNAVAILABLE;
    }
    let resident_private_bytes = private_pages.saturating_mul(page_size);
    MemoryBreakdown {
        resident_private_bytes,
        resident_shared_bytes: resident_pages
            .saturating_sub(private_pages)
            .saturating_mul(page_size),
        swapped_bytes: swapped_pages.saturating_mul(page_size),
        kind: MemoryBreakdownKind::VmRegionWalk,
    }
}

pub(super) fn process_instance_key(descriptor: &ProcessDescriptor) -> ProcessInstanceKey {
    let birth_token = macos_rusage(descriptor.pid)
        .map(|usage| usage.ri_proc_start_abstime)
        .unwrap_or(descriptor.start_time_secs);
    ProcessInstanceKey {
        pid: descriptor.pid,
        birth_token,
    }
}

pub(super) fn collect_effective_memory(descriptor: &ProcessDescriptor) -> EffectiveProcessMemory {
    if let Some(usage) = macos_rusage(descriptor.pid) {
        EffectiveProcessMemory {
            bytes: usage.ri_phys_footprint,
            kind: MemoryMetricKind::PhysicalFootprint,
            birth_token: usage.ri_proc_start_abstime,
            breakdown: macos_region_breakdown(descriptor.pid),
            peak_bytes: (usage.ri_lifetime_max_phys_footprint > 0)
                .then_some(usage.ri_lifetime_max_phys_footprint),
        }
    } else {
        EffectiveProcessMemory::rss_fallback(descriptor, descriptor.start_time_secs)
    }
}

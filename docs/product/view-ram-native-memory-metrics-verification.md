# App memory metrics verification

Issue: [#435](https://github.com/yorgai/ORG2/issues/435)

## Product boundary

The top-level **App memory** value is the byte sum of:

1. the ORG2 backend process; and
2. WebView helper processes whose ownership can be established safely.

Terminal, CLI agent, MCP, tool, and other descendant processes are returned by
a separate RSS diagnostic command. They must never enter the App memory sum.

On macOS, an uncertain WebKit helper is excluded and the snapshot reports
`attribution: "partial"`. This intentionally prefers a possible undercount to
counting Safari or another application's helper.

## What the headline means (schema v2)

The headline `effective_memory_bytes` is deliberately **the number the
platform's own task manager shows**, so users can cross-check it:

| Platform | Headline (`metric_kind`)                                 | Task-manager column                |
| -------- | -------------------------------------------------------- | ---------------------------------- |
| macOS    | `proc_pid_rusage(RUSAGE_INFO_V4).ri_phys_footprint`      | Activity Monitor → "Memory"        |
| Windows  | `PROCESS_MEMORY_COUNTERS_EX2.PrivateWorkingSetSize`      | Task Manager → "Memory"            |
| Windows  | `PrivateUsage` when EX2 is unavailable (`compatibility`) | Process Explorer → "Private Bytes" |
| Linux    | `Pss` from `/proc/<pid>/smaps_rollup`                    | KDE System Monitor → "Memory"      |
| Any      | per-process RSS (`rss_fallback`)                         | —                                  |

That headline is **not** "RAM in use right now". On macOS, `phys_footprint`
counts pages held by the memory compressor or on-disk swap at their
_uncompressed_ size; on a machine under memory pressure the headline can be
2–3× the physically resident figure. Schema v2 therefore adds a split per
process and as snapshot totals:

| Field                         | macOS (`vm_region_walk`)                                       | Windows (`working_set_commit`)                | Linux (`smaps_rollup`)        |
| ----------------------------- | -------------------------------------------------------------- | --------------------------------------------- | ----------------------------- |
| `resident_private_bytes`      | Σ `pri_private_pages_resident` over `PROC_PIDREGIONINFO`       | `PrivateWorkingSetSize`                       | `Private_Clean+Private_Dirty` |
| `resident_shared_bytes`       | Σ `pri_pages_resident` − private                               | `WorkingSetSize` − private working set        | `Pss` − private               |
| `swapped_bytes`               | Σ `pri_pages_swapped_out` over private / copy-on-write regions | `PrivateUsage` − `PrivateWorkingSetSize`      | `SwapPss`                     |
| `peak_effective_memory_bytes` | `ri_lifetime_max_phys_footprint`                               | `PeakPagefileUsage` (private-bytes path only) | `null`                        |

`resident_private_total_bytes` is the physical RAM the app exclusively holds;
`swapped_total_bytes` is the part of the headline that is _not_ in RAM.
`resident_shared_total_bytes` is diagnostic only — shared pages are counted
once per process that maps them.

The macOS region walk uses `proc_pidinfo(PROC_PIDREGIONINFO)`, which is an
unprivileged same-user query (no task port) and therefore works against
Apple's hardened `com.apple.WebKit.*` XPC services. It is bounded by
`MACOS_MAX_VM_REGIONS` and reports `breakdown_kind: "unavailable"` when the
walk returns nothing.

`rss_mapped_total_bytes` is diagnostic metadata and is never substituted into
the top value without changing the snapshot's `measurement` field.

## macOS acceptance check

`/usr/bin/footprint` ships with the base OS (no Xcode Command Line Tools
required) and reports the same kernel ledger Activity Monitor uses. For every
PID in `get_app_memory_snapshot_v1.processes`:

```bash
/usr/bin/footprint -p <pid> [-p <pid> …] --json footprint.json --swapped --noCategories
```

Compare, from the same quiet app state and as close in time as possible:

1. Σ `processes[].auxiliary.phys_footprint` from the JSON versus
   `effective_total_bytes`. Passes when
   `absolute_difference <= max(footprint_sum * 0.10, 50 MiB)`.
2. `resident_private_total_bytes + swapped_total_bytes` versus the same
   footprint sum. Passes when the split never exceeds the headline; the
   remainder is graphics / IOKit / purgeable memory that has no resident or
   swapped page behind it (the WebKit GPU helper is mostly IOSurfaces, so its
   own split is legitimately small).

Do **not** compare `swapped_total_bytes` with `summary.total.swapped`: the
`--swapped` column counts every region including the shared dyld cache, while
`swapped_bytes` counts private / copy-on-write regions only so that it stays
consistent with `phys_footprint`, which likewise ignores shared-cache pages.
Measured on 2026-08-22 (ORG2 dev, 16 GB Mac with 8.7 GB swap in use):

| Process    | `footprint` | region walk | resident private | swapped |
| ---------- | ----------: | ----------: | ---------------: | ------: |
| WebContent |     675 MiB |     673 MiB |          106 MiB | 438 MiB |
| backend    |     119 MiB |     119 MiB |           15 MiB |  92 MiB |
| GPU        |      20 MiB |      20 MiB |            3 MiB |   3 MiB |

`footprint` takes ~0.3 s and several cores per call, which is why the app
polls the region walk instead of shelling out to it. A `partial` snapshot
remains valid only as an undercount: skipped ambiguous PIDs must not be added
to the comparison sum.

For an ad-hoc comparison against any live PID without the app:

```bash
ORG2_MEMORY_PROBE_PID=<pid> cargo test -p perf_utils probe_live -- --ignored --nocapture
```

To confirm ownership, `launchctl print pid/<backend pid>` must list exactly
the `com.apple.WebKit.{WebContent,GPU,Networking}.<uuid>` instances that
appear in `processes`; WebKit helpers of other apps on the machine must be
absent from the snapshot.

## Windows acceptance check

Compare each reported PID with Process Explorer or an equivalent native tool.
Newer systems should report Private Working Set. If EX2 is unavailable, the
snapshot must say `compatibility` and use Private Bytes. Any per-process query
failure must be visible as `mixed` or `rss_fallback`, never silently relabeled
as native.

## Linux acceptance check

For each reported PID, compare `effective_memory_bytes` with the `Pss:` line
of `/proc/<pid>/smaps_rollup` and `swapped_bytes` with `SwapPss:`. Because PSS
apportions shared pages, the sum across `WebKitWebProcess` instances must not
exceed the sum of their `Rss:` lines. On kernels without `smaps_rollup`
(< 4.14) the snapshot must report `rss_fallback`.

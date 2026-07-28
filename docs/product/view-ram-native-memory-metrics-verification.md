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

## Platform metrics

| Platform | Primary effective metric                            | Compatibility/fallback                              |
| -------- | --------------------------------------------------- | --------------------------------------------------- |
| macOS    | `proc_pid_rusage(RUSAGE_INFO_V2).ri_phys_footprint` | per-process RSS                                     |
| Windows  | `PROCESS_MEMORY_COUNTERS_EX2.PrivateWorkingSetSize` | Private Bytes, then per-process RSS                 |
| Other    | per-process RSS                                     | unavailable if the process inventory cannot be read |

`rss_mapped_total_bytes` is diagnostic metadata and is never substituted into
the top value without changing the snapshot's `measurement` field.

## macOS acceptance check

For every PID in `get_app_memory_snapshot_v1.processes`, collect its physical
footprint using `vmmap <pid> -summary`, then compare the sum with
`effective_total_bytes` from one snapshot.

The check passes when:

```text
absolute_difference <= max(vmmap_sum * 0.10, 50 MiB)
```

Use a quiet, stable app state and collect the snapshot and `vmmap` readings as
close together as possible. A `partial` snapshot remains valid only as an
undercount: skipped ambiguous PIDs must not be added to the comparison sum.

## Windows acceptance check

Compare each reported PID with Process Explorer or an equivalent native tool.
Newer systems should report Private Working Set. If EX2 is unavailable, the
snapshot must say `compatibility` and use Private Bytes. Any per-process query
failure must be visible as `mixed` or `rss_fallback`, never silently relabeled
as native.

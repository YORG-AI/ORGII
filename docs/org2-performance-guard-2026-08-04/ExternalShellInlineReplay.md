# External shell inline replay performance guard

## Lifecycle matrix

| Lifecycle / path | Behavior | Verdict |
| --- | --- | --- |
| Small completed external output | Build one bounded in-memory preview and attach a complete replay state to the event. | pass |
| Output above preview threshold | Preserve the existing `.slog` writer and SQLite replay metadata path. | pass |
| Running / replay-owned event | Preserve the existing early return; no new work occurs. | pass |
| Persistence failure on large output | Preserve the existing bounded incomplete-preview fallback and error. | pass |
| Repeated imported events | Each small event performs O(output bytes) copying bounded by `SHELL_REPLAY_PREVIEW_BYTES`; no background task or retained global state is added. | pass |

## Resource findings

| Area | Finding | Verdict | Reason / mitigation |
| --- | --- | --- | --- |
| CPU | Small output is concatenated once instead of framed and serialized through replay storage. | keep | Copy cost is bounded by the existing preview threshold. |
| Memory | The complete small output is retained in `terminal_preview`. | keep | The same bytes were already retained as a preview; size cannot exceed `SHELL_REPLAY_PREVIEW_BYTES`. |
| Filesystem / SQLite | Small output skips `.slog` creation and replay-table writes; large output is unchanged. | keep | The branch threshold exactly matches the maximum complete inline preview. |
| Compatibility | The event still exposes a complete `ShellReplayState`, with zero readable range bytes indicating no backing artifact. | keep | Range consumers use `terminal_preview` for the complete bounded output; the large-output paging contract is unchanged. |
| Cleanup | No new files, rows, timers, workers, or global caches are created. | keep | Nothing new survives beyond the event state. |

## Verdict

**Pass for boundedness and lifecycle.** Unit coverage proves the small path creates
neither a replay row nor a backing replay artifact. No real-device I/O benchmark
was run, so the PR claims removal of redundant writes for the bounded path, not a
measured end-to-end speedup.

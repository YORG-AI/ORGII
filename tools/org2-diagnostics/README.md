# ORG2 standalone diagnostics

A developer CLI for process audits and memory troubleshooting on macOS and
Linux. It does not import ORG2 frontend code, register Tauri commands, or run
inside the production app. Windows process sampling is not currently supported.

## Quick start

Run these commands from the repository root. Start ORG2, then check for zombie
or adopted processes associated with the workspace or the app's process tree:

```bash
pnpm diag:process
```

If several ORG2 instances are running, select the root process explicitly:

```bash
pnpm diag:process --pid 12345
```

Start a foreground memory recording:

```bash
pnpm diag:memory record --pid auto
```

By default, the recorder samples every 15 seconds and stops after 720 samples.
Each sample retains details for at most 256 processes, while total RSS includes
all attributed processes. From another terminal, mark a workflow stage and stop
the recording:

```bash
pnpm diag:memory mark "Opened and closed 20 sessions"
pnpm diag:memory stop
```

You can also stop with `Ctrl-C`. Check the recording status or regenerate the
latest session's report:

```bash
pnpm diag:memory status
pnpm diag:memory report
```

Set explicit sampling bounds when needed:

```bash
pnpm diag:memory record --interval 5 --duration 300 --max-samples 120
```

The `pnpm diag:*` commands are unchanged. For direct CLI invocation and tests:

```bash
node tools/org2-diagnostics/cli.mjs --help
pnpm diag:test
```

## Artifacts and measurement limits

Artifacts default to the Git-ignored, workspace-local directory
`.orgii/diagnostics/sessions/<session-id>/`:

- `session.json`: root process identity, sampling configuration, and stop reason.
- `samples.ndjson`: raw samples appended directly to disk without accumulating them in memory.
- `markers/`: workflow stage markers.
- `report.json`: the complete machine-readable report.
- `samples.csv`: one row per process per sample, suitable for plotting.
- `summary.md`: trends, peaks, and workflow markers in English.

The legacy `.orgii/diagnostics` storage path is retained so existing recordings
and active-session ownership remain accessible without a migration. Root
process detection also continues to recognize legacy `orgii` executable names.
User-provided marker labels are preserved in their original language.

The tool identifies each process instance by both PID and start time. Recording
stops if the root process exits or its PID is reused, so samples from a new
process cannot be appended to the old session.

On macOS and Linux, RSS, virtual memory, and CPU measurements come from `ps`.
On macOS, WebKit helpers are attributed through
`launchctl print pid/<host-pid>`, then checked against the host's user, the
system WebKit path, and the expected role. Summed RSS is useful for identifying
trends, but shared pages may be counted more than once. It cannot prove a memory
leak on its own.

Reported command lines are truncated to 300 characters and redact common
tokens, passwords, API keys, and URL credentials. Artifacts may still contain
local paths and process names. Review them before sharing externally.

## Lifecycle and failure handling

The recording lifecycle is `idle → recording → ready`. A stop request, duration
or sample limit, root process exit, or three consecutive sampling failures
triggers finalization and report generation.

If the recorder is forcibly terminated, its active state is considered stale.
The next `record` checks the recorder's PID and start time before taking
ownership. `mark` and `stop` reject stale sessions. An external `stop` only
writes a stop-request file for the current session; it does not signal the
recorder PID, avoiding the risk of terminating a different process after PID
reuse.

The tool never automatically terminates processes it discovers. Review
`diag:process` findings and use a process's own shutdown mechanism only after
confirming that it is no longer needed.

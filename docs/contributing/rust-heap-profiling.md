# Rust heap profiling with DHAT

ORGII includes an opt-in DHAT build for diagnosing allocations retained by the
Rust desktop backend. It is a developer tool, not a production feature and not
a replacement for the App memory/RSS monitor.

DHAT can impose extreme per-allocation overhead on the full ORGII GUI and may
make the Tauri window temporarily unresponsive. For normal interactive memory
investigations on macOS, prefer
[Instruments](./macos-memory-profiling.md). Reserve this DHAT path for short,
controlled Rust-backend scenarios where that slowdown is acceptable.

## Run a profile

From the repository root:

```bash
./scripts/dev/profile-rust-heap.sh
```

The script first builds the production frontend, then builds the `org2` desktop
binary with the optimized, symbolized `dhat` Cargo profile and enables the
`dhat-heap` feature. This keeps the measured Tauri/WebView path close to the
release application while preserving Rust allocation symbols.

After Tauri backend setup completes, DHAT waits 15 seconds before it starts.
Wait for the terminal's `[dhat] Rust heap profiling started` message, exercise
one controlled scenario, then quit ORGII normally. The final Tauri exit event
synchronously writes a timestamped JSON profile below
`${TMPDIR:-/tmp}/orgii-dhat-profiles/`, and the script prints the exact path. A
forced process kill cannot flush the profile.

On macOS, quit the application with `Cmd+Q`. The red window button only hides
the main window and does not end the profiling process.

Override the post-setup delay when a scenario needs more or less settling
time. Values from 0 through 3600 seconds are accepted:

```bash
ORGII_DHAT_START_DELAY_SECS=30 ./scripts/dev/profile-rust-heap.sh
```

To choose the output file explicitly:

```bash
ORGII_DHAT_OUTPUT=/absolute/path/session-switch.json \
  ./scripts/dev/profile-rust-heap.sh
```

For repeated profiling while `build/` is already current, skip the webpack
rebuild explicitly:

```bash
ORGII_DHAT_SKIP_FRONTEND_BUILD=true ./scripts/dev/profile-rust-heap.sh
```

The skip mode refuses to run unless `build/index.html` exists.

Open the JSON file in the
[DHAT viewer](https://nnethercote.github.io/dh_view/dh_view.html). Compare
`At t-gmax` for the peak and `At t-end` for allocations still live when the app
closed. Allocation call stacks are more useful than the headline byte count.

## Recommended scenario shape

1. Launch the app and wait for the terminal to confirm profiling has started.
2. Repeat one operation enough times to expose growth, such as opening and
   leaving replay-heavy sessions.
3. Return to an idle screen and wait for configured eviction grace periods.
4. Quit the app normally with `Cmd+Q` so the final Tauri exit event writes the profile. The red window button only hides the app on macOS.
5. Repeat with the same workload after a proposed fix and compare call stacks,
   peak bytes, and end-of-run live bytes.

DHAT starts once, after backend setup plus the configured settling delay.
Startup allocations before that point are intentionally excluded so allocation
backtrace collection cannot stall the initial WebView render. Before profiling
starts, the feature-gated allocator delegates directly to the system allocator
without entering DHAT's tracking lock. Use repeated before/after scenarios
instead of treating the final total as a standalone pass/fail number.

## Scope and limitations

DHAT replaces the Rust process-wide global allocator only when the
`dhat-heap` feature is enabled. Default development and release builds retain
their normal allocator and do not link the optional `dhat` dependency.

DHAT measures allocations made through the Rust allocator in the main ORGII
backend process. It does not attribute:

- JavaScript objects, DOM nodes, Jotai atoms, or WebView caches;
- xterm/WebGL/GPU memory;
- terminal, CLI-agent, MCP, or other child processes;
- memory-mapped files, kernel/file caches, or the complete process RSS.

Use WebKit/Chromium DevTools heap snapshots for the WebView object graph and
the built-in App memory snapshot for whole-process and owned-helper trends.

## Manual Cargo invocation

After `pnpm run build`, the equivalent backend command is:

```bash
ORGII_DHAT_OUTPUT=/absolute/path/dhat-heap.json \
  cargo run --manifest-path src-tauri/Cargo.toml \
  --profile dhat --features dhat-heap --bin org2
```

Do not add `dhat-heap` to default features or production build scripts. The
profiling allocator intentionally adds substantial runtime and memory overhead.

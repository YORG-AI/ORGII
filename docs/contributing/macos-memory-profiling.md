# macOS memory profiling with Instruments

Use macOS Instruments for interactive ORGII memory investigations. Unlike the
opt-in DHAT allocator, Instruments can attach to a normally running app without
capturing a Rust backtrace under a global lock for every allocation.

For a quick, zero-profiler-overhead comparison, click the gauge button in the
ORGII navigation sidebar. Its panel separates the native backend, WebView
helpers, file cache, terminal buffers, and other runtime estimates. Record the
values before the workload, after repeating it, and again after returning to
idle. Use Instruments when that comparison points to persistent native-backend
growth that needs allocation call stacks.

## Record native allocations

1. Start ORGII normally and wait for the main window to become usable.
2. From the repository root, run:

   ```bash
   ./scripts/dev/profile-macos-memory.sh
   ```

3. Exercise one controlled workload during the two-minute recording.
4. Let the recording finish. ORGII remains open, and the script prints the
   generated `.trace` path.
5. Open the trace using the printed command, then inspect persistent bytes,
   allocation growth, and responsible call trees.

The default `Allocations` recording is limited to two minutes and attaches only
to the native `org2` process. Override the limit when necessary:

```bash
./scripts/dev/profile-macos-memory.sh --duration 5m
```

If multiple ORGII instances are running, select the intended backend explicitly:

```bash
./scripts/dev/profile-macos-memory.sh --pid 12345
```

Run the `Leaks` template for a bounded native leak scan:

```bash
./scripts/dev/profile-macos-memory.sh --template Leaks --duration 2m
```

The first recording may cause macOS to request Developer Tools permission. If
attachment is denied, enable the terminal under **System Settings → Privacy &
Security → Developer Tools**, restart the terminal, and retry.

## What the trace covers

Attaching to `org2` covers native allocations in the Tauri/Rust backend and
native frameworks loaded into that process. It does not provide the JavaScript
object-retainer graph inside the WebKit WebContent helper. Use Web Inspector
heap snapshots for JavaScript/DOM leaks, and use the built-in App memory
snapshot or Activity Monitor when comparing total backend plus helper RSS.

For comparable results, record the same duration and workload before and after
a change. Let the app return to idle before the recording ends so persistent
growth is easier to distinguish from temporary peaks.

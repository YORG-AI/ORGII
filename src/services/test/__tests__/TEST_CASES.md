# Test Cases: TestService run lifecycle (run / stop / cancel)

## Preconditions

- A workspace with a detectable test framework (e.g. Vitest) is open.
- The Testing tab (`EditorPrimarySidebar → TestingTab`) is visible.
- Tauri backend is running (`test_runner` crate commands registered).

## Happy Path

| # | Steps | Expected Result |
|---|----|-----|
| 1 | Click "Run All Tests" | Run starts; toolbar toggles to "Stop Tests"; results stream in as tests finish |
| 2 | Let the run finish | Run state becomes `completed`; summary (passed/failed counts) shown; toolbar back to "Run All Tests" |
| 3 | Click "Run All Tests", then click "Stop Tests" mid-run | Test process tree terminates within ~1s; run state becomes `cancelled` (not `completed`); toolbar returns to "Run All Tests" |
| 4 | Run again after a stop | New run starts normally with a fresh run id |

## Edge Cases

| # | Scenario | Steps | Expected Result |
|---|----|----|-----|
| 1 | Stop with no run | Invoke the `TEST_STOP` action while idle | Action reports `success: false`, "No running test run to stop"; no state change |
| 2 | Stop races run completion | Stop right as the run finishes | Backend returns `false` (nothing to signal); run stays `completed`; no error surfaced |
| 3 | Huge test output | Suite logging tens of MB (or a single giant JSON line) | Run completes; memory bounded (16 MiB tail per stream); no hang even when stderr floods before stdout |
| 4 | Test process spawns children | Framework wrapper (npx → node → workers) | Stop kills the whole process tree, not just the wrapper (`ps` shows no orphaned workers) |
| 5 | Parallel runs (two windows) | Start runs in two windows, stop one | Only the stopped run reports `cancelled`; the other completes untouched |
| 6 | Rapid repeated stop clicks | Click Stop multiple times quickly | First click signals; later clicks are no-ops (`false`); no duplicate cancel events |

## Error / Degraded States

| # | Scenario | Steps | Expected Result |
|---|----|----|-----|
| 1 | Command fails with no parseable results | Break the test config, run | `error` event with the tail of stderr (bounded), run reports finished with 0 results |
| 2 | Spawn failure | Framework binary missing | Run promise rejects with "Failed to spawn test process"; error event emitted |
| 3 | Webview reload mid-run | Reload the app while tests run | Child process killed (kill_on_drop); registry entry removed (no leak) |

## Accessibility

- [ ] Run/Stop toolbar control keyboard-reachable (existing `IconButton` in TestingTab)
- [ ] Status changes reflected in the tree (existing status icons)

## Acceptance Criteria

- [ ] `stop()` resolves true only after the backend confirms an active run was signalled
- [ ] Cancelled runs end in `cancelled` state, never `completed`
- [ ] `run_started` events carry a real `runId` (camelCase wire format)
- [ ] A stopped run's process group is fully terminated (no orphaned test processes)
- [ ] Captured output per stream never exceeds the 16 MiB budget
- [ ] Stale parallel-run terminal events do not clobber the tracked run

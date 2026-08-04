# Turn Lifecycle, Queue, and Reload E2E

## Turn lifecycle and queue E2E

The turn lifecycle is controlled by a FSM in `src/engines/SessionCore/control/turnLifecycle.ts`. Key concepts for E2E:

- `turnPhase`: `"idle"` | `"dispatching"` | `"running"` | `"stopping"` — use `inspectChatState().turnPhase` to assert turn state precisely.
- `turnGeneration`: monotonically increasing counter; each new turn gets a new generation. Stale terminal signals from old turns are ignored.
- `runtimeStatus`: derived from FSM + provider signals. Use `waitForRuntimeIdle()` to wait for `runtimeStatus === "idle"` and `turnPhase === "idle"`.
- Queue tests must assert `queuedMessages` array contents, not just UI queue item count. Use `inspectChatState().queuedMessages`.
- After Stop, queued messages with `requiresExplicitDispatch=true` must not auto-flush. Assert queue retention before any follow-up send.

## CLI session reload

CLI sessions (claude-code, codex, cursor-cli, gemini-cli) reload history from SQLite via `cliAdapter.loadHistory` after a browser refresh. Key rules:

- After `cli_agent_truncate_after_chunk` (edit-resend / rewind), the product code calls `deleteCachedSession` and `evictSession` to ensure a clean reload. Tests that reload after rewind must wait for `chatEventCount > 0`, not just `activeSessionId` match.
- `reloadAndOpenActiveSession` retries `openSession` up to 3× with 3s gaps — CLI adapter settling after reload is a known race that does not affect real users (who wait for UI to render before clicking).
- Do not mark CLI reload as a product failure if `chatEventCount: 0` appears only after a programmatic `browser.refresh()` + immediate `openSession`. Verify with multiple runs before treating as a stable product bug.

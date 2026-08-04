# Orchestration, File Change, and Streaming Regressions

## Result-driven orchestration regressions

Rendered orchestration tests must start from the final user result and durable end-state, not from implementation breadcrumbs. A test that creates rows/cards but would still pass when a run stops with incomplete work is a false positive.

For Agent Org / multi-member / queue scenarios, every complex spec should state or encode:

- Final user outcome: what the org/team should have achieved.
- Final DB invariants: run status converged; all completed tasks are actually completed; open work is visibly blocked/abandoned; no `in_progress` task lacks an owner.
- Final UI evidence: resident member sessions are visible and switchable in the left sidebar, member transcripts open, and task board status does not contradict run/session state.
- Runtime path evidence: production launch, task tools, member wake/drain, inbox delivery, and member-session messaging paths ran; debug helpers only seed or inspect.
- Anti-false-positive checks: scenario-named tasks, passive inbox rows, synthetic cards, or a second corrective prompt do not count as success.
- Latest-session evidence: after a user reports a stuck or contradictory Agent Org run, inspect the newest run/session/task/inbox durable state and the latest terminal/app log before claiming the fix is verified. Do not infer success from an older green scenario or from a different synthetic run.

A Rust runtime E2E that posts protocol messages or calls debug endpoints is not proof that Agent Org works in the app. Rendered Agent Org acceptance must drive the production launch path from the UI, wait for production wake/drain/member-session turns, and then assert both UI and durable DB finality. Unit tests and Rust E2E can pin regressions, but they cannot be used as the sole evidence for “Agent Org advances correctly.”

Minimum failure cases that a valid orchestration spec must catch:

- A `running` run with no active member session and no unread inbox work to wake/drain (stalled run).
- `status = "in_progress"` with `owner = null` (ownerless work persisted).
- A `completed` run that still has `pending` or `in_progress` tasks.
- A run that appears visually populated but cannot make forward progress without a corrective second prompt.

<details>
<summary>Agent Org-specific failure cases</summary>

- A `running` run with `pending` / `in_progress` tasks, no active member session, and no unread inbox work to wake/drain.
- A ready assigned `pending` task whose dependencies are all completed, but whose owner has no unread `TaskAssigned` inbox row and no active member turn.
- Unread org inbox rows that remain unread after the owner/member production session has gone idle/completed a turn.
- `status = "in_progress"` with `owner = null`, or `status = "in_progress"` set by the coordinator for another member rather than by the owning member's claim/drain path.
- A `completed` run that still has `pending` or `in_progress` tasks.
- Member sessions visible in the coordinator overview but absent from the left sidebar.
- Multiple org members sharing the same `agent_id` / `agent_definition_id` while inbox delivery, wake, drain, task owner, and task-tool authorization are only keyed by `agent_id`.
- A run that appears visually populated but cannot make forward progress from the original user prompt without a corrective second prompt.

</details>

## File changes panel and diff view

The inline file-review panel was removed in `fbf20c78`. The composer "files pill" now opens Agent Station Diff view instead of expanding an inline card. Tests that assert file-change review must account for this:

- The files pill (`data-testid="composer-section-files"`) click calls `openAgentStationDiff`, which sets `chatPanelMaximized=false`, `stationMode="agent-station"`, `simulatorSelectedAppAtom=AppType.DIFF`, and `replayModeAtom="replay"`.
- **`chatPanelMaximized` must be false** before `ActivitySimulator` (and thus `SimulatorWorkstationTabHeader`) renders. If the chat panel is maximized, the diff view pane is suppressed and its buttons are invisible.
- Undo All button: `data-testid="file-changes-undo-all"` in `SimulatorWorkstationTabHeader` (rendered only when `pendingCount > 0`).
- Redo All button: `data-testid="file-changes-redo-all"` in `SimulatorWorkstationTabHeader` (rendered only when `redoSnapshotAnchors.length > 0`).
- The E2E helper `__e2e.openAgentStationDiff()` sets the same atoms as the product pill callback and is available as a fallback when Tauri WebDriver `element.click()` misses React synthetic events. Use `invokeE2E("openAgentStationDiff")` after failed pill-click retries.
- `waitForFileChangesPanel` in `agentQueuedWorkspaceHelpers.mjs` encapsulates this logic: it retries pill click 3×, then falls back to `invokeE2E("openAgentStationDiff")`, then waits for `[data-testid="file-changes-undo-all"]` or `[data-testid="replay-tab-diff-filter"]` to appear.
- For plan-build-direct, always call `waitForRuntimeIdle()` before `waitForFileChangesPanel()` — the Undo All button only activates after the build turn is fully idle.

## Plan, rewind, and streaming regressions

Rendered plan tests must pin the caller path, not only derived UI helpers:

- Rewind/edit-resend must invalidate stale queued turns and cancel the active turn before sending the replacement message.
- Plan update/edit-resend tests must assert no duplicate pending/drafting cards, only the latest plan is buildable, and stale revisions remain visible only as archived history when appropriate.
- Plan card diagnostics must distinguish surfaces by `data-plan-surface`: `transcript` cards in chat history, `current` cards in the pending review bar, and communication-side preview cards.
- Stop/Send button E2E clicks must be atomic with the expected `data-state`.
- Long-running debug HTTP endpoints must be called from the WDIO Node process, not through `browser.executeAsyncScript(fetch(...))`.
- Streaming marker assertions must wait for the full expected marker, not only for assistant text to become non-empty or change.

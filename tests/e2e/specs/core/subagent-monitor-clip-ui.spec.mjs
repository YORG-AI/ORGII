/* global describe, before, after, it, browser, expect */
/**
 * Subagent monitor clip-model UI spec.
 *
 * Regression coverage for "Monitoring the progress of 16 subagents" cell
 * accumulation: terminal child sessions (completed/cancelled) must close
 * their clip and RETIRE from the monitor strip once the replay cursor
 * passes their end, while open (running) clips stay visible.
 *
 * Wire path under test:
 *   debug_seed_child_session (production upsert_session)
 *     → es_get_child_sessions (backend-authoritative isTerminal/endedAt)
 *     → useSubagentSessions → useActiveSubagentsAtCursor
 *     → SubagentPipCard strip + "Monitoring N" header
 *
 * Only the seeding is debug-assisted; discovery, clip-window math, cursor
 * filtering, and rendering are all live production code.
 */
import {
  execJS,
  invokeE2E,
  unwrap,
  waitForApp,
} from "../../support/core/session/agentQueuedFollowupDriver.mjs";

const RENDER_TIMEOUT_MS = 20_000;
const RUN_ID = Date.now();
const PARENT_SESSION_ID = `sdeagent-e2e-subagent-monitor-${RUN_ID}`;

// Recent timestamps (fixed offsets from now) so the 24h zombie-row fuse
// never interferes with the running fixture.
const BASE_MS = Date.now() - 30 * 60 * 1000;
const atOffset = (minutes) =>
  new Date(BASE_MS + minutes * 60_000).toISOString();

const EARLY_EVENT_ID = `${PARENT_SESSION_ID}-early`;
const MID_EVENT_ID = `${PARENT_SESSION_ID}-mid`;
const LATE_EVENT_ID = `${PARENT_SESSION_ID}-late`;

// Unique rendered markers (cell subtitle = task portion of the DB name).
const DONE_TASK = `ClipAlphaDone${RUN_ID}`;
const CANCELLED_TASK = `ClipBravoCancelled${RUN_ID}`;
const RUNNING_TASK = `ClipCharlieRunning${RUN_ID}`;

const CHILDREN = [
  {
    sessionId: `agent-builtin:explore-e2e-done-${RUN_ID}`,
    name: `Explore (${DONE_TASK})`,
    status: "completed",
    createdAt: atOffset(2),
    updatedAt: atOffset(8),
  },
  {
    // THE regression fixture: pre-fix, "cancelled" fell into the frontend
    // pending bucket → clip never closed → cell stacked forever.
    sessionId: `agent-builtin:explore-e2e-cancelled-${RUN_ID}`,
    name: `Explore (${CANCELLED_TASK})`,
    status: "cancelled",
    createdAt: atOffset(2),
    updatedAt: atOffset(8),
  },
  {
    sessionId: `agent-builtin:general-e2e-running-${RUN_ID}`,
    name: `General (${RUNNING_TASK})`,
    status: "running",
    createdAt: atOffset(2),
    updatedAt: new Date().toISOString(),
  },
];

function makeParentEvent(id, createdAt, message) {
  return {
    id,
    chunk_id: id,
    sessionId: PARENT_SESSION_ID,
    createdAt,
    functionName: "list_dir",
    uiCanonical: "list_dir",
    actionType: "tool_call",
    args: { path: "/repo" },
    result: { output: `[file] ${message}` },
    source: "assistant",
    displayText: `List /repo (${message})`,
    displayStatus: "completed",
    displayVariant: "tool_call",
    activityStatus: "agent",
    isDelta: false,
  };
}

const PARENT_EVENTS = [
  {
    id: `${PARENT_SESSION_ID}-user`,
    chunk_id: `${PARENT_SESSION_ID}-user`,
    sessionId: PARENT_SESSION_ID,
    createdAt: atOffset(0),
    functionName: "user_message",
    uiCanonical: "user_message",
    actionType: "raw",
    args: {},
    result: { type: "user", message: "Audit the repo", is_delta: false },
    source: "user",
    displayText: "Audit the repo",
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "processed",
    isDelta: false,
  },
  makeParentEvent(EARLY_EVENT_ID, atOffset(1), "early"),
  makeParentEvent(MID_EVENT_ID, atOffset(5), "mid"),
  makeParentEvent(LATE_EVENT_ID, atOffset(20), "late"),
];

async function seedParentAtCursor(currentEventId) {
  unwrap(
    await invokeE2E("seedChatEvents", PARENT_SESSION_ID, PARENT_EVENTS, {
      chatPanelMaximized: false,
      chatWidth: 460,
      currentEventId,
      stationMode: "agent-station",
    }),
    `seedChatEvents cursor=${currentEventId}`
  );
}

async function monitorSnapshot() {
  return execJS(`
    const body = document.body.innerText || '';
    const monitorCountMatch = body.match(/Monitoring the progress of (\\d+) subagents|正在监控 (\\d+) 个 Subagent 的进度/);
    return {
      hasDone: body.includes(${JSON.stringify(DONE_TASK)}),
      hasCancelled: body.includes(${JSON.stringify(CANCELLED_TASK)}),
      hasRunning: body.includes(${JSON.stringify(RUNNING_TASK)}),
      monitorCount: monitorCountMatch
        ? Number(monitorCountMatch[1] ?? monitorCountMatch[2])
        : null,
      bodyText: body.slice(0, 6000),
    };
  `);
}

async function waitForMonitor(assertion, label) {
  await browser.waitUntil(async () => assertion(await monitorSnapshot()), {
    timeout: RENDER_TIMEOUT_MS,
    interval: 400,
    timeoutMsg: `${label}: ${JSON.stringify(await monitorSnapshot()).slice(0, 1500)}`,
  });
}

describe("Subagent monitor clip-model UI", () => {
  before(async () => {
    await waitForApp();
    unwrap(
      await invokeE2E("navigateTo", "/orgii/workstation/code"),
      "navigateTo workstation code"
    );
    unwrap(await invokeE2E("resetToNewSession"), "resetToNewSession");

    for (const child of CHILDREN) {
      unwrap(
        await invokeE2E("debugSeedChildSessionWire", {
          parentSessionId: PARENT_SESSION_ID,
          ...child,
        }),
        `seed child ${child.sessionId}`
      );
    }
  });

  after(async () => {
    for (const child of CHILDREN) {
      await invokeE2E("deleteSessionWire", child.sessionId);
    }
    await invokeE2E("deleteSessionWire", PARENT_SESSION_ID);
  });

  it("shows all clips whose window covers the cursor (terminal clips included in-window)", async () => {
    await seedParentAtCursor(MID_EVENT_ID);
    // The strip paginates at 2 cells per page, so assert the rendered
    // first-page cells PLUS the header count covering all three clips
    // (done + cancelled terminal clips still in-window, plus running).
    await waitForMonitor(
      (snap) => snap.hasDone && snap.hasCancelled && snap.monitorCount === 3,
      "in-window cursor should render terminal cells and count 3 monitored clips"
    );
  });

  it("retires terminal clips once the cursor passes their end; open clips survive", async () => {
    await seedParentAtCursor(LATE_EVENT_ID);

    await waitForMonitor(
      (snap) => snap.hasRunning && !snap.hasDone && !snap.hasCancelled,
      "late cursor should retire completed AND cancelled cells but keep the running cell"
    );

    // Ghost-cell negative (the 16-stack regression): the cancelled clip
    // must NOT linger after its window.
    const snap = await monitorSnapshot();
    expect(snap.hasCancelled).toBe(false);
    expect(snap.hasDone).toBe(false);
    expect(snap.hasRunning).toBe(true);
  });

  it("hides clips entirely before their start", async () => {
    await seedParentAtCursor(EARLY_EVENT_ID);

    // Cursor at +1min is before every clip's start (+2min). Cursor-filter
    // yields nothing, so the open-clips fallback keeps ONLY the running
    // clip visible — closed clips must not resurface through the fallback.
    await waitForMonitor(
      (snap) => snap.hasRunning && !snap.hasDone && !snap.hasCancelled,
      "pre-start cursor must show only open clips via fallback"
    );
  });
});

/* global describe, before, after, it, browser, expect */
/**
 * Subagent navigate-arrow "revive retired cell" UI spec.
 *
 * Regression coverage for: clicking the top-right navigate arrow on a
 * SubagentBlock in the chat transcript did NOTHING once the subagent had
 * finished and the main replay cursor sat past the clip's end. The arrow's
 * handler only wrote `focusedSubagentCellAtom` + `subagentPanelRevealRequestAtom`,
 * but a terminal subagent whose window no longer covers the cursor has already
 * RETIRED its monitor cell (clip model in useSubagentSessions) — so there was
 * no cell to focus and no panel to reveal. Net effect: "没反应".
 *
 * The fix folds a `navigateToEventAtom(props.eventId)` seek into the handler:
 * the main cursor jumps back to the subagent's delegate event (inside its
 * [startedAtMs, endedAtMs] window), `navigateToEventAndUpdateBar` flips
 * replayMode to "replay" (free-browse), the cursor-filtered clip
 * re-materialises, and only THEN do focus + reveal take effect.
 *
 * Pipeline under test (live production code; only seeding is debug):
 *   seedChatEvents(parent, cursor=LATE) + debugSeedChildSessionWire(terminal)
 *     → useSubagentSessions / useActiveSubagentsAtCursor (cursor past end →
 *        cell retired)
 *   click [data-tool-call-name="agent"] [data-testid="event-navigate"]
 *     → SubagentAdapter.handleNavigate
 *     → navigateToEventAtom(delegateEventId)  (cursor → inside clip window)
 *     → focusedSubagentCellAtom + subagentPanelRevealRequestAtom
 *     → SubagentPipCard renders the cell; IndependentGridCell isFocused
 *
 * Observable result is read from the MONITOR cell only (via the
 * `data-subagent-cell-thread-id` attribute that exists exclusively on the
 * IndependentGridCell container — never on the chat block), so the delegate
 * event's own task text in the chat transcript cannot create a false positive.
 *
 * Assertions:
 *   1. Cursor at LATE (past the terminal clip's end) → no monitor cell for the
 *      child. (Baseline: the broken state where clicking did nothing.)
 *   2. After clicking the chat navigate arrow → the monitor cell for the child
 *      re-materialises AND is focused (data-subagent-cell-focused="true").
 */
import {
  execJS,
  invokeE2E,
  unwrap,
  waitForApp,
} from "../../support/core/session/agentQueuedFollowupDriver.mjs";

const RENDER_TIMEOUT_MS = 20_000;
const RUN_ID = Date.now();
const PARENT_SESSION_ID = `sdeagent-e2e-subagent-navigate-${RUN_ID}`;
const CHILD_ID = `agent-builtin:explore-e2e-navrevive-${RUN_ID}`;

// Distinct strings so we can prove the assertion reads the MONITOR cell, not
// the chat block: the chat delegate block shows CHAT_LABEL; the monitor cell
// title/subtitle is derived from the child DB name (MONITOR_TASK).
const CHAT_LABEL = `ChatDelegateLabel${RUN_ID}`;
const MONITOR_TASK = `MonitorCellTask${RUN_ID}`;

// Recent timestamps (fixed offsets from now) so the 24h zombie-row fuse never
// closes the terminal clip early in a surprising way.
const BASE_MS = Date.now() - 30 * 60 * 1000;
const atOffset = (minutes) =>
  new Date(BASE_MS + minutes * 60_000).toISOString();

const DELEGATE_EVENT_ID = `${PARENT_SESSION_ID}-delegate`;
const LATE_EVENT_ID = `${PARENT_SESSION_ID}-late`;

function makeUserEvent(sessionId, createdAt, text) {
  return {
    id: `${sessionId}-user`,
    chunk_id: `${sessionId}-user`,
    sessionId,
    createdAt,
    functionName: "user_message",
    uiCanonical: "user_message",
    actionType: "raw",
    args: {},
    result: { type: "user", message: text, is_delta: false },
    source: "user",
    displayText: text,
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "processed",
    isDelta: false,
  };
}

// The parent's subagent tool_call. functionName "agent" + uiCanonical
// "subagent" route to SubagentAdapter; args.subagentSessionId makes the block
// render the navigate arrow (onNavigate is wired only when a child id exists).
function makeDelegateEvent(sessionId, createdAt, childSessionId, label) {
  return {
    id: DELEGATE_EVENT_ID,
    chunk_id: DELEGATE_EVENT_ID,
    sessionId,
    createdAt,
    functionName: "agent",
    uiCanonical: "subagent",
    actionType: "tool_call",
    args: {
      action: "delegate",
      subagentSessionId: childSessionId,
      description: label,
      prompt: "Audit the repo end to end.",
    },
    result: { content: `Spawned ${childSessionId}`, success: true },
    source: "assistant",
    displayText: "Assigned task to subagent",
    displayStatus: "completed",
    displayVariant: "tool_call",
    activityStatus: "processed",
    isDelta: false,
  };
}

// A late settled tool event — the parent kept working long after the subagent
// finished, so the default cursor (here) sits well past the clip's end.
function makeLateEvent(sessionId, createdAt) {
  return {
    id: LATE_EVENT_ID,
    chunk_id: LATE_EVENT_ID,
    sessionId,
    createdAt,
    functionName: "list_dir",
    uiCanonical: "list_dir",
    actionType: "explore",
    args: { path: "/repo" },
    result: { output: "[dir] src" },
    source: "assistant",
    displayText: "List /repo (late)",
    displayStatus: "completed",
    displayVariant: "tool_call",
    activityStatus: "processed",
    isDelta: false,
  };
}

const PARENT_EVENTS = [
  makeUserEvent(PARENT_SESSION_ID, atOffset(0), "Run the audit"),
  // Delegate clip window aligns with the child below: [2min, 8min].
  makeDelegateEvent(PARENT_SESSION_ID, atOffset(2), CHILD_ID, CHAT_LABEL),
  // Cursor parks here (+20min) — well past the child's endedAt (+8min).
  makeLateEvent(PARENT_SESSION_ID, atOffset(20)),
];

async function seedParentAtCursor(currentEventId, options = {}) {
  const { chatPanelMaximized = false } = options;
  unwrap(
    await invokeE2E("seedChatEvents", PARENT_SESSION_ID, PARENT_EVENTS, {
      chatPanelMaximized,
      chatWidth: 460,
      currentEventId,
      stationMode: "agent-station",
    }),
    `seedChatEvents cursor=${currentEventId}`
  );
}

async function cellSnapshot() {
  const [dom, chatState] = await Promise.all([
    execJS(`
      const childId = ${JSON.stringify(CHILD_ID)};
      const body = document.body.innerText || '';
      const cell = document.querySelector(
        '[data-subagent-cell-thread-id="' + childId + '"]'
      );
      const navBtn = document.querySelector(
        '[data-tool-call-name="agent"] [data-testid="event-navigate"]'
      );
      return {
        cellPresent: !!cell,
        cellFocused: cell
          ? cell.getAttribute('data-subagent-cell-focused') === 'true'
          : false,
        navBtnPresent: !!navBtn,
        monitorTaskInBody: body.includes(
          ${JSON.stringify(MONITOR_TASK)}
        ),
        hasMonitoringHeader: /Monitoring the progress of \\d+ subagents|正在监控 \\d+ 个 Subagent 的进度/.test(body),
      };
    `),
    invokeE2E("inspectChatState"),
  ]);
  const state = chatState?.ok === true ? chatState.value : chatState;
  return {
    ...dom,
    chatFocused: Boolean(state?.chatPanelMaximized),
  };
}

async function clickChatNavigate() {
  return execJS(`
    const navBtn = document.querySelector(
      '[data-tool-call-name="agent"] [data-testid="event-navigate"]'
    );
    if (!navBtn) return { clicked: false };
    navBtn.click();
    return { clicked: true };
  `);
}

async function waitForCell(assertion, label) {
  await browser.waitUntil(async () => assertion(await cellSnapshot()), {
    timeout: RENDER_TIMEOUT_MS,
    interval: 400,
    timeoutMsg: `${label}: ${JSON.stringify(await cellSnapshot()).slice(0, 1500)}`,
  });
}

describe("Subagent navigate-arrow revives a retired monitor cell", () => {
  before(async () => {
    await waitForApp();
    unwrap(
      await invokeE2E("navigateTo", "/orgii/workstation/code"),
      "navigateTo workstation code"
    );
    unwrap(await invokeE2E("resetToNewSession"), "resetToNewSession");

    // Terminal child clip: window [2min, 8min] (createdAt → updatedAt).
    unwrap(
      await invokeE2E("debugSeedChildSessionWire", {
        parentSessionId: PARENT_SESSION_ID,
        sessionId: CHILD_ID,
        name: `Explore (${MONITOR_TASK})`,
        status: "completed",
        createdAt: atOffset(2),
        updatedAt: atOffset(8),
      }),
      "seed terminal child"
    );

    await seedParentAtCursor(LATE_EVENT_ID);
  });

  after(async () => {
    await invokeE2E("deleteSessionWire", CHILD_ID);
    await invokeE2E("deleteSessionWire", PARENT_SESSION_ID);
  });

  it("starts with the terminal clip retired (cursor past its end) and the chat arrow present", async () => {
    // The navigate arrow must exist in the chat transcript (onNavigate wired
    // because the delegate event carries a subagentSessionId)...
    await waitForCell(
      (snap) => snap.navBtnPresent,
      "chat subagent block should expose the navigate arrow"
    );
    // ...while the monitor cell is RETIRED because the cursor (+20min) sits
    // past the clip's end (+8min). This is the exact broken state where the
    // old handler's focus/reveal writes had nothing to act on.
    const snap = await cellSnapshot();
    expect(snap.cellPresent).toBe(false);
    expect(snap.monitorTaskInBody).toBe(false);
  });

  it("clicking the arrow reveals the monitor cell from a Messages-focused transcript", async () => {
    await seedParentAtCursor(LATE_EVENT_ID, { chatPanelMaximized: true });

    await waitForCell(
      (snap) => snap.navBtnPresent && !snap.cellPresent,
      "baseline should hide the retired monitor cell while the chat arrow remains visible"
    );

    const click = await clickChatNavigate();
    expect(click.clicked).toBe(true);

    await waitForCell(
      (snap) =>
        snap.cellPresent && snap.cellFocused && snap.hasMonitoringHeader,
      "navigate click must reveal the monitor snapshot"
    );

    const snap = await cellSnapshot();
    expect(snap.cellPresent).toBe(true);
    expect(snap.cellFocused).toBe(true);
    expect(snap.hasMonitoringHeader).toBe(true);
  });
});

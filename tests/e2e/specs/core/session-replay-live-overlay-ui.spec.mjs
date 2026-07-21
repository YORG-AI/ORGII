import { Buffer } from "node:buffer";

import {
  execJS,
  invokeE2E,
  unwrap,
  waitForApp,
} from "../../support/core/session/agentQueuedFollowupDriver.mjs";

const RENDER_TIMEOUT_MS = 12_000;
const SESSION_ID = `e2e-session-replay-live-overlay-${Date.now()}`;
const EVENT_ID = `${SESSION_ID}-list-dir`;
const SHELL_CALL_ID = `${SESSION_ID}-shell-call`;
const SHELL_EVENT_ID = `${SESSION_ID}-shell`;
const SHELL_MID_EVENT_ID = `${SESSION_ID}-shell-mid`;
const SHELL_FINAL_EVENT_ID = `${SESSION_ID}-shell-final`;
const WORKSPACE_PATH = "/repo";

const EARLY_SENTINEL = "SHELL_REPLAY_EARLY_SENTINEL";
const MIDDLE_SENTINEL = "SHELL_REPLAY_MIDDLE_SENTINEL";
const FINAL_SENTINEL = "SHELL_REPLAY_FINAL_SENTINEL";

function makeUserEvent(createdAt) {
  return {
    id: `${SESSION_ID}-user`,
    chunk_id: `${SESSION_ID}-user`,
    sessionId: SESSION_ID,
    createdAt,
    functionName: "user_message",
    uiCanonical: "user_message",
    actionType: "raw",
    args: {},
    result: {
      type: "user",
      message: "List the fixture directory",
      is_delta: false,
    },
    source: "user",
    displayText: "List the fixture directory",
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "processed",
    isDelta: false,
  };
}

function makeListDirEvent(createdAt, overrides = {}) {
  return {
    id: EVENT_ID,
    chunk_id: EVENT_ID,
    sessionId: SESSION_ID,
    createdAt,
    functionName: "list_dir",
    uiCanonical: "list_dir",
    actionType: "tool_call",
    args: { path: WORKSPACE_PATH },
    result: {},
    source: "assistant",
    displayText: `List ${WORKSPACE_PATH}`,
    displayStatus: "running",
    displayVariant: "tool_call",
    activityStatus: "agent",
    isDelta: false,
    ...overrides,
  };
}

function shellReplayState(preview, sequence, status = "running", completedAt) {
  return {
    ref: {
      sessionId: SESSION_ID,
      callId: SHELL_CALL_ID,
      formatVersion: 1,
    },
    bookmark: {
      visibleThroughSequence: sequence,
      visibleBytes: Buffer.byteLength(preview, "utf8"),
    },
    terminalPreview: preview,
    status,
    ...(completedAt ? { completedAt } : {}),
  };
}

function makeShellReplayEvents(baseTime) {
  const earlyAt = new Date(baseTime + 1_000).toISOString();
  const middleAt = new Date(baseTime + 2_000).toISOString();
  const finalAt = new Date(baseTime + 3_000).toISOString();
  const early = shellReplayState(EARLY_SENTINEL, 1);
  const middle = shellReplayState(`${EARLY_SENTINEL}\n${MIDDLE_SENTINEL}`, 2);
  const final = shellReplayState(
    `${EARLY_SENTINEL}\n${MIDDLE_SENTINEL}\n${FINAL_SENTINEL}`,
    3,
    "complete",
    finalAt
  );

  const shell = {
    id: SHELL_EVENT_ID,
    chunk_id: SHELL_EVENT_ID,
    sessionId: SESSION_ID,
    createdAt: earlyAt,
    functionName: "run_shell",
    uiCanonical: "run_shell",
    actionType: "tool_call",
    args: { command: "printf replay-sentinels" },
    result: {},
    source: "assistant",
    displayText: "Run replay sentinel fixture",
    displayStatus: "completed",
    displayVariant: "tool_call",
    activityStatus: "processed",
    callId: SHELL_CALL_ID,
    isDelta: false,
    shellReplay: final,
    shellReplayBookmarks: { [SHELL_CALL_ID]: early },
  };

  const checkpoint = (id, createdAt, state, label) => ({
    id,
    chunk_id: id,
    sessionId: SESSION_ID,
    createdAt,
    // Keep the Code Editor on its Terminal surface without creating a
    // second shell operation: the checkpoint deliberately has no command.
    functionName: "run_shell",
    uiCanonical: "run_shell",
    actionType: "raw",
    args: {},
    result: {},
    source: "system",
    displayText: label,
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "processed",
    isDelta: false,
    shellReplayBookmarks: { [SHELL_CALL_ID]: state },
  });

  return [
    shell,
    checkpoint(
      SHELL_MID_EVENT_ID,
      middleAt,
      middle,
      "Shell replay middle checkpoint"
    ),
    checkpoint(
      SHELL_FINAL_EVENT_ID,
      finalAt,
      final,
      "Shell replay final checkpoint"
    ),
  ];
}

async function seed(events) {
  unwrap(
    await invokeE2E("seedChatEvents", SESSION_ID, events, {
      chatPanelMaximized: false,
      chatWidth: 460,
      currentEventId: EVENT_ID,
      selectedApp: "CODE_EDITOR",
      stationMode: "agent-station",
    }),
    "seedChatEvents"
  );
}

async function disablePaneTransitionsForReplayAssertions() {
  await execJS(`
    const styleId = 'e2e-session-replay-layout-stability';
    if (!document.getElementById(styleId)) {
      const style = document.createElement('style');
      style.id = styleId;
      style.textContent = [
        '[data-workbench-surface]',
        '[data-fullmode-chat-wrapper]'
      ].join(',') + ' { transition: none !important; }';
      document.head.appendChild(style);
    }
  `);
}

async function replayPanelSnapshot() {
  return execJS(`
    const candidates = Array.from(document.querySelectorAll(
      '.session-replay-ide, .ide-code-panel, .code-viewer-scroll-container'
    ));
    const isRendered = (node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' &&
        rect.width > 0 && rect.height > 0;
    };
    const replay = candidates.find(isRendered) || candidates[0] || null;
    const text = replay ? (replay.innerText || '') : '';
    const layoutNode = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return {
        selector,
        className: node.className,
        inlineStyle: node.getAttribute('style'),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        display: style.display,
        flexBasis: style.flexBasis,
        flexGrow: style.flexGrow,
        transitionDuration: style.transitionDuration,
        ariaHidden: node.getAttribute('aria-hidden'),
        chatFocus: node.getAttribute('data-chat-focus'),
      };
    };
    return {
      hasReplay: !!replay,
      text,
      viewport: { innerWidth: window.innerWidth, innerHeight: window.innerHeight },
      layout: [
        layoutNode('[data-main-content]'),
        layoutNode('[data-workbench-surface]'),
        layoutNode('[data-fullmode-chat-wrapper]'),
      ],
      candidates: candidates.map((node) => {
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return {
          className: node.className,
          rendered: isRendered(node),
          display: style.display,
          visibility: style.visibility,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          innerText: (node.innerText || '').slice(0, 1000),
          textContent: (node.textContent || '').slice(0, 1000),
        };
      }),
      bodyText: (document.body.innerText || '').slice(0, 5000),
      testIds: Array.from(document.querySelectorAll('[data-testid]'))
        .map((node) => node.getAttribute('data-testid'))
        .filter(Boolean)
        .slice(-120),
    };
  `);
}

async function waitForReplayText(assertion, label) {
  await browser.waitUntil(async () => assertion(await replayPanelSnapshot()), {
    timeout: RENDER_TIMEOUT_MS,
    interval: 250,
    timeoutMsg: `${label}: ${JSON.stringify(await replayPanelSnapshot())}`,
  });
}

async function freshEnabledElement(selector, label) {
  await browser.waitUntil(
    async () => {
      const element = await browser.$(selector);
      return (await element.isExisting()) && (await element.isEnabled());
    },
    {
      timeout: RENDER_TIMEOUT_MS,
      interval: 100,
      timeoutMsg: `${label} was missing or disabled`,
    }
  );
  return browser.$(selector);
}

async function clickReplayControl(controlName) {
  const testId = {
    previous: "session-replay-previous",
    playPause: "session-replay-play-pause",
    next: "session-replay-next",
  }[controlName];
  if (!testId) throw new Error(`unknown replay control: ${controlName}`);
  const control = await freshEnabledElement(
    `[data-testid="${testId}"]`,
    `${controlName} replay control`
  );
  await control.click();
}

async function waitForPlaybackState(isPlaying) {
  const iconClass = isPlaying ? "lucide-pause" : "lucide-play";
  await browser.waitUntil(
    async () => {
      const icon = await browser.$(
        `[data-testid="session-replay-play-pause"] svg.${iconClass}`
      );
      return icon.isExisting();
    },
    {
      timeout: RENDER_TIMEOUT_MS,
      interval: 100,
      timeoutMsg: `replay control did not render ${iconClass}`,
    }
  );
}

async function selectPlaybackSpeed(label) {
  const trigger = await freshEnabledElement(
    '[data-testid="session-replay-speed-trigger"]',
    "playback speed trigger"
  );
  await trigger.click();

  const speed = label.replace(/x$/, "");
  const option = await freshEnabledElement(
    `[data-testid="session-replay-speed-${speed}"]`,
    `${label} playback speed option`
  );
  await option.click();
}

async function dragReplayBarAt16ms(fractions) {
  const rail = await browser.$(".replay-progress-bar .slider-rail");
  if (!(await rail.isExisting())) {
    throw new Error("rendered replay progress rail was not found");
  }
  const rect = await browser.getElementRect(rail.elementId);
  const point = (fraction) => ({
    x: Math.round(rect.x + rect.width * fraction),
    y: Math.round(rect.y + rect.height / 2),
  });

  let action = browser
    .action("pointer")
    .move({ duration: 0, ...point(fractions[0]) })
    .down({ button: 0 });
  for (const fraction of fractions.slice(1)) {
    action = action.pause(16).move({ duration: 16, ...point(fraction) });
  }
  await action.up({ button: 0 }).perform();
}

describe("SessionReplay live operation overlay UI", () => {
  before(async () => {
    await waitForApp();
    // The production layout intentionally collapses Agent Station behind the
    // chat pane at narrow widths. This spec asserts rendered replay content,
    // so give the real Tauri window enough room instead of accidentally
    // reading textContent from a zero-width, non-rendered panel.
    await browser.setWindowSize(2400, 1200);
    unwrap(
      await invokeE2E("navigateTo", "/orgii/workstation/code"),
      "navigateTo workstation code"
    );
  });

  beforeEach(async () => {
    unwrap(
      await invokeE2E("navigateTo", "/orgii/workstation/code"),
      "navigateTo workstation code before reset"
    );
    unwrap(await invokeE2E("resetToNewSession"), "resetToNewSession");
    // WebKitWebDriver can leave flex-track transitions frozen while its
    // native window is occluded. This spec exercises Snapshot playback, not
    // pane animation, so remove only those two transitions during setup and
    // continue asserting rendered innerText and real pointer interactions.
    await disablePaneTransitionsForReplayAssertions();
  });

  it("hydrates an in-place list_dir event from running placeholder to completed results", async () => {
    const baseTime = Date.now();
    const userEvent = makeUserEvent(new Date(baseTime).toISOString());
    const runningEvent = makeListDirEvent(
      new Date(baseTime + 1_000).toISOString()
    );

    await seed([userEvent, runningEvent]);
    await waitForReplayText(
      (snapshot) =>
        snapshot.hasReplay &&
        !snapshot.text.includes("README.md") &&
        !snapshot.text.includes("src/"),
      "running list_dir replay panel did not render before hydration"
    );

    const completedEvent = makeListDirEvent(runningEvent.createdAt, {
      result: { output: "[dir] src/\n[file] README.md" },
      displayStatus: "completed",
      activityStatus: "agent",
    });

    await seed([userEvent, completedEvent]);
    await waitForReplayText(
      (snapshot) =>
        snapshot.hasReplay &&
        snapshot.text.includes("List directory") &&
        snapshot.text.includes("README.md") &&
        snapshot.text.includes("src/"),
      "completed list_dir replay panel did not hydrate rendered results"
    );

    const finalSnapshot = await replayPanelSnapshot();
    expect(finalSnapshot.text).toContain("README.md");
    expect(finalSnapshot.text).toContain("src/");
  });

  it("keeps Snapshot playback controls responsive and never reveals future shell output", async () => {
    const baseTime = Date.now();
    const userEvent = makeUserEvent(new Date(baseTime).toISOString());
    const shellEvents = makeShellReplayEvents(baseTime);

    unwrap(
      await invokeE2E(
        "seedChatEvents",
        SESSION_ID,
        [userEvent, ...shellEvents],
        {
          chatPanelMaximized: false,
          chatWidth: 460,
          currentEventId: SHELL_EVENT_ID,
          selectedApp: "CODE_EDITOR",
          stationMode: "agent-station",
        }
      ),
      "seedChatEvents shell replay"
    );

    await waitForReplayText(
      (snapshot) =>
        snapshot.hasReplay &&
        snapshot.text.includes(EARLY_SENTINEL) &&
        !snapshot.text.includes(MIDDLE_SENTINEL) &&
        !snapshot.text.includes(FINAL_SENTINEL),
      "early Snapshot leaked future shell output"
    );

    // Play then pause before the first interval. The cursor must remain on the
    // same Snapshot; range prefetch errors/latency must not move it.
    await clickReplayControl("playPause");
    await waitForPlaybackState(true);
    await browser.pause(200);
    await clickReplayControl("playPause");
    await waitForPlaybackState(false);
    await browser.pause(1_100);
    const pausedSnapshot = await replayPanelSnapshot();
    expect(pausedSnapshot.text).toContain(EARLY_SENTINEL);
    expect(pausedSnapshot.text).not.toContain(MIDDLE_SENTINEL);

    await clickReplayControl("next");
    await waitForReplayText(
      (snapshot) =>
        snapshot.text.includes(EARLY_SENTINEL) &&
        snapshot.text.includes(MIDDLE_SENTINEL) &&
        !snapshot.text.includes(FINAL_SENTINEL),
      "middle Snapshot did not clamp its shell preview"
    );

    await clickReplayControl("next");
    await waitForReplayText(
      (snapshot) =>
        snapshot.text.includes(EARLY_SENTINEL) &&
        snapshot.text.includes(MIDDLE_SENTINEL) &&
        snapshot.text.includes(FINAL_SENTINEL),
      "final Snapshot did not expose the complete shell preview"
    );

    // Exercise the real rendered slider at the production 16ms drag cadence,
    // repeatedly crossing old/new Snapshot generations before settling early.
    await dragReplayBarAt16ms([0.95, 0.05, 0.55, 0.05, 0.95, 0.05]);
    await waitForReplayText(
      (snapshot) =>
        snapshot.text.includes(EARLY_SENTINEL) &&
        !snapshot.text.includes(MIDDLE_SENTINEL) &&
        !snapshot.text.includes(FINAL_SENTINEL),
      "rapid Snapshot scrubbing flashed or retained future shell output"
    );

    await selectPlaybackSpeed("2x");
    await clickReplayControl("playPause");
    await waitForReplayText(
      (snapshot) =>
        snapshot.text.includes(EARLY_SENTINEL) &&
        snapshot.text.includes(MIDDLE_SENTINEL) &&
        snapshot.text.includes(FINAL_SENTINEL),
      "2x autoplay did not reach the final Snapshot"
    );
    await waitForPlaybackState(false);
  });
});

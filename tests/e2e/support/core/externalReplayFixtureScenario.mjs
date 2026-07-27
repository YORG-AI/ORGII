import { verifyLargePayloadRange } from "./externalReplayPayloadDriver.mjs";
import {
  MIB,
  REPLAY_MAX_EVENTS,
  assertNoReplayFatalError,
  clickCurrentRenderedSelector,
  ensureTurnPageItemVisibleWithUserSort,
  execJS,
  getRpcCounts,
  invokeE2E,
  openCodexSessionFromSidebar,
  performWheelBurst,
  positionChatNearPhysicalTopForBurst,
  refreshSessionRosterViaUi,
  rescanCodexSource,
  resetToNewSession,
  rpcCountDelta,
  setPaginationEnabledViaUi,
  waitForChatTurn,
  waitForRenderedSelector,
} from "./externalReplayUiDriver.mjs";
import { selectByAgentFromRenderedMenu } from "./sidebarSessionDiscoveryDriver.mjs";

const LATEST_MARKERS = [
  "E2E bounded replay fixture latest question",
  "E2E bounded replay fixture final answer",
];
const OLDEST_MARKERS = [
  "E2E bounded replay fixture question",
  "E2E bounded replay fixture answer",
];
const MIDDLE_MARKERS = [
  "E2E bounded replay fixture middle question",
  "E2E bounded replay fixture middle answer",
];
const EARLIER_MARKERS = [
  "E2E bounded replay fixture earlier question",
  "E2E bounded replay fixture earlier answer",
];

async function clickPreviousRound(label) {
  await waitForRenderedSelector(
    '[data-testid="turn-pagination-previous-round"]',
    { label: `${label.name} previous-round button` }
  );
  await browser.waitUntil(
    () =>
      execJS(`
        const button = document.querySelector(
          '[data-testid="turn-pagination-previous-round"]'
        );
        return Boolean(button && !button.disabled);
      `),
    {
      timeout: 20_000,
      timeoutMsg: `${label.name} previous-round button stayed disabled`,
    }
  );
  const before = await getRpcCounts();
  await clickCurrentRenderedSelector(
    '[data-testid="turn-pagination-previous-round"]'
  );
  await waitForChatTurn(label);
  const after = await getRpcCounts();
  const reads = rpcCountDelta(after, before, "external_replay_read_window");
  if (reads !== 1) {
    throw new Error(
      `${label.name} issued ${reads} bounded reads; expected exactly one`
    );
  }
  if (label.toolEventIds?.length) {
    const state = await invokeE2E("inspectChatState");
    const renderedToolIds = new Set(
      (state?.toolEvents ?? []).map((event) => event?.id)
    );
    for (const toolEventId of label.toolEventIds) {
      if (!renderedToolIds.has(toolEventId)) {
        throw new Error(
          `${label.name} did not project historical tool event ${toolEventId}`
        );
      }
    }
  }
}

async function clickNextRound(label, expectedReads = 0) {
  await waitForRenderedSelector('[data-testid="turn-pagination-next-round"]', {
    label: `${label.name} next-round button`,
  });
  await browser.waitUntil(
    () =>
      execJS(`
        const button = document.querySelector(
          '[data-testid="turn-pagination-next-round"]'
        );
        return Boolean(button && !button.disabled);
      `),
    {
      timeout: 20_000,
      timeoutMsg: `${label.name} next-round button stayed disabled`,
    }
  );
  const before = await getRpcCounts();
  await clickCurrentRenderedSelector(
    '[data-testid="turn-pagination-next-round"]'
  );
  await waitForChatTurn(label);
  const after = await getRpcCounts();
  const reads = rpcCountDelta(after, before, "external_replay_read_window");
  if (reads !== expectedReads) {
    throw new Error(
      `${label.name} issued ${reads} bounded reads; expected ${expectedReads}`
    );
  }
}

async function openFreshSidebarEpisode(sessionId, label) {
  await resetToNewSession(label);
  return openCodexSessionFromSidebar(sessionId, label);
}

async function openPaginationPageList() {
  await waitForRenderedSelector(
    '[data-testid="turn-pagination-current-round"]',
    { label: "current-round pagination button" }
  );
  await clickCurrentRenderedSelector(
    '[data-testid="turn-pagination-current-round"]'
  );
  await browser.waitUntil(
    () =>
      execJS(`
        return Boolean(
          document.querySelector('[data-testid="turn-page-list"]')
        );
      `),
    { timeout: 10_000, timeoutMsg: "turn-page-list did not open" }
  );
}

async function selectPaginatedRound({
  pageIndex,
  markers,
  label,
  expectedReads,
}) {
  await openPaginationPageList();
  await ensureTurnPageItemVisibleWithUserSort(pageIndex);
  const beforeRead = await getRpcCounts();
  await clickCurrentRenderedSelector(
    `[data-testid="turn-page-list-item"][data-turn-page-index="${pageIndex}"]`
  );
  await waitForChatTurn({
    markers: [markers[1]],
    label,
    visibleMarker: markers[1],
    pinnedMarkers: [markers[0]],
  });
  const afterRead = await getRpcCounts();
  const reads = rpcCountDelta(
    afterRead,
    beforeRead,
    "external_replay_read_window"
  );
  if (reads !== expectedReads) {
    throw new Error(
      `${label} issued ${reads} bounded reads; expected ${expectedReads}`
    );
  }
}

export async function assertFixtureCodexSessionUsesBoundedReplay({
  sessionId,
  expectedLargePayloadBytes,
  expectedLargePayloadSha256,
  fixtureJsonlBytes,
}) {
  if (!sessionId) {
    throw new Error(
      "The isolated external-replay fixture was not configured by the WDIO harness"
    );
  }
  if (
    expectedLargePayloadBytes < 5 * MIB ||
    expectedLargePayloadBytes > 10 * MIB ||
    fixtureJsonlBytes <= expectedLargePayloadBytes
  ) {
    throw new Error(
      `isolated fixture lacks a real 5..10 MiB JSONL tool payload: ${JSON.stringify(
        {
          expectedLargePayloadBytes,
          fixtureJsonlBytes,
        }
      )}`
    );
  }

  await rescanCodexSource();
  await refreshSessionRosterViaUi();
  await selectByAgentFromRenderedMenu();
  // Pagination is only available after a session has opened. Use one rendered
  // sidebar open to expose the real header menu, enable Pagination there, then
  // start a fresh replay episode so the measured open begins in that mode.
  await openCodexSessionFromSidebar(sessionId, "pagination setup");
  await setPaginationEnabledViaUi(true);
  await resetToNewSession("pagination setup");
  const beforeOpen = await getRpcCounts();
  const opened = await openCodexSessionFromSidebar(
    sessionId,
    "bounded Codex fixture"
  );
  if (
    !(opened.chatEventCount > 0 && opened.chatEventCount <= REPLAY_MAX_EVENTS)
  ) {
    throw new Error(
      `fixture hydrated ${opened.chatEventCount} events; expected 1..${REPLAY_MAX_EVENTS}`
    );
  }
  await waitForChatTurn({
    markers: [LATEST_MARKERS[1]],
    label: "bounded Codex fixture latest turn",
    visibleMarker: LATEST_MARKERS[1],
    pinnedMarkers: [LATEST_MARKERS[0]],
  });
  await browser.waitUntil(
    async () => {
      const state = await invokeE2E("inspectChatState");
      return state?.externalReplayTurnSummaryCount === 15;
    },
    {
      timeout: 20_000,
      timeoutMsg:
        "bounded Codex fixture did not expose all 15 virtual turn headers",
    }
  );
  const beforeCatalog = await getRpcCounts();
  await waitForRenderedSelector(
    '[data-testid="turn-pagination-current-round"]',
    { label: "fixture current-round pagination button" }
  );
  await clickCurrentRenderedSelector(
    '[data-testid="turn-pagination-current-round"]'
  );
  await browser.waitUntil(
    () =>
      execJS(`
        return Boolean(
          document.querySelector('[data-testid="turn-page-list"]')
        );
      `),
    { timeout: 20_000, timeoutMsg: "turn-page-list did not open" }
  );
  await browser.waitUntil(
    () =>
      execJS(`
        const catalogText = String(
          document.querySelector('[data-testid="turn-page-list"]')
            ?.textContent ?? ""
        );
        return [
          "E2E bounded replay fixture middle question",
          "E2E bounded replay fixture latest question",
        ].every((marker) => catalogText.includes(marker));
      `),
    {
      timeout: 20_000,
      timeoutMsg:
        "virtual replay catalog did not populate compact previews before body selection",
    }
  );
  await ensureTurnPageItemVisibleWithUserSort(0);
  await browser.waitUntil(
    () =>
      execJS(`
        const item = document.querySelector(
          '[data-testid="turn-page-list-item"][data-turn-page-index="0"]'
        );
        return Boolean(
          item &&
          String(item.textContent ?? "").includes(
            "E2E bounded replay fixture question"
          )
        );
      `),
    {
      timeout: 20_000,
      timeoutMsg: "oldest replay catalog row lacked its compact preview",
    }
  );
  const afterCatalog = await getRpcCounts();
  if (
    rpcCountDelta(
      afterCatalog,
      beforeCatalog,
      "orgtrack_session_turn_metadata_index"
    ) < 1 ||
    rpcCountDelta(
      afterCatalog,
      beforeCatalog,
      "external_replay_read_window"
    ) !== 0
  ) {
    throw new Error(
      "opening the turn catalog did not stay on compact metadata"
    );
  }
  const beforeOldestSelection = await getRpcCounts();
  await clickCurrentRenderedSelector(
    '[data-testid="turn-page-list-item"][data-turn-page-index="0"]'
  );
  await waitForChatTurn({
    markers: [OLDEST_MARKERS[1]],
    label: "direct oldest paginated round",
    visibleMarker: OLDEST_MARKERS[1],
    pinnedMarkers: [OLDEST_MARKERS[0]],
  });
  const afterOldestSelection = await getRpcCounts();
  if (
    rpcCountDelta(
      afterOldestSelection,
      beforeOldestSelection,
      "external_replay_read_window"
    ) !== 1
  ) {
    throw new Error(
      "direct oldest paginated round did not issue exactly one bounded read"
    );
  }
  await selectPaginatedRound({
    pageIndex: 13,
    markers: MIDDLE_MARKERS,
    label: "direct middle paginated round",
    expectedReads: 1,
  });
  await selectPaginatedRound({
    pageIndex: 14,
    markers: LATEST_MARKERS,
    label: "direct latest paginated round",
    // Random-access pagination replaces the previous resident body. Returning
    // to Latest therefore performs one bounded read instead of retaining every
    // page visited during the episode.
    expectedReads: 1,
  });

  await openFreshSidebarEpisode(sessionId, "sequential pagination replay");
  await waitForChatTurn({
    markers: [LATEST_MARKERS[1]],
    label: "latest turn before sequential pagination",
    visibleMarker: LATEST_MARKERS[1],
    pinnedMarkers: [LATEST_MARKERS[0]],
  });

  await clickPreviousRound({
    name: "middle bounded Codex turn",
    markers: [MIDDLE_MARKERS[1]],
    label: "middle bounded Codex turn",
    visibleMarker: MIDDLE_MARKERS[1],
    pinnedMarkers: [MIDDLE_MARKERS[0]],
    excludes: [LATEST_MARKERS[1]],
    toolEventIds: ["codex-tool-27-e2e-middle-call"],
  });
  await clickPreviousRound({
    name: "second previous bounded Codex turn",
    markers: [EARLIER_MARKERS[1]],
    label: "second previous bounded Codex turn",
    visibleMarker: EARLIER_MARKERS[1],
    pinnedMarkers: [EARLIER_MARKERS[0]],
    excludes: [MIDDLE_MARKERS[1], LATEST_MARKERS[1]],
  });
  await clickNextRound(
    {
      name: "next bounded Codex turn",
      markers: [MIDDLE_MARKERS[1]],
      label: "next bounded Codex turn",
      visibleMarker: MIDDLE_MARKERS[1],
      pinnedMarkers: [MIDDLE_MARKERS[0]],
      excludes: [EARLIER_MARKERS[1], LATEST_MARKERS[1]],
    },
    1
  );
  await verifyLargePayloadRange({
    sessionId,
    expectedBytes: expectedLargePayloadBytes,
    expectedSha256: expectedLargePayloadSha256,
  });

  await waitForRenderedSelector('[data-testid="turn-pagination-last-round"]', {
    label: "fixture latest-round button",
  });
  await browser.waitUntil(
    () =>
      execJS(`
        const button = document.querySelector(
          '[data-testid="turn-pagination-last-round"]'
        );
        return Boolean(button && !button.disabled);
      `),
    {
      timeout: 20_000,
      timeoutMsg: "latest-round button stayed disabled",
    }
  );
  await clickCurrentRenderedSelector(
    '[data-testid="turn-pagination-last-round"]'
  );
  await waitForChatTurn({
    markers: [LATEST_MARKERS[1]],
    label: "latest bounded Codex turn after paging",
    visibleMarker: LATEST_MARKERS[1],
    pinnedMarkers: [LATEST_MARKERS[0]],
  });

  await openFreshSidebarEpisode(sessionId, "non-paginated replay");
  await waitForChatTurn({
    markers: [LATEST_MARKERS[1]],
    label: "reopened latest bounded Codex turn",
    visibleMarker: LATEST_MARKERS[1],
    pinnedMarkers: [LATEST_MARKERS[0]],
  });
  const beforeScrollMode = await getRpcCounts();
  await setPaginationEnabledViaUi(false);
  await waitForChatTurn({
    markers: [MIDDLE_MARKERS[0], LATEST_MARKERS[0]],
    label: "non-paginated Codex scroll window",
    visibleMarker: LATEST_MARKERS[0],
  });
  const residentNavigatorLabels = await execJS(`
    return Array.from(
      document.querySelectorAll(
        'nav[aria-label="Conversation navigator"] button[aria-label^="Go to turn"]'
      )
    ).map((button) => button.getAttribute("aria-label") ?? "");
  `);
  if (
    residentNavigatorLabels.length < 2 ||
    residentNavigatorLabels.some(
      (label) => !/Go to turn \d+ of 15:/.test(label)
    ) ||
    residentNavigatorLabels.some((label) =>
      /Go to turn 1 of 15: Round 1(?:\D|$)/.test(label)
    )
  ) {
    throw new Error(
      `sparse non-paginated navigator used resident ordinals instead of provider Rounds: ${JSON.stringify(
        residentNavigatorLabels
      )}`
    );
  }
  const afterScrollMode = await getRpcCounts();
  if (
    rpcCountDelta(
      afterScrollMode,
      beforeScrollMode,
      "external_replay_read_window"
    ) < 1
  ) {
    throw new Error(
      "turning pagination off did not backfill an older bounded window"
    );
  }
  const scrollRootSelector = '[data-testid="chat-history-scroll-root"]';
  const beforeRapidScroll = await getRpcCounts();
  let reachedOldestTurn = false;
  for (let burst = 0; burst < 4; burst += 1) {
    const beforeBurstCounts = await getRpcCounts();
    const beforeBurstState = await invokeE2E("inspectChatState");
    const beforeBurstEventCount = Number(
      beforeBurstState?.chatEventIds?.length ?? 0
    );
    // tauri-wd 0.1.3 dispatches W3C wheel events but does not perform their
    // native default scrolling. Establish only the physical-edge precondition;
    // the wheel below still drives the real React handler and replay request.
    // Capture the RPC/EventStore baseline first because assigning scrollTop
    // asynchronously emits the same real scroll event as a native user scroll.
    await positionChatNearPhysicalTopForBurst();
    reachedOldestTurn = Boolean(
      await execJS(`
        return String(
          document.querySelector(
            '[data-chat-view-root] [data-testid="chat-message-list"]'
          )?.innerText ?? ""
        ).includes(${JSON.stringify(OLDEST_MARKERS[1])});
      `)
    );
    if (reachedOldestTurn) break;
    await performWheelBurst(scrollRootSelector, -900, 12);
    await browser.waitUntil(
      async () => {
        const counts = await getRpcCounts();
        if (
          rpcCountDelta(
            counts,
            beforeBurstCounts,
            "external_replay_read_window"
          ) < 1
        ) {
          return false;
        }
        const state = await invokeE2E("inspectChatState");
        return Number(state?.chatEventIds?.length ?? 0) > beforeBurstEventCount;
      },
      {
        timeout: 30_000,
        interval: 100,
        timeoutMsg: `rapid scroll burst ${burst + 1} did not merge its bounded older window`,
      }
    );
  }
  await positionChatNearPhysicalTopForBurst();
  await waitForChatTurn({
    markers: [OLDEST_MARKERS[0], OLDEST_MARKERS[1]],
    label: "rapid non-paginated upward history scroll",
    visibleMarker: OLDEST_MARKERS[1],
  });
  await assertNoReplayFatalError("rapid non-paginated upward history scroll");
  const afterRapidScroll = await getRpcCounts();
  const rapidScrollReads = rpcCountDelta(
    afterRapidScroll,
    beforeRapidScroll,
    "external_replay_read_window"
  );
  if (rapidScrollReads < 1 || rapidScrollReads > 4) {
    throw new Error(
      `rapid non-paginated scroll issued ${rapidScrollReads} bounded reads; expected 1..4`
    );
  }
  await browser.pause(750);
  const afterRapidScrollIdle = await getRpcCounts();
  if (
    rpcCountDelta(
      afterRapidScrollIdle,
      afterRapidScroll,
      "external_replay_read_window"
    ) !== 0
  ) {
    throw new Error(
      "rapid non-paginated scroll kept reading after the user stopped"
    );
  }
  const afterOpen = await getRpcCounts();
  if (rpcCountDelta(afterOpen, beforeOpen, "external_replay_open_window") < 3) {
    throw new Error(
      "three rendered sidebar opens did not enter external_replay_open_window"
    );
  }
  await resetToNewSession("fixture release");
  await browser.waitUntil(
    async () => {
      const counts = await getRpcCounts();
      return (
        Number(counts.external_replay_release ?? 0) >
        Number(afterOpen.external_replay_release ?? 0)
      );
    },
    {
      timeout: 10_000,
      timeoutMsg: "fixture session never released its replay lease",
    }
  );
}

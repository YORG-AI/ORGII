import {
  assertContinuousIssue272ScrollBurst,
  waitForReplayReadAndLayoutStability,
} from "./externalReplayRealSessionScenario/continuousScroll.mjs";
import {
  assertNativeMemoryMatchesVmmap,
  processMemoryRows,
  waitForStableNativeMemorySnapshot,
} from "./externalReplayRealSessionScenario/memory.mjs";
import {
  MIB,
  REPLAY_MAX_EVENTS,
  REPLAY_MAX_IPC_BYTES,
  assertNoReplayFatalError,
  clickCurrentRenderedSelector,
  clickRenderedSelector,
  ensureTurnPageItemVisibleWithUserSort,
  execJS,
  getChatScrollMetrics,
  getChatViewportSnapshot,
  getRpcCounts,
  invokeE2E,
  invokeTauriCommand,
  openCodexSessionFromSidebar,
  performWheelBurst,
  positionChatNearPhysicalTopForBurst,
  refreshSessionRosterViaUi,
  renderedSelectorSnapshot,
  rescanCodexSource,
  resetToNewSession,
  rpcCountDelta,
  setPaginationEnabledViaUi,
  waitForCurrentReplayRound,
  waitForRenderedSelector,
  waitForRenderedSelectorAbsent,
  waitForRenderedSelectorEnabled,
  waitForVisibleReplayTurn,
} from "./externalReplayUiDriver.mjs";
import { selectByAgentFromRenderedMenu } from "./sidebarSessionDiscoveryDriver.mjs";

export { logIssue443RealCodexDiagnostics } from "./externalReplayRealSessionScenario/diagnostics.mjs";

const REPLAY_TURN_PLACEHOLDER_PREFIX = "__external_replay_turn_index__:";
function replayLimits() {
  return {
    maxTurns: 1,
    maxEvents: REPLAY_MAX_EVENTS,
    maxIpcBytes: REPLAY_MAX_IPC_BYTES,
  };
}

function visibleMarkerForEvent(event) {
  const candidates = [
    event?.displayText,
    event?.args?.content,
    event?.args?.message,
    event?.result?.content,
  ];
  for (const candidate of candidates) {
    const line = String(candidate ?? "")
      .split(/\r?\n/)
      .map((part) => part.replace(/[`*_~]/g, "").trim())
      .find((part) => part.length >= 8);
    if (line) return line.slice(0, 100);
  }
  return "";
}

function compactPreviewMarker(value) {
  return String(value ?? "")
    .replace(/\s*\[[^:\]]+:[^\]]+\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 72);
}

function replayTurnPlaceholderId(turnIndex) {
  return `${REPLAY_TURN_PLACEHOLDER_PREFIX}${turnIndex}`;
}

async function loadExpectedTurnSummaries(sessionId, totalTurnCount) {
  const latestTurnIndex = totalTurnCount - 1;
  const middleTurnIndex = Math.floor(latestTurnIndex / 2);
  const requestedIndices = [
    0,
    middleTurnIndex,
    totalTurnCount > 100 ? 99 : middleTurnIndex,
    latestTurnIndex,
    latestTurnIndex - 1,
    latestTurnIndex - 2,
    latestTurnIndex - 3,
    latestTurnIndex - 4,
  ].filter(
    (turnIndex, index, values) =>
      turnIndex >= 0 &&
      turnIndex < totalTurnCount &&
      values.indexOf(turnIndex) === index
  );
  const summaries = await invokeTauriCommand(
    "orgtrack_session_turn_metadata_index",
    {
      sessionId,
      turnIds: requestedIndices.map(replayTurnPlaceholderId),
    }
  );
  const byIndex = new Map();
  for (const summary of summaries ?? []) {
    const rawIndex = String(summary?.turnId ?? "").slice(
      REPLAY_TURN_PLACEHOLDER_PREFIX.length
    );
    const turnIndex = Number(rawIndex);
    if (!Number.isSafeInteger(turnIndex)) continue;
    const marker = compactPreviewMarker(summary.userPreview);
    if (marker.length >= 8) byIndex.set(turnIndex, { marker });
  }
  for (const turnIndex of requestedIndices) {
    if (!byIndex.has(turnIndex)) {
      throw new Error(
        `real Codex compact metadata omitted a usable preview for Round ${turnIndex + 1}`
      );
    }
  }
  return {
    byIndex,
    catalogIndices: [latestTurnIndex],
    directTurnIndex: 0,
    middleTurnIndex,
    round100TurnIndex: totalTurnCount > 100 ? 99 : middleTurnIndex,
    latestTurnIndex,
  };
}

async function setIssue443DiagnosticTarget({ label, turnIndex, userEventId }) {
  await execJS(`
    window.__orgiiE2EIssue443Target = ${JSON.stringify({
      label,
      turnIndex,
      userEventId,
    })};
    return true;
  `);
}

async function waitForCatalogPreview(turnIndex, marker) {
  await ensureTurnPageItemVisibleWithUserSort(turnIndex);
  const selector = `[data-testid="turn-page-list-item"][data-turn-page-index="${turnIndex}"]`;
  try {
    await browser.waitUntil(
      async () => {
        return execJS(`
          const item = document.querySelector(${JSON.stringify(selector)});
          return Boolean(
            item && String(item.textContent ?? "").includes(
              ${JSON.stringify(marker)}
            )
          );
        `);
      },
      {
        timeout: 20_000,
        interval: 100,
        timeoutMsg: `Round ${turnIndex + 1} never rendered compact preview ${JSON.stringify(marker)}`,
      }
    );
  } catch (error) {
    const diagnostics = await execJS(`
      const list = document.querySelector('[data-testid="turn-page-list"]');
      const root = list?.querySelector('.overflow-y-auto');
      const target = list?.querySelector(${JSON.stringify(selector)});
      return {
        targetText: target?.textContent ?? null,
        scrollTop: root?.scrollTop ?? null,
        scrollHeight: root?.scrollHeight ?? null,
        clientHeight: root?.clientHeight ?? null,
        renderedItems: Array.from(
          list?.querySelectorAll('[data-testid="turn-page-list-item"]') ?? []
        ).map((item) => ({
          turnIndex: item.getAttribute('data-turn-page-index'),
          text: item.textContent,
        })),
      };
    `);
    const rpcCounts = await getRpcCounts();
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; diagnostics=${JSON.stringify(
        { diagnostics, rpcCounts }
      )}`
    );
  }
}

async function waitForStableChatEventIds() {
  let previousIds = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const state = await invokeE2E("inspectChatState");
    const ids = JSON.stringify(state?.chatEventIds ?? []);
    if (ids === previousIds) return state;
    previousIds = ids;
    await browser.pause(250);
  }
  throw new Error("chat EventStore IDs did not stabilize before catalog check");
}

async function assertCompactCatalogBeforeBodyHydration(expected) {
  // Enabling pagination can finish one already-requested body window after the
  // toggle itself resolves. Establish an idle RPC + EventStore + layout
  // baseline before attributing any subsequent body read to opening the compact
  // metadata catalog.
  const beforePaginationSettled = await getRpcCounts();
  await waitForReplayReadAndLayoutStability({
    baselineCounts: beforePaginationSettled,
    label: "Issue 272 Pagination ON transition",
    minimumReads: 0,
    stableForMs: 3_000,
    timeout: 45_000,
  });
  const beforeCatalog = await getRpcCounts();
  const beforeState = await waitForStableChatEventIds();
  const currentRoundSelector = '[data-testid="turn-pagination-current-round"]';
  await waitForRenderedSelector(currentRoundSelector, {
    label: "real Codex current-round button",
  });
  console.log("[issue-443-real-codex] opening compact catalog");
  await clickCurrentRenderedSelector(currentRoundSelector);
  console.log("[issue-443-real-codex] compact catalog opened");
  const pageListSelector = '[data-testid="turn-page-list"]';
  await waitForRenderedSelector(pageListSelector, {
    label: "real Codex compact turn catalog",
  });

  for (const turnIndex of expected.catalogIndices) {
    await waitForCatalogPreview(
      turnIndex,
      expected.byIndex.get(turnIndex).marker
    );
  }

  const afterCatalog = await getRpcCounts();
  const afterState = await waitForStableChatEventIds();
  if (
    JSON.stringify(afterState?.chatEventIds ?? []) !==
    JSON.stringify(beforeState?.chatEventIds ?? [])
  ) {
    const beforeIds = new Set(beforeState?.chatEventIds ?? []);
    const afterIds = new Set(afterState?.chatEventIds ?? []);
    throw new Error(
      `opening the real compact turn catalog changed EventStore bodies: ${JSON.stringify(
        {
          added: [...afterIds].filter((id) => !beforeIds.has(id)),
          removed: [...beforeIds].filter((id) => !afterIds.has(id)),
          rpcDelta: {
            metadata: rpcCountDelta(
              afterCatalog,
              beforeCatalog,
              "orgtrack_session_turn_metadata_index"
            ),
            readWindow: rpcCountDelta(
              afterCatalog,
              beforeCatalog,
              "external_replay_read_window"
            ),
          },
        }
      )}`
    );
  }
  const metadataReads = rpcCountDelta(
    afterCatalog,
    beforeCatalog,
    "orgtrack_session_turn_metadata_index"
  );
  const bodyReads = rpcCountDelta(
    afterCatalog,
    beforeCatalog,
    "external_replay_read_window"
  );
  if (metadataReads < 1 || bodyReads !== 0) {
    throw new Error(
      `real latest catalog preview did not stay on compact metadata: ${JSON.stringify(
        { metadataReads, bodyReads }
      )}`
    );
  }

  console.log("[issue-443-real-codex] closing compact catalog");
  await clickCurrentRenderedSelector(currentRoundSelector);
  console.log("[issue-443-real-codex] compact catalog closed");
  await waitForRenderedSelectorAbsent(pageListSelector, {
    timeout: 5_000,
    label: "real Codex compact turn catalog",
  });
}

async function openHistoryPickerFromConversationNavigator() {
  await waitForRenderedSelector('nav[aria-label="Conversation navigator"]', {
    label: "conversation navigator",
  });
  const markerSelector =
    'nav[aria-label="Conversation navigator"] button[aria-current="step"]';
  const toggleSelector = '[data-testid="conversation-history-toggle"]';
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (!(await renderedSelectorSnapshot(markerSelector))) continue;
    // Tauri WebDriver does not deserialize element references consistently.
    // Clicking the already-active marker in the WebKit realm still exercises
    // the real product focus/click path that exposes the History control.
    await clickCurrentRenderedSelector(markerSelector);
    const toggleVisible = await browser
      .waitUntil(
        async () => Boolean(await renderedSelectorSnapshot(toggleSelector)),
        { timeout: 1_000, interval: 50 }
      )
      .then(() => true)
      .catch(() => false);
    if (!toggleVisible) continue;
    console.log("[issue-443-real-codex] opening conversation History picker");
    await clickCurrentRenderedSelector(toggleSelector);
    console.log("[issue-443-real-codex] conversation History picker opened");
    await waitForRenderedSelector('[data-testid="turn-page-list"]', {
      timeout: 10_000,
      label: "conversation History picker",
    });
    return;
  }
  const diagnostics = await execJS(`
    const navigator = document.querySelector(
      'nav[aria-label="Conversation navigator"]'
    );
    return {
      navigatorClass: navigator?.className ?? null,
      markerCount:
        navigator?.querySelectorAll('button[aria-label^="Go to turn"]').length ??
        0,
      activeMarker: Boolean(
        navigator?.querySelector('button[aria-current="step"]')
      ),
      historyToggle: Boolean(
        navigator?.querySelector('[data-testid="conversation-history-toggle"]')
      ),
    };
  `);
  throw new Error(
    `real conversation navigator never exposed its rendered history picker; diagnostics=${JSON.stringify(diagnostics)}`
  );
}

async function assertRandomAccessRoundVisibleWithoutCorrectiveScroll({
  expected,
  turnIndex,
}) {
  const activeSessionId = (await invokeE2E("inspectChatState"))
    ?.activeSessionId;
  const window = await invokeTauriCommand("external_replay_query_window", {
    sourceId: "codex_app",
    sessionId: activeSessionId,
    turnIndex,
    limits: replayLimits(),
  });
  const userEvent = window.events?.find((event) => event?.source === "user");
  const marker =
    expected.byIndex.get(turnIndex)?.marker ?? visibleMarkerForEvent(userEvent);
  if (!marker || !userEvent?.id) {
    throw new Error(
      `real random-access Round ${turnIndex + 1} lacked compact metadata or a user event`
    );
  }
  await setIssue443DiagnosticTarget({
    label: `random-access Round ${turnIndex + 1}`,
    turnIndex,
    userEventId: userEvent.id,
  });
  await openHistoryPickerFromConversationNavigator();
  await waitForCatalogPreview(turnIndex, compactPreviewMarker(marker));
  const beforeState = await invokeE2E("inspectChatState");
  const bodyWasResident = beforeState?.chatEventIds?.includes(userEvent.id);
  const beforeRead = await getRpcCounts();
  console.log(`[issue-443-real-codex] selecting direct Round ${turnIndex + 1}`);
  await clickCurrentRenderedSelector(
    `[data-testid="turn-page-list-item"][data-turn-page-index="${turnIndex}"]`
  );
  await browser.waitUntil(
    async () =>
      Boolean(
        (await invokeE2E("inspectChatState"))?.chatEventIds?.includes(
          userEvent.id
        )
      ),
    {
      timeout: 30_000,
      interval: 100,
      timeoutMsg: `real direct Round ${turnIndex + 1} never entered EventStore`,
    }
  );
  await waitForVisibleReplayTurn({
    turnIndex,
    label: `real direct Round ${turnIndex + 1}`,
  });
  await assertNoReplayFatalError(`real direct Round ${turnIndex + 1}`);
  const reads = rpcCountDelta(
    await getRpcCounts(),
    beforeRead,
    "external_replay_read_window"
  );
  if (reads > 4 || (!bodyWasResident && reads < 1)) {
    throw new Error(
      `real direct Round ${turnIndex + 1} issued ${reads} bounded reads (resident=${bodyWasResident}); expected 0..4 for resident or 1..4 for unloaded`
    );
  }
}

async function assertPaginationRoundBody({ expected, sessionId, turnIndex }) {
  const targetWindow = await invokeTauriCommand(
    "external_replay_query_window",
    {
      sourceId: "codex_app",
      sessionId,
      turnIndex,
      limits: replayLimits(),
    }
  );
  const userEvent = targetWindow.events?.find(
    (event) => event?.source === "user"
  );
  const assistantBodies = (targetWindow.events ?? [])
    .filter((event) => event?.source === "assistant")
    .map((event) => ({
      id: event?.id,
      marker: visibleMarkerForEvent(event),
    }))
    .filter(
      ({ id, marker }) =>
        Boolean(id) &&
        marker.length >= 8 &&
        !marker.startsWith("[payload truncated]")
    );
  if (!userEvent?.id || assistantBodies.length === 0) {
    throw new Error(
      `real Codex Round ${turnIndex + 1} fixture lacked a user/assistant body pair`
    );
  }
  await setIssue443DiagnosticTarget({
    label: `pagination Round ${turnIndex + 1}`,
    turnIndex,
    userEventId: userEvent.id,
  });

  await setPaginationEnabledViaUi(true);
  await clickCurrentRenderedSelector(
    '[data-testid="turn-pagination-current-round"]'
  );
  await waitForRenderedSelector('[data-testid="turn-page-list"]', {
    label: "real Codex Round catalog",
  });
  await waitForCatalogPreview(
    turnIndex,
    expected.byIndex.get(turnIndex).marker
  );
  await clickCurrentRenderedSelector(
    `[data-testid="turn-page-list-item"][data-turn-page-index="${turnIndex}"]`
  );
  await waitForCurrentReplayRound({
    turnIndex,
    label: `real Codex Round ${turnIndex + 1} selector`,
  });

  let state = null;
  let viewport = null;
  try {
    await browser.waitUntil(
      async () => {
        state = await invokeE2E("inspectChatState");
        viewport = await getChatViewportSnapshot([]);
        const visibleTargetGroup = viewport?.visibleGroups?.find(
          (group) => Number(group.replayTurnIndex) === turnIndex
        );
        return Boolean(
          state?.chatEventIds?.includes(userEvent.id) &&
          assistantBodies.some(({ id }) => state?.chatEventIds?.includes(id)) &&
          assistantBodies.some(({ marker }) =>
            String(visibleTargetGroup?.text ?? "").includes(marker)
          )
        );
      },
      {
        timeout: 30_000,
        interval: 100,
        timeoutMsg: `real Codex Round ${turnIndex + 1} did not render its user and assistant body`,
      }
    );
  } catch (error) {
    // Capture the terminal state after the wait rather than interpolating the
    // initial null values into WebdriverIO's static timeout message.
    state = await invokeE2E("inspectChatState").catch((stateError) => ({
      diagnosticError: String(stateError),
    }));
    viewport = await getChatViewportSnapshot(
      assistantBodies.slice(0, 8).map(({ marker }) => marker)
    ).catch((viewportError) => ({
      diagnosticError: String(viewportError),
    }));
    throw new Error(
      `real Codex Round ${turnIndex + 1} did not render its user and assistant body; waitError=${String(
        error
      )} state=${JSON.stringify(state)} viewport=${JSON.stringify(viewport)}`
    );
  }
}

async function assertFirstRoundCanScrollForward(expected) {
  const firstTurnIndex = 0;
  const firstWindow = await invokeTauriCommand("external_replay_query_window", {
    sourceId: "codex_app",
    sessionId: (await invokeE2E("inspectChatState"))?.activeSessionId,
    turnIndex: firstTurnIndex,
    limits: replayLimits(),
  });
  const firstUserEvent = firstWindow.events?.find(
    (event) => event?.source === "user"
  );
  if (!firstUserEvent?.id) {
    throw new Error("real Codex first Round lacked a user event");
  }
  await setIssue443DiagnosticTarget({
    label: "navigator first-Round forward scroll",
    turnIndex: firstTurnIndex,
    userEventId: firstUserEvent.id,
  });
  await setPaginationEnabledViaUi(false);
  await openHistoryPickerFromConversationNavigator();
  await waitForCatalogPreview(
    firstTurnIndex,
    expected.byIndex.get(firstTurnIndex).marker
  );
  await clickCurrentRenderedSelector(
    '[data-testid="turn-page-list-item"][data-turn-page-index="0"]'
  );
  await waitForVisibleReplayTurn({
    turnIndex: firstTurnIndex,
    label: "real Codex first Round",
  });

  const scrollRootSelector = '[data-testid="chat-history-scroll-root"]';
  await performWheelBurst(scrollRootSelector, 900, 12);
  let viewport = null;
  await browser.waitUntil(
    async () => {
      viewport = await getChatViewportSnapshot([]);
      return Boolean(
        viewport?.visibleGroups?.some(
          (group) => Number(group.replayTurnIndex) > firstTurnIndex
        )
      );
    },
    {
      timeout: 30_000,
      interval: 100,
      timeoutMsg: `real Codex remained trapped at Round 1 after a forward wheel burst; viewport=${JSON.stringify(
        viewport
      )}`,
    }
  );
}

async function assertNavigatorCatalogCanBrowse(expected) {
  await setPaginationEnabledViaUi(false);
  await openHistoryPickerFromConversationNavigator();
  for (const turnIndex of [
    expected.latestTurnIndex,
    expected.middleTurnIndex,
    0,
  ]) {
    await waitForCatalogPreview(
      turnIndex,
      expected.byIndex.get(turnIndex).marker
    );
  }
}

async function assertDirectOldRoundVisibleWithoutCorrectiveScroll(expected) {
  await setPaginationEnabledViaUi(false);
  await waitForRenderedSelector('[data-testid="chat-history-scroll-root"]', {
    label: "chat history scroll root",
  });
  const turnIndices = [
    expected.directTurnIndex,
    expected.middleTurnIndex,
    expected.latestTurnIndex,
  ].filter((turnIndex, index, values) => values.indexOf(turnIndex) === index);
  for (const turnIndex of turnIndices) {
    await assertRandomAccessRoundVisibleWithoutCorrectiveScroll({
      expected,
      turnIndex,
    });
  }
}

async function logAcceptanceStep(label) {
  // tauri-wd has one pending-script slot. Keep diagnostic reads sequential so
  // acceptance logging cannot race the product action it is observing.
  const memory = await invokeTauriCommand("get_app_memory_snapshot_v1");
  const state = await invokeE2E("inspectChatState");
  console.log(
    `[issue-443-real-codex] acceptance-step=${label} events=${Number(
      state?.chatEventCount ?? 0
    )} processes=${JSON.stringify(processMemoryRows(memory))}`
  );
}

async function assertFirstRenderedOpen(sessionId, openedState) {
  const latestWindow = await invokeTauriCommand(
    "external_replay_query_window",
    {
      sourceId: "codex_app",
      sessionId,
      limits: replayLimits(),
    }
  );
  const latestUserEvent = latestWindow.events?.find(
    (event) => event?.source === "user"
  );
  if (
    !latestUserEvent?.id ||
    !openedState?.chatEventIds?.includes(latestUserEvent.id)
  ) {
    throw new Error(
      `real Codex sidebar open rendered the wrong latest turn: ${JSON.stringify(
        {
          expectedLatestUserEventId: latestUserEvent?.id ?? null,
          totalTurnCount: latestWindow.totalTurnCount,
          chatEventIds: openedState?.chatEventIds ?? null,
        }
      )}`
    );
  }
  if (Number(latestWindow.totalTurnCount) < 6) {
    throw new Error(
      `real Issue 272 session exposed only ${latestWindow.totalTurnCount} turns`
    );
  }
  const latestTurnIndex = Number(latestWindow.totalTurnCount) - 1;
  await waitForVisibleReplayTurn({
    turnIndex: latestTurnIndex,
    label: "real Codex latest turn",
  });
  const expected = await loadExpectedTurnSummaries(
    sessionId,
    Number(latestWindow.totalTurnCount)
  );
  await logAcceptanceStep("compact-summaries-loaded");
  return { expected, latestWindow };
}

async function assertPaginationOnRoundNavigation({
  expected,
  latestWindow,
  sessionId,
}) {
  await setPaginationEnabledViaUi(true);
  await waitForCurrentReplayRound({
    turnIndex: expected.latestTurnIndex,
    label: "real Codex latest pagination Round",
    allowLatestLabel: true,
  });
  const previousTurnIndex = Number(latestWindow.totalTurnCount) - 2;
  if (previousTurnIndex < 0) return;
  const previousWindow = await invokeTauriCommand(
    "external_replay_query_window",
    {
      sourceId: "codex_app",
      sessionId,
      turnIndex: previousTurnIndex,
      limits: replayLimits(),
    }
  );
  const previousUserEvent = previousWindow.events?.find(
    (event) => event?.source === "user"
  );
  const previousSelector = '[data-testid="turn-pagination-previous-round"]';
  await waitForRenderedSelectorEnabled(previousSelector, {
    label: "real Codex previous-round button",
  });
  const beforePreviousState = await invokeE2E("inspectChatState");
  const previousTurnWasResident = Boolean(
    previousUserEvent?.id &&
    beforePreviousState?.chatEventIds?.includes(previousUserEvent.id)
  );
  const beforePrevious = await getRpcCounts();
  console.log(
    `[issue-443-real-codex] clicking Previous for Round ${previousTurnIndex + 1}`
  );
  await clickCurrentRenderedSelector(previousSelector);
  console.log(
    `[issue-443-real-codex] Previous click completed for Round ${previousTurnIndex + 1}`
  );
  let currentState = null;
  await browser.waitUntil(
    async () => {
      currentState = await invokeE2E("inspectChatState");
      return Boolean(
        previousUserEvent?.id &&
        currentState?.chatEventIds?.includes(previousUserEvent.id)
      );
    },
    {
      timeout: 30_000,
      timeoutMsg: `real Codex previous turn ${previousTurnIndex} did not render`,
    }
  );
  if (!previousUserEvent?.id) {
    throw new Error(
      `real Codex previous turn ${previousTurnIndex} lacked a user event`
    );
  }
  await waitForCurrentReplayRound({
    turnIndex: previousTurnIndex,
    label: `real Codex previous turn ${previousTurnIndex}`,
  });
  await waitForVisibleReplayTurn({
    turnIndex: previousTurnIndex,
    label: `real Codex previous turn ${previousTurnIndex}`,
  });
  const afterPrevious = await getRpcCounts();
  await logAcceptanceStep("previous-round-visible");
  const readCalls = rpcCountDelta(
    afterPrevious,
    beforePrevious,
    "external_replay_read_window"
  );
  if (readCalls > 2 || (!previousTurnWasResident && readCalls < 1)) {
    throw new Error(
      `real previous-round click issued ${readCalls} bounded reads (resident=${previousTurnWasResident}); expected 0..2 for a resident body or 1..2 for an unloaded body`
    );
  }

  const nextSelector = '[data-testid="turn-pagination-next-round"]';
  await waitForRenderedSelectorEnabled(nextSelector, {
    label: "real Codex next-round button",
  });
  const beforeNext = await getRpcCounts();
  await clickCurrentRenderedSelector(nextSelector);
  await waitForCurrentReplayRound({
    turnIndex: expected.latestTurnIndex,
    label: "real Codex next Round",
    allowLatestLabel: true,
  });
  await waitForVisibleReplayTurn({
    turnIndex: expected.latestTurnIndex,
    label: "real Codex next Round",
  });
  const nextReads = rpcCountDelta(
    await getRpcCounts(),
    beforeNext,
    "external_replay_read_window"
  );
  if (nextReads > 2) {
    throw new Error(
      `real next-round click issued ${nextReads} bounded reads; expected 0..2`
    );
  }

  const latestSelector = '[data-testid="turn-pagination-last-round"]';
  await waitForRenderedSelector(latestSelector, {
    label: "real Codex latest-round button",
  });
  if (!(await renderedSelectorSnapshot(latestSelector))?.disabled) {
    console.log("[issue-443-real-codex] clicking Latest");
    await clickRenderedSelector(latestSelector, {
      label: "real Codex latest-round button",
    });
    console.log("[issue-443-real-codex] Latest click completed");
  }
  await waitForCurrentReplayRound({
    turnIndex: expected.latestTurnIndex,
    label: "real Codex latest Round restored",
    allowLatestLabel: true,
  });
  await waitForVisibleReplayTurn({
    turnIndex: expected.latestTurnIndex,
    label: "real Codex latest Round restored",
  });
  await logAcceptanceStep("latest-round-restored");
}

function requireRealSessionId(sessionId) {
  if (!sessionId) {
    throw new Error(
      "E2E_ISSUE_443_REAL_CODEX_SESSION_ID is required for the real Codex acceptance matrix"
    );
  }
}

async function openFreshRealCodexEpisode(
  sessionId,
  label,
  { maxResidentEvents = null } = {}
) {
  requireRealSessionId(sessionId);
  await resetToNewSession(`${label} pre-open`);
  const beforeOpenRpc = await getRpcCounts();
  await openCodexSessionFromSidebar(sessionId, label);
  let openedState = null;
  let lastRpcCounts = beforeOpenRpc;
  await browser.waitUntil(
    async () => {
      lastRpcCounts = await getRpcCounts();
      openedState = await invokeE2E("inspectChatState");
      const eventCount = Number(openedState?.chatEventCount ?? 0);
      return (
        rpcCountDelta(
          lastRpcCounts,
          beforeOpenRpc,
          "external_replay_open_window"
        ) >= 1 &&
        openedState?.activeSessionId === sessionId &&
        openedState?.coreSessionId === sessionId &&
        eventCount > 0 &&
        (maxResidentEvents === null || eventCount <= maxResidentEvents)
      );
    },
    {
      timeout: 180_000,
      interval: 100,
      timeoutMsg: `${label} did not finish a fresh bounded open; maxResidentEvents=${String(
        maxResidentEvents
      )} state=${JSON.stringify(
        openedState
      )} rpc=${JSON.stringify(lastRpcCounts)}`,
    }
  );
  return openedState;
}

export async function prepareIssue443RealCodexMatrix(sessionId) {
  requireRealSessionId(sessionId);
  await rescanCodexSource();
  await refreshSessionRosterViaUi();
  await selectByAgentFromRenderedMenu();
}

export async function assertIssue443RealCodexInitialOpen(sessionId) {
  const openedState = await openFreshRealCodexEpisode(
    sessionId,
    "real Codex initial-open",
    { maxResidentEvents: REPLAY_MAX_EVENTS }
  );
  await assertFirstRenderedOpen(sessionId, openedState);
}

export async function assertIssue443RealCodexCompactCatalog(sessionId) {
  const openedState = await openFreshRealCodexEpisode(
    sessionId,
    "real Codex compact-catalog"
  );
  const { expected } = await assertFirstRenderedOpen(sessionId, openedState);
  await setPaginationEnabledViaUi(true);
  await assertCompactCatalogBeforeBodyHydration(expected);
  await logAcceptanceStep("compact-catalog-closed");
}

export async function assertIssue443RealCodexPaginationOn(sessionId) {
  const openedState = await openFreshRealCodexEpisode(
    sessionId,
    "real Codex pagination-on"
  );
  const context = await assertFirstRenderedOpen(sessionId, openedState);
  await assertPaginationOnRoundNavigation({
    ...context,
    sessionId,
  });
}

export async function assertIssue443RealCodexPaginationRound100(sessionId) {
  const openedState = await openFreshRealCodexEpisode(
    sessionId,
    "real Codex pagination-round-100"
  );
  const { expected } = await assertFirstRenderedOpen(sessionId, openedState);
  await assertPaginationRoundBody({
    expected,
    sessionId,
    turnIndex: expected.round100TurnIndex,
  });
}

export async function assertIssue443RealCodexContinuousScroll(sessionId) {
  const openedState = await openFreshRealCodexEpisode(
    sessionId,
    "real Codex pagination-off-continuous-scroll"
  );
  const { latestWindow } = await assertFirstRenderedOpen(
    sessionId,
    openedState
  );
  await assertContinuousIssue272ScrollBurst(
    Number(latestWindow.totalTurnCount)
  );
  await logAcceptanceStep("continuous-scroll-complete");
}

export async function assertIssue443RealCodexNavigatorRandomAccess(sessionId) {
  const openedState = await openFreshRealCodexEpisode(
    sessionId,
    "real Codex navigator-random-access"
  );
  const { expected } = await assertFirstRenderedOpen(sessionId, openedState);
  await assertDirectOldRoundVisibleWithoutCorrectiveScroll(expected);
  await logAcceptanceStep("direct-old-round-visible");
}

export async function assertIssue443RealCodexNavigatorFirstRoundRecovery(
  sessionId
) {
  const openedState = await openFreshRealCodexEpisode(
    sessionId,
    "real Codex navigator-first-round-recovery"
  );
  const { expected } = await assertFirstRenderedOpen(sessionId, openedState);
  await assertFirstRoundCanScrollForward(expected);
}

export async function assertIssue443RealCodexNavigatorCatalog(sessionId) {
  const openedState = await openFreshRealCodexEpisode(
    sessionId,
    "real Codex navigator-catalog"
  );
  const { expected } = await assertFirstRenderedOpen(sessionId, openedState);
  await assertNavigatorCatalogCanBrowse(expected);
}

async function secondaryCodexSessionId(primarySessionId) {
  return execJS(`
    const primary = ${JSON.stringify(primarySessionId)};
    const section = document.querySelector(
      '[data-sidebar-section-id="external_history:codex_app"]'
    );
    const rows = Array.from(
      section?.querySelectorAll('[data-testid^="sidebar-session-item-"]') ?? []
    );
    return rows
      .map((row) =>
        String(row.getAttribute("data-testid") ?? "").slice(
          "sidebar-session-item-".length
        )
      )
      .find((sessionId) => sessionId && sessionId !== primary) ?? null;
  `);
}

export async function assertIssue443RealCodexEpisodeAndReopen(sessionId) {
  const firstA = await openFreshRealCodexEpisode(
    sessionId,
    "real Codex episode A1"
  );
  const { latestWindow } = await assertFirstRenderedOpen(sessionId, firstA);
  const latestUserEvent = latestWindow.events?.find(
    (event) => event?.source === "user"
  );
  const sessionB = await secondaryCodexSessionId(sessionId);
  if (!sessionB) {
    throw new Error(
      "real Codex A→B→A scenario requires a second rendered Codex session"
    );
  }
  const openedB = await openCodexSessionFromSidebar(
    sessionB,
    "real Codex episode B"
  );
  const bEventIds = new Set(openedB?.chatEventIds ?? []);
  const reopenedA = await openCodexSessionFromSidebar(
    sessionId,
    "real Codex episode A2"
  );
  await waitForVisibleReplayTurn({
    turnIndex: Number(latestWindow.totalTurnCount) - 1,
    label: "real Codex reopened episode A2",
  });
  if (
    reopenedA?.activeSessionId !== sessionId ||
    !latestUserEvent?.id ||
    !reopenedA?.chatEventIds?.includes(latestUserEvent.id) ||
    reopenedA.chatEventIds.some((eventId) => bEventIds.has(eventId))
  ) {
    throw new Error(
      `real Codex A→B→A accepted stale session state: ${JSON.stringify({
        sessionB,
        expectedAEventId: latestUserEvent?.id ?? null,
        activeSessionId: reopenedA?.activeSessionId ?? null,
        reopenedEventIds: reopenedA?.chatEventIds ?? null,
      })}`
    );
  }
  await assertNoReplayFatalError("real Codex A→B→A");
}

export async function assertIssue443RealCodexBoundedMemoryRelease(sessionId) {
  requireRealSessionId(sessionId);
  // Pagination OFF intentionally bootstraps multiple individually bounded
  // windows. Establish Pagination ON before measuring latest-window
  // open/release cycles so this scenario tests lifecycle retention rather than
  // inheriting the previous continuous-scroll scenario's display preference.
  await openFreshRealCodexEpisode(
    sessionId,
    "real Codex memory pagination setup"
  );
  await setPaginationEnabledViaUi(true);
  await resetToNewSession("real Codex memory pagination setup release");
  const memoryBefore = await waitForStableNativeMemorySnapshot();
  const baselineBytes = Number(memoryBefore?.effective_total_bytes ?? 0);
  await assertNativeMemoryMatchesVmmap(memoryBefore, baselineBytes);

  // Warm five rendered open/release cycles, then measure five more. Every open
  // is a real click on the production sidebar row; only the between-cycle reset
  // uses a debug helper to establish a fresh foreground episode.
  const warmupCycles = 5;
  const measuredCycles = 5;
  const samples = [];
  for (let cycle = 0; cycle < warmupCycles + measuredCycles; cycle += 1) {
    const startedAt = Date.now();
    const openedState = await openFreshRealCodexEpisode(
      sessionId,
      `real Codex cycle ${cycle}`,
      { maxResidentEvents: REPLAY_MAX_EVENTS }
    );
    const eventCount = Number(openedState.chatEventCount);
    const memoryLatestWindowOpen = await invokeTauriCommand(
      "get_app_memory_snapshot_v1"
    );
    await waitForVisibleReplayTurn({
      turnIndex:
        Number(
          (
            await invokeTauriCommand("external_replay_query_window", {
              sourceId: "codex_app",
              sessionId,
              limits: replayLimits(),
            })
          ).totalTurnCount
        ) - 1,
      label: `real Codex memory cycle ${cycle}`,
    });
    await resetToNewSession(`real Codex release cycle ${cycle}`);
    await browser.pause(1_000);
    const memoryReleased = await invokeTauriCommand(
      "get_app_memory_snapshot_v1"
    );
    samples.push({
      cycle,
      elapsedMs: Date.now() - startedAt,
      eventCount,
      latestWindowOpenBytes: Number(
        memoryLatestWindowOpen?.effective_total_bytes ?? 0
      ),
      latestWindowOpenProcesses: processMemoryRows(memoryLatestWindowOpen),
      releasedBytes: Number(memoryReleased?.effective_total_bytes ?? 0),
      releasedProcesses: processMemoryRows(memoryReleased),
    });
  }

  const firstWindowGrowth = Math.max(
    0,
    samples[0].latestWindowOpenBytes - baselineBytes
  );
  const steadyReference = samples[warmupCycles - 1].releasedBytes;
  const measuredTail = samples.slice(warmupCycles);
  const idleReleaseSamples = [];
  for (let sampleIndex = 0; sampleIndex < 6; sampleIndex += 1) {
    await browser.pause(5_000);
    const memoryIdle = await invokeTauriCommand("get_app_memory_snapshot_v1");
    idleReleaseSamples.push({
      elapsedMs: (sampleIndex + 1) * 5_000,
      releasedBytes: Number(memoryIdle?.effective_total_bytes ?? 0),
      releasedProcesses: processMemoryRows(memoryIdle),
    });
  }
  const settledCandidates = [...measuredTail, ...idleReleaseSamples];
  const settledBytes = Math.min(
    ...settledCandidates.map((sample) => sample.releasedBytes)
  );
  const settledGrowth = Math.max(0, settledBytes - baselineBytes);
  const stepGrowth = Math.max(0, settledBytes - steadyReference);
  const backendMib = (sample) =>
    sample.releasedProcesses.find((processRow) => processRow.role === "backend")
      ?.mib ?? 0;
  const backendStepGrowthMib = Math.max(
    0,
    Math.min(...settledCandidates.map(backendMib)) -
      backendMib(samples[warmupCycles - 1])
  );
  console.log(
    `[issue-443-real-codex] baseline=${(baselineBytes / MIB).toFixed(1)} MiB firstWindowGrowth=${(firstWindowGrowth / MIB).toFixed(1)} MiB settledGrowth=${(settledGrowth / MIB).toFixed(1)} MiB measuredStepGrowth=${(stepGrowth / MIB).toFixed(1)} MiB backendStepGrowth=${backendStepGrowthMib.toFixed(1)} MiB samples=${JSON.stringify(samples)} idleSamples=${JSON.stringify(idleReleaseSamples)}`
  );

  if (firstWindowGrowth > 400 * MIB) {
    throw new Error(
      `real Codex first bounded window grew Physical Footprint by ${(firstWindowGrowth / MIB).toFixed(1)} MiB`
    );
  }
  if (stepGrowth > 64 * MIB) {
    throw new Error(
      `five measured real Codex open/release cycles grew another ${(stepGrowth / MIB).toFixed(1)} MiB after warmup`
    );
  }
  if (settledGrowth > 250 * MIB) {
    throw new Error(
      `real Codex settled Physical Footprint remained ${(settledGrowth / MIB).toFixed(1)} MiB above baseline`
    );
  }
  if (backendStepGrowthMib > 16) {
    throw new Error(
      `five measured real Codex cycles grew backend Physical Footprint by ${backendStepGrowthMib.toFixed(1)} MiB`
    );
  }
}

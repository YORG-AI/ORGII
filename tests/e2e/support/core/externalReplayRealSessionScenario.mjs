import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  MIB,
  REPLAY_MAX_EVENTS,
  REPLAY_MAX_IPC_BYTES,
  assertNoReplayFatalError,
  clickCurrentRenderedSelector,
  clickRenderedSelector,
  ensureTurnPageItemVisibleWithUserSort,
  execJS,
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
  waitForChatTurn,
  waitForRenderedSelector,
  waitForRenderedSelectorAbsent,
  waitForRenderedSelectorEnabled,
} from "./externalReplayUiDriver.mjs";
import { selectByAgentFromRenderedMenu } from "./sidebarSessionDiscoveryDriver.mjs";

const execFileAsync = promisify(execFile);
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

function visibleAssistantMarkerForWindow(window) {
  const events = window?.events ?? [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.source !== "assistant" || event?.displayVariant !== "message") {
      continue;
    }
    const marker = visibleMarkerForEvent(event);
    if (marker) return marker;
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
    latestTurnIndex,
  };
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

async function waitForStableRpcCount(commandName) {
  let previousCount = null;
  let stableSamples = 0;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const counts = await getRpcCounts();
    const count = Number(counts?.[commandName] ?? 0);
    if (count === previousCount) {
      stableSamples += 1;
      if (stableSamples >= 4) return;
    } else {
      previousCount = count;
      stableSamples = 0;
    }
    await browser.pause(250);
  }
  throw new Error(`${commandName} did not become idle before catalog check`);
}

async function assertCompactCatalogBeforeBodyHydration(expected) {
  // Enabling pagination can finish one already-requested body window after the
  // toggle itself resolves. Establish an idle baseline before attributing any
  // subsequent body read to opening the compact metadata catalog.
  await waitForStableRpcCount("external_replay_read_window");
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

async function assertDirectOldRoundVisibleWithoutCorrectiveScroll(expected) {
  await setPaginationEnabledViaUi(false);
  await waitForRenderedSelector('[data-testid="chat-history-scroll-root"]', {
    label: "chat history scroll root",
  });

  await openHistoryPickerFromConversationNavigator();
  const activeSessionId = (await invokeE2E("inspectChatState"))
    ?.activeSessionId;
  let turnIndex = expected.directTurnIndex;
  let marker = "";
  let bodyMarker = "";
  for (const offset of [0, 1, -1, 2, -2, 3, -3, 4, -4]) {
    const candidateIndex = expected.directTurnIndex + offset;
    if (candidateIndex < 0 || candidateIndex > expected.latestTurnIndex) {
      continue;
    }
    const candidateWindow = await invokeTauriCommand(
      "external_replay_query_window",
      {
        sourceId: "codex_app",
        sessionId: activeSessionId,
        turnIndex: candidateIndex,
        limits: replayLimits(),
      }
    );
    const userEvent = candidateWindow.events?.find(
      (event) => event?.source === "user"
    );
    const candidateMarker = visibleMarkerForEvent(userEvent);
    const candidateBodyMarker =
      visibleAssistantMarkerForWindow(candidateWindow);
    if (!candidateMarker || !candidateBodyMarker) continue;
    turnIndex = candidateIndex;
    marker = candidateMarker;
    bodyMarker = candidateBodyMarker;
    break;
  }
  if (!marker || !bodyMarker) {
    throw new Error(
      `real middle Rounds around ${expected.directTurnIndex + 1} had no visible user/assistant marker pair`
    );
  }
  await waitForCatalogPreview(turnIndex, compactPreviewMarker(marker));
  const beforeRead = await getRpcCounts();
  console.log(
    `[issue-443-real-codex] selecting direct old Round ${turnIndex + 1}`
  );
  await clickCurrentRenderedSelector(
    `[data-testid="turn-page-list-item"][data-turn-page-index="${turnIndex}"]`
  ); // The selected old Round must paint without corrective scrolling.
  console.log(
    `[issue-443-real-codex] direct old Round ${turnIndex + 1} selected`
  );
  await waitForChatTurn({
    markers: [marker, bodyMarker],
    label: `real direct old Round ${turnIndex + 1}`,
    visibleMarker: marker,
  });
  await assertNoReplayFatalError("real direct old-Round selection");
  const afterRead = await getRpcCounts();
  const reads = rpcCountDelta(
    afterRead,
    beforeRead,
    "external_replay_read_window"
  );
  if (reads < 1 || reads > 4) {
    throw new Error(
      `real direct old Round issued ${reads} bounded reads; expected 1..4`
    );
  }
}

async function assertContinuousIssue272ScrollBurst(totalTurnCount) {
  await setPaginationEnabledViaUi(false);
  const scrollRootSelector = '[data-testid="chat-history-scroll-root"]';
  await waitForRenderedSelector(scrollRootSelector, {
    label: "Issue 272 continuous history root",
  });
  // Pagination OFF performs one bounded bootstrap. Wait for it to settle so
  // the measured gesture below owns every subsequent read.
  await browser.pause(1_000);
  const beforeReads = await getRpcCounts();
  await positionChatNearPhysicalTopForBurst();
  const anchorBefore = await execJS(`
    const root = document.querySelector(${JSON.stringify(scrollRootSelector)});
    const rootRect = root?.getBoundingClientRect();
    const items = Array.from(
      document.querySelectorAll(
        '[data-chat-view-root] [data-chat-item-key]'
      )
    );
    const groups = Array.from(
      document.querySelectorAll(
        '[data-chat-view-root] [data-chat-group-index]'
      )
    );
    const findVisible = (elements) =>
      rootRect
        ? elements.find((element) => {
          const rect = element.getBoundingClientRect();
          return rect.bottom > rootRect.top + 1 && rect.top < rootRect.bottom - 1;
        })
        : null;
    const visibleItem = findVisible(items);
    const visibleGroup = findVisible(groups);
    return {
      itemKey: visibleItem?.getAttribute("data-chat-item-key") ?? null,
      groupKey: visibleGroup?.getAttribute("data-chat-group-key") ?? null,
      turnId: visibleGroup?.getAttribute("data-chat-turn-id") ?? null,
      text: String((visibleItem ?? visibleGroup)?.innerText ?? "").slice(0, 160),
      scrollTop: root?.scrollTop ?? null,
      scrollHeight: root?.scrollHeight ?? null,
    };
  `);
  await performWheelBurst(scrollRootSelector, -900, 12);
  await browser.waitUntil(
    async () =>
      rpcCountDelta(
        await getRpcCounts(),
        beforeReads,
        "external_replay_read_window"
      ) >= 4,
    {
      timeout: 30_000,
      interval: 100,
      timeoutMsg:
        "Issue 272 continuous scroll did not complete its four-window bounded burst",
    }
  );
  await browser.pause(500);
  const afterReads = await getRpcCounts();
  const boundedReads = rpcCountDelta(
    afterReads,
    beforeReads,
    "external_replay_read_window"
  );
  const anchorAfter = await execJS(`
    const expectedItemKey = ${JSON.stringify(anchorBefore?.itemKey ?? null)};
    const expectedGroupKey = ${JSON.stringify(anchorBefore?.groupKey ?? null)};
    const root = document.querySelector(${JSON.stringify(scrollRootSelector)});
    const rootRect = root?.getBoundingClientRect();
    const groups = Array.from(
      document.querySelectorAll(
        '[data-chat-view-root] [data-chat-group-index]'
      )
    );
    const anchor = expectedItemKey
      ? document.querySelector(
          \`[data-chat-view-root] [data-chat-item-key="\${CSS.escape(expectedItemKey)}"]\`
        )
      : expectedGroupKey
        ? groups.find(
          (group) => group.getAttribute("data-chat-group-key") === expectedGroupKey
        )
        : null;
    const anchorRect = anchor?.getBoundingClientRect() ?? null;
    const anchorGroup = expectedGroupKey
      ? groups.find(
          (group) => group.getAttribute("data-chat-group-key") === expectedGroupKey
        )
      : null;
    const anchorGroupRect = anchorGroup?.getBoundingClientRect() ?? null;
    return {
      anchorPresent: Boolean(anchor),
      anchorVisible: Boolean(
        rootRect &&
          anchorRect &&
          anchorRect.bottom > rootRect.top + 1 &&
          anchorRect.top < rootRect.bottom - 1
      ),
      anchorTop: anchorRect?.top ?? null,
      anchorBottom: anchorRect?.bottom ?? null,
      anchorGroupPresent: Boolean(anchorGroup),
      anchorGroupTop: anchorGroupRect?.top ?? null,
      anchorGroupBottom: anchorGroupRect?.bottom ?? null,
      anchorGroupVisible: Boolean(
        rootRect &&
          anchorGroupRect &&
          anchorGroupRect.bottom > rootRect.top + 1 &&
          anchorGroupRect.top < rootRect.bottom - 1
      ),
      rootTop: rootRect?.top ?? null,
      rootBottom: rootRect?.bottom ?? null,
      scrollTop: root?.scrollTop ?? null,
      scrollHeight: root?.scrollHeight ?? null,
      navigatorLabels: Array.from(
        document.querySelectorAll(
          'nav[aria-label="Conversation navigator"] button[aria-label^="Go to turn"]'
        )
      ).map((button) => button.getAttribute("aria-label") ?? ""),
    };
  `);
  const expectedTotalPattern = new RegExp(
    `Go to turn \\d+ of ${totalTurnCount}:`
  );
  if (
    boundedReads !== 4 ||
    !(anchorBefore?.itemKey || anchorBefore?.groupKey) ||
    !(
      (anchorAfter?.anchorPresent && anchorAfter?.anchorVisible) ||
      anchorAfter?.anchorGroupVisible
    ) ||
    !(Number(anchorAfter?.scrollTop) > 1) ||
    !Array.isArray(anchorAfter?.navigatorLabels) ||
    anchorAfter.navigatorLabels.length < 2 ||
    anchorAfter.navigatorLabels.some(
      (label) => !expectedTotalPattern.test(String(label))
    )
  ) {
    throw new Error(
      `Issue 272 continuous scroll lost batching, provider numbering, or its viewport anchor: ${JSON.stringify(
        {
          boundedReads,
          anchorBefore,
          anchorAfter,
          totalTurnCount,
        }
      )}`
    );
  }
}

async function assertNativeMemoryMatchesVmmap(memorySnapshot, baselineBytes) {
  if (process.platform !== "darwin") return;
  if (memorySnapshot.measurement !== "native") {
    throw new Error(
      `#435 regression: expected native macOS memory measurement, got ${memorySnapshot.measurement}`
    );
  }
  let vmmapBytes = 0;
  const vmmapBytesByPid = new Map();
  for (const processRow of memorySnapshot.processes ?? []) {
    if (processRow.metric_kind !== "physical_footprint") {
      throw new Error(
        `#435 regression: PID ${processRow.pid} used ${processRow.metric_kind}`
      );
    }
    const { stdout } = await execFileAsync(
      "/usr/bin/vmmap",
      ["-summary", String(processRow.pid)],
      { maxBuffer: 2 * MIB }
    );
    const match = stdout.match(
      /^Physical footprint:\s+([0-9.]+)\s*([KMGT]?)B?\s*$/im
    );
    if (!match) {
      throw new Error(
        `#435 regression: vmmap omitted Physical footprint for PID ${processRow.pid}`
      );
    }
    const units = { "": 1, K: 1024, M: MIB, G: 1024 * MIB, T: 1024 ** 4 };
    const processVmmapBytes = Number(match[1]) * units[match[2].toUpperCase()];
    vmmapBytes += processVmmapBytes;
    vmmapBytesByPid.set(processRow.pid, processVmmapBytes);
  }
  // vmmap samples each PID sequentially, so the aggregate represents a point
  // somewhere between the native snapshot taken before the loop and the one
  // taken immediately after it. Compare against the closer bracket endpoint
  // instead of treating the older endpoint as simultaneous.
  const memoryAfterVmmap = await invokeTauriCommand(
    "get_app_memory_snapshot_v1"
  );
  if (memoryAfterVmmap.measurement !== "native") {
    throw new Error(
      `#435 regression: follow-up memory measurement was ${memoryAfterVmmap.measurement}`
    );
  }
  const afterBytes = Number(memoryAfterVmmap.effective_total_bytes ?? 0);
  const beforeBytesByPid = new Map(
    (memorySnapshot.processes ?? []).map((row) => [
      row.pid,
      Number(row.effective_memory_bytes ?? 0),
    ])
  );
  const afterBytesByPid = new Map(
    (memoryAfterVmmap.processes ?? []).map((row) => [
      row.pid,
      Number(row.effective_memory_bytes ?? 0),
    ])
  );
  let difference = 0;
  for (const [pid, processVmmapBytes] of vmmapBytesByPid) {
    const beforeProcessBytes = beforeBytesByPid.get(pid);
    const afterProcessBytes = afterBytesByPid.get(pid);
    if (beforeProcessBytes === undefined || afterProcessBytes === undefined) {
      throw new Error(
        `#435 regression: PID ${pid} changed during bracketed vmmap sampling`
      );
    }
    const lower = Math.min(beforeProcessBytes, afterProcessBytes);
    const upper = Math.max(beforeProcessBytes, afterProcessBytes);
    if (processVmmapBytes < lower) {
      difference += lower - processVmmapBytes;
    } else if (processVmmapBytes > upper) {
      difference += processVmmapBytes - upper;
    }
  }
  const tolerance = Math.max(vmmapBytes * 0.1, 50 * MIB);
  if (difference > tolerance) {
    throw new Error(
      `#435 regression: per-PID bracketed native snapshots and vmmap differ by ${(difference / MIB).toFixed(1)} MiB (before=${(baselineBytes / MIB).toFixed(1)} MiB, after=${(afterBytes / MIB).toFixed(1)} MiB, vmmap=${(vmmapBytes / MIB).toFixed(1)} MiB)`
    );
  }
  console.log(
    `[issue-443-real-codex] #435 native-before=${(baselineBytes / MIB).toFixed(1)} MiB native-after=${(afterBytes / MIB).toFixed(1)} MiB vmmap=${(vmmapBytes / MIB).toFixed(1)} MiB out-of-bracket=${(difference / MIB).toFixed(1)} MiB`
  );
}

async function logAcceptanceStep(label) {
  const [memory, state] = await Promise.all([
    invokeTauriCommand("get_app_memory_snapshot_v1"),
    invokeE2E("inspectChatState"),
  ]);
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
  const latestMarker = visibleMarkerForEvent(latestUserEvent);
  if (latestMarker) {
    await waitForChatTurn({
      markers: [latestMarker],
      label: "real Codex latest turn",
      visibleMarker: latestMarker,
    });
  }

  if (Number(latestWindow.totalTurnCount) < 6) {
    throw new Error(
      `real Issue 272 session exposed only ${latestWindow.totalTurnCount} turns`
    );
  }
  const expected = await loadExpectedTurnSummaries(
    sessionId,
    Number(latestWindow.totalTurnCount)
  );
  await logAcceptanceStep("compact-summaries-loaded");
  if (process.env.E2E_ISSUE_443_CONTINUOUS_ONLY === "1") {
    await assertContinuousIssue272ScrollBurst(
      Number(latestWindow.totalTurnCount)
    );
    return;
  }
  await setPaginationEnabledViaUi(true);
  await assertCompactCatalogBeforeBodyHydration(expected);
  await logAcceptanceStep("compact-catalog-closed");
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
  const marker = visibleMarkerForEvent(previousUserEvent);
  const previousBodyMarker = visibleAssistantMarkerForWindow(previousWindow);
  if (!marker || !previousBodyMarker) {
    throw new Error(
      `real Codex previous turn ${previousTurnIndex} lacked a visible header/body marker`
    );
  }
  await waitForChatTurn({
    markers: [previousBodyMarker],
    label: `real Codex previous turn ${previousTurnIndex}`,
    visibleMarker: previousBodyMarker,
    pinnedMarkers: [marker],
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
  await logAcceptanceStep("latest-round-restored");
  await assertContinuousIssue272ScrollBurst(
    Number(latestWindow.totalTurnCount)
  );
  await logAcceptanceStep("continuous-scroll-complete");
  await assertDirectOldRoundVisibleWithoutCorrectiveScroll(expected);
  await logAcceptanceStep("direct-old-round-visible");
}

function processMemoryRows(memorySnapshot) {
  return (memorySnapshot?.processes ?? []).map((processRow) => ({
    pid: processRow.pid,
    role: processRow.role,
    mib: Number(
      (Number(processRow.effective_memory_bytes ?? 0) / MIB).toFixed(1)
    ),
  }));
}

async function waitForStableNativeMemorySnapshot() {
  const maxAttempts = 12;
  const stableDifferenceBytes = 32 * MIB;
  let previous = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const current = await invokeTauriCommand("get_app_memory_snapshot_v1");
    const currentBytes = Number(current?.effective_total_bytes ?? 0);
    if (current?.measurement !== "native" || !(currentBytes > 0)) {
      throw new Error(
        `native memory baseline is unavailable: ${JSON.stringify(current)}`
      );
    }
    if (previous) {
      const previousPids = (previous.processes ?? [])
        .map((row) => row.pid)
        .sort((left, right) => left - right)
        .join(",");
      const currentPids = (current.processes ?? [])
        .map((row) => row.pid)
        .sort((left, right) => left - right)
        .join(",");
      const difference = Math.abs(
        currentBytes - Number(previous.effective_total_bytes ?? 0)
      );
      if (previousPids === currentPids && difference <= stableDifferenceBytes) {
        console.log(
          `[issue-443-real-codex] native baseline stabilized after ${attempt + 1} samples (delta=${(difference / MIB).toFixed(1)} MiB)`
        );
        return current;
      }
    }
    previous = current;
    await browser.pause(500);
  }
  throw new Error(
    `native memory baseline did not stabilize within ${maxAttempts} samples`
  );
}

export async function assertIssue443RealCodexSessionStaysBounded(sessionId) {
  if (!sessionId) {
    throw new Error(
      "E2E_ISSUE_443_REAL_CODEX_SESSION_ID is required for the real Codex acceptance scenario"
    );
  }

  await rescanCodexSource();
  await refreshSessionRosterViaUi();
  await selectByAgentFromRenderedMenu();
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
    const openedState = await openCodexSessionFromSidebar(
      sessionId,
      `real Codex cycle ${cycle}`
    );
    const eventCount = Number(openedState?.chatEventCount ?? 0);
    if (!(eventCount > 0 && eventCount <= REPLAY_MAX_EVENTS)) {
      throw new Error(
        `real Codex cycle ${cycle} hydrated ${eventCount} events; hard cap is ${REPLAY_MAX_EVENTS}`
      );
    }
    const memoryLatestWindowOpen = await invokeTauriCommand(
      "get_app_memory_snapshot_v1"
    );
    if (cycle === 0) {
      await assertFirstRenderedOpen(sessionId, openedState);
    }

    const memoryAfterAcceptance = await invokeTauriCommand(
      "get_app_memory_snapshot_v1"
    );
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
      acceptanceBytes: Number(
        memoryAfterAcceptance?.effective_total_bytes ?? 0
      ),
      acceptanceProcesses: processMemoryRows(memoryAfterAcceptance),
      releasedBytes: Number(memoryReleased?.effective_total_bytes ?? 0),
      releasedProcesses: processMemoryRows(memoryReleased),
    });
    if (process.env.E2E_ISSUE_443_CONTINUOUS_ONLY === "1") {
      return;
    }
  }

  const firstWindowGrowth = Math.max(
    0,
    samples[0].latestWindowOpenBytes - baselineBytes
  );
  const firstAcceptanceGrowth = Math.max(
    0,
    samples[0].acceptanceBytes - baselineBytes
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
    `[issue-443-real-codex] baseline=${(baselineBytes / MIB).toFixed(1)} MiB firstWindowGrowth=${(firstWindowGrowth / MIB).toFixed(1)} MiB firstAcceptanceGrowth=${(firstAcceptanceGrowth / MIB).toFixed(1)} MiB settledGrowth=${(settledGrowth / MIB).toFixed(1)} MiB measuredStepGrowth=${(stepGrowth / MIB).toFixed(1)} MiB backendStepGrowth=${backendStepGrowthMib.toFixed(1)} MiB samples=${JSON.stringify(samples)} idleSamples=${JSON.stringify(idleReleaseSamples)}`
  );

  if (firstWindowGrowth > 400 * MIB) {
    throw new Error(
      `real Codex first bounded window grew Physical Footprint by ${(firstWindowGrowth / MIB).toFixed(1)} MiB`
    );
  }
  if (firstAcceptanceGrowth > 400 * MIB) {
    throw new Error(
      `real Codex first full acceptance interaction grew Physical Footprint by ${(firstAcceptanceGrowth / MIB).toFixed(1)} MiB`
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

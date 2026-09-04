import fs from "node:fs";
import path from "node:path";

import {
  clickMainAction,
  waitForRuntimeIdle,
  waitForWorkingTurn,
} from "./agentQueuedControlScenarios.mjs";
import {
  QUEUE_TIMEOUT_MS,
  REPLY_TIMEOUT_MS,
  assertLiveAssistantOverlayOrdering,
  assertNoDurableLiveStreamPlaceholders,
  assertTurnSummaryOrdering,
  clickByTestId,
  configureScenario,
  execJS,
  inspectChatState,
  invokeE2E,
  js,
  stopActiveTurnIfNeeded,
  summarizeChatState,
  typeAndClickSend,
  unwrap,
  waitForActiveSession,
  waitForChatInput,
  waitForChatLaunched,
  waitForModePill,
} from "./agentQueuedFollowupDriver.mjs";
import {
  assertNoImplementationFilesCreated,
  clickUndoAllAndConfirm,
  createTempRepo,
  listWorkspaceFiles,
  waitForFileChangesPanel,
  waitForMarkerFile,
} from "./agentQueuedWorkspaceHelpers.mjs";
import { PLAN_FORBIDDEN_PROMPT_TOOL_NAMES } from "./toolCoverage.mjs";

function providerCapacityRuntimeError(state) {
  const runtimeError = String(state?.runtimeError ?? "");
  const normalized = runtimeError.toLowerCase();
  if (
    !normalized.includes("rate limit") &&
    !normalized.includes("rate_limit") &&
    !normalized.includes("too many requests") &&
    !normalized.includes("quota") &&
    !normalized.includes("capacity") &&
    !normalized.includes("429") &&
    !normalized.includes("404 not found") &&
    !normalized.includes("model not found") &&
    !normalized.includes("requested entity was not found")
  ) {
    return null;
  }
  return runtimeError;
}

async function failFastProviderCapacity(label) {
  const state = await inspectChatState(`${label}-provider-capacity-check`);
  const runtimeError = providerCapacityRuntimeError(state);
  if (runtimeError) {
    throw new Error(
      `${label} provider capacity blocked plan wait: ${runtimeError}; state=${JSON.stringify(summarizeChatState(state))}`
    );
  }
}

async function assertNoProviderCapacityBlock(label) {
  await failFastProviderCapacity(label);
}

async function assertPlanModePromptTools(label) {
  await waitForActiveSession(`${label}-tool-schema`);
  const active = unwrap(
    await invokeE2E("getActiveSessionId"),
    `${label}-getActiveSessionId`
  );
  if (!active.sessionId) {
    throw new Error(`${label} has no active session for tool schema assertion`);
  }

  let snapshotResult = null;
  await browser.waitUntil(
    async () => {
      try {
        const result = await invokeE2E(
          "debugSessionToolsSnapshot",
          active.sessionId
        );
        if (result?.ok) {
          snapshotResult = result;
          return true;
        }
      } catch {
        return false;
      }
      return false;
    },
    {
      timeout: 30_000,
      interval: 1_000,
      timeoutMsg: `${label} debugSessionToolsSnapshot never became available; state=${JSON.stringify(summarizeChatState(await invokeE2E("inspectChatState")))}`,
    }
  );

  const promptToolNames = snapshotResult?.snapshot?.promptToolNames ?? [];
  if (!Array.isArray(promptToolNames)) {
    throw new Error(
      `${label} Plan mode prompt tools snapshot is not an array; snapshot=${JSON.stringify(snapshotResult.snapshot)}`
    );
  }

  const forbiddenPromptTools = PLAN_FORBIDDEN_PROMPT_TOOL_NAMES.filter(
    (toolName) => promptToolNames.includes(toolName)
  );
  if (forbiddenPromptTools.length > 0) {
    throw new Error(
      `${label} Plan mode prompt tools expose write/build-only tools ${JSON.stringify(forbiddenPromptTools)}; promptToolNames=${JSON.stringify(promptToolNames)} snapshot=${JSON.stringify(snapshotResult.snapshot)}`
    );
  }
  if (!promptToolNames.includes("create_plan")) {
    throw new Error(
      `${label} Plan mode prompt tools do not expose create_plan; promptToolNames=${JSON.stringify(promptToolNames)} snapshot=${JSON.stringify(snapshotResult.snapshot)}`
    );
  }
}

async function showChatTranscriptSurface() {
  await execJS(`
    const chatTab = document.querySelector('[data-testid="replay-tab-chat"]');
    if (chatTab) chatTab.click();
    return true;
  `);
  await browser.pause(100);
}

async function tryWaitForPlanCardReady(label, timeout = REPLY_TIMEOUT_MS) {
  try {
    let navigatedRevisionId = null;
    await showChatTranscriptSurface();
    await browser.waitUntil(
      async () => {
        const ui = await execJS(js.planUi);
        const transcriptBuildReady =
          ui.readyCardCount >= 1 && ui.enabledBuildButtonCount >= 1;
        if (transcriptBuildReady || ui.planDocBuildEnabled) return true;

        const state = await inspectChatState(`${label}-plan-ready`);
        const revisionId = planRevisionIdentity(state.pendingPlan);
        if (
          revisionId &&
          revisionId !== navigatedRevisionId &&
          ui.readyCardCount >= 1 &&
          ui.visibleNavigateButtonCount > 0
        ) {
          navigatedRevisionId = revisionId;
          await clickPlanNavigateByRevision(
            `${label}-auto-preview`,
            revisionId
          );
        }
        return false;
      },
      {
        timeout,
        interval: 2_000,
        timeoutMsg: `${label} plan card never became ready; state=${JSON.stringify(summarizeChatState(await invokeE2E("inspectChatState")))} ui=${JSON.stringify(await execJS(js.planUi))}`,
      }
    );
    return true;
  } catch {
    return false;
  }
}

async function waitForPlanCardReady(label) {
  const ready = await tryWaitForPlanCardReady(label);
  if (!ready) {
    throw new Error(
      `${label} plan card never became ready; state=${JSON.stringify(summarizeChatState(await invokeE2E("inspectChatState")))} ui=${JSON.stringify(await execJS(js.planUi))}`
    );
  }
}

async function assertCurrentTurnPlanStaysExpandedInTranscript(label) {
  const state = await inspectChatState(`${label}-current-turn-plan-surface`);
  const revisionId = planRevisionIdentity(state.pendingPlan);
  const ui = await execJS(js.planUi);
  const transcriptMatches = ui.transcriptCardRevisionIds.filter(
    (candidate) => candidate === revisionId
  );
  const currentMatches = ui.currentCardRevisionIds.filter(
    (candidate) => candidate === revisionId
  );
  const transcriptCollapsedStates = ui.transcriptCardCollapsedStates.filter(
    (_collapsedState, index) =>
      ui.transcriptCardRevisionIds[index] === revisionId
  );

  if (
    !revisionId ||
    transcriptMatches.length !== 1 ||
    currentMatches.length !== 0 ||
    transcriptCollapsedStates.some(
      (collapsedState) => collapsedState !== "false"
    )
  ) {
    throw new Error(
      `${label} current-turn plan must stay expanded in transcript, not pinned current; revision=${revisionId} state=${JSON.stringify(summarizeChatState(state))} ui=${JSON.stringify(ui)}`
    );
  }
}

async function waitForPlanStreamingShellOrReady(label) {
  await showChatTranscriptSurface();
  const shortTimeoutMs = 15_000;
  let sawDraftingCard = false;
  let sawAnyPlanSurface = false;

  try {
    await browser.waitUntil(
      async () => {
        await showChatTranscriptSurface();
        const ui = await execJS(js.planUi);
        const hasDraftingCard =
          ui.draftingCardCount > 0 &&
          ui.readyCardCount === 0 &&
          ui.enabledBuildButtonCount === 0;
        const hasReadyPlan =
          (ui.readyCardCount >= 1 && ui.enabledBuildButtonCount >= 1) ||
          ui.planDocBuildEnabled;
        sawDraftingCard ||= hasDraftingCard;
        sawAnyPlanSurface ||= hasDraftingCard || hasReadyPlan;
        return sawAnyPlanSurface;
      },
      {
        timeout: shortTimeoutMs,
        interval: 500,
        timeoutMsg: `${label} plan shell did not stream within ${shortTimeoutMs}ms`,
      }
    );
  } catch {
    const state = summarizeChatState(await invokeE2E("inspectChatState"));
    const ui = await execJS(js.planUi);
    console.warn(
      `[e2e-plan-diagnostic] ${label} no plan surface after ${shortTimeoutMs}ms state=${JSON.stringify(state)} ui=${JSON.stringify(ui)}`
    );
  }

  return { sawDraftingCard };
}

async function startPlanDraftObserver() {
  await execJS(`
    if (window.__orgiiPlanDraftObserver) {
      window.__orgiiPlanDraftObserver.disconnect();
    }
    window.__orgiiPlanDraftObserved = false;
    window.__orgiiPlanDraftObserver = new MutationObserver(() => {
      const cards = Array.from(document.querySelectorAll('[data-testid="create-plan-card"]'));
      if (cards.some((card) => card.getAttribute('data-plan-ready') !== 'true')) {
        window.__orgiiPlanDraftObserved = true;
      }
    });
    window.__orgiiPlanDraftObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-plan-ready']
    });
    return true;
  `);
}

async function stopPlanDraftObserver() {
  return execJS(`
    const observed = Boolean(window.__orgiiPlanDraftObserved);
    if (window.__orgiiPlanDraftObserver) {
      window.__orgiiPlanDraftObserver.disconnect();
      window.__orgiiPlanDraftObserver = null;
    }
    return observed;
  `).catch(() => false);
}

async function waitForPlanShellVisible(label) {
  const streaming = await waitForPlanStreamingShellOrReady(label);
  await browser.waitUntil(
    async () => {
      await showChatTranscriptSurface();
      const ui = await execJS(js.planUi);
      const hasVisiblePlanSurface =
        ui.cardCount > 0 || ui.communicationPlanRowCount > 0 || ui.planDocPanel;
      const hasReadablePreview =
        !ui.planDocPanel || String(ui.planDocText ?? "").trim().length > 0;
      return hasVisiblePlanSurface && hasReadablePreview;
    },
    {
      timeout: REPLY_TIMEOUT_MS,
      interval: 500,
      timeoutMsg: `${label} plan shell never became visible/readable; state=${JSON.stringify(summarizeChatState(await invokeE2E("inspectChatState")))} ui=${JSON.stringify(await execJS(js.planUi))}`,
    }
  );

  const observerSawDraftingCard = await stopPlanDraftObserver();
  if (!streaming.sawDraftingCard && !observerSawDraftingCard) {
    const ui = await execJS(js.planUi);
    console.warn(
      `[e2e-plan-diagnostic] ${label} provider completed before WebDriver observed a drafting plan card; ui=${JSON.stringify(ui)} state=${JSON.stringify(summarizeChatState(await invokeE2E("inspectChatState")))}`
    );
  }
}

async function clickPlanNavigateByRevision(label, revisionId) {
  const clickResultScript = `
    const revisionId = ${JSON.stringify(revisionId)};
    const currentCards = Array.from(document.querySelectorAll('[data-testid="create-plan-card"][data-plan-surface="current"]'));
    const currentCard = currentCards.find((candidate) => candidate.getAttribute('data-plan-revision-id') === revisionId);
    const planDoc = document.querySelector('[data-testid="plan-doc-panel"]');
    const planDocCurrent = planDoc?.getAttribute('data-plan-revision-id') === revisionId;
    if (currentCard || planDocCurrent) return { ok: true, reason: 'already-current' };

    const allRows = Array.from(document.querySelectorAll('[data-testid="plan-interaction-row"]'));
    const transcriptCards = Array.from(document.querySelectorAll('[data-testid="create-plan-card"]')).filter(
      (candidate) => candidate.getAttribute('data-plan-surface') !== 'current'
    );
    const cards = [...allRows, ...transcriptCards];
    const card = cards.find((candidate) => candidate.getAttribute('data-plan-revision-id') === revisionId);
    if (!card) return { ok: false, reason: 'missing-card', cardRevisionIds: cards.map((candidate) => candidate.getAttribute('data-plan-revision-id') || '') };
    const button = card.querySelector('[data-testid="event-navigate"]');
    if (!button) return { ok: false, reason: 'missing-button' };
    button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window, button: 0 }));
    button.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window, button: 0 }));
    button.click();
    return { ok: true };
  `;
  let result = await execJS(clickResultScript);
  if (!result?.ok && result?.reason === "missing-card") {
    await execJS(`
      const chatTab = document.querySelector('[data-testid="replay-tab-chat"]');
      if (chatTab) chatTab.click();
      return true;
    `);
    await browser.pause(100);
    result = await execJS(clickResultScript);
  }
  if (!result?.ok) {
    throw new Error(
      `${label} could not click plan preview navigate for revision ${revisionId}; result=${JSON.stringify(result)} ui=${JSON.stringify(await execJS(js.planUi))}`
    );
  }
}

async function waitForPlanRevisionSelected(label, revisionId) {
  await browser.waitUntil(
    async () => {
      const ui = await execJS(js.planUi);
      return (
        ui.planDocRevisionId === revisionId ||
        ui.currentCardRevisionIds.includes(revisionId) ||
        ui.transcriptCardRevisionIds.includes(revisionId)
      );
    },
    {
      timeout: 20_000,
      interval: 500,
      timeoutMsg: `${label} selected plan revision did not remain visible; revision=${revisionId} ui=${JSON.stringify(await execJS(js.planUi))}`,
    }
  );
}

function assertRevisionOrderInSurface(
  label,
  surfaceName,
  revisionIds,
  firstPlan,
  secondPlan
) {
  const firstIndex = revisionIds.indexOf(firstPlan.revisionId);
  const secondIndex = revisionIds.indexOf(secondPlan.revisionId);
  if (firstIndex === -1 || secondIndex === -1) return;
  if (firstIndex > secondIndex) {
    throw new Error(
      `${label} archived plan rendered after the newer plan in ${surfaceName}; revisions=${JSON.stringify(revisionIds)} first=${firstPlan.revisionId} second=${secondPlan.revisionId}`
    );
  }
}

async function assertPlanRevisionOrder(label, firstPlan, secondPlan) {
  const ui = await execJS(js.planUi);
  assertRevisionOrderInSurface(
    label,
    "chat history",
    ui.chatHistoryCardRevisionIds,
    firstPlan,
    secondPlan
  );
  assertRevisionOrderInSurface(
    label,
    "transcript cards",
    ui.transcriptCardRevisionIds,
    firstPlan,
    secondPlan
  );
}

async function waitForPlanRevisionVisible(label, revisionId) {
  await browser.waitUntil(
    async () => {
      const ui = await execJS(js.planUi);
      const allRevisionIds = [
        ...ui.currentCardRevisionIds,
        ...ui.transcriptCardRevisionIds,
        ui.planDocRevisionId,
      ].filter(Boolean);
      return allRevisionIds.includes(revisionId);
    },
    {
      timeout: 20_000,
      interval: 500,
      timeoutMsg: `${label} plan revision did not become visible; revision=${revisionId} ui=${JSON.stringify(await execJS(js.planUi))} state=${JSON.stringify(summarizeChatState(await invokeE2E("inspectChatState")))}`,
    }
  );
}

async function assertPlanPreviewNavigation(label, firstPlan, secondPlan) {
  await waitForPlanRevisionVisible(
    `${label}-latest-visible`,
    secondPlan.revisionId
  );
  const ui = await execJS(js.planUi);
  const allRevisionIds = [
    ...ui.currentCardRevisionIds,
    ...ui.transcriptCardRevisionIds,
    ui.planDocRevisionId,
  ].filter(Boolean);
  const firstVisible = allRevisionIds.includes(firstPlan.revisionId);
  const secondVisible = allRevisionIds.includes(secondPlan.revisionId);
  if (!secondVisible) {
    throw new Error(
      `${label} latest plan revision is not visible; second=${secondPlan.revisionId} ui=${JSON.stringify(ui)}`
    );
  }

  const latestBuildable =
    (ui.planDocBuildEnabled &&
      ui.planDocRevisionId === secondPlan.revisionId) ||
    (ui.enabledBuildRevisionIds ?? []).includes(secondPlan.revisionId);
  if (!latestBuildable) {
    throw new Error(
      `${label} latest plan revision was not buildable before preview navigation; ui=${JSON.stringify(ui)}`
    );
  }

  if (firstVisible) {
    await clickPlanNavigateByRevision(
      `${label}-first-preview`,
      firstPlan.revisionId
    );
    await waitForPlanRevisionSelected(
      `${label}-first-preview`,
      firstPlan.revisionId
    );
    const firstPreview = await execJS(js.planUi);
    if (firstPreview.planDocBuildEnabled) {
      throw new Error(
        `${label} archived plan preview remained buildable; ui=${JSON.stringify(firstPreview)}`
      );
    }
  }
}

function hasDuplicateNonEmptyValues(values) {
  const nonEmptyValues = values.filter(Boolean);
  return new Set(nonEmptyValues).size !== nonEmptyValues.length;
}

async function assertPlanCardDedupe(label) {
  await browser.waitUntil(
    async () => {
      const ui = await execJS(js.planUi);
      const state = await invokeE2E("inspectChatState");
      const pinnedCollapsed =
        ui.currentCardCollapsedStates.length === 0 ||
        ui.currentCardCollapsedStates.every(
          (cardState) => cardState === "true"
        );
      const runtimeStillActive = ["running", "installing"].includes(
        state?.runtimeStatus
      );
      return (
        ui.currentCardCount <= 1 &&
        ui.currentDraftCardCount === 0 &&
        ui.planningFooterCount === 0 &&
        !runtimeStillActive &&
        pinnedCollapsed &&
        !hasDuplicateNonEmptyValues(ui.currentCardRevisionIds) &&
        !hasDuplicateNonEmptyValues(ui.chatHistoryCardRevisionIds)
      );
    },
    {
      timeout: 10_000,
      interval: 500,
      timeoutMsg: `${label} plan card rendered incorrectly; ui=${JSON.stringify(await execJS(js.planUi))} state=${JSON.stringify(summarizeChatState(await invokeE2E("inspectChatState")))}`,
    }
  );
}

function isProviderCapacityText(text) {
  const normalized = String(text ?? "").toLowerCase();
  return (
    normalized.includes("429") ||
    normalized.includes("too many requests") ||
    normalized.includes("quota_exhausted") ||
    normalized.includes("rate limit") ||
    normalized.includes("rate limited") ||
    normalized.includes("overloaded") ||
    normalized.includes("provider overloaded") ||
    normalized.includes("404 not found") ||
    normalized.includes("model not found") ||
    normalized.includes("requested entity was not found")
  );
}

function extractProviderCapacityText(state) {
  const candidates = [state?.runtimeError];
  for (const event of state?.rawEvents ?? []) {
    if (event.source === "user") continue;
    if (event.resultStatus === "error") {
      candidates.push(event.displayText, event.result, event.args);
    }
  }
  for (const event of state?.chatEvents ?? []) {
    if (event.source === "user") continue;
    if (event.displayVariant === "error") {
      candidates.push(event.displayText);
    }
  }
  const providerText = candidates.find(isProviderCapacityText);
  return providerText ? String(providerText).slice(0, 1200) : null;
}

function streamProgressSnapshot(state, finalText = null) {
  const finalMarker = finalText ? String(finalText) : null;
  const chatUnits = (state.chatEvents ?? [])
    .filter((event) => {
      if (event.displayVariant === "thinking") return true;
      if (event.source !== "assistant" || event.displayVariant !== "message") {
        return false;
      }
      return (
        !finalMarker || !String(event.displayText ?? "").includes(finalMarker)
      );
    })
    .map((event) => ({
      id: event.id,
      source: event.source,
      displayVariant: event.displayVariant,
      functionName: "chat_event",
      textLength: String(event.displayText ?? "").trim().length,
      textPrefix: normalizeEventText(event.displayText).slice(0, 80),
    }));
  const rawUnits = (state.rawEvents ?? [])
    .filter(
      (event) =>
        event.actionType === "tool_call" ||
        (event.source === "assistant" &&
          ["assistant_message", "agent_message", "message"].includes(
            event.functionName
          ) &&
          (!finalMarker ||
            !String(event.displayText ?? "").includes(finalMarker)))
    )
    .map((event) => ({
      id: event.id,
      source: event.source,
      actionType: event.actionType,
      uiCanonical: event.uiCanonical,
      functionName: event.functionName,
      activityStatus: event.activityStatus,
      resultStatus: event.resultStatus,
      textLength: String(event.displayText ?? "").trim().length,
      textPrefix: normalizeEventText(event.displayText).slice(0, 80),
    }));
  const liveDeltaLength = state.streamingDelta?.length ?? 0;
  const liveDeltaText = String(state.streamingDelta?.text ?? "");
  const units = [...chatUnits, ...rawUnits];
  return {
    running: state.isSessionActive || state.runtimeStatus === "running",
    totalUnits: units.length,
    totalTextLength:
      liveDeltaLength + units.reduce((sum, unit) => sum + unit.textLength, 0),
    liveDeltaLength,
    liveDeltaPrefix: normalizeEventText(liveDeltaText).slice(0, 80),
    signature: JSON.stringify({ units, liveDeltaLength, liveDeltaText }),
    units: units.slice(-8),
  };
}

function isIncrementalStreamProgress(previous, next) {
  return (
    next.running &&
    previous &&
    next.signature !== previous.signature &&
    (next.totalUnits > previous.totalUnits ||
      next.totalTextLength > previous.totalTextLength)
  );
}

function hasRunningToolFeedback(snapshot) {
  return (
    snapshot.running &&
    snapshot.units.some((unit) => unit.actionType === "tool_call")
  );
}

function hasObservableLiveDelta(snapshot) {
  return snapshot.liveDeltaLength > 0;
}

async function waitForIntermediateStreamEvents(label, finalText = null) {
  let providerCapacityText = null;
  let firstSnapshot = null;
  let latestSnapshot = null;
  let sawIncrementalProgress = false;
  let sawRunningToolFeedback = false;
  let sawObservableLiveDelta = false;
  await browser.waitUntil(
    async () => {
      const state = await inspectChatState(`${label}-intermediate-stream`);
      providerCapacityText = extractProviderCapacityText(state);
      if (providerCapacityText) return true;
      const snapshot = streamProgressSnapshot(state, finalText);
      latestSnapshot = snapshot;

      if (snapshot.totalUnits > 0 || snapshot.totalTextLength > 0) {
        if (!firstSnapshot) {
          firstSnapshot = snapshot;
        }
        if (hasObservableLiveDelta(snapshot)) {
          sawObservableLiveDelta = true;
          return true;
        }
        if (hasRunningToolFeedback(snapshot)) {
          sawRunningToolFeedback = true;
          return true;
        }
        if (isIncrementalStreamProgress(firstSnapshot, snapshot)) {
          sawIncrementalProgress = true;
          return true;
        }
      }

      const finalTextSeen = finalText
        ? (state.chatEvents ?? []).some(
            (event) =>
              event.source !== "user" &&
              String(event.displayText ?? "").includes(finalText)
          ) ||
          (state.rawEvents ?? []).some(
            (event) =>
              event.source !== "user" &&
              String(event.displayText ?? "").includes(finalText)
          )
        : false;
      const hasAssistantOrToolEvent = (state.chatEvents ?? []).some(
        (event) => event.source !== "user"
      );
      const turnEnded =
        hasAssistantOrToolEvent &&
        !state.isSessionActive &&
        state.runtimeStatus !== "running";
      return turnEnded || finalTextSeen;
    },
    {
      timeout: REPLY_TIMEOUT_MS,
      interval: 500,
      timeoutMsg: `${label} did not reach incremental streaming or turn completion; first=${JSON.stringify(firstSnapshot)} latest=${JSON.stringify(latestSnapshot)} state=${JSON.stringify(summarizeChatState(await invokeE2E("inspectChatState")))} ui=${JSON.stringify(await execJS(js.planUi))}`,
    }
  );
  if (providerCapacityText) {
    throw new Error(
      `${label} hit retryable provider capacity before incremental streaming progress: ${providerCapacityText}`
    );
  }
  if (
    !sawIncrementalProgress &&
    !sawObservableLiveDelta &&
    !sawRunningToolFeedback
  ) {
    throw new Error(
      `${label} completed without observable incremental streaming progress, live delta, or running tool feedback; first=${JSON.stringify(firstSnapshot)} latest=${JSON.stringify(latestSnapshot)} state=${JSON.stringify(summarizeChatState(await invokeE2E("inspectChatState")))} ui=${JSON.stringify(await execJS(js.planUi))}`
    );
  }
  await assertLiveAssistantOverlayOrdering(label);
  await assertTurnSummaryOrdering(label);
  await assertNoDurableLiveStreamPlaceholders(label);
}

async function waitForPlanCardGone(label) {
  await browser.waitUntil(
    async () => {
      const ui = await execJS(js.planUi);
      const state = await invokeE2E("inspectChatState");
      return (
        ui.currentCardCount === 0 &&
        ui.enabledBuildButtonCount === 0 &&
        !ui.planDocBuild &&
        !ui.planDocEdit &&
        !state?.pendingPlan
      );
    },
    {
      timeout: 30_000,
      interval: 1_000,
      timeoutMsg: `${label} stale buildable plan UI remained after Build/archive; state=${JSON.stringify(summarizeChatState(await invokeE2E("inspectChatState")))} ui=${JSON.stringify(await execJS(js.planUi))}`,
    }
  );
}

async function clickPlanBuild(label) {
  await waitForPlanCardReady(label);
  const ui = await execJS(js.planUi);
  if (ui.planDocBuildEnabled) {
    await clickByTestId("plan-doc-build", `${label} plan Build`);
    return;
  }
  await clickByTestId("create-plan-build", `${label} plan Build`);
}

function normalizeEventText(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

async function assertNoDuplicateThinkingPlaceholders(label) {
  const state = await inspectChatState(`${label}-thinking-dedup`);
  const thinkingEvents = (state.chatEvents ?? []).filter(
    (event) => event.displayVariant === "thinking"
  );
  const authoritativeTexts = new Set(
    thinkingEvents
      .filter(
        (event) =>
          typeof event.id === "string" &&
          event.id.startsWith("stream-think-") &&
          !event.id.startsWith("stream-think-ts-")
      )
      .map((event) => normalizeEventText(event.displayText))
      .filter((text) => text.length > 20)
  );
  const duplicatedPlaceholder = thinkingEvents.find((event) => {
    if (
      typeof event.id !== "string" ||
      !event.id.startsWith("stream-think-ts-")
    ) {
      return false;
    }
    const text = normalizeEventText(event.displayText);
    return text.length > 20 && authoritativeTexts.has(text);
  });

  if (duplicatedPlaceholder) {
    throw new Error(
      `${label} duplicated thinking placeholder beside authoritative event; duplicate=${JSON.stringify(
        {
          id: duplicatedPlaceholder.id,
          text: normalizeEventText(duplicatedPlaceholder.displayText).slice(
            0,
            180
          ),
        }
      )} state=${JSON.stringify(summarizeChatState(state))}`
    );
  }
}

async function assertTodoUiIfTodoToolAppeared(label) {
  const state = await inspectChatState(`${label}-todo`);
  const hasTodoTool = state.toolEvents.some(
    (event) =>
      event.functionName === "manage_todo" ||
      event.uiCanonical === "manage_todo"
  );
  if (!hasTodoTool) return;

  await browser.waitUntil(
    async () => {
      const nextState = await inspectChatState(`${label}-todo-visible`);
      const ui = await execJS(js.planUi);
      return nextState.pinnedTodoCount > 0 || ui.pinnedTodo || ui.todoKanban;
    },
    {
      timeout: 30_000,
      interval: 1_000,
      timeoutMsg: `${label} manage_todo appeared but todo UI did not render; state=${JSON.stringify(summarizeChatState(await invokeE2E("inspectChatState")))} ui=${JSON.stringify(await execJS(js.planUi))}`,
    }
  );
}

function planRequestContent(markerFile, markerText, label) {
  return [
    "# ORGII Plan Request",
    "",
    `Scenario: ${label}`,
    "",
    "Draft an implementation plan for approval before making any implementation change.",
    "The approved Build phase must make exactly one low-risk filesystem change.",
    `Acceptance artifact: ${markerFile}`,
    `Expected content: ${markerText}`,
    "Plan constraints: under 120 words, no code blocks, no tables.",
    "Do not create the acceptance artifact until the Build phase is approved.",
  ].join("\n");
}

function writePlanRequest(repoPath, markerFile, markerText, label) {
  const content = planRequestContent(markerFile, markerText, label);
  fs.writeFileSync(
    path.join(repoPath, "ORGII_PLAN_REQUEST.md"),
    content,
    "utf8"
  );
  return content;
}

function updatePlanRequest(repoPath, markerFile, markerText, label) {
  return writePlanRequest(repoPath, markerFile, markerText, label);
}

function planPromptForConfig(config, requestContent) {
  const compactRequest = requestContent
    .replace(/^# ORGII Plan Request Scenario:[^\n]+\n?/, "")
    .replace(/\s+/g, " ")
    .trim();
  return [
    `Use these inline requirements as the complete source of truth for ${config.label}:`,
    compactRequest,
    "Research is complete; do not answer in prose.",
    "Immediately submit a concise buildable Plan approval card before doing implementation work.",
  ].join(" ");
}

async function ensurePlanCardReadyAfterPrompt(label) {
  const firstAttemptTimeoutMs = 30_000;
  if (await tryWaitForPlanCardReady(label, firstAttemptTimeoutMs)) return;

  const state = await inspectChatState(`${label}-plan-ready-no-correction`);
  if (planRevisionIdentity(state.pendingPlan)) {
    await waitForPlanCardReady(`${label}-existing-plan`);
    return;
  }

  throw new Error(
    `${label} did not produce a buildable plan card from the original user request; state=${JSON.stringify(summarizeChatState(state))} ui=${JSON.stringify(await execJS(js.planUi))}`
  );
}

function planRevisionIdentity(pendingPlan) {
  return pendingPlan?.planRevisionId ?? pendingPlan?.toolCallId ?? null;
}

async function tryWaitForPendingPlanRevisionChange(
  label,
  previousRevisionId,
  timeout = REPLY_TIMEOUT_MS
) {
  try {
    await waitForPendingPlanRevisionChange(label, previousRevisionId, timeout);
    return true;
  } catch {
    return false;
  }
}

async function waitForPendingPlanRevisionChange(
  label,
  previousRevisionId,
  timeout = REPLY_TIMEOUT_MS
) {
  await browser.waitUntil(
    async () => {
      const state = await inspectChatState(`${label}-pending-plan`);
      const runtimeError = providerCapacityRuntimeError(state);
      if (runtimeError) {
        throw new Error(
          `${label} provider capacity blocked plan revision change: ${runtimeError}; state=${JSON.stringify(summarizeChatState(state))}`
        );
      }
      const currentRevisionId = planRevisionIdentity(state.pendingPlan);
      return !!currentRevisionId && currentRevisionId !== previousRevisionId;
    },
    {
      timeout,
      interval: 2_000,
      timeoutMsg: `${label} pending plan did not update; previous=${JSON.stringify(previousRevisionId)} state=${JSON.stringify(summarizeChatState(await invokeE2E("inspectChatState")))} ui=${JSON.stringify(await execJS(js.planUi))}`,
    }
  );
}

async function editFirstUserMessageAndResend(label, prompt) {
  await showChatTranscriptSurface();
  await browser.waitUntil(
    async () => {
      const state = await execJS(`
        const visible = (node) => {
          if (!node) return false;
          const rect = node.getBoundingClientRect();
          const style = window.getComputedStyle(node);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const chatList = document.querySelector('[data-testid="chat-message-list"]');
        const editable = chatList
          ? Array.from(chatList.querySelectorAll('[data-testid="chat-message-user-editable"]')).filter(visible)
          : [];
        if (editable.length > 0) {
          return { editableCount: editable.length, movedRound: false, movedLast: false, expandedTurn: false };
        }

        const collapsedTurnHeader = Array.from(document.querySelectorAll('div')).find((node) => {
          if (!visible(node)) return false;
          if (!String(node.className || '').includes('group/chat-block-header')) return false;
          const text = node.textContent || '';
          return text.includes('Agent worked for');
        });
        if (collapsedTurnHeader) {
          collapsedTurnHeader.click();
          return { editableCount: 0, movedRound: false, movedLast: false, expandedTurn: true };
        }

        const previousRound = document.querySelector('[data-testid="turn-pagination-previous-round"]');
        if (previousRound && !previousRound.disabled) {
          previousRound.click();
          return { editableCount: 0, movedRound: true, movedLast: false, expandedTurn: false };
        }

        const lastRound = document.querySelector('[data-testid="turn-pagination-last-round"]');
        if (lastRound && !lastRound.disabled) {
          lastRound.click();
          return { editableCount: 0, movedRound: false, movedLast: true, expandedTurn: false };
        }

        return {
          editableCount: 0,
          movedRound: false,
          movedLast: false,
          expandedTurn: false,
          roundLabel: document.querySelector('[data-testid="turn-pagination-current-round"]')?.textContent || '',
          chatListUserEditableTotal: chatList?.querySelectorAll('[data-testid="chat-message-user-editable"]').length ?? 0,
          userEditableTotal: document.querySelectorAll('[data-testid="chat-message-user-editable"]').length,
          collapsedTurnHeaderCount: Array.from(document.querySelectorAll('div')).filter((node) => String(node.className || '').includes('group/chat-block-header') && (node.textContent || '').includes('Agent worked for')).length,
          chatListText: chatList?.textContent?.slice(0, 1500) || '',
          bodyText: (document.body.innerText || '').slice(0, 1500),
        };
      `);
      if (state.movedRound || state.movedLast || state.expandedTurn) {
        await browser.pause(500);
        await showChatTranscriptSurface();
      }
      return state.editableCount > 0;
    },
    {
      timeout: 30_000,
      interval: 500,
      timeoutMsg: `${label} previous round edit entry did not appear before edit; round=${JSON.stringify(await execJS(`return document.querySelector('[data-testid="turn-pagination-current-round"]')?.textContent || ''`))} ui=${JSON.stringify(await execJS(js.planUi))} page=${JSON.stringify(await execJS(`const chatList = document.querySelector('[data-testid="chat-message-list"]'); return { chatListUserEditableTotal: chatList?.querySelectorAll('[data-testid="chat-message-user-editable"]').length ?? 0, userEditableTotal: document.querySelectorAll('[data-testid="chat-message-user-editable"]').length, userEditButtonTotal: document.querySelectorAll('[data-testid="chat-message-user-edit-button"]').length, collapsedTurnHeaderCount: Array.from(document.querySelectorAll('div')).filter((node) => String(node.className || '').includes('group/chat-block-header') && (node.textContent || '').includes('Agent worked for')).length, chatListText: chatList?.textContent?.slice(0, 1500) || '', bodyText: (document.body.innerText || '').slice(0, 1500) };`))}`,
    }
  );
  const editClicked = await execJS(`
    const visible = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const chatList = document.querySelector('[data-testid="chat-message-list"]');
    const editButton = chatList
      ? Array.from(chatList.querySelectorAll('[data-testid="chat-message-user-edit-button"]')).find(visible)
      : null;
    if (editButton) {
      editButton.click();
      return 'clicked';
    }
    const user = chatList
      ? Array.from(chatList.querySelectorAll('[data-testid="chat-message-user-editable"]')).find(visible)
      : null;
    if (!user) return 'missing-edit-entry';
    user.click();
    return 'clicked';
  `);
  if (editClicked !== "clicked") {
    throw new Error(`${label} could not enter edit mode: ${editClicked}`);
  }

  await browser.waitUntil(
    async () => {
      const metrics = await execJS(`
        const root = document.querySelector('[data-testid="chat-input"]');
        const editor = root?.querySelector('[contenteditable="true"]');
        if (!root || !editor) return null;
        const rootRect = root.getBoundingClientRect();
        const editorRect = editor.getBoundingClientRect();
        return {
          rootWidth: rootRect.width,
          editorWidth: editorRect.width,
          editorScrollWidth: editor.scrollWidth,
          editorClientWidth: editor.clientWidth,
          rootScrollWidth: root.scrollWidth,
          rootClientWidth: root.clientWidth,
          text: editor.textContent || '',
        };
      `);
      if (!metrics) return false;
      const editorFits =
        metrics.editorScrollWidth <= metrics.editorClientWidth + 1;
      const rootFits = metrics.rootScrollWidth <= metrics.rootClientWidth + 1;
      if (!editorFits || !rootFits) {
        throw new Error(
          `${label} edit composer overflowed before resend; metrics=${JSON.stringify(metrics)}`
        );
      }
      return true;
    },
    {
      timeout: 5_000,
      interval: 250,
      timeoutMsg: `${label} edit composer did not mount for overflow assertion`,
    }
  );

  const inputSelector =
    '[data-testid="chat-message-edit-composer"] [contenteditable="true"]';
  await browser.waitUntil(async () => execJS(js.exists(inputSelector)), {
    timeout: 5_000,
    timeoutMsg: `${label} edit composer input did not mount`,
  });
  const beforeEditState = await inspectChatState(
    `${label}-before-edit-resend-click`
  );
  const typed = await execJS(js.clearAndType(inputSelector, prompt));
  if (!typed.includes(prompt)) {
    throw new Error(`${label} failed to type edited prompt: ${typed}`);
  }
  const resendClicked = await execJS(`
    const visible = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const editComposer = document.querySelector('[data-testid="chat-message-edit-composer"]');
    const buttons = Array.from((editComposer || document).querySelectorAll('button')).filter(visible);
    const resend = buttons.find((button) => (button.textContent || '').trim() === 'Resend');
    if (!resend) {
      return { clicked: false, buttons: buttons.map((button) => (button.textContent || '').trim()).filter(Boolean).slice(0, 20) };
    }
    resend.click();
    return { clicked: true };
  `);
  if (!resendClicked?.clicked) {
    throw new Error(
      `${label} could not click edit resend button: ${JSON.stringify(resendClicked)}`
    );
  }
  const revertClicked = await execJS(`
    const buttons = Array.from(document.querySelectorAll('button'));
    const revert = buttons.find((button) => (button.textContent || '').includes('Revert changes'));
    if (!revert) return 'not-open';
    revert.click();
    return 'clicked';
  `);
  if (revertClicked !== "not-open" && revertClicked !== "clicked") {
    throw new Error(`${label} revert dialog click failed: ${revertClicked}`);
  }

  await browser.waitUntil(
    async () => {
      const state = await inspectChatState(`${label}-after-edit-resend-click`);
      return (state.chatEvents ?? []).some(
        (event) =>
          event.source === "user" &&
          String(event.displayText ?? "").includes(prompt.slice(0, 120))
      );
    },
    {
      timeout: 30_000,
      interval: 500,
      timeoutMsg: `${label} edit resend did not append replacement prompt; clicked=${JSON.stringify(resendClicked)} before=${JSON.stringify(summarizeChatState(beforeEditState))} after=${JSON.stringify(summarizeChatState(await invokeE2E("inspectChatState")))}`,
    }
  );
}

async function waitForPlanRevisionCleared(label, staleRevisionId) {
  await browser.waitUntil(
    async () => {
      const state = await inspectChatState(`${label}-cleared`);
      const ui = await execJS(js.planUi);
      const currentRevisionId = planRevisionIdentity(state.pendingPlan);
      const staleBuildableCard = await execJS(`
        return Array.from(document.querySelectorAll('[data-testid="create-plan-card"]')).some((card) => {
          const revision = card.getAttribute('data-plan-revision-id') || '';
          const ready = card.getAttribute('data-plan-ready') === 'true';
          return revision === ${JSON.stringify(staleRevisionId)} && ready;
        });
      `);
      return (
        currentRevisionId !== staleRevisionId &&
        !staleBuildableCard &&
        !ui.planDocBuildEnabled
      );
    },
    {
      timeout: REPLY_TIMEOUT_MS,
      interval: 1_000,
      timeoutMsg: `${label} stale plan revision remained after edit/resend; stale=${JSON.stringify(staleRevisionId)} state=${JSON.stringify(summarizeChatState(await invokeE2E("inspectChatState")))} ui=${JSON.stringify(await execJS(js.planUi))}`,
    }
  );
}

async function runPlanBuildDirectScenario(config) {
  const repoPath = createTempRepo(`${config.label}-plan-direct`);
  const markerFile = `orgii-plan-build-${config.label.replace(/[^a-zA-Z0-9]/g, "-")}-${Date.now()}.md`;
  const markerText = `ORGII_PLAN_BUILD_${config.label.replace(/[^a-zA-Z0-9]/g, "_")}_${Date.now()}`;
  const requestContent = writePlanRequest(
    repoPath,
    markerFile,
    markerText,
    `${config.label}-plan-direct`
  );
  const beforeFiles = listWorkspaceFiles(repoPath);
  const prompt = planPromptForConfig(config, requestContent);

  try {
    await configureScenario(config, { repoPath, agentExecMode: "plan" });
    await waitForModePill(`${config.label}-plan-direct`, "Plan");
    const inputSelector = await waitForChatInput();
    await startPlanDraftObserver();
    await typeAndClickSend(inputSelector, prompt);
    await waitForChatLaunched(prompt);
    await assertPlanModePromptTools(`${config.label}-plan-direct`);
    await ensurePlanCardReadyAfterPrompt(`${config.label}-plan-direct`);
    await waitForPlanShellVisible(`${config.label}-plan-direct`);
    await assertPlanCardDedupe(`${config.label}-plan-direct`);
    assertNoImplementationFilesCreated(
      `${config.label}-plan-direct-before-build`,
      beforeFiles,
      repoPath
    );
    await clickPlanBuild(`${config.label}-plan-direct`);
    await waitForPlanCardGone(`${config.label}-plan-direct`);
    await assertTodoUiIfTodoToolAppeared(`${config.label}-plan-direct`);

    const filePath = path.join(repoPath, markerFile);
    await waitForMarkerFile(config, filePath, markerText);
    // Wait for the build turn to fully complete before inspecting the file
    // changes panel — the marker file exists as soon as the tool call lands, but
    // the agent session may still be streaming its final assistant message and
    // the file-change review buttons only activate once the turn is idle.
    await waitForRuntimeIdle(`${config.label}-plan-direct-build-complete`);
    await waitForFileChangesPanel(`${config.label}-plan-direct-rewind`);
    await clickUndoAllAndConfirm(`${config.label}-plan-direct-rewind`);

    await browser.waitUntil(
      async () => {
        const panel = await execJS(js.fileChanges);
        const fileExists = fs.existsSync(filePath);
        const fileHasMarker = fileExists
          ? fs.readFileSync(filePath, "utf8").includes(markerText)
          : false;
        return !panel.undoAll && !fileHasMarker;
      },
      {
        timeout: 30_000,
        timeoutMsg: `${config.label} Plan Build Undo All did not rewind file; exists=${fs.existsSync(filePath)} content=${fs.existsSync(filePath) ? JSON.stringify(fs.readFileSync(filePath, "utf8")) : "<missing>"} fileChanges=${JSON.stringify(await execJS(js.fileChanges))}`,
      }
    );
  } finally {
    await execJS(
      `window.__orgiiE2EAutoConfirmDestructive = false; return true;`
    ).catch(() => undefined);
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
}

async function runPlanUpdateSupersedesScenario(config) {
  const repoPath = createTempRepo(`${config.label}-plan-update`);
  const firstMarkerFile = `orgii-plan-first-${Date.now()}.md`;
  const updatedMarkerFile = `orgii-plan-updated-${Date.now()}.md`;
  const firstMarkerText = `ORGII_PLAN_FIRST_${Date.now()}`;
  const updatedMarkerText = `ORGII_PLAN_UPDATED_${Date.now()}`;
  const firstRequestContent = writePlanRequest(
    repoPath,
    firstMarkerFile,
    firstMarkerText,
    `${config.label}-plan-update-first`
  );
  const firstPrompt = planPromptForConfig(config, firstRequestContent);
  let updatePrompt = "";

  await configureScenario(config, { repoPath, agentExecMode: "plan" });
  await waitForModePill(`${config.label}-plan-update`, "Plan");
  const inputSelector = await waitForChatInput();
  await startPlanDraftObserver();
  await typeAndClickSend(inputSelector, firstPrompt);
  await waitForChatLaunched(firstPrompt);
  await assertPlanModePromptTools(`${config.label}-plan-update`);
  await ensurePlanCardReadyAfterPrompt(`${config.label}-plan-update-first`);
  await waitForPlanShellVisible(`${config.label}-plan-update-first`);
  await assertCurrentTurnPlanStaysExpandedInTranscript(
    `${config.label}-plan-update-first`
  );
  await assertPlanCardDedupe(`${config.label}-plan-update-first`);
  const firstState = await inspectChatState(
    `${config.label}-plan-update-first`
  );
  const firstRevisionId = planRevisionIdentity(firstState.pendingPlan);
  if (!firstRevisionId) {
    throw new Error(
      `${config.label} first plan did not expose a revision id; state=${JSON.stringify(summarizeChatState(firstState))}`
    );
  }

  const updatedRequestContent = updatePlanRequest(
    repoPath,
    updatedMarkerFile,
    updatedMarkerText,
    `${config.label}-plan-update-second`
  );
  updatePrompt = [
    `Use these updated inline requirements as the complete source of truth for ${config.label}:`,
    updatedRequestContent.replace(/\s+/g, " ").trim(),
    "Research is complete; do not answer in prose.",
    "Revise the pending plan from this content before implementation starts.",
    "Submit the revised plan for approval.",
  ].join(" ");
  const chatInputSelector = await waitForChatInput();
  await startPlanDraftObserver();
  await typeAndClickSend(chatInputSelector, updatePrompt);
  await browser.waitUntil(
    async () => {
      const state = await inspectChatState(
        `${config.label}-plan-update-no-queue`
      );
      return state.queuedMessages.length === 0;
    },
    {
      timeout: QUEUE_TIMEOUT_MS,
      timeoutMsg: `${config.label} queued a pending-plan follow-up instead of sending it directly; state=${JSON.stringify(summarizeChatState(await invokeE2E("inspectChatState")))}`,
    }
  );
  const updateRevisionTimeoutMs = config.label.includes("gemini-rust-agent")
    ? 60_000
    : REPLY_TIMEOUT_MS;
  const updatePlanAppeared = await tryWaitForPendingPlanRevisionChange(
    `${config.label}-plan-update-second`,
    firstRevisionId,
    updateRevisionTimeoutMs
  );
  if (!updatePlanAppeared) {
    const state = await inspectChatState(
      `${config.label}-plan-update-no-correction`
    );
    throw new Error(
      `${config.label} did not update the pending plan from the original revision request; first=${JSON.stringify(firstRevisionId)} state=${JSON.stringify(summarizeChatState(state))} ui=${JSON.stringify(await execJS(js.planUi))}`
    );
  }
  await waitForPlanShellVisible(`${config.label}-plan-update-second`);
  await waitForPlanCardReady(`${config.label}-plan-update-second`);
  await assertCurrentTurnPlanStaysExpandedInTranscript(
    `${config.label}-plan-update-second`
  );
  await assertPlanCardDedupe(`${config.label}-plan-update-second`);
  await assertNoDuplicateThinkingPlaceholders(`${config.label}-plan-update`);
  const secondState = await inspectChatState(
    `${config.label}-plan-update-second`
  );
  const secondRevisionId = planRevisionIdentity(secondState.pendingPlan);
  if (!secondRevisionId || secondRevisionId === firstRevisionId) {
    throw new Error(
      `${config.label} update did not archive the previous pending plan; first=${JSON.stringify(firstRevisionId)} second=${JSON.stringify(secondRevisionId)} state=${JSON.stringify(summarizeChatState(secondState))}`
    );
  }
  const ui = await execJS(js.planUi);
  const enabledBuildRevisionIds = new Set([
    ...(ui.enabledBuildRevisionIds ?? []),
    ...(ui.planDocBuildEnabled && ui.planDocRevisionId
      ? [ui.planDocRevisionId]
      : []),
  ]);
  if (
    enabledBuildRevisionIds.size !== 1 ||
    !enabledBuildRevisionIds.has(secondRevisionId)
  ) {
    throw new Error(
      `${config.label} plan update did not leave exactly one buildable revision; revision=${secondRevisionId} enabled=${JSON.stringify(Array.from(enabledBuildRevisionIds))} ui=${JSON.stringify(ui)} state=${JSON.stringify(summarizeChatState(secondState))}`
    );
  }
  const visibleRevisionIds = [
    ...ui.currentCardRevisionIds,
    ...ui.transcriptCardRevisionIds,
  ];
  const updatedPlanCardVisible =
    (visibleRevisionIds.includes(secondRevisionId) || ui.planDocBuildEnabled) &&
    secondState.pendingPlan?.planContent?.includes(updatedMarkerFile);
  if (!updatedPlanCardVisible) {
    throw new Error(
      `${config.label} updated plan card did not reappear as the latest approval surface; marker=${updatedMarkerFile} revision=${secondRevisionId} ui=${JSON.stringify(ui)} state=${JSON.stringify(summarizeChatState(secondState))}`
    );
  }

  const firstPlan = {
    revisionId: firstRevisionId,
    markerFile: firstMarkerFile,
  };
  const secondPlan = {
    revisionId: secondRevisionId,
    markerFile: updatedMarkerFile,
  };
  await assertPlanRevisionOrder(
    `${config.label}-plan-update-order`,
    firstPlan,
    secondPlan
  );
  await assertPlanPreviewNavigation(
    `${config.label}-plan-update-preview`,
    firstPlan,
    secondPlan
  );

  await clickPlanBuild(`${config.label}-plan-update`);
  await waitForPlanCardGone(`${config.label}-plan-update`);
  await assertTodoUiIfTodoToolAppeared(`${config.label}-plan-update`);
}

async function runPlanEditResendScenario(config) {
  const repoPath = createTempRepo(`${config.label}-plan-edit-resend`);
  const firstMarkerFile = `orgii-plan-edit-first-${Date.now()}.md`;
  const editedMarkerFile = `orgii-plan-edit-resend-${Date.now()}.md`;
  const firstMarkerText = `ORGII_PLAN_EDIT_FIRST_${Date.now()}`;
  const editedMarkerText = `ORGII_PLAN_EDIT_RESEND_${Date.now()}`;
  const firstRequestContent = writePlanRequest(
    repoPath,
    firstMarkerFile,
    firstMarkerText,
    `${config.label}-plan-edit-resend-first`
  );
  const firstPrompt = planPromptForConfig(config, firstRequestContent);
  let editedPrompt = "";

  await configureScenario(config, { repoPath, agentExecMode: "plan" });
  await waitForModePill(`${config.label}-plan-edit-resend`, "Plan");
  const inputSelector = await waitForChatInput();
  await startPlanDraftObserver();
  await typeAndClickSend(inputSelector, firstPrompt);
  await waitForChatLaunched(firstPrompt);
  await assertPlanModePromptTools(`${config.label}-plan-edit-resend`);
  await ensurePlanCardReadyAfterPrompt(
    `${config.label}-plan-edit-resend-first`
  );
  await waitForPlanShellVisible(`${config.label}-plan-edit-resend-first`);
  await assertPlanCardDedupe(`${config.label}-plan-edit-resend-first`);

  const firstState = await inspectChatState(
    `${config.label}-plan-edit-resend-first`
  );
  const firstRevisionId = planRevisionIdentity(firstState.pendingPlan);
  if (!firstRevisionId) {
    throw new Error(
      `${config.label} first edit/resend plan did not expose a revision id; state=${JSON.stringify(summarizeChatState(firstState))}`
    );
  }

  const editedRequestContent = updatePlanRequest(
    repoPath,
    editedMarkerFile,
    editedMarkerText,
    `${config.label}-plan-edit-resend-second`
  );
  editedPrompt = [
    `Use this replacement ORGII_PLAN_REQUEST.md content as the source of truth for ${config.label}:`,
    editedRequestContent.replace(/\s+/g, " ").trim(),
    "Replace the previous pending plan with a new plan based on that content.",
    "Submit the replacement plan for approval.",
  ].join(" ");
  await startPlanDraftObserver();
  await editFirstUserMessageAndResend(
    `${config.label}-plan-edit-resend`,
    editedPrompt
  );
  await waitForPlanRevisionCleared(
    `${config.label}-plan-edit-resend`,
    firstRevisionId
  );
  await waitForPendingPlanRevisionChange(
    `${config.label}-plan-edit-resend-second`,
    firstRevisionId,
    REPLY_TIMEOUT_MS
  );
  await waitForPlanShellVisible(`${config.label}-plan-edit-resend-second`);
  await waitForPlanCardReady(`${config.label}-plan-edit-resend-second`);
  await assertPlanCardDedupe(`${config.label}-plan-edit-resend-second`);

  const secondState = await inspectChatState(
    `${config.label}-plan-edit-resend-second`
  );
  const secondRevisionId = planRevisionIdentity(secondState.pendingPlan);
  if (!secondRevisionId || secondRevisionId === firstRevisionId) {
    throw new Error(
      `${config.label} edit/resend did not replace pending plan revision; first=${JSON.stringify(firstRevisionId)} second=${JSON.stringify(secondRevisionId)} state=${JSON.stringify(summarizeChatState(secondState))}`
    );
  }
  if (!secondState.pendingPlan?.planContent?.includes(editedMarkerFile)) {
    throw new Error(
      `${config.label} edit/resend pending plan did not contain edited marker; marker=${editedMarkerFile} state=${JSON.stringify(summarizeChatState(secondState))}`
    );
  }

  const ui = await execJS(js.planUi);
  const enabledBuildRevisionIds = new Set([
    ...(ui.enabledBuildRevisionIds ?? []),
    ...(ui.planDocBuildEnabled && ui.planDocRevisionId
      ? [ui.planDocRevisionId]
      : []),
  ]);
  if (
    enabledBuildRevisionIds.size !== 1 ||
    !enabledBuildRevisionIds.has(secondRevisionId)
  ) {
    throw new Error(
      `${config.label} edit/resend left the wrong buildable revisions; revision=${secondRevisionId} enabled=${JSON.stringify(Array.from(enabledBuildRevisionIds))} ui=${JSON.stringify(ui)} state=${JSON.stringify(summarizeChatState(secondState))}`
    );
  }
}

async function runPlanStopScenario(config) {
  const repoPath = createTempRepo(`${config.label}-plan-stop`);
  const markerFile = `orgii-plan-stop-${Date.now()}.md`;
  const markerText = `ORGII_PLAN_STOP_${Date.now()}`;
  const requestContent = writePlanRequest(
    repoPath,
    markerFile,
    markerText,
    `${config.label}-plan-stop`
  );
  const prompt = [
    planPromptForConfig(config, requestContent),
    "Before creating the plan, briefly think through alternatives.",
  ].join(" ");

  await configureScenario(config, { repoPath, agentExecMode: "plan" });
  const inputSelector = await waitForChatInput();
  await typeAndClickSend(inputSelector, prompt);
  await waitForChatLaunched(prompt);
  await assertPlanModePromptTools(`${config.label}-plan-stop`);
  await waitForWorkingTurn(`${config.label}-plan-stop`);
  await clickMainAction("stop", `${config.label}-plan-stop`);
  await browser.pause(800);
  const state = await inspectChatState(`${config.label}-plan-stop`);
  const ui = await execJS(js.planUi);
  if (
    state.pendingPlan ||
    ui.readyCurrentCardCount > 0 ||
    ui.enabledBuildButtonCount > 0
  ) {
    throw new Error(
      `${config.label} Stop left a buildable plan card; state=${JSON.stringify(summarizeChatState(state))} ui=${JSON.stringify(ui)}`
    );
  }
}

async function runPlanWriteBeforeBuildDeniedScenario(config) {
  const repoPath = createTempRepo(`${config.label}-plan-write-denied`);
  const markerFile = `orgii-plan-denied-${Date.now()}.md`;
  const markerText = `ORGII_PLAN_DENIED_${Date.now()}`;
  const markerPath = path.join(repoPath, markerFile);
  const requestContent = writePlanRequest(
    repoPath,
    markerFile,
    markerText,
    `${config.label}-plan-write-denied`
  );
  const beforeFiles = listWorkspaceFiles(repoPath);
  const prompt = planPromptForConfig(config, requestContent);

  await configureScenario(config, { repoPath, agentExecMode: "plan" });
  await waitForModePill(`${config.label}-plan-write-denied`, "Plan");
  const inputSelector = await waitForChatInput();
  await startPlanDraftObserver();
  await typeAndClickSend(inputSelector, prompt);
  await waitForChatLaunched(prompt);
  await assertPlanModePromptTools(`${config.label}-plan-write-denied`);
  await ensurePlanCardReadyAfterPrompt(`${config.label}-plan-write-denied`);
  await waitForPlanShellVisible(`${config.label}-plan-write-denied`);
  await assertPlanCardDedupe(`${config.label}-plan-write-denied`);
  if (fs.existsSync(markerPath)) {
    throw new Error(
      `${config.label} Plan mode created ${markerFile} before Build approval`
    );
  }
  assertNoImplementationFilesCreated(
    `${config.label}-plan-write-denied`,
    beforeFiles,
    repoPath
  );
}

export {
  assertNoDuplicateThinkingPlaceholders,
  runPlanBuildDirectScenario,
  runPlanEditResendScenario,
  runPlanStopScenario,
  runPlanUpdateSupersedesScenario,
  runPlanWriteBeforeBuildDeniedScenario,
  waitForIntermediateStreamEvents,
};

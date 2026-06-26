import {
  QUEUE_TIMEOUT_MS,
  REPLY_TIMEOUT_MS,
  assertControlFlowHealthyAfterStop,
  assertLiveAssistantOverlayOrdering,
  assertNoDurableLiveStreamPlaceholders,
  assertProgressUiSettledAfterAssistantReply,
  assertTurnSummaryOrdering,
  configureScenario,
  execJS,
  inspectChatState,
  installControlFlowInstrumentation,
  invokeE2E,
  js,
  readControlFlowInstrumentation,
  summarizeChatState,
  summarizePageDump,
  truncateDiagnosticText,
  typeAndClickSend,
  unwrap,
  waitForChatInput,
  waitForChatLaunched,
} from "./agentQueuedFollowupDriver.mjs";

function throwIfProviderRuntimeBlocked(state, label) {
  const runtimeError = String(state?.runtimeError ?? "");
  const normalized = runtimeError.toLowerCase();
  if (
    normalized.includes("429") ||
    normalized.includes("too many requests") ||
    normalized.includes("quota_exhausted") ||
    normalized.includes("rate limited") ||
    normalized.includes("rate_limit") ||
    normalized.includes("capacity") ||
    normalized.includes("overloaded")
  ) {
    throw new Error(
      `${label} provider capacity blocked scenario: ${runtimeError}; state=${JSON.stringify(summarizeChatState(state))}`
    );
  }
}

async function switchStationMode(mode, label) {
  const testId =
    mode === "my-station"
      ? "station-mode-my-station"
      : "station-mode-agent-station";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const state = await inspectChatState(`${label}-${mode}-before-click`);
    if (state.stationMode === mode) return true;
    const clicked = await execJS(`
      const directButton = document.querySelector('[data-testid=${JSON.stringify(testId)}]');
      const chipButton = document.querySelector('[data-testid="station-mode-chip"]');
      const button = directButton || chipButton;
      if (!button) return "missing";
      if (button.disabled) return "disabled";
      button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window, button: 0 }));
      button.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window, button: 0 }));
      button.click();
      return directButton ? "clicked-direct" : "clicked-chip";
    `);
    if (clicked === "missing") return false;
    if (clicked !== "clicked-direct" && clicked !== "clicked-chip") {
      throw new Error(
        `${label} station switch click failed for ${mode}: ${clicked}; dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`
      );
    }
    await browser.pause(300);
  }
  await browser.waitUntil(
    async () => {
      const state = await inspectChatState(`${label}-${mode}`);
      return state.stationMode === mode;
    },
    {
      timeout: 10_000,
      timeoutMsg: `${label} did not switch to ${mode}; state=${JSON.stringify(summarizeChatState(await invokeE2E("inspectChatState")))} dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`,
    }
  );
  await browser.pause(300);
  return true;
}

function parseEventResult(result) {
  if (!result) return {};
  if (typeof result === "string") {
    try {
      return JSON.parse(result);
    } catch {
      return {};
    }
  }
  return result;
}

function parseEventArgs(args) {
  if (!args) return {};
  if (typeof args === "string") {
    try {
      return JSON.parse(args);
    } catch {
      return {};
    }
  }
  return args;
}

const TERMINAL_SHELL_PROCESS_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "canceled",
  "killed",
  "exited",
]);

function isAuthoritativeRunningEvent(event) {
  if (!event || event.displayStatus !== "running") return false;
  const args = parseEventArgs(event.args);
  const shellStatus = args.shellProcessStatus;
  if (typeof shellStatus === "string") {
    return !TERMINAL_SHELL_PROCESS_STATUSES.has(shellStatus.toLowerCase());
  }
  return true;
}

function hasAuthoritativeRunningTurn(state) {
  const events = [...(state?.rawEvents ?? []), ...(state?.chatEvents ?? [])];
  return (
    state?.isSessionActive === true ||
    state?.runtimeStatus === "running" ||
    events.some(isAuthoritativeRunningEvent)
  );
}

function userEventContainsMarker(event, marker) {
  if (!event || event.source !== "user") return false;
  const result = parseEventResult(event.result);
  if (result.syntheticUserInput === true) return false;
  const message = result.message ?? {};
  return String(message.content ?? event.displayText ?? "").includes(marker);
}

function markerUserTranscriptEvents(state, marker) {
  return (state.rawEvents ?? []).filter((event) =>
    userEventContainsMarker(event, marker)
  );
}

function markerSyntheticPreviewEvents(state, marker) {
  return (state.rawEvents ?? []).filter((event) => {
    if (!event || event.source !== "user") return false;
    const result = parseEventResult(event.result);
    if (result.syntheticUserInput !== true) return false;
    const message = result.message ?? {};
    return String(message.content ?? event.displayText ?? "").includes(marker);
  });
}

async function captureRenderedSurface(mode, label) {
  const switched = await switchStationMode(mode, label);
  if (!switched) return null;
  await browser.waitUntil(
    async () => {
      const snapshot = await execJS(js.renderedSurfaceSnapshot);
      const state = await inspectChatState(`${label}-${mode}-render`);
      return state.chatEvents.some((event) =>
        snapshot.bodyText.includes(event.displayText.slice(0, 60))
      );
    },
    {
      timeout: 20_000,
      timeoutMsg: `${label} ${mode} did not render chat event text; snapshot=${JSON.stringify(await execJS(js.renderedSurfaceSnapshot))} state=${JSON.stringify(summarizeChatState(await invokeE2E("inspectChatState")))}`,
    }
  );
  return execJS(js.renderedSurfaceSnapshot);
}

async function assertStationSurfacesConsistent(label) {
  const initialSurface = await execJS(js.renderedSurfaceSnapshot);
  const myStation = await captureRenderedSurface("my-station", label);
  const agentStation = await captureRenderedSurface("agent-station", label);
  if (!myStation || !agentStation) {
    return {
      myStation: myStation ?? initialSurface,
      agentStation: agentStation ?? initialSurface,
      comparedBothStations: false,
    };
  }
  if (myStation.filesPillText !== agentStation.filesPillText) {
    throw new Error(
      `${label} file pill mismatch between My Station and Agent: my=${JSON.stringify(myStation)} agent=${JSON.stringify(agentStation)}`
    );
  }
  if (myStation.roundLabel !== agentStation.roundLabel) {
    throw new Error(
      `${label} round label mismatch between My Station and Agent: my=${JSON.stringify(myStation)} agent=${JSON.stringify(agentStation)}`
    );
  }
  if (myStation.changesCount !== agentStation.changesCount) {
    throw new Error(
      `${label} changes count mismatch between My Station and Agent: my=${JSON.stringify(myStation)} agent=${JSON.stringify(agentStation)}`
    );
  }
  return { myStation, agentStation, comparedBothStations: true };
}

async function waitForWorkingTurn(label) {
  const deadline = Date.now() + 60_000;
  let state = null;
  let sendState = null;
  while (Date.now() < deadline) {
    state = await inspectChatState(label);
    sendState = await execJS(js.sendState);
    if (hasAuthoritativeRunningTurn(state) && sendState?.state === "stop") {
      return;
    }
    await browser.pause(500);
  }

  state = await inspectChatState(`${label}-final-probe`);
  sendState = await execJS(js.sendState);
  if (hasAuthoritativeRunningTurn(state) && sendState?.state === "stop") {
    return;
  }

  throw new Error(
    `${label} did not enter a working state before follow-up; state=${JSON.stringify(summarizeChatState(state))} sendState=${JSON.stringify(sendState)} dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`
  );
}

async function clickMainAction(expectedState, label, timeout = 15_000) {
  let lastClickResult = null;
  await browser.waitUntil(
    async () => {
      lastClickResult = await execJS(
        js.clickWhenState('[data-testid="chat-send-button"]', expectedState)
      );
      return lastClickResult === "clicked";
    },
    {
      timeout,
      interval: 250,
      timeoutMsg: `${label} main action never became clickable ${expectedState}; lastClickResult=${JSON.stringify(lastClickResult)} state=${JSON.stringify(await execJS(js.sendState))}`,
    }
  );
}

async function typeAndSubmitWithShortcut(inputSelector, prompt) {
  const typed = await execJS(js.clearAndType(inputSelector, prompt));
  if (!typed.includes(prompt)) {
    throw new Error(`Failed to type prompt: ${typed}`);
  }
  await browser.pause(300);
  const shortcutResult = await execJS(`
    const isVisible = (node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const visibleInputShells = Array.from(document.querySelectorAll('[data-testid="chat-input"]')).filter(isVisible);
    const activeInputShell = visibleInputShells[visibleInputShells.length - 1] ?? null;
    const scopedEditors = activeInputShell
      ? Array.from(activeInputShell.querySelectorAll(${JSON.stringify(inputSelector)})).filter(isVisible)
      : [];
    const editors = scopedEditors.length > 0
      ? scopedEditors
      : Array.from(document.querySelectorAll(${JSON.stringify(inputSelector)})).filter(isVisible);
    const element = editors[editors.length - 1] ?? null;
    if (!element) return "missing";
    element.focus();
    if (!(element.textContent || "").includes(${JSON.stringify(prompt)})) {
      return "wrong-editor:" + (element.textContent || "").slice(0, 120);
    }
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      bubbles: true,
      cancelable: true,
      metaKey: true,
    });
    element.dispatchEvent(event);
    return event.defaultPrevented ? "submitted" : "not-handled";
  `);
  if (shortcutResult !== "submitted") {
    throw new Error(`Shortcut submit failed: ${shortcutResult}`);
  }

  const markerMatch = prompt.match(/([A-Z0-9_]+_[a-zA-Z0-9_]+_\d+)/);
  const marker = markerMatch?.[1] ?? prompt;
  await browser.waitUntil(
    async () => {
      const state = await inspectChatState(`${marker}-shortcut-submit-probe`);
      return (
        state.queuedMessages.some((item) => item.content.includes(marker)) ||
        markerUserTranscriptEvents(state, marker).length > 0 ||
        markerSyntheticPreviewEvents(state, marker).length > 0
      );
    },
    {
      timeout: 10_000,
      interval: 250,
      timeoutMsg: `shortcut submit did not reach any source-of-truth for ${marker}; state=${JSON.stringify(summarizeChatState(await invokeE2E("inspectChatState")))}`,
    }
  );
}

async function imageUploadPickerState() {
  return execJS(`
    return {
      uploadClickCount: window.__orgiiE2EUploadClickCount || 0,
      menuOpen: !!document.querySelector('[data-testid="slash-command-menu"]'),
    };
  `);
}

async function assertRealPlusImageUploadPathOpensFilePicker(label) {
  await browser.waitUntil(
    async () =>
      (await execJS(
        js.exists('[data-testid="composer-skills-tools-button"]')
      )) && (await execJS(js.exists('[data-testid="chat-file-upload-input"]'))),
    {
      timeout: 30_000,
      interval: 500,
      timeoutMsg: `${label} composer upload controls never mounted before + image path; sendState=${JSON.stringify(await execJS(js.sendState))} dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`,
    }
  );

  const opened = await execJS(
    js.visibleClick('[data-testid="composer-skills-tools-button"]')
  );
  if (opened !== "clicked") {
    throw new Error(
      `${label} real + image path did not open Skills & Tools: ${opened}; dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`
    );
  }
  await browser.waitUntil(
    async () =>
      (await execJS(js.exists('[data-testid="slash-command-image-upload"]'))) &&
      (await execJS(js.exists('[data-testid="chat-file-upload-input"]'))),
    {
      timeout: 5_000,
      interval: 200,
      timeoutMsg: `${label} real + image path did not render Image row/input; dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`,
    }
  );

  // The bottom-anchored floating composer must open this menu UPWARD — the
  // panel has to sit fully above the composer shell and stay within the
  // viewport. Regression guard for the queue-edit "+" menu rendering off the
  // bottom edge (placement was hardcoded "down" for every edit-mode composer).
  const menuGeometry = await execJS(`
    const menu = document.querySelector('[data-testid="slash-command-menu"]');
    const shell = document.querySelector('[data-testid="chat-input"]');
    if (!menu || !shell) return { ok: false, reason: "missing-menu-or-shell" };
    const menuRect = menu.getBoundingClientRect();
    const shellRect = shell.getBoundingClientRect();
    return {
      ok: true,
      menuTop: menuRect.top,
      menuBottom: menuRect.bottom,
      shellTop: shellRect.top,
      viewportHeight: window.innerHeight,
    };
  `);
  if (!menuGeometry?.ok) {
    throw new Error(
      `${label} could not measure + menu geometry: ${JSON.stringify(menuGeometry)}; dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`
    );
  }
  // Allow a small overlap tolerance for the trigger-gap rounding, but the menu
  // must clearly open upward (its bottom near/above the composer top) and must
  // not be clipped by the viewport bottom.
  const opensUpward = menuGeometry.menuBottom <= menuGeometry.shellTop + 8;
  const withinViewport =
    menuGeometry.menuBottom <= menuGeometry.viewportHeight + 1 &&
    menuGeometry.menuTop >= -1;
  if (!opensUpward || !withinViewport) {
    throw new Error(
      `${label} + menu did not open upward within the viewport (off-bottom regression); geometry=${JSON.stringify(menuGeometry)}; dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`
    );
  }

  const patchResult = await execJS(`
    const input = document.querySelector('[data-testid="chat-file-upload-input"]');
    if (!input) return { ok: false, reason: "missing-upload-input" };
    if (!input.__orgiiE2EOriginalClick) {
      input.__orgiiE2EOriginalClick = input.click.bind(input);
    }
    window.__orgiiE2EUploadClickCount = 0;
    input.click = () => {
      window.__orgiiE2EUploadClickCount = (window.__orgiiE2EUploadClickCount || 0) + 1;
    };
    return { ok: true };
  `);
  if (!patchResult?.ok) {
    throw new Error(
      `${label} real + image path could not patch hidden input: ${JSON.stringify(patchResult)}; dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`
    );
  }
  const clicked = await execJS(`
    const row = document.querySelector('[data-testid="slash-command-image-upload"]');
    if (!row) return "missing";
    row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window, button: 0 }));
    return "clicked";
  `);
  if (clicked !== "clicked") {
    throw new Error(`${label} real + image row click failed: ${clicked}`);
  }
  await browser.waitUntil(
    async () => {
      const state = await imageUploadPickerState();
      return state.uploadClickCount === 1 && state.menuOpen === false;
    },
    {
      timeout: 2_000,
      interval: 100,
      timeoutMsg: `${label} real + image path did not trigger hidden file input exactly once; state=${JSON.stringify(await imageUploadPickerState())} dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`,
    }
  );
}

async function attachTestImageToComposer(
  fileName = "orgii-e2e-cancel-image.png"
) {
  const result = await execJS(`
    const shell = document.querySelector('[data-testid="chat-input"]');
    const editor = shell && shell.querySelector('[contenteditable="true"]');
    if (!editor) return { ok: false, reason: "missing-editor" };
    // The image-attach hook is mounted by multiple composers at once; scope the
    // injected event to THIS composer's owner so the image lands on exactly one
    // attachment strip (mirrors how a real file picker is scoped to its input).
    const ownerId = shell.getAttribute("data-image-owner-id") || "";
    const canvas = document.createElement("canvas");
    canvas.width = 16;
    canvas.height = 16;
    const context = canvas.getContext("2d");
    if (!context) return { ok: false, reason: "missing-canvas-context" };
    context.fillStyle = "#ff3366";
    context.fillRect(0, 0, 16, 16);
    context.fillStyle = "#ffffff";
    context.fillRect(4, 4, 8, 8);
    const dataUrl = canvas.toDataURL("image/png");
    editor.focus();
    window.dispatchEvent(new CustomEvent("orgii:e2e-add-chat-image", {
      detail: {
        eventId: "e2e-image-" + Date.now() + "-" + Math.random().toString(16).slice(2),
        fileName: ${JSON.stringify(fileName)},
        dataUrl,
        ownerId,
      },
    }));
    return { ok: true, fileName: ${JSON.stringify(fileName)}, dataUrlLength: dataUrl.length, ownerId };
  `);
  if (!result?.ok) {
    throw new Error(
      `Failed to attach test image: ${JSON.stringify(result)} dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`
    );
  }
}

async function waitForImageAttachmentCount(count, label, options = {}) {
  const atLeast = options.atLeast === true;
  await browser.waitUntil(
    async () => {
      const state = await execJS(js.imageAttachmentState);
      return atLeast ? state.count >= count : state.count === count;
    },
    {
      timeout: 20_000,
      interval: 500,
      timeoutMsg: `${label} expected ${atLeast ? "at least " : ""}${count} image attachment(s); imageState=${JSON.stringify(await execJS(js.imageAttachmentState))} dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`,
    }
  );
}

async function waitForQueuedOrForceSentFollowup(marker) {
  await browser.waitUntil(
    async () => {
      const state = await inspectChatState(marker);
      const queuedItems = await execJS(js.queuedItems);
      return (
        state.queuedMessages.some((item) => item.content.includes(marker)) ||
        queuedItems.some((item) => item.text.includes(marker)) ||
        markerUserTranscriptEvents(state, marker).length > 0
      );
    },
    {
      timeout: QUEUE_TIMEOUT_MS,
      timeoutMsg: `follow-up marker ${marker} never appeared in queued messages or a durable force-sent user turn; state=${JSON.stringify(summarizeChatState(await invokeE2E("inspectChatState")))} dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`,
    }
  );
}

async function readRenderedRoundBoundarySnapshot(marker) {
  return execJS(`
    const marker = ${JSON.stringify(marker)};
    const isVisible = (node) => {
      if (!node) return false;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const chatList = document.querySelector('[data-testid="chat-message-list"]');
    const roundControl = Array.from(document.querySelectorAll('[data-testid="turn-pagination-current-round"]')).find(isVisible) || null;
    const userMessages = chatList
      ? Array.from(chatList.querySelectorAll('[data-testid="chat-message-user-editable"]')).filter(isVisible)
      : [];
    const markerUserMessages = userMessages
      .map((node) => (node.textContent || "").trim())
      .filter((text) => text.includes(marker));
    const queuedItems = Array.from(document.querySelectorAll('[data-testid="queued-message-item"]'))
      .filter(isVisible)
      .map((node) => ((node.getAttribute("data-queued-message-content") || node.textContent || "")).trim())
      .filter((text) => text.includes(marker));
    return {
      roundLabel: roundControl ? (roundControl.textContent || "").trim() : "",
      userMessageCount: userMessages.length,
      markerUserMessageCount: markerUserMessages.length,
      markerUserMessages,
      queuedItemCount: queuedItems.length,
      queuedItems,
      chatListText: chatList ? (chatList.textContent || "").slice(0, 2000) : "",
    };
  `);
}

async function assertRenderedRoundBoundaryWhileQueued(label, marker) {
  const samples = [];
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const state = await inspectChatState(`${label}-round-boundary`);
    const snapshot = await readRenderedRoundBoundarySnapshot(marker);
    samples.push(snapshot);
    const syntheticPreviewCount = markerSyntheticPreviewEvents(
      state,
      marker
    ).length;
    if (snapshot.markerUserMessageCount > 0 || syntheticPreviewCount > 0) {
      throw new Error(
        `${label} queued follow-up crossed the rendered round boundary before dispatch; marker=${marker} syntheticPreviewCount=${syntheticPreviewCount} snapshot=${JSON.stringify(snapshot)} state=${JSON.stringify(summarizeChatState(state))}`
      );
    }
    await browser.pause(250);
  }
  if (samples.every((sample) => sample.queuedItemCount === 0)) {
    throw new Error(
      `${label} queued follow-up was not rendered in the composer queue while parked; marker=${marker} samples=${JSON.stringify(samples)} state=${JSON.stringify(summarizeChatState(await invokeE2E("inspectChatState")))}`
    );
  }
}

async function assertQueuedFollowupRemainsParked(label, marker) {
  await assertRenderedRoundBoundaryWhileQueued(label, marker);
  const state = await inspectChatState(`${label}-queue-parked`);
  assertQueuedMarkerState(state, label, marker, {
    shouldBeQueued: true,
    shouldBeUserTurn: false,
  });
}

function assertQueuedMarkerState(
  state,
  label,
  marker,
  { shouldBeQueued, shouldBeUserTurn }
) {
  const queuedAtomCount = state.queuedMessages.filter((item) =>
    item.content.includes(marker)
  ).length;
  const syntheticPreviewCount = markerSyntheticPreviewEvents(
    state,
    marker
  ).length;
  const userTurnCount = markerUserTranscriptEvents(state, marker).length;
  const effectiveUserTurnCount = userTurnCount;
  if (
    syntheticPreviewCount !== 0 ||
    (shouldBeQueued && queuedAtomCount === 0) ||
    (!shouldBeQueued && queuedAtomCount !== 0) ||
    (shouldBeUserTurn && effectiveUserTurnCount !== 1) ||
    (!shouldBeUserTurn && userTurnCount !== 0)
  ) {
    throw new Error(
      `${label} marker state mismatch for ${marker}; queuedAtomCount=${queuedAtomCount} syntheticPreviewCount=${syntheticPreviewCount} userTurnCount=${userTurnCount} effectiveUserTurnCount=${effectiveUserTurnCount} expected=${JSON.stringify({ shouldBeQueued, shouldBeUserTurn })} state=${JSON.stringify(summarizeChatState(state))}`
    );
  }
}

async function assertComposerImmediatelyUnlockedAfterStop(label, marker) {
  await browser.waitUntil(
    async () => {
      const sendState = await execJS(js.sendState);
      return sendState?.state === "submit" && sendState.disabled === false;
    },
    {
      timeout: 2_000,
      interval: 100,
      timeoutMsg: `${label} Stop did not immediately flip back to Send; state=${JSON.stringify(summarizeChatState(await invokeE2E("inspectChatState")))} sendState=${JSON.stringify(await execJS(js.sendState))} dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`,
    }
  );

  const probe = `STOP_TYPEABLE_PROBE_${Date.now()}`;
  const result = await execJS(`
    const editor = document.querySelector('[data-testid="chat-input"] [contenteditable="true"]');
    if (!editor) return { ok: false, reason: "missing-editor" };
    const before = editor.textContent || "";
    editor.focus();
    const focused = document.activeElement === editor;
    const editable = editor.isContentEditable === true;
    const inserted = document.execCommand("insertText", false, ${JSON.stringify(" " + probe)});
    const afterInsert = editor.textContent || "";
    const typed = afterInsert.includes(${JSON.stringify(probe)});
    if (typed) {
      document.execCommand("undo", false, null);
      if ((editor.textContent || "") !== before) {
        document.execCommand("selectAll", false, null);
        document.execCommand("insertText", false, before);
      }
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "historyUndo", data: null }));
    }
    return { ok: focused && editable && inserted && typed, focused, editable, inserted, typed, before: before.slice(0, 120), afterInsert: afterInsert.slice(0, 160) };
  `);
  if (!result?.ok) {
    throw new Error(
      `${label} composer was not focusable/typeable immediately after Stop; result=${JSON.stringify(result)} state=${JSON.stringify(summarizeChatState(await invokeE2E("inspectChatState")))} dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`
    );
  }

  await assertLiveAssistantOverlayOrdering(`${label}-after-stop-unlock`);
  await assertTurnSummaryOrdering(`${label}-after-stop-unlock`);
  await assertNoDurableLiveStreamPlaceholders(`${label}-after-stop-unlock`);

  await browser.pause(1_500);
  const state = await inspectChatState(`${label}-queue-after-stop-unlock`);
  const queuedStillContainsMarker =
    state.queuedMessages.some((item) => item.content.includes(marker)) ||
    markerSyntheticPreviewEvents(state, marker).length > 0;
  const markerWasSentAsUserTurn =
    markerUserTranscriptEvents(state, marker).length > 0;
  if (!queuedStillContainsMarker || markerWasSentAsUserTurn) {
    throw new Error(
      `${label} queued follow-up moved after Stop instead of staying queued; queuedStillContainsMarker=${queuedStillContainsMarker} markerWasSentAsUserTurn=${markerWasSentAsUserTurn} state=${JSON.stringify(summarizeChatState(state))} dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`
    );
  }
}

async function assertComposerResponsiveAfterStop(label, expectedText) {
  await browser.waitUntil(
    async () => {
      const state = await inspectChatState(`${label}-post-stop-idle`);
      const mode = await execJS(js.mode);
      const editorText = await execJS(js.editorText);
      return (
        !hasAuthoritativeRunningTurn(state) &&
        (mode === "creator" || mode === "chat") &&
        typeof editorText === "string" &&
        editorText.includes(expectedText.slice(0, 80))
      );
    },
    {
      timeout: 20_000,
      interval: 500,
      timeoutMsg: `${label} Stop left a running or unloaded session; state=${JSON.stringify(summarizeChatState(await invokeE2E("inspectChatState")))} dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`,
    }
  );

  await assertLiveAssistantOverlayOrdering(`${label}-post-stop-idle`);
  await assertTurnSummaryOrdering(`${label}-post-stop-idle`);
  await assertNoDurableLiveStreamPlaceholders(`${label}-post-stop-idle`);

  const inputSelector = await waitForChatInput();
  const probeText = `${expectedText} STOP_FREEZE_PROBE_${Date.now()}`;
  const typed = await execJS(js.clearAndType(inputSelector, probeText));
  if (!typed.includes("STOP_FREEZE_PROBE_")) {
    throw new Error(
      `${label} composer did not accept typing after Stop; typed=${JSON.stringify(typed)} dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`
    );
  }
  await execJS(js.clearAndType(inputSelector, expectedText));
}

async function waitForMarkerState(label, marker, expected, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    const state = await inspectChatState(`${label}-marker-state`);
    try {
      assertQueuedMarkerState(state, label, marker, expected);
      return;
    } catch (error) {
      lastError = error;
    }
    await browser.pause(500);
  }
  const finalState = await invokeE2E("inspectChatState");
  throw new Error(
    `${label} marker ${marker} did not reach expected state ${JSON.stringify(expected)}; lastError=${lastError?.message ?? String(lastError)} finalState=${JSON.stringify(summarizeChatState(finalState))} dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`
  );
}

async function waitForQueuedFollowup(marker) {
  await browser.waitUntil(
    async () => {
      const state = await inspectChatState(marker);
      throwIfProviderRuntimeBlocked(state, marker);
      const queuedItems = await execJS(js.queuedItems);
      return (
        state.queuedMessages.some((item) => item.content.includes(marker)) ||
        queuedItems.some((item) => item.text.includes(marker))
      );
    },
    {
      timeout: QUEUE_TIMEOUT_MS,
      timeoutMsg: `follow-up marker ${marker} never appeared in queued messages; state=${JSON.stringify(summarizeChatState(await invokeE2E("inspectChatState")))} dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`,
    }
  );
}

async function clickSendNowForQueuedMarker(marker) {
  const state = await inspectChatState(marker);
  const queuedMessage = state.queuedMessages.find((item) =>
    item.content.includes(marker)
  );
  if (!queuedMessage) {
    const markerUserEvents = markerUserTranscriptEvents(state, marker);
    const markerPreviewEvents = markerSyntheticPreviewEvents(state, marker);
    if (markerUserEvents.length === 1 && markerPreviewEvents.length === 0)
      return;
    throw new Error(
      `Queued state did not contain marker ${marker}: markerUserEvents=${markerUserEvents.length} markerPreviewEvents=${markerPreviewEvents.length} state=${JSON.stringify(summarizeChatState(state))}`
    );
  }
  const previousFlushRequest = state.queueFlushRequest;

  let clicked = null;
  await browser.waitUntil(
    async () => {
      const currentState = await inspectChatState(
        `${marker}-before-send-now-click`
      );
      const markerUserEvents = markerUserTranscriptEvents(currentState, marker);
      if (markerUserEvents.length === 1) {
        clicked = "already-sent";
        return true;
      }
      clicked = await execJS(`
        const item = document.querySelector('[data-testid="queued-message-item"][data-queued-message-id=${JSON.stringify(queuedMessage.id)}]');
        if (!item) return "missing-item";
        const button = item.querySelector('[data-testid="queued-message-send-now"]');
        if (!button) return "missing-button";
        if (button.disabled) return "disabled";
        button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window, button: 0 }));
        button.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window, button: 0 }));
        button.click();
        return "clicked";
      `);
      return clicked === "clicked";
    },
    {
      timeout: 20_000,
      interval: 500,
      timeoutMsg: `Send Now button click failed for marker ${marker}: ${clicked}; state=${JSON.stringify(summarizeChatState(await invokeE2E("inspectChatState")))} dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`,
    }
  );
  if (clicked === "already-sent") return;

  await browser.waitUntil(
    async () => {
      const instantState = await inspectChatState(
        `${marker}-force-send-instant`
      );
      // Unified-queue contract: Send Now instantly promotes the item to
      // priority "now" (visible queue hides it); the atom entry survives
      // until the dispatcher actually sends it.
      const visibleItems = await execJS(js.queuedItems);
      const visibleStillContainsMarker = visibleItems.some((item) =>
        item.text.includes(marker)
      );
      const promotedToNow = (
        instantState.forceSendPendingMessages ?? []
      ).some((item) => item.content.includes(marker));
      const queuedStillContainsMarker = instantState.queuedMessages.some(
        (item) => item.content.includes(marker)
      );
      return (
        !visibleStillContainsMarker &&
        (promotedToNow || !queuedStillContainsMarker)
      );
    },
    {
      timeout: 2_000,
      interval: 100,
      timeoutMsg: `Send Now did not immediately promote/hide queue item for ${marker}; state=${JSON.stringify(summarizeChatState(await invokeE2E("inspectChatState")))} dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`,
    }
  );

  await browser.waitUntil(
    async () => {
      const nextState = await inspectChatState(`${marker}-flush`);
      return nextState.queueFlushRequest > previousFlushRequest;
    },
    {
      timeout: 5_000,
      timeoutMsg: `Send Now did not invoke queue flush for ${marker}; before=${previousFlushRequest} state=${JSON.stringify(summarizeChatState(await invokeE2E("inspectChatState")))} dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`,
    }
  );

  await browser.waitUntil(
    async () => {
      const nextState = await inspectChatState(marker);
      const queuedStillContainsMarker = nextState.queuedMessages.some((item) =>
        item.content.includes(marker)
      );
      const markerUserEvents = markerUserTranscriptEvents(nextState, marker);
      const markerPreviewEvents = markerSyntheticPreviewEvents(
        nextState,
        marker
      );
      return (
        markerUserEvents.length >= 1 &&
        markerPreviewEvents.length === 0 &&
        !queuedStillContainsMarker
      );
    },
    {
      timeout: REPLY_TIMEOUT_MS,
      interval: 1_000,
      timeoutMsg: `Send Now did not consume queue and append user turn for ${marker}; state=${JSON.stringify(summarizeChatState(await invokeE2E("inspectChatState")))} dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`,
    }
  );
}

async function waitForMarkerReply(marker, label) {
  let lastDiagnostic = null;
  await browser.waitUntil(
    async () => {
      const assistantTexts = await execJS(js.assistantTexts);
      const state = await inspectChatState(`${label}-reply`);
      throwIfProviderRuntimeBlocked(state, label);
      const assistantEvents = state.chatEvents.filter(
        (event) => event.source === "assistant"
      );
      const visibleSentinel = assistantTexts.some((text) =>
        text.includes("[Request interrupted by user]")
      );
      const eventSentinel = assistantEvents.some((event) =>
        event.displayText.includes("[Request interrupted by user]")
      );
      if (visibleSentinel || eventSentinel) {
        throw new Error(
          `${label} leaked interrupt sentinel; state=${JSON.stringify(summarizeChatState(state))} assistantTexts=${JSON.stringify(assistantTexts.map((text) => truncateDiagnosticText(text)))}`
        );
      }
      lastDiagnostic = {
        state: summarizeChatState(state),
        assistantTexts: assistantTexts.map((text) =>
          truncateDiagnosticText(text)
        ),
      };
      return assistantEvents.some(
        (event) =>
          event.displayVariant === "message" &&
          event.displayText.trim() === marker
      );
    },
    {
      timeout: REPLY_TIMEOUT_MS,
      interval: 2_000,
      timeoutMsg: `${label} follow-up marker never appeared in assistant output; diagnostic=${JSON.stringify(lastDiagnostic)} dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`,
    }
  );

  const state = await inspectChatState(`${label}-reply-final`);
  const assistantTexts = await execJS(js.assistantTexts);
  const assistantEvents = state.chatEvents.filter(
    (event) => event.source === "assistant"
  );
  const markerAssistantEvents = assistantEvents.filter(
    (event) =>
      event.displayVariant === "message" && event.displayText.trim() === marker
  );
  if (markerAssistantEvents.length !== 1) {
    throw new Error(
      `${label} marker must appear in exactly one assistant message event. markerEvents=${JSON.stringify(
        markerAssistantEvents.map((event) => ({
          id: event.id,
          displayText: truncateDiagnosticText(event.displayText),
        }))
      )} assistantTexts=${JSON.stringify(assistantTexts.map((text) => truncateDiagnosticText(text)))} state=${JSON.stringify(summarizeChatState(state))}`
    );
  }
}

async function waitForIdleSendButton(label) {
  await browser.waitUntil(
    async () => {
      const state = await execJS(js.sendState);
      return state && state.state !== "working";
    },
    {
      timeout: 30_000,
      timeoutMsg: `${label} send button stayed in working state after queued follow-up completed`,
    }
  );
}

async function waitForRuntimeIdle(label) {
  // Default 60s, but allow an env override so slow providers (e.g. cursor
  // composer) or runs sharing the host with another e2e matrix can extend the
  // wait without flaking. The restore/rewind scenarios only assert idle as a
  // precondition gate, so a longer ceiling never weakens correctness.
  const RUNTIME_IDLE_TIMEOUT_MS = Number.parseInt(
    process.env.E2E_RUNTIME_IDLE_TIMEOUT_MS ?? "60000",
    10
  );
  await browser.waitUntil(
    async () => {
      const state = await inspectChatState(`${label}-runtime-idle`);
      return !hasAuthoritativeRunningTurn(state);
    },
    {
      timeout: RUNTIME_IDLE_TIMEOUT_MS,
      interval: 1_000,
      timeoutMsg: `${label} runtime did not become idle; state=${JSON.stringify(summarizeChatState(await invokeE2E("inspectChatState")))} dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`,
    }
  );
}

function longRunningPromptForConfig(config, waitSeconds = 20) {
  return [
    `Start a deliberately long, harmless task for ${config.label}.`,
    `Create a stoppable window by waiting for about ${waitSeconds} seconds before the final answer.`,
    "After the wait completes, reply with a short confirmation.",
  ].join(" ");
}

function repoExplorationPromptForConfig(config, waitSeconds = 20) {
  return [
    `Explore the current fixture repo for ${config.label} before answering.`,
    "Read README.md and package.json, inspect src/math.ts, and search under src for math-related symbols or text.",
    `Use whichever normal repo-inspection tools are appropriate, then keep the turn active for about ${waitSeconds} seconds before the final answer.`,
    "After the exploration and wait complete, summarize the files you inspected in one short sentence.",
  ].join(" ");
}

// Issue #110 pin: forces the agent to block the turn inside a REAL foreground
// shell command (not the generic LLM "wait N seconds" prompt, which a provider
// can satisfy with internal latency). Only a genuinely-running foreground shell
// reproduces the swallowed-force-send path, because force-send must physically
// kill that process for the cancelled terminal to land and release the queue.
function blockingShellPromptForConfig(config, sleepSeconds = 45) {
  return [
    `Run a single blocking foreground shell command for ${config.label}:`,
    `execute exactly \`sleep ${sleepSeconds}\` in the terminal and wait for it to finish.`,
    "Do not run it in the background. After it completes, reply with a short confirmation.",
  ].join(" ");
}

async function runFreshStopRollbackScenario(config) {
  const firstPrompt = longRunningPromptForConfig(config);

  await configureScenario(config);
  const inputSelector = await waitForChatInput();
  await typeAndClickSend(inputSelector, firstPrompt);
  await installControlFlowInstrumentation(`${config.label}-fresh-stop`);
  const beforeStopProbe = await readControlFlowInstrumentation();
  await clickMainAction("stop", `${config.label}-fresh-stop`, 30_000);

  await browser.waitUntil(
    async () => {
      const mode = await execJS(js.mode);
      const editorText = await execJS(js.editorText);
      const state = await inspectChatState(`${config.label}-fresh-stop`);
      const promptStillVisible = state.chatEvents.some(
        (event) =>
          event.source === "user" &&
          event.displayText?.includes(firstPrompt.slice(0, 80))
      );
      return (
        mode === "chat" &&
        typeof editorText === "string" &&
        editorText.includes(firstPrompt.slice(0, 80)) &&
        promptStillVisible &&
        state.queuedMessages.length === 0
      );
    },
    {
      timeout: 15_000,
      timeoutMsg: `${config.label} fresh Stop did not keep first prompt visible with draft restored; state=${JSON.stringify(summarizeChatState(await invokeE2E("inspectChatState")))} dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`,
    }
  );
  await assertComposerResponsiveAfterStop(
    `${config.label}-fresh-stop`,
    firstPrompt
  );
  await assertControlFlowHealthyAfterStop(
    `${config.label}-fresh-stop`,
    beforeStopProbe
  );
}

// Regression: pressing the MAIN composer Stop while the parent turn has
// already settled (runtime idle) but a background subagent is still running
// took the `keep_pre_turn_cancel_when_idle` branch in `cancel_active_turn`
// and left `session.cancel_flag = true` with no turn closure to reset it.
// The NEXT user message then inherited that stale flag and self-cancelled on
// iteration 1 (0 tokens, no assistant reply). The fix resets `cancel_flag`
// at the start of every fresh turn closure (message.rs). This scenario:
//   1. runs a real turn to completion (parent idle),
//   2. seeds a *running* background subagent so the composer shows Stop,
//   3. clicks Stop (the idle UserStop that strands the flag),
//   4. sends a NEW message and asserts it gets a genuine assistant reply —
//      proving the next turn was NOT self-cancelled by a stale flag.
async function runStopWithBackgroundSubagentNextMessageScenario(config) {
  const label = `${config.label}-stop-bg-subagent`;
  const safeLabel = config.label.replace(/[^a-zA-Z0-9]/g, "_");
  const firstPrompt = `Reply with a one-line confirmation for ${config.label}. STOP_BG_FIRST_${safeLabel}_${Date.now()}`;
  const followupMarker = `STOP_BG_NEXT_${safeLabel}_${Date.now()}`;
  const followupPrompt = `Reply with exactly this token and nothing else: ${followupMarker}`;

  await configureScenario(config);
  const inputSelector = await waitForChatInput();

  // 1. First turn runs to natural completion → parent session goes idle.
  await typeAndClickSend(inputSelector, firstPrompt);
  await waitForChatLaunched(firstPrompt);
  await waitForRuntimeIdle(label);
  await waitForIdleSendButton(label);

  const active = unwrap(
    await invokeE2E("getActiveSessionId"),
    `${label}-getActiveSessionId`
  );
  if (!active.sessionId) {
    throw new Error(`${label} produced no active session id`);
  }

  // 2. Seed a live background subagent job on the REAL session. This drives
  //    updateSubagentJobAtom (the same atom agent:subagent_job_changed feeds)
  //    so the composer re-enters Stop state over the idle parent — the exact
  //    "parent idle + background worker running" window the bug needs.
  const subagentHandle = `agent-builtin:explore-stopbg-${Date.now()}`;
  const seed = await invokeE2E("seedSubagentJob", {
    sessionId: active.sessionId,
    handle: subagentHandle,
    agentName: `E2E Stop-BG Worker ${safeLabel}`,
    subagentType: "delegate",
    status: "running",
  });
  if (!seed || seed.ok !== true) {
    throw new Error(
      `${label} seedSubagentJob failed: ${seed?.error ?? "unknown"}`
    );
  }

  await browser.waitUntil(
    async () => {
      const sendState = await execJS(js.sendState);
      return sendState?.state === "stop";
    },
    {
      timeout: 20_000,
      interval: 400,
      timeoutMsg: `${label} composer did not re-enter Stop while a background subagent ran; sendState=${JSON.stringify(await execJS(js.sendState))} dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`,
    }
  );

  // 3. The bug's trigger: UserStop while the parent turn is already idle.
  await clickMainAction("stop", `${label}-idle-stop`, 30_000);

  // Drop the seeded subagent so it can no longer hold the composer in Stop —
  // any subsequent Stop state must come from the new turn we are about to send.
  unwrap(
    await invokeE2E("seedSubagentJob", {
      sessionId: active.sessionId,
      handle: subagentHandle,
      agentName: `E2E Stop-BG Worker ${safeLabel}`,
      subagentType: "delegate",
      status: "completed",
    }),
    `${label}-complete-subagent`
  );

  await browser.waitUntil(
    async () => {
      const sendState = await execJS(js.sendState);
      return sendState?.state === "submit";
    },
    {
      timeout: 20_000,
      interval: 400,
      timeoutMsg: `${label} composer never returned to Send after Stop + subagent completion; sendState=${JSON.stringify(await execJS(js.sendState))} dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`,
    }
  );

  // 4. Send a fresh message. Before the fix this self-cancelled instantly
  //    (0 tokens, no reply); after the fix it must produce a real reply.
  const followupSelector = await waitForChatInput();
  await typeAndClickSend(followupSelector, followupPrompt);
  await assertProgressUiSettledAfterAssistantReply(
    `${label}-next-message`,
    followupMarker
  );

  console.log(
    `[queued-followup] ${label} session=${active.sessionId} nextMarker=${followupMarker}`
  );
}

async function runFreshStopImageRestoreScenario(config) {
  const marker = `IMAGE_CANCEL_RESTORE_${config.label.replace(/[^a-zA-Z0-9]/g, "_")}_${Date.now()}`;
  const imageFileName = `${marker}.png`;
  const imagePrompt = `${longRunningPromptForConfig(config)} Include this screenshot marker in the prompt text: ${marker}`;

  await configureScenario(config);
  const inputSelector = await waitForChatInput();
  await assertRealPlusImageUploadPathOpensFilePicker(
    `${config.label}-image-real-plus-path`
  );
  const typed = await execJS(js.clearAndType(inputSelector, imagePrompt));
  if (!typed.includes(marker)) {
    throw new Error(
      `${config.label} failed to type image cancel prompt; typed=${JSON.stringify(typed)}`
    );
  }
  await attachTestImageToComposer(imageFileName);
  await waitForImageAttachmentCount(1, `${config.label}-image-before-send`, {
    atLeast: true,
  });

  await clickMainAction("submit", `${config.label}-image-send`, 20_000);
  await clickMainAction("stop", `${config.label}-image-stop`, 30_000);

  await browser.waitUntil(
    async () => {
      const mode = await execJS(js.mode);
      const editorText = await execJS(js.editorText);
      const imageState = await execJS(js.imageAttachmentState);
      const state = await inspectChatState(
        `${config.label}-image-cancel-restore`
      );
      const promptStillVisible = state.chatEvents.some(
        (event) =>
          event.source === "user" && event.displayText?.includes(marker)
      );
      return (
        mode === "chat" &&
        typeof editorText === "string" &&
        editorText.includes(marker) &&
        promptStillVisible &&
        imageState.count >= 1 &&
        imageState.fileNames.some(
          (fileName) =>
            fileName.includes("restored-image") || fileName.includes(marker)
        ) &&
        state.queuedMessages.length === 0
      );
    },
    {
      timeout: 30_000,
      interval: 500,
      timeoutMsg: `${config.label} fresh Stop did not restore image attachment with prompt; imageState=${JSON.stringify(await execJS(js.imageAttachmentState))} state=${JSON.stringify(summarizeChatState(await invokeE2E("inspectChatState")))} dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`,
    }
  );
  await assertComposerResponsiveAfterStop(
    `${config.label}-image-stop`,
    imagePrompt
  );
}

async function openQueuedMessageEditComposer(label, marker) {
  // Click the pencil (edit) button on the queued item matching `marker`. The
  // queued row has no dedicated edit testid — the first action button is Edit.
  const opened = await execJS(`
    const marker = ${JSON.stringify(marker)};
    const rows = Array.from(document.querySelectorAll('[data-testid="queued-message-item"]'));
    const row = rows.find((node) =>
      ((node.getAttribute("data-queued-message-content") || node.textContent || "")).includes(marker)
    );
    if (!row) return { ok: false, reason: "missing-row", rowCount: rows.length };
    const editButton = row.querySelector('button[title="Edit"]')
      || row.querySelector("button");
    if (!editButton) return { ok: false, reason: "missing-edit-button" };
    editButton.click();
    return { ok: true };
  `);
  if (!opened?.ok) {
    throw new Error(
      `${label} could not open queued-message edit composer: ${JSON.stringify(opened)} dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`
    );
  }
  await browser.waitUntil(
    async () => {
      const state = await inspectChatState(`${label}-queue-edit-open`);
      const cardVisible = await execJS(
        js.exists('[data-testid="queue-edit-mode-card"]')
      );
      return state.isQueueEditing === true && cardVisible;
    },
    {
      timeout: 10_000,
      interval: 250,
      timeoutMsg: `${label} queue-edit mode did not activate after clicking Edit; state=${JSON.stringify(summarizeChatState(await invokeE2E("inspectChatState")))} dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`,
    }
  );
}

async function clickQueueEditSave(label) {
  const clicked = await execJS(`
    const card = document.querySelector('[data-testid="queue-edit-mode-card"]');
    const shell = document.querySelector('[data-testid="chat-input"]');
    const scope = shell || document;
    const buttons = Array.from(scope.querySelectorAll('button'));
    const save = buttons.find((button) => (button.textContent || "").trim() === "Save");
    if (!save) {
      return { ok: false, reason: "missing-save", labels: buttons.map((b) => (b.textContent || "").trim()).filter(Boolean) };
    }
    save.click();
    return { ok: true, hadCard: !!card };
  `);
  if (!clicked?.ok) {
    throw new Error(
      `${label} could not click Save in queue-edit composer: ${JSON.stringify(clicked)} dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`
    );
  }
}

// Regression: uploading an image via the "+" menu while editing a QUEUED
// message used to collapse queue-edit mode (the slash/+ menu portal renders to
// document.body, outside the edit container, so its mousedown tripped the
// edit-mode click-outside guard). The picked image then landed in the main
// composer's attachment strip above the input instead of the queued message.
// This scenario proves: (1) opening the + menu's Upload Image row keeps
// queue-edit mode open, and (2) the attached image folds into the queued
// message on Save.
async function runQueueEditImageUploadScenario(config) {
  const marker = `QUEUE_EDIT_IMAGE_${config.label.replace(/[^a-zA-Z0-9]/g, "_")}_${Date.now()}`;
  // Use the repo-exploration prompt (real multi-step tool calls) rather than a
  // "wait N seconds" prompt — fast non-reasoning relay models ignore the wait
  // and complete instantly, leaving no working window to queue a follow-up.
  const firstPrompt = repoExplorationPromptForConfig(config, 12);
  const followupPrompt = `Queued follow-up to edit with an image: ${marker}`;
  const imageFileName = `${marker}.png`;

  await configureScenario(config);
  const inputSelector = await waitForChatInput();
  await typeAndClickSend(inputSelector, firstPrompt);
  await waitForChatLaunched(firstPrompt);
  await waitForWorkingTurn(`${config.label}-queue-edit-image`);

  const chatInputSelector = await waitForChatInput();
  await typeAndSubmitWithShortcut(chatInputSelector, followupPrompt);
  await waitForQueuedFollowup(marker);

  // Enter queue-edit mode for the parked follow-up.
  await openQueuedMessageEditComposer(
    `${config.label}-queue-edit-image`,
    marker
  );

  // Drive the REAL "+" menu → Upload image path. This patches the hidden file
  // input's click(), opens the menu, and clicks the Image row. The key
  // assertion is inside: after the row's mousedown, queue-edit mode must NOT
  // collapse (the bug closed it here).
  await assertRealPlusImageUploadPathOpensFilePicker(
    `${config.label}-queue-edit-image-plus-path`
  );

  // The + menu closed but queue-edit mode must still be active. Before the fix
  // the click-outside guard fired and dropped us back to the normal composer.
  const afterMenu = await inspectChatState(
    `${config.label}-queue-edit-image-after-menu`
  );
  const editCardStillVisible = await execJS(
    js.exists('[data-testid="queue-edit-mode-card"]')
  );
  if (!afterMenu.isQueueEditing || !editCardStillVisible) {
    throw new Error(
      `${config.label} opening the + menu Upload-Image row collapsed queue-edit mode (regression); isQueueEditing=${afterMenu.isQueueEditing} editCardStillVisible=${editCardStillVisible} state=${JSON.stringify(summarizeChatState(afterMenu))} dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`
    );
  }

  // Now actually attach an image (the real OS picker can't be driven in
  // WebDriver, so we inject the file the same way the picker would) and ensure
  // it lands on the edit composer's attachment strip, not a stale main one.
  // Exactly one image must appear — the E2E inject event is scoped to this
  // composer's owner, so it must not multicast onto other mounted composers.
  await attachTestImageToComposer(imageFileName);
  await waitForImageAttachmentCount(
    1,
    `${config.label}-queue-edit-image-before-save`
  );
  const stillEditingAfterAttach = await inspectChatState(
    `${config.label}-queue-edit-image-after-attach`
  );
  if (!stillEditingAfterAttach.isQueueEditing) {
    throw new Error(
      `${config.label} attaching an image dropped queue-edit mode (image leaked to the main composer); state=${JSON.stringify(summarizeChatState(stillEditingAfterAttach))} dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`
    );
  }

  // Save the edit. The image must fold into the queued message, and queue-edit
  // mode must close. We assert on the queued message still carrying the image
  // (imageCount>=1) the moment the edit commits — this is the core proof that
  // the upload landed on the queued message and not the main composer. We do
  // NOT assert it stays parked afterwards: the active exploration turn may
  // naturally complete and auto-dispatch the (still "next" priority) follow-up,
  // which is correct queue behaviour and orthogonal to this regression.
  await clickQueueEditSave(`${config.label}-queue-edit-image`);
  await browser.waitUntil(
    async () => {
      const state = await inspectChatState(
        `${config.label}-queue-edit-image-saved`
      );
      if (state.isQueueEditing) return false;
      const queued = state.queuedMessages.find((item) =>
        item.content.includes(marker)
      );
      // Either the edit just committed with the image folded in (still queued),
      // or the turn completed and it already auto-dispatched as a user turn —
      // both are acceptable terminal states. The regression we guard against is
      // the image NOT reaching the queued message at all.
      if (queued) return (queued.imageCount ?? 0) >= 1;
      return markerUserTranscriptEvents(state, marker).length > 0;
    },
    {
      timeout: 15_000,
      interval: 300,
      timeoutMsg: `${config.label} queued message did not receive the uploaded image after Save (image leaked to the main composer or edit never committed); state=${JSON.stringify(summarizeChatState(await invokeE2E("inspectChatState")))} dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`,
    }
  );

  console.log(
    `[queue-edit-image] ${config.label} marker=${marker} image folded into queued message`
  );
}

async function runStopRestoresInFlightScenario(config) {
  const marker = `QUEUE_STOP_RESTORE_${config.label.replace(/[^a-zA-Z0-9]/g, "_")}_${Date.now()}`;
  const firstPrompt = longRunningPromptForConfig(config);
  const followupPrompt = `Keep this queued while Stop restores the active prompt: ${marker}`;

  await configureScenario(config);
  const inputSelector = await waitForChatInput();
  await typeAndClickSend(inputSelector, firstPrompt);
  await waitForChatLaunched(firstPrompt);
  await waitForWorkingTurn(`${config.label}-stop-restore`);

  const chatInputSelector = await waitForChatInput();
  await typeAndSubmitWithShortcut(chatInputSelector, followupPrompt);
  await waitForQueuedFollowup(marker);
  await assertQueuedFollowupRemainsParked(
    `${config.label}-active-turn-before-stop`,
    marker
  );
  await clickMainAction("stop", `${config.label}-stop-restore`);
  await assertComposerImmediatelyUnlockedAfterStop(
    `${config.label}-stop-restore`,
    marker
  );
  await browser.waitUntil(
    async () => {
      const state = await inspectChatState(
        `${config.label}-stop-restore-cancel-started`
      );
      if (!hasAuthoritativeRunningTurn(state)) return true;
      if (state.isPendingCancel || state.userInitiatedCancel) return true;
      const editorText = await execJS(js.editorText);
      const restoredPromptVisible =
        typeof editorText === "string" &&
        editorText.includes(firstPrompt.slice(0, 80));
      const queuedStillContainsMarker = state.queuedMessages.some((item) =>
        item.content.includes(marker)
      );
      if (restoredPromptVisible && queuedStillContainsMarker) return true;
      const sendState = await execJS(js.sendState);
      if (sendState?.state === "stop" && !sendState.disabled) {
        await clickMainAction(
          "stop",
          `${config.label}-stop-restore-retry`,
          2_000
        ).catch(() => undefined);
      }
      return false;
    },
    {
      timeout: 45_000,
      interval: 1_000,
      timeoutMsg: `${config.label} Stop click did not begin cancellation; state=${JSON.stringify(summarizeChatState(await invokeE2E("inspectChatState")))} sendState=${JSON.stringify(await execJS(js.sendState))}`,
    }
  );

  await browser.waitUntil(
    async () => {
      const editorText = await execJS(js.editorText);
      const state = await inspectChatState(`${config.label}-stop-restore`);
      const queuedStillContainsMarker = state.queuedMessages.some((item) =>
        item.content.includes(marker)
      );
      return (
        typeof editorText === "string" &&
        editorText.includes(firstPrompt.slice(0, 80)) &&
        queuedStillContainsMarker
      );
    },
    {
      timeout: 45_000,
      interval: 500,
      timeoutMsg: `${config.label} Stop did not restore in-flight prompt while preserving queue; state=${JSON.stringify(summarizeChatState(await invokeE2E("inspectChatState")))} dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`,
    }
  );
}

async function runBurstQueueSendNowOrderingScenario(config) {
  const suffix = `${config.label.replace(/[^a-zA-Z0-9]/g, "_")}_${Date.now()}`;
  const firstPrompt = longRunningPromptForConfig(config);
  const firstMarker = `BURST_Q1_${suffix}`;
  const middleMarker = `BURST_Q2_MIDDLE_${suffix}`;
  const lastMarker = `BURST_Q3_${suffix}`;
  const draftMarker = `BURST_DRAFT_AFTER_STOP_${suffix}`;
  const firstQueuedPrompt = `${longRunningPromptForConfig(config)} Keep this first burst queued marker parked: ${firstMarker}`;
  const middleQueuedPrompt = `${longRunningPromptForConfig(config)} Send Now will target this middle burst queued marker: ${middleMarker}`;
  const lastQueuedPrompt = `${longRunningPromptForConfig(config)} Keep this last burst queued marker parked: ${lastMarker}`;
  const draftPrompt = `${longRunningPromptForConfig(config)} This explicit draft after Stop must run before parked siblings: ${draftMarker}`;

  await configureScenario(config);
  const inputSelector = await waitForChatInput();
  await typeAndClickSend(inputSelector, firstPrompt);
  await waitForChatLaunched(firstPrompt);
  await waitForWorkingTurn(`${config.label}-burst-initial`);

  const chatInputSelector = await waitForChatInput();
  for (const prompt of [
    firstQueuedPrompt,
    middleQueuedPrompt,
    lastQueuedPrompt,
  ]) {
    await typeAndSubmitWithShortcut(chatInputSelector, prompt);
  }
  for (const marker of [firstMarker, middleMarker, lastMarker]) {
    await waitForQueuedFollowup(marker);
    await waitForMarkerState(
      `${config.label}-${marker}-initially-queued`,
      marker,
      {
        shouldBeQueued: true,
        shouldBeUserTurn: false,
      }
    );
  }

  await clickSendNowForQueuedMarker(middleMarker);
  await waitForMarkerState(
    `${config.label}-burst-middle-force-sent`,
    middleMarker,
    {
      shouldBeQueued: false,
      shouldBeUserTurn: true,
    },
    60_000
  );
  await waitForMarkerState(
    `${config.label}-burst-first-after-middle`,
    firstMarker,
    {
      shouldBeQueued: true,
      shouldBeUserTurn: false,
    }
  );
  await waitForMarkerState(
    `${config.label}-burst-last-after-middle`,
    lastMarker,
    {
      shouldBeQueued: true,
      shouldBeUserTurn: false,
    }
  );

  await waitForWorkingTurn(`${config.label}-burst-middle-working`);
  await clickMainAction("stop", `${config.label}-burst-stop-middle`, 30_000);
  await assertComposerImmediatelyUnlockedAfterStop(
    `${config.label}-burst-stop-middle`,
    firstMarker
  );

  await typeAndSubmitWithShortcut(chatInputSelector, draftPrompt);
  await waitForMarkerState(
    `${config.label}-burst-draft-after-stop`,
    draftMarker,
    {
      shouldBeQueued: false,
      shouldBeUserTurn: true,
    },
    60_000
  );
  await waitForMarkerState(
    `${config.label}-burst-first-after-draft`,
    firstMarker,
    {
      shouldBeQueued: true,
      shouldBeUserTurn: false,
    }
  );
  await waitForMarkerState(
    `${config.label}-burst-last-after-draft`,
    lastMarker,
    {
      shouldBeQueued: true,
      shouldBeUserTurn: false,
    }
  );
}

async function runQueueAutodispatchesAfterNaturalCompletionScenario(config) {
  const suffix = `${config.label.replace(/[^a-zA-Z0-9]/g, "_")}_${Date.now()}`;
  const firstPrompt = repoExplorationPromptForConfig(config, 8);
  const marker = `QUEUE_AUTODISPATCH_AFTER_COMPLETE_${suffix}`;
  const followupPrompt = `This queued follow-up must auto-dispatch after the active turn naturally completes: ${marker}`;

  await configureScenario(config);
  const inputSelector = await waitForChatInput();
  await typeAndClickSend(inputSelector, firstPrompt);
  await waitForChatLaunched(firstPrompt);
  await waitForWorkingTurn(`${config.label}-autodispatch-working`);

  const chatInputSelector = await waitForChatInput();
  await typeAndClickSend(chatInputSelector, followupPrompt);
  await waitForQueuedFollowup(marker);
  await waitForMarkerState(
    `${config.label}-autodispatch-initially-queued`,
    marker,
    { shouldBeQueued: true, shouldBeUserTurn: false }
  );

  await browser.waitUntil(
    async () => {
      const state = await inspectChatState(`${config.label}-autodispatch`);
      throwIfProviderRuntimeBlocked(state, `${config.label}-autodispatch`);
      const queuedStillContainsMarker = state.queuedMessages.some((item) =>
        item.content.includes(marker)
      );
      const markerWasSent =
        markerUserTranscriptEvents(state, marker).length > 0;
      const markerPreviewEvents = markerSyntheticPreviewEvents(
        state,
        marker
      ).length;
      return (
        markerWasSent && markerPreviewEvents === 0 && !queuedStillContainsMarker
      );
    },
    {
      timeout: REPLY_TIMEOUT_MS,
      interval: 1_000,
      timeoutMsg: `${config.label} queued follow-up did not auto-dispatch after natural completion; marker=${marker} state=${JSON.stringify(summarizeChatState(await invokeE2E("inspectChatState")))} dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`,
    }
  );
}

async function runSendAfterIdleDoesNotQueueScenario(config) {
  const suffix = `${config.label.replace(/[^a-zA-Z0-9]/g, "_")}_${Date.now()}`;
  const firstPrompt = repoExplorationPromptForConfig(config, 1);
  const marker = `SEND_AFTER_IDLE_DIRECT_${suffix}`;
  const secondPrompt = `This prompt is sent only after the previous turn is fully idle and must not enter the frontend queue: ${marker}`;

  await configureScenario(config);
  const inputSelector = await waitForChatInput();
  await typeAndClickSend(inputSelector, firstPrompt);
  await waitForChatLaunched(firstPrompt);
  await waitForRuntimeIdle(`${config.label}-send-after-idle-first-turn`);
  await waitForIdleSendButton(`${config.label}-send-after-idle-first-turn`);

  const beforeSecond = await inspectChatState(
    `${config.label}-send-after-idle-before-second-send`
  );
  throwIfProviderRuntimeBlocked(beforeSecond, `${config.label}-send-after-idle`);
  if (beforeSecond.queuedMessages.length > 0) {
    throw new Error(
      `${config.label} had leftover queued messages before idle direct-send assertion; state=${JSON.stringify(summarizeChatState(beforeSecond))}`
    );
  }

  const chatInputSelector = await waitForChatInput();
  await typeAndClickSend(chatInputSelector, secondPrompt);

  await browser.waitUntil(
    async () => {
      const state = await inspectChatState(`${config.label}-send-after-idle`);
      throwIfProviderRuntimeBlocked(state, `${config.label}-send-after-idle`);
      const queuedMarkerCount = state.queuedMessages.filter((item) =>
        item.content.includes(marker)
      ).length;
      const markerUserTurnCount = markerUserTranscriptEvents(
        state,
        marker
      ).length;
      if (queuedMarkerCount > 0) {
        throw new Error(
          `${config.label} idle follow-up incorrectly entered messageQueueAtom; marker=${marker} state=${JSON.stringify(summarizeChatState(state))}`
        );
      }
      return markerUserTurnCount === 1;
    },
    {
      timeout: QUEUE_TIMEOUT_MS,
      interval: 500,
      timeoutMsg: `${config.label} idle follow-up did not become a direct user turn; marker=${marker} state=${JSON.stringify(summarizeChatState(await invokeE2E("inspectChatState")))} dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`,
    }
  );
}

async function runQueueDoesNotAutoflushWhileActiveScenario(config) {
  const suffix = `${config.label.replace(/[^a-zA-Z0-9]/g, "_")}_${Date.now()}`;
  const firstPrompt = repoExplorationPromptForConfig(config);
  const clickMarker = `NO_AUTOFLUSH_CLICK_${suffix}`;
  const shortcutMarker = `NO_AUTOFLUSH_SHORTCUT_${suffix}`;
  const clickPrompt = `This click-submitted follow-up must stay queued while the active turn is still running: ${clickMarker}`;
  const shortcutPrompt = `This shortcut-submitted follow-up must also stay queued while the active turn is still running: ${shortcutMarker}`;

  await configureScenario(config);
  const inputSelector = await waitForChatInput();
  await typeAndClickSend(inputSelector, firstPrompt);
  await waitForChatLaunched(firstPrompt);
  await waitForWorkingTurn(`${config.label}-no-autoflush-working`);

  const chatInputSelector = await waitForChatInput();
  await typeAndClickSend(chatInputSelector, clickPrompt);
  await browser.waitUntil(
    async () => {
      const state = await inspectChatState(
        `${config.label}-no-autoflush-click-after-click-submit`
      );
      return state.queuedMessages.some((item) =>
        item.content.includes(clickMarker)
      );
    },
    {
      timeout: QUEUE_TIMEOUT_MS,
      interval: 500,
      timeoutMsg: `${config.label} click-submitted follow-up did not enter messageQueueAtom; marker=${clickMarker} state=${JSON.stringify(summarizeChatState(await invokeE2E("inspectChatState")))}`,
    }
  );
  await typeAndSubmitWithShortcut(chatInputSelector, shortcutPrompt);
  await waitForQueuedFollowup(shortcutMarker);

  await waitForMarkerState(
    `${config.label}-no-autoflush-click-initial`,
    clickMarker,
    { shouldBeQueued: true, shouldBeUserTurn: false }
  );
  await waitForMarkerState(
    `${config.label}-no-autoflush-shortcut-initial`,
    shortcutMarker,
    { shouldBeQueued: true, shouldBeUserTurn: false }
  );

  await browser.pause(5_000);
  const state = await inspectChatState(`${config.label}-no-autoflush-after-5s`);
  assertQueuedMarkerState(
    state,
    `${config.label}-no-autoflush-click-after-5s`,
    clickMarker,
    {
      shouldBeQueued: true,
      shouldBeUserTurn: false,
    }
  );
  assertQueuedMarkerState(
    state,
    `${config.label}-no-autoflush-shortcut-after-5s`,
    shortcutMarker,
    {
      shouldBeQueued: true,
      shouldBeUserTurn: false,
    }
  );
  if (!hasAuthoritativeRunningTurn(state)) {
    return;
  }

  await clickMainAction("stop", `${config.label}-no-autoflush-stop`, 30_000);
  await assertComposerImmediatelyUnlockedAfterStop(
    `${config.label}-no-autoflush-stop`,
    clickMarker
  );
  await waitForMarkerState(
    `${config.label}-no-autoflush-shortcut-after-stop`,
    shortcutMarker,
    { shouldBeQueued: true, shouldBeUserTurn: false }
  );
}

async function runStopDoubleClickDoesNotResubmitScenario(config) {
  const marker = `DOUBLE_STOP_NO_RESUBMIT_${config.label.replace(/[^a-zA-Z0-9]/g, "_")}_${Date.now()}`;
  const firstPrompt = `${longRunningPromptForConfig(config)} Preserve this double-stop marker in the prompt: ${marker}`;

  await configureScenario(config);
  const inputSelector = await waitForChatInput();
  await typeAndClickSend(inputSelector, firstPrompt);
  await waitForChatLaunched(firstPrompt);
  await waitForWorkingTurn(`${config.label}-double-stop-working`);

  const firstClick = await execJS(
    js.clickWhenState('[data-testid="chat-send-button"]', "stop")
  );
  if (firstClick !== "clicked") {
    throw new Error(
      `${config.label} first Stop click failed in double-click scenario: ${firstClick}; sendState=${JSON.stringify(await execJS(js.sendState))}`
    );
  }
  await browser.pause(150);
  const secondClick = await execJS(
    js.click('[data-testid="chat-send-button"]')
  );
  await assertComposerResponsiveAfterStop(
    `${config.label}-double-stop-first`,
    firstPrompt
  );

  const state = await inspectChatState(
    `${config.label}-double-stop-second-click`
  );
  const sendState = await execJS(js.sendState);
  const editorText = await execJS(js.editorText);
  const userTurns = markerUserTranscriptEvents(state, marker);
  if (userTurns.length > 1 || !String(editorText ?? "").includes(marker)) {
    throw new Error(
      `${config.label} rapid second Stop click re-submitted restored draft; secondClick=${secondClick} userTurns=${userTurns.length} sendState=${JSON.stringify(sendState)} editorText=${JSON.stringify(String(editorText ?? "").slice(0, 180))} state=${JSON.stringify(summarizeChatState(state))} dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`
    );
  }
}

async function runChaosControlFlowScenario(config) {
  const suffix = `${config.label.replace(/[^a-zA-Z0-9]/g, "_")}_${Date.now()}`;
  const firstPrompt = longRunningPromptForConfig(config, 45);
  const queuedOneMarker = `CHAOS_Q1_${suffix}`;
  const queuedTwoMarker = `CHAOS_Q2_${suffix}`;
  const resendMarker = `CHAOS_RESEND_${suffix}`;
  const finalMarker = `CHAOS_FINAL_${suffix}`;
  const queuedOnePrompt = `${longRunningPromptForConfig(config)} Keep this first queued marker in the prompt: ${queuedOneMarker}`;
  const queuedTwoPrompt = `${longRunningPromptForConfig(config)} Keep this second queued marker in the prompt: ${queuedTwoMarker}`;
  const resendPrompt = `${longRunningPromptForConfig(config)} This is the explicit re-send after Stop marker: ${resendMarker}`;
  const finalPrompt = `${longRunningPromptForConfig(config)} This is the final explicit send after the second Stop marker: ${finalMarker}`;

  await configureScenario(config);
  const inputSelector = await waitForChatInput();
  await typeAndClickSend(inputSelector, firstPrompt);
  await waitForChatLaunched(firstPrompt);
  await waitForWorkingTurn(`${config.label}-chaos-initial`);

  const chatInputSelector = await waitForChatInput();
  await typeAndSubmitWithShortcut(chatInputSelector, queuedOnePrompt);
  await waitForQueuedFollowup(queuedOneMarker);
  await typeAndSubmitWithShortcut(chatInputSelector, queuedTwoPrompt);
  await waitForQueuedFollowup(queuedTwoMarker);
  await assertQueuedFollowupRemainsParked(
    `${config.label}-chaos-q1-before-stop`,
    queuedOneMarker
  );
  await assertQueuedFollowupRemainsParked(
    `${config.label}-chaos-q2-before-stop`,
    queuedTwoMarker
  );

  await clickMainAction("stop", `${config.label}-chaos-first-stop`, 30_000);
  await assertComposerImmediatelyUnlockedAfterStop(
    `${config.label}-chaos-first-stop-q1`,
    queuedOneMarker
  );
  await waitForMarkerState(
    `${config.label}-chaos-q2-after-first-stop`,
    queuedTwoMarker,
    { shouldBeQueued: true, shouldBeUserTurn: false }
  );

  await typeAndSubmitWithShortcut(chatInputSelector, resendPrompt);
  await waitForMarkerState(
    `${config.label}-chaos-resend-sent-after-stop`,
    resendMarker,
    {
      shouldBeQueued: false,
      shouldBeUserTurn: true,
    },
    60_000
  );
  await waitForMarkerState(
    `${config.label}-chaos-q1-after-resend`,
    queuedOneMarker,
    { shouldBeQueued: true, shouldBeUserTurn: false }
  );
  await waitForMarkerState(
    `${config.label}-chaos-q2-after-resend`,
    queuedTwoMarker,
    { shouldBeQueued: true, shouldBeUserTurn: false }
  );

  await clickSendNowForQueuedMarker(queuedOneMarker);
  await waitForMarkerState(
    `${config.label}-chaos-q1-force-sent`,
    queuedOneMarker,
    {
      shouldBeQueued: false,
      shouldBeUserTurn: true,
    },
    60_000
  );
  await waitForMarkerState(
    `${config.label}-chaos-q2-after-q1-force`,
    queuedTwoMarker,
    { shouldBeQueued: true, shouldBeUserTurn: false }
  );

  await waitForWorkingTurn(`${config.label}-chaos-q1-working`);
  await clickMainAction("stop", `${config.label}-chaos-second-stop`, 30_000);
  await assertComposerImmediatelyUnlockedAfterStop(
    `${config.label}-chaos-second-stop-q2`,
    queuedTwoMarker
  );

  await typeAndClickSend(chatInputSelector, finalPrompt);
  const finalSubmitProbe = await inspectChatState(
    `${config.label}-chaos-final-submit-probe`
  );
  const finalEditorText = await execJS(js.editorText);
  const finalSendState = await execJS(js.sendState);
  const finalQueued = finalSubmitProbe.queuedMessages.some((item) =>
    item.content.includes(finalMarker)
  );
  const finalUserTurn = markerUserTranscriptEvents(
    finalSubmitProbe,
    finalMarker
  ).length;
  if (
    !finalQueued &&
    finalUserTurn === 0 &&
    String(finalEditorText ?? "").includes(finalMarker)
  ) {
    throw new Error(
      `${config.label} final prompt stayed in editor after submit; sendState=${JSON.stringify(finalSendState)} editorText=${JSON.stringify(String(finalEditorText ?? "").slice(0, 240))} state=${JSON.stringify(summarizeChatState(finalSubmitProbe))}`
    );
  }
  await waitForMarkerState(
    `${config.label}-chaos-final-user-turn`,
    finalMarker,
    {
      shouldBeQueued: false,
      shouldBeUserTurn: true,
    },
    60_000
  );
  await waitForMarkerState(
    `${config.label}-chaos-q2-after-final`,
    queuedTwoMarker,
    { shouldBeQueued: true, shouldBeUserTurn: false }
  );

  await clickSendNowForQueuedMarker(queuedTwoMarker);
  await waitForMarkerState(
    `${config.label}-chaos-q2-force-sent`,
    queuedTwoMarker,
    {
      shouldBeQueued: false,
      shouldBeUserTurn: true,
    },
    60_000
  );
}

async function runForceSendScenario(config) {
  const marker = `QUEUE_FORCE_SEND_${config.label.replace(/[^a-zA-Z0-9]/g, "_")}_${Date.now()}`;
  const firstPrompt = longRunningPromptForConfig(config);
  const followupPrompt = `Stop the previous counting task. Reply with exactly this marker and nothing else: ${marker}`;

  await configureScenario(config);
  const inputSelector = await waitForChatInput();
  await typeAndClickSend(inputSelector, firstPrompt);
  await waitForChatLaunched(firstPrompt);
  await waitForWorkingTurn(config.label);

  const chatInputSelector = await waitForChatInput();
  await typeAndClickSend(chatInputSelector, followupPrompt);
  await waitForQueuedOrForceSentFollowup(marker);
  await clickSendNowForQueuedMarker(marker);
  // Force-send stuck-UI regression pin (2026-06-12): during the interrupt
  // window the panel must visibly acknowledge the click — the planning
  // footer stays/becomes visible (status mirror keeps `running`), the
  // promoted "now" message renders with its "sending now…" state, or the
  // dispatch already consumed the message and the follow-up user turn is
  // rendered in the transcript (fast providers can clear the interrupt
  // window between polls). Before the fix beginTimelineBoundary wrote
  // `idle` AND ChatView hid "now" messages, so the user saw none of these.
  await browser.waitUntil(
    async () => {
      // JSON-string the result — tauri-wd nulls plain object returns.
      const activityJson = await browser.execute((markerText) => {
        const isVisible = (node) => {
          const style = window.getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            rect.width > 0 &&
            rect.height > 0
          );
        };
        const footerVisible = Array.from(
          document.querySelectorAll('[data-testid="planning-footer"]')
        ).some(isVisible);
        const sendingNowVisible = Array.from(
          document.querySelectorAll("[data-queued-message-sending]")
        ).some(isVisible);
        const transcript = document.querySelector(
          '[data-testid="chat-message-list"]'
        );
        const followupInTranscript = Boolean(
          transcript && (transcript.textContent || "").includes(markerText)
        );
        return JSON.stringify({
          footerVisible,
          sendingNowVisible,
          followupInTranscript,
        });
      }, marker);
      const activity = JSON.parse(activityJson || "{}");
      return (
        activity.footerVisible === true ||
        activity.sendingNowVisible === true ||
        activity.followupInTranscript === true
      );
    },
    {
      timeout: 4_000,
      interval: 200,
      timeoutMsg: `${config.label} Send Now produced no visible acknowledgement within 4s (no planning footer, no "sending now" queued card, follow-up not yet in transcript) — force-send window reads as frozen (regression).`,
    }
  );
  await waitForMarkerReply(marker, config.label);
  await waitForIdleSendButton(config.label);

  const surfaces = await assertStationSurfacesConsistent(
    `${config.label}-force-send`
  );
  if (!surfaces.myStation.roundLabel || !surfaces.agentStation.roundLabel) {
    throw new Error(
      `${config.label} missing rendered round label after Force Send; surfaces=${JSON.stringify(surfaces)}`
    );
  }
  if (/Round\s+1\b/.test(surfaces.myStation.roundLabel)) {
    throw new Error(
      `${config.label} Force Send still rendered only Round 1 after multiple user turns; surfaces=${JSON.stringify(surfaces)}`
    );
  }
  // turn_intent_id round-corruption regression pin (2026-06-10).
  // Before the canonical user-intent id wire (commits 830c5330..e6752742),
  // a Stop + Send Now sequence could produce 3+ user rounds for what was
  // actually two genuine user submits. The lifecycle store now drops the
  // invalidated intent and collapses same-intent pairs, so the indexer
  // must materialize at most 2 rounds (1 is also legal: a stopped first
  // turn with zero body events is dropped by materialized_turn_drafts).
  //
  // The pagination label is NOT usable here — the latest page always
  // renders as "Latest Round", never "Round N". The session detail panel
  // "Rounds·N round(s)" line is the rendered projection of
  // session_turns — assert on it when present (the panel is not
  // guaranteed to be rendered in every surface snapshot; the durable
  // backend user_message count below is the hard assertion either way).
  const roundCountMatch = /Rounds·(\d+)\s+round/.exec(
    surfaces.myStation.bodyText
  );
  if (roundCountMatch) {
    const renderedRoundCount = Number.parseInt(roundCountMatch[1], 10);
    if (renderedRoundCount > 2) {
      throw new Error(
        `${config.label} Force Send produced extra phantom rounds (rendered=${renderedRoundCount}, expected<=2). Regression: stale turn_intent_id rows are leaking past the indexer. surfaces=${JSON.stringify(surfaces)}`
      );
    }
  }
  // Cross-check sources of truth: backend-persisted user_message events
  // in the transcript should also be exactly 2 (synthetic optimistic rows
  // carry syntheticUserInput=true and are excluded from the count).
  const transcriptState = await inspectChatState(
    `${config.label}-force-send-round-count`
  );
  const backendUserMessages = (transcriptState.rawEvents ?? []).filter(
    (event) => {
      if (!event || event.source !== "user") return false;
      const result = parseEventResult(event.result);
      return result.syntheticUserInput !== true;
    }
  );
  if (backendUserMessages.length !== 2) {
    throw new Error(
      `${config.label} Force Send persisted ${backendUserMessages.length} backend user_message events, expected exactly 2. Regression: scheduler or persist bridge is writing multiple rows per turn_intent_id. events=${JSON.stringify(backendUserMessages.map((e) => ({ id: e.id, text: (e.displayText ?? "").slice(0, 60) })))}`
    );
  }

  const active = unwrap(
    await invokeE2E("getActiveSessionId"),
    "getActiveSessionId"
  );
  if (!active.sessionId) {
    throw new Error(`${config.label} produced no active session id`);
  }
  expect(active.sessionId).toMatch(config.sessionIdPattern);
  console.log(
    `[queued-followup] ${config.label} session=${active.sessionId} marker=${marker}`
  );
}

// Issue #110 regression: Force Send swallowed while a foreground terminal
// command is running. Unlike runForceSendScenario (which uses a generic LLM
// "wait ~20s" prompt that a provider can satisfy with internal latency), this
// scenario forces the agent to block the turn inside a REAL `sleep 45`
// foreground shell command. Before the fix, force-send left that process alive,
// so the cancelled terminal never landed promptly: the FSM stopping dead-man
// (~10s) fired, the FE dispatched the marker message, but the backend scheduler
// worker stayed blocked on turn #1 until `sleep 45` finished — the marker reply
// only arrived ~45s later (the "swallowed" symptom). With the table-driven
// boundary effects (force-send => shellKill:"foreground"), the foreground shell
// is killed, `exec` returns, the turn loop observes cancel_flag, and the marker
// turn lands well before the 45s command would have completed.
//
// Gated to configs that own a real `exec`/shell foreground tool (rust-agent).
// Configs whose harness cannot run a blocking foreground shell are skipped by
// the spec via config.supportsForegroundShell.
async function runForceSendWhileShellRunningScenario(config) {
  const SLEEP_SECONDS = 45;
  const marker = `QUEUE_FORCE_SEND_SHELL_${config.label.replace(/[^a-zA-Z0-9]/g, "_")}_${Date.now()}`;
  const firstPrompt = blockingShellPromptForConfig(config, SLEEP_SECONDS);
  const followupPrompt = `Stop whatever is currently running and reply with exactly this marker and nothing else: ${marker}`;

  await configureScenario(config);
  const inputSelector = await waitForChatInput();
  await typeAndClickSend(inputSelector, firstPrompt);
  await waitForChatLaunched(firstPrompt);
  await waitForWorkingTurn(config.label);

  // Wait until a foreground shell tool call is actually rendered as running for
  // this session — otherwise we'd race the force-send against tool dispatch and
  // could pass without ever exercising the blocking-shell path.
  await browser.waitUntil(
    async () => {
      const state = await inspectChatState(`${config.label}-force-send-shell`);
      return (state.rawEvents ?? []).some(
        (event) =>
          event &&
          event.actionType === "tool_call" &&
          event.displayStatus === "running" &&
          /shell|exec|terminal|run_shell/i.test(
            `${event.functionName ?? ""} ${event.uiCanonical ?? ""}`
          )
      );
    },
    {
      timeout: 30_000,
      interval: 500,
      timeoutMsg: `${config.label} never rendered a running foreground shell tool call for the blocking command; state=${JSON.stringify(summarizeChatState(await invokeE2E("inspectChatState")))}`,
    }
  );

  const chatInputSelector = await waitForChatInput();
  await typeAndClickSend(chatInputSelector, followupPrompt);
  await waitForQueuedOrForceSentFollowup(marker);

  const forceSendAtMs = Date.now();
  await clickSendNowForQueuedMarker(marker);

  // The core #110 assertion: the marker reply must arrive well before the 45s
  // blocking command would have finished on its own. We give a generous margin
  // (interrupt + provider terminal + redispatch + reply round-trip) but cap it
  // far below SLEEP_SECONDS so a regression that waits for the command to drain
  // naturally fails loudly instead of passing slowly.
  const MAX_MARKER_LATENCY_MS = 30_000;
  await waitForMarkerReply(marker, config.label);
  const markerLatencyMs = Date.now() - forceSendAtMs;
  if (markerLatencyMs >= SLEEP_SECONDS * 1_000) {
    throw new Error(
      `${config.label} Force Send was swallowed (regression #110): marker reply took ${markerLatencyMs}ms, i.e. the turn waited for the ${SLEEP_SECONDS}s foreground command to finish instead of force-send killing it.`
    );
  }
  if (markerLatencyMs >= MAX_MARKER_LATENCY_MS) {
    throw new Error(
      `${config.label} Force Send marker reply was slow (${markerLatencyMs}ms >= ${MAX_MARKER_LATENCY_MS}ms): the foreground shell may not have been killed promptly on force-send.`
    );
  }
  await waitForIdleSendButton(config.label);

  const active = unwrap(
    await invokeE2E("getActiveSessionId"),
    "getActiveSessionId"
  );
  if (!active.sessionId) {
    throw new Error(`${config.label} produced no active session id`);
  }
  expect(active.sessionId).toMatch(config.sessionIdPattern);
  console.log(
    `[queued-followup] ${config.label} force-send-while-shell session=${active.sessionId} marker=${marker} latencyMs=${markerLatencyMs}`
  );
}

export {
  assertStationSurfacesConsistent,
  hasAuthoritativeRunningTurn,
  clickMainAction,
  clickSendNowForQueuedMarker,
  runBurstQueueSendNowOrderingScenario,
  runChaosControlFlowScenario,
  runForceSendScenario,
  runForceSendWhileShellRunningScenario,
  runFreshStopImageRestoreScenario,
  runFreshStopRollbackScenario,
  runQueueAutodispatchesAfterNaturalCompletionScenario,
  runQueueDoesNotAutoflushWhileActiveScenario,
  runQueueEditImageUploadScenario,
  runSendAfterIdleDoesNotQueueScenario,
  runStopDoubleClickDoesNotResubmitScenario,
  runStopRestoresInFlightScenario,
  runStopWithBackgroundSubagentNextMessageScenario,
  waitForIdleSendButton,
  waitForQueuedFollowup,
  waitForRuntimeIdle,
  waitForWorkingTurn,
};

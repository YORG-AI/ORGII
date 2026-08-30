import fs from "node:fs";
import path from "node:path";

import {
  assertStationSurfacesConsistent,
  hasAuthoritativeRunningTurn,
  waitForRuntimeIdle,
} from "./agentQueuedControlScenarios.mjs";
import {
  configureScenario,
  execJS,
  installControlFlowInstrumentation,
  invokeE2E,
  js,
  readControlFlowInstrumentation,
  summarizeChatState,
  summarizePageDump,
  typeAndClickSend,
  unwrap,
  waitForApp,
  waitForChatInput,
  waitForChatLaunched,
} from "./agentQueuedFollowupDriver.mjs";
import {
  clickRedoAllAndConfirm,
  clickUndoAllAndConfirm,
  createTempRepo,
  rewindPromptForConfig,
  waitForFileChangesPanel,
  waitForMarkerFile,
} from "./agentQueuedWorkspaceHelpers.mjs";

async function activeSessionId(label) {
  const active = unwrap(
    await invokeE2E("getActiveSessionId"),
    `${label}-getActiveSessionId`
  );
  if (!active.sessionId) {
    throw new Error(`${label} has no active session id`);
  }
  return active.sessionId;
}

async function activeCliSessionStatus(label) {
  const sessionId = await activeSessionId(label);
  const result = unwrap(
    await invokeE2E("inspectCliSessionStatus", sessionId),
    `${label}-inspectCliSessionStatus`
  );
  return result.session;
}

async function activeCliHistoryMutation(label) {
  const sessionId = await activeSessionId(label);
  const result = unwrap(
    await invokeE2E("inspectCliHistoryMutation", sessionId),
    `${label}-inspectCliHistoryMutation`
  );
  return result.mutation;
}

async function assertCliHistoryMutationIfApplicable(label, reason, minEpoch) {
  const session = await activeCliSessionStatus(label);
  if (!session) return;
  if (session.cli_session_id !== null && session.cli_session_id !== undefined) {
    throw new Error(
      `${label} did not clear CLI native resume id after file-history mutation; session=${JSON.stringify(session)}`
    );
  }
  const mutation = await activeCliHistoryMutation(label);
  if (!mutation) {
    throw new Error(`${label} did not persist CLI history mutation marker`);
  }
  if (mutation.reason !== reason || mutation.epoch < minEpoch) {
    throw new Error(
      `${label} persisted unexpected CLI history mutation marker; expected reason=${reason} minEpoch=${minEpoch} actual=${JSON.stringify(mutation)}`
    );
  }
}

async function ensureMarkerFileCreated(config, filePath, markerText) {
  await waitForMarkerFile(config, filePath, markerText, 60_000);
}

async function reloadAndOpenActiveSession(sessionId, label) {
  await browser.refresh();
  await waitForApp();
  // CLI sessions may need a moment for the adapter to settle after page
  // reload before openSession can locate the session in the store. Retry
  // the openSession call with a short delay if chatEventCount is still 0 —
  // this is a known race on reload for CLI sessions where the
  // session-persistence cache eviction races against the initial history load.
  //
  // Restore-to-checkpoint truncates to a very short history (often a single
  // turn) with no follow-up resend, which widens this race versus edit-resend
  // (whose fresh resend turn re-primes the live store). The chunk table is
  // already authoritative-correct at this point; we just need the live CLI
  // adapter to finish its async re-load, so give it extra attempts.
  const MAX_OPEN_ATTEMPTS = 6;
  for (let attempt = 1; attempt <= MAX_OPEN_ATTEMPTS; attempt++) {
    unwrap(
      await invokeE2E("openSession", sessionId),
      `${label}-openSession-attempt-${attempt}`
    );
    const settled = await browser
      .waitUntil(
        async () => {
          const state = await invokeE2E("inspectChatState");
          return (
            state.activeSessionId === sessionId && state.chatEventCount > 0
          );
        },
        { timeout: 20_000, interval: 1_000 }
      )
      .catch(() => false);
    if (settled) return;
    if (attempt < MAX_OPEN_ATTEMPTS) {
      // Give the CLI adapter more time to finish the post-reload history load
      // before retrying openSession.
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  }
  // Final check with full error message if all attempts exhausted.
  await browser.waitUntil(
    async () => {
      const state = await invokeE2E("inspectChatState");
      return state.activeSessionId === sessionId && state.chatEventCount > 0;
    },
    {
      timeout: 5_000,
      interval: 1_000,
      timeoutMsg: `${label} did not restore session after reload; state=${JSON.stringify(summarizeChatState(await invokeE2E("inspectChatState")))} dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`,
    }
  );
}

async function clickEditResendWithRevertDialog(
  label,
  originalPrompt,
  editedPrompt
) {
  const editClicked = await execJS(`
    const targetText = ${JSON.stringify(originalPrompt.slice(0, 120))};
    const cards = Array.from(document.querySelectorAll('[data-testid="chat-message-user-editable"]'));
    const card = cards.find((node) => (node.textContent || '').includes(targetText));
    if (!card) return { clicked: false, reason: 'missing-card', count: cards.length };
    const button = card.querySelector('[data-testid="chat-message-user-edit-button"]');
    if (button) button.click();
    else card.click();
    return { clicked: true };
  `);
  if (!editClicked?.clicked) {
    throw new Error(
      `${label} could not open edit composer: ${JSON.stringify(editClicked)}`
    );
  }

  const inputSelector =
    '[data-testid="chat-message-edit-composer"] [contenteditable="true"]';
  await browser.waitUntil(async () => execJS(js.exists(inputSelector)), {
    timeout: 10_000,
    interval: 500,
    timeoutMsg: `${label} edit composer did not mount; dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`,
  });

  const typed = await execJS(js.clearAndType(inputSelector, editedPrompt));
  if (!typed.includes(editedPrompt)) {
    throw new Error(
      `${label} failed to type edited prompt: ${JSON.stringify(typed)}`
    );
  }

  const resendClicked = await execJS(`
    const editComposer = document.querySelector('[data-testid="chat-message-edit-composer"]');
    const buttons = Array.from((editComposer || document).querySelectorAll('button'));
    const resend = buttons.find((button) => (button.textContent || '').trim() === 'Resend');
    if (!resend) return { clicked: false, buttons: buttons.map((button) => (button.textContent || '').trim()).filter(Boolean) };
    resend.click();
    return { clicked: true };
  `);
  if (!resendClicked?.clicked) {
    throw new Error(
      `${label} could not click Resend: ${JSON.stringify(resendClicked)}`
    );
  }

  await browser.waitUntil(
    async () =>
      (await execJS(js.exists('[data-testid="rewind-file-changes-revert"]'))) &&
      (await execJS(js.exists('[data-testid="rewind-file-changes-keep"]'))),
    {
      timeout: 10_000,
      interval: 500,
      timeoutMsg: `${label} revert/keep dialog did not appear after edit resend; state=${JSON.stringify(summarizeChatState(await invokeE2E("inspectChatState")))} dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`,
    }
  );

  const revertClicked = await execJS(
    js.click('[data-testid="rewind-file-changes-revert"]')
  );
  if (revertClicked !== "clicked") {
    throw new Error(
      `${label} could not click Revert changes: ${revertClicked}`
    );
  }
}

async function clickRestoreCheckpointWithRevertDialog(label, targetPrompt) {
  const restoreClicked = await execJS(`
    const targetText = ${JSON.stringify(targetPrompt.slice(0, 120))};
    const cards = Array.from(document.querySelectorAll('[data-testid="chat-message-user-editable"]'));
    const card = cards.find((node) => (node.textContent || '').includes(targetText));
    if (!card) return { clicked: false, reason: 'missing-card', count: cards.length };
    const button = card.querySelector('[data-testid="chat-message-restore-checkpoint"]');
    if (!button) return { clicked: false, reason: 'missing-restore-button' };
    button.click();
    return { clicked: true };
  `);
  if (!restoreClicked?.clicked) {
    throw new Error(
      `${label} could not click Restore checkpoint: ${JSON.stringify(restoreClicked)}`
    );
  }

  await browser.waitUntil(
    async () =>
      (await execJS(js.exists('[data-testid="rewind-file-changes-revert"]'))) &&
      (await execJS(js.exists('[data-testid="rewind-file-changes-keep"]'))),
    {
      timeout: 10_000,
      interval: 500,
      timeoutMsg: `${label} revert/keep dialog did not appear after restore checkpoint; state=${JSON.stringify(summarizeChatState(await invokeE2E("inspectChatState")))} dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`,
    }
  );

  const revertClicked = await execJS(
    js.click('[data-testid="rewind-file-changes-revert"]')
  );
  if (revertClicked !== "clicked") {
    throw new Error(
      `${label} could not click Revert changes: ${revertClicked}`
    );
  }
}

/**
 * Restore-to-checkpoint scenario (Cursor-style restore, NO resend).
 *
 * 1. Send message A → creates fileA.
 * 2. Send message B → creates fileB.
 * 3. Restore the session to message B's checkpoint, choosing "Revert changes".
 *    Asserts: fileB reverted, message B + assistant turn removed, fileA + msg A
 *    preserved, NO new message is re-sent (runtime stays idle, no fileB resend).
 * 4. Reload + reopen: history shows exactly message A; message B is gone.
 */
async function runRestoreCheckpointScenario(config) {
  const repoPath = createTempRepo(config.label);
  const safe = config.label.replace(/[^a-zA-Z0-9]/g, "-");
  const safeU = config.label.replace(/[^a-zA-Z0-9]/g, "_");
  const stamp = Date.now();
  const markerFileA = `orgii-restore-a-${safe}-${stamp}.md`;
  const markerTextA = `ORGII_RESTORE_A_${safeU}_${stamp}`;
  const markerFileB = `orgii-restore-b-${safe}-${stamp}.md`;
  const markerTextB = `ORGII_RESTORE_B_${safeU}_${stamp}`;
  const promptA = rewindPromptForConfig(config, markerFileA, markerTextA);
  const promptB = rewindPromptForConfig(config, markerFileB, markerTextB);

  const fileA = path.join(repoPath, markerFileA);
  const fileB = path.join(repoPath, markerFileB);

  try {
    await configureScenario(config, { repoPath });
    const inputSelector = await waitForChatInput();

    // --- Turn A ---
    await typeAndClickSend(inputSelector, promptA);
    await waitForChatLaunched(promptA);
    await ensureMarkerFileCreated(config, fileA, markerTextA);
    await waitForRuntimeIdle(`${config.label}-restore-after-a`);

    // --- Turn B (the checkpoint we will restore to) ---
    await typeAndClickSend(inputSelector, promptB);
    await waitForChatLaunched(promptB);
    await ensureMarkerFileCreated(config, fileB, markerTextB);
    await waitForRuntimeIdle(`${config.label}-restore-after-b`);
    await waitForFileChangesPanel(`${config.label}-restore`);

    // --- Restore to checkpoint B, reverting files ---
    await clickRestoreCheckpointWithRevertDialog(
      `${config.label}-restore-checkpoint`,
      promptB
    );

    // fileB reverted (gone), fileA preserved.
    await browser.waitUntil(
      async () => {
        const fileBGone =
          !fs.existsSync(fileB) ||
          !fs.readFileSync(fileB, "utf8").includes(markerTextB);
        const fileAKept =
          fs.existsSync(fileA) &&
          fs.readFileSync(fileA, "utf8").includes(markerTextA);
        return fileBGone && fileAKept;
      },
      {
        timeout: 60_000,
        interval: 1_000,
        timeoutMsg: `${config.label} restore-checkpoint did not revert fileB while keeping fileA; fileBExists=${fs.existsSync(fileB)} fileB=${fs.existsSync(fileB) ? JSON.stringify(fs.readFileSync(fileB, "utf8")) : "<missing>"} fileAExists=${fs.existsSync(fileA)} fileA=${fs.existsSync(fileA) ? JSON.stringify(fs.readFileSync(fileA, "utf8")) : "<missing>"} state=${JSON.stringify(summarizeChatState(await invokeE2E("inspectChatState")))}`,
      }
    );

    // No resend: turn must land idle and message B's file must NOT be
    // re-created. A resend would have re-run turn B and rewritten fileB, so a
    // permanently-reverted fileB is the strongest live signal of "no resend".
    // (Live EventStore history for agent sessions can lag the truncate RPC, so
    // the authoritative message-history assertion runs after reload below —
    // matching the edit-resend scenario's reload-then-verify pattern.)
    await waitForRuntimeIdle(`${config.label}-restore-after-restore`);
    // Give a brief window to prove fileB is NOT resurrected by a stray resend.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    if (
      fs.existsSync(fileB) &&
      fs.readFileSync(fileB, "utf8").includes(markerTextB)
    ) {
      throw new Error(
        `${config.label} restore-checkpoint re-created fileB (unexpected resend); fileB=${JSON.stringify(fs.readFileSync(fileB, "utf8"))}`
      );
    }
    await assertCliHistoryMutationIfApplicable(
      `${config.label}-after-restore-checkpoint`,
      "file_rewind",
      1
    );

    // LIVE assertion (no reload): the on-screen history must immediately
    // reflect the checkpoint — message A visible, message B gone — and the
    // runtime must read idle. This guards the production UX where restore does
    // NOT reload the page: a regression that cleared the live store (e.g. an
    // over-eager evictSession) would leave the panel rendering an empty
    // "Agent is running" placeholder here even though files/DB were correct.
    await browser.waitUntil(
      async () => {
        const state = await invokeE2E("inspectChatState");
        const userTexts = (state.chatEvents ?? [])
          .filter((event) => event.source === "user")
          .map((event) => String(event.displayText ?? ""));
        const aMatches = userTexts.filter((text) => text.includes(markerTextA));
        const bMatches = userTexts.filter((text) => text.includes(markerTextB));
        return (
          aMatches.length === 1 &&
          bMatches.length === 0 &&
          !hasAuthoritativeRunningTurn(state)
        );
      },
      {
        timeout: 30_000,
        interval: 1_000,
        timeoutMsg: `${config.label} live history after restore-checkpoint was wrong (empty/stale/running) without a reload; state=${JSON.stringify(summarizeChatState(await invokeE2E("inspectChatState")))} dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`,
      }
    );

    await assertStationSurfacesConsistent(`${config.label}-restore-checkpoint`);

    // --- Reload + reopen: only message A survives ---
    const sessionId = await activeSessionId(`${config.label}-restore-reload`);
    await reloadAndOpenActiveSession(
      sessionId,
      `${config.label}-reload-after-restore`
    );
    await browser.waitUntil(
      async () => {
        const state = await invokeE2E("inspectChatState");
        const userTexts = (state.chatEvents ?? [])
          .filter((event) => event.source === "user")
          .map((event) => String(event.displayText ?? ""));
        const aMatches = userTexts.filter((text) => text.includes(markerTextA));
        const bMatches = userTexts.filter((text) => text.includes(markerTextB));
        return aMatches.length === 1 && bMatches.length === 0;
      },
      {
        timeout: 30_000,
        interval: 1_000,
        timeoutMsg: `${config.label} reload history after restore-checkpoint was inconsistent; state=${JSON.stringify(summarizeChatState(await invokeE2E("inspectChatState")))}`,
      }
    );
    await assertStationSurfacesConsistent(`${config.label}-restore-reload`);
  } finally {
    await execJS(
      `window.__orgiiE2EAutoConfirmDestructive = false; return true;`
    ).catch(() => undefined);
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
}

async function runRewindScenario(config) {
  const repoPath = createTempRepo(config.label);
  const markerFile = `orgii-rewind-${config.label.replace(/[^a-zA-Z0-9]/g, "-")}-${Date.now()}.md`;
  const markerText = `ORGII_REWIND_MARKER_${config.label.replace(/[^a-zA-Z0-9]/g, "_")}_${Date.now()}`;
  const replacementMarkerFile = `orgii-rewind-replacement-${config.label.replace(/[^a-zA-Z0-9]/g, "-")}-${Date.now()}.md`;
  const replacementMarkerText = `ORGII_REWIND_REPLACEMENT_${config.label.replace(/[^a-zA-Z0-9]/g, "_")}_${Date.now()}`;
  const prompt = rewindPromptForConfig(config, markerFile, markerText);
  const replacementPrompt = rewindPromptForConfig(
    config,
    replacementMarkerFile,
    replacementMarkerText
  );

  try {
    await configureScenario(config, { repoPath });
    const inputSelector = await waitForChatInput();
    await typeAndClickSend(inputSelector, prompt);
    await waitForChatLaunched(prompt);

    const filePath = path.join(repoPath, markerFile);
    await ensureMarkerFileCreated(config, filePath, markerText);
    await waitForRuntimeIdle(`${config.label}-rewind-before-undo`);
    await waitForFileChangesPanel(`${config.label}-rewind`);
    await installControlFlowInstrumentation(`${config.label}-rewind-undo`);

    await clickUndoAllAndConfirm(`${config.label}-rewind`);

    await browser.waitUntil(
      async () => {
        const panel = await execJS(js.fileChanges);
        const fileExists = fs.existsSync(filePath);
        const fileHasMarker = fileExists
          ? fs.readFileSync(filePath, "utf8").includes(markerText)
          : false;
        return (
          !panel.undoAll &&
          panel.redoAll &&
          !panel.redoAllDisabled &&
          !fileHasMarker
        );
      },
      {
        timeout: 60_000,
        timeoutMsg: `${config.label} Undo All did not rewind file or expose Redo All; exists=${fs.existsSync(filePath)} content=${fs.existsSync(filePath) ? JSON.stringify(fs.readFileSync(filePath, "utf8")) : "<missing>"} fileChanges=${JSON.stringify(await execJS(js.fileChanges))} controlFlow=${JSON.stringify(await readControlFlowInstrumentation())}`,
      }
    );
    await assertCliHistoryMutationIfApplicable(
      `${config.label}-after-undo`,
      "file_rewind",
      1
    );

    await clickRedoAllAndConfirm(`${config.label}-redo`);
    await browser.waitUntil(
      async () =>
        fs.existsSync(filePath) &&
        fs.readFileSync(filePath, "utf8").includes(markerText),
      {
        timeout: 30_000,
        timeoutMsg: `${config.label} Redo All did not restore file; exists=${fs.existsSync(filePath)} content=${fs.existsSync(filePath) ? JSON.stringify(fs.readFileSync(filePath, "utf8")) : "<missing>"} fileChanges=${JSON.stringify(await execJS(js.fileChanges))}`,
      }
    );
    await assertCliHistoryMutationIfApplicable(
      `${config.label}-after-redo`,
      "snapshot_restore",
      2
    );

    try {
      await browser.waitUntil(
        async () => {
          const finalFileChanges = await execJS(js.fileChanges);
          return !finalFileChanges.undoAll && !finalFileChanges.redoAll;
        },
        {
          timeout: 10_000,
          interval: 500,
          timeoutMsg: `${config.label} file review controls remained after Redo All`,
        }
      );
    } catch (error) {
      const finalFileChanges = await execJS(js.fileChanges).catch(() => null);
      throw new Error(
        `${config.label} file review controls remained after Redo All; fileChanges=${JSON.stringify(finalFileChanges)}; original=${error instanceof Error ? error.message : String(error)}`
      );
    }
    await assertStationSurfacesConsistent(`${config.label}-redo`);

    await clickEditResendWithRevertDialog(
      `${config.label}-edit-resend-revert-dialog`,
      prompt,
      replacementPrompt
    );

    const replacementFilePath = path.join(repoPath, replacementMarkerFile);
    await ensureMarkerFileCreated(
      config,
      replacementFilePath,
      replacementMarkerText
    );
    await waitForRuntimeIdle(`${config.label}-rewind-after-edit-resend`);
    await browser.waitUntil(
      async () => {
        const originalStillHasMarker =
          fs.existsSync(filePath) &&
          fs.readFileSync(filePath, "utf8").includes(markerText);
        const replacementHasMarker =
          fs.existsSync(replacementFilePath) &&
          fs
            .readFileSync(replacementFilePath, "utf8")
            .includes(replacementMarkerText);
        return !originalStillHasMarker && replacementHasMarker;
      },
      {
        timeout: 60_000,
        interval: 1_000,
        timeoutMsg: `${config.label} edit-resend Revert changes did not rewind original file and create replacement; originalExists=${fs.existsSync(filePath)} original=${fs.existsSync(filePath) ? JSON.stringify(fs.readFileSync(filePath, "utf8")) : "<missing>"} replacementExists=${fs.existsSync(replacementFilePath)} replacement=${fs.existsSync(replacementFilePath) ? JSON.stringify(fs.readFileSync(replacementFilePath, "utf8")) : "<missing>"} state=${JSON.stringify(summarizeChatState(await invokeE2E("inspectChatState")))}`,
      }
    );
    await assertCliHistoryMutationIfApplicable(
      `${config.label}-after-edit-resend-revert`,
      "file_rewind",
      3
    );
    await assertStationSurfacesConsistent(`${config.label}-edit-resend-revert`);

    const sessionId = await activeSessionId(`${config.label}-reload-history`);
    await reloadAndOpenActiveSession(
      sessionId,
      `${config.label}-reload-after-edit-resend-revert`
    );
    await browser.waitUntil(
      async () => {
        const state = await invokeE2E("inspectChatState");
        const userTexts = (state.chatEvents ?? [])
          .filter((event) => event.source === "user")
          .map((event) => String(event.displayText ?? ""));
        const replacementMatches = userTexts.filter((text) =>
          text.includes(replacementMarkerText)
        );
        const originalMatches = userTexts.filter((text) =>
          text.includes(markerText)
        );
        return replacementMatches.length === 1 && originalMatches.length === 0;
      },
      {
        timeout: 30_000,
        interval: 1_000,
        timeoutMsg: `${config.label} reload/resume history was inconsistent after edit-resend rewind; state=${JSON.stringify(summarizeChatState(await invokeE2E("inspectChatState")))}`,
      }
    );
    await assertStationSurfacesConsistent(`${config.label}-reload-history`);
  } finally {
    await execJS(
      `window.__orgiiE2EAutoConfirmDestructive = false; return true;`
    ).catch(() => undefined);
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
}

export { runRestoreCheckpointScenario, runRewindScenario };

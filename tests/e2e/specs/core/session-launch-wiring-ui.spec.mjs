/* global browser, describe, before, it, process */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BUILTIN_SDE_AGENT_ID,
  DEFAULT_AGENT_ORG_ID,
  E2E_REPO_PATH,
  assertE2ERepoFixture,
  getApiAccount,
  invokeE2E,
  selectPreferredModel,
  selectRenderedDefaultAgentOrg,
  selectRenderedExecMode,
  sendFromRenderedCreator,
  sendRenderedChatPrompt,
  unwrap,
  waitForAgentOrgRunViewByOrg,
  waitForApp,
  waitForSessionAggregateRow,
} from "../../support/core/agentOrgUiDriver.mjs";
import {
  ASK_FORBIDDEN_PROMPT_TOOL_NAMES,
  PLAN_FORBIDDEN_PROMPT_TOOL_NAMES,
  fetchToolInventory,
} from "../../support/core/session/toolCoverage.mjs";

const RUN_ID = Date.now();
const SPEC_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_BINARY = path.resolve(
  SPEC_DIR,
  "../../../..",
  "src-tauri/target/debug/org2"
);
const BUILTIN_OS_AGENT_ID = "builtin:os";
const RENDER_TIMEOUT_MS = 30_000;
const E2E_BASE_URL = `http://127.0.0.1:${process.env.E2E_IDE_SERVER_PORT ?? "13847"}`;
const SCENARIO_FILTER = (process.env.E2E_LAUNCH_WIRING_SCENARIOS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

function shouldRunScenario(name) {
  return SCENARIO_FILTER.length === 0 || SCENARIO_FILTER.includes(name);
}

function shouldSetupRealApiAccount() {
  const fakeOnlyScenarios = new Set([
    "provider-payload-snapshot",
    "fake-provider-auto-compact",
    "runtime-hooks",
  ]);
  return (
    SCENARIO_FILTER.length === 0 ||
    SCENARIO_FILTER.some((scenario) => !fakeOnlyScenarios.has(scenario))
  );
}

function createTempWorkspaceDir(label) {
  return fs.mkdtempSync(
    path.join(os.tmpdir(), `orgii-e2e-${label}-${RUN_ID}-`)
  );
}

function initTempGitRepo(repoPath, label) {
  fs.writeFileSync(path.join(repoPath, "README.md"), `# ${label}\n`, "utf8");
  execFileSync("git", ["init"], { cwd: repoPath, stdio: "ignore" });
  execFileSync("git", ["add", "README.md"], { cwd: repoPath, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], {
    cwd: repoPath,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "ORGII E2E",
      GIT_AUTHOR_EMAIL: "e2e@orgii.local",
      GIT_COMMITTER_NAME: "ORGII E2E",
      GIT_COMMITTER_EMAIL: "e2e@orgii.local",
    },
  });
}

async function postJsonAny(pathname, body = {}, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${E2E_BASE_URL}${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = await response.json();
    if (!response.ok || json?.error) {
      throw new Error(`${pathname} failed: ${JSON.stringify(json)}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

async function postJson(pathname, body = {}, timeoutMs = 10_000) {
  const json = await postJsonAny(pathname, body, timeoutMs);
  if (json?.ok !== true) {
    throw new Error(`${pathname} failed: ${JSON.stringify(json)}`);
  }
  return json;
}

async function execJS(script) {
  return browser.executeScript(script, []);
}

async function invokeTauriCommand(command, args = {}) {
  const envelope = await browser.executeAsyncScript(
    `
      const cb = arguments[arguments.length - 1];
      const command = arguments[0];
      const args = arguments[1];
      const invoke = window.__TAURI_INTERNALS__?.invoke;
      if (typeof invoke !== 'function') {
        cb({ ok: false, error: 'Tauri invoke is unavailable' });
        return;
      }
      Promise.resolve(invoke(command, args))
        .then((result) => cb({ ok: true, result }))
        .catch((error) => cb({ ok: false, error: String(error?.message || error) }));
    `,
    [command, args]
  );
  if (envelope?.ok !== true) {
    throw new Error(
      `Tauri ${command} failed: ${envelope?.error ?? "unknown error"}`
    );
  }
  return envelope.result;
}

async function waitForRenderedSession(sessionId, label) {
  let state = null;
  try {
    await browser.waitUntil(
      async () => {
        state = await execJS(`
          const chatPanel = document.querySelector('[data-testid="chat-panel"]');
          const history = document.querySelector('[data-testid="chat-message-list"]');
          const activeTab = document.querySelector('[data-session-tab="${sessionId}"]');
          const bodyText = document.body.innerText || '';
          return {
            hasChatPanel: Boolean(chatPanel),
            hasHistory: Boolean(history),
            hasActiveTab: Boolean(activeTab),
            bodyHasSession: bodyText.includes(${JSON.stringify(sessionId)}),
            bodyText: bodyText.slice(0, 1800),
          };
        `);
        const chatState = unwrap(
          await invokeE2E("inspectChatState"),
          `inspectChatState(${label})`
        );
        state.chatState = {
          activeSessionId: chatState.activeSessionId,
          activeSession: chatState.activeSession,
          coreSessionId: chatState.coreSessionId,
          sessionView: chatState.sessionView,
        };
        return (
          state.hasChatPanel && state.chatState.activeSessionId === sessionId
        );
      },
      {
        timeout: RENDER_TIMEOUT_MS,
        interval: 500,
        timeoutMsg: `${label} did not render as active chat session`,
      }
    );
  } catch (error) {
    throw new Error(
      `${label} did not render as active chat session: latest=${JSON.stringify(state)} original=${String(error?.message ?? error)}`
    );
  }
  return state;
}

async function launchAndAssert({
  label,
  account,
  model,
  mode,
  agentDefinitionId,
  agentOrgId,
  expectedAgentDefinitionId,
  expectedAgentOrgId,
}) {
  const prompt = `E2E launch wiring ${label} ${RUN_ID}. Reply briefly.`;
  const result = unwrap(
    await invokeE2E("launchSession", {
      category: "rust_agent",
      content: prompt,
      workspacePath: E2E_REPO_PATH,
      keySource: "own_key",
      accountId: account.id,
      model,
      agentDefinitionId,
      agentOrgId,
      mode,
      background: false,
    }),
    `launchSession(${label})`
  ).result;
  const sessionId = result?.sessionId ?? result?.session_id;
  if (!sessionId) {
    throw new Error(
      `${label} launch did not create a session: ${JSON.stringify(result)}`
    );
  }

  await waitForSessionAggregateRow(
    sessionId,
    (session) =>
      session.model === model &&
      session.accountId === account.id &&
      session.agentExecMode === mode &&
      (expectedAgentDefinitionId === undefined ||
        session.agentDefinitionId === expectedAgentDefinitionId) &&
      (expectedAgentOrgId === undefined ||
        session.agentOrgId === expectedAgentOrgId),
    `${label} persisted session metadata`
  );

  unwrap(await invokeE2E("openSession", sessionId), `openSession(${label})`);
  const renderedState = await waitForRenderedSession(sessionId, label);
  if (renderedState.chatState.activeSession?.agentExecMode !== mode) {
    throw new Error(
      `${label} rendered active session mode mismatch: ${JSON.stringify(renderedState)}`
    );
  }
  return { sessionId, result };
}

async function assertModeToolInventory(mode, sessionId) {
  const inventory = await fetchToolInventory(sessionId);
  const promptTools = new Set(inventory.promptVisibleNames);
  const missing = [];
  const unexpected = [];

  const expectPresent = (name) => {
    if (!promptTools.has(name)) missing.push(name);
  };
  const expectAbsent = (name) => {
    if (promptTools.has(name)) unexpected.push(name);
  };

  if (mode === "build") {
    for (const name of ["read_file", "run_shell", "edit_file", "manage_todo"]) {
      expectPresent(name);
    }
    expectAbsent("create_plan");
  } else if (mode === "plan") {
    expectPresent("read_file");
    expectPresent("create_plan");
    expectAbsent("manage_todo");
    for (const name of PLAN_FORBIDDEN_PROMPT_TOOL_NAMES) expectAbsent(name);
  } else if (mode === "ask") {
    expectPresent("read_file");
    for (const name of ASK_FORBIDDEN_PROMPT_TOOL_NAMES) expectAbsent(name);
  }

  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Mode ${mode} tool inventory mismatch for ${sessionId}: missing=${JSON.stringify(missing)} unexpected=${JSON.stringify(unexpected)} inventory=${JSON.stringify(inventory)}`
    );
  }
}

async function assertPersistedSessionWorkspace(sessionId, expected) {
  const workspaceResult = unwrap(
    await invokeE2E("readSessionWorkspaceFromDb", sessionId),
    `readSessionWorkspaceFromDb(${sessionId})`
  ).result;
  const workspace = workspaceResult?.workspace ?? null;
  if (expected.workspaceRoot == null) {
    const hasPersistedRoot = Boolean(workspace?.workspaceRoot);
    const hasPersistedWorkingDir = Boolean(workspace?.workingDir);
    const hasAdditionalDirectories =
      (workspace?.additionalDirectories ?? []).length > 0;
    if (
      hasPersistedRoot ||
      hasPersistedWorkingDir ||
      hasAdditionalDirectories
    ) {
      throw new Error(
        `Expected no persisted workspace for ${sessionId}, got ${JSON.stringify(workspaceResult)}`
      );
    }
    return;
  }

  const additional = (workspace?.additionalDirectories ?? [])
    .map((entry) => entry.path)
    .sort();
  const expectedAdditional = [...(expected.additionalDirectories ?? [])].sort();
  if (
    workspace?.workspaceRoot !== expected.workspaceRoot ||
    JSON.stringify(additional) !== JSON.stringify(expectedAdditional)
  ) {
    throw new Error(
      `Persisted workspace mismatch for ${sessionId}: expected=${JSON.stringify(expected)} actual=${JSON.stringify(workspaceResult)}`
    );
  }
}

async function removeAgentDefIfExists(agentId) {
  const defs = unwrap(
    await invokeE2E("listAgentDefs"),
    "listAgentDefs cleanup"
  ).defs;
  if (defs.some((definition) => definition?.id === agentId)) {
    await invokeE2E("removeAgentDef", agentId);
  }
}

async function waitForRenderedCreatorInput(label) {
  let state = null;
  await browser.waitUntil(
    async () => {
      state = await execJS(`
        const shell = document.querySelector('[data-testid="session-creator-chat-panel"]');
        const editor = shell?.querySelector('[data-testid="chat-input"] [contenteditable="true"]') ?? null;
        const rect = editor?.getBoundingClientRect();
        return {
          hasShell: Boolean(shell),
          hasEditor: Boolean(editor),
          editable: editor?.getAttribute('contenteditable') ?? null,
          visible: Boolean(rect && rect.width > 0 && rect.height > 0),
          body: (document.body.innerText || '').slice(0, 1600),
        };
      `);
      return state?.hasShell === true && state?.hasEditor === true && state?.visible === true;
    },
    {
      timeout: RENDER_TIMEOUT_MS,
      interval: 250,
      timeoutMsg: `${label} rendered creator input never became interactive: ${JSON.stringify(state)}`,
    }
  );
  return state;
}

async function prepareRenderedCreator({
  account,
  model,
  agentDefinitionId,
  agentOrgId,
  repoPath = E2E_REPO_PATH,
}) {
  const config = {
    accountName: account.name ?? account.id,
    model,
    agentType: account.agent_type,
    category: "rust_agent",
    agentDefinitionId,
    agentOrgId,
  };
  if (repoPath) {
    config.repoPath = repoPath;
  }
  unwrap(
    await invokeE2E("configureWithExistingKey", config),
    "configure rendered Session Creator account"
  );
  unwrap(
    await invokeE2E("navigateTo", "/orgii/workstation/code"),
    "navigate to workstation before rendered Session Creator reset"
  );
  unwrap(
    await invokeE2E("resetToNewSession"),
    "resetToNewSession before rendered Session Creator action"
  );
  await waitForRenderedCreatorInput("prepareRenderedCreator");
}

async function typeRenderedCreatorPrompt(prompt, label) {
  const state = await execJS(`
    const shell = document.querySelector('[data-testid="session-creator-chat-panel"]') ?? document;
    const editor = shell.querySelector('[contenteditable="true"]');
    if (!editor) return { ok: false, reason: "missing-editor" };
    editor.focus();
    editor.textContent = ${JSON.stringify(prompt)};
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(prompt)} }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
    const button = shell.querySelector('[data-testid="chat-send-button"]');
    return {
      ok: true,
      editorText: editor.textContent || '',
      buttonState: button?.getAttribute('data-state') ?? null,
      buttonDisabled: button ? Boolean(button.disabled) : null,
    };
  `);
  if (state?.ok !== true || !String(state.editorText ?? "").includes(prompt)) {
    throw new Error(
      `${label} prompt was not typed into rendered creator: ${JSON.stringify(state)}`
    );
  }
  return state;
}

async function focusRenderedCreatorInput(label) {
  await waitForRenderedCreatorInput(label);
  const state = await execJS(`
    const shell = document.querySelector('[data-testid="session-creator-chat-panel"]');
    const editor = shell?.querySelector('[data-testid="chat-input"] [contenteditable="true"]') ?? null;
    if (!editor) return { ok: false, reason: "missing-editor" };
    editor.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
    return {
      ok: true,
      text: editor.textContent || '',
      activeIsEditor: document.activeElement === editor,
    };
  `);
  if (state?.ok !== true || state.activeIsEditor !== true) {
    throw new Error(`${label} could not focus rendered creator input: ${JSON.stringify(state)}`);
  }
}

async function readRenderedCreatorTextState() {
  return execJS(`
    const shell = document.querySelector('[data-testid="session-creator-chat-panel"]');
    const editor = shell?.querySelector('[data-testid="chat-input"] [contenteditable="true"]') ?? null;
    return {
      ok: Boolean(editor),
      editorText: editor?.textContent || '',
      activeTag: document.activeElement?.tagName || '',
      activeText: document.activeElement?.textContent || '',
      activeIsEditor: document.activeElement === editor,
    };
  `);
}

async function selectRenderedCreatorText(label) {
  const state = await execJS(`
    const shell = document.querySelector('[data-testid="session-creator-chat-panel"]');
    const editor = shell?.querySelector('[data-testid="chat-input"] [contenteditable="true"]') ?? null;
    if (!editor) return { ok: false, reason: "missing-editor" };
    editor.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection?.removeAllRanges();
    selection?.addRange(range);
    return {
      ok: true,
      editorText: editor.textContent || '',
      activeIsEditor: document.activeElement === editor,
    };
  `);
  if (state?.ok !== true || state.activeIsEditor !== true) {
    throw new Error(`${label} could not select rendered creator text: ${JSON.stringify(state)}`);
  }
  return state;
}

async function insertRenderedCreatorTextWithInputEvent(text, label) {
  const state = await execJS(`
    const shell = document.querySelector('[data-testid="session-creator-chat-panel"]');
    const editor = shell?.querySelector('[data-testid="chat-input"] [contenteditable="true"]') ?? null;
    if (!editor) return { ok: false, reason: "missing-editor" };
    editor.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection?.removeAllRanges();
    selection?.addRange(range);
    const inserted = document.execCommand('insertText', false, ${JSON.stringify(text)});
    editor.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: ${JSON.stringify(text)},
    }));
    return {
      ok: true,
      inserted,
      editorText: editor.textContent || '',
      activeIsEditor: document.activeElement === editor,
    };
  `);
  if (state?.ok !== true || !String(state.editorText ?? "").includes(text)) {
    throw new Error(`${label} could not insert rendered creator text through input event: ${JSON.stringify(state)}`);
  }
  return state;
}

async function waitForRenderedCreatorExactText(text, label) {
  let state = null;
  try {
    await browser.waitUntil(
      async () => {
        state = await readRenderedCreatorTextState();
        return state?.ok === true && String(state.editorText ?? "") === text;
      },
      {
        timeout: RENDER_TIMEOUT_MS,
        interval: 100,
        timeoutMsg: `${label} rendered creator text did not stabilize`,
      }
    );
  } catch (error) {
    state = await readRenderedCreatorTextState();
    throw new Error(`${error.message}: latest=${JSON.stringify(state)}`);
  }
  return state;
}

async function insertRenderedCreatorText(text, label) {
  await focusRenderedCreatorInput(label);
  await selectRenderedCreatorText(label);
  await browser.keys("Backspace");
  await browser.keys(text);

  let state = await readRenderedCreatorTextState();
  if (String(state?.editorText ?? "") !== text) {
    await insertRenderedCreatorTextWithInputEvent(text, label);
  }

  return waitForRenderedCreatorExactText(text, label);
}

async function readRenderedShellTextState(shellSelector) {
  return execJS(`
    const shell = document.querySelector(${JSON.stringify(shellSelector)}) ?? document;
    const editor = shell.querySelector('[data-testid="chat-input"] [contenteditable="true"]');
    return {
      ok: Boolean(editor),
      editorText: editor?.textContent || '',
      activeTag: document.activeElement?.tagName || '',
      activeText: document.activeElement?.textContent || '',
      activeIsEditor: document.activeElement === editor,
    };
  `);
}

async function selectRenderedShellText(label, shellSelector) {
  let state = null;
  try {
    await browser.waitUntil(
      async () => {
        state = await execJS(`
          const shell = document.querySelector(${JSON.stringify(shellSelector)}) ?? document;
          const inputShells = Array.from(shell.querySelectorAll('[data-testid="chat-input"]')).filter((candidate) => {
            const rect = candidate.getBoundingClientRect();
            const style = window.getComputedStyle(candidate);
            return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
          });
          const inputShell = inputShells[inputShells.length - 1] ?? null;
          const editor = inputShell?.querySelector('[contenteditable="true"]') ?? null;
          if (!editor) {
            return {
              ok: false,
              reason: "missing-visible-editor",
              shellFound: shell !== document,
              inputShellCount: inputShells.length,
              body: (document.body.innerText || '').slice(0, 1600),
            };
          }
          editor.focus();
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(editor);
          selection?.removeAllRanges();
          selection?.addRange(range);
          return {
            ok: true,
            editorText: editor.textContent || '',
            activeIsEditor: document.activeElement === editor,
            inputShellCount: inputShells.length,
          };
        `);
        return state?.ok === true && state.activeIsEditor === true;
      },
      {
        timeout: RENDER_TIMEOUT_MS,
        interval: 250,
        timeoutMsg: `${label} visible composer editor did not mount`,
      }
    );
  } catch (error) {
    throw new Error(`${error.message}: latest=${JSON.stringify(state)}`);
  }
  return state;
}

async function insertRenderedShellTextWithInputEvent(text, label, shellSelector) {
  const state = await execJS(`
    const shell = document.querySelector(${JSON.stringify(shellSelector)}) ?? document;
    const editor = shell.querySelector('[data-testid="chat-input"] [contenteditable="true"]');
    if (!editor) return { ok: false, reason: "missing-editor" };
    editor.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection?.removeAllRanges();
    selection?.addRange(range);
    const inserted = document.execCommand('insertText', false, ${JSON.stringify(text)});
    editor.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: ${JSON.stringify(text)},
    }));
    return {
      ok: true,
      inserted,
      editorText: editor.textContent || '',
      activeIsEditor: document.activeElement === editor,
    };
  `);
  if (state?.ok !== true || !String(state.editorText ?? "").includes(text)) {
    throw new Error(`${label} could not insert rendered shell text through input event: ${JSON.stringify(state)}`);
  }
  return state;
}

async function waitForRenderedShellExactText(text, label, shellSelector) {
  let state = null;
  try {
    await browser.waitUntil(
      async () => {
        state = await readRenderedShellTextState(shellSelector);
        return state?.ok === true && String(state.editorText ?? "") === text;
      },
      {
        timeout: RENDER_TIMEOUT_MS,
        interval: 100,
        timeoutMsg: `${label} rendered shell text did not stabilize`,
      }
    );
  } catch (error) {
    state = await readRenderedShellTextState(shellSelector);
    throw new Error(`${error.message}: latest=${JSON.stringify(state)}`);
  }
  return state;
}

async function insertRenderedShellText(text, label, shellSelector) {
  await selectRenderedShellText(label, shellSelector);
  await browser.keys("Backspace");
  await browser.keys(text);

  const state = await readRenderedShellTextState(shellSelector);
  if (String(state?.editorText ?? "") !== text) {
    await insertRenderedShellTextWithInputEvent(text, label, shellSelector);
  }

  return waitForRenderedShellExactText(text, label, shellSelector);
}

async function openEditorPaletteSearch(query, label) {
  const opened = await execJS(`
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'p',
      code: 'KeyP',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    }));
    return true;
  `);
  if (opened !== true) {
    throw new Error(`${label} failed to dispatch Cmd+P`);
  }

  await browser.waitUntil(
    async () => execJS(`return !!document.querySelector('[data-spotlight-input="true"]');`),
    {
      timeout: RENDER_TIMEOUT_MS,
      interval: 250,
      timeoutMsg: `${label} editor palette input did not open`,
    }
  );

  const inputState = await execJS(`
    const input = document.querySelector('[data-spotlight-input="true"]');
    if (!input) return { ok: false, reason: 'missing-input' };
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, ${JSON.stringify(query)});
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(query)} }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, value: input.value };
  `);
  if (inputState?.ok !== true || inputState?.value !== query) {
    throw new Error(`${label} failed to set palette query: ${JSON.stringify(inputState)}`);
  }
}

async function assertMultiRootEditorPaletteSearch({
  secondaryName,
  secondaryFilePath,
  query,
  label = "multi-root Cmd+P search",
}) {
  await openEditorPaletteSearch(query, label);

  let state = null;
  await browser.waitUntil(
    async () => {
      state = await execJS(`
        const rows = Array.from(document.querySelectorAll('[data-spotlight-item-id]')).map((row) => ({
          id: row.getAttribute('data-spotlight-item-id') || '',
          text: row.textContent || '',
        }));
        return {
          inputValue: document.querySelector('[data-spotlight-input="true"]')?.value || '',
          rows,
          body: (document.body.innerText || '').slice(0, 2400),
        };
      `);
      return (state?.rows ?? []).some(
        (row) =>
          String(row.id) === secondaryFilePath ||
          (String(row.id).includes(path.basename(secondaryFilePath)) &&
            String(row.text).includes(secondaryName))
      );
    },
    {
      timeout: RENDER_TIMEOUT_MS,
      interval: 250,
      timeoutMsg: `${label} did not render secondary repo file result`,
    }
  );

  const matched = (state?.rows ?? []).find(
    (row) =>
      String(row.id) === secondaryFilePath ||
      (String(row.id).includes(path.basename(secondaryFilePath)) &&
        String(row.text).includes(secondaryName))
  );
  if (!matched) {
    throw new Error(`${label} missing secondary repo row: ${JSON.stringify(state)}`);
  }
}

async function assertMultiRootAtSearchSources({
  primaryName,
  secondaryName,
  secondaryPath,
  shellSelector = '[data-testid="session-creator-chat-panel"]',
  label = "multi-root @ search",
}) {
  await insertRenderedShellText(`repo @${secondaryName}`, label, shellSelector);

  let rootState = null;
  try {
    await browser.waitUntil(
      async () => {
        rootState = await execJS(`
          const shell = document.querySelector(${JSON.stringify(shellSelector)}) ?? document;
          const editor = shell.querySelector('[data-testid="chat-input"] [contenteditable="true"]');
          const rows = Array.from(document.querySelectorAll('.context-menu [class*="cursor-pointer"]'))
            .map((row) => ({
              text: row.textContent || '',
            }));
          return {
            rows,
            editorText: editor?.textContent || '',
            body: (document.body.innerText || '').slice(0, 2400),
          };
        `);
        return (
          String(rootState?.editorText ?? "").includes(`repo @${secondaryName}`) &&
          (rootState?.rows ?? []).some((row) => String(row.text ?? "").startsWith(secondaryName))
        );
      },
      {
        timeout: RENDER_TIMEOUT_MS,
        interval: 250,
        timeoutMsg: `${label} did not render repo root row`,
      }
    );
  } catch (error) {
    throw new Error(
      `${error.message}: latest=${JSON.stringify(rootState)}`
    );
  }

  const rootClickState = await execJS(`
    const rows = Array.from(document.querySelectorAll('.context-menu [class*="cursor-pointer"]'));
    const row = rows.find((candidate) => (candidate.textContent || '').startsWith(${JSON.stringify(secondaryName)}));
    if (!row) return { ok: false, reason: "missing-root-row", rows: rows.map((node) => node.textContent || '') };
    row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    row.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
    row.click();
    return { ok: true };
  `);
  if (rootClickState?.ok !== true) {
    throw new Error(`${label} root row click failed: ${JSON.stringify(rootClickState)}`);
  }

  await browser.waitUntil(
    async () => {
      const pillState = await execJS(`
        const shell = document.querySelector(${JSON.stringify(shellSelector)}) ?? document;
        const editor = shell.querySelector('[data-testid="chat-input"] [contenteditable="true"]');
        const pills = Array.from(shell.querySelectorAll('[data-composer-pill="true"]')).map((pill) => ({
          filePath: pill.getAttribute('data-file-path') || '',
          fileName: pill.getAttribute('data-file-name') || '',
          iconType: pill.getAttribute('data-icon-type') || '',
        }));
        return { editorText: editor?.textContent || '', pills };
      `);
      return (
        !String(pillState?.editorText ?? "").includes(`@${secondaryName}`) &&
        (pillState?.pills ?? []).some(
          (pill) =>
            String(pill.filePath ?? "") === secondaryPath &&
            String(pill.fileName ?? "") === secondaryName &&
            String(pill.iconType ?? "") === "repo"
        )
      );
    },
    {
      timeout: RENDER_TIMEOUT_MS,
      interval: 250,
      timeoutMsg: `${label} did not insert secondary repo root pill: ${JSON.stringify(rootClickState)}`,
    }
  );

  const expectedSecondaryIndexPath = path.join(secondaryPath, "src", "index.tsx");
  await insertRenderedShellText("before @index.tsx", label, shellSelector);

  let state = null;
  try {
    await browser.waitUntil(
      async () => {
        state = await execJS(`
          const shell = document.querySelector(${JSON.stringify(shellSelector)}) ?? document;
          const editor = shell.querySelector('[data-testid="chat-input"] [contenteditable="true"]');
          const menus = Array.from(document.querySelectorAll('.context-menu')).map((menu) => menu.textContent || '');
          const rows = Array.from(document.querySelectorAll('.context-menu [data-testid="context-menu-result-source"]'))
            .map((badge) => {
              const row = badge.closest('[class*="cursor-pointer"]');
              return {
                source: badge.textContent || '',
                title: badge.getAttribute('title') || '',
                rowText: row?.textContent || '',
              };
            });
          return {
            rows,
            menus,
            editorText: editor?.textContent || '',
            activeTag: document.activeElement?.tagName || '',
            activeText: document.activeElement?.textContent || '',
            body: (document.body.innerText || '').slice(0, 2400),
          };
        `);
        const sources = (state?.rows ?? [])
          .filter((row) => String(row.rowText ?? "").includes("index.tsx"))
          .map((row) => row.source);
        return (
          String(state?.editorText ?? "").includes("before @index.tsx") &&
          sources.includes(primaryName) &&
          sources.includes(secondaryName)
        );
      },
      {
        timeout: RENDER_TIMEOUT_MS,
        interval: 250,
        timeoutMsg: `${label} did not render both repo source badges`,
      }
    );
  } catch (error) {
    throw new Error(
      `${error.message}: latest=${JSON.stringify(state)}`
    );
  }

  const clickState = await execJS(`
    const badges = Array.from(document.querySelectorAll('.context-menu [data-testid="context-menu-result-source"]'));
    const badge = badges.find((candidate) => {
      const rowText = candidate.closest('[class*="cursor-pointer"]')?.textContent || '';
      return (candidate.textContent || '').includes(${JSON.stringify(secondaryName)}) && rowText.includes('index.tsx');
    });
    const row = badge?.closest('[class*="cursor-pointer"]') ?? null;
    if (!row) return { ok: false, reason: "missing-secondary-row", badges: badges.map((node) => node.textContent || '') };
    row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    row.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
    row.click();
    const shell = document.querySelector(${JSON.stringify(shellSelector)}) ?? document;
    const pills = Array.from(shell.querySelectorAll('[data-composer-pill="true"]')).map((pill) => ({
      filePath: pill.getAttribute('data-file-path') || '',
      fileName: pill.getAttribute('data-file-name') || '',
      text: pill.textContent || '',
    }));
    return { ok: true, pills };
  `);
  if (clickState?.ok !== true) {
    throw new Error(`${label} secondary row click failed: ${JSON.stringify(clickState)}`);
  }

  await browser.waitUntil(
    async () => {
      const pillState = await execJS(`
        const shell = document.querySelector(${JSON.stringify(shellSelector)}) ?? document;
        const editor = shell.querySelector('[data-testid="chat-input"] [contenteditable="true"]');
        const pills = Array.from(shell.querySelectorAll('[data-composer-pill="true"]')).map((pill) => ({
          filePath: pill.getAttribute('data-file-path') || '',
          fileName: pill.getAttribute('data-file-name') || '',
          text: pill.textContent || '',
        }));
        return { editorText: editor?.textContent || '', pills };
      `);
      return (
        String(pillState?.editorText ?? "").includes("before ") &&
        !String(pillState?.editorText ?? "").includes("@index.tsx") &&
        (pillState?.pills ?? []).some(
          (pill) =>
            String(pill.filePath ?? "") === expectedSecondaryIndexPath &&
            String(pill.fileName ?? "") === "index.tsx"
        )
      );
    },
    {
      timeout: RENDER_TIMEOUT_MS,
      interval: 250,
      timeoutMsg: `${label} did not insert secondary repo pill: ${JSON.stringify(clickState)}`,
    }
  );
}

async function assertRenderedCreatorSendDisabled(label) {
  let state = null;
  await browser.waitUntil(
    async () => {
      state = await execJS(`
        const shell = document.querySelector('[data-testid="session-creator-chat-panel"]') ?? document;
        const button = shell.querySelector('[data-testid="chat-send-button"]');
        return {
          buttonPresent: Boolean(button),
          state: button?.getAttribute('data-state') ?? null,
          disabled: button ? Boolean(button.disabled) : null,
          bodyText: (document.body.innerText || '').slice(0, 1200),
        };
      `);
      return state?.buttonPresent === true && state?.disabled === true;
    },
    {
      timeout: RENDER_TIMEOUT_MS,
      interval: 250,
      timeoutMsg: `${label} send button was not disabled: ${JSON.stringify(state)}`,
    }
  );
  return state;
}

async function selectRenderedAgentDefinition(agentId) {
  unwrap(
    await invokeE2E("navigateTo", "/orgii/workstation/code"),
    "navigate to workstation code"
  );
  await browser.waitUntil(
    async () =>
      execJS(
        `return !!document.querySelector('[data-testid="session-creator-agent-selector"]');`
      ),
    {
      timeout: RENDER_TIMEOUT_MS,
      timeoutMsg:
        "SessionCreator agent selector never rendered for AgentDefinition selection",
    }
  );
  const openResult = await execJS(`
    const selector = document.querySelector('[data-testid="session-creator-agent-selector"]');
    if (!selector) return "missing";
    selector.click();
    return "clicked";
  `);
  if (openResult !== "clicked") {
    throw new Error(
      `Agent selector did not open for ${agentId}: ${openResult}`
    );
  }
  const optionSelector = `[data-testid="session-creator-agent-option-def-${agentId}"]`;
  await browser.waitUntil(
    async () =>
      execJS(
        `return !!document.querySelector(${JSON.stringify(optionSelector)});`
      ),
    {
      timeout: RENDER_TIMEOUT_MS,
      timeoutMsg: `AgentDefinition option ${agentId} never rendered`,
    }
  );
  const clickResult = await execJS(`
    const option = document.querySelector(${JSON.stringify(optionSelector)});
    if (!option) return "missing";
    option.click();
    return "clicked";
  `);
  if (clickResult !== "clicked") {
    throw new Error(
      `AgentDefinition option ${agentId} did not click: ${clickResult}`
    );
  }
  const selection = unwrap(
    await invokeE2E("inspectCreatorSelection"),
    `inspectCreatorSelection(${agentId})`
  ).creator;
  if (selection.selectedAgentDefinitionId !== agentId) {
    throw new Error(
      `AgentDefinition selector mismatch for ${agentId}: ${JSON.stringify(selection)}`
    );
  }
}

describe("Session launch wiring rendered UI invariants", function () {
  this.timeout(180_000);

  let account;
  let model;

  before(async () => {
    assertE2ERepoFixture();
    await waitForApp();
    if (shouldSetupRealApiAccount()) {
      account = await getApiAccount();
      model = selectPreferredModel(account);
    }
  });

  it("centralizes hook capture settings in Launchpad Runtime", async function () {
    if (!shouldRunScenario("runtime-hooks")) {
      this.skip();
      return;
    }

    unwrap(
      await invokeE2E("ensureRepoSelected", { repoPath: E2E_REPO_PATH }),
      "select workspace for Codex hook approval"
    );
    unwrap(await invokeE2E("resetToNewSession"), "reset to Launchpad");

    const clickVisible = async (selector, label) => {
      let point = null;
      await browser.waitUntil(
        async () => {
          point = await execJS(`
            const element = document.querySelector(${JSON.stringify(selector)});
            if (!element) return { ok: false, reason: 'missing' };
            element.scrollIntoView({ block: 'center', inline: 'center' });
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            const x = Math.floor(rect.left + rect.width / 2);
            const y = Math.floor(rect.top + rect.height / 2);
            const hit = document.elementFromPoint(x, y);
            return {
              ok: rect.width > 0 && rect.height > 0 &&
                style.display !== 'none' && style.visibility !== 'hidden' &&
                Boolean(hit && (hit === element || element.contains(hit))),
              x,
              y,
              text: element.textContent?.trim().replace(/\s+/g, ' ').slice(0, 160) ?? '',
            };
          `);
          return point?.ok === true;
        },
        {
          timeout: RENDER_TIMEOUT_MS,
          interval: 250,
          timeoutMsg: `${label} was not pointer-clickable: ${JSON.stringify(point)}`,
        }
      );
      await browser
        .action("pointer")
        .move({ x: point.x, y: point.y })
        .down()
        .up()
        .perform();
    };

    const waitForSwitchState = async (platform, expected) => {
      const selector = `[data-testid="session-provenance-hook-switch-${platform}"]`;
      let state = null;
      await browser.waitUntil(
        async () => {
          state = await execJS(`
            const element = document.querySelector(${JSON.stringify(selector)});
            return element ? {
              present: true,
              checked: element.getAttribute('aria-checked'),
              disabled: Boolean(element.disabled),
            } : { present: false };
          `);
          return (
            state?.present === true &&
            state.checked === String(expected) &&
            state.disabled === false
          );
        },
        {
          timeout: RENDER_TIMEOUT_MS,
          interval: 200,
          timeoutMsg: `Hook switch ${platform} did not settle at ${expected}: ${JSON.stringify(state)}`,
        }
      );
    };

    const openHooks = async () => {
      await clickVisible(
        '[data-testid="chat-panel-start-page-tab-runtime"]',
        "Launchpad Runtime tab"
      );
      await browser.waitUntil(
        async () =>
          execJS(`
            const hooks = document.querySelector('[data-testid="data-source-view-hooks"]');
            if (hooks) return true;
            document.querySelector('[data-testid="chat-panel-start-page-tab-runtime"]')?.click();
            return false;
          `),
        {
          timeout: RENDER_TIMEOUT_MS,
          interval: 300,
          timeoutMsg: "Launchpad Runtime content did not activate",
        }
      );
      await clickVisible('[data-testid="data-source-view-hooks"]', "Hooks tab");
      await browser.waitUntil(
        async () =>
          execJS(`
            const element = document.querySelector('[data-testid="session-provenance-hooks-panel"]');
            if (!element) return false;
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
          `),
        {
          timeout: RENDER_TIMEOUT_MS,
          timeoutMsg: "Session Provenance hooks panel did not render",
        }
      );
    };

    await openHooks();

    let panelState = null;
    await browser.waitUntil(
      async () => {
        panelState = await execJS(`
          const panel = document.querySelector('[data-testid="session-provenance-hooks-panel"]');
          const switches = ['claude_code', 'codex', 'cursor'].map((platform) => {
            const element = document.querySelector('[data-testid="session-provenance-hook-switch-' + platform + '"]');
            return {
              platform,
              present: Boolean(element),
              checked: element?.getAttribute('aria-checked') ?? null,
              disabled: element ? Boolean(element.disabled) : null,
            };
          });
          return {
            text: panel?.textContent ?? '',
            switches,
          };
        `);
        return (
          panelState.switches.every(
            (item) => item.present && item.disabled === false
          ) &&
          panelState.text.includes("Claude Code") &&
          panelState.text.includes("Codex") &&
          panelState.text.includes("Cursor") &&
          panelState.text.includes(".claude/settings.json") &&
          panelState.text.includes(".codex/hooks.json") &&
          panelState.text.includes(".cursor/hooks.json")
        );
      },
      {
        timeout: RENDER_TIMEOUT_MS,
        interval: 250,
        timeoutMsg: `Centralized hook settings did not load: ${JSON.stringify(panelState)}`,
      }
    );

    const originalCodexState =
      panelState.switches.find((item) => item.platform === "codex")?.checked ===
      "true";
    const toggledCodexState = !originalCodexState;

    try {
      await clickVisible(
        '[data-testid="session-provenance-hook-switch-codex"]',
        "Codex hook switch"
      );
      await waitForSwitchState("codex", toggledCodexState);

      // Unmount and remount the production panel. The reloaded state comes
      // from the real Tauri status command, not the component's optimistic state.
      await clickVisible(
        '[data-testid="data-source-view-scanning"]',
        "Scanning tab"
      );
      await openHooks();
      await waitForSwitchState("codex", toggledCodexState);
    } finally {
      await openHooks();
      const current = await execJS(`
        return document.querySelector('[data-testid="session-provenance-hook-switch-codex"]')?.getAttribute('aria-checked') === 'true';
      `);
      if (current !== originalCodexState) {
        await clickVisible(
          '[data-testid="session-provenance-hook-switch-codex"]',
          "Codex hook switch restore"
        );
      }
      await waitForSwitchState("codex", originalCodexState);
    }

    // Codex is the one managed provider with its own trust gate. Installation
    // alone must never be rendered as active.
    await openHooks();
    const codexEnabled = await execJS(`
      return document.querySelector('[data-testid="session-provenance-hook-switch-codex"]')?.getAttribute('aria-checked') === 'true';
    `);
    if (!codexEnabled) {
      await clickVisible(
        '[data-testid="session-provenance-hook-switch-codex"]',
        "Codex hook switch for approval flow"
      );
      await waitForSwitchState("codex", true);
    }

    let approvalState = null;
    try {
      await browser.waitUntil(
        async () => {
          try {
            approvalState = await execJS(`
              return [
                document.querySelector('[data-testid="session-provenance-hook-status-codex"]')?.getAttribute('data-activation-state') || '',
                document.querySelector('[data-testid="session-provenance-codex-approval"]')?.textContent || '',
                Boolean(document.querySelector('[data-testid="session-provenance-review-codex-hooks"] button'))
              ];
            `);
          } catch (error) {
            approvalState = ["webdriver-error", String(error), false];
            return false;
          }
          const activationState = String(approvalState?.[0] ?? "").trim();
          const cardText = String(approvalState?.[1] ?? "")
            .trim()
            .replace(/\s+/g, " ");
          return (
            activationState === "awaiting_approval" &&
            cardText.includes("ORG2 hooks") &&
            cardText.includes("Trust all and continue") &&
            approvalState?.[2] === true
          );
        },
        {
          timeout: RENDER_TIMEOUT_MS,
          interval: 250,
          timeoutMsg: "Codex approval state did not render",
        }
      );
    } catch (error) {
      throw new Error(
        `${error.message}: latest=${JSON.stringify(approvalState)}`
      );
    }

    const ptysBeforeApproval = await invokeTauriCommand("list_pty_sessions");
    const ptyIdsBeforeApproval = new Set(
      ptysBeforeApproval.map((session) => session.session_id)
    );
    let approvalPty = null;
    let approvalOutput = "";
    let latestPtySessions = [];
    let skippedCodexUpdatePrompt = false;
    try {
      await clickVisible(
        '[data-testid="session-provenance-review-codex-hooks"] button',
        "Review Codex hooks button"
      );

      // The production button must open a dedicated visible terminal and run
      // Codex far enough to render its native trust prompt. We intentionally do
      // not choose a trust option in automation.
      try {
        await browser.waitUntil(
          async () => {
            latestPtySessions = await invokeTauriCommand("list_pty_sessions");
            approvalPty = latestPtySessions.find(
              (session) =>
                !ptyIdsBeforeApproval.has(session.session_id) &&
                session.name === "Codex hook approval"
            );
            if (!approvalPty) return false;
            const snapshot = await invokeTauriCommand(
              "get_pty_output_snapshot",
              { sessionId: approvalPty.session_id }
            );
            approvalOutput = String(snapshot?.output ?? "");
            if (
              !skippedCodexUpdatePrompt &&
              approvalOutput.includes("Update now") &&
              approvalOutput.includes("Skip")
            ) {
              // A Codex release prompt can precede hook review. Skip only this
              // update choice; the user's hook trust decision remains untouched.
              await invokeTauriCommand("write_pty", {
                sessionId: approvalPty.session_id,
                data: "2",
              });
              skippedCodexUpdatePrompt = true;
              return false;
            }
            return (
              approvalOutput.includes("3 hooks are new or changed") &&
              approvalOutput.includes("Trust") &&
              approvalOutput.includes("continue")
            );
          },
          {
            timeout: RENDER_TIMEOUT_MS,
            interval: 300,
            timeoutMsg: "Codex native hook trust prompt did not appear",
          }
        );
      } catch (error) {
        const terminalUiState = await execJS(`
          return {
            href: window.location.href,
            hasTerminal: Boolean(document.querySelector('.terminal-core')),
            body: (document.body.innerText || '').slice(0, 2000)
          };
        `);
        throw new Error(
          `${error.message}: ptys=${JSON.stringify(latestPtySessions)} selected=${JSON.stringify(approvalPty)} output=${JSON.stringify(approvalOutput.slice(-2000))} ui=${JSON.stringify(terminalUiState)}`
        );
      }

      if (approvalPty.name !== "Codex hook approval") {
        throw new Error(
          `Dedicated approval terminal was not named correctly: ${JSON.stringify(approvalPty)}`
        );
      }

      // Deterministically emulate the first post-approval callback by invoking
      // the real installed hook binary and adapter path. This establishes the
      // activation receipt without automating the user's security decision.
      execFileSync(APP_BINARY, ["--session-provenance-hook", "codex"], {
        input: JSON.stringify({
          session_id: `e2e-codex-trust-${RUN_ID}`,
          turn_id: `turn-${RUN_ID}`,
          cwd: E2E_REPO_PATH,
          hook_event_name: "PostToolUse",
          tool_name: "apply_patch",
          tool_use_id: `tool-${RUN_ID}`,
          tool_input: {
            command:
              "*** Begin Patch\n*** Add File: e2e-trust-proof.txt\n+proof\n*** End Patch",
          },
        }),
        env: process.env,
        stdio: ["pipe", "ignore", "pipe"],
      });
    } finally {
      if (approvalPty?.session_id) {
        await invokeTauriCommand("close_pty", {
          sessionId: approvalPty.session_id,
        });
      }
    }

    let activeState = null;
    await browser.waitUntil(
      async () => {
        activeState = await execJS(`
          return document.querySelector('[data-testid="session-provenance-hook-status-codex"]')?.getAttribute('data-activation-state') ?? '';
        `);
        return activeState === "active";
      },
      {
        timeout: RENDER_TIMEOUT_MS,
        interval: 250,
        timeoutMsg: `Codex did not render active after a real hook callback: ${JSON.stringify(activeState)}`,
      }
    );

    if (!originalCodexState) {
      await clickVisible(
        '[data-testid="session-provenance-hook-switch-codex"]',
        "Codex hook switch final restore"
      );
      await waitForSwitchState("codex", false);
    }
  });

  it("persists and renders builtin SDE launch modes", async function () {
    if (!shouldRunScenario("builtin-modes")) {
      this.skip();
      return;
    }

    for (const mode of ["build", "plan", "ask"]) {
      const { sessionId } = await launchAndAssert({
        label: `builtin-sde-${mode}`,
        account,
        model,
        mode,
        agentDefinitionId: BUILTIN_SDE_AGENT_ID,
        expectedAgentDefinitionId: BUILTIN_SDE_AGENT_ID,
      });
      await assertModeToolInventory(mode, sessionId);
    }
  });

  it("launches OS Agent Ask mode safely with zero repos selected", async function () {
    if (!shouldRunScenario("zero-repo-os-ask")) {
      this.skip();
      return;
    }

    try {
      unwrap(await invokeE2E("clearWorkspaceRepos"), "clear workspace repos");
      const result = unwrap(
        await invokeE2E("launchSession", {
          category: "rust_agent",
          content: `E2E zero repo OS Ask launch ${RUN_ID}. Reply briefly.`,
          keySource: "own_key",
          accountId: account.id,
          model,
          agentDefinitionId: BUILTIN_OS_AGENT_ID,
          mode: "ask",
          background: false,
        }),
        "launchSession(zero-repo-os-ask)"
      ).result;
      const sessionId = result?.sessionId ?? result?.session_id;
      if (!sessionId) {
        throw new Error(
          `Zero repo OS Ask launch did not create a session: ${JSON.stringify(result)}`
        );
      }

      await waitForSessionAggregateRow(
        sessionId,
        (session) =>
          session.model === model &&
          session.accountId === account.id &&
          session.agentDefinitionId === BUILTIN_OS_AGENT_ID &&
          session.agentExecMode === "ask" &&
          (session.workspacePath == null || session.workspacePath === ""),
        "zero repo OS Ask launch metadata"
      );
      await assertModeToolInventory("ask", sessionId);
      await assertPersistedSessionWorkspace(sessionId, { workspaceRoot: null });
    } finally {
      await invokeE2E("ensureRepoSelected", { repoPath: E2E_REPO_PATH });
    }
  });

  it("blocks SDE Agent launch from rendered creator when zero repos are selected", async function () {
    if (!shouldRunScenario("zero-repo-sde-guard")) {
      this.skip();
      return;
    }

    try {
      await prepareRenderedCreator({
        account,
        model,
        agentDefinitionId: BUILTIN_SDE_AGENT_ID,
      });
      unwrap(await invokeE2E("clearWorkspaceRepos"), "clear workspace repos");
      await selectRenderedAgentDefinition(BUILTIN_SDE_AGENT_ID);
      await selectRenderedExecMode("ask");

      const selection = unwrap(
        await invokeE2E("inspectCreatorSelection"),
        "inspectCreatorSelection(zero-repo-sde-guard)"
      ).creator;
      if (selection.source != null) {
        throw new Error(
          `SDE zero-repo guard expected no creator source, got ${JSON.stringify(selection)}`
        );
      }

      await typeRenderedCreatorPrompt(
        `E2E SDE zero repo guard ${RUN_ID}. This should not launch.`,
        "zero repo SDE guard"
      );
      await assertRenderedCreatorSendDisabled("zero repo SDE guard");
    } finally {
      await invokeE2E("ensureRepoSelected", { repoPath: E2E_REPO_PATH });
    }
  });

  it("passes multi-root workspace folders as additional session directories", async function () {
    if (!shouldRunScenario("multi-root-workspace")) {
      this.skip();
      return;
    }

    const primaryPath = createTempWorkspaceDir("multi-primary");
    const secondaryPath = createTempWorkspaceDir("multi-secondary");
    const tertiaryPath = createTempWorkspaceDir("multi-tertiary");
    try {
      const seeded = unwrap(
        await invokeE2E("seedMultiRootWorkspace", {
          workspaceId: `e2e-multi-root-${RUN_ID}`,
          workspaceName: `E2E Multi Root ${RUN_ID}`,
          folders: [
            {
              id: "primary",
              name: "primary",
              path: primaryPath,
              isPrimary: true,
            },
            { id: "secondary", name: "secondary", path: secondaryPath },
            { id: "tertiary", name: "tertiary", path: tertiaryPath },
          ],
        }),
        "seed multi-root workspace"
      );

      const result = unwrap(
        await invokeE2E("launchSession", {
          category: "rust_agent",
          content: `E2E multi-root launch ${RUN_ID}. Reply briefly.`,
          keySource: "own_key",
          accountId: account.id,
          model,
          agentDefinitionId: BUILTIN_SDE_AGENT_ID,
          mode: "ask",
          background: false,
        }),
        "launchSession(multi-root-workspace)"
      ).result;
      const sessionId = result?.sessionId ?? result?.session_id;
      if (!sessionId) {
        throw new Error(
          `Multi-root launch did not create a session: ${JSON.stringify(result)}`
        );
      }

      await waitForSessionAggregateRow(
        sessionId,
        (session) => session.workspacePath === seeded.primaryPath,
        "multi-root launch workspace metadata"
      );
      await assertPersistedSessionWorkspace(sessionId, {
        workspaceRoot: seeded.primaryPath,
        additionalDirectories: seeded.additionalDirectories,
      });
    } finally {
      await invokeE2E("ensureRepoSelected", { repoPath: E2E_REPO_PATH });
      fs.rmSync(primaryPath, { recursive: true, force: true });
      fs.rmSync(secondaryPath, { recursive: true, force: true });
      fs.rmSync(tertiaryPath, { recursive: true, force: true });
    }
  });

  it("keeps multi-root launch root on primary folder when active folder moves", async function () {
    if (!shouldRunScenario("multi-root-active-folder-primary-launch")) {
      this.skip();
      return;
    }

    const primaryPath = createTempWorkspaceDir("multi-active-primary");
    const secondaryPath = createTempWorkspaceDir("multi-active-secondary");
    const tertiaryPath = createTempWorkspaceDir("multi-active-tertiary");
    try {
      const seeded = unwrap(
        await invokeE2E("seedMultiRootWorkspace", {
          workspaceId: `e2e-multi-root-active-${RUN_ID}`,
          workspaceName: `E2E Multi Root Active ${RUN_ID}`,
          folders: [
            {
              id: "primary-active",
              name: "primary-active",
              path: primaryPath,
              isPrimary: true,
            },
            {
              id: "secondary-active",
              name: "secondary-active",
              path: secondaryPath,
            },
            {
              id: "tertiary-active",
              name: "tertiary-active",
              path: tertiaryPath,
            },
          ],
        }),
        "seed active-folder multi-root workspace"
      );
      const activeSnapshot = unwrap(
        await invokeE2E("setActiveWorkspaceFolderForTest", secondaryPath),
        "set active workspace folder to secondary"
      );
      if (
        activeSnapshot.primaryFolder?.path !== primaryPath ||
        activeSnapshot.activeFolder?.path !== secondaryPath ||
        activeSnapshot.repoPath !== primaryPath
      ) {
        throw new Error(
          `Active folder setup changed durable repo state unexpectedly: ${JSON.stringify(activeSnapshot)}`
        );
      }

      const result = unwrap(
        await invokeE2E("launchSession", {
          category: "rust_agent",
          content: `E2E multi-root active folder launch ${RUN_ID}. Reply briefly.`,
          keySource: "own_key",
          accountId: account.id,
          model,
          agentDefinitionId: BUILTIN_SDE_AGENT_ID,
          mode: "ask",
          background: false,
        }),
        "launchSession(multi-root-active-folder-primary-launch)"
      ).result;
      const sessionId = result?.sessionId ?? result?.session_id;
      if (!sessionId) {
        throw new Error(
          `Active-folder multi-root launch did not create a session: ${JSON.stringify(result)}`
        );
      }

      await waitForSessionAggregateRow(
        sessionId,
        (session) =>
          session.model === model &&
          session.accountId === account.id &&
          session.agentDefinitionId === BUILTIN_SDE_AGENT_ID &&
          session.agentExecMode === "ask" &&
          session.workspacePath === primaryPath,
        "active-folder multi-root launch metadata"
      );
      await assertPersistedSessionWorkspace(sessionId, {
        workspaceRoot: primaryPath,
        additionalDirectories: seeded.additionalDirectories,
      });
    } finally {
      await invokeE2E("ensureRepoSelected", { repoPath: E2E_REPO_PATH });
      fs.rmSync(primaryPath, { recursive: true, force: true });
      fs.rmSync(secondaryPath, { recursive: true, force: true });
      fs.rmSync(tertiaryPath, { recursive: true, force: true });
    }
  });

  it("renders multi-root Session Creator @ search with persistent source badges and unambiguous file pills", async function () {
    if (!shouldRunScenario("multi-root-at-search")) {
      this.skip();
      return;
    }

    const primaryPath = createTempWorkspaceDir("multi-at-primary");
    const secondaryPath = createTempWorkspaceDir("multi-at-secondary");
    const primaryName = "E2EPrimaryRepo";
    const secondaryName = "E2ESecondaryRepo";
    try {
      initTempGitRepo(primaryPath, primaryName);
      initTempGitRepo(secondaryPath, secondaryName);
      for (const repoPath of [primaryPath, secondaryPath]) {
        fs.mkdirSync(path.join(repoPath, "src"), { recursive: true });
        fs.writeFileSync(
          path.join(repoPath, "src", "index.tsx"),
          `export const source = ${JSON.stringify(path.basename(repoPath))};\n`
        );
      }

      unwrap(
        await invokeE2E("seedMultiRootWorkspace", {
          workspaceId: `e2e-multi-root-at-${RUN_ID}`,
          workspaceName: `E2E Multi Root At ${RUN_ID}`,
          folders: [
            {
              id: "primary-at",
              name: primaryName,
              path: primaryPath,
              isPrimary: true,
            },
            {
              id: "secondary-at",
              name: secondaryName,
              path: secondaryPath,
            },
          ],
        }),
        "seed multi-root @ search workspace"
      );
      await prepareRenderedCreator({
        account,
        model,
        agentDefinitionId: BUILTIN_SDE_AGENT_ID,
        repoPath: null,
      });

      await assertMultiRootAtSearchSources({
        primaryName,
        secondaryName,
        secondaryPath,
      });
    } finally {
      try {
        await invokeE2E("ensureRepoSelected", { repoPath: E2E_REPO_PATH });
      } catch (error) {
        console.warn(
          "multi-root @ search cleanup could not restore repo selection",
          error
        );
      }
      fs.rmSync(primaryPath, { recursive: true, force: true });
      fs.rmSync(secondaryPath, { recursive: true, force: true });
    }
  });

  it("renders Cmd+P file search results from secondary workspace roots", async function () {
    if (!shouldRunScenario("multi-root-cmd-p-search")) {
      this.skip();
      return;
    }

    const primaryPath = createTempWorkspaceDir("multi-cmdp-primary");
    const secondaryPath = createTempWorkspaceDir("multi-cmdp-secondary");
    const primaryName = "E2ECmdPPrimaryRepo";
    const secondaryName = "E2ECmdPSecondaryRepo";
    const secondaryFileName = `secondary-cmdp-target-${RUN_ID}.tsx`;
    const secondaryFilePath = path.join(secondaryPath, "src", secondaryFileName);
    try {
      initTempGitRepo(primaryPath, primaryName);
      initTempGitRepo(secondaryPath, secondaryName);
      fs.mkdirSync(path.join(primaryPath, "src"), { recursive: true });
      fs.mkdirSync(path.join(secondaryPath, "src"), { recursive: true });
      fs.writeFileSync(
        path.join(primaryPath, "src", `primary-cmdp-only-${RUN_ID}.tsx`),
        "export const primaryOnly = true;\n"
      );
      fs.writeFileSync(
        secondaryFilePath,
        "export const secondaryCmdPOnly = true;\n"
      );

      unwrap(
        await invokeE2E("seedMultiRootWorkspace", {
          workspaceId: `e2e-multi-root-cmdp-${RUN_ID}`,
          workspaceName: `E2E Multi Root CmdP ${RUN_ID}`,
          folders: [
            {
              id: "primary-cmdp",
              name: primaryName,
              path: primaryPath,
              isPrimary: true,
            },
            {
              id: "secondary-cmdp",
              name: secondaryName,
              path: secondaryPath,
            },
          ],
        }),
        "seed multi-root Cmd+P workspace"
      );
      unwrap(
        await invokeE2E("navigateTo", "/orgii/workstation/code"),
        "navigate to workstation before multi-root Cmd+P search"
      );
      await assertMultiRootEditorPaletteSearch({
        secondaryName,
        secondaryFilePath,
        query: secondaryFileName.replace(/\.tsx$/, ""),
      });
    } finally {
      try {
        await invokeE2E("ensureRepoSelected", { repoPath: E2E_REPO_PATH });
      } catch (error) {
        console.warn(
          "multi-root Cmd+P cleanup could not restore repo selection",
          error
        );
      }
      fs.rmSync(primaryPath, { recursive: true, force: true });
      fs.rmSync(secondaryPath, { recursive: true, force: true });
    }
  });

  it("renders existing chat composer multi-root @ search with source badges and secondary repo pills", async function () {
    if (!shouldRunScenario("multi-root-existing-chat-at-search")) {
      this.skip();
      return;
    }

    const primaryPath = createTempWorkspaceDir("multi-chat-at-primary");
    const secondaryPath = createTempWorkspaceDir("multi-chat-at-secondary");
    const primaryName = "E2EChatPrimaryRepo";
    const secondaryName = "E2EChatSecondaryRepo";
    try {
      initTempGitRepo(primaryPath, primaryName);
      initTempGitRepo(secondaryPath, secondaryName);
      for (const repoPath of [primaryPath, secondaryPath]) {
        fs.mkdirSync(path.join(repoPath, "src"), { recursive: true });
        fs.writeFileSync(
          path.join(repoPath, "src", "index.tsx"),
          `export const source = ${JSON.stringify(path.basename(repoPath))};\n`
        );
      }

      const seeded = unwrap(
        await invokeE2E("seedMultiRootWorkspace", {
          workspaceId: `e2e-multi-root-chat-at-${RUN_ID}`,
          workspaceName: `E2E Multi Root Chat At ${RUN_ID}`,
          folders: [
            {
              id: "primary-chat-at",
              name: primaryName,
              path: primaryPath,
              isPrimary: true,
            },
            {
              id: "secondary-chat-at",
              name: secondaryName,
              path: secondaryPath,
            },
          ],
        }),
        "seed multi-root existing chat @ search workspace"
      );

      const result = unwrap(
        await invokeE2E("launchSession", {
          category: "rust_agent",
          content: `E2E existing chat multi-root at search launch ${RUN_ID}. Reply briefly.`,
          keySource: "own_key",
          accountId: account.id,
          model,
          agentDefinitionId: BUILTIN_SDE_AGENT_ID,
          mode: "ask",
          background: false,
        }),
        "launchSession(multi-root-existing-chat-at-search)"
      ).result;
      const sessionId = result?.sessionId ?? result?.session_id;
      if (!sessionId) {
        throw new Error(
          `Existing chat multi-root @ search launch did not create a session: ${JSON.stringify(result)}`
        );
      }

      await waitForSessionAggregateRow(
        sessionId,
        (session) =>
          session.model === model &&
          session.accountId === account.id &&
          session.agentDefinitionId === BUILTIN_SDE_AGENT_ID &&
          session.agentExecMode === "ask" &&
          session.workspacePath === seeded.primaryPath,
        "existing chat multi-root @ search launch metadata"
      );
      await assertPersistedSessionWorkspace(sessionId, {
        workspaceRoot: seeded.primaryPath,
        additionalDirectories: seeded.additionalDirectories,
      });
      unwrap(
        await invokeE2E("navigateTo", "/orgii/workstation/code"),
        "navigate to workstation before existing chat multi-root @ search"
      );
      unwrap(await invokeE2E("openSession", sessionId), "open existing chat multi-root @ search session");
      await waitForRenderedSession(sessionId, "existing-chat-multi-root-at-search");

      await assertMultiRootAtSearchSources({
        primaryName,
        secondaryName,
        secondaryPath,
        shellSelector: '[data-testid="chat-panel"]',
        label: "existing chat multi-root @ search",
      });
    } finally {
      try {
        await invokeE2E("ensureRepoSelected", { repoPath: E2E_REPO_PATH });
      } catch (error) {
        console.warn(
          "existing chat multi-root @ search cleanup could not restore repo selection",
          error
        );
      }
      fs.rmSync(primaryPath, { recursive: true, force: true });
      fs.rmSync(secondaryPath, { recursive: true, force: true });
    }
  });

  it("persists and renders custom AgentDefinition target metadata", async function () {
    if (!shouldRunScenario("custom-agent")) {
      this.skip();
      return;
    }

    const agentId = `e2e-launch-wiring-custom-${RUN_ID}`;
    const definition = {
      id: agentId,
      name: `E2E Launch Wiring Agent ${RUN_ID}`,
      description: "Temporary custom Agent for launch wiring E2E coverage.",
      builtIn: false,
      tier: "primary",
      inheritsFrom: BUILTIN_SDE_AGENT_ID,
      capabilities: { coding: { modeSwitch: true } },
      delegationConfig: { delegatable: true, contextBuilders: [] },
      sessionModel: {
        mode: "singleton",
        processingLock: true,
        maxIterations: 3,
      },
      agentPolicy: {
        autonomy: "full",
        workspaceOnly: true,
        blockedCommands: [],
        riskRules: { medium: [], high: [] },
      },
      tools: { userAllowedTools: [], excludedTools: [] },
      skillsConfig: { enabled: true, include: [], exclude: [], sourceDirs: [] },
    };

    try {
      await removeAgentDefIfExists(agentId);
      unwrap(
        await invokeE2E("addAgentDef", definition),
        "add custom launch wiring AgentDefinition"
      );
      unwrap(
        await invokeE2E("refreshAgentDefs"),
        "refresh custom launch wiring AgentDefinition"
      );
      await launchAndAssert({
        label: "custom-agent-debug",
        account,
        model,
        mode: "debug",
        agentDefinitionId: agentId,
        expectedAgentDefinitionId: agentId,
      });
    } finally {
      await invokeE2E("removeAgentDef", agentId);
    }
  });

  it("launches a custom AgentDefinition through the rendered Session Creator selector", async function () {
    if (!shouldRunScenario("custom-agent-rendered-selector")) {
      this.skip();
      return;
    }

    const agentId = `e2e-rendered-selector-custom-${RUN_ID}`;
    const definition = {
      id: agentId,
      name: `E2E Rendered Selector Agent ${RUN_ID}`,
      description:
        "Temporary custom Agent for rendered selector launch coverage.",
      builtIn: false,
      tier: "primary",
      inheritsFrom: BUILTIN_SDE_AGENT_ID,
      capabilities: { coding: { modeSwitch: true } },
      delegationConfig: { delegatable: true, contextBuilders: [] },
      sessionModel: {
        mode: "singleton",
        processingLock: true,
        maxIterations: 3,
      },
      agentPolicy: {
        autonomy: "full",
        workspaceOnly: true,
        blockedCommands: [],
        riskRules: { medium: [], high: [] },
      },
      tools: { userAllowedTools: [], excludedTools: [] },
      skillsConfig: { enabled: true, include: [], exclude: [], sourceDirs: [] },
    };

    try {
      await removeAgentDefIfExists(agentId);
      unwrap(
        await invokeE2E("addAgentDef", definition),
        "add rendered selector AgentDefinition"
      );
      unwrap(
        await invokeE2E("refreshAgentDefs"),
        "refresh rendered selector AgentDefinition"
      );
      await prepareRenderedCreator({
        account,
        model,
        agentDefinitionId: BUILTIN_SDE_AGENT_ID,
      });
      await selectRenderedAgentDefinition(agentId);
      const sessionId = await sendFromRenderedCreator(
        `E2E rendered custom Agent selector launch ${RUN_ID}. Reply briefly.`
      );
      if (!sessionId) {
        throw new Error(
          "Rendered custom Agent selector launch did not create a session id"
        );
      }
      await waitForSessionAggregateRow(
        sessionId,
        (session) =>
          session.model === model &&
          session.accountId === account.id &&
          session.agentDefinitionId === agentId,
        "rendered custom Agent selector launch metadata"
      );
      unwrap(
        await invokeE2E("openSession", sessionId),
        "open rendered selector session"
      );
      await waitForRenderedSession(sessionId, "custom-agent-rendered-selector");
    } finally {
      await invokeE2E("removeAgentDef", agentId);
    }
  });

  it("launches through the rendered execution mode selector", async function () {
    if (!shouldRunScenario("rendered-mode-selector")) {
      this.skip();
      return;
    }

    await prepareRenderedCreator({
      account,
      model,
      agentDefinitionId: BUILTIN_SDE_AGENT_ID,
    });
    await selectRenderedExecMode("ask");
    const sessionId = await sendFromRenderedCreator(
      `E2E rendered execution mode selector launch ${RUN_ID}. Reply briefly.`
    );
    if (!sessionId) {
      throw new Error(
        "Rendered execution mode selector did not create a session id"
      );
    }
    await waitForSessionAggregateRow(
      sessionId,
      (session) =>
        session.model === model &&
        session.accountId === account.id &&
        session.agentDefinitionId === BUILTIN_SDE_AGENT_ID &&
        session.agentExecMode === "ask",
      "rendered execution mode selector launch metadata"
    );
    unwrap(
      await invokeE2E("openSession", sessionId),
      "open rendered mode selector session"
    );
    await waitForRenderedSession(sessionId, "rendered-mode-selector");
  });

  it("launches a default Agent Org through the rendered Session Creator selector", async function () {
    if (!shouldRunScenario("agent-org-rendered-selector")) {
      this.skip();
      return;
    }

    await prepareRenderedCreator({
      account,
      model,
      agentDefinitionId: BUILTIN_SDE_AGENT_ID,
    });
    await selectRenderedDefaultAgentOrg();
    await selectRenderedExecMode("plan");
    const sessionId = await sendFromRenderedCreator(
      `E2E rendered Agent Org selector launch ${RUN_ID}. Reply briefly.`
    );
    if (!sessionId) {
      throw new Error(
        "Rendered Agent Org selector launch did not create a session id"
      );
    }

    const runState = await waitForAgentOrgRunViewByOrg(
      DEFAULT_AGENT_ORG_ID,
      (view, run) =>
        run?.rootSessionId === sessionId &&
        run?.orgId === DEFAULT_AGENT_ORG_ID &&
        Boolean(view?.context?.runId) &&
        view?.context?.runId === run?.runId &&
        (view?.members ?? []).length > 0,
      "rendered default Agent Org selector runtime view"
    );
    unwrap(
      await invokeE2E("openSession", sessionId),
      "open rendered Agent Org selector root session"
    );
    const renderedState = await waitForRenderedSession(
      sessionId,
      "agent-org-rendered-selector"
    );
    if (renderedState.chatState.activeSession?.agentExecMode !== "plan") {
      throw new Error(
        `Rendered Agent Org selector did not persist plan mode: ${JSON.stringify({ runState, renderedState })}`
      );
    }
  });

  it("captures provider payload after durable compacted resume", async function () {
    if (!shouldRunScenario("provider-payload-snapshot")) {
      this.skip();
      return;
    }

    const sessionId = `agent:e2e-provider-payload-${RUN_ID}`;
    const oldMarker = `E2E_PROVIDER_PAYLOAD_OLD_HISTORY_SHOULD_NOT_EXIST_${RUN_ID}`;
    const summary = `E2E_PROVIDER_PAYLOAD_SUMMARY_${RUN_ID}`;
    const recentUser = `E2E provider payload recent user ${RUN_ID}`;
    const recentAssistant = `E2E provider payload recent assistant ${RUN_ID}`;
    const followUp = `E2E provider payload follow-up ${RUN_ID}`;
    const fakeModel = `e2e-fake-provider-payload-${RUN_ID}`;

    await postJsonAny("/agent/test/sde", {
      content: "E2E provider payload warmup",
      session_id: sessionId,
      model: fakeModel,
      workspace_path: E2E_REPO_PATH,
      agent_definition_id: BUILTIN_SDE_AGENT_ID,
      mode: "ask",
      no_cleanup: false,
      restrict_tools: [],
      max_retries: 0,
    });

    await postJson("/agent/test/session/seed-compacted-history", {
      session_id: sessionId,
      old_marker: oldMarker,
      summary,
      recent_user: recentUser,
      recent_assistant: recentAssistant,
    });
    await postJson("/agent/test/session/provider-request-capture", {
      action: "arm",
      clear: true,
    });
    const resume = await postJsonAny(
      "/agent/test/sde",
      {
        content: `${followUp} final-capture`,
        session_id: sessionId,
        model: fakeModel,
        workspace_path: E2E_REPO_PATH,
        agent_definition_id: BUILTIN_SDE_AGENT_ID,
        mode: "ask",
        no_cleanup: false,
        is_resume: true,
        restrict_tools: [],
        max_retries: 0,
      },
      30_000
    );
    if (!String(resume.content ?? "").includes("E2E_FAKE_PROVIDER_REPLY")) {
      throw new Error(
        `Fake provider did not complete resume turn: ${JSON.stringify(resume)}`
      );
    }
    const captureResult = await postJson(
      "/agent/test/session/provider-request-capture",
      {
        action: "drain",
        clear: true,
        disarm: true,
      }
    );
    const captures = captureResult.captures ?? [];
    const capture = [...captures]
      .reverse()
      .find((item) => item.sessionId === sessionId);
    if (!capture) {
      throw new Error(
        `No provider request capture for ${sessionId}: ${JSON.stringify(captureResult)}`
      );
    }

    const payloadText = JSON.stringify(capture.messages);
    const roles = capture.messages.map((message) => message.role);
    if (payloadText.includes(oldMarker)) {
      throw new Error(
        `Provider payload leaked old full history: ${payloadText}`
      );
    }
    if (!payloadText.includes(summary)) {
      throw new Error(
        `Provider payload missing compact summary ${summary}: ${payloadText}`
      );
    }
    if (!payloadText.includes(`${followUp} final-capture`)) {
      throw new Error(`Provider payload missing follow-up: ${payloadText}`);
    }
    if (!roles.includes("system") || !roles.includes("user")) {
      throw new Error(
        `Provider payload missing required roles: ${JSON.stringify({ roles, capture })}`
      );
    }
    const summaryIndex = capture.messages.findIndex((message) =>
      JSON.stringify(message).includes(summary)
    );
    const followUpIndex = capture.messages.findIndex((message) =>
      JSON.stringify(message).includes(`${followUp} final-capture`)
    );
    if (
      summaryIndex < 0 ||
      followUpIndex < 0 ||
      summaryIndex >= followUpIndex
    ) {
      throw new Error(
        `Provider payload order wrong: ${JSON.stringify({ summaryIndex, followUpIndex, messages: capture.messages })}`
      );
    }
  });

  it("auto-compacts tiny fake-provider context without seeded compact transcript", async function () {
    if (!shouldRunScenario("fake-provider-auto-compact")) {
      this.skip();
      return;
    }

    const sessionId = `agent:e2e-auto-compact-${RUN_ID}`;
    const rawMarker = `E2E_AUTO_COMPACT_RAW_HISTORY_${RUN_ID}`;
    const followUp = `E2E auto compact follow-up ${RUN_ID}`;
    const fakeModel = `e2e-fake-provider-auto-compact-${RUN_ID}`;
    const compaction = {
      enabled: true,
      triggerRatio: 0.2,
      keepRatio: 0.25,
      summaryMaxTokens: 256,
      minMessages: 4,
      floorTokens: 32,
      reservedSummaryTokens: 64,
      bufferTokens: 64,
    };

    await postJsonAny("/agent/test/sde", {
      content: "E2E auto compact warmup",
      session_id: sessionId,
      model: fakeModel,
      workspace_path: E2E_REPO_PATH,
      agent_definition_id: BUILTIN_SDE_AGENT_ID,
      mode: "ask",
      no_cleanup: true,
      restrict_tools: [],
      max_retries: 0,
      context_window: 1400,
      compaction,
    });

    const beforeSeed = await postJson("/agent/test/session/llm-history", {
      session_id: sessionId,
    });
    if (beforeSeed.compactBoundaryCount !== 0) {
      throw new Error(
        `Warmup unexpectedly compacted before raw seed: ${JSON.stringify(beforeSeed)}`
      );
    }

    await postJson("/agent/test/session/seed-raw-history", {
      session_id: sessionId,
      marker: rawMarker,
      message_count: 12,
      marker_message_count: 6,
      chars_per_message: 900,
    });
    const seeded = await postJson("/agent/test/session/llm-history", {
      session_id: sessionId,
    });
    if (
      seeded.compactBoundaryCount !== 0 ||
      !JSON.stringify(seeded).includes(rawMarker)
    ) {
      throw new Error(
        `Raw seed must not pre-compact transcript: ${JSON.stringify(seeded).slice(0, 4000)}`
      );
    }

    await postJson("/agent/test/session/provider-request-capture", {
      action: "arm",
      clear: true,
    });
    const response = await postJsonAny(
      "/agent/test/sde",
      {
        content: followUp,
        session_id: sessionId,
        model: fakeModel,
        workspace_path: E2E_REPO_PATH,
        agent_definition_id: BUILTIN_SDE_AGENT_ID,
        mode: "ask",
        no_cleanup: false,
        is_resume: true,
        restrict_tools: [],
        max_retries: 0,
        context_window: 1400,
        compaction,
      },
      30_000
    );
    if (!String(response.content ?? "").includes("E2E_FAKE_PROVIDER_REPLY")) {
      throw new Error(
        `Fake provider did not complete auto-compact turn: ${JSON.stringify(response)}`
      );
    }

    const captureResult = await postJson(
      "/agent/test/session/provider-request-capture",
      {
        action: "drain",
        clear: true,
        disarm: true,
      }
    );
    const capture = [...(captureResult.captures ?? [])]
      .reverse()
      .find((item) => item.sessionId === sessionId);
    if (!capture) {
      throw new Error(
        `No auto-compact provider request capture: ${JSON.stringify(captureResult)}`
      );
    }
    const payloadText = JSON.stringify(capture.messages);
    if (!payloadText.includes("E2E_FAKE_COMPACT_SUMMARY")) {
      throw new Error(
        `Provider payload missing fake compact summary: ${payloadText}`
      );
    }
    if (!payloadText.includes(followUp)) {
      throw new Error(
        `Provider payload missing auto-compact follow-up: ${payloadText}`
      );
    }
    if (payloadText.includes(rawMarker)) {
      throw new Error(
        `Provider payload leaked raw pre-compact history: ${payloadText}`
      );
    }

    const persisted = await postJson("/agent/test/session/llm-history", {
      session_id: sessionId,
    });
    const persistedText = JSON.stringify(persisted);
    if (persisted.compactBoundaryCount < 1) {
      throw new Error(
        `Auto-compact did not persist compact boundary: ${persistedText}`
      );
    }
    if (!persistedText.includes("E2E_FAKE_COMPACT_SUMMARY")) {
      throw new Error(
        `Persisted auto-compact summary missing: ${persistedText}`
      );
    }
    if (persistedText.includes(rawMarker)) {
      throw new Error(
        `Persisted auto-compact history leaked raw marker: ${persistedText}`
      );
    }
  });

  it("reopens and resumes multiple Rust Agent sessions after simulated restart", async function () {
    if (!shouldRunScenario("rust-restart-multi-resume")) {
      this.skip();
      return;
    }

    const sessionIds = [];
    for (let index = 0; index < 3; index += 1) {
      const result = unwrap(
        await invokeE2E("launchSession", {
          category: "rust_agent",
          content: "",
          workspacePath: E2E_REPO_PATH,
          keySource: "own_key",
          accountId: account.id,
          model,
          agentDefinitionId: BUILTIN_SDE_AGENT_ID,
          mode: "ask",
          background: false,
        }),
        `launchSession(rust-restart-multi-resume-${index})`
      ).result;
      const sessionId = result?.sessionId ?? result?.session_id;
      if (!sessionId) {
        throw new Error(
          `Rust restart multi resume launch ${index} did not create a session: ${JSON.stringify(result)}`
        );
      }
      sessionIds.push(sessionId);
      await postJson("/agent/test/session/seed-compacted-history", {
        session_id: sessionId,
        old_marker: `E2E_OLD_FULL_HISTORY_SHOULD_NOT_REAPPEAR_${RUN_ID}_${index}`,
        summary: `E2E durable compact summary ${RUN_ID} session ${index}`,
        recent_user: `E2E compact recent user ${RUN_ID} session ${index}`,
        recent_assistant: `E2E compact recent assistant ${RUN_ID} session ${index}`,
      });
      const seededHistory = await postJson("/agent/test/session/llm-history", {
        session_id: sessionId,
      });
      if (seededHistory.compactBoundaryCount !== 1) {
        throw new Error(
          `Seeded compact history did not contain exactly one compact boundary for ${sessionId}: ${JSON.stringify(seededHistory)}`
        );
      }
      if (
        JSON.stringify(seededHistory).includes(
          "E2E_OLD_FULL_HISTORY_SHOULD_NOT_REAPPEAR"
        )
      ) {
        throw new Error(
          `Seeded compact history still contains old full history for ${sessionId}: ${JSON.stringify(seededHistory)}`
        );
      }
      await waitForSessionAggregateRow(
        sessionId,
        (session) =>
          session.category === "rust_agent" &&
          session.agentDefinitionId === BUILTIN_SDE_AGENT_ID &&
          session.agentExecMode === "ask",
        `rust restart multi resume ${index} aggregate row`
      );
    }

    for (const sessionId of sessionIds) {
      await postJson("/agent/test/session/update-status-via-cmd", {
        session_id: sessionId,
        status: "running",
      });
    }

    const restartResult = unwrap(
      await invokeE2E("agentOrgSimulateAppRestart"),
      "agentOrgSimulateAppRestart(rust multi resume)"
    );
    if (
      (restartResult.sessionsAbandoned ??
        restartResult.sessions_abandoned ??
        0) < sessionIds.length
    ) {
      throw new Error(
        `Simulated restart did not abandon all forced-running Rust sessions: ${JSON.stringify({ restartResult, sessionIds })}`
      );
    }

    for (const sessionId of sessionIds) {
      await postJson("/agent/test/session/update-status-via-cmd", {
        session_id: sessionId,
        status: "idle",
      });
    }

    const aggregateStartedAt = Date.now();
    await postJson(
      "/agent/test/session/aggregate-list-via-cmd",
      { category: "agent", limit: 20, sortBy: "updated_at", sortOrder: "desc" },
      10_000
    );
    console.log(
      `[rust-restart-resume] aggregate-list-after-restart-ms=${Date.now() - aggregateStartedAt}`
    );

    for (const [index, sessionId] of sessionIds.entries()) {
      unwrap(
        await invokeE2E("navigateTo", "/orgii/workstation/code"),
        `navigateTo workstation code before resume ${index}`
      );
      unwrap(
        await invokeE2E("openSession", sessionId),
        `openSession(rust restart multi resume ${index})`
      );
      await waitForRenderedSession(
        sessionId,
        `rust-restart-multi-resume-${index}`
      );
      const baselineState = unwrap(
        await invokeE2E("inspectChatState"),
        `inspectChatState(rust restart multi resume baseline ${index})`
      );
      const baselineEventIds = new Set(
        (baselineState.rawEvents ?? []).map((event) => event.id)
      );
      const inputReady = await execJS(`
        const input = document.querySelector('[data-testid="chat-input"] [contenteditable="true"]');
        return Boolean(input);
      `);
      if (!inputReady) {
        const pageState = await execJS(`
          return {
            url: location.href,
            bodyText: (document.body.innerText || '').slice(0, 2000),
            hasChatPanel: Boolean(document.querySelector('[data-testid="chat-panel"]')),
            hasMessageList: Boolean(document.querySelector('[data-testid="chat-message-list"]')),
            hasChatInputShell: Boolean(document.querySelector('[data-testid="chat-input"]')),
          };
        `);
        throw new Error(
          `Rust restart resume opened ${sessionId} without composer: page=${JSON.stringify(pageState)} chat=${JSON.stringify(baselineState)}`
        );
      }
      const followUp = `E2E rust restart multi resume follow-up ${RUN_ID} session ${index}`;
      const sendStartedAt = Date.now();
      await sendRenderedChatPrompt(followUp);
      let latestState = null;
      await browser.waitUntil(
        async () => {
          latestState = unwrap(
            await invokeE2E("inspectChatState"),
            `inspectChatState(rust restart multi resume visible ${index})`
          );
          const text = JSON.stringify(latestState);
          return (
            latestState.activeSessionId === sessionId && text.includes(followUp)
          );
        },
        {
          timeout: RENDER_TIMEOUT_MS,
          interval: 500,
          timeoutMsg: `Rust restart follow-up did not stay visible for ${sessionId}`,
        }
      );
      console.log(
        `[rust-restart-resume] session=${sessionId} user-visible-ms=${Date.now() - sendStartedAt}`
      );

      const resumeHistory = await postJson("/agent/test/session/llm-history", {
        session_id: sessionId,
      });
      const resumeHistoryText = JSON.stringify(resumeHistory);
      if (resumeHistory.compactBoundaryCount !== 1) {
        throw new Error(
          `Resume LLM history should retain one durable compact boundary for ${sessionId}: ${resumeHistoryText}`
        );
      }
      if (
        resumeHistoryText.includes("E2E_OLD_FULL_HISTORY_SHOULD_NOT_REAPPEAR")
      ) {
        throw new Error(
          `Resume LLM history regressed to old full history for ${sessionId}: ${resumeHistoryText}`
        );
      }
      if (!resumeHistoryText.includes(followUp)) {
        throw new Error(
          `Resume LLM history did not include follow-up user message for ${sessionId}: ${resumeHistoryText}`
        );
      }

      let firstAgentActivityMs = null;
      await browser.waitUntil(
        async () => {
          latestState = unwrap(
            await invokeE2E("inspectChatState"),
            `inspectChatState(rust restart multi resume agent activity ${index})`
          );
          if ((latestState.streamingDelta?.length ?? 0) > 0) {
            firstAgentActivityMs = Date.now() - sendStartedAt;
            return true;
          }
          const newAgentEvent = (latestState.rawEvents ?? []).find(
            (event) =>
              !baselineEventIds.has(event.id) &&
              event.source !== "user" &&
              (event.displayText || event.actionType || event.uiCanonical)
          );
          if (newAgentEvent) {
            firstAgentActivityMs = Date.now() - sendStartedAt;
            return true;
          }
          return false;
        },
        {
          timeout: 30_000,
          interval: 1_000,
          timeoutMsg: `Rust restart follow-up produced no agent activity within 30s for ${sessionId}: latest=${JSON.stringify(latestState)}`,
        }
      );
      console.log(
        `[rust-restart-resume] session=${sessionId} first-agent-activity-ms=${firstAgentActivityMs}`
      );
    }
  });

  it("persists and renders Agent Org target metadata", async function () {
    if (!shouldRunScenario("agent-org")) {
      this.skip();
      return;
    }

    const result = unwrap(
      await invokeE2E("launchSession", {
        category: "rust_agent",
        content: `E2E launch wiring default Agent Org ${RUN_ID}. Reply briefly.`,
        workspacePath: E2E_REPO_PATH,
        keySource: "own_key",
        accountId: account.id,
        model,
        agentDefinitionId: BUILTIN_SDE_AGENT_ID,
        agentOrgId: DEFAULT_AGENT_ORG_ID,
        mode: "plan",
        background: false,
      }),
      "launchSession(default-agent-org-plan)"
    ).result;
    const rootSessionId = result?.sessionId ?? result?.session_id;
    const runId = result?.agentOrgRunId ?? result?.agent_org_run_id;
    if (!rootSessionId || !runId) {
      throw new Error(
        `Agent Org launch did not return root session/run ids: ${JSON.stringify(result)}`
      );
    }

    const runState = await waitForAgentOrgRunViewByOrg(
      DEFAULT_AGENT_ORG_ID,
      (view, run) =>
        run?.runId === runId &&
        run?.orgId === DEFAULT_AGENT_ORG_ID &&
        view?.context?.runId === runId &&
        (view?.members ?? []).length > 0,
      "default Agent Org launch wiring runtime view"
    );
    unwrap(
      await invokeE2E("openSession", rootSessionId),
      "openSession(default Agent Org root)"
    );
    await waitForRenderedSession(rootSessionId, "default-agent-org-plan");
    if (runState.run?.rootSessionId !== rootSessionId) {
      throw new Error(
        `Agent Org run root session mismatch: ${JSON.stringify({ result, runState })}`
      );
    }
  });
});

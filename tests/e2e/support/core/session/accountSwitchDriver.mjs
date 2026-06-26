import { providerBlockedText } from "./e2eBrowserHelpers.mjs";

/**
 * Live Claude Code multi-account proof.
 *
 * This spec uses existing KeyVault accounts and the rendered chat UI. Debug
 * helpers may seed the initial session, but account switching itself must happen
 * through the in-session model/source picker because that is the user path.
 */
export const CLAUDE_CODE_AGENT_TYPE = "claude_code";
export const CODEX_AGENT_TYPE = "codex";
export const CURSOR_AGENT_TYPE = "cursor_cli";
export const GEMINI_AGENT_TYPE = "gemini_cli";
const INITIAL_ACCOUNT_NAME = process.env.E2E_CLAUDE_CODE_INITIAL_ACCOUNT;
const FOLLOWUP_ACCOUNT_NAME = process.env.E2E_CLAUDE_CODE_FOLLOWUP_ACCOUNT;
export const CODEX_INITIAL_ACCOUNT_NAME = process.env.E2E_CODEX_INITIAL_ACCOUNT;
export const CODEX_FOLLOWUP_ACCOUNT_NAME = process.env.E2E_CODEX_FOLLOWUP_ACCOUNT;
export const CURSOR_INITIAL_ACCOUNT_NAME =
  process.env.E2E_CURSOR_CLI_INITIAL_ACCOUNT ??
  process.env.E2E_CURSOR_ACCOUNT_A;
export const CURSOR_FOLLOWUP_ACCOUNT_NAME =
  process.env.E2E_CURSOR_CLI_FOLLOWUP_ACCOUNT ??
  process.env.E2E_CURSOR_ACCOUNT_B;
const GEMINI_INITIAL_ACCOUNT_NAME =
  process.env.E2E_GEMINI_INITIAL_ACCOUNT ?? process.env.E2E_GEMINI_ACCOUNT;
const GEMINI_FOLLOWUP_ACCOUNT_NAME =
  process.env.E2E_GEMINI_FOLLOWUP_ACCOUNT ??
  process.env.E2E_GEMINI_SECOND_ACCOUNT;
export const MODEL_ID = process.env.E2E_CLAUDE_CODE_MODEL ?? "claude-sonnet-4-6";
export const CODEX_MODEL_ID = process.env.E2E_CODEX_MODEL ?? "gpt-5.5";
export const CURSOR_MODEL_ID = process.env.E2E_CURSOR_CLI_MODEL ?? "composer-2.5-fast";
export const CURSOR_NATIVE_MODEL_ID =
  process.env.E2E_CURSOR_NATIVE_MODEL ?? "composer-2.5-fast";
export const CURSOR_NATIVE_HARNESS_TYPE = "cursor_native";
const CURSOR_NATIVE_INITIAL_ACCOUNT_NAME =
  process.env.E2E_CURSOR_NATIVE_INITIAL_ACCOUNT ?? CURSOR_INITIAL_ACCOUNT_NAME;
const CURSOR_NATIVE_FOLLOWUP_ACCOUNT_NAME =
  process.env.E2E_CURSOR_NATIVE_FOLLOWUP_ACCOUNT ??
  CURSOR_FOLLOWUP_ACCOUNT_NAME;
const DEFAULT_GEMINI_MODEL_CHAIN = [
  process.env.E2E_GEMINI_MODEL,
  "gemini-3.1-flash-lite",
  "gemini-3.1-flash-lite-preview",
  "gemini-3-flash-lite",
  "gemini-3-flash-lite-preview",
  "gemini-3-lite",
  "gemini-3-flash",
  "gemini-3.1-flash-preview",
  "gemini-3.1-flash",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-3.1-pro",
  "gemini-3.1-pro-preview",
  "gemini-3-pro",
  "gemini-2.5-pro",
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite",
  "gemini-2.0-pro",
  "gemini-1.5-flash",
  "gemini-1.5-flash-8b",
  "gemini-1.5-pro",
].filter(Boolean);
export const GEMINI_MODEL_CHAIN = parseE2EChain(
  process.env.E2E_GEMINI_MODEL_CHAIN,
  DEFAULT_GEMINI_MODEL_CHAIN
);
const ACCOUNT_SWITCH_SCENARIOS = parseE2EChain(
  process.env.E2E_ACCOUNT_SWITCH_SCENARIOS,
  []
);
const ACCOUNT_SWITCH_SCENARIO_NAMES = new Set([
  "claude-code-cli",
  "codex-cli",
  "cursor-cli",
  "cursor-rust",
  "claude-code-rust",
  "claude-code-rust-midstream",
  "gemini-rust",
  "gemini-cli",
]);
export const INITIAL_EXPECTED_TEXT = "ORGII_CC_SWITCH_INITIAL_READY";
export const FOLLOWUP_EXPECTED_TEXT = "ORGII_CC_SWITCH_FOLLOWUP_READY";
export const CODEX_INITIAL_EXPECTED_TEXT = "ORGII_CODEX_SWITCH_INITIAL_READY";
export const CODEX_FOLLOWUP_EXPECTED_TEXT = "ORGII_CODEX_SWITCH_FOLLOWUP_READY";
export const GEMINI_INITIAL_EXPECTED_TEXT = "ORGII_GEMINI_SWITCH_INITIAL_READY";
export const GEMINI_FOLLOWUP_EXPECTED_TEXT = "ORGII_GEMINI_SWITCH_FOLLOWUP_READY";
const MOUNT_TIMEOUT_MS = 60_000;
const ENDPOINT_TIMEOUT_MS = Number.parseInt(
  process.env.E2E_CLAUDE_SWITCH_TIMEOUT_MS ?? "120000",
  10
);
const SCENARIO_TIMEOUT_MS = Number.parseInt(
  process.env.E2E_ACCOUNT_SWITCH_SCENARIO_TIMEOUT_MS ?? "180000",
  10
);
const E2E_REPO_PATH = process.env.E2E_REPO_PATH;

const js = {
  exists: (selector) =>
    `return !!document.querySelector(${JSON.stringify(selector)});`,
  click: (selector) => `
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return "missing";
    element.scrollIntoView({ block: "center", inline: "center" });
    element.click();
    return "clicked";
  `,
  clickLastVisible: (selector) => `
    const visibleInputs = Array.from(document.querySelectorAll('[data-testid="chat-input"]')).filter((inputShell) => {
      const rect = inputShell.getBoundingClientRect();
      const style = window.getComputedStyle(inputShell);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    });
    const inputShell = visibleInputs[visibleInputs.length - 1] ?? null;
    const scopedElements = inputShell
      ? Array.from(inputShell.querySelectorAll(${JSON.stringify(selector)}))
      : [];
    const elements = scopedElements.length > 0
      ? scopedElements
      : Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
    const visible = elements.filter((element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    });
    const element = visible[visible.length - 1];
    if (!element) return { status: "missing", count: elements.length, visibleCount: visible.length };
    element.scrollIntoView({ block: "center", inline: "center" });
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
    element.click();
      return {
        status: "clicked",
        count: elements.length,
        visibleCount: visible.length,
        text: element.textContent || "",
        testId: element.getAttribute("data-testid"),
        disabled: element.disabled === true,
        ariaLabel: element.getAttribute("aria-label"),
      };
  `,
  type: (selector, text) => `
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return "missing";
    element.focus();
    document.execCommand("selectAll", false, null);
    const ok = document.execCommand("insertText", false, ${JSON.stringify(text)});
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ${JSON.stringify(text)} }));
    return ok ? (element.textContent || "") : "insert-failed";
  `,
  sendState: `
    const button = document.querySelector('[data-testid="chat-send-button"]');
    const editor = document.querySelector('[data-testid="chat-input"] [contenteditable="true"]');
    if (!button) return null;
    return {
      state: button.getAttribute("data-state"),
      disabled: button.disabled,
      editorText: editor ? editor.textContent || "" : null,
    };
  `,
  mode: `
    return (() => {
      if (document.querySelector('[data-testid="chat-message-list"]')) return "chat";
      if (document.querySelector('[data-testid="chat-input"]')) return "creator";
      return "unknown";
    })();
  `,
  pageDump: `
    return {
      pathname: window.location.pathname,
      mode: (() => {
        if (document.querySelector('[data-testid="chat-message-list"]')) return "chat";
        if (document.querySelector('[data-testid="chat-input"]')) return "creator";
        return "unknown";
      })(),
      modelPillText: document.querySelector('[data-testid="chat-model-pill-model"]')?.textContent || null,
      sourceOptions: Array.from(document.querySelectorAll('[data-testid="unified-model-source-option"]')).map((node) => ({
        text: node.textContent || "",
        accountId: node.getAttribute('data-source-account-id'),
        modelType: node.getAttribute('data-source-model-type'),
      })),
      modelOptions: Array.from(document.querySelectorAll('[data-spotlight-model-id]')).map((node) => ({
        text: node.textContent || "",
        modelId: node.getAttribute('data-spotlight-model-id'),
        groupModelIds: node.getAttribute('data-spotlight-group-model-ids'),
      })),
      spotlightContainers: Array.from(document.querySelectorAll('[data-spotlight-container]')).map((node) => ({
        text: node.textContent || "",
        rect: (() => {
          const rect = node.getBoundingClientRect();
          return { width: rect.width, height: rect.height, top: rect.top, left: rect.left };
        })(),
      })),
      sendState: (() => {
        const button = document.querySelector('[data-testid="chat-send-button"]');
        return button ? { state: button.getAttribute("data-state"), disabled: button.disabled } : null;
      })(),
      bodyText: document.body.innerText.slice(0, 2500),
    };
  `,
};

async function execJS(script) {
  return browser.executeScript(script, []);
}

async function safeExecJS(script) {
  try {
    return await execJS(script);
  } catch {
    return false;
  }
}

function normalizeTranscriptText(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function duplicateTranscriptEntries(entries) {
  const seen = new Map();
  const duplicates = [];
  for (const entry of entries) {
    const text = normalizeTranscriptText(entry.text);
    if (text.length < 12) continue;
    const key = `${entry.source}:${text}`;
    const existing = seen.get(key);
    if (existing) duplicates.push({ first: existing, second: entry, text });
    else seen.set(key, entry);
  }
  return duplicates;
}

async function assertNoDuplicateTranscriptMessages(label) {
  const state = unwrap(
    await invokeE2E("inspectChatState"),
    `${label}-inspectChatState`
  );
  const eventEntries = (state.chatEvents ?? [])
    .filter(
      (event) =>
        (event.source === "user" || event.source === "assistant") &&
        event.displayVariant === "message"
    )
    .map((event) => ({
      id: event.id,
      source: event.source,
      text: event.displayText,
      surface: "event-store",
    }));
  const eventDuplicates = duplicateTranscriptEntries(eventEntries);
  if (eventDuplicates.length > 0) {
    throw new Error(
      `${label} duplicate EventStore transcript messages; duplicates=${JSON.stringify(eventDuplicates.slice(0, 3))}`
    );
  }

  const renderedEntries = await execJS(`
    const isVisible = (node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const entries = [];
    document.querySelectorAll('[data-testid="chat-message-user-editable"]').forEach((node, index) => {
      if (isVisible(node)) entries.push({ source: 'user', id: String(index), text: node.textContent || '', surface: 'rendered' });
    });
    document.querySelectorAll('[data-testid="chat-message-assistant"]').forEach((node, index) => {
      if (isVisible(node)) entries.push({ source: 'assistant', id: String(index), text: node.textContent || '', surface: 'rendered' });
    });
    return entries;
  `);
  const renderedDuplicates = duplicateTranscriptEntries(renderedEntries);
  if (renderedDuplicates.length > 0) {
    throw new Error(
      `${label} duplicate rendered transcript messages; duplicates=${JSON.stringify(renderedDuplicates.slice(0, 3))} entries=${JSON.stringify(renderedEntries.map((entry) => ({ ...entry, text: String(entry.text ?? "").slice(0, 160) })))}`
    );
  }
}

async function waitForFrontendReady() {
  const port = process.env.E2E_FRONTEND_PORT ?? "1998";
  const url = `http://127.0.0.1:${port}`;
  await browser.waitUntil(
    async () => {
      try {
        const response = await fetch(url, { method: "GET" });
        return response.ok;
      } catch {
        return false;
      }
    },
    {
      timeout: MOUNT_TIMEOUT_MS,
      timeoutMsg: `frontend dev server never became ready at ${url}`,
    }
  );
}

async function clickLastVisibleNative(selector) {
  const targetId = `e2e-click-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const prepared = await execJS(`
    document.querySelectorAll('[data-e2e-native-click-target]').forEach((node) => {
      node.removeAttribute('data-e2e-native-click-target');
    });
    const visibleInputs = Array.from(document.querySelectorAll('[data-testid="chat-input"]')).filter((inputShell) => {
      const rect = inputShell.getBoundingClientRect();
      const style = window.getComputedStyle(inputShell);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    });
    const inputShell = visibleInputs[visibleInputs.length - 1] ?? null;
    const scopedElements = inputShell
      ? Array.from(inputShell.querySelectorAll(${JSON.stringify(selector)}))
      : [];
    const elements = scopedElements.length > 0
      ? scopedElements
      : Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
    const visible = elements.filter((element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    });
    const element = visible[visible.length - 1];
    if (!element) return { status: "missing", count: elements.length, visibleCount: visible.length };
    element.setAttribute('data-e2e-native-click-target', ${JSON.stringify(targetId)});
    return {
      status: "prepared",
      count: elements.length,
      visibleCount: visible.length,
      text: element.textContent || "",
      testId: element.getAttribute("data-testid"),
      disabled: element.disabled === true,
      ariaLabel: element.getAttribute("aria-label"),
      groupModelIds: element.getAttribute("data-spotlight-group-model-ids"),
      modelId: element.getAttribute("data-spotlight-model-id"),
    };
  `);
  if (prepared?.status !== "prepared") return prepared;
  const element = await browser.$(
    `[data-e2e-native-click-target="${targetId}"]`
  );
  await element.click();
  return { ...prepared, status: "clicked" };
}

async function clickLastVisibleReactPath(selector) {
  return execJS(`
    const elements = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
    const visible = elements.filter((element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    });
    const element = visible[visible.length - 1];
    if (!element) return { status: "missing", count: elements.length, visibleCount: visible.length };
    element.scrollIntoView({ block: "center", inline: "center" });
    const rect = element.getBoundingClientRect();
    const eventInit = {
      bubbles: true,
      cancelable: true,
      view: window,
      button: 0,
      buttons: 1,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    };
    element.dispatchEvent(new PointerEvent("pointerdown", eventInit));
    element.dispatchEvent(new MouseEvent("mousedown", eventInit));
    element.dispatchEvent(new PointerEvent("pointerup", { ...eventInit, buttons: 0 }));
    element.dispatchEvent(new MouseEvent("mouseup", { ...eventInit, buttons: 0 }));
    element.dispatchEvent(new MouseEvent("click", { ...eventInit, buttons: 0 }));
    return {
      status: "clicked",
      count: elements.length,
      visibleCount: visible.length,
      text: element.textContent || "",
      testId: element.getAttribute("data-testid"),
      accountId: element.getAttribute("data-source-account-id"),
      modelType: element.getAttribute("data-source-model-type"),
    };
  `);
}

async function clickLastVisibleDomClick(selector) {
  return execJS(`
    const elements = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
    const visible = elements.filter((element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    });
    const element = visible[visible.length - 1];
    if (!element) return { status: "missing", count: elements.length, visibleCount: visible.length };
    element.scrollIntoView({ block: "center", inline: "center" });
    element.click();
    return {
      status: "clicked",
      count: elements.length,
      visibleCount: visible.length,
      text: element.textContent || "",
      testId: element.getAttribute("data-testid"),
      accountId: element.getAttribute("data-source-account-id"),
      modelType: element.getAttribute("data-source-model-type"),
    };
  `);
}

async function hoverLastVisibleNative(selector) {
  const targetId = `e2e-hover-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const prepared = await execJS(`
    document.querySelectorAll('[data-e2e-native-hover-target]').forEach((node) => {
      node.removeAttribute('data-e2e-native-hover-target');
    });
    const elements = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
    const visible = elements.filter((element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    });
    const element = visible[visible.length - 1];
    if (!element) return { status: "missing", count: elements.length, visibleCount: visible.length };
    element.setAttribute('data-e2e-native-hover-target', ${JSON.stringify(targetId)});
    return {
      status: "prepared",
      count: elements.length,
      visibleCount: visible.length,
      text: element.textContent || "",
      testId: element.getAttribute("data-testid"),
      ariaLabel: element.getAttribute("aria-label"),
    };
  `);
  if (prepared?.status !== "prepared") return prepared;
  const element = await browser.$(
    `[data-e2e-native-hover-target="${targetId}"]`
  );
  await element.moveTo();
  return { ...prepared, status: "hovered" };
}

async function clickLastVisibleNativeByText(selector, text) {
  const targetId = `e2e-click-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const prepared = await execJS(`
    document.querySelectorAll('[data-e2e-native-click-target]').forEach((node) => {
      node.removeAttribute('data-e2e-native-click-target');
    });
    const elements = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
    const visible = elements.filter((element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      const elementText = element.textContent || "";
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" && elementText.includes(${JSON.stringify(text)});
    });
    const element = visible[visible.length - 1];
    if (!element) return { status: "missing", count: elements.length, visibleCount: visible.length, textMatch: ${JSON.stringify(text)} };
    element.setAttribute('data-e2e-native-click-target', ${JSON.stringify(targetId)});
    return {
      status: "prepared",
      count: elements.length,
      visibleCount: visible.length,
      text: element.textContent || "",
      testId: element.getAttribute("data-testid"),
      disabled: element.disabled === true,
      ariaLabel: element.getAttribute("aria-label"),
    };
  `);
  if (prepared?.status !== "prepared") return prepared;
  const element = await browser.$(
    `[data-e2e-native-click-target="${targetId}"]`
  );
  await element.click();
  return { ...prepared, status: "clicked" };
}

export async function invokeE2E(method, ...args) {
  return browser.executeAsyncScript(
    `
    const callback = arguments[arguments.length - 1];
    const methodName = arguments[0];
    const rest = Array.prototype.slice.call(arguments, 1, arguments.length - 1);
    if (!window.__e2e || typeof window.__e2e[methodName] !== "function") {
      callback({ ok: false, error: "window.__e2e." + methodName + " not available" });
      return;
    }
    window.__e2e[methodName].apply(null, rest)
      .then(callback)
      .catch((error) => callback({ ok: false, error: String(error && error.message || error) }));
  `,
    [method, ...args]
  );
}

export function unwrap(result, label) {
  if (!result || result.ok !== true) {
    throw new Error(`${label} failed: ${result?.error ?? "unknown"}`);
  }
  return result;
}

export function ensureFixtureRepoSelected() {
  if (!E2E_REPO_PATH) {
    throw new Error("E2E_REPO_PATH was not initialized by the WDIO runner");
  }
  return { path: E2E_REPO_PATH };
}

function withTimeout(operation, timeoutMs, label) {
  let timer = null;
  return Promise.race([
    operation(),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function runAccountSwitchWithTimeout(label, operation) {
  console.log(`[account-switch-stage] ${label} start`);
  const startedAt = Date.now();
  return withTimeout(operation, SCENARIO_TIMEOUT_MS, label).finally(() => {
    console.log(`[account-switch-stage] ${label} end elapsed=${Date.now() - startedAt}ms`);
  });
}

function parseE2EChain(rawValue, fallbackValues) {
  const parsed = (rawValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const source = parsed.length > 0 ? parsed : fallbackValues;
  return Array.from(new Set(source.filter(Boolean)));
}

export function shouldRunScenario(scenarioName) {
  return (
    ACCOUNT_SWITCH_SCENARIOS.length === 0 ||
    ACCOUNT_SWITCH_SCENARIOS.includes(scenarioName)
  );
}

function isScenarioExplicitlyRequested(scenarioName) {
  return ACCOUNT_SWITCH_SCENARIOS.includes(scenarioName);
}

export function skipOrFailMissingCoverage(mochaContext, scenarioName, message) {
  if (isScenarioExplicitlyRequested(scenarioName)) {
    throw new Error(
      `[account-switch-missing-coverage] scenario=${scenarioName} ${message}`
    );
  }
  console.log(message);
  mochaContext.skip();
}

export function assertKnownRequestedScenarios() {
  const unknownScenarios = ACCOUNT_SWITCH_SCENARIOS.filter(
    (scenarioName) => !ACCOUNT_SWITCH_SCENARIO_NAMES.has(scenarioName)
  );
  if (unknownScenarios.length > 0) {
    throw new Error(
      `Unknown E2E_ACCOUNT_SWITCH_SCENARIOS=${JSON.stringify(unknownScenarios)}; known=${JSON.stringify(Array.from(ACCOUNT_SWITCH_SCENARIO_NAMES))}`
    );
  }
}

export function logScenarioScope(scenarioName) {
  console.log(
    `[account-switch-scope] scenario=${scenarioName} rendered_ui=true`
  );
}

export function sharedModelsFromChain(initialAccount, followupAccount, modelChain) {
  return modelChain.filter(
    (candidate) =>
      (initialAccount.enabled_models ?? []).includes(candidate) &&
      (followupAccount.enabled_models ?? []).includes(candidate)
  );
}

function isCursorAccountBlockedResponse(response) {
  const text = providerBlockedText(response);
  return (
    text.includes("cursor connect error invalid_argument") ||
    text.includes("cursor connect error")
  );
}

export function isGeminiTransientCapacityResponse(response) {
  const text = providerBlockedText(response);
  return (
    text.includes("429") ||
    text.includes("too many requests") ||
    text.includes("model_capacity_exhausted") ||
    text.includes("capacity") ||
    text.includes("rate limit") ||
    text.includes("rate_limit") ||
    text.includes("overloaded") ||
    text.includes("unavailable")
  );
}

export async function skipCursorProviderBlockedIfApplicable(
  mochaContext,
  scenarioName,
  error
) {
  const state = await invokeE2E("inspectChatState").catch((stateError) => ({
    ok: false,
    error: String(stateError?.message ?? stateError),
  }));
  if (
    isCursorAccountBlockedResponse(error) ||
    isCursorAccountBlockedResponse(state)
  ) {
    skipOrFailMissingCoverage(
      mochaContext,
      scenarioName,
      `[${scenarioName}] Cursor provider/account blocked: ${String(error?.message ?? error).slice(0, 700)} state=${JSON.stringify({ runtimeError: state.runtimeError, runtimeStatus: state.runtimeStatus })}`
    );
    return true;
  }
  return false;
}

export async function waitForApp() {
  await waitForFrontendReady();
  await browser.setTimeout({ script: 5_000 });
  await browser.setWindowSize(1800, 1000).catch(() => undefined);
  await browser.waitUntil(
    async () =>
      safeExecJS(
        `return document.readyState === 'complete' || document.readyState === 'interactive';`
      ),
    {
      timeout: MOUNT_TIMEOUT_MS,
      timeoutMsg: "app document never became script-readable",
    }
  );
  await browser.waitUntil(
    async () =>
      safeExecJS(
        `return !!document.querySelector('[data-testid="chat-panel"]');`
      ),
    { timeout: MOUNT_TIMEOUT_MS, timeoutMsg: "chat-panel never mounted" }
  );
  await browser.waitUntil(
    async () =>
      safeExecJS(
        `return !!(window.__e2e
          && window.__e2e.listAccounts
          && window.__e2e.ensureRepoSelected
          && window.__e2e.configureWithExistingKey
          && window.__e2e.getActiveSessionId
          && window.__e2e.inspectChatState
          && window.__e2e.navigateTo);`
      ),
    { timeout: 20_000, timeoutMsg: "required __e2e helpers never exposed" }
  );
}

function accountDisplayName(account) {
  return account.name || account.id;
}

async function configureRenderedCreator({
  account,
  model,
  category,
  cliAgentType,
  agentDefinitionId,
  nativeHarnessType,
  repoPath,
}) {
  unwrap(
    await invokeE2E("navigateTo", "/orgii/workstation/code"),
    "navigateTo workstation code"
  );
  unwrap(await invokeE2E("resetToNewSession"), "resetToNewSession");
  const configured = unwrap(
    await invokeE2E("configureWithExistingKey", {
      accountName: accountDisplayName(account),
      model,
      agentType: account.agent_type,
      category,
      cliAgentType,
      agentDefinitionId,
      nativeHarnessType,
      repoPath,
    }),
    `configureWithExistingKey(${category}:${account.agent_type})`
  );
  expect(configured.accountId).toBe(account.id);
  expect(configured.modelId).toBe(model);
  await browser.waitUntil(
    async () => {
      const mode = await execJS(js.mode);
      const sendState = await execJS(js.sendState);
      return mode === "creator" && sendState?.state === "submit";
    },
    {
      timeout: MOUNT_TIMEOUT_MS,
      timeoutMsg: `configured creator never became ready; dump=${JSON.stringify(await execJS(js.pageDump))}`,
    }
  );
}

async function sendFromRenderedComposer(prompt, label) {
  const inputSelector = '[data-testid="chat-input"] [contenteditable="true"]';
  await browser.waitUntil(async () => execJS(js.exists(inputSelector)), {
    timeout: MOUNT_TIMEOUT_MS,
    timeoutMsg: `${label} chat input never mounted; dump=${JSON.stringify(await execJS(js.pageDump))}`,
  });
  const typeResult = await execJS(js.type(inputSelector, prompt));
  if (typeof typeResult !== "string" || !typeResult.includes(prompt)) {
    throw new Error(
      `${label} failed to type prompt: ${JSON.stringify(typeResult)}`
    );
  }
  await browser.waitUntil(
    async () => {
      const state = await execJS(js.sendState);
      return state?.state === "submit" && !state.disabled;
    },
    {
      timeout: 20_000,
      timeoutMsg: `${label} send button never became submit; state=${JSON.stringify(await execJS(js.sendState))}; dump=${JSON.stringify(await execJS(js.pageDump))}`,
    }
  );
  const clicked = await execJS(js.click('[data-testid="chat-send-button"]'));
  if (clicked !== "clicked") {
    throw new Error(`${label} send click failed: ${clicked}`);
  }
}

async function waitForActiveSession(label) {
  await browser.waitUntil(
    async () => {
      const active = unwrap(
        await invokeE2E("getActiveSessionId"),
        `${label}-getActiveSessionId`
      );
      return !!active.sessionId;
    },
    {
      timeout: ENDPOINT_TIMEOUT_MS,
      interval: 1_000,
      timeoutMsg: `${label} did not create an active session; state=${JSON.stringify(await invokeE2E("inspectChatState"))}; dump=${JSON.stringify(await execJS(js.pageDump))}`,
    }
  );
  return unwrap(
    await invokeE2E("getActiveSessionId"),
    `${label}-getActiveSessionId-final`
  ).sessionId;
}

async function waitForComposerIdle(label, expectedAssistantText = null) {
  await browser.waitUntil(
    async () => {
      const state = await execJS(js.sendState);
      const chat = unwrap(
        await invokeE2E("inspectChatState"),
        `${label}-inspectChatState`
      );
      if (chat.runtimeStatus === "failed" && chat.runtimeError) {
        throw new Error(`${label} runtime failed: ${chat.runtimeError}`);
      }
      const expectedReplyReady =
        expectedAssistantText === null ||
        chat.chatEvents.some(
          (event) =>
            event.source === "assistant" &&
            event.displayVariant === "message" &&
            event.displayText.trim() === expectedAssistantText
        );
      return (
        expectedReplyReady &&
        state?.state === "submit" &&
        !state.disabled &&
        !chat.isSessionActive &&
        chat.runtimeStatus !== "running"
      );
    },
    {
      timeout: ENDPOINT_TIMEOUT_MS,
      interval: 2_000,
      timeoutMsg: `${label} composer did not become idle; expectedAssistantText=${JSON.stringify(expectedAssistantText)} state=${JSON.stringify(await execJS(js.sendState))}; chat=${JSON.stringify(await invokeE2E("inspectChatState"))}; dump=${JSON.stringify(await execJS(js.pageDump))}`,
    }
  );
}

function modelTokens(modelId) {
  return String(modelId ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function hasSameModelTokens(leftTokens, rightTokens) {
  if (leftTokens.length !== rightTokens.length) return false;
  const rightSet = new Set(rightTokens);
  return leftTokens.every((token) => rightSet.has(token));
}

function sessionModelMatches(actualModel, expectedModel) {
  const actual = String(actualModel ?? "");
  const expected = String(expectedModel ?? "");
  if (actual === expected) return true;

  const actualTokens = modelTokens(actual);
  const expectedTokens = modelTokens(expected);
  if (actualTokens.length === 0 || expectedTokens.length === 0) return false;
  return hasSameModelTokens(actualTokens, expectedTokens);
}

function parseModelIdList(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  return String(value ?? "")
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function getAllowedSwitchModels(account, fallbackModel, groupModelIds = []) {
  const groupModels =
    groupModelIds.length > 0 ? groupModelIds : [fallbackModel];
  const enabled = new Set(account.enabled_models ?? []);
  const accountModels = groupModels.filter((modelId) => enabled.has(modelId));
  return accountModels.length > 0 ? accountModels : [fallbackModel];
}

function sessionModelMatchesAny(actualModel, expectedModels) {
  return expectedModels.some((expectedModel) =>
    sessionModelMatches(actualModel, expectedModel)
  );
}

async function isSessionPatchedTo(accountId, expectedModels, label) {
  const state = unwrap(
    await invokeE2E("inspectChatState"),
    `${label}-inspectChatState`
  );
  return (
    state.activeSession?.accountId === accountId &&
    sessionModelMatchesAny(state.activeSession?.model, expectedModels)
  );
}

/**
 * Tolerant variant for polling loops: between an account patch
 * (`invalidate_session`) and the next turn's re-init the backend
 * legitimately returns "session runtime not initialized" — that window
 * must read as "not switched yet", not a hard throw inside waitUntil.
 */
async function tryReadRuntimeModelSnapshot(sessionId) {
  const result = await invokeE2E("debugSessionModelSnapshot", sessionId);
  if (!result || result.ok !== true) return null;
  return result.snapshot;
}

async function assertRustRuntimeAccount(
  sessionId,
  expectedAccountId,
  forbiddenAccountId,
  label
) {
  let snapshot = null;
  await browser.waitUntil(
    async () => {
      snapshot = await tryReadRuntimeModelSnapshot(sessionId);
      return snapshot?.activeAccountId === expectedAccountId;
    },
    {
      timeout: 20_000,
      interval: 500,
      timeoutMsg: `${label} runtime did not switch activeAccountId to ${expectedAccountId}; forbidden=${forbiddenAccountId}; snapshot=${JSON.stringify(snapshot)}`,
    }
  );
  expect(snapshot.activeAccountId).toBe(expectedAccountId);
  if (forbiddenAccountId) {
    expect(snapshot.activeAccountId).not.toBe(forbiddenAccountId);
  }
  console.log(
    `[account-switch-evidence] label=${label} runtimeActiveAccount=${snapshot.activeAccountId} activeModel=${snapshot.activeModel}`
  );
}

/**
 * Backend-truth assertion for CLI sessions: the persisted
 * `code_sessions.account_id` row (read via `cli_agent_status`) must carry
 * the switched account — the frontend store value alone is optimistic.
 */
async function assertCliPersistedAccount(sessionId, expectedAccountId, label) {
  let session = null;
  await browser.waitUntil(
    async () => {
      const result = await invokeE2E("inspectCliSessionStatus", sessionId);
      if (!result || result.ok !== true) return false;
      session = result.session;
      return session?.accountId === expectedAccountId;
    },
    {
      timeout: 20_000,
      interval: 500,
      timeoutMsg: `${label} persisted code_sessions.account_id never became ${expectedAccountId}; session=${JSON.stringify(session)}`,
    }
  );
  console.log(
    `[account-switch-evidence] label=${label} persistedCliAccount=${session?.accountId}`
  );
}

async function switchAccountThroughRenderedPicker(
  followupAccount,
  model,
  label
) {
  await browser.waitUntil(
    async () => execJS(js.exists('[data-testid="chat-model-pill-model"]')),
    {
      timeout: MOUNT_TIMEOUT_MS,
      timeoutMsg: `${label} model pill never mounted; dump=${JSON.stringify(await execJS(js.pageDump))}`,
    }
  );

  const sourceSelector = `[data-testid="unified-model-source-option"][data-source-account-id="${followupAccount.id}"]`;
  const modelSelector = `[data-spotlight-model-section="all"][data-spotlight-model-id="${model}"], [data-spotlight-model-section="all"][data-spotlight-model-id^="${model}-"], [data-spotlight-model-section="all"][data-spotlight-group-model-ids~="${model}"]`;

  const clicked = await clickLastVisibleNative(
    '[data-testid="chat-model-pill-model"]'
  );
  if (clicked?.status !== "clicked") {
    throw new Error(
      `${label} model pill click failed: ${JSON.stringify(clicked)}`
    );
  }
  console.log(
    `[account-switch-evidence] label=${label} clickedModelPill=${JSON.stringify(clicked)}`
  );

  await browser.waitUntil(async () => execJS(js.exists(modelSelector)), {
    timeout: MOUNT_TIMEOUT_MS,
    interval: 250,
    timeoutMsg: `${label} model option never appeared for model=${model}; dump=${JSON.stringify(await execJS(js.pageDump))}`,
  });

  const modelHovered = await hoverLastVisibleNative(modelSelector);
  if (modelHovered?.status !== "hovered") {
    throw new Error(
      `${label} model option hover failed for model=${model}: ${JSON.stringify(modelHovered)} dump=${JSON.stringify(await execJS(js.pageDump))}`
    );
  }

  const modelClicked = await clickLastVisibleNative(modelSelector);
  if (modelClicked?.status !== "clicked") {
    throw new Error(
      `${label} model option click failed for model=${model}: ${JSON.stringify(modelClicked)} dump=${JSON.stringify(await execJS(js.pageDump))}`
    );
  }
  console.log(
    `[account-switch-evidence] label=${label} hoveredModel=${JSON.stringify(modelHovered)} clickedModel=${JSON.stringify(modelClicked)}`
  );

  const modelGroupIds = parseModelIdList(modelClicked.groupModelIds);
  const allowedSwitchModels = getAllowedSwitchModels(
    followupAccount,
    model,
    modelGroupIds
  );

  if (
    await isSessionPatchedTo(followupAccount.id, allowedSwitchModels, label)
  ) {
    console.log(
      `[account-switch-evidence] label=${label} switchedByModelSelection=true account=${followupAccount.id} allowedModels=${JSON.stringify(allowedSwitchModels)}`
    );
    return allowedSwitchModels;
  }

  await browser.waitUntil(async () => execJS(js.exists(sourceSelector)), {
    timeout: MOUNT_TIMEOUT_MS,
    interval: 250,
    timeoutMsg: `${label} source option never appeared after model selection for model=${model} account=${followupAccount.id}; dump=${JSON.stringify(await execJS(js.pageDump))}`,
  });

  let sourceClicked = null;
  const sourceClickStrategies = [
    clickLastVisibleNative,
    clickLastVisibleReactPath,
    clickLastVisibleDomClick,
  ];
  const startedAt = Date.now();
  while (Date.now() - startedAt < 20_000) {
    for (const clickSourceOption of sourceClickStrategies) {
      try {
        sourceClicked = await clickSourceOption(sourceSelector);
      } catch (error) {
        sourceClicked = {
          status: "error",
          error: String(error?.message ?? error),
        };
        continue;
      }
      if (sourceClicked?.status !== "clicked") continue;
      if (
        await isSessionPatchedTo(followupAccount.id, allowedSwitchModels, label)
      ) {
        console.log(
          `[account-switch-evidence] label=${label} clickedSource=${JSON.stringify(sourceClicked)} allowedModels=${JSON.stringify(allowedSwitchModels)}`
        );
        return allowedSwitchModels;
      }
    }
    await browser.pause(500);
  }
  throw new Error(
    `${label} source option click did not patch session; sourceClicked=${JSON.stringify(sourceClicked)} state=${JSON.stringify(await invokeE2E("inspectChatState"))}; dump=${JSON.stringify(await execJS(js.pageDump))}`
  );
}

async function runRenderedAccountSwitchImpl({
  label,
  initialAccount,
  followupAccount,
  model,
  category,
  cliAgentType,
  agentDefinitionId,
  nativeHarnessType,
  repoPath,
  initialExpectedText,
  followupExpectedText,
  reverseExpectedText,
  allowFollowupProviderFailure = false,
  skipFollowupProviderCall = false,
}) {
  await configureRenderedCreator({
    account: initialAccount,
    model,
    category,
    cliAgentType,
    agentDefinitionId,
    nativeHarnessType,
    repoPath,
  });

  await sendFromRenderedComposer(
    `Reply with exactly ${initialExpectedText} and no other words.`,
    `${label} initial`
  );
  const sessionId = await waitForActiveSession(`${label} initial`);
  expect(sessionId).toBeTruthy();
  await waitForComposerIdle(`${label} initial`, initialExpectedText);
  await assertNoDuplicateTranscriptMessages(`${label} initial`);
  await browser.waitUntil(
    async () =>
      isSessionPatchedTo(
        initialAccount.id,
        [model],
        `${label} initial-account`
      ),
    {
      timeout: 20_000,
      interval: 500,
      timeoutMsg: `${label} initial session row was not on initial account; state=${JSON.stringify(await invokeE2E("inspectChatState"))}; dump=${JSON.stringify(await execJS(js.pageDump))}`,
    }
  );
  if (category === "rust_agent") {
    await assertRustRuntimeAccount(
      sessionId,
      initialAccount.id,
      followupAccount.id,
      `${label} initial-runtime-account`
    );
  }

  let expectedFinalModels = await switchAccountThroughRenderedPicker(
    followupAccount,
    model,
    label
  );
  const switchedState = unwrap(
    await invokeE2E("inspectChatState"),
    `${label} switched inspectChatState`
  );
  console.log(
    `[account-switch-evidence] label=${label} session=${sessionId} initialAccount=${initialAccount.id} followupAccount=${followupAccount.id} switchedAccount=${switchedState.activeSession?.accountId ?? "<missing>"} model=${switchedState.activeSession?.model ?? "<missing>"}`
  );
  if (category === "cli_agent") {
    // Backend truth — the frontend value above is the optimistic store
    // write; CLI scenarios have no runtime snapshot, so assert the
    // persisted DB row instead.
    await assertCliPersistedAccount(
      sessionId,
      followupAccount.id,
      `${label} switched-persisted`
    );
  }

  if (skipFollowupProviderCall) {
    console.log(
      `[account-switch-evidence] label=${label} skippedFollowupProviderCall=true reason=provider-capacity-prone switch-state-already-verified`
    );
  } else {
    await sendFromRenderedComposer(
      `Reply with exactly ${followupExpectedText} and no other words.`,
      `${label} follow-up`
    );
    if (category === "rust_agent") {
      await assertRustRuntimeAccount(
        sessionId,
        followupAccount.id,
        initialAccount.id,
        `${label} followup-runtime-account`
      );
    }
    try {
      await waitForComposerIdle(`${label} follow-up`, followupExpectedText);
      await assertNoDuplicateTranscriptMessages(`${label} follow-up`);
    } catch (error) {
      if (!allowFollowupProviderFailure) throw error;
      console.log(
        `[account-switch-evidence] label=${label} followupProviderFailureAllowed=${String(error?.message ?? error)}`
      );
    }
  }

  if (category === "rust_agent" && reverseExpectedText) {
    expectedFinalModels = await switchAccountThroughRenderedPicker(
      initialAccount,
      model,
      `${label} reverse`
    );
    await sendFromRenderedComposer(
      `Reply with exactly ${reverseExpectedText} and no other words.`,
      `${label} reverse-follow-up`
    );
    await assertRustRuntimeAccount(
      sessionId,
      initialAccount.id,
      followupAccount.id,
      `${label} reverse-runtime-account`
    );
    try {
      await waitForComposerIdle(
        `${label} reverse-follow-up`,
        reverseExpectedText
      );
      await assertNoDuplicateTranscriptMessages(`${label} reverse-follow-up`);
    } catch (error) {
      if (!allowFollowupProviderFailure) throw error;
      console.log(
        `[account-switch-evidence] label=${label} reverseProviderFailureAllowed=${String(error?.message ?? error)}`
      );
    }
  }

  const state = unwrap(
    await invokeE2E("inspectChatState"),
    `${label} inspectChatState`
  );
  const finalExpectedAccountId =
    category === "rust_agent" && reverseExpectedText
      ? initialAccount.id
      : followupAccount.id;
  console.log(
    `[account-switch-evidence] label=${label} session=${sessionId} finalAccount=${state.activeSession?.accountId ?? "<missing>"} model=${state.activeSession?.model ?? "<missing>"} active=${state.isSessionActive}`
  );
  expect(state.activeSessionId).toBe(sessionId);
  expect(state.activeSession?.accountId).toBe(finalExpectedAccountId);
  expect(
    sessionModelMatchesAny(state.activeSession?.model, expectedFinalModels)
  ).toBe(true);
  return state;
}

export async function runRenderedAccountSwitch(config) {
  return runAccountSwitchWithTimeout(config.label, () =>
    runRenderedAccountSwitchImpl(config)
  );
}

/**
 * 行进中 (mid-stream) variant: the switch happens WHILE a turn is
 * actively streaming, not between turns. Contract under test:
 *  1. The in-flight turn completes normally on the OLD account (the
 *     runtime Arc snapshotted at turn entry is isolated from the patch).
 *  2. The session row is patched to the new account immediately.
 *  3. The NEXT turn rebuilds the runtime onto the new account.
 *  4. The transcript is not duplicated by the mid-stream invalidation.
 *
 * Rust-agent only: CLI sessions intentionally kill + rerun on switch,
 * so "current turn completes on the old account" is not their contract.
 */
async function runRenderedMidStreamAccountSwitchImpl({
  label,
  initialAccount,
  followupAccount,
  model,
  category,
  agentDefinitionId,
  nativeHarnessType,
  repoPath,
  streamingPrompt,
  initialExpectedText,
  followupExpectedText,
}) {
  if (category !== "rust_agent") {
    throw new Error(
      `${label}: mid-stream switch contract only applies to rust_agent sessions`
    );
  }

  await configureRenderedCreator({
    account: initialAccount,
    model,
    category,
    agentDefinitionId,
    nativeHarnessType,
    repoPath,
  });

  // A prompt long enough to keep the turn streaming while we drive the
  // picker. The sentinel terminator lets us detect orderly completion.
  await sendFromRenderedComposer(
    streamingPrompt ??
      `Count from 1 to 40, one number per line, then finish with exactly ${initialExpectedText} on its own line.`,
    `${label} streaming`
  );
  const sessionId = await waitForActiveSession(`${label} streaming`);
  expect(sessionId).toBeTruthy();

  // Wait for the turn to actually be RUNNING (not idle) — the whole
  // point is to switch mid-flight.
  await browser.waitUntil(
    async () => {
      const chat = unwrap(
        await invokeE2E("inspectChatState"),
        `${label}-inspectChatState-running`
      );
      return chat.runtimeStatus === "running" || chat.isSessionActive;
    },
    {
      timeout: 30_000,
      interval: 250,
      timeoutMsg: `${label} turn never entered running state before switch`,
    }
  );

  const expectedFinalModels = await switchAccountThroughRenderedPicker(
    followupAccount,
    model,
    `${label} midstream`
  );

  // Session row must be patched immediately, even while streaming.
  await browser.waitUntil(
    async () =>
      isSessionPatchedTo(
        followupAccount.id,
        expectedFinalModels,
        `${label} midstream-row`
      ),
    {
      timeout: 20_000,
      interval: 500,
      timeoutMsg: `${label} session row was not patched to followup account during streaming; state=${JSON.stringify(await invokeE2E("inspectChatState"))}`,
    }
  );
  console.log(
    `[account-switch-evidence] label=${label} session=${sessionId} rowPatchedMidStream=true to=${followupAccount.id}`
  );

  // The in-flight turn must still complete normally (old account serves
  // it). The reply is "numbers + sentinel", so unlike the exact-match
  // idle helper we only require the sentinel to APPEAR in an assistant
  // message before the composer settles.
  await waitForComposerIdle(`${label} streaming`);
  const streamedChat = unwrap(
    await invokeE2E("inspectChatState"),
    `${label}-inspectChatState-streamed`
  );
  const sentinelSeen = streamedChat.chatEvents.some(
    (event) =>
      event.source === "assistant" &&
      event.displayVariant === "message" &&
      event.displayText.includes(initialExpectedText)
  );
  if (!sentinelSeen) {
    throw new Error(
      `${label}: in-flight turn did not complete with sentinel ${initialExpectedText} after mid-stream switch`
    );
  }
  await assertNoDuplicateTranscriptMessages(`${label} streaming`);

  // Next turn rebuilds onto the new account.
  await sendFromRenderedComposer(
    `Reply with exactly ${followupExpectedText} and no other words.`,
    `${label} follow-up`
  );
  await assertRustRuntimeAccount(
    sessionId,
    followupAccount.id,
    initialAccount.id,
    `${label} followup-runtime-account`
  );
  await waitForComposerIdle(`${label} follow-up`, followupExpectedText);
  await assertNoDuplicateTranscriptMessages(`${label} follow-up`);

  const state = unwrap(
    await invokeE2E("inspectChatState"),
    `${label} inspectChatState`
  );
  expect(state.activeSessionId).toBe(sessionId);
  expect(state.activeSession?.accountId).toBe(followupAccount.id);
  return state;
}

export async function runRenderedMidStreamAccountSwitch(config) {
  return runAccountSwitchWithTimeout(config.label, () =>
    runRenderedMidStreamAccountSwitchImpl(config)
  );
}

function findCliAccount(
  accounts,
  agentType,
  accountName,
  modelId,
  {
    requireOAuth = true,
    requireApiKey = false,
    requireSessionToken = true,
  } = {}
) {
  const account = accounts.find(
    (row) =>
      row.agent_type === agentType &&
      (!accountName || row.name === accountName || row.id === accountName) &&
      row.enabled &&
      (row.enabled_models ?? []).includes(modelId) &&
      (!requireOAuth || row.auth_method === "oauth") &&
      (!requireApiKey || row.has_api_key) &&
      (!requireSessionToken || row.has_session_token)
  );
  if (!account) {
    const available = accounts
      .filter((row) => row.agent_type === agentType)
      .map((row) => ({
        id: row.id,
        name: row.name,
        enabled: row.enabled,
        auth_method: row.auth_method,
        has_api_key: row.has_api_key,
        has_session_token: row.has_session_token,
        enabled_models: row.enabled_models,
      }));
    throw new Error(
      `${agentType} account ${accountName ?? `(any with ${modelId})`} not found with required auth fields. Available=${JSON.stringify(available)}`
    );
  }
  return account;
}

export function findCliAccountPair(
  accounts,
  agentType,
  initialAccountName,
  followupAccountName,
  modelId,
  {
    requireOAuth = true,
    requireApiKey = false,
    requireSessionToken = true,
  } = {}
) {
  const candidates = accounts.filter(
    (row) =>
      row.agent_type === agentType &&
      row.enabled &&
      (row.enabled_models ?? []).includes(modelId) &&
      (!requireOAuth || row.auth_method === "oauth") &&
      (!requireApiKey || row.has_api_key) &&
      (!requireSessionToken || row.has_session_token)
  );

  if (initialAccountName && followupAccountName) {
    return [
      findCliAccount(accounts, agentType, initialAccountName, modelId, {
        requireOAuth,
        requireApiKey,
        requireSessionToken,
      }),
      findCliAccount(accounts, agentType, followupAccountName, modelId, {
        requireOAuth,
        requireApiKey,
        requireSessionToken,
      }),
    ];
  }

  if (initialAccountName) {
    const initialAccount = findCliAccount(
      accounts,
      agentType,
      initialAccountName,
      modelId,
      { requireOAuth, requireApiKey, requireSessionToken }
    );
    const followupAccount = candidates.find(
      (candidate) => candidate.id !== initialAccount.id
    );
    return followupAccount ? [initialAccount, followupAccount] : null;
  }

  if (followupAccountName) {
    const followupAccount = findCliAccount(
      accounts,
      agentType,
      followupAccountName,
      modelId,
      { requireOAuth, requireApiKey, requireSessionToken }
    );
    const initialAccount = candidates.find(
      (candidate) => candidate.id !== followupAccount.id
    );
    return initialAccount ? [initialAccount, followupAccount] : null;
  }

  if (candidates.length < 2) return null;
  return [candidates[0], candidates[1]];
}

export function findClaudeCodeAccountPair(
  accounts,
  { requireRustAgentSupport = false } = {}
) {
  const filteredAccounts = requireRustAgentSupport
    ? accounts.filter((account) => account.supports_rust_agents)
    : accounts;
  return findCliAccountPair(
    filteredAccounts,
    CLAUDE_CODE_AGENT_TYPE,
    INITIAL_ACCOUNT_NAME,
    FOLLOWUP_ACCOUNT_NAME,
    MODEL_ID
  );
}

export function findCursorNativeAccountPair(accounts) {
  const filteredAccounts = accounts.filter(
    (account) => account.supports_rust_agents
  );
  return findCliAccountPair(
    filteredAccounts,
    CURSOR_AGENT_TYPE,
    CURSOR_NATIVE_INITIAL_ACCOUNT_NAME,
    CURSOR_NATIVE_FOLLOWUP_ACCOUNT_NAME,
    CURSOR_NATIVE_MODEL_ID,
    {
      requireOAuth: false,
      requireApiKey: false,
      requireSessionToken: true,
    }
  );
}

export function findGeminiAccountPair(accounts) {
  const candidates = accounts.filter(
    (row) =>
      row.agent_type === GEMINI_AGENT_TYPE &&
      row.enabled &&
      row.auth_method === "oauth" &&
      row.has_session_token &&
      GEMINI_MODEL_CHAIN.some((model) =>
        (row.enabled_models ?? []).includes(model)
      )
  );

  if (GEMINI_INITIAL_ACCOUNT_NAME && GEMINI_FOLLOWUP_ACCOUNT_NAME) {
    return [
      findGeminiAccount(accounts, GEMINI_INITIAL_ACCOUNT_NAME),
      findGeminiAccount(accounts, GEMINI_FOLLOWUP_ACCOUNT_NAME),
    ];
  }

  if (GEMINI_INITIAL_ACCOUNT_NAME) {
    const initialAccount = findGeminiAccount(
      accounts,
      GEMINI_INITIAL_ACCOUNT_NAME
    );
    const followupAccount = candidates.find(
      (candidate) => candidate.id !== initialAccount.id
    );
    return followupAccount ? [initialAccount, followupAccount] : null;
  }

  if (GEMINI_FOLLOWUP_ACCOUNT_NAME) {
    const followupAccount = findGeminiAccount(
      accounts,
      GEMINI_FOLLOWUP_ACCOUNT_NAME
    );
    const initialAccount = candidates.find(
      (candidate) => candidate.id !== followupAccount.id
    );
    return initialAccount ? [initialAccount, followupAccount] : null;
  }

  if (candidates.length < 2) return null;
  return [candidates[0], candidates[1]];
}

function findGeminiAccount(accounts, accountName) {
  const account = accounts.find(
    (row) =>
      row.agent_type === GEMINI_AGENT_TYPE &&
      (!accountName || row.name === accountName || row.id === accountName) &&
      row.enabled &&
      row.auth_method === "oauth" &&
      row.has_session_token &&
      GEMINI_MODEL_CHAIN.some((model) =>
        (row.enabled_models ?? []).includes(model)
      )
  );
  if (account) return account;

  const available = accounts
    .filter((row) => row.agent_type === GEMINI_AGENT_TYPE)
    .map((row) => ({
      id: row.id,
      name: row.name,
      enabled: row.enabled,
      auth_method: row.auth_method,
      has_session_token: row.has_session_token,
      enabled_models: row.enabled_models,
    }));
  throw new Error(
    `gemini account ${accountName ?? `(any with ${GEMINI_MODEL_CHAIN.join(",")})`} not found with required auth fields. Available=${JSON.stringify(available)}`
  );
}

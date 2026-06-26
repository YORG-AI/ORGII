/**
 * session-matrix-ui.spec.mjs
 *
 * Live rendered UI proof for provider-backed sessions. Setup helpers only select
 * existing KeyVault accounts in SessionCreator state; session launch itself must
 * happen by typing into the rendered chat input and clicking the rendered send
 * button. Tool assertions use the same rendered `data-tool-call-name` blocks a
 * user sees in the chat transcript.
 */

export const PROMPT_PREFIX = `ORGII_TOOL_UI_${Date.now()}`;
const CLAUDE_CODE_ACCOUNT_NAME = process.env.E2E_CLAUDE_CODE_ACCOUNT;
export const PREFERRED_CLAUDE_CODE_MODEL_ID =
  process.env.E2E_CLAUDE_CODE_MODEL ?? "claude-sonnet-4-6";
const CURSOR_CLI_ACCOUNT_NAME = process.env.E2E_CURSOR_CLI_ACCOUNT;
const CURSOR_NATIVE_ACCOUNT_NAME = process.env.E2E_CURSOR_NATIVE_ACCOUNT;
export const CURSOR_CLI_MODEL_ID =
  process.env.E2E_CURSOR_CLI_MODEL ?? "composer-2.5-fast";
export const CURSOR_NATIVE_MODEL_ID =
  process.env.E2E_CURSOR_NATIVE_MODEL ?? "composer-2.5-fast";
const CODEX_ACCOUNT_NAME = process.env.E2E_CODEX_ACCOUNT;
export const PREFERRED_CODEX_MODEL_ID = process.env.E2E_CODEX_MODEL ?? "gpt-5.5";
const GEMINI_ACCOUNT_NAME = process.env.E2E_GEMINI_ACCOUNT;
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
const API_ACCOUNT_NAME = process.env.E2E_OPENAI_ACCOUNT;
export const PREFERRED_API_MODEL_ID = process.env.E2E_OPENAI_MODEL ?? "op-4.6-relay";
const API_AGENT_TYPE = process.env.E2E_API_AGENT_TYPE ?? "openai_api";
const E2E_REPO_PATH = process.env.E2E_REPO_PATH;
export const CLAUDE_CODE_AGENT_TYPE = "claude_code";
export const CURSOR_AGENT_TYPE = "cursor_cli";
export const CODEX_AGENT_TYPE = "codex";
export const GEMINI_AGENT_TYPE = "gemini_cli";
export const CURSOR_NATIVE_HARNESS_TYPE = "cursor_native";
const MOUNT_TIMEOUT_MS = 60_000;
const REPLY_TIMEOUT_MS = Number.parseInt(
  process.env.E2E_REPLY_TIMEOUT_MS ?? "180000",
  10
);
const TOOL_TIMEOUT_MS = Number.parseInt(
  process.env.E2E_TOOL_TIMEOUT_MS ?? "120000",
  10
);
const GEMINI_PRE_TOOL_FALLBACK_TIMEOUT_MS = Number.parseInt(
  process.env.E2E_GEMINI_PRE_TOOL_FALLBACK_TIMEOUT_MS ?? "30000",
  10
);
const MATRIX_LABEL_FILTER = (process.env.E2E_MATRIX_LABELS ?? "")
  .split(",")
  .map((label) => label.trim())
  .filter(Boolean);
const blockedAccountIds = new Set();

async function execJS(script) {
  return browser.executeScript(script, []);
}

async function invokeE2E(method, ...args) {
  return browser.executeAsyncScript(
    `
    const cb = arguments[arguments.length - 1];
    const method = arguments[0];
    const rest = Array.prototype.slice.call(arguments, 1, arguments.length - 1);
    if (!window.__e2e || typeof window.__e2e[method] !== "function") {
      cb({ ok: false, error: "window.__e2e." + method + " not available" });
      return;
    }
    window.__e2e[method].apply(null, rest)
      .then(cb)
      .catch((error) => cb({ ok: false, error: String(error && error.message || error) }));
  `,
    [method, ...args]
  );
}

function unwrap(result, label) {
  if (!result || result.ok !== true) {
    throw new Error(`${label} failed: ${result?.error ?? "unknown"}`);
  }
  return result;
}

const js = {
  exists: (selector) =>
    `return !!document.querySelector(${JSON.stringify(selector)});`,
  mode: `
    const creator = document.querySelector(".session-creator-chat-panel");
    const history = document.querySelector('[data-testid="chat-message-list"]');
    return creator ? "creator" : history ? "chat" : "unknown";
  `,
  type: (selector, text) => `
    const editor = document.querySelector(${JSON.stringify(selector)});
    if (!editor) return "missing";
    editor.focus();
    const ok = document.execCommand("insertText", false, ${JSON.stringify(text)});
    return ok ? "typed" : "insert-failed";
  `,
  editorText: (selector) => `
    const editor = document.querySelector(${JSON.stringify(selector)});
    return editor ? (editor.textContent || "") : null;
  `,
  click: (selector) => `
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return "missing";
    if (element.disabled) return "disabled";
    element.click();
    return "clicked";
  `,
  sendState: `
    const button = document.querySelector('[data-testid="chat-send-button"]');
    if (!button) return null;
    return { state: button.getAttribute("data-state"), disabled: button.disabled };
  `,
  latestAssistant: `
    const bubbles = Array.from(document.querySelectorAll('[data-testid="chat-message-assistant"]'));
    if (bubbles.length === 0) return { text: "" };
    const latest = bubbles[bubbles.length - 1];
    return { text: (latest.textContent || latest.innerText || "").trim() };
  `,
  toolBlocks: `
    const blocks = Array.from(document.querySelectorAll('[data-tool-call-name]'));
    return blocks.map((block) => ({
      name: block.getAttribute('data-tool-call-name') || '',
      eventId: block.getAttribute('data-tool-call-event-id') || '',
      text: (block.textContent || block.innerText || '').trim().slice(0, 1000),
    })).filter((block) => block.name.length > 0);
  `,
  scrollChatTo: (position) => `
    const candidates = Array.from(document.querySelectorAll(
      '[data-virtuoso-scroller], [data-testid="chat-message-list"] [style*="overflow"]'
    ));
    const scroller = candidates.find((element) =>
      element instanceof HTMLElement && element.scrollHeight > element.clientHeight
    );
    if (!scroller) return "missing";
    if (${JSON.stringify(position)} === "top") {
      scroller.scrollTop = 0;
    } else {
      scroller.scrollTop = scroller.scrollHeight;
    }
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    return "scrolled";
  `,
  pageDump: `
    const list = document.querySelector('[data-testid="chat-message-list"]');
    return {
      mode: (() => {
        const creator = document.querySelector(".session-creator-chat-panel");
        const history = document.querySelector('[data-testid="chat-message-list"]');
        return creator ? "creator" : history ? "chat" : "unknown";
      })(),
      assistantCount: document.querySelectorAll('[data-testid="chat-message-assistant"]').length,
      toolBlocks: Array.from(document.querySelectorAll('[data-tool-call-name]')).map((block) => ({
        name: block.getAttribute('data-tool-call-name') || '',
        text: (block.textContent || block.innerText || '').trim().slice(0, 500),
      })),
      bodyText: (document.body.innerText || '').slice(0, 3000),
      listText: list ? (list.textContent || '').slice(0, 3000) : null,
      listAttrs: list ? {
        chatHistoryCount: list.getAttribute('data-chat-history-count'),
        optimizedCount: list.getAttribute('data-optimized-count'),
        flatCount: list.getAttribute('data-flat-count'),
        groupCounts: list.getAttribute('data-group-counts'),
      } : null,
      sendState: (() => {
        const button = document.querySelector('[data-testid="chat-send-button"]');
        return button ? { state: button.getAttribute("data-state"), disabled: button.disabled } : null;
      })(),
    };
  `,
  retryOrModelError: `
    const text = document.body.innerText || "";
    return {
      reconnecting: /reconnecting/i.test(text),
      unsupportedModel: /model is not supported|unsupported model|invalid model/i.test(text),
      transientCapacity: /429|too many requests|quota_exhausted|rate limited|rate limit|capacity|model_capacity_exhausted|overloaded|unavailable|gemini-client-error/i.test(text),
      sendState: (() => {
        const button = document.querySelector('[data-testid="chat-send-button"]');
        return button ? { state: button.getAttribute("data-state"), disabled: button.disabled } : null;
      })(),
      text: text.slice(0, 2000),
    };
  `,
};

export async function waitForApp() {
  await browser.setWindowSize(2400, 1200).catch(() => undefined);
  await execJS(`
    localStorage.setItem("orgii:auth_skipped", "1");
    localStorage.setItem("orgii:e2eBaseUrl", ${JSON.stringify(process.env.E2E_BASE_URL ?? "http://127.0.0.1:13847")});
    if (location.pathname.includes("login")) {
      location.reload();
    }
    return true;
  `).catch(() => undefined);
  await browser.pause(500);
  await browser.waitUntil(
    async () => execJS(js.exists('[data-testid="chat-panel"]')),
    { timeout: MOUNT_TIMEOUT_MS, timeoutMsg: "chat-panel never mounted" }
  );
  await browser.waitUntil(
    async () =>
      execJS(
        `return !!(window.__e2e
          && window.__e2e.configureWithExistingKey
          && window.__e2e.listAccounts
          && window.__e2e.getActiveSessionId
          && window.__e2e.resetToNewSession
          && window.__e2e.navigateTo);`
      ),
    { timeout: 10_000, timeoutMsg: "required __e2e helpers never exposed" }
  );
}

async function listAccounts() {
  return unwrap(await invokeE2E("listAccounts"), "listAccounts").accounts;
}

function accountDisplayName(account) {
  return account.name || account.id;
}

function parseE2EChain(rawValue, fallbackValues) {
  const parsed = (rawValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const source = parsed.length > 0 ? parsed : fallbackValues;
  return Array.from(new Set(source.filter(Boolean)));
}

export function selectPreferredModel(account, preferredModel) {
  const enabledModels = account.enabled_models ?? [];
  return enabledModels.includes(preferredModel)
    ? preferredModel
    : enabledModels[0];
}

export function selectModelFromChain(account, modelChain) {
  const model = modelChain.find((candidate) =>
    (account.enabled_models ?? []).includes(candidate)
  );
  if (!model) {
    throw new Error(
      `No model from chain ${JSON.stringify(modelChain)} is enabled for account ${accountDisplayName(account)}; enabled=${JSON.stringify(account.enabled_models ?? [])}`
    );
  }
  return model;
}

function matchesOptionalAccountName(row, accountName) {
  return !accountName || row.name === accountName || row.id === accountName;
}

function shouldRunMatrixLabel(label) {
  return (
    MATRIX_LABEL_FILTER.length === 0 || MATRIX_LABEL_FILTER.includes(label)
  );
}

function isGeminiConfig(config) {
  return config.account?.agent_type === GEMINI_AGENT_TYPE;
}

function isClaudeCodeConfig(config) {
  return config.account?.agent_type === CLAUDE_CODE_AGENT_TYPE;
}

class ProviderBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProviderBlockedError";
  }
}

function isProviderAccountBlockedError(error) {
  const message = String(error?.message ?? error ?? "").toLowerCase();
  return (
    message.includes("oauth refresh failed") ||
    message.includes("refresh_token_reused") ||
    message.includes("refresh token") ||
    message.includes("needs to be signed in again") ||
    message.includes("invalid_grant") ||
    message.includes("unauthorized") ||
    message.includes("auth error") ||
    message.includes("cursor connect error invalid_argument")
  );
}

function isGeminiTransientCapacityError(error) {
  const message = String(error?.message ?? error ?? "").toLowerCase();
  return (
    message.includes("gemini pre-tool candidate timeout") ||
    message.includes("429") ||
    message.includes("too many requests") ||
    message.includes("model_capacity_exhausted") ||
    message.includes("capacity") ||
    message.includes("rate limit") ||
    message.includes("rate_limit") ||
    message.includes("overloaded") ||
    message.includes("unavailable") ||
    message.includes("gaxios") ||
    message.includes("error when talking to gemini api") ||
    message.includes("gemini-client-error")
  );
}

function isClaudeCodeAccountBlockedError(error) {
  const message = String(error?.message ?? error ?? "").toLowerCase();
  return (
    message.includes("oauth refresh failed") ||
    message.includes("refresh token not found or invalid") ||
    message.includes("this account needs to be signed in again") ||
    message.includes("auth error")
  );
}

async function throwIfRenderedProviderCapacity(label) {
  const retryOrModelError = await execJS(js.retryOrModelError);
  if (retryOrModelError.transientCapacity) {
    throw new ProviderBlockedError(
      `${label} surfaced transient provider capacity in rendered UI: ${JSON.stringify(retryOrModelError)}`
    );
  }

  const state = await invokeE2E("inspectChatState").catch((error) => ({
    ok: false,
    error: String(error?.message ?? error),
  }));
  if (!state?.ok) return;
  const stateText = JSON.stringify({
    runtimeError: state.runtimeError,
    runtimeStatus: state.runtimeStatus,
    chatEventCount: state.chatEventCount,
    snapshotChatEventCount: state.snapshotChatEventCount,
  });
  if (isProviderAccountBlockedError(stateText)) {
    throw new ProviderBlockedError(
      `${label} surfaced provider/account auth blocker in chat state: ${stateText}`
    );
  }
  if (isGeminiTransientCapacityError(stateText)) {
    throw new ProviderBlockedError(
      `${label} surfaced transient provider capacity in chat state: ${stateText}`
    );
  }
}

function geminiModelFallbackConfigs(config) {
  if (!isGeminiConfig(config)) return [];
  const seen = new Set([config.model]);
  return GEMINI_MODEL_CHAIN.filter(
    (model) =>
      !seen.has(model) && (config.account.enabled_models ?? []).includes(model)
  ).map((model) => ({ ...config, model }));
}

function accountSummary(accounts, agentType) {
  return accounts
    .filter((row) => row.agent_type === agentType)
    .map((row) => ({
      id: row.id,
      name: row.name,
      enabled: row.enabled,
      auth_method: row.auth_method,
      has_api_key: row.has_api_key,
      has_session_token: row.has_session_token,
      can_use_native_harness: row.can_use_native_harness,
      native_harness_type: row.native_harness_type,
      enabled_models: row.enabled_models,
    }));
}

export async function getClaudeCodeAccount() {
  const accounts = await listAccounts();
  const account = accounts.find(
    (row) =>
      row.agent_type === CLAUDE_CODE_AGENT_TYPE &&
      row.auth_method === "oauth" &&
      row.enabled &&
      row.has_session_token &&
      (row.enabled_models ?? []).length > 0 &&
      matchesOptionalAccountName(row, CLAUDE_CODE_ACCOUNT_NAME)
  );
  if (!account) {
    throw new Error(
      `No enabled Claude Code OAuth account found. requested=${CLAUDE_CODE_ACCOUNT_NAME ?? "<any>"} rows=${JSON.stringify(accountSummary(accounts, CLAUDE_CODE_AGENT_TYPE))}`
    );
  }
  return account;
}

export async function getCursorNativeAccount() {
  const accounts = await listAccounts();
  const account = accounts.find(
    (row) =>
      row.agent_type === CURSOR_AGENT_TYPE &&
      row.enabled &&
      row.has_session_token &&
      (row.enabled_models ?? []).length > 0 &&
      matchesOptionalAccountName(row, CURSOR_NATIVE_ACCOUNT_NAME)
  );
  if (!account) {
    throw new Error(
      `No enabled Cursor native account with session token and enabled model found. requested=${CURSOR_NATIVE_ACCOUNT_NAME ?? "<any>"} rows=${JSON.stringify(accountSummary(accounts, CURSOR_AGENT_TYPE))}`
    );
  }
  return account;
}

export async function getCursorCliAccount() {
  const accounts = await listAccounts();
  const account = accounts.find(
    (row) =>
      row.agent_type === CURSOR_AGENT_TYPE &&
      row.enabled &&
      row.has_api_key &&
      (row.enabled_models ?? []).length > 0 &&
      matchesOptionalAccountName(row, CURSOR_CLI_ACCOUNT_NAME)
  );
  if (!account) {
    throw new Error(
      `No enabled Cursor CLI account with API key and enabled model found. requested=${CURSOR_CLI_ACCOUNT_NAME ?? "<any>"} rows=${JSON.stringify(accountSummary(accounts, CURSOR_AGENT_TYPE))}`
    );
  }
  return account;
}

export async function getCodexAccount() {
  const accounts = await listAccounts();
  const account = accounts.find(
    (row) =>
      row.agent_type === CODEX_AGENT_TYPE &&
      row.enabled &&
      row.auth_method === "oauth" &&
      row.has_session_token &&
      (row.enabled_models ?? []).length > 0 &&
      matchesOptionalAccountName(row, CODEX_ACCOUNT_NAME)
  );
  if (!account) {
    throw new Error(
      `No enabled Codex OAuth account found. requested=${CODEX_ACCOUNT_NAME ?? "<any>"} rows=${JSON.stringify(accountSummary(accounts, CODEX_AGENT_TYPE))}`
    );
  }
  return account;
}

export async function getGeminiAccount() {
  const accounts = await listAccounts();
  const account = accounts.find(
    (row) =>
      row.agent_type === GEMINI_AGENT_TYPE &&
      row.enabled &&
      row.auth_method === "oauth" &&
      row.has_session_token &&
      (row.enabled_models ?? []).length > 0 &&
      matchesOptionalAccountName(row, GEMINI_ACCOUNT_NAME)
  );
  if (!account) {
    throw new Error(
      `No enabled Gemini OAuth account found. requested=${GEMINI_ACCOUNT_NAME ?? "<any>"} rows=${JSON.stringify(accountSummary(accounts, GEMINI_AGENT_TYPE))}`
    );
  }
  return account;
}

export async function getApiAccount() {
  const accounts = await listAccounts();
  const account = accounts.find(
    (row) =>
      row.agent_type === API_AGENT_TYPE &&
      row.enabled &&
      row.has_api_key &&
      (row.enabled_models ?? []).length > 0 &&
      matchesOptionalAccountName(row, API_ACCOUNT_NAME)
  );
  if (!account) {
    throw new Error(
      `No enabled API account found. requested=${API_ACCOUNT_NAME ?? "<any>"} agentType=${API_AGENT_TYPE} rows=${JSON.stringify(accountSummary(accounts, API_AGENT_TYPE))}`
    );
  }
  return account;
}

async function configureCreator({
  account,
  model,
  category,
  cliAgentType,
  agentDefinitionId,
  nativeHarnessType,
}) {
  unwrap(
    await invokeE2E("navigateTo", "/orgii/workstation/code"),
    "navigateTo"
  );
  unwrap(await invokeE2E("resetToNewSession"), "resetToNewSession");
  const result = unwrap(
    await invokeE2E("configureWithExistingKey", {
      accountName: accountDisplayName(account),
      model,
      agentType: account.agent_type,
      category,
      cliAgentType,
      agentDefinitionId,
      nativeHarnessType,
      agentExecMode: "build",
      repoPath: E2E_REPO_PATH,
    }),
    `configureWithExistingKey(${category}:${account.agent_type})`
  );
  expect(result.modelId).toBe(model);
  await browser.pause(800);
  return result;
}

async function sendFromRenderedCreator(prompt) {
  const inputSelector = '[data-testid="chat-input"] [contenteditable="true"]';
  await browser.waitUntil(async () => execJS(js.exists(inputSelector)), {
    timeout: MOUNT_TIMEOUT_MS,
    timeoutMsg: `chat input (${inputSelector}) never mounted; dump=${JSON.stringify(await execJS(js.pageDump))}`,
  });

  const typeResult = await execJS(js.type(inputSelector, prompt));
  expect(typeResult).toBe("typed");
  await browser.pause(500);

  const editorText = await execJS(js.editorText(inputSelector));
  expect(editorText).toContain(prompt);

  await browser.waitUntil(
    async () => {
      const clickResult = await execJS(
        js.click('[data-testid="chat-send-button"]')
      );
      if (clickResult === "clicked") return true;
      const sendState = await execJS(js.sendState);
      console.log(
        `[tool-ui-matrix] send not ready: ${clickResult} ${JSON.stringify(sendState)}`
      );
      return false;
    },
    { timeout: 20_000, timeoutMsg: "chat-send-button never became clickable" }
  );

  await browser
    .waitUntil(async () => (await execJS(js.mode)) === "chat", {
      timeout: 45_000,
      timeoutMsg: "session never transitioned to chat view",
    })
    .catch(async (error) => {
      const state = await invokeE2E("inspectChatState").catch((stateError) => ({
        ok: false,
        error: String(stateError?.message ?? stateError),
      }));
      const stateText = JSON.stringify(state);
      if (isProviderAccountBlockedError(stateText)) {
        throw new ProviderBlockedError(
          `send did not transition because provider/account auth is blocked: ${stateText}`
        );
      }
      throw error;
    });
}

async function waitForRenderedToolAndReply({
  expectedNames,
  label,
  preToolTimeoutLabel = "tool block timeout",
  toolTimeoutMs = TOOL_TIMEOUT_MS,
}) {
  await browser
    .waitUntil(
      async () => {
        const blocks = await execJS(js.toolBlocks);
        if (blocks.some((block) => expectedNames.includes(block.name))) {
          return true;
        }
        await throwIfRenderedProviderCapacity(label);
        const retryOrModelError = await execJS(js.retryOrModelError);
        if (retryOrModelError.sendState?.state === "retry") {
          throw new Error(
            `${label} entered retry state before rendering an expected tool block: ${JSON.stringify(retryOrModelError)}`
          );
        }
        await execJS(js.scrollChatTo("top"));
        return false;
      },
      {
        timeout: toolTimeoutMs,
        timeoutMsg: `no expected tool block appeared in rendered chat UI: ${expectedNames.join(", ")}`,
      }
    )
    .catch(async (error) => {
      const dump = await execJS(js.pageDump).catch((dumpError) => ({
        dumpError: String(
          dumpError && dumpError.message ? dumpError.message : dumpError
        ),
      }));
      const state = await invokeE2E("inspectChatState").catch((stateError) => ({
        ok: false,
        error: String(
          stateError && stateError.message ? stateError.message : stateError
        ),
      }));
      throw new Error(
        `${label} ${preToolTimeoutLabel}: no expected tool block appeared in rendered chat UI: ${expectedNames.join(", ")}; dump=${JSON.stringify(dump)} state=${JSON.stringify(state)} cause=${String(
          error && error.message ? error.message : error
        )}`
      );
    });

  await execJS(js.scrollChatTo("bottom"));

  let replyAppeared = false;
  await browser
    .waitUntil(
      async () => {
        const retryOrModelError = await execJS(js.retryOrModelError);
        if (retryOrModelError.unsupportedModel) {
          throw new Error(
            `${label} surfaced an unsupported model error in rendered chat UI: ${JSON.stringify(retryOrModelError)}`
          );
        }
        await throwIfRenderedProviderCapacity(label);
        if (retryOrModelError.sendState?.state === "retry") {
          throw new Error(
            `${label} rendered tool block but entered retry before assistant reply: ${JSON.stringify(retryOrModelError)}`
          );
        }
        const latest = await execJS(js.latestAssistant);
        return latest.text.length > 0;
      },
      {
        timeout: REPLY_TIMEOUT_MS,
        interval: 5_000,
        timeoutMsg: "no assistant reply appeared in rendered chat UI",
      }
    )
    .then(() => {
      replyAppeared = true;
    })
    .catch(async (error) => {
      const active = await invokeE2E("getActiveSessionId").catch(
        (invokeError) => ({
          ok: false,
          error: String(
            invokeError && invokeError.message
              ? invokeError.message
              : invokeError
          ),
        })
      );
      const dump = await execJS(js.pageDump).catch((dumpError) => ({
        dumpError: String(
          dumpError && dumpError.message ? dumpError.message : dumpError
        ),
      }));
      throw new Error(
        `${label} rendered tool block but no assistant reply. active=${JSON.stringify(active)} dump=${JSON.stringify(dump)} cause=${String(
          error && error.message ? error.message : error
        )}`
      );
    });

  expect(replyAppeared).toBe(true);
  const retryOrModelError = await execJS(js.retryOrModelError);
  expect(retryOrModelError.unsupportedModel).toBe(false);
  expect(retryOrModelError.reconnecting).toBe(false);
  const active = unwrap(
    await invokeE2E("getActiveSessionId"),
    "getActiveSessionId"
  );
  const latest = await execJS(js.latestAssistant);
  const toolBlocks = await execJS(js.toolBlocks);
  if (!active.sessionId) {
    throw new Error(
      `No active session id after UI send: ${JSON.stringify(await execJS(js.pageDump))}`
    );
  }
  expect(latest.text.length).toBeGreaterThan(0);
  expect(toolBlocks.some((block) => expectedNames.includes(block.name))).toBe(
    true
  );
  return {
    sessionId: active.sessionId,
    assistantText: latest.text,
    toolBlocks,
  };
}

export async function runRenderedToolScenario(config, mochaContext) {
  if (!shouldRunMatrixLabel(config.label)) {
    mochaContext?.skip();
    return { status: "filtered" };
  }

  if (blockedAccountIds.has(config.account?.id)) {
    console.warn(
      `[tool-ui-provider-blocked] label=${config.label} account=${accountDisplayName(config.account)} skipped because the account was already classified blocked in this run`
    );
    mochaContext?.skip();
    return { status: "blocked" };
  }

  const configsToTry = [config, ...geminiModelFallbackConfigs(config)];
  let lastError = null;
  let providerBlockedCount = 0;

  for (const candidateConfig of configsToTry) {
    try {
      await configureCreator(candidateConfig);
      await sendFromRenderedCreator(candidateConfig.prompt);
      const result = await waitForRenderedToolAndReply({
        expectedNames: candidateConfig.expectedToolNames,
        label: candidateConfig.label,
        preToolTimeoutLabel: isGeminiConfig(candidateConfig)
          ? "gemini pre-tool candidate timeout"
          : "tool block timeout",
        toolTimeoutMs: isGeminiConfig(candidateConfig)
          ? GEMINI_PRE_TOOL_FALLBACK_TIMEOUT_MS
          : TOOL_TIMEOUT_MS,
      });
      console.log(
        `[tool-ui-matrix] ${candidateConfig.label} session=${result.sessionId} model=${candidateConfig.model} tools=${JSON.stringify(
          result.toolBlocks.map((block) => block.name)
        )} reply=${JSON.stringify(result.assistantText.slice(0, 500))}`
      );
      expect(result.sessionId).toMatch(candidateConfig.sessionIdPattern);
      return { status: "passed", ...result };
    } catch (error) {
      lastError = error;
      const geminiBlocked =
        isGeminiConfig(candidateConfig) &&
        isGeminiTransientCapacityError(error);
      const claudeCodeBlocked =
        isClaudeCodeConfig(candidateConfig) &&
        isClaudeCodeAccountBlockedError(error);
      const accountBlocked =
        error instanceof ProviderBlockedError ||
        isProviderAccountBlockedError(error);

      if (!geminiBlocked && !claudeCodeBlocked && !accountBlocked) {
        throw error;
      }

      providerBlockedCount += 1;
      if (!geminiBlocked && candidateConfig.account?.id) {
        blockedAccountIds.add(candidateConfig.account.id);
      }
      const blockerKind = geminiBlocked
        ? "gemini-capacity"
        : claudeCodeBlocked
          ? "claude-code-auth"
          : "provider-auth";
      console.warn(
        `[tool-ui-provider-blocked] label=${candidateConfig.label} kind=${blockerKind} model=${candidateConfig.model} account=${accountDisplayName(candidateConfig.account)} error=${String(error?.message ?? error).slice(0, 900)}`
      );
    }
  }

  if (providerBlockedCount === configsToTry.length) {
    console.warn(
      `[tool-ui-provider-blocked] label=${config.label} all ${configsToTry.length} candidate(s) blocked; provider/account blocker, not rendered UI failure. lastError=${String(lastError?.message ?? lastError).slice(0, 900)}`
    );
    mochaContext?.skip();
    return { status: "blocked" };
  }

  throw lastError;
}

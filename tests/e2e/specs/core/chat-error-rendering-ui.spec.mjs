/**
 * chat-error-rendering-ui.spec.mjs
 *
 * Terminal error visibility ledger.
 *
 * Regression spec for the "quota-exhausted call renders as blank space"
 * bug (2026-06-10): when a turn dies on a provider error (credit balance
 * exhausted / rate limited / stream retry budget exhausted), the
 * `functionName: "system"` failed event must render as a visible
 * AgentErrorChatItem card — in the live expanded view AND after the turn
 * is collapsed behind the "Agent worked for …" pin bar. Before the fix,
 * `useChatGroups` collapse kept only the last *completed assistant
 * message*; a turn whose tail was tool calls + error collapsed down to a
 * structural-only row and the error became invisible.
 *
 * Seeds transcript events through the real EventStore path (same
 * mechanism as chat-rendering-ui.spec.mjs) so the assertion exercises
 * the production pipeline: ingestion → chatItemPipeline → useChatGroups
 * collapse → ActivityRouter → AgentErrorChatItem.
 */

const MOUNT_TIMEOUT_MS = 60_000;
const RENDER_TIMEOUT_MS = 12_000;
const RUN_ID = Date.now();

const QUOTA_ERROR_TEXT =
  "LLM error: Rate limited: This request would exceed your account's rate limit. Please try again later. (retry after 3462s)";
const CREDIT_ERROR_TEXT =
  "LLM error: Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";

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
    Promise.resolve(window.__e2e[method].apply(null, rest))
      .then(cb)
      .catch((e) => cb({ ok: false, error: String(e && e.message || e) }));
  `,
    [method, ...args]
  );
}

async function waitForApp() {
  await browser.setWindowSize(2400, 1200).catch(() => undefined);
  await browser.waitUntil(
    async () => {
      try {
        return await execJS(
          `return !!document.querySelector('[data-testid="chat-panel"]');`
        );
      } catch {
        return false;
      }
    },
    { timeout: MOUNT_TIMEOUT_MS, timeoutMsg: "chat-panel never mounted" }
  );
  await browser.waitUntil(
    async () => {
      try {
        return await execJS(
          `return !!(window.__e2e && window.__e2e.seedChatEvents);`
        );
      } catch {
        return false;
      }
    },
    { timeout: 20_000, timeoutMsg: "window.__e2e.seedChatEvents never exposed" }
  );
}

// ── Event factories ─────────────────────────────────────────────

function makeUserEvent(sessionId, idSuffix, text, createdAt) {
  return {
    id: `user-${idSuffix}`,
    chunk_id: `user-${idSuffix}`,
    sessionId,
    createdAt,
    functionName: "user_message",
    uiCanonical: "user_message",
    actionType: "raw",
    args: {},
    result: { type: "user", message: text, is_delta: false },
    source: "user",
    displayText: text,
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "processed",
    isDelta: false,
  };
}

function makeToolEvent(sessionId, idSuffix, toolIndex, createdAt) {
  const sentinel = `ERR_LEDGER_TOOL_${idSuffix}_${toolIndex}`;
  return {
    id: `tool-${idSuffix}-${toolIndex}`,
    chunk_id: `tool-${idSuffix}-${toolIndex}`,
    sessionId,
    createdAt,
    functionName: "run_shell",
    uiCanonical: "run_shell",
    actionType: "tool_call",
    args: { command: `printf '${sentinel}'` },
    result: {
      success: true,
      status: "completed",
      is_delta: false,
      observation: sentinel,
      stdout: sentinel,
    },
    source: "assistant",
    displayText: sentinel,
    displayStatus: "completed",
    displayVariant: "tool_call",
    activityStatus: "agent",
    isDelta: false,
  };
}

/**
 * Mirrors the shape of both error producers:
 * - Rust `lifecycle::build_session_error_event` (session-error-… id)
 * - FE `makeErrorEvent` in eventFactories.ts (error-… id)
 */
function makeErrorEvent(sessionId, idSuffix, message, createdAt) {
  const id = `session-error-${sessionId}-${idSuffix}`;
  return {
    id,
    chunk_id: id,
    sessionId,
    createdAt,
    functionName: "system",
    uiCanonical: "",
    actionType: "assistant",
    args: { errorCode: "RATE_LIMITED", isRetryable: true },
    result: { observation: `Error: ${message}` },
    source: "assistant",
    displayText: `Error: ${message}`,
    displayStatus: "failed",
    displayVariant: "message",
    activityStatus: "agent",
    isDelta: false,
  };
}

function makeAssistantEvent(sessionId, idSuffix, text, createdAt) {
  return {
    id: `assistant-${idSuffix}`,
    chunk_id: `assistant-${idSuffix}`,
    sessionId,
    createdAt,
    functionName: "assistant_message",
    uiCanonical: "agent_message",
    actionType: "assistant",
    args: {},
    result: {
      content: text,
      observation: text,
      is_delta: false,
      role: "assistant",
    },
    source: "assistant",
    displayText: text,
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "agent",
    isDelta: false,
  };
}

// ── Assertions ──────────────────────────────────────────────────

async function chatBodyState(needle) {
  return execJS(`
    const needle = ${JSON.stringify(needle)};
    const history = document.querySelector('[data-testid="chat-message-list"]');
    const body = history ? (history.innerText || '') : (document.body.innerText || '');
    return {
      hasNeedle: body.includes(needle),
      flatCount: history ? history.getAttribute('data-flat-count') : null,
      bodyLength: body.length,
    };
  `);
}

async function waitForVisibleText(needle, label) {
  await browser.waitUntil(
    async () => {
      const state = await chatBodyState(needle);
      return state.hasNeedle;
    },
    {
      timeout: RENDER_TIMEOUT_MS,
      timeoutMsg: `${label}: expected visible text ${JSON.stringify(needle)} never rendered; state=${JSON.stringify(await chatBodyState(needle))}`,
    }
  );
}

describe("ORGII terminal error rendering", function () {
  this.timeout(300_000);

  before(async () => {
    await waitForApp();
  });

  it("renders a quota/rate-limit error card when the turn dies without an assistant reply", async function () {
    const sessionId = `e2e-error-render-${RUN_ID}-tail`;
    const base = Date.now();
    const events = [
      makeUserEvent(
        sessionId,
        `${RUN_ID}-tail`,
        "Do a long research task",
        new Date(base).toISOString()
      ),
      makeToolEvent(
        sessionId,
        `${RUN_ID}-tail`,
        0,
        new Date(base + 1_000).toISOString()
      ),
      makeToolEvent(
        sessionId,
        `${RUN_ID}-tail`,
        1,
        new Date(base + 2_000).toISOString()
      ),
      makeErrorEvent(
        sessionId,
        `${RUN_ID}-tail`,
        QUOTA_ERROR_TEXT,
        new Date(base + 3_000).toISOString()
      ),
    ];
    const seed = await invokeE2E("seedChatEvents", sessionId, events);
    if (!seed || seed.ok !== true) {
      throw new Error(`seedChatEvents failed: ${seed?.error ?? "unknown"}`);
    }

    // The error card body (sans the "Error: " prefix stripped by
    // AgentErrorChatItem) must be visible — NOT blank space.
    await waitForVisibleText(
      "exceed your account's rate limit",
      "tail-error-visible"
    );
  });

  it("keeps the error card visible after the turn is collapsed behind the pin bar", async function () {
    const sessionId = `e2e-error-render-${RUN_ID}-collapsed`;
    const base = Date.now();
    // Turn 1: user + tools + error, NO completed assistant reply.
    // Turn 2: ordinary user + assistant reply. Turn 1 becomes a non-tail
    // multi-item group → collapsed by default by useChatGroups.
    const events = [
      makeUserEvent(
        sessionId,
        `${RUN_ID}-c1`,
        "First request that will die on quota",
        new Date(base).toISOString()
      ),
      makeToolEvent(
        sessionId,
        `${RUN_ID}-c1`,
        0,
        new Date(base + 1_000).toISOString()
      ),
      makeToolEvent(
        sessionId,
        `${RUN_ID}-c1`,
        1,
        new Date(base + 2_000).toISOString()
      ),
      makeErrorEvent(
        sessionId,
        `${RUN_ID}-c1`,
        CREDIT_ERROR_TEXT,
        new Date(base + 3_000).toISOString()
      ),
      makeUserEvent(
        sessionId,
        `${RUN_ID}-c2`,
        "Second request after topping up",
        new Date(base + 60_000).toISOString()
      ),
      makeAssistantEvent(
        sessionId,
        `${RUN_ID}-c2`,
        "Second turn reply after recovery.",
        new Date(base + 61_000).toISOString()
      ),
    ];
    const seed = await invokeE2E("seedChatEvents", sessionId, events);
    if (!seed || seed.ok !== true) {
      throw new Error(`seedChatEvents failed: ${seed?.error ?? "unknown"}`);
    }

    // Second turn's reply renders (sanity that the list is live).
    await waitForVisibleText(
      "Second turn reply after recovery.",
      "collapsed-second-turn"
    );
    // Collapsed first turn must STILL surface its terminal error card.
    // Pre-fix behaviour: the collapse kept only the last completed
    // assistant message, so the credit error vanished into blank space.
    await waitForVisibleText(
      "credit balance is too low",
      "collapsed-error-visible"
    );
  });

  it("keeps both the final reply and a trailing error visible in a collapsed turn", async function () {
    const sessionId = `e2e-error-render-${RUN_ID}-replyerr`;
    const base = Date.now();
    // Turn 1: assistant narration BEFORE the error (the common real-world
    // shape: agent narrates progress, then a later LLM call dies).
    const events = [
      makeUserEvent(
        sessionId,
        `${RUN_ID}-r1`,
        "Investigate and fix the bug",
        new Date(base).toISOString()
      ),
      makeAssistantEvent(
        sessionId,
        `${RUN_ID}-r1`,
        "Found the root cause, preparing the fix.",
        new Date(base + 1_000).toISOString()
      ),
      makeToolEvent(
        sessionId,
        `${RUN_ID}-r1`,
        0,
        new Date(base + 2_000).toISOString()
      ),
      makeErrorEvent(
        sessionId,
        `${RUN_ID}-r1`,
        QUOTA_ERROR_TEXT,
        new Date(base + 3_000).toISOString()
      ),
      makeUserEvent(
        sessionId,
        `${RUN_ID}-r2`,
        "Continue please",
        new Date(base + 60_000).toISOString()
      ),
      makeAssistantEvent(
        sessionId,
        `${RUN_ID}-r2`,
        "Continuing after the rate limit cleared.",
        new Date(base + 61_000).toISOString()
      ),
    ];
    const seed = await invokeE2E("seedChatEvents", sessionId, events);
    if (!seed || seed.ok !== true) {
      throw new Error(`seedChatEvents failed: ${seed?.error ?? "unknown"}`);
    }

    await waitForVisibleText(
      "Continuing after the rate limit cleared.",
      "replyerr-second-turn"
    );
    // Collapsed turn keeps its final narration…
    await waitForVisibleText(
      "Found the root cause, preparing the fix.",
      "replyerr-final-reply"
    );
    // …AND the trailing terminal error card.
    await waitForVisibleText(
      "exceed your account's rate limit",
      "replyerr-error-visible"
    );
  });
});

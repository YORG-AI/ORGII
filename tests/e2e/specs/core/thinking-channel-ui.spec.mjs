/* global describe, before, it */
/**
 * thinking-channel-ui.spec.mjs
 *
 * Validates that reasoning/thinking is surfaced through the dedicated
 * thinking channel for *every* OpenAI-compatible reasoning flavor, not
 * just providers that already speak `reasoning_content`.
 *
 * Coverage matrix (one `it()` per row):
 *   - `vincetest1 / gpt-high` — relay inlines `<think>…</think>` into
 *     `delta.content`. Pre-fix this surfaced as `<think>…</think>` literally
 *     in the assistant bubble. Post-fix it routes through
 *     `ThinkTagSplitter` → reasoning channel → ThinkingEvent.
 *
 * Hard-fail assertions (these catch regression of the bug being fixed):
 *   - The assistant transcript has a row with `displayVariant === "thinking"`
 *     or `functionName === "thinking"` and non-empty `displayText`.
 *   - **No** row of any kind contains literal `<think>` or `</think>` in
 *     `displayText` — that string must never reach the UI in any channel.
 *   - The rendered DOM exposes a thinking surface (icon or "Thinking" /
 *     "Thought" label).
 *
 * Soft / informational:
 *   - Logs the thinking row length, assistant length, first 300 chars of each.
 *
 * Hooked into the same wdio harness as session-matrix-ui.spec.mjs. Skips
 * when E2E_OPENAI_ACCOUNT is missing.
 */
import {
  execJS,
  invokeE2E,
  unwrap,
} from "../../support/core/session/e2eBrowserHelpers.mjs";
import {
  PREFERRED_API_MODEL_ID,
  getApiAccount,
  selectPreferredModel,
  waitForApp,
} from "../../support/core/session/sessionMatrixDriver.mjs";

const MOUNT_TIMEOUT_MS = 60_000;
const REPLY_TIMEOUT_MS = Number.parseInt(
  process.env.E2E_REPLY_TIMEOUT_MS ?? "240000",
  10
);
const E2E_REPO_PATH = process.env.E2E_REPO_PATH;
// Thinking-capable model on vincetest1. Defaults to gpt-high (confirmed to
// return inline `<think>…</think>` SSE frames in the parent task). Override
// with E2E_THINKING_MODEL for any other reasoning model on the same relay.
const THINKING_MODEL = process.env.E2E_THINKING_MODEL ?? "gpt-high";
const LABEL = "vincetest1-inline-think";
const PROMPT_PREFIX = `ORGII_THINK_UI_${Date.now()}`;
// Reasoning-friendly prompt — every modern reasoning model produces a non-
// trivial trace for arithmetic-with-steps.
const PROMPT = `${PROMPT_PREFIX} Compute 17 × 23 step by step. Show your reasoning, then give the final number.`;

const js = {
  exists: (selector) =>
    `return !!document.querySelector(${JSON.stringify(selector)});`,
  type: (selector, text) => `
    const editor = document.querySelector(${JSON.stringify(selector)});
    if (!editor) return "missing";
    editor.focus();
    const ok = document.execCommand("insertText", false, ${JSON.stringify(text)});
    return ok ? "typed" : "insert-failed";
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
  mode: `
    const creator = document.querySelector(".session-creator-chat-panel");
    const history = document.querySelector('[data-testid="chat-message-list"]');
    return creator ? "creator" : history ? "chat" : "unknown";
  `,
  // Surface every place a thinking trace might land in the DOM so we have
  // a single source of truth for the rendered-thinking assertion. Looks at
  // i18n labels ("Thinking", "Thought") and the dedicated container class
  // used by ThinkingEvent / agent-message InlineThinkingBlock.
  thinkingSurface: `
    const body = document.body.innerText || "";
    const hasThinkingTextLabel = /thinking|thought/i.test(body);
    const thinkingNodes = Array.from(
      document.querySelectorAll(".activity-thinking, .activity-thinking__content")
    );
    const thinkingTexts = thinkingNodes
      .map((n) => (n.textContent || "").trim())
      .filter((t) => t.length > 0);
    return {
      hasThinkingTextLabel,
      thinkingNodeCount: thinkingNodes.length,
      thinkingTexts: thinkingTexts.slice(0, 3),
      // Hard-fail signal: if any rendered node contains a literal "<think>"
      // string, the splitter failed and reasoning is leaking onto the
      // visible content channel.
      bodyContainsRawThinkTag: /<think>|<\/think>/.test(body),
    };
  `,
};

async function ensureAuthBypass() {
  await execJS(`
    localStorage.setItem("orgii:auth_skipped", "1");
    localStorage.setItem("orgii:e2eBaseUrl", ${JSON.stringify(process.env.E2E_BASE_URL ?? "http://127.0.0.1:13847")});
    if (location.pathname.includes("login")) {
      location.reload();
    }
    return true;
  `).catch(() => undefined);
}

async function configureSession(account, model) {
  unwrap(
    await invokeE2E("navigateTo", "/orgii/workstation/code"),
    "navigateTo"
  );
  unwrap(await invokeE2E("resetToNewSession"), "resetToNewSession");
  const result = unwrap(
    await invokeE2E("configureWithExistingKey", {
      accountName: account.name || account.id,
      model,
      agentType: account.agent_type,
      category: "rust_agent",
      agentDefinitionId: "builtin:sde",
      agentExecMode: "build",
      repoPath: E2E_REPO_PATH,
    }),
    `configureWithExistingKey(${account.agent_type}:${model})`
  );
  expect(result.modelId).toBe(model);
  await browser.pause(800);
}

async function sendPrompt(prompt) {
  const inputSelector = '[data-testid="chat-input"] [contenteditable="true"]';
  await browser.waitUntil(async () => execJS(js.exists(inputSelector)), {
    timeout: MOUNT_TIMEOUT_MS,
    timeoutMsg: "chat input never mounted",
  });
  expect(await execJS(js.type(inputSelector, prompt))).toBe("typed");
  await browser.pause(400);
  await browser.waitUntil(
    async () =>
      (await execJS(js.click('[data-testid="chat-send-button"]'))) ===
      "clicked",
    { timeout: 20_000, timeoutMsg: "send button never became clickable" }
  );
  await browser.waitUntil(async () => (await execJS(js.mode)) === "chat", {
    timeout: 45_000,
    timeoutMsg: "session never transitioned to chat view",
  });
}

async function waitForTurnComplete() {
  // Wait until the send button is back to its idle "send" state — that
  // is the canonical signal that the assistant turn (including any
  // post-reasoning content) is finished.
  await browser.waitUntil(
    async () => {
      const send = await execJS(js.sendState);
      return send && send.state !== "stop" && send.disabled !== true;
    },
    {
      timeout: REPLY_TIMEOUT_MS,
      interval: 2_000,
      timeoutMsg: "assistant turn never returned to idle",
    }
  );
}

function findThinkingRow(rawEvents) {
  return rawEvents.find(
    (event) =>
      event.displayVariant === "thinking" ||
      event.functionName === "thinking" ||
      event.uiCanonical === "thinking"
  );
}

function findAssistantRows(rawEvents) {
  return rawEvents.filter(
    (event) =>
      event.source === "assistant" &&
      (event.functionName === "assistant_message" ||
        event.uiCanonical === "agent_message" ||
        event.displayVariant === "message")
  );
}

function rowsLeakingThinkTag(rawEvents) {
  return rawEvents.filter((event) => {
    const text = String(event.displayText ?? "");
    return text.includes("<think>") || text.includes("</think>");
  });
}

describe("Thinking channel rendering (provider-agnostic reasoning surface)", () => {
  let apiAccount;

  before(async () => {
    if (!process.env.E2E_OPENAI_ACCOUNT) {
      console.warn(
        "[thinking-channel-ui] E2E_OPENAI_ACCOUNT not set — skipping"
      );
      return;
    }
    await waitForApp();
    await ensureAuthBypass();
    apiAccount = await getApiAccount();
  });

  it("routes inline <think>...</think> reasoning to the thinking channel and never leaks tag text to any chat row", async function () {
    if (!process.env.E2E_OPENAI_ACCOUNT) {
      this.skip();
      return;
    }
    this.timeout(REPLY_TIMEOUT_MS + 120_000);

    const model = selectPreferredModel(apiAccount, THINKING_MODEL);
    if (!model) {
      throw new Error(
        `No model available on account ${apiAccount.name ?? apiAccount.id}; enabled=${JSON.stringify(apiAccount.enabled_models ?? [])}`
      );
    }
    if (model !== THINKING_MODEL) {
      console.warn(
        `[thinking-channel-ui] requested ${THINKING_MODEL} not enabled; falling back to ${model}. ` +
          `Override with E2E_THINKING_MODEL=<id>.`
      );
    }

    await configureSession(apiAccount, model);
    await sendPrompt(PROMPT);
    await waitForTurnComplete();

    const state = unwrap(
      await invokeE2E("inspectChatState"),
      "inspectChatState"
    );
    const rawEvents = state.rawEvents ?? [];

    // 1. Hard-fail: no chat row may carry a literal "<think>" tag.
    const leaks = rowsLeakingThinkTag(rawEvents);
    if (leaks.length > 0) {
      throw new Error(
        `[think-tag-leak] ${leaks.length} chat row(s) contain raw <think> markup. ` +
          `The Rust ThinkTagSplitter failed to demux this provider's reasoning. ` +
          `samples=${JSON.stringify(
            leaks.slice(0, 3).map((event) => ({
              id: event.id,
              functionName: event.functionName,
              displayVariant: event.displayVariant,
              text: String(event.displayText ?? "").slice(0, 240),
            }))
          )}`
      );
    }

    // 2. Hard-fail: assistant must have replied with the final answer.
    const assistantRows = findAssistantRows(rawEvents);
    expect(assistantRows.length).toBeGreaterThan(0);
    const assistantText = assistantRows
      .map((event) => String(event.displayText ?? ""))
      .join("\n");
    expect(assistantText.length).toBeGreaterThan(0);

    // 3. Hard-fail: a thinking row must exist with non-empty content.
    const thinkingRow = findThinkingRow(rawEvents);
    if (!thinkingRow) {
      throw new Error(
        `[no-thinking-row] No row with displayVariant/functionName="thinking" was created. ` +
          `This means the splitter did not route reasoning to the thinking channel. ` +
          `rawEventSummary=${JSON.stringify(
            rawEvents.slice(-10).map((event) => ({
              id: event.id,
              source: event.source,
              functionName: event.functionName,
              uiCanonical: event.uiCanonical,
              displayVariant: event.displayVariant,
              textLen: String(event.displayText ?? "").length,
            }))
          )}`
      );
    }
    expect(String(thinkingRow.displayText ?? "").length).toBeGreaterThan(0);

    // 4. Hard-fail: thinking row itself must not contain raw <think> markup.
    const thinkingText = String(thinkingRow.displayText ?? "");
    expect(thinkingText.includes("<think>")).toBe(false);
    expect(thinkingText.includes("</think>")).toBe(false);

    // 5. Rendered UI surface check — confirms the data actually reaches the
    //    visual layer, not just the state atom.
    const surface = await execJS(js.thinkingSurface);
    if (surface.bodyContainsRawThinkTag) {
      throw new Error(
        `[rendered-think-tag-leak] DOM body text contains literal "<think>" markup. ` +
          `Some renderer is still echoing raw tags to the user.`
      );
    }
    expect(surface.hasThinkingTextLabel || surface.thinkingNodeCount > 0).toBe(
      true
    );

    console.log(
      `[thinking-channel-ui] ${LABEL} model=${model} ` +
        `thinking_len=${thinkingText.length} ` +
        `assistant_len=${assistantText.length} ` +
        `surface=${JSON.stringify({
          hasLabel: surface.hasThinkingTextLabel,
          nodeCount: surface.thinkingNodeCount,
        })} ` +
        `thinking_preview=${JSON.stringify(thinkingText.slice(0, 200))} ` +
        `assistant_preview=${JSON.stringify(assistantText.slice(0, 200))}`
    );
  });
});

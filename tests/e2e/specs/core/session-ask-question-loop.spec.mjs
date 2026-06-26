/* global browser, expect */
/**
 * session-ask-question-loop.spec.mjs
 *
 * Regression coverage for issue #80 fix: the `ask_user_questions` tool no
 * longer carries a hardcoded 5-minute tool-side timeout. The wait policy is
 * now driven entirely by the per-session QuestionManager + presence policy
 * (Online → wait indefinitely, only Stop / an answer resolves it).
 *
 * This spec proves the POSITIVE question loop is intact after that change:
 *   1. A rust-native SDE session is told to call ask_user_questions.
 *   2. The question card renders and the tool blocks (AwaitingUser) instead
 *      of erroring out — i.e. the turn does NOT complete on its own.
 *   3. We answer via the debug endpoint POST /agent/test/sde/question/{id}.
 *   4. The agent receives the answer and the turn completes (send button
 *      returns to idle), proving the unblock path still works end-to-end.
 *
 * It does NOT try to prove "waits forever" directly — that is covered by the
 * Rust unit tests (Off → policy None; timeout → graceful auto-skip). WDIO's
 * bounded mocha timeout cannot observe an unbounded wait cheaply.
 */
import {
  configureScenario,
  execJS,
  filteredConfigs,
  inspectChatState,
  invokeE2E,
  js,
  listAccounts,
  rustAgentConfigs,
  scenarioConfigs,
  summarizeChatState,
  typeAndClickSend,
  unwrap,
  waitForApp,
  waitForChatInput,
  waitForChatLaunched,
} from "../../support/core/session/agentQueuedFollowupDriver.mjs";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:13847";
const ASK_TIMEOUT_MS = Number.parseInt(
  process.env.E2E_ASK_TIMEOUT_MS ?? "120000",
  10
);

const ASK_PROMPT = [
  "Before doing anything else, you MUST call the ask_user_questions tool",
  "exactly once to ask me which color I prefer.",
  "Provide a single question with header 'Color' and exactly two options:",
  "'Red' and 'Blue', each with a short description.",
  "Do not proceed or answer on your own — wait for my selection,",
  "then acknowledge the color I picked.",
].join(" ");

async function getActiveSessionId(label) {
  const active = unwrap(
    await invokeE2E("getActiveSessionId"),
    `${label}-getActiveSessionId`
  );
  if (!active.sessionId) {
    throw new Error(`${label} has no active session id`);
  }
  return active.sessionId;
}

/** Poll the debug endpoint until a pending ask_user_questions request exists. */
async function waitForPendingQuestion(sessionId, label) {
  let pending = null;
  await browser.waitUntil(
    async () => {
      const res = await fetch(
        `${BASE_URL}/agent/test/sde/question/${sessionId}`
      );
      if (!res.ok) return false;
      const body = await res.json();
      if (body.pending && (body.request_ids?.length ?? 0) > 0) {
        pending = body;
        return true;
      }
      return false;
    },
    {
      timeout: ASK_TIMEOUT_MS,
      interval: 1_000,
      timeoutMsg: `${label}: ask_user_questions never reached a pending state; state=${JSON.stringify(
        summarizeChatState(await inspectChatState(label))
      )}`,
    }
  );
  return pending;
}

/** Answer the first pending question with a single option label. */
async function answerQuestion(sessionId, requestId, optionLabel) {
  const res = await fetch(`${BASE_URL}/agent/test/sde/question/${sessionId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      request_id: requestId,
      answers: [[optionLabel]],
    }),
  });
  if (!res.ok) {
    throw new Error(`answer POST failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function waitForIdleSend(label) {
  await browser.waitUntil(
    async () => {
      const state = await execJS(js.sendState);
      return state && state.state === "submit" && !state.disabled;
    },
    {
      timeout: ASK_TIMEOUT_MS,
      interval: 1_000,
      timeoutMsg: `${label}: send button never returned to idle after answering; state=${JSON.stringify(
        summarizeChatState(await inspectChatState(label))
      )}`,
    }
  );
}

function hasAskQuestionToolEvent(state) {
  return (state.toolEvents ?? []).some(
    (event) => event.functionName === "ask_user_questions"
  );
}

describe("ORGII ask_user_questions loop (issue #80 timeout fix)", function () {
  let config;

  before(async () => {
    await waitForApp();
    const configs = filteredConfigs(scenarioConfigs(await listAccounts()));
    const rustConfigs = rustAgentConfigs(configs);
    config =
      rustConfigs.find((c) => c.label === "openai-api-rust-agent") ??
      rustConfigs[0];
    if (!config) {
      throw new Error(
        "No rust-native agent config available for ask-question loop spec"
      );
    }
  });

  it("renders the question card, blocks the turn, and resumes after the user answers", async function () {
    this.timeout(600_000);
    const label = `${config.label}-ask-loop`;

    await configureScenario(config);
    const inputSelector = await waitForChatInput();
    await typeAndClickSend(inputSelector, ASK_PROMPT);
    await waitForChatLaunched(ASK_PROMPT);

    const sessionId = await getActiveSessionId(label);

    // 1. The tool must block on a pending question (proves it waits rather
    //    than erroring out / completing on its own).
    const pending = await waitForPendingQuestion(sessionId, label);
    const requestId = pending.request_ids[0];

    // The question card / tool event must be visible in the rendered state.
    const blockedState = await inspectChatState(`${label}-blocked`);
    expect(hasAskQuestionToolEvent(blockedState)).toBe(true);

    // While blocked, the turn must NOT be idle — the agent is awaiting input.
    const blockedSend = await execJS(js.sendState);
    expect(blockedSend?.state).not.toBe("submit");

    // 2. Answer through the debug endpoint (mirrors the FE answer path).
    await answerQuestion(sessionId, requestId, "Blue");

    // 3. The question must clear and the turn must complete.
    await browser.waitUntil(
      async () => {
        const res = await fetch(
          `${BASE_URL}/agent/test/sde/question/${sessionId}`
        );
        if (!res.ok) return false;
        const body = await res.json();
        return body.pending === false;
      },
      {
        timeout: ASK_TIMEOUT_MS,
        interval: 1_000,
        timeoutMsg: `${label}: question never cleared after answering`,
      }
    );

    await waitForIdleSend(label);

    // 4. The agent acknowledged the answer (no hard Timeout error surfaced).
    const finalState = await inspectChatState(`${label}-final`);
    expect(finalState.runtimeError).toBeFalsy();
    const bodyText = String(await execJS(js.bodyText)).toLowerCase();
    expect(bodyText.includes("blue")).toBe(true);
  });
});


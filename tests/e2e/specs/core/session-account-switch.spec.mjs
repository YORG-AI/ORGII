/* global describe, before, it, expect */
import { execFileSync } from "node:child_process";

import {
  CLAUDE_CODE_AGENT_TYPE,
  CODEX_AGENT_TYPE,
  CODEX_FOLLOWUP_ACCOUNT_NAME,
  CODEX_FOLLOWUP_EXPECTED_TEXT,
  CODEX_INITIAL_ACCOUNT_NAME,
  CODEX_INITIAL_EXPECTED_TEXT,
  CODEX_MODEL_ID,
  CURSOR_AGENT_TYPE,
  CURSOR_FOLLOWUP_ACCOUNT_NAME,
  CURSOR_INITIAL_ACCOUNT_NAME,
  CURSOR_MODEL_ID,
  CURSOR_NATIVE_HARNESS_TYPE,
  CURSOR_NATIVE_MODEL_ID,
  FOLLOWUP_EXPECTED_TEXT,
  GEMINI_MODEL_CHAIN,
  INITIAL_EXPECTED_TEXT,
  MODEL_ID,
  assertKnownRequestedScenarios,
  ensureFixtureRepoSelected,
  findClaudeCodeAccountPair,
  findCliAccountPair,
  findCursorNativeAccountPair,
  findGeminiAccountPair,
  invokeE2E,
  isGeminiTransientCapacityResponse,
  logScenarioScope,
  runRenderedAccountSwitch,
  runRenderedMidStreamAccountSwitch,
  sendFromRenderedComposer,
  sharedModelsFromChain,
  shouldRunScenario,
  skipCursorProviderBlockedIfApplicable,
  skipOrFailMissingCoverage,
  switchAccountThroughRenderedPicker,
  switchRuntimeThroughRenderedPicker,
  unwrap,
  waitForApp,
  waitForComposerIdle,
} from "../../support/core/session/accountSwitchDriver.mjs";

describe("Claude Code CLI multi-account switching", () => {
  before(() => {
    assertKnownRequestedScenarios();
  });

  it("uses one Claude Code account first and switches follow-up to another", async function () {
    const scenarioName = "claude-code-cli";
    if (!shouldRunScenario(scenarioName)) {
      this.skip();
      return;
    }
    logScenarioScope(scenarioName);
    await waitForApp();

    const accounts = unwrap(
      await invokeE2E("listAccounts"),
      "listAccounts"
    ).accounts;
    const accountPair = findClaudeCodeAccountPair(accounts);
    if (!accountPair) {
      skipOrFailMissingCoverage(
        this,
        scenarioName,
        `[claude-code-account-switch] fewer than two enabled Claude Code OAuth accounts with ${MODEL_ID}`
      );
      return;
    }
    const [initialAccount, followupAccount] = accountPair;
    expect(initialAccount.id).not.toBe(followupAccount.id);

    const repo = await ensureFixtureRepoSelected();

    await runRenderedAccountSwitch({
      label: "claude-code-account-switch",
      initialAccount,
      followupAccount,
      model: MODEL_ID,
      category: "cli_agent",
      cliAgentType: CLAUDE_CODE_AGENT_TYPE,
      repoPath: repo.path,
      initialExpectedText: INITIAL_EXPECTED_TEXT,
      followupExpectedText: FOLLOWUP_EXPECTED_TEXT,
    });
  });

  it("keeps Codex CLI account profiles isolated while switching accounts", async function () {
    const scenarioName = "codex-cli";
    if (!shouldRunScenario(scenarioName)) {
      this.skip();
      return;
    }
    logScenarioScope(scenarioName);
    await waitForApp();

    const accounts = unwrap(
      await invokeE2E("listAccounts"),
      "listAccounts"
    ).accounts;
    const accountPair = findCliAccountPair(
      accounts,
      CODEX_AGENT_TYPE,
      CODEX_INITIAL_ACCOUNT_NAME,
      CODEX_FOLLOWUP_ACCOUNT_NAME,
      CODEX_MODEL_ID
    );
    if (!accountPair) {
      skipOrFailMissingCoverage(
        this,
        scenarioName,
        `[codex-account-switch] fewer than two enabled Codex OAuth accounts with ${CODEX_MODEL_ID}`
      );
      return;
    }
    const [initialAccount, followupAccount] = accountPair;
    expect(initialAccount.id).not.toBe(followupAccount.id);

    const repo = await ensureFixtureRepoSelected();

    await runRenderedAccountSwitch({
      label: "codex-account-switch",
      initialAccount,
      followupAccount,
      model: CODEX_MODEL_ID,
      category: "cli_agent",
      cliAgentType: CODEX_AGENT_TYPE,
      repoPath: repo.path,
      initialExpectedText: CODEX_INITIAL_EXPECTED_TEXT,
      followupExpectedText: CODEX_FOLLOWUP_EXPECTED_TEXT,
    });
  });

  it("switches Cursor CLI follow-up to another account profile", async function () {
    const scenarioName = "cursor-cli";
    if (!shouldRunScenario(scenarioName)) {
      this.skip();
      return;
    }
    logScenarioScope(scenarioName);
    await waitForApp();

    const accounts = unwrap(
      await invokeE2E("listAccounts"),
      "listAccounts"
    ).accounts;
    const accountPair = findCliAccountPair(
      accounts,
      CURSOR_AGENT_TYPE,
      CURSOR_INITIAL_ACCOUNT_NAME,
      CURSOR_FOLLOWUP_ACCOUNT_NAME,
      CURSOR_MODEL_ID,
      {
        requireOAuth: false,
        requireApiKey: true,
        requireSessionToken: false,
      }
    );
    if (!accountPair) {
      skipOrFailMissingCoverage(
        this,
        scenarioName,
        `[cursor-account-switch] fewer than two enabled Cursor accounts with ${CURSOR_MODEL_ID}`
      );
      return;
    }
    const [initialAccount, followupAccount] = accountPair;
    expect(initialAccount.id).not.toBe(followupAccount.id);

    const repo = await ensureFixtureRepoSelected();

    try {
      await runRenderedAccountSwitch({
        label: "cursor-account-switch",
        initialAccount,
        followupAccount,
        model: CURSOR_MODEL_ID,
        category: "cli_agent",
        cliAgentType: CURSOR_AGENT_TYPE,
        repoPath: repo.path,
        initialExpectedText: "CURSOR_CLI_SWITCH_INITIAL_OK",
        followupExpectedText: "CURSOR_CLI_SWITCH_FOLLOWUP_OK",
      });
    } catch (error) {
      if (
        await skipCursorProviderBlockedIfApplicable(this, scenarioName, error)
      ) {
        return;
      }
      throw error;
    }
  });

  it("switches Cursor Rust-native follow-up to another native account", async function () {
    const scenarioName = "cursor-rust";
    if (!shouldRunScenario(scenarioName)) {
      this.skip();
      return;
    }
    logScenarioScope(scenarioName);
    await waitForApp();

    const accounts = unwrap(
      await invokeE2E("listAccounts"),
      "listAccounts"
    ).accounts;
    const accountPair = findCursorNativeAccountPair(accounts);
    if (!accountPair) {
      skipOrFailMissingCoverage(
        this,
        scenarioName,
        `[cursor-rust-account-switch] fewer than two enabled Rust-capable Cursor native accounts with ${CURSOR_NATIVE_MODEL_ID}`
      );
      return;
    }
    const [initialAccount, followupAccount] = accountPair;
    expect(initialAccount.id).not.toBe(followupAccount.id);

    const repo = await ensureFixtureRepoSelected();

    try {
      await runRenderedAccountSwitch({
        label: "cursor-rust-account-switch",
        initialAccount,
        followupAccount,
        model: CURSOR_NATIVE_MODEL_ID,
        category: "rust_agent",
        agentDefinitionId: "builtin:sde",
        nativeHarnessType: CURSOR_NATIVE_HARNESS_TYPE,
        repoPath: repo.path,
        initialExpectedText: "ORGII_CURSOR_RUST_SWITCH_INITIAL_READY",
        followupExpectedText: "ORGII_CURSOR_RUST_SWITCH_FOLLOWUP_READY",
        reverseExpectedText: "ORGII_CURSOR_RUST_SWITCH_REVERSE_READY",
      });
    } catch (error) {
      if (
        await skipCursorProviderBlockedIfApplicable(this, scenarioName, error)
      ) {
        return;
      }
      throw error;
    }
  });

  it("switches Claude Code Rust-native follow-up to another account", async function () {
    const scenarioName = "claude-code-rust";
    if (!shouldRunScenario(scenarioName)) {
      this.skip();
      return;
    }
    logScenarioScope(scenarioName);
    await waitForApp();

    const accounts = unwrap(
      await invokeE2E("listAccounts"),
      "listAccounts"
    ).accounts;
    const accountPair = findClaudeCodeAccountPair(accounts, {
      requireRustAgentSupport: true,
    });
    if (!accountPair) {
      skipOrFailMissingCoverage(
        this,
        scenarioName,
        `[claude-code-rust-account-switch] fewer than two enabled Rust-capable Claude Code OAuth accounts with ${MODEL_ID}`
      );
      return;
    }
    const [initialAccount, followupAccount] = accountPair;
    expect(initialAccount.id).not.toBe(followupAccount.id);

    const repo = await ensureFixtureRepoSelected();

    await runRenderedAccountSwitch({
      label: "claude-code-rust-account-switch",
      initialAccount,
      followupAccount,
      model: MODEL_ID,
      category: "rust_agent",
      agentDefinitionId: "builtin:sde",
      repoPath: repo.path,
      initialExpectedText: "ORGII_CC_RUST_SWITCH_INITIAL_READY",
      followupExpectedText: "ORGII_CC_RUST_SWITCH_FOLLOWUP_READY",
      reverseExpectedText: "ORGII_CC_RUST_SWITCH_REVERSE_READY",
    });
  });

  it("switches Claude Code Rust-native account WHILE a turn is streaming (行进中)", async function () {
    const scenarioName = "claude-code-rust-midstream";
    if (!shouldRunScenario(scenarioName)) {
      this.skip();
      return;
    }
    logScenarioScope(scenarioName);
    await waitForApp();

    const accounts = unwrap(
      await invokeE2E("listAccounts"),
      "listAccounts"
    ).accounts;
    const accountPair = findClaudeCodeAccountPair(accounts, {
      requireRustAgentSupport: true,
    });
    if (!accountPair) {
      skipOrFailMissingCoverage(
        this,
        scenarioName,
        `[claude-code-rust-midstream] fewer than two enabled Rust-capable Claude Code OAuth accounts with ${MODEL_ID}`
      );
      return;
    }
    const [initialAccount, followupAccount] = accountPair;
    expect(initialAccount.id).not.toBe(followupAccount.id);

    const repo = await ensureFixtureRepoSelected();

    await runRenderedMidStreamAccountSwitch({
      label: "claude-code-rust-midstream-switch",
      initialAccount,
      followupAccount,
      model: MODEL_ID,
      category: "rust_agent",
      agentDefinitionId: "builtin:sde",
      repoPath: repo.path,
      initialExpectedText: "ORGII_CC_RUST_MIDSTREAM_STREAM_DONE",
      followupExpectedText: "ORGII_CC_RUST_MIDSTREAM_FOLLOWUP_READY",
    });
  });

  it("switches Gemini API Rust-agent follow-up to another account with model-chain fallback", async function () {
    const scenarioName = "gemini-rust";
    if (!shouldRunScenario(scenarioName)) {
      this.skip();
      return;
    }
    logScenarioScope(scenarioName);
    await waitForApp();

    const accounts = unwrap(
      await invokeE2E("listAccounts"),
      "listAccounts"
    ).accounts;
    const accountPair = findGeminiAccountPair(accounts);
    if (!accountPair) {
      skipOrFailMissingCoverage(
        this,
        scenarioName,
        `[gemini-account-switch] fewer than two enabled Gemini API accounts for E2E_GEMINI_MODEL_CHAIN=${JSON.stringify(GEMINI_MODEL_CHAIN)}`
      );
      return;
    }
    const [initialAccount, followupAccount] = accountPair;
    expect(initialAccount.id).not.toBe(followupAccount.id);
    const geminiModels = sharedModelsFromChain(
      initialAccount,
      followupAccount,
      GEMINI_MODEL_CHAIN
    );
    if (geminiModels.length === 0) {
      throw new Error(
        `No shared Gemini model from chain ${JSON.stringify(GEMINI_MODEL_CHAIN)} is enabled for accounts ${initialAccount.name ?? initialAccount.id} and ${followupAccount.name ?? followupAccount.id}`
      );
    }

    const repo = await ensureFixtureRepoSelected();

    let geminiModel = null;
    for (const candidateModel of geminiModels) {
      try {
        await runRenderedAccountSwitch({
          label: `gemini-rust-account-switch-${candidateModel}`,
          initialAccount,
          followupAccount,
          model: candidateModel,
          category: "rust_agent",
          agentDefinitionId: "builtin:sde",
          repoPath: repo.path,
          initialExpectedText: "ORGII_GEMINI_RUST_SWITCH_INITIAL_READY",
          followupExpectedText: "ORGII_GEMINI_RUST_SWITCH_FOLLOWUP_READY",
          reverseExpectedText: "ORGII_GEMINI_RUST_SWITCH_REVERSE_READY",
        });
        geminiModel = candidateModel;
        break;
      } catch (error) {
        if (!isGeminiTransientCapacityResponse(error)) {
          throw error;
        }
        console.warn(
          `[gemini-rust-account-switch-chain] model=${candidateModel} hit transient capacity/rate-limit error; trying next fallback. error=${String(error?.message ?? error).slice(0, 700)}`
        );
      }
    }

    if (!geminiModel) {
      throw new Error(
        `gemini-rust-account-switch exhausted E2E_GEMINI_MODEL_CHAIN=${JSON.stringify(geminiModels)}`
      );
    }
  });
});

const nativeLiveIt =
  process.env.E2E_NATIVE_CONTINUATION_LIVE === "1" ? it : it.skip;
const nativeAppLiveIt =
  process.env.E2E_NATIVE_APP_UI_LIVE === "1" ? it : it.skip;

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for live native coverage`);
  return value;
}

function liveCliAccount(accounts, type, model, requested) {
  return accounts.find(
    (row) =>
      row.agent_type === type &&
      row.enabled &&
      row.health_status !== "invalid" &&
      (row.enabled_models ?? []).includes(model) &&
      (!requested || row.id === requested || row.name === requested)
  );
}

const NATIVE_LARGE_MIN_EVENTS_FLOOR = 40;
const NATIVE_ASSISTANT_PLACEHOLDER_TEXT = "AI Processing...";
const NATIVE_TOOL_RESULT_TEXT_KEYS = [
  "output",
  "observation",
  "content",
  "stdout",
  "text",
  "message",
  "summary",
];
const NATIVE_UNFINISHED_RESULT_STATUS = new Set([
  "running",
  "pending",
  "in_progress",
  "awaiting_user",
]);

function nativeLargeMinimumEvents() {
  const configured = process.env.E2E_NATIVE_LARGE_MIN_EVENTS?.trim();
  if (!configured) return NATIVE_LARGE_MIN_EVENTS_FLOOR;
  const parsed = Number.parseInt(configured, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(
      `E2E_NATIVE_LARGE_MIN_EVENTS=${JSON.stringify(configured)} is not an integer`
    );
  }
  if (parsed < NATIVE_LARGE_MIN_EVENTS_FLOOR) {
    throw new Error(
      `E2E_NATIVE_LARGE_MIN_EVENTS=${parsed} is below this acceptance's floor of ${NATIVE_LARGE_MIN_EVENTS_FLOOR}. ` +
        `This test exists to prove large provider-native histories survive a cross-runtime round trip, so the operator must supply a session that genuinely projects at least ${NATIVE_LARGE_MIN_EVENTS_FLOOR} events instead of lowering the bar.`
    );
  }
  return parsed;
}

function collectStrings(value, sink) {
  if (typeof value === "string") {
    sink.push(value);
    return sink;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, sink);
    return sink;
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) collectStrings(entry, sink);
    return sink;
  }
  return sink;
}

function anchorText(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  return Array.from(trimmed).slice(0, 80).join("").trimEnd();
}

function actionTypeHistogram(events) {
  const counts = {};
  for (const event of events) {
    const key = String(event?.actionType ?? "unknown");
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return JSON.stringify(counts);
}

function toolResultText(event) {
  const result = event?.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return "";
  for (const key of NATIVE_TOOL_RESULT_TEXT_KEYS) {
    const value = result[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  const status =
    typeof event.resultStatus === "string" ? event.resultStatus.trim() : "";
  const nested = collectStrings(result, []).find(
    (entry) => entry.trim().length >= 8 && entry.trim() !== status
  );
  return nested ?? "";
}

function isCompletedToolCall(event) {
  if (
    event?.actionType !== "tool_call" &&
    event?.actionType !== "tool_result"
  ) {
    return false;
  }
  const status =
    typeof event.resultStatus === "string"
      ? event.resultStatus.trim().toLowerCase()
      : "";
  if (status && NATIVE_UNFINISHED_RESULT_STATUS.has(status)) return false;
  return toolResultText(event).trim().length > 0;
}

async function openLargeSession(sessionId, label) {
  unwrap(await invokeE2E("openSession", sessionId), `${label} open`);
  const state = unwrap(await invokeE2E("inspectChatState"), `${label} inspect`);
  const rawEvents = state.rawEvents ?? [];
  const chatEvents = state.chatEvents ?? [];
  const minimum = nativeLargeMinimumEvents();
  const shape = `raw=${rawEvents.length} chat=${chatEvents.length} actionTypes=${actionTypeHistogram(rawEvents)}`;
  if (rawEvents.length < minimum) {
    throw new Error(
      `${label}: session ${sessionId} projects only ${rawEvents.length} events (${shape}), below the ${minimum}-event bar. ` +
        `Supply a session id that genuinely projects at least ${minimum} events; lowering E2E_NATIVE_LARGE_MIN_EVENTS is not an accepted remedy.`
    );
  }
  const anchor = (events, predicate, extract, kind, remedy) => {
    for (const event of events) {
      if (!predicate(event)) continue;
      const text = anchorText(extract(event));
      if (text) return text;
    }
    throw new Error(
      `${label}: session ${sessionId} has no ${kind} anchor (${shape}). ${remedy}`
    );
  };
  return [
    anchor(
      rawEvents,
      (event) => event.source === "user",
      (event) => event.displayText,
      "user turn",
      "A source=user event carrying display text is required; image-only user turns do not qualify."
    ),
    anchor(
      chatEvents,
      (event) =>
        event.source === "assistant" &&
        event.displayVariant === "message" &&
        event.displayText !== NATIVE_ASSISTANT_PLACEHOLDER_TEXT,
      (event) => event.displayText,
      "assistant message",
      "A chat event with source=assistant and displayVariant=message is required."
    ),
    anchor(
      rawEvents,
      isCompletedToolCall,
      (event) => toolResultText(event),
      "completed tool call with result",
      "A raw event with actionType=tool_call/tool_result, a non-running resultStatus and non-empty result text is required. " +
        "If the projection drops this provider's tool calls entirely, that is the defect under test - fix the projection, do not retarget or skip this anchor."
    ),
  ];
}

async function continueWith(target, marker, label) {
  await switchRuntimeThroughRenderedPicker(target.type, label);
  await switchAccountThroughRenderedPicker(target.account, target.model, label);
  await sendFromRenderedComposer(
    `Reply with exactly ${marker} and no other words.`,
    label
  );
  await waitForComposerIdle(label, marker);
  return unwrap(await invokeE2E("inspectChatState"), `${label} final state`);
}

function assertHistory(state, expected, label) {
  const transcript = collectStrings(state.rawEvents ?? [], []);
  collectStrings(state.chatEvents ?? [], transcript);
  for (const text of expected) {
    if (!transcript.some((entry) => entry.includes(text))) {
      throw new Error(
        `${label} lost canonical history ${JSON.stringify(text)}`
      );
    }
  }
}

describe("provider-native continuation acceptance (live, opt-in)", () => {
  nativeLiveIt(
    "round-trips large Codex/Claude histories in both directions",
    async function () {
      this.timeout(1_200_000);
      await waitForApp();
      const accounts = unwrap(
        await invokeE2E("listAccounts"),
        "native listAccounts"
      ).accounts;
      const claudeModel =
        process.env.E2E_CLAUDE_CODE_MODEL ?? "claude-sonnet-4-6";
      const codexModel = process.env.E2E_CODEX_MODEL ?? "gpt-5.5";
      const claude = liveCliAccount(
        accounts,
        CLAUDE_CODE_AGENT_TYPE,
        claudeModel,
        process.env.E2E_CLAUDE_CODE_ACCOUNT
      );
      const codex = liveCliAccount(
        accounts,
        CODEX_AGENT_TYPE,
        codexModel,
        process.env.E2E_CODEX_ACCOUNT
      );
      if (!claude || !codex)
        throw new Error("live Codex/Claude account missing");
      const targets = {
        claude: {
          account: claude,
          model: claudeModel,
          type: CLAUDE_CODE_AGENT_TYPE,
        },
        codex: { account: codex, model: codexModel, type: CODEX_AGENT_TYPE },
      };

      const scenarios = [
        {
          source: requiredEnv("E2E_NATIVE_LARGE_CODEX_SESSION_ID"),
          label: "Codex-Claude-Codex",
          first: targets.claude,
          second: targets.codex,
        },
        {
          source: requiredEnv("E2E_NATIVE_LARGE_CLAUDE_SESSION_ID"),
          label: "Claude-Codex-Claude",
          first: targets.codex,
          second: targets.claude,
        },
      ];
      const prepared = [];
      const unusable = [];
      for (const scenario of scenarios) {
        try {
          prepared.push({
            scenario,
            anchors: await openLargeSession(scenario.source, scenario.label),
          });
        } catch (error) {
          unusable.push(String(error?.message ?? error));
        }
      }
      if (unusable.length > 0) {
        throw new Error(
          `provider-native continuation acceptance has no usable input:\n${unusable.join("\n")}`
        );
      }

      for (const { scenario, anchors } of prepared) {
        unwrap(
          await invokeE2E("openSession", scenario.source),
          `${scenario.label} reopen`
        );
        const firstMarker = `NATIVE_FIRST_${Date.now()}`;
        const first = await continueWith(
          scenario.first,
          firstMarker,
          `${scenario.label} first`
        );
        assertHistory(first, anchors, `${scenario.label} first`);
        const second = await continueWith(
          scenario.second,
          `NATIVE_RETURN_${Date.now()}`,
          `${scenario.label} return`
        );
        assertHistory(
          second,
          [...anchors, firstMarker],
          `${scenario.label} return`
        );
      }
    }
  );
});

function nativeProcessWindows(processName) {
  const script = `tell application "System Events"
    set matches to every application process whose name contains "${processName}"
    if (count of matches) is 0 then return ""
    set target to item 1 of matches
    if (count of windows of target) is 0 then return (name of target)
    set uiText to ""
    repeat with uiElement in entire contents of front window of target
      try
        if role of uiElement is "AXStaticText" then
          set uiText to uiText & linefeed & (value of uiElement as text)
        end if
      end try
    end repeat
    return (name of target) & linefeed & ((name of every window of target) as text) & uiText
  end tell`;
  return execFileSync("osascript", ["-e", script], { encoding: "utf8" });
}

describe("native App catalog visibility (live, ignored by default)", () => {
  nativeAppLiveIt(
    "opens cataloged UUID/title/cwd rows in both native Apps",
    async function () {
      this.timeout(240_000);
      if (process.platform !== "darwin") throw new Error("macOS only");
      await waitForApp();
      for (const target of [
        { prefix: "CODEX", process: "Codex" },
        { prefix: "CLAUDE", process: "Claude" },
      ]) {
        const sessionId = requiredEnv(
          `E2E_NATIVE_${target.prefix}_APP_SESSION_ID`
        );
        const uuid = requiredEnv(`E2E_NATIVE_${target.prefix}_APP_UUID`);
        const title = requiredEnv(`E2E_NATIVE_${target.prefix}_APP_TITLE`);
        const cwd = requiredEnv(`E2E_NATIVE_${target.prefix}_APP_CWD`);
        unwrap(
          await invokeE2E("openSession", sessionId),
          `${target.process} open`
        );
        const state = unwrap(
          await invokeE2E("inspectChatState"),
          `${target.process} catalog`
        );
        expect(sessionId).toContain(uuid);
        expect(state.activeSession?.name ?? "").toContain(title);
        expect(state.activeSession?.repoPath).toBe(cwd);
        await (
          await browser.$('[data-testid="chat-panel-header-more-button"]')
        ).click();
        const open = await browser.$(
          '[data-testid="session-open-in-app-menu-item"]'
        );
        await open.waitForExist({ timeout: 30_000 });
        await open.click();
        await browser.pause(3_000);
        const nativeUi = nativeProcessWindows(target.process);
        expect(nativeUi).toContain(title);
        expect(nativeUi).toContain(cwd.split("/").filter(Boolean).at(-1));
      }
    }
  );
});

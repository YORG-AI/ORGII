/* global describe, before, it, expect */
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
  sharedModelsFromChain,
  shouldRunScenario,
  skipCursorProviderBlockedIfApplicable,
  skipOrFailMissingCoverage,
  unwrap,
  waitForApp,
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

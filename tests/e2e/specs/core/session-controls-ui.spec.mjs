import {
  assertNoDuplicateTranscriptMessages,
  inspectChatState,
  isClaudeCodeConfig,
  isClaudeCodeTransientAuthError,
  isGeminiConfig,
  isGeminiTransientCapacityError,
  isProviderAccountBlockedError,
  isProviderNondeterministicMarkerError,
} from "../../support/core/session/agentQueuedFollowupDriver.mjs";
import {
  CONTROL_LABEL_FILTER,
  assertKnownControlScenarios,
  assertUniqueConfigLabels,
  filteredConfigs,
  listAccounts,
  runAskForceSendScenario,
  runAskWriteDeniedScenario,
  runBurstQueueSendNowOrderingScenario,
  runChaosControlFlowScenario,
  runForceSendScenario,
  runForceSendWhileShellRunningScenario,
  runFreshStopImageRestoreScenario,
  runFreshStopRollbackScenario,
  runIntermediateStreamingScenario,
  runPlanBuildDirectScenario,
  runPlanEditResendScenario,
  runPlanStopScenario,
  runPlanUpdateSupersedesScenario,
  runPlanWriteBeforeBuildDeniedScenario,
  runQueueAutodispatchesAfterNaturalCompletionScenario,
  runQueueDoesNotAutoflushWhileActiveScenario,
  runQueueEditImageUploadScenario,
  runRestoreCheckpointScenario,
  runRewindScenario,
  runSendAfterIdleDoesNotQueueScenario,
  runStopDoubleClickDoesNotResubmitScenario,
  runStopRestoresInFlightScenario,
  runStopWithBackgroundSubagentNextMessageScenario,
  rustAgentConfigs,
  scenarioConfigs,
  shouldRunScenario,
  waitForApp,
} from "../../support/core/session/agentQueuedFollowupScenarios.mjs";
import { assertExecutedToolsRendered } from "../../support/core/session/toolCoverage.mjs";

const providerBlockedFamilies = new Set();

function isProviderFamilyBlocked(config) {
  if (isGeminiConfig(config)) return providerBlockedFamilies.has("gemini");
  return false;
}

async function runScenarioWithToolRendering(config, scenarioName, runner) {
  const configsToTry = [config, ...(config.fallbackConfigs ?? [])];
  let lastError = null;

  for (const candidateConfig of configsToTry) {
    try {
      await runner(candidateConfig);
      const state = await inspectChatState(
        `${candidateConfig.label}-${scenarioName}-tool-rendering`
      );
      await assertExecutedToolsRendered(
        `${candidateConfig.label}-${scenarioName}`,
        state
      );
      await assertNoDuplicateTranscriptMessages(
        `${candidateConfig.label}-${scenarioName}`
      );
      if (candidateConfig !== config) {
        const chainLabel = isGeminiConfig(candidateConfig)
          ? "gemini"
          : isClaudeCodeConfig(candidateConfig)
            ? "claude-code"
            : "provider";
        console.log(
          `[queued-followup-${chainLabel}-chain] scenario=${scenarioName} recovered with account=${candidateConfig.account.name ?? candidateConfig.account.id} model=${candidateConfig.model}`
        );
      }
      return "passed";
    } catch (error) {
      lastError = error;
      const errorMessage = String(error?.message ?? error ?? "");
      const longQuotaExhausted =
        (/quota[_ ]exhausted/i.test(errorMessage) ||
          /exhausted your capacity/i.test(errorMessage)) &&
        /reset after (?:\d+h|[1-9]\d{3,}s)/i.test(errorMessage);
      const geminiStartupOrMarkerStall =
        isGeminiConfig(candidateConfig) &&
        (errorMessage.includes(
          "did not enter a working state before follow-up"
        ) ||
          errorMessage.includes("follow-up marker never appeared"));
      if (
        isGeminiConfig(candidateConfig) &&
        (longQuotaExhausted || geminiStartupOrMarkerStall)
      ) {
        lastError = error;
        providerBlockedFamilies.add("gemini");
        console.warn(
          `[queued-followup-provider-blocker] scenario=${scenarioName} account=${candidateConfig.account.name ?? candidateConfig.account.id} model=${candidateConfig.model} long Gemini quota exhausted; skipping remaining Gemini fallback for this config. error=${errorMessage.slice(0, 700)}`
        );
        break;
      }
      const canTryGeminiFallback =
        isGeminiConfig(candidateConfig) &&
        (isGeminiTransientCapacityError(error) ||
          errorMessage.includes(
            "did not enter a working state before follow-up"
          ));
      const canTryClaudeCodeFallback =
        isClaudeCodeConfig(candidateConfig) &&
        isClaudeCodeTransientAuthError(error);
      const canTryProviderAccountFallback =
        isProviderAccountBlockedError(error);
      const canTryProviderMarkerFallback =
        isProviderNondeterministicMarkerError(error);
      if (
        !canTryGeminiFallback &&
        !canTryClaudeCodeFallback &&
        !canTryProviderAccountFallback &&
        !canTryProviderMarkerFallback
      ) {
        throw error;
      }
      const chainLabel = canTryGeminiFallback
        ? "gemini"
        : canTryClaudeCodeFallback
          ? "claude-code"
          : "provider";
      console.warn(
        `[queued-followup-${chainLabel}-chain] scenario=${scenarioName} account=${candidateConfig.account.name ?? candidateConfig.account.id} model=${candidateConfig.model} hit retryable provider/account issue; trying next fallback. error=${String(error?.message ?? error).slice(0, 700)}`
      );
    }
  }

  console.warn(
    `[queued-followup-provider-blocker] scenario=${scenarioName} label=${config.label} exhausted provider/account fallback chain; skipping this config. error=${String(lastError?.message ?? lastError).slice(0, 900)}`
  );
  return "provider-blocked";
}

const CONTROL_SCENARIO_NAMES = [
  "fresh-stop",
  "fresh-stop-image",
  "stop-restore",
  "chaos-control-flow",
  "burst-queue-send-now-ordering",
  "queue-autodispatch-after-natural-completion",
  "send-after-idle-does-not-queue",
  "queue-does-not-autoflush-while-active",
  "queue-edit-image-upload",
  "stop-double-click-no-resubmit",
  "stop-bg-subagent-next-message",
  "force-send",
  "force-send-while-shell-running",
  "rewind",
  "restore-checkpoint",
  "plan-build-direct",
  "plan-update",
  "plan-edit-resend",
  "plan-stop",
  "plan-write-denied",
  "intermediate-streaming",
  "ask-write-denied",
  "ask-force-send",
];

const RUST_AGENT_EXEC_MODE_SCENARIOS = new Set([
  "fresh-stop",
  "fresh-stop-image",
  "stop-bg-subagent-next-message",
  // #110 needs a real `exec` foreground shell, which only the rust-agent
  // harness owns — gate it to rust-agent configs.
  "force-send-while-shell-running",
  "queue-edit-image-upload",
  "plan-build-direct",
  "plan-update",
  "plan-edit-resend",
  "plan-stop",
  "plan-write-denied",
  "ask-write-denied",
  "ask-force-send",
]);
describe("ORGII force-send queued follow-up behavior", function () {
  let configs;

  function configsForScenario(scenarioName) {
    if (RUST_AGENT_EXEC_MODE_SCENARIOS.has(scenarioName)) {
      return rustAgentConfigs(configs);
    }
    return configs;
  }

  async function runScenario(scenarioName, runner, mochaContext) {
    if (!shouldRunScenario(scenarioName)) {
      mochaContext.skip();
      return;
    }
    const selectedConfigs = configsForScenario(scenarioName).filter(
      (config) => !isProviderFamilyBlocked(config)
    );
    if (selectedConfigs.length === 0) {
      throw new Error(`Scenario ${scenarioName} has no available configs`);
    }
    const scope = RUST_AGENT_EXEC_MODE_SCENARIOS.has(scenarioName)
      ? "rust_agent_exec_mode"
      : "all_agents";
    console.log(
      `[queued-followup-matrix] scenario=${scenarioName} scope=${scope} labels=${JSON.stringify(selectedConfigs.map((config) => config.label))}`
    );
    let passedCount = 0;
    const providerBlockedLabels = [];
    for (const config of selectedConfigs) {
      if (isProviderFamilyBlocked(config)) {
        providerBlockedLabels.push(config.label);
        continue;
      }
      const result = await runScenarioWithToolRendering(
        config,
        scenarioName,
        runner
      );
      if (result === "passed") passedCount += 1;
      if (result === "provider-blocked")
        providerBlockedLabels.push(config.label);
    }
    if (CONTROL_LABEL_FILTER.length > 0 && providerBlockedLabels.length > 0) {
      throw new Error(
        `Scenario ${scenarioName} had provider/account-blocked requested labels: ${providerBlockedLabels.join(", ")}; selected=${selectedConfigs.length}`
      );
    }
    if (passedCount === 0 && selectedConfigs.length > 0) {
      throw new Error(
        `Scenario ${scenarioName} had no successful platform coverage; providerBlocked=${providerBlockedLabels.length} selected=${selectedConfigs.length}`
      );
    }
  }

  before(async () => {
    assertKnownControlScenarios(CONTROL_SCENARIO_NAMES);
    await waitForApp();
    configs = filteredConfigs(scenarioConfigs(await listAccounts()));
    assertUniqueConfigLabels(configs, "selected control configs");
    if (CONTROL_LABEL_FILTER.length > 0) {
      const producedLabels = new Set(configs.map((config) => config.label));
      const missingLabels = CONTROL_LABEL_FILTER.filter(
        (label) => !producedLabels.has(label)
      );
      if (missingLabels.length > 0) {
        throw new Error(
          `Requested E2E_CONTROL_LABELS missing configs: ${missingLabels.join(", ")}; produced=${JSON.stringify(Array.from(producedLabels))}`
        );
      }
    }
    if (configs.length === 0) {
      throw new Error(
        `No configs matched E2E_CONTROL_LABELS=${JSON.stringify(CONTROL_LABEL_FILTER)}`
      );
    }
  });

  it("keeps a fresh first-send prompt visible and restores uploaded images on Stop across Rust AgentExecMode sessions", async function () {
    await runScenario(
      "fresh-stop-image",
      runFreshStopImageRestoreScenario,
      this
    );
  });

  it("keeps a fresh first-send prompt visible and restores its draft on Stop across Rust AgentExecMode sessions", async function () {
    await runScenario("fresh-stop", runFreshStopRollbackScenario, this);
  });

  it("survives mixed Stop, resend, Send Now, Stop, and double-queue control flow across Rust and CLI agents", async function () {
    this.timeout(1_200_000);
    await runScenario("chaos-control-flow", runChaosControlFlowScenario, this);
  });

  it("auto-dispatches queued follow-ups after the active turn naturally completes", async function () {
    this.timeout(1_200_000);
    await runScenario(
      "queue-autodispatch-after-natural-completion",
      runQueueAutodispatchesAfterNaturalCompletionScenario,
      this
    );
  });

  it("sends new prompts directly after the previous turn is idle instead of queueing them", async function () {
    this.timeout(1_200_000);
    await runScenario(
      "send-after-idle-does-not-queue",
      runSendAfterIdleDoesNotQueueScenario,
      this
    );
  });

  it("does not auto-flush queued follow-ups while the active turn is still running", async function () {
    this.timeout(1_200_000);
    await runScenario(
      "queue-does-not-autoflush-while-active",
      runQueueDoesNotAutoflushWhileActiveScenario,
      this
    );
  });

  it("uploads an image into a queued message via the + menu without collapsing queue-edit mode", async function () {
    this.timeout(1_200_000);
    await runScenario(
      "queue-edit-image-upload",
      runQueueEditImageUploadScenario,
      this
    );
  });

  it("keeps burst queued siblings parked when the user force-sends the middle item then Stops and resends", async function () {
    this.timeout(1_200_000);
    await runScenario(
      "burst-queue-send-now-ordering",
      runBurstQueueSendNowOrderingScenario,
      this
    );
  });

  it("does not resubmit a restored draft when the user double-clicks Stop", async function () {
    await runScenario(
      "stop-double-click-no-resubmit",
      runStopDoubleClickDoesNotResubmitScenario,
      this
    );
  });

  it("restores the in-flight prompt on Stop without consuming queued follow-ups across Rust and CLI agents", async function () {
    await runScenario("stop-restore", runStopRestoresInFlightScenario, this);
  });

  it("keeps the next message live after Stopping with a background subagent over an idle parent turn across Rust AgentExecMode sessions", async function () {
    this.timeout(1_200_000);
    await runScenario(
      "stop-bg-subagent-next-message",
      runStopWithBackgroundSubagentNextMessageScenario,
      this
    );
  });

  it("force-sends coherent follow-ups through Rust and CLI agents", async function () {
    this.timeout(1_200_000);
    await runScenario("force-send", runForceSendScenario, this);
  });

  it("force-sends a follow-up that lands promptly while a foreground shell command is still running (#110)", async function () {
    this.timeout(1_200_000);
    await runScenario(
      "force-send-while-shell-running",
      runForceSendWhileShellRunningScenario,
      this
    );
  });

  it("rewinds agent file edits through the rendered Undo All control across Rust and CLI agents", async function () {
    this.timeout(1_200_000);
    await runScenario("rewind", runRewindScenario, this);
  });

  it("restores the session to a prior checkpoint without re-sending across Rust and CLI agents", async function () {
    this.timeout(1_200_000);
    await runScenario(
      "restore-checkpoint",
      runRestoreCheckpointScenario,
      this
    );
  });

  it("runs Plan mode direct Build and clears stale plan UI across Rust AgentExecMode sessions", async function () {
    await runScenario("plan-build-direct", runPlanBuildDirectScenario, this);
  });

  it("updates pending Plan mode cards and only leaves the latest card buildable across Rust AgentExecMode sessions", async function () {
    await runScenario("plan-update", runPlanUpdateSupersedesScenario, this);
  });

  it("clears stale Plan mode approval state when editing and resending a planned Rust AgentExecMode user turn", async function () {
    await runScenario("plan-edit-resend", runPlanEditResendScenario, this);
  });

  it("stops Plan mode without leaving a buildable stale plan card across Rust AgentExecMode sessions", async function () {
    await runScenario("plan-stop", runPlanStopScenario, this);
  });

  it("keeps Plan mode read-only before Build approval across Rust AgentExecMode sessions", async function () {
    await runScenario(
      "plan-write-denied",
      runPlanWriteBeforeBuildDeniedScenario,
      this
    );
  });

  it("renders intermediate thinking or tool events before final completion across agents", async function () {
    await runScenario(
      "intermediate-streaming",
      runIntermediateStreamingScenario,
      this
    );
  });

  it("keeps Ask mode read-only even when the user asks for file edits across Rust AgentExecMode sessions", async function () {
    await runScenario("ask-write-denied", runAskWriteDeniedScenario, this);
  });

  it("force-sends read-only follow-ups in Ask mode without plan or rewind UI across Rust AgentExecMode sessions", async function () {
    this.timeout(1_200_000);
    await runScenario("ask-force-send", runAskForceSendScenario, this);
  });
});

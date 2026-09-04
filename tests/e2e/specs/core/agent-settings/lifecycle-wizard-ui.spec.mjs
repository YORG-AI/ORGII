/* global describe, before, it */
import {
  BUILTIN_SDE_AGENT_ID,
  bootAgentSettingsE2E,
  clickSwitchAndWait,
  expectDefinitionField,
  getCurrentAgentConfigRootSelector,
  openAgentRow,
  openAgentWizard,
  openWizardTab,
  pointerClick,
  refreshAgentRows,
  removeAgentDefIfExists,
  restoreWorkstationIfFocused,
  setMarkdownEditor,
  setNumberInput,
  setTextInput,
  waitForAgentDefField,
  waitForScript,
} from "../../../support/core/agent-settings/agentSettingsDriver.mjs";
import { invokeE2E, unwrap } from "../../../support/core/agentOrgUiDriver.mjs";

const RUN_MARKER = `E2E_AGENT_LIFECYCLE_${Date.now()}`;

async function findAgentByName(name) {
  const defs = unwrap(await invokeE2E("listAgentDefs"), "listAgentDefs").defs;
  return (defs ?? []).find((definition) => definition?.name === name) ?? null;
}

describe("Agent Settings lifecycle and wizard UI", () => {
  before(async () => {
    await bootAgentSettingsE2E();
  });

  it("cancels the rendered custom Agent wizard without creating an AgentDefinition", async () => {
    const cancelledName = `E2E Cancelled Agent ${RUN_MARKER}`;
    const stale = await findAgentByName(cancelledName);
    if (stale?.id) {
      await removeAgentDefIfExists(stale.id);
    }

    await openAgentWizard();
    await setTextInput(
      '[data-testid="agent-orgs-agent-wizard-name-input"]',
      cancelledName,
      "cancelled wizard agent name"
    );
    await pointerClick(
      '[data-testid="agent-orgs-agent-wizard-cancel-button"]',
      "Agent wizard cancel button"
    );
    await waitForScript(
      `return !document.querySelector('[data-testid="agent-orgs-agent-wizard-root"]');`,
      "Agent wizard did not close after cancel"
    );

    const after = await findAgentByName(cancelledName);
    if (after) {
      throw new Error(
        `Cancelled wizard created an AgentDefinition: ${JSON.stringify(after)}`
      );
    }
  });

  it("creates, edits subagents, and deletes a custom Agent through rendered Settings UI", async () => {
    const childAgentId = `e2e-lifecycle-child-${RUN_MARKER}`;
    const childDefinition = {
      id: childAgentId,
      name: `E2E Lifecycle Child ${RUN_MARKER}`,
      description:
        "Temporary child for rendered Agent wizard sub-agent coverage.",
      builtIn: false,
      tier: "secondary",
      inheritsFrom: BUILTIN_SDE_AGENT_ID,
      capabilities: { coding: { modeSwitch: true } },
      delegationConfig: { delegatable: true, contextBuilders: [] },
      sessionModel: {
        mode: "singleton",
        processingLock: true,
        maxIterations: 2,
      },
      tools: { userAllowedTools: [], excludedTools: [] },
      skillsConfig: { enabled: true, include: [], exclude: [], sourceDirs: [] },
    };
    const agentName = `E2E Wizard Agent ${RUN_MARKER}`;
    const agentDescription = `Rendered wizard description ${RUN_MARKER}`;
    const soulContent = `Rendered wizard soul ${RUN_MARKER}`;
    const compactionModel = `e2e-compaction-model-${RUN_MARKER}`;
    let createdAgentId = null;

    try {
      await removeAgentDefIfExists(childAgentId);
      unwrap(
        await invokeE2E("addAgentDef", childDefinition),
        "seed lifecycle child AgentDefinition"
      );
      await waitForAgentDefField(
        childAgentId,
        (definition) => definition?.id === childAgentId,
        "seeded lifecycle child AgentDefinition"
      );
      await refreshAgentRows();
      const stale = await findAgentByName(agentName);
      if (stale?.id) {
        await removeAgentDefIfExists(stale.id);
      }

      await openAgentWizard();
      await setMarkdownEditor(
        '[data-testid="agent-orgs-agent-wizard-soul-editor"]',
        soulContent,
        "Agent wizard soul editor"
      );
      await setTextInput(
        '[data-testid="agent-orgs-agent-wizard-name-input"]',
        agentName,
        "Agent wizard name"
      );
      await setTextInput(
        '[data-testid="agent-orgs-agent-wizard-description-input"]',
        agentDescription,
        "Agent wizard description"
      );

      await openWizardTab("models");
      await pointerClick(
        '[data-testid="agent-orgs-agent-wizard-context-window-select"]',
        "Agent wizard context window select"
      );
      await pointerClick(
        '[data-testid="agent-orgs-agent-wizard-context-window-option-custom"]',
        "Agent wizard custom context option"
      );
      await setNumberInput(
        '[data-testid="agent-orgs-agent-wizard-context-window-input"]',
        64_000,
        "Agent wizard context window"
      );
      await setNumberInput(
        '[data-testid="agent-orgs-agent-wizard-max-tokens-input"]',
        4_096,
        "Agent wizard max tokens"
      );
      await setNumberInput(
        '[data-testid="agent-orgs-agent-wizard-temperature-input"]',
        0.4,
        "Agent wizard temperature"
      );
      await setNumberInput(
        '[data-testid="agent-orgs-agent-wizard-compaction-trigger-ratio-input"]',
        0.6,
        "Agent wizard compaction trigger ratio"
      );
      await setNumberInput(
        '[data-testid="agent-orgs-agent-wizard-compaction-keep-ratio-input"]',
        0.35,
        "Agent wizard compaction keep ratio"
      );
      await setTextInput(
        '[data-testid="agent-orgs-agent-wizard-compaction-model-input"]',
        compactionModel,
        "Agent wizard compaction model"
      );
      await setNumberInput(
        '[data-testid="agent-orgs-agent-wizard-compaction-summary-max-tokens-input"]',
        2048,
        "Agent wizard compaction summary max tokens"
      );
      await setNumberInput(
        '[data-testid="agent-orgs-agent-wizard-compaction-min-messages-input"]',
        9,
        "Agent wizard compaction min messages"
      );
      await setNumberInput(
        '[data-testid="agent-orgs-agent-wizard-compaction-floor-tokens-input"]',
        12_000,
        "Agent wizard compaction floor tokens"
      );
      await setNumberInput(
        '[data-testid="agent-orgs-agent-wizard-compaction-reserved-summary-tokens-input"]',
        18_000,
        "Agent wizard compaction reserved summary tokens"
      );
      await setNumberInput(
        '[data-testid="agent-orgs-agent-wizard-compaction-buffer-tokens-input"]',
        9_000,
        "Agent wizard compaction buffer tokens"
      );

      await openWizardTab("capabilities");
      await clickSwitchAndWait(
        '[data-testid="agent-orgs-agent-wizard-capability-coding-switch"]',
        "Agent wizard coding capability switch"
      );
      await clickSwitchAndWait(
        '[data-testid="agent-orgs-agent-wizard-capability-coding-mode-switch"]',
        "Agent wizard coding mode switch"
      );
      await clickSwitchAndWait(
        '[data-testid="agent-orgs-agent-wizard-capability-desktop-switch"]',
        "Agent wizard desktop capability switch"
      );
      await clickSwitchAndWait(
        '[data-testid="agent-orgs-agent-wizard-capability-browser-external-switch"]',
        "Agent wizard external browser capability switch"
      );
      await clickSwitchAndWait(
        '[data-testid="agent-orgs-agent-wizard-capability-browser-internal-switch"]',
        "Agent wizard internal browser capability switch"
      );
      await clickSwitchAndWait(
        '[data-testid="agent-orgs-agent-wizard-capability-gateway-switch"]',
        "Agent wizard gateway capability switch"
      );
      await clickSwitchAndWait(
        '[data-testid="agent-orgs-agent-wizard-capability-data-switch"]',
        "Agent wizard data capability switch"
      );
      await clickSwitchAndWait(
        '[data-testid="agent-orgs-agent-wizard-capability-management-switch"]',
        "Agent wizard management capability switch"
      );

      await openWizardTab("subagents");
      await setNumberInput(
        '[data-testid="agent-orgs-subagents-max-tool-use-concurrency-input"]',
        3,
        "Agent wizard max tool-use concurrency"
      );
      await pointerClick(
        '[data-testid="agent-orgs-subagents-add-button"]',
        "Agent wizard add sub-agent button"
      );
      await pointerClick(
        `[data-testid="agent-orgs-subagents-add-option-${childAgentId}"]`,
        "Agent wizard child sub-agent option"
      );
      await clickSwitchAndWait(
        `[data-testid="agent-orgs-subagents-isolation-${childAgentId}"]`,
        "Agent wizard sub-agent worktree isolation switch"
      );

      await pointerClick(
        '[data-testid="agent-orgs-agent-wizard-create-button"]',
        "Agent wizard create button"
      );
      await browser.waitUntil(
        async () => Boolean(await findAgentByName(agentName)),
        {
          timeout: 20_000,
          interval: 500,
          timeoutMsg:
            "Created AgentDefinition did not appear after wizard create",
        }
      );
      const created = await findAgentByName(agentName);
      if (!created?.id) {
        throw new Error(
          `Created AgentDefinition had no id: ${JSON.stringify(created)}`
        );
      }
      createdAgentId = created.id;

      const stored = await waitForAgentDefField(
        createdAgentId,
        (definition) => definition?.name === agentName,
        "rendered wizard-created AgentDefinition"
      );
      expectDefinitionField(
        stored,
        (definition) => definition.description === agentDescription,
        "wizard description"
      );
      expectDefinitionField(
        stored,
        (definition) => definition.soulContent === soulContent,
        "wizard soul content"
      );
      expectDefinitionField(
        stored,
        (definition) => definition.contextWindow === 64_000,
        "wizard context window"
      );
      expectDefinitionField(
        stored,
        (definition) => definition.maxTokens === 4_096,
        "wizard max tokens"
      );
      expectDefinitionField(
        stored,
        (definition) => definition.temperature === 0.4,
        "wizard temperature"
      );
      expectDefinitionField(
        stored,
        (definition) => definition.sessionModel?.compaction?.enabled === true,
        "wizard compaction enabled"
      );
      expectDefinitionField(
        stored,
        (definition) =>
          definition.sessionModel?.compaction?.triggerRatio === 0.6,
        "wizard compaction trigger ratio"
      );
      expectDefinitionField(
        stored,
        (definition) => definition.sessionModel?.compaction?.keepRatio === 0.35,
        "wizard compaction keep ratio"
      );
      expectDefinitionField(
        stored,
        (definition) =>
          definition.sessionModel?.compaction?.model === compactionModel,
        "wizard compaction model"
      );
      expectDefinitionField(
        stored,
        (definition) =>
          definition.sessionModel?.compaction?.summaryMaxTokens === 2048,
        "wizard compaction summary max tokens"
      );
      expectDefinitionField(
        stored,
        (definition) => definition.sessionModel?.compaction?.minMessages === 9,
        "wizard compaction min messages"
      );
      expectDefinitionField(
        stored,
        (definition) =>
          definition.sessionModel?.compaction?.floorTokens === 12_000,
        "wizard compaction floor tokens"
      );
      expectDefinitionField(
        stored,
        (definition) =>
          definition.sessionModel?.compaction?.reservedSummaryTokens === 18_000,
        "wizard compaction reserved summary tokens"
      );
      expectDefinitionField(
        stored,
        (definition) =>
          definition.sessionModel?.compaction?.bufferTokens === 9_000,
        "wizard compaction buffer tokens"
      );
      expectDefinitionField(
        stored,
        (definition) => definition.capabilities?.coding?.modeSwitch === false,
        "wizard coding capability"
      );
      expectDefinitionField(
        stored,
        (definition) => definition.capabilities?.desktop?.enabled === true,
        "wizard desktop capability"
      );
      expectDefinitionField(
        stored,
        (definition) => definition.capabilities?.browser?.external === true,
        "wizard external browser capability"
      );
      expectDefinitionField(
        stored,
        (definition) => definition.capabilities?.browser?.internal === true,
        "wizard internal browser capability"
      );
      expectDefinitionField(
        stored,
        (definition) => definition.capabilities?.gateway != null,
        "wizard gateway capability"
      );
      expectDefinitionField(
        stored,
        (definition) => definition.capabilities?.data != null,
        "wizard data capability"
      );
      expectDefinitionField(
        stored,
        (definition) => definition.capabilities?.management != null,
        "wizard management capability"
      );
      expectDefinitionField(
        stored,
        (definition) => definition.maxToolUseConcurrency === 3,
        "wizard max tool-use concurrency"
      );
      expectDefinitionField(
        stored,
        (definition) =>
          (definition.subAgents ?? []).some(
            (entry) =>
              entry.agentId === childAgentId && entry.isolation === "worktree"
          ),
        "wizard sub-agent worktree isolation"
      );

      await openAgentRow(createdAgentId, "wizard-created Agent");
      await waitForScript(
        `return !!document.querySelector('[data-testid="agent-orgs-custom-detail"]');`,
        "wizard-created Agent custom detail did not render"
      );
      const detailRootSelector = getCurrentAgentConfigRootSelector();
      await restoreWorkstationIfFocused(
        detailRootSelector,
        "wizard-created Agent delete"
      );
      await pointerClick(
        '[data-testid="agent-orgs-delete-agent-button"]',
        "delete Agent button",
        { rootSelector: detailRootSelector, jsClick: true }
      );
      await pointerClick(
        '[data-testid="agent-orgs-cancel-delete-agent-button"]',
        "cancel delete Agent button",
        { rootSelector: detailRootSelector, jsClick: true }
      );
      const afterCancel = unwrap(
        await invokeE2E("getAgentDef", createdAgentId),
        "get AgentDefinition after delete cancel"
      ).def;
      if (!afterCancel) {
        throw new Error("Delete cancel removed the AgentDefinition");
      }

      await restoreWorkstationIfFocused(
        detailRootSelector,
        "wizard-created Agent delete after cancel"
      );
      await pointerClick(
        '[data-testid="agent-orgs-delete-agent-button"]',
        "delete Agent button after cancel",
        { rootSelector: detailRootSelector, jsClick: true }
      );
      await restoreWorkstationIfFocused(
        detailRootSelector,
        "wizard-created Agent confirm delete"
      );
      await pointerClick(
        '[data-testid="agent-orgs-confirm-delete-agent-button"]',
        "confirm delete Agent button",
        { rootSelector: detailRootSelector, jsClick: true }
      );
      await browser.waitUntil(
        async () => {
          const defs = unwrap(
            await invokeE2E("listAgentDefs"),
            "poll AgentDefinitions after rendered delete"
          ).defs;
          return !(defs ?? []).some(
            (definition) => definition?.id === createdAgentId
          );
        },
        {
          timeout: 20_000,
          interval: 500,
          timeoutMsg:
            "wizard-created AgentDefinition was not deleted through rendered UI",
        }
      );
      createdAgentId = null;
    } finally {
      if (createdAgentId) {
        await invokeE2E("removeAgentDef", createdAgentId);
      }
      await invokeE2E("removeAgentDef", childAgentId);
      await refreshAgentRows();
    }
  });
});

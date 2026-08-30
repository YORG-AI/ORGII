/* global describe, before, it */
import {
  BUILTIN_SDE_AGENT_ID,
  bootAgentSettingsE2E,
  clickAgentDetailTab,
  openAgentRow,
  pointerClick,
  refreshAgentRows,
  removeAgentDefIfExists,
  waitForAgentDefField,
  waitForScript,
} from "../../../support/core/agent-settings/agentSettingsDriver.mjs";
import { invokeE2E, unwrap } from "../../../support/core/agentOrgUiDriver.mjs";

const RUN_MARKER = `E2E_AGENT_SECURITY_${Date.now()}`;

describe("Agent Settings security policy UI", () => {
  before(async () => {
    await bootAgentSettingsE2E();
  });

  it("persists rendered access mode changes to AgentDefinition autonomy", async () => {
    const agentId = `e2e-security-${RUN_MARKER}`;
    const initialDefinition = {
      id: agentId,
      name: `E2E Security Agent ${RUN_MARKER}`,
      description: "Temporary custom agent for access-mode UI coverage.",
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
        await invokeE2E("addAgentDef", initialDefinition),
        "seed security AgentDefinition"
      );
      await waitForAgentDefField(
        agentId,
        (definition) => definition?.agentPolicy?.autonomy === "full",
        "seeded security AgentDefinition"
      );

      await openAgentRow(agentId, "security Agent");
      await waitForScript(
        `return !!document.querySelector('[data-testid="agent-orgs-custom-detail"]');`,
        "security Agent detail did not render"
      );
      await clickAgentDetailTab("general");

      await pointerClick(
        '[data-testid="agent-orgs-security-access-mode-select"]',
        "security access mode select"
      );
      await pointerClick(
        '[data-testid="agent-orgs-security-access-mode-option-readonly"]',
        "security readonly access mode option"
      );
      await waitForAgentDefField(
        agentId,
        (definition) => definition?.agentPolicy?.autonomy === "readonly",
        "readonly access mode persisted"
      );

      await pointerClick(
        '[data-testid="agent-orgs-security-access-mode-select"]',
        "security access mode select after readonly"
      );
      await pointerClick(
        '[data-testid="agent-orgs-security-access-mode-option-full"]',
        "security full access mode option"
      );
      const stored = await waitForAgentDefField(
        agentId,
        (definition) => definition?.agentPolicy?.autonomy === "full",
        "full access mode persisted"
      );
      if (stored.agentPolicy?.workspaceOnly !== true) {
        throw new Error(
          `Access-mode update clobbered sibling workspaceOnly policy: ${JSON.stringify(stored)}`
        );
      }
    } finally {
      await invokeE2E("removeAgentDef", agentId);
      await refreshAgentRows();
    }
  });
});

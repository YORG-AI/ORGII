/* global describe, before, it */
import {
  BUILTIN_SDE_AGENT_ID,
  bootAgentSettingsE2E,
  clickAgentDetailTab,
  getCurrentAgentConfigRootSelector,
  openAgentRow,
  pointerClick,
  waitForScript,
} from "../../../support/core/agent-settings/agentSettingsDriver.mjs";

async function waitForLocation(predicate, label) {
  let state = null;
  await browser.waitUntil(
    async () => {
      state = await browser.executeScript(
        `
          return {
            pathname: window.location.pathname,
            search: window.location.search,
            href: window.location.href,
            bodyText: document.body.innerText.slice(0, 1200),
            testIds: Array.from(document.querySelectorAll('[data-testid]')).map((element) => element.getAttribute('data-testid')).slice(-80),
          };
        `,
        []
      );
      return predicate(state);
    },
    {
      timeout: 30_000,
      interval: 250,
      timeoutMsg: `${label}: ${JSON.stringify(state, null, 2)}`,
    }
  );
}

describe("Agent Settings management entry UI", () => {
  before(async () => {
    await bootAgentSettingsE2E();
  });

  it("deep-links Add Skill, Add MCP, and Add Rule buttons to their management surfaces", async () => {
    await openAgentRow(BUILTIN_SDE_AGENT_ID, "SDE Agent");
    await waitForScript(
      `return !!document.querySelector('[data-testid="agent-orgs-builtin-detail-sde"]');`,
      "SDE Agent detail did not render"
    );

    await clickAgentDetailTab("skillsets");
    await pointerClick(
      '[data-testid="agent-orgs-add-skill-button"]',
      "Add Skill button",
      { rootSelector: getCurrentAgentConfigRootSelector(), jsClick: true }
    );
    await waitForLocation(
      (state) =>
        state.pathname.includes("/settings/integrations/skills-mcps-plugins") &&
        !state.search.includes("skillsetTab=mcp"),
      "Add Skill did not navigate to Skills/MCPs/Plugins Skills tab"
    );

    await openAgentRow(BUILTIN_SDE_AGENT_ID, "SDE Agent after Add Skill");
    await clickAgentDetailTab("skillsets");
    await pointerClick(
      '[data-testid="agent-orgs-add-mcp-button"]',
      "Add MCP button",
      { rootSelector: getCurrentAgentConfigRootSelector(), jsClick: true }
    );
    await waitForLocation(
      (state) =>
        state.pathname.includes("/settings/integrations/skills-mcps-plugins") &&
        state.search.includes("skillsetTab=mcp"),
      "Add MCP did not navigate to Skills/MCPs/Plugins MCP tab"
    );

    await openAgentRow(BUILTIN_SDE_AGENT_ID, "SDE Agent after Add MCP");
    await clickAgentDetailTab("rules");
    await pointerClick(
      '[data-testid="agent-orgs-add-rule-button"]',
      "Add Rule button",
      { rootSelector: getCurrentAgentConfigRootSelector(), jsClick: true }
    );
    await waitForScript(
      `return window.location.pathname.includes('/settings/integrations/rules-memory-and-evolution');`,
      "Add Rule did not navigate to Rules/Memory/Evolution management"
    );
  });
});

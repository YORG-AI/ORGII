import { describe, expect, it } from "vitest";

import {
  CLI_LAUNCH_MODE,
  SESSION_TARGET_KIND,
  type SessionCreatorState,
  normalizeAgentOnlySessionCreatorState,
  normalizeSessionCreatorState,
} from "../creatorStateAtom";

const defaultAgentOrgState: SessionCreatorState = {
  dispatchCategory: "rust_agent",
  targetKind: SESSION_TARGET_KIND.AGENT_ORG,
  source: null,
  selectedAgentDefinitionId: null,
  selectedAgentOrgId: "default:sde-feature-team",
  agentName: "Default Agent Team",
  agentIconId: "network",
  cliAgentType: null,
  cliLaunchMode: CLI_LAUNCH_MODE.GUI,
};

describe("normalizeSessionCreatorState", () => {
  it("uses SDE Agent instead of the built-in default Agent Team", () => {
    const normalized = normalizeSessionCreatorState(defaultAgentOrgState);

    expect(normalized.dispatchCategory).toBe("rust_agent");
    expect(normalized.targetKind).toBe(SESSION_TARGET_KIND.AGENT);
    expect(normalized.selectedAgentDefinitionId).toBe("builtin:sde");
    expect(normalized.selectedAgentOrgId).toBeNull();
    expect(normalized.agentName).toBe("SDE Agent");
    expect(normalized.agentIconId).toBe("code");
  });

  it("preserves a custom Agent Team selection", () => {
    const customOrgState: SessionCreatorState = {
      ...defaultAgentOrgState,
      selectedAgentOrgId: "custom-org",
      agentName: "Custom Org",
    };

    expect(normalizeSessionCreatorState(customOrgState)).toEqual(
      customOrgState
    );
  });
});

describe("normalizeAgentOnlySessionCreatorState", () => {
  it("replaces a Human session selection with the default SDE Agent", () => {
    const humanState: SessionCreatorState = {
      ...defaultAgentOrgState,
      dispatchCategory: "human_session",
      targetKind: SESSION_TARGET_KIND.HUMAN,
      selectedAgentOrgId: null,
      agentName: "Work log",
      agentIconId: "clipboard-list",
    };

    const normalized = normalizeAgentOnlySessionCreatorState(humanState);

    expect(normalized.dispatchCategory).toBe("rust_agent");
    expect(normalized.targetKind).toBe(SESSION_TARGET_KIND.AGENT);
    expect(normalized.selectedAgentDefinitionId).toBe("builtin:sde");
    expect(normalized.selectedAgentOrgId).toBeNull();
    expect(normalized.agentName).toBe("SDE Agent");
    expect(normalized.agentIconId).toBe("code");
  });

  it("preserves an existing agent selection", () => {
    const agentState: SessionCreatorState = {
      ...defaultAgentOrgState,
      targetKind: SESSION_TARGET_KIND.AGENT,
      selectedAgentDefinitionId: "custom-agent",
      selectedAgentOrgId: null,
      agentName: "Custom Agent",
    };

    expect(normalizeAgentOnlySessionCreatorState(agentState)).toBe(agentState);
  });
});

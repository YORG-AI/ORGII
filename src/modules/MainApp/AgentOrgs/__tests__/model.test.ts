import { describe, expect, it } from "vitest";

import {
  resolveAgentOrgsTableTab,
  resolveLegacyAgentOrgsRedirect,
  selectInstalledCliAgents,
} from "../model";
import type { AvailableCliAgent } from "../types";

describe("AgentOrgs model", () => {
  it("falls back to agents for non-table route tabs", () => {
    expect(resolveAgentOrgsTableTab("agents")).toBe("agents");
    expect(resolveAgentOrgsTableTab("orgs")).toBe("orgs");
    expect(resolveAgentOrgsTableTab("clis")).toBe("clis");
  });

  it("filters and sorts installed CLI agents without mutating input", () => {
    const agents = [
      { displayName: "Zulu", installed: true },
      { displayName: "Alpha", installed: true },
      { displayName: "Beta", installed: false },
    ] as AvailableCliAgent[];
    expect(
      selectInstalledCliAgents(agents).map((agent) => agent.displayName)
    ).toEqual(["Alpha", "Zulu"]);
    expect(agents.map((agent) => agent.displayName)).toEqual([
      "Zulu",
      "Alpha",
      "Beta",
    ]);
  });

  it("recognizes the legacy org settings route", () => {
    expect(resolveLegacyAgentOrgsRedirect("/settings/org")).toBe(true);
    expect(resolveLegacyAgentOrgsRedirect("/settings/agent-orgs/orgs")).toBe(
      false
    );
  });
});

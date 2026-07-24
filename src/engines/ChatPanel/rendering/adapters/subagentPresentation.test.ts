import { describe, expect, it } from "vitest";

import { resolveSubagentPresentation } from "./subagentPresentation";

describe("resolveSubagentPresentation", () => {
  it("uses the parsed Codex nickname instead of the child prompt title", () => {
    expect(
      resolveSubagentPresentation({
        sessionId: "codexapp-rollout-child",
        hasCodexThreadIdentity: true,
        parsedAgentName: "Peirce",
        sessionAgentName: "try use a subagent to audit today's commit history",
        description: "audit_todays_commits",
        prompt: "try use a subagent to audit today's commit history",
      })
    ).toEqual({
      agentName: "Peirce",
      description: "",
    });
  });

  it("keeps the child display name and description for non-Codex agents", () => {
    expect(
      resolveSubagentPresentation({
        sessionId: "agent-builtin:explore-1",
        hasCodexThreadIdentity: false,
        parsedAgentName: "Explore",
        sessionAgentName: "Repository Scout",
        description: "Audit the repository",
        prompt: "Inspect the current changes.",
      })
    ).toEqual({
      agentName: "Repository Scout",
      description: "Audit the repository",
    });
  });
});

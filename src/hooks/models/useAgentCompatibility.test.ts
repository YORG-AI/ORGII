import { describe, expect, it } from "vitest";

import { getCliCompatibleAccountsForAgent } from "./useAgentCompatibility";

describe("getCliCompatibleAccountsForAgent", () => {
  it("uses the exact CLI inventory row without requiring global registry mounting", () => {
    const accounts = [
      {
        id: "codex-plan",
        modelType: "codex",
        status: "ready",
        canLaunchCli: true,
      },
      {
        id: "openai-key",
        modelType: "openai_api",
        status: "ready",
        hasApiKey: true,
      },
      {
        id: "anthropic-key",
        modelType: "anthropic_api",
        status: "ready",
        hasApiKey: true,
      },
    ];

    expect(
      getCliCompatibleAccountsForAgent(
        {
          name: "codex",
          compatibleApiProviders: ["openai_api", "zenmux_api"],
        },
        "codex",
        accounts
      ).map((account) => account.id)
    ).toEqual(["codex-plan", "openai-key"]);
  });

  it("rejects a plan account whose CLI credential is not launchable", () => {
    expect(
      getCliCompatibleAccountsForAgent(
        { name: "codex", compatibleApiProviders: [] },
        "codex",
        [
          {
            modelType: "codex",
            status: "ready",
            canLaunchCli: false,
          },
        ]
      )
    ).toEqual([]);
  });
});

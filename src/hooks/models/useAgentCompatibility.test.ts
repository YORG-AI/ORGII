import { describe, expect, it } from "vitest";

import type { KeyVaultAccount } from "@src/hooks/keyVault";
import type { AgentRegistry } from "@src/store/session/agentRegistryAtom";

import { getCliCompatibleAccounts } from "./useAgentCompatibility";

function account(
  id: string,
  modelType: string,
  overrides: Partial<KeyVaultAccount> = {}
): KeyVaultAccount {
  return {
    id,
    name: id,
    modelType: modelType as KeyVaultAccount["modelType"],
    hasLocalKey: true,
    isListed: false,
    status: "ready",
    hasKey: true,
    hasApiKey: false,
    hasSessionToken: true,
    enabled: true,
    ...overrides,
  };
}

const registry = {
  agents: [
    {
      name: "claude_code",
      compatibleApiProviders: ["anthropic_api", "atlascloud_api"],
    },
  ],
  apiProviders: [],
} as unknown as AgentRegistry;

describe("CLI account compatibility", () => {
  it("keeps runnable Claude OAuth and supported providers, not Codex or invalid OAuth", () => {
    const compatible = getCliCompatibleAccounts(registry, "claude_code", [
      account("anthropic-1", "claude_code", {
        authMethod: "oauth",
        canLaunchCli: true,
      }),
      account("atlas-1", "atlascloud_api", { hasApiKey: true }),
      account("openai-1", "codex", {
        authMethod: "oauth",
        canLaunchCli: true,
      }),
      account("expired-anthropic", "claude_code", {
        authMethod: "oauth",
        status: "error",
        canLaunchCli: true,
      }),
    ]);

    expect(compatible.map((entry) => entry.id)).toEqual([
      "anthropic-1",
      "atlas-1",
    ]);
  });
});

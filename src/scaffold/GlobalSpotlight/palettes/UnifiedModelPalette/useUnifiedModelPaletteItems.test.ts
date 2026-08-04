import { describe, expect, it } from "vitest";

import type { KeyVaultAccount } from "@src/hooks/keyVault/types";

import { resolveCurrentModelEntry } from "./useUnifiedModelPaletteItems";

function accountWithStaleEnabledModel(): KeyVaultAccount {
  return {
    id: "codex-key",
    hasLocalKey: true,
    isListed: false,
    modelType: "codex",
    name: "OpenAIne w",
    status: "ready",
    hasKey: true,
    hasApiKey: false,
    hasSessionToken: true,
    authMethod: "oauth",
    enabled: true,
    availableModels: ["gpt-5.5", "gpt-5.4"],
    enabledModels: ["gpt-5.6-sol", "gpt-5.5", "gpt-5.4"],
  };
}

describe("useUnifiedModelPaletteItems", () => {
  it("does not synthesize an actionable recent row for a stale active pair", () => {
    const accounts = [accountWithStaleEnabledModel()];
    const entry = resolveCurrentModelEntry({
      activeModelId: "gpt-5.6-sol",
      advancedConfig: {
        keySource: "own_key",
        model: "gpt-5.6-sol",
        selectedAccountId: "codex-key",
        selectedSourceLabel: "OpenAIne w",
        selectedSourceModelType: "codex",
      },
      compatibleRecentEntries: [],
      groupByModel: new Map(),
      compatibilityContext: {
        accounts,
        orgiiPoolEnabled: true,
        orgiiModelSet: new Map(),
        orgiiCategoryIds: new Set(),
      },
    });

    expect(entry).toBeNull();
  });

  it("keeps a current pair that remains available and enabled", () => {
    const account = accountWithStaleEnabledModel();
    const entry = resolveCurrentModelEntry({
      activeModelId: "gpt-5.5",
      advancedConfig: {
        keySource: "own_key",
        model: "gpt-5.5",
        selectedAccountId: "codex-key",
      },
      compatibleRecentEntries: [],
      groupByModel: new Map([["gpt-5.5", ["gpt-5.5"]]]),
      compatibilityContext: {
        accounts: [account],
        orgiiPoolEnabled: true,
        orgiiModelSet: new Map(),
        orgiiCategoryIds: new Set(),
      },
    });

    expect(entry).toMatchObject({
      modelId: "gpt-5.5",
      accountId: "codex-key",
    });
  });
});

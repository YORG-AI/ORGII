import { describe, expect, it } from "vitest";

import { CLI_AGENT } from "@src/api/types/keys";
import type { KeyVaultAccount } from "@src/hooks/keyVault/types";
import type { RecentModelEntry } from "@src/store/session/recentModelEntriesAtom";

import { resolveValidatedLastPair } from "../useValidatedLastPair";

function codexAccount(
  overrides: Partial<KeyVaultAccount> = {}
): KeyVaultAccount {
  return {
    id: "account-id",
    hasLocalKey: true,
    isListed: false,
    modelType: CLI_AGENT.CODEX,
    name: "Codex",
    status: "ready",
    hasKey: true,
    hasApiKey: false,
    hasSessionToken: true,
    authMethod: "oauth",
    enabled: true,
    availableModels: ["gpt-5.5-high-fast"],
    enabledModels: ["gpt-5.5-high-fast"],
    ...overrides,
  };
}

function recentPair(
  overrides: Partial<RecentModelEntry> = {}
): RecentModelEntry {
  return {
    modelId: "gpt-5.5-high-fast",
    sourceType: "own_key",
    accountId: "account-id",
    accountName: "Codex",
    modelType: CLI_AGENT.CODEX,
    ...overrides,
  };
}

const EMPTY_POOL = {
  orgiiPoolEnabled: true,
  orgiiModelSet: new Map(),
  orgiiCategoryIds: new Set<string>(),
};

describe("resolveValidatedLastPair", () => {
  it("keeps the persisted own-key selection before Key Vault finishes loading", () => {
    const selection = resolveValidatedLastPair({
      pair: recentPair(),
      accounts: [],
      accountsLoaded: false,
      ...EMPTY_POOL,
    });

    expect(selection).toMatchObject({
      model: "gpt-5.5-high-fast",
      selectedAccountId: "account-id",
      selectedSourceLabel: "Codex",
    });
  });

  it("returns the validated selection after Key Vault loads", () => {
    const selection = resolveValidatedLastPair({
      pair: recentPair(),
      accounts: [codexAccount()],
      accountsLoaded: true,
      ...EMPTY_POOL,
    });

    expect(selection).toMatchObject({
      model: "gpt-5.5-high-fast",
      selectedAccountId: "account-id",
    });
  });

  it("rejects an incompatible selection only after Key Vault loads", () => {
    const selection = resolveValidatedLastPair({
      pair: recentPair(),
      accounts: [],
      accountsLoaded: true,
      ...EMPTY_POOL,
    });

    expect(selection).toBeNull();
  });
});

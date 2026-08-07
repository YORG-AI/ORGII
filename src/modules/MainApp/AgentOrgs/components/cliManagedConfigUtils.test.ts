import { describe, expect, it } from "vitest";

import type { KeyVaultAccount } from "@src/hooks/keyVault";

import {
  getManagedProxyAccounts,
  getManagedProxyDraftSelection,
  modelIdsFor,
} from "./cliManagedConfigUtils";

function account(
  id: string,
  overrides: Partial<KeyVaultAccount> = {}
): KeyVaultAccount {
  return {
    id,
    hasLocalKey: true,
    isListed: false,
    modelType: "openai_api",
    name: id,
    status: "ready",
    hasKey: true,
    hasApiKey: true,
    hasSessionToken: false,
    enabled: true,
    ...overrides,
  } as KeyVaultAccount;
}

describe("getManagedProxyAccounts", () => {
  it("keeps only enabled API keys approved by backend compatibility", () => {
    const accounts = [
      account("supported"),
      account("wrong-protocol"),
      account("disabled", { enabled: false }),
      account("oauth-only", { hasApiKey: false }),
    ];

    expect(
      getManagedProxyAccounts(accounts, ["supported", "disabled"])
    ).toEqual([accounts[0]]);
  });
});

describe("modelIdsFor", () => {
  it("prefers enabled models and removes duplicates", () => {
    const value = account("key", {
      enabledModels: ["gpt-5", "gpt-5", "gpt-5-mini"],
      availableModels: ["ignored"],
    });

    expect(modelIdsFor(value)).toEqual(["gpt-5", "gpt-5-mini"]);
  });

  it("falls back to available models", () => {
    const value = account("key", {
      enabledModels: [],
      availableModels: ["claude-a", "claude-b"],
    });

    expect(modelIdsFor(value)).toEqual(["claude-a", "claude-b"]);
  });
});

describe("getManagedProxyDraftSelection", () => {
  it("does not carry a stale model onto a different compatible key", () => {
    const accounts = [
      account("openai", { enabledModels: ["gpt-5"] }),
      account("anthropic", { enabledModels: ["claude-sonnet"] }),
    ];

    expect(
      getManagedProxyDraftSelection(accounts, "missing", "claude-sonnet")
    ).toEqual({ keyId: "openai", model: "gpt-5" });
  });

  it("keeps a saved model only when it belongs to the saved key", () => {
    const accounts = [
      account("openai", { enabledModels: ["gpt-5", "gpt-5-mini"] }),
    ];

    expect(
      getManagedProxyDraftSelection(accounts, "openai", "gpt-5-mini")
    ).toEqual({ keyId: "openai", model: "gpt-5-mini" });
  });
});

import { describe, expect, it } from "vitest";

import type { KeyVaultAccount } from "@src/hooks/keyVault";

import { accountHasModel, buildAccountLookup } from "./useModelAccountLookup";

function claudeAccount(
  overrides: Partial<KeyVaultAccount> = {}
): KeyVaultAccount {
  return {
    id: "key-1",
    name: "kate1",
    modelType: "claude_code",
    status: "ready",
    enabled: true,
    availableModels: ["claude-opus-4-8"],
    enabledModels: ["claude-opus-4-8"],
    // Backend-synthesized effort ladder: variant ids exist ONLY here,
    // never in enabledModels/availableModels.
    modelVariants: [
      {
        model: "claude-opus-4-8-high",
        base_model: "claude-opus-4-8",
        reasoning: "high",
        fast: false,
      },
      {
        model: "claude-opus-4-8-max",
        base_model: "claude-opus-4-8",
        reasoning: "max",
        fast: false,
      },
    ],
    ...overrides,
  } as KeyVaultAccount;
}

describe("accountHasModel", () => {
  it("accepts synthesized effort variants whose base model is enabled", () => {
    const account = claudeAccount();
    expect(accountHasModel(account, "claude-opus-4-8")).toBe(true);
    expect(accountHasModel(account, "claude-opus-4-8-high")).toBe(true);
    expect(accountHasModel(account, "claude-opus-4-8-max")).toBe(true);
  });

  it("rejects variants when the base model is not enabled", () => {
    const account = claudeAccount({ enabledModels: [] });
    expect(accountHasModel(account, "claude-opus-4-8-high")).toBe(false);
  });

  it("rejects enabled ids that are no longer in the available catalog", () => {
    const account = claudeAccount({
      availableModels: ["claude-opus-4-7"],
      enabledModels: ["claude-opus-4-8"],
    });

    expect(accountHasModel(account, "claude-opus-4-8")).toBe(false);
    expect(accountHasModel(account, "claude-opus-4-8-high")).toBe(false);
  });

  it("rejects unknown ids and disabled accounts", () => {
    expect(accountHasModel(claudeAccount(), "claude-opus-4-8-xhigh")).toBe(
      false
    );
    expect(
      accountHasModel(claudeAccount({ enabled: false }), "claude-opus-4-8")
    ).toBe(false);
  });
});

describe("buildAccountLookup", () => {
  it("includes synthesized variant ids in the model universe", () => {
    const lookup = buildAccountLookup([claudeAccount()]);
    // Variant ids must be present or groupByModel family expansion can
    // never offer an effort ladder for native Claude keys.
    expect(lookup.has("claude-opus-4-8")).toBe(true);
    expect(lookup.has("claude-opus-4-8-high")).toBe(true);
    expect(lookup.get("claude-opus-4-8-high")?.agentTypes).toEqual([
      "claude_code",
    ]);
  });

  it("does not leak variants of disabled base models", () => {
    const lookup = buildAccountLookup([claudeAccount({ enabledModels: [] })]);
    expect(lookup.has("claude-opus-4-8-high")).toBe(false);
  });

  it("does not count stale enabled ids from a different account catalog", () => {
    const stale = claudeAccount({
      id: "stale-key",
      availableModels: ["claude-opus-4-7"],
      enabledModels: ["claude-opus-4-8"],
    });
    const lookup = buildAccountLookup([claudeAccount(), stale]);

    expect(lookup.get("claude-opus-4-8")?.totalKeys).toBe(1);
  });
});

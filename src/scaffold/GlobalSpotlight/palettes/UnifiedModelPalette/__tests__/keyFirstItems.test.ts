import { describe, expect, it, vi } from "vitest";

import type { KeyVaultAccount } from "@src/hooks/keyVault/types";

import {
  buildKeyItems,
  buildKeyModelItems,
  enabledAccountModelIds,
  selectableKeyAccounts,
} from "../keyFirstItems";

function makeAccount(overrides: Partial<KeyVaultAccount>): KeyVaultAccount {
  const models = overrides.availableModels ?? [];
  return {
    id: "acct",
    name: "OpenAI",
    modelType: "openai",
    status: "ready",
    hasKey: true,
    hasApiKey: true,
    hasSessionToken: false,
    hasLocalKey: true,
    isListed: false,
    enabled: true,
    availableModels: models,
    enabledModels: models,
    ...overrides,
  } as KeyVaultAccount;
}

describe("selectableKeyAccounts", () => {
  it("keeps only ready keys that can launch at least one model", () => {
    const withModels = makeAccount({ id: "a", availableModels: ["gpt-5"] });
    const noModels = makeAccount({ id: "b" });
    const notReady = makeAccount({
      id: "c",
      status: "error" as KeyVaultAccount["status"],
      availableModels: ["gpt-5"],
    });
    const disabled = makeAccount({
      id: "d",
      enabled: false,
      availableModels: ["gpt-5"],
    });

    expect(
      selectableKeyAccounts([withModels, noModels, notReady, disabled], false)
    ).toEqual([withModels]);
  });

  it("keeps model-less keys for CLI agents", () => {
    const noModels = makeAccount({ id: "b" });
    expect(selectableKeyAccounts([noModels], true)).toEqual([noModels]);
  });
});

describe("buildKeyItems", () => {
  it("lists keys under the All Models section with a family count", () => {
    const account = makeAccount({
      id: "a",
      availableModels: ["gpt-5-high", "gpt-5-low", "claude-sonnet-4-5"],
    });
    const [item] = buildKeyItems({
      accounts: [account],
      isCliAgent: false,
      onSelectKey: vi.fn(),
      onCommit: vi.fn(),
    });

    expect(item.id).toBe("key:a");
    expect(item.label).toBe("OpenAI");
    expect(item.data?.modelSection).toBe("all");
    expect(item.data?.keyAccountId).toBe("a");
    expect(item.data?.showDisclosureChevron).toBe(true);
  });

  it("hands a key with models to the models column on select", () => {
    const account = makeAccount({ id: "a", availableModels: ["gpt-5"] });
    const onSelectKey = vi.fn();
    const onCommit = vi.fn();
    const [item] = buildKeyItems({
      accounts: [account],
      isCliAgent: true,
      onSelectKey,
      onCommit,
    });

    item.action?.();

    expect(onSelectKey).toHaveBeenCalledWith("a");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("commits a model-less CLI key directly", () => {
    const account = makeAccount({ id: "a" });
    const onSelectKey = vi.fn();
    const onCommit = vi.fn();
    const [item] = buildKeyItems({
      accounts: [account],
      isCliAgent: true,
      onSelectKey,
      onCommit,
    });

    expect(item.data?.showDisclosureChevron).toBe(false);
    item.action?.();

    expect(onCommit).toHaveBeenCalledWith(account, "");
    expect(onSelectKey).not.toHaveBeenCalled();
  });
});

describe("buildKeyModelItems", () => {
  it("emits one row per model family and commits the family's launch model", () => {
    const account = makeAccount({
      id: "a",
      availableModels: ["gpt-5-high", "gpt-5-low", "claude-sonnet-4-5"],
    });
    const onCommit = vi.fn();
    const items = buildKeyModelItems({
      account,
      onCommit,
      persistDefaultVariantForAccount: vi.fn(),
    });

    expect(items).toHaveLength(2);
    const gptRow = items.find((item) =>
      (item.data?.groupModelIds as string[]).includes("gpt-5-high")
    );
    expect(gptRow).toBeDefined();
    expect(gptRow?.data?.groupModelIds).toEqual(
      expect.arrayContaining(["gpt-5-high", "gpt-5-low"])
    );

    gptRow?.action?.();
    expect(onCommit).toHaveBeenCalledWith(
      account,
      gptRow?.data?.modelId as string
    );
  });

  it("launches the key's persisted default variant", () => {
    const account = makeAccount({
      id: "a",
      availableModels: ["gpt-5-high", "gpt-5-low"],
      defaultVariants: [{ base_model: "gpt-5", model: "gpt-5-low" }],
    });
    const onCommit = vi.fn();
    const [row] = buildKeyModelItems({
      account,
      onCommit,
      persistDefaultVariantForAccount: vi.fn(),
    });

    expect(row.data?.modelId).toBe("gpt-5-low");
    row.action?.();
    expect(onCommit).toHaveBeenCalledWith(account, "gpt-5-low");
  });

  it("returns nothing for a key with no enabled models", () => {
    const account = makeAccount({
      id: "a",
      availableModels: ["gpt-5"],
      enabledModels: [],
    });
    expect(enabledAccountModelIds(account)).toEqual([]);
    expect(
      buildKeyModelItems({
        account,
        onCommit: vi.fn(),
        persistDefaultVariantForAccount: vi.fn(),
      })
    ).toEqual([]);
  });
});

it("custom API labels stay key-scoped while selection uses each exact request ID", async () => {
  const { replaceModelAliasesFromKeys } =
    await import("@src/hooks/models/modelAliasRegistry");
  replaceModelAliasesFromKeys([
    {
      id: "a",
      model_aliases: [{ alias: "deployment-high", display_name: "Production" }],
    },
    {
      id: "b",
      model_aliases: [
        { alias: "deployment-high", display_name: "Development" },
      ],
    },
  ]);
  try {
    const account = makeAccount({
      id: "a",
      modelType: "custom_api",
      availableModels: [
        "deployment-high",
        "deployment-low",
        "new-provider/model-2026-09-01",
      ],
    });
    const onCommit = vi.fn();
    const items = buildKeyModelItems({
      account,
      onCommit,
      persistDefaultVariantForAccount: vi.fn(),
    });
    expect(items).toHaveLength(3);
    expect(new Set(items.map((item) => item.id)).size).toBe(3);
    for (const item of items) {
      item.action?.();
      expect(onCommit).toHaveBeenLastCalledWith(account, item.data?.modelId);
    }
    const row = items.find((item) => item.data?.modelId === "deployment-high");
    expect(row?.label).toContain("Production");
    expect(row?.label).not.toContain("Development");
  } finally {
    replaceModelAliasesFromKeys([]);
  }
});

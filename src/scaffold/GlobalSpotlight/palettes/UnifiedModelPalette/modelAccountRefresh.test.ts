import { describe, expect, it, vi } from "vitest";

import type { KeyVaultAccount } from "@src/hooks/keyVault";

import { refreshModelAccounts } from "./modelAccountRefresh";

describe("refreshModelAccounts", () => {
  it("reloads the Key Vault instead of no-oping when the account list is empty", async () => {
    const reloadAccounts = vi.fn(async () => undefined);
    const refreshLoadedAccounts = vi.fn(async () => ({
      total: 0,
      failed: 0,
      added: 0,
      removed: 0,
    }));

    const summary = await refreshModelAccounts(
      [],
      reloadAccounts,
      refreshLoadedAccounts
    );

    expect(summary).toBeNull();
    expect(reloadAccounts).toHaveBeenCalledOnce();
    expect(refreshLoadedAccounts).not.toHaveBeenCalled();
  });

  it("refreshes loaded model catalogs before reloading persisted accounts", async () => {
    const account = { id: "account-1" } as KeyVaultAccount;
    const calls: string[] = [];
    const refreshLoadedAccounts = vi.fn(async () => {
      calls.push("models");
      return { total: 1, failed: 0, added: 2, removed: 1 };
    });
    const reloadAccounts = vi.fn(async () => {
      calls.push("accounts");
    });

    const summary = await refreshModelAccounts(
      [account],
      reloadAccounts,
      refreshLoadedAccounts
    );

    expect(summary).toEqual({ total: 1, failed: 0, added: 2, removed: 1 });
    expect(calls).toEqual(["models", "accounts"]);
  });
});

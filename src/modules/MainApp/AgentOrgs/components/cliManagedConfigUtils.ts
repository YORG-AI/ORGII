import type { KeyVaultAccount } from "@src/hooks/keyVault";

export function modelIdsFor(account: KeyVaultAccount | undefined): string[] {
  if (!account) return [];
  const available = account.availableModels ?? [];
  const availableSet = new Set(available);
  const enabledAvailable = (account.enabledModels ?? []).filter((model) =>
    availableSet.has(model)
  );
  const models = enabledAvailable.length > 0 ? enabledAvailable : available;
  return Array.from(new Set(models.filter(Boolean)));
}

export function getManagedProxyAccounts(
  credentials: KeyVaultAccount[],
  compatibleKeyIds?: readonly string[]
): KeyVaultAccount[] {
  const allowed = compatibleKeyIds ? new Set(compatibleKeyIds) : undefined;
  return credentials.filter(
    (account) =>
      account.enabled !== false &&
      account.hasApiKey === true &&
      (allowed === undefined || allowed.has(account.id))
  );
}

export function getManagedProxyDraftSelection(
  accounts: KeyVaultAccount[],
  preferredKeyId?: string | null,
  preferredModel?: string | null
): { keyId: string; model: string } {
  const preferredAccount = accounts.find(
    (account) => account.id === preferredKeyId
  );
  const account = preferredAccount ?? accounts[0];
  if (!account) return { keyId: "", model: "" };

  const models = modelIdsFor(account);
  const model =
    preferredAccount && preferredModel && models.includes(preferredModel)
      ? preferredModel
      : (models[0] ?? "");
  return { keyId: account.id, model };
}

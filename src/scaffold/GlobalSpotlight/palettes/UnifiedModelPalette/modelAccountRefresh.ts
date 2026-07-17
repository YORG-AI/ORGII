import type { KeyVaultAccount } from "@src/hooks/keyVault";
import {
  type RefreshAllAccountModelsSummary,
  refreshAllAccountModels,
} from "@src/modules/MainApp/Integrations/KeyVault/hooks/refreshAccountModels";

type ReloadAccounts = () => Promise<void>;
type RefreshLoadedAccounts = (
  accounts: KeyVaultAccount[]
) => Promise<RefreshAllAccountModelsSummary>;

/**
 * Recover the account list when it is empty; otherwise refresh every loaded
 * account's model catalog and then reload the persisted Key Vault state.
 */
export async function refreshModelAccounts(
  accounts: KeyVaultAccount[],
  reloadAccounts: ReloadAccounts,
  refreshLoadedAccounts: RefreshLoadedAccounts = refreshAllAccountModels
): Promise<RefreshAllAccountModelsSummary | null> {
  if (accounts.length === 0) {
    await reloadAccounts();
    return null;
  }

  const summary = await refreshLoadedAccounts(accounts);
  await reloadAccounts();
  return summary;
}

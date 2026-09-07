/** Accounts that represent an enabled, executable local credential. */
export function credentialedAccounts<
  T extends { enabled: boolean; hasKey: boolean },
>(accounts: readonly T[]): T[] {
  return accounts.filter((account) => account.enabled && account.hasKey);
}

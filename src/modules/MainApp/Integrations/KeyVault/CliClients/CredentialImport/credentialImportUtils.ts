import type {
  CredentialSuggestion,
  SuggestionSourceKind,
} from "@src/api/services/keyValidation";

/** Stable table row key — the probe already guarantees `id` uniqueness. */
export function credentialImportRowKey(row: Pick<CredentialSuggestion, "id">) {
  return row.id;
}

/**
 * i18n key (under the `integrations` namespace) for a suggestion's source
 * kind. Kept as a lookup so an unknown kind from a newer backend falls back
 * to the raw value instead of an empty label.
 */
export const SOURCE_KIND_LABEL_KEY: Record<SuggestionSourceKind, string> = {
  env: "credentialImport.sourceKind.env",
  shell_profile: "credentialImport.sourceKind.shell_profile",
  config_file: "credentialImport.sourceKind.config_file",
  oauth_store: "credentialImport.sourceKind.oauth_store",
  keychain: "credentialImport.sourceKind.keychain",
  state_db: "credentialImport.sourceKind.state_db",
  cc_switch: "credentialImport.sourceKind.cc_switch",
};

/** Suggestions that still need importing (the vault lacks their secret). */
export function importableSuggestions<T extends CredentialSuggestion>(
  items: readonly T[]
): T[] {
  return items.filter((item) => !item.alreadyImported);
}

/**
 * Sort: OAuth login stores first (richest import), then by agent, then by
 * source label, so the same agent's env + profile rows sit together.
 */
export function sortSuggestions<T extends CredentialSuggestion>(
  rows: T[]
): T[] {
  const kindRank: Record<SuggestionSourceKind, number> = {
    oauth_store: 0,
    keychain: 0,
    state_db: 0,
    cc_switch: 1,
    config_file: 1,
    env: 2,
    shell_profile: 3,
  };
  return [...rows].sort((a, b) => {
    const agentCmp = a.agentType.localeCompare(b.agentType);
    if (agentCmp !== 0) return agentCmp;
    const rankCmp =
      (kindRank[a.sourceKind] ?? 9) - (kindRank[b.sourceKind] ?? 9);
    if (rankCmp !== 0) return rankCmp;
    return a.sourceLabel.localeCompare(b.sourceLabel);
  });
}

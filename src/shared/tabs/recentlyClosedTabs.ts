export const RECENTLY_CLOSED_TABS_LIMIT = 5;

interface TabIdentity {
  id: string;
}

/**
 * Put newly closed tabs at the front, de-duplicate reopened/reclosed entries,
 * and keep the app-lifetime history bounded.
 *
 * `closedTabs` follows close order (oldest to newest). Bulk close callers can
 * therefore pass their natural iteration order and the last closed tab becomes
 * the first restore option.
 */
export function prependRecentlyClosedTabs<T extends TabIdentity>(
  current: readonly T[],
  closedTabs: readonly T[]
): T[] {
  if (closedTabs.length === 0) return [...current];

  const closedIds = new Set(closedTabs.map((tab) => tab.id));
  return [
    ...[...closedTabs].reverse(),
    ...current.filter((tab) => !closedIds.has(tab.id)),
  ].slice(0, RECENTLY_CLOSED_TABS_LIMIT);
}

export function removeRecentlyClosedTab<T extends TabIdentity>(
  current: readonly T[],
  tabId: string
): T[] {
  return current.filter((tab) => tab.id !== tabId);
}

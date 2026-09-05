export const RECENT_TABS_LIMIT = 5;

interface TabIdentity {
  id: string;
}

/** Put one tab at the front of a bounded, de-duplicated MRU history. */
export function recordRecentTab<T extends TabIdentity>(
  current: readonly T[],
  tab: T
): T[] {
  return [tab, ...current.filter((candidate) => candidate.id !== tab.id)].slice(
    0,
    RECENT_TABS_LIMIT
  );
}

export function removeRecentTab<T extends TabIdentity>(
  current: readonly T[],
  tabId: string
): T[] {
  return current.filter((tab) => tab.id !== tabId);
}

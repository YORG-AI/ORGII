import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

import type { TeamInboxItem } from "./domain";

export interface TeamInboxCacheState {
  items: TeamInboxItem[];
  unreadCount: number;
  loading: boolean;
  error: string | null;
  revision: number;
  loadedForViewerKey: string | null;
  /** True when either the local or cloud source still has a next page. */
  hasMore: boolean;
}

export const teamInboxCacheAtom = atom<TeamInboxCacheState>({
  items: [],
  unreadCount: 0,
  loading: false,
  error: null,
  revision: 0,
  loadedForViewerKey: null,
  hasMore: false,
});
teamInboxCacheAtom.debugLabel = "teamInboxCacheAtom";

export const teamInboxUnreadCountAtom = atom(
  (get) => get(teamInboxCacheAtom).unreadCount
);
teamInboxUnreadCountAtom.debugLabel = "teamInboxUnreadCountAtom";

export const teamInboxInvalidationAtom = atom(0);
teamInboxInvalidationAtom.debugLabel = "teamInboxInvalidationAtom";

export type TeamInboxCloudReadReceipts = Record<string, string>;
export const MAX_TEAM_INBOX_CLOUD_READ_RECEIPTS = 1_000;

export function addTeamInboxCloudReadReceipts(
  current: TeamInboxCloudReadReceipts,
  additions: TeamInboxCloudReadReceipts
): TeamInboxCloudReadReceipts {
  const next = { ...current };
  for (const [key, readAt] of Object.entries(additions)) {
    delete next[key];
    next[key] = readAt;
  }
  const keys = Object.keys(next);
  for (
    let index = 0;
    index < keys.length - MAX_TEAM_INBOX_CLOUD_READ_RECEIPTS;
    index += 1
  ) {
    delete next[keys[index]!];
  }
  return next;
}

export function removeTeamInboxCloudReadReceipts(
  current: TeamInboxCloudReadReceipts,
  keys: readonly string[]
): TeamInboxCloudReadReceipts {
  if (keys.length === 0) return current;
  let changed = false;
  const next = { ...current };
  for (const key of keys) {
    if (key in next) {
      delete next[key];
      changed = true;
    }
  }
  return changed ? next : current;
}

export const teamInboxCloudReadReceiptsAtom =
  atomWithStorage<TeamInboxCloudReadReceipts>(
    "orgii:team-inbox:cloud-read-receipts",
    {},
    undefined,
    { getOnInit: true }
  );
teamInboxCloudReadReceiptsAtom.debugLabel = "teamInboxCloudReadReceiptsAtom";

export const invalidateTeamInboxAtom = atom(null, (get, set) => {
  set(teamInboxInvalidationAtom, get(teamInboxInvalidationAtom) + 1);
});
invalidateTeamInboxAtom.debugLabel = "invalidateTeamInboxAtom";

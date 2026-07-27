import { atom } from "jotai";

import type { TeamInboxItem } from "./domain";
import type { TeamInboxUnreadCounts } from "./domain";

export interface TeamInboxCacheState {
  items: TeamInboxItem[];
  unreadCount: number;
  unreadCounts: TeamInboxUnreadCounts;
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
  unreadCounts: { all: 0, mentions: 0, assigned: 0 },
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

export const invalidateTeamInboxAtom = atom(null, (get, set) => {
  set(teamInboxInvalidationAtom, get(teamInboxInvalidationAtom) + 1);
});
invalidateTeamInboxAtom.debugLabel = "invalidateTeamInboxAtom";

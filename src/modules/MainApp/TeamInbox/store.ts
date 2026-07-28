import { atom } from "jotai";

import type { SessionReferenceOpen } from "@src/shared/dnd/sessionTabDrag";

import type { TeamInboxItem } from "./domain";
import type { TeamInboxIssue } from "./domain";
import type { TeamInboxUnreadCounts } from "./domain";

export interface TeamInboxCacheState {
  items: TeamInboxItem[];
  unreadCount: number;
  unreadCounts: TeamInboxUnreadCounts;
  loading: boolean;
  issue: TeamInboxIssue | null;
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
  issue: null,
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

export interface TeamInboxSessionHandoffRequest extends SessionReferenceOpen {
  requestId: number;
}

const teamInboxSessionHandoffRequestSequenceAtom = atom(0);

export const teamInboxSessionHandoffRequestAtom =
  atom<TeamInboxSessionHandoffRequest | null>(null);
teamInboxSessionHandoffRequestAtom.debugLabel =
  "teamInboxSessionHandoffRequestAtom";

export const requestTeamInboxSessionHandoffAtom = atom(
  null,
  (get, set, reference: SessionReferenceOpen) => {
    const requestId = get(teamInboxSessionHandoffRequestSequenceAtom) + 1;
    set(teamInboxSessionHandoffRequestSequenceAtom, requestId);
    set(teamInboxSessionHandoffRequestAtom, { ...reference, requestId });
  }
);
requestTeamInboxSessionHandoffAtom.debugLabel =
  "requestTeamInboxSessionHandoffAtom";

export const consumeTeamInboxSessionHandoffRequestAtom = atom(
  null,
  (get, set, requestId: number) => {
    if (get(teamInboxSessionHandoffRequestAtom)?.requestId === requestId) {
      set(teamInboxSessionHandoffRequestAtom, null);
    }
  }
);
consumeTeamInboxSessionHandoffRequestAtom.debugLabel =
  "consumeTeamInboxSessionHandoffRequestAtom";

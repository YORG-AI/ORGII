import { atom } from "jotai";

import type { SessionReferenceOpen } from "@src/shared/dnd/sessionTabDrag";

import type {
  TeamInboxFilter,
  TeamInboxIssue,
  TeamInboxItem,
  TeamInboxUnreadCounts,
} from "./domain";

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

/**
 * Small, in-memory navigation state for the singleton Inbox tab. The surface
 * itself intentionally unmounts while another chat-panel tab is active, so
 * user context must live above the component without keeping its data-source
 * effects or subscriptions alive in the background.
 */
export interface TeamInboxViewState {
  filter: TeamInboxFilter;
  query: string;
  selectedItemId: string | null;
  selectedPullRequestKey: string | null;
  supersededFocusRequestId: number | null;
}

export const INITIAL_TEAM_INBOX_VIEW_STATE: TeamInboxViewState = {
  filter: "all",
  query: "",
  selectedItemId: null,
  selectedPullRequestKey: null,
  supersededFocusRequestId: null,
};

export const teamInboxViewStateAtom = atom<TeamInboxViewState>(
  INITIAL_TEAM_INBOX_VIEW_STATE
);
teamInboxViewStateAtom.debugLabel = "teamInboxViewStateAtom";

export const teamInboxInvalidationAtom = atom(0);
teamInboxInvalidationAtom.debugLabel = "teamInboxInvalidationAtom";

export const invalidateTeamInboxAtom = atom(null, (get, set) => {
  set(teamInboxInvalidationAtom, get(teamInboxInvalidationAtom) + 1);
});
invalidateTeamInboxAtom.debugLabel = "invalidateTeamInboxAtom";

export interface TeamInboxItemFocusRequest {
  itemKey: string;
  requestId: number;
}

const teamInboxItemFocusRequestSequenceAtom = atom(0);

export const teamInboxItemFocusRequestAtom =
  atom<TeamInboxItemFocusRequest | null>(null);
teamInboxItemFocusRequestAtom.debugLabel = "teamInboxItemFocusRequestAtom";

export const requestTeamInboxItemFocusAtom = atom(
  null,
  (get, set, itemKey: string) => {
    const requestId = get(teamInboxItemFocusRequestSequenceAtom) + 1;
    set(teamInboxItemFocusRequestSequenceAtom, requestId);
    set(teamInboxItemFocusRequestAtom, { itemKey, requestId });
  }
);
requestTeamInboxItemFocusAtom.debugLabel = "requestTeamInboxItemFocusAtom";

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

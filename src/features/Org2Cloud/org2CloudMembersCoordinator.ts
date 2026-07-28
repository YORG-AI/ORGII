import type { createStore } from "jotai";

import {
  type Org2CloudAuthState,
  org2CloudAuthIdentityKey,
} from "./org2CloudAuthAtom";
import {
  type CloudOrgMember,
  ensureFreshSession,
  listOrgMembers,
} from "./org2CloudClient";

const ROSTER_CACHE_TTL_MS = 60_000;
export const MAX_ROSTER_CACHE_ENTRIES = 64;

type JotaiStore = ReturnType<typeof createStore>;

interface RosterCacheEntry {
  members: CloudOrgMember[];
  rosterVersion: number;
  expiresAt: number;
}

export interface CloudOrgMembersResult {
  auth: Org2CloudAuthState;
  members: CloudOrgMember[];
}

export interface LoadCloudOrgMembersOptions {
  /**
   * Ignore a completed TTL cache entry, while still joining an equal/newer
   * in-flight request. Used by the open-panel dropped-Realtime fallback.
   */
  force?: boolean;
}

interface InFlightRosterRequest {
  rosterVersion: number;
  promise: Promise<CloudOrgMembersResult | null>;
}

interface RosterCoordinatorState {
  cache: Map<string, RosterCacheEntry>;
  inFlight: Map<string, InFlightRosterRequest>;
}

let stateByStore = new WeakMap<JotaiStore, RosterCoordinatorState>();

function stateFor(store: JotaiStore): RosterCoordinatorState {
  let state = stateByStore.get(store);
  if (!state) {
    state = { cache: new Map(), inFlight: new Map() };
    stateByStore.set(store, state);
  }
  return state;
}

function rosterKey(auth: Org2CloudAuthState, orgId: string): string {
  return `${org2CloudAuthIdentityKey(auth)}|${orgId}`;
}

function cacheRoster(
  cache: Map<string, RosterCacheEntry>,
  key: string,
  entry: RosterCacheEntry
): void {
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > MAX_ROSTER_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

/**
 * One identity-aware, version-aware roster read shared by every rendered
 * consumer. Sidebar, management, share dialogs, and work-item locks can mount
 * together without issuing duplicate list_org_members requests.
 */
export async function loadCloudOrgMembers(
  store: JotaiStore,
  auth: Org2CloudAuthState,
  orgId: string,
  rosterVersion = 0,
  options: LoadCloudOrgMembersOptions = {}
): Promise<CloudOrgMembersResult | null> {
  const state = stateFor(store);
  const key = rosterKey(auth, orgId);
  const cached = state.cache.get(key);
  if (
    !options.force &&
    cached &&
    cached.expiresAt > Date.now() &&
    cached.rosterVersion >= rosterVersion
  ) {
    state.cache.delete(key);
    state.cache.set(key, cached);
    return { auth, members: cached.members };
  }

  const pending = state.inFlight.get(key);
  if (pending && pending.rosterVersion >= rosterVersion) {
    return pending.promise;
  }

  const request: InFlightRosterRequest = {
    rosterVersion,
    promise: Promise.resolve(null),
  };
  request.promise = (async () => {
    const fresh = await ensureFreshSession(auth);
    if (!fresh) return null;
    const members = await listOrgMembers(fresh.accessToken, orgId);
    if (state.inFlight.get(key) === request) {
      cacheRoster(state.cache, key, {
        members,
        rosterVersion,
        expiresAt: Date.now() + ROSTER_CACHE_TTL_MS,
      });
    }
    return { auth: fresh, members };
  })().finally(() => {
    if (state.inFlight.get(key) === request) {
      state.inFlight.delete(key);
    }
  });
  state.inFlight.set(key, request);
  return request.promise;
}

/** Test/store-disposal support; identity-keying prevents cross-account reads. */
export function clearCloudOrgMembersCache(store?: JotaiStore): void {
  if (store) {
    stateByStore.delete(store);
    return;
  }
  stateByStore = new WeakMap<JotaiStore, RosterCoordinatorState>();
}

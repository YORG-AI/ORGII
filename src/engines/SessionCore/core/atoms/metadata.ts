/**
 * Session Metadata Atoms
 *
 * Session ID, loading status, cache status, and other metadata.
 */
import { type Atom, atom } from "jotai";

import { createStableWeakLruCache } from "@src/util/core/state/stableWeakLruCache";

import type { SessionEvent, SessionLoadStatus, SessionSpec } from "../types";

const MAX_SESSION_RELOAD_EPOCH_ENTRIES = 200;

// ============================================
// Session Metadata
// ============================================

/**
 * Current session ID.
 */
export const sessionIdAtom = atom<string | null>(null);
sessionIdAtom.debugLabel = "session/sessionId";

/**
 * Session loading status.
 */
export const loadStatusAtom = atom<SessionLoadStatus>("idle");
loadStatusAtom.debugLabel = "session/loadStatus";

export const loadErrorAtom = atom<string | null>(null);
loadErrorAtom.debugLabel = "session/loadError";

export const sessionReloadEpochMapAtom = atom<Map<string, number>>(new Map());
sessionReloadEpochMapAtom.debugLabel = "session/reloadEpochMap";

/**
 * Bumped whenever the on-screen session's transcript is swapped wholesale by
 * a `replace` reload (windowed imported refresh, native-transcript
 * reconcile). A replace demotes lazily-fetched turn bodies back to
 * `unloadedTurn` placeholders, so any component-level "already loaded"
 * accounting must reset and refetch the visible window when this changes.
 */
export const transcriptReplaceEpochAtom = atom(0);
transcriptReplaceEpochAtom.debugLabel = "session/transcriptReplaceEpoch";

export const triggerSessionReloadAtom = atom(
  null,
  (get, set, sessionId: string) => {
    const current = get(sessionReloadEpochMapAtom);
    const next = new Map(current);
    if (next.size >= MAX_SESSION_RELOAD_EPOCH_ENTRIES && !next.has(sessionId)) {
      const firstKey = next.keys().next().value;
      if (firstKey) next.delete(firstKey);
    }
    next.set(sessionId, (current.get(sessionId) ?? 0) + 1);
    set(sessionReloadEpochMapAtom, next);
  }
);
triggerSessionReloadAtom.debugLabel = "session/triggerReload";

/**
 * User-requested session hydrations that are still fetching their initial
 * transcript. Entries exist only while work is in flight; counts preserve the
 * loading state when two surfaces request the same session concurrently.
 */
export interface SessionHydrationState {
  count: number;
  iconId?: string;
}

export const sessionHydrationCountMapAtom = atom<
  ReadonlyMap<string, SessionHydrationState>
>(new Map());
sessionHydrationCountMapAtom.debugLabel = "session/hydrationCountMap";

const sessionHydrationByIdCache =
  createStableWeakLruCache<Atom<SessionHydrationState | undefined>>(100);

/** Narrow, LRU-bounded view used by the active Chat Pane and tab icons. */
export function sessionHydrationByIdAtom(
  sessionId: string
): Atom<SessionHydrationState | undefined> {
  const cached = sessionHydrationByIdCache.get(sessionId);
  if (cached) return cached;
  const scopedAtom = atom((get) =>
    get(sessionHydrationCountMapAtom).get(sessionId)
  );
  scopedAtom.debugLabel = `session/hydration:${sessionId}`;
  sessionHydrationByIdCache.set(sessionId, scopedAtom);
  return scopedAtom;
}

export const beginSessionHydrationAtom = atom(
  null,
  (get, set, payload: string | { sessionId: string; iconId?: string }) => {
    const { sessionId, iconId } =
      typeof payload === "string" ? { sessionId: payload } : payload;
    if (!sessionId) return;
    const current = get(sessionHydrationCountMapAtom);
    const currentEntry = current.get(sessionId);
    const next = new Map(current);
    next.set(sessionId, {
      count: (currentEntry?.count ?? 0) + 1,
      iconId: iconId ?? currentEntry?.iconId,
    });
    set(sessionHydrationCountMapAtom, next);
  }
);
beginSessionHydrationAtom.debugLabel = "session/beginHydration";

export const endSessionHydrationAtom = atom(
  null,
  (get, set, sessionId: string) => {
    if (!sessionId) return;
    const current = get(sessionHydrationCountMapAtom);
    const entry = current.get(sessionId);
    const count = entry?.count ?? 0;
    if (count === 0) return;
    const next = new Map(current);
    if (count === 1) next.delete(sessionId);
    else next.set(sessionId, { ...entry, count: count - 1 });
    set(sessionHydrationCountMapAtom, next);
  }
);
endSessionHydrationAtom.debugLabel = "session/endHydration";

// ============================================
// Cache Status
// ============================================

/**
 * Whether current data came from cache.
 */
export const isFromCacheAtom = atom<boolean>(false);
isFromCacheAtom.debugLabel = "session/isFromCache";

/**
 * Last time data was fetched from network.
 */
export const lastFetchedAtom = atom<number | null>(null);
lastFetchedAtom.debugLabel = "session/lastFetched";

/**
 * Whether there are more events to load (pagination).
 */
export const hasMoreEventsAtom = atom<boolean>(false);
hasMoreEventsAtom.debugLabel = "session/hasMoreEvents";

/**
 * Whether currently loading more events.
 */
export const isLoadingMoreAtom = atom<boolean>(false);
isLoadingMoreAtom.debugLabel = "session/isLoadingMore";

// ============================================
// Pending Synthetic User Event
// ============================================

/**
 * Holds the synthetic user event injected by launchSession so it survives
 * clearSessionAtom. loadSessionAtom consumes and merges it when the real
 * data arrives, then clears the atom.
 */
export const pendingSyntheticEventAtom = atom<SessionEvent | null>(null);
pendingSyntheticEventAtom.debugLabel = "session/pendingSyntheticEvent";

// ============================================
// Spec List (for replay bar segments)
// ============================================

export const specsAtom = atom<SessionSpec[]>([]);
specsAtom.debugLabel = "session/specs";

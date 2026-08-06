/**
 * Session Atoms
 *
 * Core and derived Jotai atoms for session state.
 */
import { type Atom, atom } from "jotai";

import { isActiveStatus, isTerminalStatus } from "@src/types/session/session";

import { loadPersistedSessions } from "./persistence";
import type { Session, SessionGroups } from "./types";

// ============================================
// Storage Keys
// ============================================

export const SESSION_STORAGE_KEYS = {
  lastRefresh: "orgii_sessions_last_refresh",
} as const;

export const SESSION_CACHE_INVALIDATION_KEY =
  "orgii_session_cache_invalidated_at";
export const SESSION_CACHE_INVALIDATED_EVENT = "session-cache-invalidated";

// ============================================
// Core Atoms
// ============================================

// Entity cache, not the Sidebar's authoritative roster. It is hydrated
// synchronously from localStorage so known sessions can render on cold start;
// paginated list membership lives in `sessionPaginationAtom` and is combined
// with these records by the Sidebar projection.
export const sessionsAtom = atom<Session[]>(loadPersistedSessions());
sessionsAtom.debugLabel = "sessionsAtom";

export const sessionLoadingAtom = atom<boolean>(false);
sessionLoadingAtom.debugLabel = "sessionLoadingAtom";

export const sessionErrorAtom = atom<string | null>(null);
sessionErrorAtom.debugLabel = "sessionErrorAtom";

export const sessionLastLoadedAtom = atom<number | null>(null);
sessionLastLoadedAtom.debugLabel = "sessionLastLoadedAtom";

export const sessionFlatListLastLoadedBySignatureAtom = atom<
  Record<string, number>
>({});
sessionFlatListLastLoadedBySignatureAtom.debugLabel =
  "sessionFlatListLastLoadedBySignatureAtom";

// ============================================
// Derived Atoms
// ============================================

// Closure-based cache: avoids module-level mutable state (singleton hazard
// with multiple Jotai stores). The closure variables are private to each atom
// instance and are reset whenever the module is re-evaluated (HMR, tests).
export const validSessionIdsAtom = (() => {
  let prevSessions: Session[] = [];
  let prevIds = new Set<string>();
  return atom((get) => {
    const sessions = get(sessionsAtom);
    if (sessions === prevSessions) return prevIds;
    const newIds = new Set(sessions.map((s) => s.session_id));
    if (
      newIds.size === prevIds.size &&
      sessions.every((s) => prevIds.has(s.session_id))
    ) {
      prevSessions = sessions;
      return prevIds;
    }
    prevSessions = sessions;
    prevIds = newIds;
    return newIds;
  });
})();
validSessionIdsAtom.debugLabel = "validSessionIdsAtom";

// Map for O(1) session lookups by ID
export const sessionMapAtom = (() => {
  let prevSessions: Session[] = [];
  let prevMap = new Map<string, Session>();
  return atom<Map<string, Session>>((get) => {
    const sessions = get(sessionsAtom);
    if (sessions === prevSessions) return prevMap;
    prevSessions = sessions;
    prevMap = new Map(sessions.map((s) => [s.session_id, s]));
    return prevMap;
  });
})();
sessionMapAtom.debugLabel = "sessionMapAtom";

export const getSessionByIdAtom = atom((get) => {
  const sessionMap = get(sessionMapAtom);
  return (sessionId: string) => sessionMap.get(sessionId);
});
getSessionByIdAtom.debugLabel = "getSessionByIdAtom";

/**
 * Per-ID session atom factory with stable instances.
 *
 * Returns a cached derived atom that resolves a single session by ID
 * from `sessionMapAtom`. Components that only need one session should
 * use `useAtomValue(sessionByIdAtom(id))` instead of subscribing to
 * the full `sessionsAtom` array.
 *
 * The atom instance is cached by ID so repeated calls with the same ID
 * return the same Jotai atom (critical for stable subscriptions).
 * Jotai's equality check prevents downstream re-renders when the
 * session object reference is unchanged (which `sessionMapAtom`
 * guarantees via its reference-stability cache).
 */
// LRU cap: evict the oldest entry when the cache exceeds this size.
// Without a cap the Map grows by one Jotai atom per unique sessionId ever
// seen — an unbounded leak for long-running sessions over multiple days.
const SESSION_BY_ID_CACHE_MAX = 500;
const _sessionByIdCache = new Map<string, Atom<Session | undefined>>();

export function sessionByIdAtom(sessionId: string): Atom<Session | undefined> {
  const cached = _sessionByIdCache.get(sessionId);
  if (cached) {
    // Move to end (most-recently-used) by re-inserting.
    _sessionByIdCache.delete(sessionId);
    _sessionByIdCache.set(sessionId, cached);
    return cached;
  }

  const derived = atom<Session | undefined>((get) => {
    const sessionMap = get(sessionMapAtom);
    return sessionMap.get(sessionId);
  });
  derived.debugLabel = `session:${sessionId}`;

  if (_sessionByIdCache.size >= SESSION_BY_ID_CACHE_MAX) {
    // Evict least-recently-used (first inserted) entry.
    const lruKey = _sessionByIdCache.keys().next().value;
    if (lruKey !== undefined) _sessionByIdCache.delete(lruKey);
  }

  _sessionByIdCache.set(sessionId, derived);
  return derived;
}

// ============================================
// Single-pass session grouping
// ============================================

const sessionGroupsAtom = (() => {
  let prevSessions: Session[] = [];
  let prevGroups: SessionGroups | null = null;
  return atom<SessionGroups>((get) => {
    const sessions = get(sessionsAtom);
    if (sessions === prevSessions && prevGroups) return prevGroups;
    prevSessions = sessions;
    const active: Session[] = [];
    const completed: Session[] = [];
    const failed: Session[] = [];
    for (const session of sessions) {
      const status = session.status;
      if (isActiveStatus(status)) {
        active.push(session);
      } else if (status === "completed") {
        completed.push(session);
      } else if (isTerminalStatus(status)) {
        failed.push(session);
      }
    }
    prevGroups = { active, completed, failed };
    return prevGroups;
  });
})();
sessionGroupsAtom.debugLabel = "sessionGroupsAtom";

export const activeSessionsAtom = atom((get) => get(sessionGroupsAtom).active);
activeSessionsAtom.debugLabel = "activeSessionsAtom";

// ============================================
// Session Counts (derived from session groups)
// ============================================

export const sessionTotalCountAtom = atom((get) => get(sessionsAtom).length);
sessionTotalCountAtom.debugLabel = "sessionTotalCountAtom";

export const sessionActiveCountAtom = atom(
  (get) => get(activeSessionsAtom).length
);
sessionActiveCountAtom.debugLabel = "sessionActiveCountAtom";

export const sessionCompletedCountAtom = atom(
  (get) => get(sessionGroupsAtom).completed.length
);
sessionCompletedCountAtom.debugLabel = "sessionCompletedCountAtom";

export const sessionFailedCountAtom = atom(
  (get) => get(sessionGroupsAtom).failed.length
);
sessionFailedCountAtom.debugLabel = "sessionFailedCountAtom";

// ============================================
// Working sessions (strict subset of active)
// ============================================

/**
 * Statuses that mean the session is actively burning compute / waiting on a
 * network turn — i.e. interrupting them by letting the machine sleep would
 * cancel real work. Excludes `idle`, `paused`, and `waiting_for_user` because
 * those states are conversation pauses, not in-flight work.
 */
const WORKING_STATUSES: ReadonlySet<string> = new Set([
  "running",
  "installing",
  "in_progress",
  "pending",
  "queued",
  "waiting_for_funds",
]);

/**
 * True iff at least one session is in a status that represents in-flight work.
 * Used by `useSleepInhibitor` to decide whether to hold a platform sleep
 * inhibitor while `general.preventSleepWhileRunning` is enabled.
 */
export const anySessionWorkingAtom = atom((get) =>
  get(sessionsAtom).some((session) => WORKING_STATUSES.has(session.status))
);
anySessionWorkingAtom.debugLabel = "anySessionWorkingAtom";

/**
 * Most recently updated sessions (last 10).
 *
 * NOTE: Sessions from Rust backend are already sorted by updated_at desc,
 * so we just slice the first 10. No re-sorting needed.
 */
let _prevSessionsForRecent: Session[] = [];
let _prevRecent: Session[] = [];

export const recentSessionsAtom = atom((get) => {
  const sessions = get(sessionsAtom);
  if (sessions === _prevSessionsForRecent) return _prevRecent;
  _prevSessionsForRecent = sessions;

  // Sessions are pre-sorted by updated_at desc from Rust backend,
  // so we just take the first 10.
  _prevRecent = sessions.slice(0, 10);
  return _prevRecent;
});
recentSessionsAtom.debugLabel = "recentSessionsAtom";

// ============================================
// Chat Context
// ============================================

export const contextItemsAtom = atom<string[]>([]);
contextItemsAtom.debugLabel = "contextItemsAtom";

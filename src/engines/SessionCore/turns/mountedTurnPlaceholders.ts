/**
 * Registry of turn ids whose lazy-load placeholder (`UnloadedTurnBubble`) is
 * CURRENTLY MOUNTED in the Workstation Communication ("Messages") replay
 * surface, keyed by session.
 *
 * Why this exists: `pruneLoadedTurnBodies` (./loadedTurnRegistry.ts) caps how
 * many historical turn bodies stay resident at once
 * (`MAX_LOADED_HISTORICAL_TURN_BODIES`). When many placeholders mount at
 * once — e.g. "communication-load-more-messages" reveals a dozen rounds in
 * one go — each placeholder's own lazy-load effect used to call
 * `pruneLoadedTurnBodies` protecting ONLY its own turnId. A sibling
 * placeholder's fetch resolving a moment later would then evict a body that
 * had just barely finished loading, because that earlier prune call had no
 * way to know a different placeholder was still relying on it. Since each
 * placeholder's fetch is one-shot, the evicted one never refetched on its
 * own and got stuck showing "Loading message…" forever.
 *
 * Fix: every mounted placeholder registers its turnId here (add on mount,
 * remove on unmount). Any caller of `pruneLoadedTurnBodies` should union the
 * ids it's actively fetching with every currently-mounted id for the session
 * before pruning, so eviction only ever targets turns nothing on screen
 * currently needs. See `UnloadedTurnBubble` and `useReplayTurnPrefetch`.
 *
 * Protecting every mounted placeholder can mean `pruneLoadedTurnBodies` is
 * unable to shrink the loaded set back down to the cap while many
 * placeholders are mounted at once — that's tolerated by design (see the
 * doc comment on `pruneLoadedTurnBodies`); the overshoot self-corrects as
 * placeholders unmount and later prune calls see a smaller protected set.
 */

const mountedTurnIdsBySession = new Map<string, Set<string>>();

const EMPTY_TURN_IDS: ReadonlySet<string> = new Set();

export function registerMountedTurnPlaceholder(
  sessionId: string,
  turnId: string
): void {
  let turnIds = mountedTurnIdsBySession.get(sessionId);
  if (!turnIds) {
    turnIds = new Set<string>();
    mountedTurnIdsBySession.set(sessionId, turnIds);
  }
  turnIds.add(turnId);
}

export function unregisterMountedTurnPlaceholder(
  sessionId: string,
  turnId: string
): void {
  const turnIds = mountedTurnIdsBySession.get(sessionId);
  if (!turnIds) return;
  turnIds.delete(turnId);
  if (turnIds.size === 0) {
    mountedTurnIdsBySession.delete(sessionId);
  }
}

/**
 * Snapshot of every turn id currently mounted as a placeholder for
 * `sessionId`. Returns a shared empty set (never `null`/`undefined`) so
 * callers can iterate unconditionally.
 */
export function getMountedTurnPlaceholderIds(
  sessionId: string
): ReadonlySet<string> {
  return mountedTurnIdsBySession.get(sessionId) ?? EMPTY_TURN_IDS;
}

/** Test-only: reset the registry between specs. */
export function clearMountedTurnPlaceholders(sessionId: string): void {
  mountedTurnIdsBySession.delete(sessionId);
}

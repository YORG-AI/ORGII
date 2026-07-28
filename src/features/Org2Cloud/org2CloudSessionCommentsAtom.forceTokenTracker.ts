/**
 * Module-level force-refetch de-dup state for `useSessionComments`'
 * `fetchComments` claim loop (`org2CloudSessionCommentsAtom.ts`). Lives in
 * its own module — not inside the hook — because the atom entry, and
 * therefore the fetch claim, is shared across every mounted hook instance
 * for the same key; this de-dup state must be too.
 */

/**
 * Keys whose in-flight fetch swallowed a FORCED refresh: replayed with one
 * more forced fetch the moment the running fetch settles (module-level —
 * the atom entry is shared across hook instances, so the queue must be
 * too). A Set, so N dropped forces replay as ONE refetch.
 */
export const pendingForceRefetchKeys = new Set<string>();
/** Signal-aware force dedup shared across hook instances. The same Realtime
 * generation may be observed by header and transcript subscribers; it must
 * produce one request, not one sequential request per subscriber. */
export const activeForceTokenByKey = new Map<string, string>();
export const pendingForceTokenByKey = new Map<string, string>();
export const completedForceTokenByKey = new Map<string, string>();
const COMPLETED_FORCE_TOKEN_CACHE_MAX = 500;

export function rememberCompletedForceToken(key: string, token: string): void {
  completedForceTokenByKey.delete(key);
  completedForceTokenByKey.set(key, token);
  if (completedForceTokenByKey.size <= COMPLETED_FORCE_TOKEN_CACHE_MAX) return;
  const oldestKey = completedForceTokenByKey.keys().next().value;
  if (oldestKey !== undefined) completedForceTokenByKey.delete(oldestKey);
}

export function dropPendingForce(key: string): void {
  pendingForceTokenByKey.delete(key);
  pendingForceRefetchKeys.delete(key);
}

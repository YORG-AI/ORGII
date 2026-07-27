/** Realtime nudge bus for the session-comments plane: id-only broadcast frames that trigger RPC refetches. */
import { atom } from "jotai";

import { createLogger } from "@src/hooks/logger";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";

const log = createLogger("Org2CloudCommentsBus");

export const COMMENTS_CHANGED_EVENT = "comments-changed";

/** `orgId|sessionId` → monotonically increasing nudge counter. */
export const org2CloudCommentsSignalAtom = atom<Record<string, number>>({});

/**
 * Signal keys accumulate one counter per (org, session) ever nudged in this
 * identity epoch (the realtime root clears the atom on identity change). Cap
 * the record so a months-long uptime cannot grow it without bound. An evicted
 * key restarts at 0; consumers seed from the current value on mount and
 * compare by inequality, so the worst case is one deduped force-refetch that
 * the next nudge or the TTL fetch covers.
 */
export const MAX_COMMENTS_SIGNAL_KEYS = 256;

/** Pure bounded bump: re-appends the key (LRU order) and evicts the oldest
 * keys beyond the cap. Every writer of the signal atom must go through this. */
export function bumpCommentsSignalKey(
  current: Record<string, number>,
  key: string
): Record<string, number> {
  const next: Record<string, number> = {};
  for (const existing of Object.keys(current)) {
    if (existing !== key) next[existing] = current[existing]!;
  }
  next[key] = (current[key] ?? 0) + 1;
  const keys = Object.keys(next);
  const overflow = keys.length - MAX_COMMENTS_SIGNAL_KEYS;
  for (let index = 0; index < overflow; index += 1) {
    delete next[keys[index]!];
  }
  return next;
}

export function sessionCommentsKey(orgId: string, sessionId: string): string {
  return `${orgId}|${sessionId}`;
}

/** Durable org-wide invalidation key (org_change_signals has no session id). */
export function orgCommentsKey(orgId: string): string {
  return `${orgId}|*`;
}

type BroadcastSender = (
  event: string,
  payload: Record<string, unknown>
) => void;

const senders = new Map<string, BroadcastSender>();

/** Wired by useOrg2CloudRealtime while an org's channel is open. */
export function registerCommentsBroadcaster(
  orgId: string,
  sender: BroadcastSender
): () => void {
  senders.set(orgId, sender);
  return () => {
    if (senders.get(orgId) === sender) senders.delete(orgId);
  };
}

export function bumpLocalCommentsSignal(
  orgId: string,
  sessionId: string
): void {
  let store: ReturnType<typeof getInstrumentedStore>;
  try {
    store = getInstrumentedStore();
  } catch {
    return;
  }
  const key = sessionCommentsKey(orgId, sessionId);
  store.set(
    org2CloudCommentsSignalAtom,
    bumpCommentsSignalKey(store.get(org2CloudCommentsSignalAtom), key)
  );
}

/** Notify peers without invalidating this instance's already-patched cache. */
export function broadcastCommentsChangedToPeers(
  orgId: string,
  sessionId: string
): void {
  const sender = senders.get(orgId);
  if (!sender) {
    log.warn(`no broadcaster registered for org ${orgId} (channel not open)`);
    return;
  }
  sender(COMMENTS_CHANGED_EVENT, { sessionId });
}

/** Fire-and-forget nudge for headless writers that have not patched the local
 * comments atom: peers via broadcast, this instance via the local signal. */
export function broadcastCommentsChanged(
  orgId: string,
  sessionId: string
): void {
  bumpLocalCommentsSignal(orgId, sessionId);
  broadcastCommentsChangedToPeers(orgId, sessionId);
}

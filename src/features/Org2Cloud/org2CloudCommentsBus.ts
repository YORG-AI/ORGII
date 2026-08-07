/** Realtime nudge bus for the session-comments plane: id-only broadcast frames that trigger RPC refetches. */
import { atom } from "jotai";

import { createLogger } from "@src/hooks/logger";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";

const log = createLogger("Org2CloudCommentsBus");

export const COMMENTS_CHANGED_EVENT = "comments-changed";

/** `orgId|sessionId` → monotonically increasing nudge counter. */
export const org2CloudCommentsSignalAtom = atom<Record<string, number>>({});

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
  const current = store.get(org2CloudCommentsSignalAtom);
  store.set(org2CloudCommentsSignalAtom, {
    ...current,
    [key]: (current[key] ?? 0) + 1,
  });
}

/** Fire-and-forget nudge that a session's comments/tasks changed: peers via broadcast, this instance via the local signal. */
export function broadcastCommentsChanged(
  orgId: string,
  sessionId: string
): void {
  bumpLocalCommentsSignal(orgId, sessionId);
  const sender = senders.get(orgId);
  if (!sender) {
    log.warn(`no broadcaster registered for org ${orgId} (channel not open)`);
    return;
  }
  sender(COMMENTS_CHANGED_EVENT, { sessionId });
}

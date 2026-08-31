/**
 * Client store for the 0024 conversation-events plane: per-conversation
 * incremental fetch keyed by `(orgId, rootSessionId)` with a dense
 * server-assigned seq cursor. Capability-gated — a pre-0024 backend leaves
 * every entry "unsupported" and the fork-wire fallback stays in charge.
 */
import { atom, useAtomValue, useSetAtom, useStore } from "jotai";
import { useEffect } from "react";

import { createLogger } from "@src/hooks/logger";

import { commitRefreshedAuth, org2CloudAuthAtom } from "../org2CloudAuthAtom";
import { getCloudCapabilitiesConfirmed } from "../org2CloudCapabilities";
import { ensureFreshSession } from "../org2CloudClient";
import {
  type CloudConversationEvent,
  listConversationEvents,
} from "../org2CloudConversationEventsClient";
import type { SessionCommentTarget } from "../sessionCommentTarget";

const log = createLogger("ConversationPlane");

export type ConversationPlaneState =
  | "idle"
  | "loading"
  | "ready"
  | "unsupported"
  | "error";

export interface ConversationPlaneEntry {
  state: ConversationPlaneState;
  /** Ordered by seq asc; deduped by wire id. */
  events: CloudConversationEvent[];
  lastSeq: number;
}

const EMPTY_ENTRY: ConversationPlaneEntry = {
  state: "idle",
  events: [],
  lastSeq: 0,
};

export function conversationPlaneKey(
  orgId: string,
  rootSessionId: string
): string {
  return `${orgId}:${rootSessionId}`;
}

export const conversationPlaneAtom = atom<
  Record<string, ConversationPlaneEntry>
>({});

/** orgId → monotonically increasing signal counter (realtime bump). */
export const conversationPlaneSignalAtom = atom<Record<string, number>>({});

const inFlightByKey = new Set<string>();

function mergePlaneEvents(
  previous: ConversationPlaneEntry,
  incoming: readonly CloudConversationEvent[]
): ConversationPlaneEntry {
  if (incoming.length === 0) {
    return { ...previous, state: "ready" };
  }
  const known = new Set(previous.events.map((event) => event.id));
  const fresh = incoming.filter((event) => !known.has(event.id));
  const events = [...previous.events, ...fresh].sort(
    (left, right) => left.seq - right.seq
  );
  return {
    state: "ready",
    events,
    lastSeq: events.length > 0 ? events[events.length - 1].seq : 0,
  };
}

/**
 * Keeps the plane entry for the given conversation target fetched and
 * incrementally fresh. Refetches whenever the org's signal counter bumps
 * (realtime `conversationEvents` kind) and after local pushes (the pusher
 * bumps the same signal).
 */
export function useConversationPlaneEvents(
  target: SessionCommentTarget | null
): ConversationPlaneEntry {
  const auth = useAtomValue(org2CloudAuthAtom);
  const store = useStore();
  const setAuth = useSetAtom(org2CloudAuthAtom);
  const entries = useAtomValue(conversationPlaneAtom);
  const setEntries = useSetAtom(conversationPlaneAtom);
  const signals = useAtomValue(conversationPlaneSignalAtom);
  const targetOrgId = target?.orgId;
  const targetSessionId = target?.sessionId;
  const signal = targetOrgId ? (signals[targetOrgId] ?? 0) : 0;
  const key =
    targetOrgId && targetSessionId
      ? conversationPlaneKey(targetOrgId, targetSessionId)
      : null;
  const entry = key ? (entries[key] ?? EMPTY_ENTRY) : EMPTY_ENTRY;

  useEffect(() => {
    if (!targetOrgId || !targetSessionId || !key || !auth) return;
    const currentEntry = store.get(conversationPlaneAtom)[key] ?? EMPTY_ENTRY;
    const entryState = currentEntry.state;
    if (entryState === "unsupported") return;
    if (inFlightByKey.has(key)) return;
    inFlightByKey.add(key);
    void (async () => {
      try {
        const fresh = await ensureFreshSession(auth);
        if (!fresh) return;
        commitRefreshedAuth(setAuth, auth, fresh);
        const probe = await getCloudCapabilitiesConfirmed(fresh.accessToken);
        if (!probe.capabilities.conversationEvents) {
          if (probe.confirmed) {
            setEntries((current) => ({
              ...current,
              [key]: { ...EMPTY_ENTRY, state: "unsupported" },
            }));
          }
          return;
        }
        let afterSeq = currentEntry.lastSeq;
        for (;;) {
          const page = await listConversationEvents(fresh.accessToken, {
            orgId: targetOrgId,
            rootSessionId: targetSessionId,
            afterSeq,
          });
          setEntries((current) => {
            const previous = current[key] ?? EMPTY_ENTRY;
            return {
              ...current,
              [key]: mergePlaneEvents(previous, page.events),
            };
          });
          if (!page.hasMore || page.events.length === 0) break;
          afterSeq = page.events[page.events.length - 1].seq;
        }
      } catch (error) {
        log.warn(`conversation plane fetch failed for ${key}`, error);
        setEntries((current) => {
          const previous = current[key] ?? EMPTY_ENTRY;
          if (previous.state === "ready") return current;
          return { ...current, [key]: { ...previous, state: "error" } };
        });
      } finally {
        inFlightByKey.delete(key);
      }
    })();
  }, [
    targetOrgId,
    targetSessionId,
    key,
    auth,
    setAuth,
    setEntries,
    signal,
    store,
  ]);

  return entry;
}

/** Bump helper for realtime dispatch and local pushes. */
export function bumpConversationPlaneSignal(
  set: (
    update: (current: Record<string, number>) => Record<string, number>
  ) => void,
  orgId: string
): void {
  set((current) => ({ ...current, [orgId]: (current[orgId] ?? 0) + 1 }));
}

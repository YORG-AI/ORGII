/**
 * Client store for the 0024 conversation-events plane: per-conversation
 * incremental fetch keyed by `(authIdentity, orgId, rootSessionId)` with a
 * dense server-assigned seq cursor. `authIdentity` includes the Cloud endpoint
 * and account, so two accounts that can name the same org/session never share
 * cached events or a single-flight request. Capability-gated — a pre-0024
 * backend leaves every entry "unsupported" and the fork-wire fallback stays
 * in charge.
 */
import {
  atom,
  type createStore,
  useAtomValue,
  useSetAtom,
  useStore,
} from "jotai";
import { useEffect, useMemo } from "react";

import { createLogger } from "@src/hooks/logger";
import { BoundedMap } from "@src/util/collections/BoundedMap";

import {
  commitRefreshedAuth,
  org2CloudAuthAtom,
  org2CloudAuthIdentityKey,
} from "../org2CloudAuthAtom";
import type { Org2CloudAuthState } from "../org2CloudAuthAtom";
import { getCloudCapabilitiesConfirmed } from "../org2CloudCapabilities";
import { ensureFreshSession } from "../org2CloudClient";
import {
  type CloudConversationEvent,
  decodeConversationEventChunks,
  listConversationEvents,
} from "../org2CloudConversationEventsClient";
import type { SessionCommentTarget } from "../sessionCommentTarget";

const log = createLogger("ConversationPlane");
const MAX_CONVERSATION_PLANE_ENTRIES = 64;
const MAX_CONVERSATION_PLANE_BYTES = 128 * 1024 * 1024;
/** A mounted conversation keeps only a renderable tail, never its full life. */
export const MAX_CONVERSATION_PLANE_ENTRY_EVENTS = 2_000;
export const MAX_CONVERSATION_PLANE_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_CONVERSATION_PLANE_PULL_BYTES = 128 * 1024 * 1024;
const MAX_CONVERSATION_PLANE_SIGNALS = 64;

export type ConversationPlaneState =
  | "idle"
  | "loading"
  | "ready"
  | "unsupported"
  | "error";

export interface ConversationPlaneEntry {
  /** Endpoint + account privacy/cache boundary for this snapshot. */
  authIdentityKey: string;
  orgId: string;
  rootSessionId: string;
  state: ConversationPlaneState;
  /** Ordered by seq asc; deduped by wire id. */
  events: CloudConversationEvent[];
  /** First retained logical row; null when the visible window is empty. */
  firstSeq: number | null;
  /** True when durable Cloud history exists before `firstSeq`. */
  hasEarlierEvents: boolean;
  /** Timestamp of the first logical plane row, retained after tail eviction. */
  historyStartedAt: string | null;
  lastSeq: number;
  /** Cached payload estimate; avoids serializing every retained transcript. */
  approximateBytes?: number;
}

export interface ConversationPlaneLocator {
  authIdentityKey: string;
  orgId: string;
  rootSessionId: string;
}

const KEY_SEPARATOR = "\u001f";

function emptyEntry(locator: ConversationPlaneLocator): ConversationPlaneEntry {
  return {
    ...locator,
    state: "idle",
    events: [],
    firstSeq: null,
    hasEarlierEvents: false,
    historyStartedAt: null,
    lastSeq: 0,
    approximateBytes: 0,
  };
}

export function conversationPlaneKey(
  locator: ConversationPlaneLocator
): string {
  return [locator.authIdentityKey, locator.orgId, locator.rootSessionId].join(
    KEY_SEPARATOR
  );
}

export const conversationPlaneAtom = atom<
  Record<string, ConversationPlaneEntry>
>({});

/** orgId → monotonically increasing signal counter (realtime bump). */
export const conversationPlaneSignalAtom = atom<Record<string, number>>({});

type ConversationPlaneEntries = Record<string, ConversationPlaneEntry>;
type JotaiStore = ReturnType<typeof createStore>;
type SetConversationPlaneEntries = (
  update: (current: ConversationPlaneEntries) => ConversationPlaneEntries
) => void;
type SetCloudAuth = (
  update: (current: Org2CloudAuthState | null) => Org2CloudAuthState | null
) => void;

interface RefreshConversationPlaneParams {
  store: JotaiStore;
  auth: Org2CloudAuthState;
  orgId: string;
  rootSessionId: string;
  getEntry: () => ConversationPlaneEntry | undefined;
  setEntries: SetConversationPlaneEntries;
  setAuth: SetCloudAuth;
  /**
   * Stable identity of a real invalidation that initiated this refresh.
   * Concurrent readers with the same identity join one request; a newer
   * identity arriving while it is in flight schedules exactly one trailing
   * pull. Ordinary readers omit it and only join.
   */
  invalidationKey?: string;
}

interface ConversationPlaneRequestState {
  activeIdentityKey: string | null;
  epoch: number;
  inFlightByKey: Map<string, Promise<ConversationPlaneEntry>>;
  trailingRefreshKeys: Set<string>;
  activeInvalidationByKey: Map<string, string>;
  trailingInvalidationByKey: Map<string, string>;
}

const requestStateByStore = new WeakMap<
  JotaiStore,
  ConversationPlaneRequestState
>();

function requestStateFor(store: JotaiStore): ConversationPlaneRequestState {
  let state = requestStateByStore.get(store);
  if (!state) {
    state = {
      activeIdentityKey: null,
      epoch: 0,
      inFlightByKey: new Map(),
      trailingRefreshKeys: new Set(),
      activeInvalidationByKey: new Map(),
      trailingInvalidationByKey: new Map(),
    };
    requestStateByStore.set(store, state);
  }
  return state;
}

function boundedRecordWrite<T>(
  current: Record<string, T>,
  key: string,
  value: T,
  maxSize: number
): Record<string, T> {
  const bounded = new BoundedMap<string, T>({ maxSize });
  for (const [existingKey, existingValue] of Object.entries(current)) {
    bounded.set(existingKey, existingValue);
  }
  bounded.set(key, value);
  return Object.fromEntries(bounded.entries());
}

function writeConversationPlaneEntry(
  current: ConversationPlaneEntries,
  key: string,
  entry: ConversationPlaneEntry
): ConversationPlaneEntries {
  const bounded = boundedRecordWrite(
    current,
    key,
    entry,
    MAX_CONVERSATION_PLANE_ENTRIES
  );
  const entries = Object.entries(bounded);
  let approximateBytes = entries.reduce(
    (total, [, value]) => total + conversationPlaneEntryBytes(value),
    0
  );
  while (
    approximateBytes > MAX_CONVERSATION_PLANE_BYTES &&
    entries.length > 1
  ) {
    const oldestIndex = entries.findIndex(([candidate]) => candidate !== key);
    if (oldestIndex < 0) break;
    const removed = entries.splice(oldestIndex, 1)[0];
    if (!removed) break;
    approximateBytes -= conversationPlaneEntryBytes(removed[1]);
  }
  return Object.fromEntries(entries);
}

function conversationPlaneEntryBytes(entry: ConversationPlaneEntry): number {
  return entry.approximateBytes ?? approximateEventBytes(entry.events);
}

function approximateEventBytes(
  events: readonly CloudConversationEvent[]
): number {
  return events.reduce(
    (total, event) => total + JSON.stringify(event).length * 2,
    0
  );
}

function appendWirePageWithinPullBound(
  destination: CloudConversationEvent[],
  page: readonly CloudConversationEvent[],
  currentBytes: number
): number {
  const nextBytes = currentBytes + approximateEventBytes(page);
  if (nextBytes > MAX_CONVERSATION_PLANE_PULL_BYTES) {
    throw new Error(
      `canonical conversation plane exceeds the ${MAX_CONVERSATION_PLANE_PULL_BYTES}-byte reconstruction bound`
    );
  }
  destination.push(...page);
  return nextBytes;
}

export interface ConversationPlaneWindow {
  events: CloudConversationEvent[];
  approximateBytes: number;
  firstSeq: number | null;
  hasEarlierEvents: boolean;
}

/**
 * Bound the in-memory render window without moving the durable `lastSeq`
 * cursor backwards. The Cloud plane remains the history authority; callers
 * that need native reconstruction use `loadCompleteConversationPlaneEvents`
 * rather than treating this UI tail as a checkpoint.
 */
export function boundConversationPlaneWindow(
  events: readonly CloudConversationEvent[],
  options: { maxEvents?: number; maxBytes?: number } = {}
): ConversationPlaneWindow {
  const maxEvents = options.maxEvents ?? MAX_CONVERSATION_PLANE_ENTRY_EVENTS;
  const maxBytes = options.maxBytes ?? MAX_CONVERSATION_PLANE_ENTRY_BYTES;
  let start = Math.max(0, events.length - Math.max(0, maxEvents));
  let approximateBytes = approximateEventBytes(events.slice(start));
  while (start < events.length && approximateBytes > maxBytes) {
    approximateBytes -= approximateEventBytes([events[start]]);
    start += 1;
  }
  const retained = events.slice(start);
  return {
    events: retained,
    approximateBytes,
    firstSeq: retained[0]?.seq ?? null,
    hasEarlierEvents: start > 0,
  };
}

function appendConversationEvents(
  base: readonly CloudConversationEvent[],
  incoming: readonly CloudConversationEvent[]
): CloudConversationEvent[] {
  if (incoming.length === 0) return [...base];
  const incomingOrdered = incoming.every(
    (event, index) => index === 0 || incoming[index - 1]!.seq <= event.seq
  );
  const baseTip = base.at(-1)?.seq ?? 0;
  if (incomingOrdered && baseTip <= incoming[0]!.seq) {
    return [...base, ...incoming];
  }
  // Defensive fallback for a server/schema regression; normal incremental
  // pages never pay this full-history sort.
  return [...base, ...incoming].sort((left, right) => left.seq - right.seq);
}

/** Load the exact durable plane for execution; this result is never cached. */
export async function loadCompleteConversationPlaneEvents(
  accessToken: string,
  params: { orgId: string; rootSessionId: string },
  endpoint: { supabaseUrl: string; anonKey: string }
): Promise<CloudConversationEvent[]> {
  let afterSeq = 0;
  const wireEvents: CloudConversationEvent[] = [];
  let wireBytes = 0;
  for (;;) {
    const page = await listConversationEvents(
      accessToken,
      { ...params, afterSeq },
      endpoint
    );
    wireBytes = appendWirePageWithinPullBound(
      wireEvents,
      page.events,
      wireBytes
    );
    // Quarantined rows leave no readable event but still own a seq; follow the
    // wire cursor so one poisoned row cannot stall the pull, and stop as soon
    // as it fails to advance.
    const advanced = page.lastSeq > afterSeq;
    afterSeq = Math.max(afterSeq, page.lastSeq);
    if (!page.hasMore || !advanced) break;
  }
  return decodeConversationEventChunks(wireEvents);
}

function activateConversationPlaneIdentity(
  store: JotaiStore,
  authIdentityKey: string | null,
  setEntries: SetConversationPlaneEntries
): ConversationPlaneRequestState {
  const state = requestStateFor(store);
  if (state.activeIdentityKey === authIdentityKey) return state;
  state.activeIdentityKey = authIdentityKey;
  state.epoch += 1;
  state.inFlightByKey.clear();
  state.trailingRefreshKeys.clear();
  state.activeInvalidationByKey.clear();
  state.trailingInvalidationByKey.clear();
  setEntries((current) => {
    const retained = Object.fromEntries(
      Object.entries(current).filter(
        ([, entry]) => entry.authIdentityKey === authIdentityKey
      )
    );
    return Object.keys(retained).length === Object.keys(current).length
      ? current
      : retained;
  });
  return state;
}

function storeHasConversationPlaneIdentity(
  store: JotaiStore,
  authIdentityKey: string
): boolean {
  const current = store.get(org2CloudAuthAtom);
  return Boolean(
    current && org2CloudAuthIdentityKey(current) === authIdentityKey
  );
}

function locatorForRequest(
  params: Pick<
    RefreshConversationPlaneParams,
    "auth" | "orgId" | "rootSessionId"
  >
): ConversationPlaneLocator {
  return {
    authIdentityKey: org2CloudAuthIdentityKey(params.auth),
    orgId: params.orgId,
    rootSessionId: params.rootSessionId,
  };
}

function entryMatchesLocator(
  entry: ConversationPlaneEntry | undefined,
  locator: ConversationPlaneLocator
): entry is ConversationPlaneEntry {
  return (
    entry?.authIdentityKey === locator.authIdentityKey &&
    entry.orgId === locator.orgId &&
    entry.rootSessionId === locator.rootSessionId
  );
}

/**
 * One authoritative loader shared by the mounted transcript and the submit
 * boundary. A capable backend must never race through the legacy visible-fork
 * path merely because its first plane fetch is still in flight.
 */
export function refreshConversationPlaneEntry(
  params: RefreshConversationPlaneParams
): Promise<ConversationPlaneEntry> {
  const locator = locatorForRequest(params);
  if (
    !storeHasConversationPlaneIdentity(params.store, locator.authIdentityKey)
  ) {
    return Promise.reject(
      new Error("cloud auth identity changed before plane refresh")
    );
  }
  const key = conversationPlaneKey(locator);
  const requestState = activateConversationPlaneIdentity(
    params.store,
    locator.authIdentityKey,
    params.setEntries
  );
  const requestEpoch = requestState.epoch;
  const isCurrentRequest = () =>
    requestState.activeIdentityKey === locator.authIdentityKey &&
    requestState.epoch === requestEpoch;
  const existing = requestState.inFlightByKey.get(key);
  if (existing) {
    const requestedInvalidation = params.invalidationKey;
    const latestInvalidation =
      requestState.trailingInvalidationByKey.get(key) ??
      requestState.activeInvalidationByKey.get(key);
    if (
      requestedInvalidation === undefined ||
      requestedInvalidation === latestInvalidation
    ) {
      return existing;
    }
    requestState.trailingRefreshKeys.add(key);
    requestState.trailingInvalidationByKey.set(key, requestedInvalidation);
    const runTrailingRefresh = () => {
      if (!requestState.trailingRefreshKeys.delete(key)) return null;
      const trailingInvalidation =
        requestState.trailingInvalidationByKey.get(key) ??
        requestedInvalidation;
      requestState.trailingInvalidationByKey.delete(key);
      return refreshConversationPlaneEntry({
        ...params,
        invalidationKey: trailingInvalidation,
      });
    };
    return existing.then(
      (entry) => runTrailingRefresh() ?? entry,
      (error: unknown) => {
        const trailing = runTrailingRefresh();
        if (trailing) return trailing;
        throw error;
      }
    );
  }

  if (params.invalidationKey !== undefined) {
    requestState.activeInvalidationByKey.set(key, params.invalidationKey);
  }

  const load = (async (): Promise<ConversationPlaneEntry> => {
    const storedBefore = params.getEntry();
    const before = entryMatchesLocator(storedBefore, locator)
      ? storedBefore
      : emptyEntry(locator);
    if (before.state !== "ready") {
      params.setEntries((current) =>
        isCurrentRequest()
          ? writeConversationPlaneEntry(current, key, {
              ...before,
              state: "loading",
            })
          : current
      );
    }
    try {
      const fresh = await ensureFreshSession(params.auth);
      if (!fresh) throw new Error("cloud auth refresh failed");
      if (
        !isCurrentRequest() ||
        org2CloudAuthIdentityKey(fresh) !== locator.authIdentityKey
      ) {
        throw new Error("cloud auth identity changed during plane refresh");
      }
      commitRefreshedAuth(params.setAuth, params.auth, fresh);
      const endpoint = {
        supabaseUrl: fresh.supabaseUrl,
        anonKey: fresh.supabaseAnonKey,
      };
      const probe = await getCloudCapabilitiesConfirmed(
        fresh.accessToken,
        endpoint
      );
      if (!probe.capabilities.conversationEvents) {
        if (!probe.confirmed) {
          throw new Error(
            "conversation plane capability probe was unconfirmed"
          );
        }
        const unsupported = {
          ...emptyEntry(locator),
          state: "unsupported",
        } as const;
        params.setEntries((current) =>
          isCurrentRequest()
            ? writeConversationPlaneEntry(current, key, unsupported)
            : current
        );
        return unsupported;
      }

      const stored = params.getEntry();
      const base = entryMatchesLocator(stored, locator) ? stored : before;
      let afterSeq = base.lastSeq;
      const incomingWireEvents: CloudConversationEvent[] = [];
      let incomingWireBytes = 0;
      for (;;) {
        const page = await listConversationEvents(
          fresh.accessToken,
          {
            orgId: params.orgId,
            rootSessionId: params.rootSessionId,
            afterSeq,
          },
          endpoint
        );
        if (!isCurrentRequest()) {
          throw new Error("cloud auth identity changed during plane refresh");
        }
        incomingWireBytes = appendWirePageWithinPullBound(
          incomingWireEvents,
          page.events,
          incomingWireBytes
        );
        const advanced = page.lastSeq > afterSeq;
        afterSeq = Math.max(afterSeq, page.lastSeq);
        if (!page.hasMore || !advanced) break;
      }
      const decodedIncoming =
        await decodeConversationEventChunks(incomingWireEvents);
      const known = new Set(base.events.map((event) => event.id));
      const novelIncoming = decodedIncoming.filter(
        (event) => !known.has(event.id)
      );
      const completeVisibleInput = appendConversationEvents(
        base.events,
        novelIncoming
      );
      const window = boundConversationPlaneWindow(completeVisibleInput);
      const resolved: ConversationPlaneEntry = {
        ...base,
        state: "ready",
        events: window.events,
        firstSeq: window.firstSeq,
        hasEarlierEvents: base.hasEarlierEvents || window.hasEarlierEvents,
        historyStartedAt:
          base.historyStartedAt ?? completeVisibleInput[0]?.createdAt ?? null,
        // Chunk envelopes collapse to one logical event. Advance only after
        // every fetched page decodes successfully, so a partial group never
        // becomes a visible ready snapshot or consumes its retry cursor.
        lastSeq: afterSeq,
        approximateBytes: window.approximateBytes,
      };
      params.setEntries((current) =>
        isCurrentRequest()
          ? writeConversationPlaneEntry(current, key, resolved)
          : current
      );
      return resolved;
    } catch (error) {
      params.setEntries((current) => {
        if (!isCurrentRequest()) return current;
        const storedCurrent = current[key];
        const previous = entryMatchesLocator(storedCurrent, locator)
          ? storedCurrent
          : emptyEntry(locator);
        if (previous.state === "ready") return current;
        return writeConversationPlaneEntry(current, key, {
          ...previous,
          state: "error",
        });
      });
      throw error;
    }
  })();
  requestState.inFlightByKey.set(key, load);
  const clearInFlight = () => {
    if (requestState.inFlightByKey.get(key) === load) {
      requestState.inFlightByKey.delete(key);
      requestState.activeInvalidationByKey.delete(key);
    }
  };
  void load.then(clearInFlight, clearInFlight);
  return load;
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
  const authIdentityKey = auth ? org2CloudAuthIdentityKey(auth) : null;
  const store = useStore();
  const setAuth = useSetAtom(org2CloudAuthAtom);
  const entries = useAtomValue(conversationPlaneAtom);
  const setEntries = useSetAtom(conversationPlaneAtom);
  const signals = useAtomValue(conversationPlaneSignalAtom);
  const setSignals = useSetAtom(conversationPlaneSignalAtom);
  const targetOrgId = target?.orgId;
  const targetSessionId = target?.sessionId;
  const signal = targetOrgId ? (signals[targetOrgId] ?? 0) : 0;
  const locator = useMemo(
    () =>
      authIdentityKey && targetOrgId && targetSessionId
        ? {
            authIdentityKey,
            orgId: targetOrgId,
            rootSessionId: targetSessionId,
          }
        : null,
    [authIdentityKey, targetOrgId, targetSessionId]
  );
  const key = locator ? conversationPlaneKey(locator) : null;
  const entry = locator
    ? entryMatchesLocator(entries[key!], locator)
      ? entries[key!]
      : emptyEntry(locator)
    : emptyEntry({ authIdentityKey: "", orgId: "", rootSessionId: "" });

  useEffect(() => {
    const previousIdentity = requestStateFor(store).activeIdentityKey;
    activateConversationPlaneIdentity(store, authIdentityKey, setEntries);
    if (previousIdentity !== authIdentityKey) setSignals({});
  }, [authIdentityKey, setEntries, setSignals, store]);

  useEffect(() => {
    if (!targetOrgId || !targetSessionId || !key || !auth || !locator) return;
    const storedCurrent = store.get(conversationPlaneAtom)[key];
    const currentEntry = entryMatchesLocator(storedCurrent, locator)
      ? storedCurrent
      : emptyEntry(locator);
    if (currentEntry.state === "unsupported") return;
    void (async () => {
      await refreshConversationPlaneEntry({
        store,
        auth,
        orgId: targetOrgId,
        rootSessionId: targetSessionId,
        getEntry: () => store.get(conversationPlaneAtom)[key],
        setEntries,
        setAuth,
        invalidationKey: `signal:${signal}`,
      });
    })().catch((error: unknown) => {
      log.warn(`conversation plane fetch failed for ${key}`, error);
    });
  }, [
    targetOrgId,
    targetSessionId,
    key,
    locator,
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
  set((current) =>
    boundedRecordWrite(
      current,
      orgId,
      (current[orgId] ?? 0) + 1,
      MAX_CONVERSATION_PLANE_SIGNALS
    )
  );
}

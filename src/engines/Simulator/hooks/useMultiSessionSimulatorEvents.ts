/**
 * useMultiSessionSimulatorEvents — subscribe to simulator events from
 * multiple child sessions simultaneously.
 *
 * Returns a bounded Map from sessionId → recent simulator-visible SessionEvent[]
 * for grid cells. This intentionally keeps only the latest window per child
 * session so large subagent histories do not stay duplicated in React state.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { type SessionEvent } from "@src/engines/SessionCore";
import {
  eventStoreProxy,
  isStreamingSnapshot,
} from "@src/engines/SessionCore/core/store/EventStoreProxy";
import type {
  DerivedSnapshot,
  Snapshot,
  StreamingSnapshot,
} from "@src/engines/SessionCore/core/store/EventStoreProxy";
import { createLogger } from "@src/hooks/logger";

import type { SubagentSession } from "./useSubagentSessions";

const log = createLogger("multiSessionSimulator");

const MAX_EVENTS_PER_SUBAGENT_SESSION = 360;

type SessionEventsMap = Map<string, SessionEvent[]>;

const EMPTY_MAP: SessionEventsMap = new Map();

function trimEventWindow(events: SessionEvent[]): SessionEvent[] {
  if (events.length <= MAX_EVENTS_PER_SUBAGENT_SESSION) return events;
  return events.slice(events.length - MAX_EVENTS_PER_SUBAGENT_SESSION);
}

function eventCreatedAtMs(event: SessionEvent): number {
  const t = new Date(event.createdAt).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * Insert `event` into `events` so the array remains sorted ascending by
 * `createdAt`. Uses linear scan from the tail because streaming arrivals are
 * almost always in order; the rare out-of-order arrival walks back at most
 * a handful of positions, never breaking the sorted invariant that every
 * binary search downstream relies on.
 */
function insertSorted(events: SessionEvent[], event: SessionEvent): number {
  const eventMs = eventCreatedAtMs(event);
  let i = events.length;
  while (i > 0 && eventCreatedAtMs(events[i - 1]) > eventMs) {
    i--;
  }
  events.splice(i, 0, event);
  return i;
}

function mergeEventUpserts(
  previousEvents: SessionEvent[],
  upserts: SessionEvent[]
): SessionEvent[] {
  if (upserts.length === 0) return previousEvents;
  const nextEvents = [...previousEvents];
  const indexById = new Map<string, number>();

  for (let index = 0; index < nextEvents.length; index++) {
    indexById.set(nextEvents[index].id, index);
  }

  for (const upsert of upserts) {
    const existingIndex = indexById.get(upsert.id);
    if (existingIndex === undefined) {
      const insertedAt = insertSorted(nextEvents, upsert);
      // `splice` invalidates downstream indices in the map; rebuild the
      // affected range so subsequent upserts find the right slot.
      indexById.set(upsert.id, insertedAt);
      for (let j = insertedAt + 1; j < nextEvents.length; j++) {
        indexById.set(nextEvents[j].id, j);
      }
    } else {
      nextEvents[existingIndex] = upsert;
    }
  }

  return trimEventWindow(nextEvents);
}

function extractSimulatorEvents(
  snapshot: Snapshot,
  previousEvents: SessionEvent[]
): SessionEvent[] {
  if (!isStreamingSnapshot(snapshot)) {
    // DerivedSnapshot: `sortedSimulatorEvents` is the Rust-side pre-filtered
    // result (derived.rs is_visible_in_simulator) — consume it directly,
    // including the legitimately-empty case.
    const derived = snapshot as DerivedSnapshot;
    return trimEventWindow(derived.sortedSimulatorEvents ?? []);
  }

  const streaming = snapshot as StreamingSnapshot;
  return mergeEventUpserts(
    previousEvents,
    streaming.simulatorEventUpserts ?? []
  );
}

export interface SubagentHistoryLoad {
  status: "loading" | "ready" | "error";
  retry: () => void;
}

const INITIAL_LOAD_STATE: SubagentHistoryLoad = {
  status: "loading",
  retry: () => {},
};

function subscribeVisibility(listener: () => void) {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}
const isVisible = () => !document.hidden;

export function useMultiSessionSimulatorEvents(
  subagentSessions: SubagentSession[]
) {
  const [eventsMap, setEventsMap] = useState<SessionEventsMap>(EMPTY_MAP);
  const [statuses, setStatuses] = useState<Map<string, SubagentHistoryLoad>>(
    new Map()
  );
  const eventsRef = useRef<SessionEventsMap>(new Map());
  const retryRef = useRef<(id: string) => void>(() => {});
  const retry = useCallback((id: string) => retryRef.current(id), []);
  const visible = useSyncExternalStore(
    subscribeVisibility,
    isVisible,
    () => true
  );
  const idsKey = JSON.stringify(
    [...new Set(subagentSessions.map((sub) => sub.sessionId))].sort()
  );

  useEffect(() => {
    const ids = JSON.parse(idsKey) as string[];
    const membership = new Set(ids);
    let disposed = false;
    const unsubs: Array<() => void> = [];
    const pending = new Set<string>();
    const baseline = new Set<string>();
    const failed = new Set<string>();
    const fullReceivedDuringLoad = new Set<string>();
    const duringLoad = new Map<string, SessionEvent[]>();
    eventsRef.current = new Map(
      [...eventsRef.current].filter(([id]) => membership.has(id))
    );
    const publish = () => {
      if (!disposed) setEventsMap(new Map(eventsRef.current));
    };
    const setStatus = (id: string, status: SubagentHistoryLoad["status"]) => {
      if (disposed) return;
      setStatuses((previous) => {
        if (
          previous.get(id)?.status === status &&
          [...previous.keys()].every((key) => membership.has(key))
        )
          return previous;
        return new Map(
          [...previous].filter(([key]) => membership.has(key))
        ).set(id, { status, retry: () => retry(id) });
      });
    };
    const apply = (id: string, snapshot: Snapshot) => {
      if (disposed) return;
      if (!isStreamingSnapshot(snapshot)) baseline.add(id);
      eventsRef.current.set(
        id,
        extractSimulatorEvents(snapshot, eventsRef.current.get(id) ?? [])
      );
      publish();
    };
    const load = async (id: string, fromCache: boolean) => {
      if (disposed || !visible || pending.has(id)) return;
      pending.add(id);
      failed.delete(id);
      duringLoad.set(id, []);
      fullReceivedDuringLoad.delete(id);
      setStatus(id, "loading");
      try {
        if (fromCache) await eventStoreProxy.loadFromCache(id);
        if (disposed) return;
        const snapshot = await eventStoreProxy.getSnapshot(id);
        if (disposed) return;
        if (!fullReceivedDuringLoad.has(id)) apply(id, snapshot);
        const buffered = duringLoad.get(id) ?? [];
        if (buffered.length) {
          eventsRef.current.set(
            id,
            mergeEventUpserts(eventsRef.current.get(id) ?? [], buffered)
          );
          publish();
        }
        setStatus(id, "ready");
      } catch (error) {
        if (!disposed) {
          failed.add(id);
          setStatus(id, "error");
          log.warn("Subagent history load failed", id, error);
        }
      } finally {
        pending.delete(id);
        duringLoad.delete(id);
        fullReceivedDuringLoad.delete(id);
      }
    };
    const onSnapshot = (id: string, snapshot: Snapshot) => {
      if (disposed) return;
      if (!isStreamingSnapshot(snapshot) && pending.has(id))
        fullReceivedDuringLoad.add(id);
      if (isStreamingSnapshot(snapshot) && pending.has(id)) {
        duringLoad.set(
          id,
          mergeEventUpserts(
            duringLoad.get(id) ?? [],
            snapshot.simulatorEventUpserts ?? []
          )
        );
      }
      apply(id, snapshot);
      if (baseline.has(id)) setStatus(id, "ready");
      else if (!pending.has(id) && !failed.has(id)) void load(id, false);
    };
    retryRef.current = (id) => {
      if (membership.has(id)) void load(id, true);
    };
    queueMicrotask(() => {
      if (disposed) return;
      publish();
      setStatuses(
        (previous) =>
          new Map([...previous].filter(([id]) => membership.has(id)))
      );
      if (!visible) return;
      for (const id of ids) {
        unsubs.push(
          eventStoreProxy.subscribeSession(id, (snapshot) =>
            onSnapshot(id, snapshot)
          )
        );
        const latest = eventStoreProxy.getLatestSessionSnapshot(id);
        if (latest) onSnapshot(id, latest);
        else void load(id, true);
      }
    });
    return () => {
      disposed = true;
      unsubs.forEach((unsubscribe) => unsubscribe());
    };
  }, [idsKey, visible, retry]);
  const membership = new Set(subagentSessions.map((sub) => sub.sessionId));
  return {
    eventsMap: [...eventsMap.keys()].every((id) => membership.has(id))
      ? eventsMap
      : new Map([...eventsMap].filter(([id]) => membership.has(id))),
    loadState: (id: string): SubagentHistoryLoad =>
      statuses.get(id) ?? INITIAL_LOAD_STATE,
  };
}

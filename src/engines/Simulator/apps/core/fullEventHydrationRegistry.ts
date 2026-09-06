import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { estimateRuntimeValueBytes } from "@src/hooks/perf/runtimeMemoryStats";
import { registerCache } from "@src/util/memory/cacheRegistry";

const MAX_HYDRATED_EVENTS = 600;

const hydratedEvents = new Map<string, SessionEvent>();

function touch(event: SessionEvent): void {
  hydratedEvents.delete(event.id);
  hydratedEvents.set(event.id, event);
}

function prune(): void {
  while (hydratedEvents.size > MAX_HYDRATED_EVENTS) {
    const oldestId = hydratedEvents.keys().next().value;
    if (oldestId === undefined) return;
    hydratedEvents.delete(oldestId);
  }
}

export function hydrateFullEventWindow(events: SessionEvent[]): SessionEvent[] {
  const hydrated: SessionEvent[] = [];
  for (const event of events) {
    touch(event);
    hydrated.push(event);
  }
  prune();
  return hydrated;
}

export function clearHydratedEvents(): void {
  hydratedEvents.clear();
}

export function getHydratedEventStats(): { entries: number; bytes: number } {
  let bytes = 0;
  for (const event of hydratedEvents.values()) {
    bytes += estimateRuntimeValueBytes(event);
  }
  return { entries: hydratedEvents.size, bytes };
}

registerCache({
  id: "simulator.hydratedEvents",
  tier: 1,
  estimate: getHydratedEventStats,
  trim: clearHydratedEvents,
});

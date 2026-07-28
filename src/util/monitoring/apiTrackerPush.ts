import {
  getTrackingObservationStartedAtMs,
  isTrackingEnabled,
} from "./apiTrackerState";
import type { PushHotspot, PushKind } from "./apiTrackerTypes";
import {
  effectiveObservationWindowMs,
  ratePerMinuteInWindow,
} from "./hotspotRates";

interface PushEvent {
  kind: PushKind;
  name: string;
  timestampMs: number;
}

const MAX_PUSH_EVENTS = 2000;
const pushEvents: PushEvent[] = [];

/**
 * Record one backend-push delivery (Tauri event, IPC channel message,
 * WebSocket message, SSE event). Cheap no-op while tracking is disabled —
 * safe to call from hot dispatch paths.
 */
export function recordPushEvent(kind: PushKind, name: string): void {
  if (!isTrackingEnabled()) return;
  pushEvents.push({ kind, name, timestampMs: Date.now() });
  if (pushEvents.length > MAX_PUSH_EVENTS) {
    pushEvents.splice(0, pushEvents.length - MAX_PUSH_EVENTS);
  }
}

export function getPushHotspots(windowMs = 120_000): PushHotspot[] {
  const now = Date.now();
  const observationWindowMs = effectiveObservationWindowMs(
    windowMs,
    getTrackingObservationStartedAtMs(),
    now
  );
  const recent = pushEvents.filter(
    (event) => now - event.timestampMs <= windowMs
  );

  const grouped = new Map<string, PushEvent[]>();
  for (const event of recent) {
    const key = `${event.kind}:${event.name}`;
    const group = grouped.get(key);
    if (group) group.push(event);
    else grouped.set(key, [event]);
  }

  return Array.from(grouped.entries())
    .map(([key, events]) => {
      const timestamps = events.map((event) => event.timestampMs);
      const firstMs = Math.min(...timestamps);
      const lastMs = Math.max(...timestamps);
      const eventsPerMinute = ratePerMinuteInWindow(
        events.length,
        observationWindowMs
      );
      return {
        key,
        kind: events[0].kind,
        name: events[0].name,
        count: events.length,
        eventsPerMinute,
        lastTimestamp: new Date(lastMs).toISOString(),
        firstTimestamp: new Date(firstMs).toISOString(),
        isLikelyStream: events.length >= 10,
      } satisfies PushHotspot;
    })
    .sort((hotspotA, hotspotB) => {
      if (hotspotA.isLikelyStream !== hotspotB.isLikelyStream) {
        return hotspotA.isLikelyStream ? -1 : 1;
      }
      return hotspotB.eventsPerMinute - hotspotA.eventsPerMinute;
    });
}

export function clearPushEvents(): void {
  pushEvents.splice(0, pushEvents.length);
}

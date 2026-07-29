import { WORK_ITEM_HISTORY_ACTION } from "@src/api/http/project/types";

import type { TimelineEntry } from "./types";

const DEFAULT_GROUPING_WINDOW_MS = 5 * 60 * 1000;

export type ActivityTimelineItem =
  | {
      kind: "entry";
      id: string;
      entry: TimelineEntry;
    }
  | {
      kind: "change-group";
      id: string;
      entries: TimelineEntry[];
      actor: TimelineEntry;
      timestamp: string;
      changeCount: number;
      fieldLabels: string[];
      fieldKeys: string[];
    };

/**
 * Condenses only consecutive update events from the same actor. Comments and
 * lifecycle events remain hard boundaries so their chronology stays explicit.
 */
export function groupActivityTimelineEntries(
  entries: readonly TimelineEntry[],
  groupingWindowMs = DEFAULT_GROUPING_WINDOW_MS
): ActivityTimelineItem[] {
  const items: ActivityTimelineItem[] = [];
  let pendingUpdates: TimelineEntry[] = [];

  const flushPendingUpdates = () => {
    if (pendingUpdates.length === 0) return;

    if (pendingUpdates.length === 1) {
      const [entry] = pendingUpdates;
      items.push({ kind: "entry", id: entry.id, entry });
      pendingUpdates = [];
      return;
    }

    const firstEntry = pendingUpdates[0];
    const lastEntry = pendingUpdates[pendingUpdates.length - 1];
    items.push({
      kind: "change-group",
      id: `change-group:${firstEntry.id}:${lastEntry.id}`,
      entries: pendingUpdates,
      actor: firstEntry,
      timestamp: lastEntry.timestamp,
      changeCount: pendingUpdates.reduce(
        (count, entry) => count + Math.max(entry.descriptions.length, 1),
        0
      ),
      fieldLabels: Array.from(
        new Set(pendingUpdates.flatMap((entry) => entry.changeFields ?? []))
      ),
      fieldKeys: Array.from(
        new Set(pendingUpdates.flatMap((entry) => entry.changeFieldKeys ?? []))
      ),
    });
    pendingUpdates = [];
  };

  for (const entry of entries) {
    if (entry.type !== WORK_ITEM_HISTORY_ACTION.UPDATED) {
      flushPendingUpdates();
      items.push({ kind: "entry", id: entry.id, entry });
      continue;
    }

    const previousEntry = pendingUpdates[pendingUpdates.length - 1];
    if (
      previousEntry &&
      (!isSameActor(previousEntry, entry) ||
        !isWithinGroupingWindow(
          previousEntry.timestamp,
          entry.timestamp,
          groupingWindowMs
        ))
    ) {
      flushPendingUpdates();
    }

    pendingUpdates.push(entry);
  }

  flushPendingUpdates();
  return items;
}

function isSameActor(
  previousEntry: TimelineEntry,
  nextEntry: TimelineEntry
): boolean {
  const previousActor = previousEntry.actorId ?? previousEntry.userName;
  const nextActor = nextEntry.actorId ?? nextEntry.userName;
  return previousActor === nextActor;
}

function isWithinGroupingWindow(
  previousTimestamp: string,
  nextTimestamp: string,
  groupingWindowMs: number
): boolean {
  const previousTime = Date.parse(previousTimestamp);
  const nextTime = Date.parse(nextTimestamp);
  if (!Number.isFinite(previousTime) || !Number.isFinite(nextTime)) {
    return false;
  }

  const elapsedMs = nextTime - previousTime;
  return elapsedMs >= 0 && elapsedMs <= groupingWindowMs;
}

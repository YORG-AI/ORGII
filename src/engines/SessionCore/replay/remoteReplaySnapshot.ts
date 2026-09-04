import {
  buildSimulatorPreviewFields,
  isSimulatorVisibleApprox,
} from "@src/engines/SessionCore/core/atoms/actions.simulatorPreview";
import { isLiveRuntimeResourceEvent } from "@src/engines/SessionCore/core/runningEventGate";
import type { DerivedSnapshot } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { isVisibleInChat } from "@src/engines/SessionCore/ingestion/visibilityFilters";

function eventTime(event: SessionEvent): number {
  const parsed = Date.parse(event.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareReplayEvents(left: SessionEvent, right: SessionEvent): number {
  const timeDifference = eventTime(left) - eventTime(right);
  return timeDifference || left.id.localeCompare(right.id);
}

/**
 * Build the same snapshot shape consumed by the desktop WorkStation replay
 * from an already-authorized remote event list.
 *
 * The Cloud transport remains the source of truth. This projection performs
 * no persistence and never writes into the desktop EventStore; callers mount
 * it in an isolated Jotai store.
 */
export interface BuildRemoteReplaySnapshotOptions {
  /** Inclusive replay cursor; defaults to the full event list. */
  endIndex?: number;
  version?: number;
}

export function buildRemoteReplaySnapshot(
  events: readonly SessionEvent[],
  options: BuildRemoteReplaySnapshotOptions = {}
): DerivedSnapshot {
  const version = options.version ?? Date.now();
  const lastIndex = events.length - 1;
  const endIndex =
    options.endIndex === undefined
      ? lastIndex
      : Math.min(Math.max(options.endIndex, -1), lastIndex);
  const materializedEvents =
    endIndex >= lastIndex ? [...events] : events.slice(0, endIndex + 1);
  const chatEvents = materializedEvents.filter(isVisibleInChat);
  const simulatorEvents = materializedEvents
    .filter(isSimulatorVisibleApprox)
    .sort(compareReplayEvents);

  return {
    version,
    eventCount: materializedEvents.length,
    events: materializedEvents,
    chatEvents,
    messagesEvents: simulatorEvents,
    sortedSimulatorEvents: simulatorEvents,
    lastEvent: materializedEvents[materializedEvents.length - 1] ?? null,
    eventIndex: Object.fromEntries(
      materializedEvents.map((event, index) => [event.id, index])
    ),
    chatEventCount: chatEvents.length,
    hasRunningEvent: materializedEvents.some(isLiveRuntimeResourceEvent),
    ...buildSimulatorPreviewFields(simulatorEvents),
  };
}

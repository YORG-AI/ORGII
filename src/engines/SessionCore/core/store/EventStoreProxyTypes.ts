import type {
  SessionEvent,
  SimulatorEventPreview,
} from "@src/engines/SessionCore/core/types";

export interface SimulatorPreviewSnapshotFields {
  sortedSimulatorEventIds?: string[];
  eventPreviewById?: Record<string, SimulatorEventPreview>;
  createdAtById?: Record<string, string>;
  threadIdById?: Record<string, string>;
  functionNameById?: Record<string, string>;
  displayStatusById?: Record<string, string>;
  displayVariantById?: Record<string, string>;
}

export interface DerivedSnapshot extends SimulatorPreviewSnapshotFields {
  version: number;
  eventCount: number;
  events: SessionEvent[];
  chatEvents: SessionEvent[];
  messagesEvents: SessionEvent[];
  sortedSimulatorEvents: SessionEvent[];
  lastEvent: SessionEvent | null;
  eventIndex: Record<string, number>;
  chatEventCount: number;
  hasRunningEvent: boolean;
}

export interface StreamingSnapshot extends SimulatorPreviewSnapshotFields {
  version: number;
  eventCount: number;
  chatEvents: SessionEvent[];
  sortedSimulatorEvents: SessionEvent[];
  simulatorEventUpserts?: SessionEvent[];
  lastEvent: SessionEvent | null;
  streaming: boolean;
  hasRunningEvent: boolean;
}

export interface SnapshotDelta extends SimulatorPreviewSnapshotFields {
  version: number;
  baseVersion: number;
  eventCount: number;
  upserts: SessionEvent[];
  removedIds: string[];
  eventIds: string[];
  chatEventIds: string[];
  messagesEventIds: string[];
  sortedSimulatorEventIds: string[];
  lastEventId: string | null;
  chatEventCount: number;
  hasRunningEvent: boolean;
  snapshotDelta: true;
}

export type Snapshot = DerivedSnapshot | StreamingSnapshot;
export type SnapshotPayload = Snapshot | SnapshotDelta;

export interface EventStoreMemoryStats {
  cachedSessions: number;
  normalizedSessions: number;
  cachedEvents: number;
  bytes: number;
}

export type SnapshotEnvelope = SnapshotPayload & {
  sessionId: string;
};

export type GlobalListener = (snapshot: Snapshot, sessionId: string) => void;
export type SessionListener = (snapshot: Snapshot) => void;

export interface NormalizedSnapshotCache {
  eventsById: Map<string, SessionEvent>;
  eventIds: string[];
  chatEventIds: string[];
  messagesEventIds: string[];
  sortedSimulatorEventIds: string[];
  eventPreviewById: Record<string, SimulatorEventPreview>;
  createdAtById: Record<string, string>;
  threadIdById: Record<string, string>;
  functionNameById: Record<string, string>;
  displayStatusById: Record<string, string>;
  displayVariantById: Record<string, string>;
}

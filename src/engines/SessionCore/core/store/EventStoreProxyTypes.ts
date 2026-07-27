import type { CanvasInlineMode } from "@src/engines/ChatPanel/blocks/CanvasInlineCard/types";
import type {
  SessionEvent,
  SimulatorEventPreview,
} from "@src/engines/SessionCore/core/types";

export interface LatestCanvasPreview {
  eventId: string;
  mode: CanvasInlineMode;
  url?: string;
  title?: string;
  streaming?: boolean;
}

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
  latestCanvasPreview?: LatestCanvasPreview;
  /** Active turn marker on materialized incremental streaming deltas. */
  streaming?: boolean;
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
  latestCanvasPreview?: LatestCanvasPreview;
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
  latestCanvasPreview?: LatestCanvasPreview;
  snapshotDelta: true;
  incrementalOrders?: boolean;
  memberships?: SnapshotEventMembership[];
  streaming?: boolean;
}

export interface SnapshotEventMembership {
  id: string;
  eventIndex: number;
  chat: boolean;
  messages: boolean;
  simulator: boolean;
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
  /** Visibility bits for chat/messages/simulator order membership. */
  orderMembershipById: Map<string, number>;
  runningEventIds: Set<string>;
  latestCanvasPreview?: LatestCanvasPreview;
}

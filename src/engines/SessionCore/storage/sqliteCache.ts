/**
 * SQLite Session Cache - High-Performance Local Storage
 *
 * Uses Tauri's Rust backend with SQLite + FTS5. All SessionEvent <-> CachedEvent
 * conversion now happens in Rust, eliminating JS-side serialization overhead.
 *
 * @example
 * ```typescript
 * await sqliteCache.saveEvents(sessionId, events);
 * const results = await sqliteCache.searchEvents(sessionId, "npm install");
 * const events = await sqliteCache.loadEvents(sessionId);
 * ```
 */
import { rpc } from "@src/api/tauri/rpc";

import { parseSessionSpecsJson } from "../core/schemas";
import type {
  EventPayloadBody,
  ExtractedGitArtifactData,
  ReplayTimeRange,
  SessionEvent,
  SessionSpec,
} from "../core/types";
import { TURN_WINDOW_RECENT_BODY_COUNT } from "../turns/turnWindowConfig";

// ============================================
// Types
// ============================================

export interface SessionMetadata {
  sessionId: string;
  eventCount: number;
  cachedAt: number;
  contentRevision: number;
  timeRangeStart?: string;
  timeRangeEnd?: string;
}

export interface SearchResult {
  event: SessionEvent;
  rank: number;
  snippet: string;
}

export interface CacheStats {
  totalSessions: number;
  totalEvents: number;
  dbSizeBytes: number;
}

export interface TruncateResult {
  deletedCount: number;
  deletedIds: string[];
  deletedSequences: number[];
}

// ============================================
// Cache API
// ============================================

export async function saveEvents(
  sessionId: string,
  events: SessionEvent[]
): Promise<void> {
  await rpc.sessionCore.cache.saveEvents({ sessionId, events });
}

export type TurnStatus =
  | "pending"
  | "working"
  | "completed"
  | "interrupted"
  | "failed";

export interface TurnModifiedFile {
  path: string;
  fileName: string;
  status: "created" | "modified" | "deleted";
  additions: number;
  deletions: number;
}

export interface TurnResourceInteraction {
  path: string;
  fileName: string;
  action: "read" | "write" | "create" | "delete" | "rename" | "search";
  outcome: "succeeded" | "failed" | "unknown";
  count: number;
  firstOccurredAt: string;
  lastOccurredAt: string;
}

export interface TurnSummary {
  sessionId: string;
  turnId: string;
  startSequence: number;
  endSequence: number | null;
  nextTurnId: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  userEventIds: string[];
  userPreview: string;
  eventCount: number;
  bodyEventCount: number;
  status: TurnStatus;
  interrupted: boolean;
  modifiedFiles: TurnModifiedFile[];
  resourceInteractions: TurnResourceInteraction[];
  gitArtifacts: ExtractedGitArtifactData[];
}

export interface TurnBodyWindow {
  turnId: string;
  events: SessionEvent[];
}

export interface InitialTurnWindow {
  turns: TurnSummary[];
  events: SessionEvent[];
}

export async function loadEvents(sessionId: string): Promise<SessionEvent[]> {
  return rpc.sessionCore.cache.loadEvents({ sessionId });
}

export async function loadTurnIndex(
  sessionId: string,
  turnIds?: string[]
): Promise<TurnSummary[]> {
  return rpc.sessionCore.cache.loadTurnIndex({ sessionId, turnIds });
}

export async function loadTurnBody(
  sessionId: string,
  turnId: string
): Promise<TurnBodyWindow> {
  return rpc.sessionCore.cache.loadTurnBody({ sessionId, turnId });
}

export async function loadEventPayload(
  sessionId: string,
  eventId: string,
  fieldPath: string
): Promise<EventPayloadBody | null> {
  return rpc.sessionCore.cache.loadEventPayload({
    sessionId,
    eventId,
    fieldPath,
  });
}

export async function loadInitialTurnWindow(
  sessionId: string,
  recentTurnCount = TURN_WINDOW_RECENT_BODY_COUNT
): Promise<InitialTurnWindow> {
  return rpc.sessionCore.cache.loadInitialTurnWindow({
    sessionId,
    recentTurnCount,
  });
}

export async function searchEvents(
  sessionId: string,
  query: string,
  limit = 50
): Promise<SearchResult[]> {
  if (!query.trim()) return [];
  return rpc.sessionCore.cache.searchEvents({
    sessionId,
    query,
    limit,
  }) as Promise<SearchResult[]>;
}

export async function getSessionMetadata(
  sessionId: string
): Promise<SessionMetadata | null> {
  return rpc.sessionCore.cache.getSessionMetadata({
    sessionId,
  });
}

export async function deleteSession(sessionId: string): Promise<void> {
  await rpc.sessionCore.cache.deleteSession({ sessionId });
}

export async function clearOldSessions(maxAgeHours = 24): Promise<number> {
  return rpc.sessionCore.cache.clearOldSessions({ maxAgeHours });
}

export async function getAllSessions(): Promise<SessionMetadata[]> {
  return rpc.sessionCore.cache.getAllSessions();
}

export async function getStats(): Promise<CacheStats | null> {
  return rpc.sessionCore.cache.getStats();
}

// ============================================
// Full Session API (events + specs + timeRange)
// ============================================

interface FullSessionPayload {
  sessionId: string;
  events: SessionEvent[];
  specsJson?: string;
  timeRangeStart?: string;
  timeRangeEnd?: string;
}

/**
 * Save a full session (events + specs + timeRange) in one Tauri call.
 * Preferred over `saveEvents` when specs/timeRange are available.
 */
export async function saveFullSession(
  sessionId: string,
  events: SessionEvent[],
  specs: SessionSpec[],
  timeRange: ReplayTimeRange
): Promise<void> {
  await rpc.sessionCore.cache.saveFullSession({
    payload: {
      sessionId,
      events,
      specsJson: specs.length > 0 ? JSON.stringify(specs) : undefined,
      timeRangeStart: timeRange.start || undefined,
      timeRangeEnd: timeRange.end || undefined,
    } satisfies FullSessionPayload,
  });
}

/**
 * Load a full session (events + specs + timeRange) in one Tauri call.
 * Returns null if the session is not cached.
 */
export async function loadFullSession(sessionId: string): Promise<{
  events: SessionEvent[];
  specs: SessionSpec[];
  timeRange: ReplayTimeRange;
} | null> {
  const result = (await rpc.sessionCore.cache.loadFullSession({
    sessionId,
  })) as FullSessionPayload | null;
  if (!result || result.events.length === 0) return null;

  const specs: SessionSpec[] = result.specsJson
    ? (parseSessionSpecsJson(result.specsJson) as SessionSpec[])
    : [];

  return {
    events: result.events,
    specs,
    timeRange: {
      start: result.timeRangeStart ?? "",
      end: result.timeRangeEnd ?? "",
    },
  };
}

// ============================================
// Message Editing API
// ============================================

export async function truncateAfterEvent(
  sessionId: string,
  eventId: string
): Promise<TruncateResult> {
  return rpc.sessionCore.cache.truncateAfterEvent({
    sessionId,
    eventId,
  });
}

export async function deleteEvent(
  sessionId: string,
  eventId: string
): Promise<boolean> {
  return rpc.sessionCore.cache.deleteEvent({ sessionId, eventId });
}

export async function updateEvent(
  sessionId: string,
  event: SessionEvent
): Promise<boolean> {
  return rpc.sessionCore.cache.updateEvent({
    sessionId,
    event,
  });
}

export async function clearSessionHistory(
  sessionId: string
): Promise<TruncateResult> {
  return rpc.sessionCore.cache.clearSessionHistory({ sessionId });
}

export async function getEvent(
  sessionId: string,
  eventId: string
): Promise<SessionEvent | null> {
  return rpc.sessionCore.cache.getEvent({
    sessionId,
    eventId,
  });
}

// ============================================
// Export API Object
// ============================================

export const sqliteCache = {
  saveEvents,
  loadEvents,
  saveFullSession,
  loadFullSession,
  searchEvents,
  getSessionMetadata,
  deleteSession,
  clearOldSessions,
  getAllSessions,
  getStats,
  truncateAfterEvent,
  deleteEvent,
  updateEvent,
  clearSessionHistory,
  getEvent,
};

export default sqliteCache;

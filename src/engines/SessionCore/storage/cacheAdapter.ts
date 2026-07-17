/**
 * Unified Cache Adapter
 *
 * Thin facade over sqliteCache. All SessionEvent <-> CachedEvent conversion
 * now happens in Rust, so this is mostly pass-through.
 */
import type { ReplayTimeRange, SessionEvent, SessionSpec } from "../core/types";
import * as sqliteCache from "./sqliteCache";

// ============================================
// Types
// ============================================

export interface SearchResult {
  event: SessionEvent;
  rank: number;
  snippet: string;
}

export interface CacheMetadata {
  sessionId: string;
  eventCount: number;
  cachedAt: number;
}

export interface CacheStats {
  totalSessions: number;
  totalEvents: number;
  dbSizeBytes: number;
}

// ============================================
// Cache API
// ============================================

export async function saveEvents(
  sessionId: string,
  events: SessionEvent[]
): Promise<void> {
  await sqliteCache.saveEvents(sessionId, events);
}

export async function loadEvents(sessionId: string): Promise<SessionEvent[]> {
  return sqliteCache.loadEvents(sessionId);
}

export async function loadTurnIndex(
  sessionId: string,
  turnIds?: string[]
): Promise<sqliteCache.TurnSummary[]> {
  return sqliteCache.loadTurnIndex(sessionId, turnIds);
}

export async function loadTurnBody(
  sessionId: string,
  turnId: string
): Promise<sqliteCache.TurnBodyWindow> {
  return sqliteCache.loadTurnBody(sessionId, turnId);
}

export async function loadInitialTurnWindow(
  sessionId: string,
  recentTurnCount?: number
): Promise<sqliteCache.InitialTurnWindow> {
  return sqliteCache.loadInitialTurnWindow(sessionId, recentTurnCount);
}

export async function saveFullSession(
  sessionId: string,
  events: SessionEvent[],
  specs: SessionSpec[],
  timeRange: ReplayTimeRange
): Promise<void> {
  await sqliteCache.saveFullSession(sessionId, events, specs, timeRange);
}

export async function loadFullSession(sessionId: string): Promise<{
  events: SessionEvent[];
  specs: SessionSpec[];
  timeRange: ReplayTimeRange;
} | null> {
  return sqliteCache.loadFullSession(sessionId);
}

export async function searchEvents(
  sessionId: string,
  query: string,
  limit = 50
): Promise<SearchResult[]> {
  return sqliteCache.searchEvents(sessionId, query, limit);
}

export async function isSessionCached(sessionId: string): Promise<boolean> {
  const meta = await sqliteCache.getSessionMetadata(sessionId);
  return meta !== null;
}

export async function getSessionMetadata(
  sessionId: string
): Promise<CacheMetadata | null> {
  const meta = await sqliteCache.getSessionMetadata(sessionId);
  if (!meta) return null;
  return {
    sessionId: meta.sessionId,
    eventCount: meta.eventCount,
    cachedAt: meta.cachedAt,
  };
}

export async function deleteSession(sessionId: string): Promise<void> {
  await sqliteCache.deleteSession(sessionId);
}

export async function clearOldSessions(maxAgeHours = 24): Promise<number> {
  return sqliteCache.clearOldSessions(maxAgeHours);
}

export async function getStats(): Promise<CacheStats | null> {
  return sqliteCache.getStats();
}

// ============================================
// Export API Object
// ============================================

export const cacheAdapter = {
  saveEvents,
  loadEvents,
  loadTurnIndex,
  loadTurnBody,
  loadInitialTurnWindow,
  saveFullSession,
  loadFullSession,
  searchEvents,
  isSessionCached,
  getSessionMetadata,
  deleteSession,
  clearOldSessions,
  getStats,
};

export default cacheAdapter;

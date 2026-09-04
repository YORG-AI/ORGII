/**
 * Hosted Key Activity API
 *
 * Reads hosted-key (ORGII key) session activity from the local Rust event
 * cache (`~/.orgii/sessions.db → events` table).
 *
 * `getHostedKeyActivity()` reads from the Tauri event cache.
 * `storeHostedKeyActivityBatch()` saves via the same cache.
 */
import { z } from "zod/v4";

import { rpc } from "@src/api/tauri/rpc";

// ============================================
// Types
// ============================================

export interface HostedKeyActivityEvent {
  event_id: string;
  event_type: string;
  data: Record<string, unknown>;
  created_at?: string;
}

export interface HostedKeyCursorData {
  cursor: string;
}

export interface HostedKeyActivityChunk {
  event_id: string;
  chunk_id: string;
  action_type: string;
  function: string;
  args: Record<string, unknown>;
  result: Record<string, unknown>;
  created_at: string;
  thread_id?: string;
  process_id?: string;
}

export interface HostedKeyActivityListData {
  chunks: HostedKeyActivityChunk[];
  total: number;
  has_more: boolean;
}

export interface HostedKeyActivityBatchRequest {
  events: HostedKeyActivityEvent[];
}

export interface HostedKeyActivityBatchData {
  stored: number;
  cursor: string;
}

const HostedKeyJsonRecordSchema = z.record(z.string(), z.unknown());

function parseHostedKeyJsonRecord(raw: string): Record<string, unknown> {
  return HostedKeyJsonRecordSchema.parse(JSON.parse(raw || "{}"));
}

// ============================================
// Hosted Key Activity from Rust Event Cache
// ============================================

const INITIAL_CURSOR = "0";

export async function getHostedKeyCursor(
  _sessionId: string,
  _onError?: () => void
) {
  // Cursor is not needed for local cache — always return initial
  return { data: { cursor: INITIAL_CURSOR } as HostedKeyCursorData, status: 0 };
}

/**
 * Load hosted-key session activity from the local Rust event cache.
 */
export async function getHostedKeyActivity(
  sessionId: string,
  _options?: { limit?: number; after?: string },
  _onError?: () => void
) {
  const events = await rpc.sessionCore.cache.loadCachedEvents({ sessionId });

  if (!events || !Array.isArray(events) || events.length === 0) {
    return {
      data: {
        chunks: [],
        total: 0,
        has_more: false,
      } as HostedKeyActivityListData,
      status: 0,
    };
  }

  // Convert CachedEvent rows → HostedKeyActivityChunk format
  const chunks: HostedKeyActivityChunk[] = events.map((event) => {
    const args = parseHostedKeyJsonRecord(event.argsJson);
    const result = parseHostedKeyJsonRecord(event.resultJson);

    return {
      event_id: event.id,
      chunk_id: event.id,
      action_type: event.eventType,
      function: event.functionName ?? event.eventType,
      args,
      result,
      created_at: event.createdAt,
      thread_id: event.threadId ?? undefined,
      process_id: undefined,
    };
  });

  return {
    data: {
      chunks,
      total: chunks.length,
      has_more: false,
    } as HostedKeyActivityListData,
    status: 0,
  };
}

/**
 * Store hosted-key activity events in the local Rust event cache.
 */
export async function storeHostedKeyActivityBatch(
  sessionId: string,
  events: HostedKeyActivityEvent[],
  _onError?: () => void
) {
  if (events.length === 0) {
    return {
      data: { stored: 0, cursor: INITIAL_CURSOR } as HostedKeyActivityBatchData,
      status: 0,
    };
  }

  // Convert HostedKeyActivityEvent → CachedEvent for Tauri
  const cachedEvents = events.map((event) => ({
    id: event.event_id,
    sessionId,
    eventType: event.event_type,
    functionName: null,
    threadId: null,
    argsJson: "{}",
    resultJson: JSON.stringify(event.data || {}),
    content: "",
    createdAt: event.created_at || new Date().toISOString(),
    metaJson: null,
    historySequence: null,
  }));

  await rpc.sessionCore.cache.saveCachedEvents({
    sessionId,
    events: cachedEvents,
  });

  return {
    data: {
      stored: events.length,
      cursor: INITIAL_CURSOR,
    } as HostedKeyActivityBatchData,
    status: 0,
  };
}

export function compareStreamIds(id1: string, id2: string): number {
  if (id1 === INITIAL_CURSOR) return -1;
  if (id2 === INITIAL_CURSOR) return 1;
  try {
    const [ts1, seq1] = id1.split("-").map(Number);
    const [ts2, seq2] = id2.split("-").map(Number);
    if (ts1 !== ts2) return ts1 < ts2 ? -1 : 1;
    return seq1 < seq2 ? -1 : seq1 > seq2 ? 1 : 0;
  } catch {
    return id1 < id2 ? -1 : id1 > id2 ? 1 : 0;
  }
}

// ============================================
// Export
// ============================================

export const hostedKeyActivityApi = {
  getHostedKeyCursor,
  getHostedKeyActivity,
  storeHostedKeyActivityBatch,
  compareStreamIds,
};

export default hostedKeyActivityApi;

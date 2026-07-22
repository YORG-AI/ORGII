import { getImportedHistorySourceBySessionId } from "@src/api/tauri/externalHistory";
import {
  type ExternalReplayCursor,
  type ExternalReplayTarget,
  type ExternalReplayWindow,
  externalReplayQueryWindowForTarget,
  resolveSecondaryReplayTarget,
} from "@src/api/tauri/externalHistory/replay";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";

export type RawTranscriptSource =
  | {
      kind: "external-history";
      sourceId: string;
      displayName: string;
      target: ExternalReplayTarget;
    }
  | {
      kind: "orgii-event-store";
      displayName: string;
    };

export interface RawTranscriptSnapshot {
  sessionId: string;
  source: RawTranscriptSource;
  loadedAt: string;
  entries: SessionEvent[];
  replay?: RawTranscriptReplayState;
}

export interface RawTranscriptReplayState {
  cursor: ExternalReplayCursor;
  windowStartSequence: number | null;
  turnHeaders: ExternalReplayWindow["turnHeaders"];
  totalTurnCount: number;
  hasOlder: boolean;
  ipcBytes: number;
  newerContentReleased?: boolean;
}

const RAW_REPLAY_EVENT_BUDGET = 1_000;
const RAW_REPLAY_BYTE_BUDGET = 16 * 1024 * 1024;

export function canCopyRawTranscript(
  snapshot: RawTranscriptSnapshot | null,
  maxBytes: number
): boolean {
  if (!snapshot) return false;
  if (snapshot.source.kind !== "external-history") return true;
  return Boolean(
    snapshot.replay &&
    !snapshot.replay.hasOlder &&
    !snapshot.replay.newerContentReleased &&
    snapshot.replay.ipcBytes <= maxBytes
  );
}

/**
 * Pretty-print an array without ever joining a string larger than `maxBytes`.
 * External replay uses this for the optional small-transcript Copy action;
 * large histories must use the Rust streamed exporter instead.
 */
export function stringifyJsonArrayBounded(
  entries: readonly unknown[],
  maxBytes: number
): string | null {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4) return null;
  const encoder = new TextEncoder();
  const pieces = ["[\n"];
  let bytes = 2;

  for (const [index, entry] of entries.entries()) {
    const serialized = JSON.stringify(entry, null, 2);
    if (serialized === undefined) return null;
    const indented = serialized.replace(/^/gm, "  ");
    const piece = `${index === 0 ? "" : ",\n"}${indented}`;
    const pieceBytes = encoder.encode(piece).byteLength;
    if (bytes + pieceBytes + 2 > maxBytes) return null;
    pieces.push(piece);
    bytes += pieceBytes;
  }

  pieces.push("\n]");
  return pieces.join("");
}

export function mergeRawSessionEvents(
  persistedEvents: SessionEvent[],
  liveEvents: SessionEvent[],
  sessionId: string
): SessionEvent[] {
  const merged = new Map<string, SessionEvent>();
  for (const event of persistedEvents) {
    if (event.sessionId === sessionId) merged.set(event.id, event);
  }
  for (const event of liveEvents) {
    if (event.sessionId === sessionId) merged.set(event.id, event);
  }
  return Array.from(merged.values()).sort((left, right) => {
    const timeOrder = left.createdAt.localeCompare(right.createdAt);
    return timeOrder === 0 ? left.id.localeCompare(right.id) : timeOrder;
  });
}

export async function loadRawSessionTranscript(
  sessionId: string
): Promise<RawTranscriptSnapshot> {
  const replayTarget = await resolveSecondaryReplayTarget(sessionId);
  if (replayTarget) {
    const externalSource = getImportedHistorySourceBySessionId(sessionId);
    const window = await externalReplayQueryWindowForTarget({
      target: replayTarget,
    });
    return {
      sessionId,
      source: {
        kind: "external-history",
        sourceId: replayTarget.sourceId,
        displayName:
          externalSource?.displayName ??
          replayTarget.sourceId.replace(/_/g, " "),
        target: replayTarget,
      },
      loadedAt: new Date().toISOString(),
      entries: window.events,
      replay: {
        cursor: window.cursor,
        windowStartSequence: window.windowStartSequence,
        turnHeaders: window.turnHeaders,
        totalTurnCount: window.totalTurnCount,
        hasOlder: window.hasOlder,
        ipcBytes: window.stats.ipcBytes,
      },
    };
  }

  const [persistedResult, liveResult] = await Promise.allSettled([
    eventStoreProxy.getPersistedEvents(sessionId),
    eventStoreProxy.getEvents(sessionId),
  ]);
  const persistedEvents =
    persistedResult.status === "fulfilled" ? persistedResult.value : [];
  const liveEvents = liveResult.status === "fulfilled" ? liveResult.value : [];
  if (
    persistedResult.status === "rejected" &&
    liveResult.status === "rejected"
  ) {
    throw persistedResult.reason;
  }

  return {
    sessionId,
    source: {
      kind: "orgii-event-store",
      displayName: "ORGII EventStore",
    },
    loadedAt: new Date().toISOString(),
    entries: mergeRawSessionEvents(persistedEvents, liveEvents, sessionId),
  };
}

function mergeReplayEvents(
  older: SessionEvent[],
  current: SessionEvent[],
  anticipatedBytes: number
): { entries: SessionEvent[]; bytes: number; released: boolean } {
  const seen = new Set<string>();
  const merged: SessionEvent[] = [];
  for (const event of [...older, ...current]) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    merged.push(event);
  }
  if (
    merged.length <= RAW_REPLAY_EVENT_BUDGET &&
    anticipatedBytes <= RAW_REPLAY_BYTE_BUDGET
  ) {
    return { entries: merged, bytes: anticipatedBytes, released: false };
  }

  // Keep the page the user is currently scrolling into (the older prefix)
  // and release the far-away newer tail. Each event is serialized alone, so
  // the budget check never creates a session-sized intermediate string.
  const bounded: SessionEvent[] = [];
  let bytes = 0;
  const encoder = new TextEncoder();
  for (const event of merged) {
    const eventBytes = encoder.encode(JSON.stringify(event)).byteLength;
    if (
      bounded.length >= RAW_REPLAY_EVENT_BUDGET ||
      (bounded.length > 0 && bytes + eventBytes > RAW_REPLAY_BYTE_BUDGET)
    ) {
      break;
    }
    bounded.push(event);
    bytes += eventBytes;
  }
  return { entries: bounded, bytes, released: bounded.length < merged.length };
}

/**
 * Read the preceding bounded replay page. The generation check is mandatory:
 * a truncate/replace between pages must reset the virtual transcript instead
 * of joining rows from two different source files.
 */
export async function loadOlderRawSessionTranscript(
  snapshot: RawTranscriptSnapshot
): Promise<RawTranscriptSnapshot> {
  if (
    snapshot.source.kind !== "external-history" ||
    !snapshot.replay?.hasOlder
  ) {
    return snapshot;
  }
  const oldestSequence = snapshot.replay.windowStartSequence;
  if (oldestSequence === null) return snapshot;

  const window = await externalReplayQueryWindowForTarget({
    target: snapshot.source.target,
    beforeSequence: oldestSequence,
  });
  const sourceChanged =
    window.cursor.generation !== snapshot.replay.cursor.generation ||
    window.cursor.revision !== snapshot.replay.cursor.revision;
  if (sourceChanged) {
    // A stale `beforeSequence` belongs to the old immutable snapshot. Re-open
    // the latest bounded window instead of presenting an arbitrary older page
    // from the new generation/revision as if it were the canonical reset.
    const latest = await externalReplayQueryWindowForTarget({
      target: snapshot.source.target,
    });
    return {
      ...snapshot,
      loadedAt: new Date().toISOString(),
      entries: latest.events,
      replay: {
        cursor: latest.cursor,
        windowStartSequence: latest.windowStartSequence,
        turnHeaders: latest.turnHeaders,
        totalTurnCount: latest.totalTurnCount,
        hasOlder: latest.hasOlder,
        ipcBytes: latest.stats.ipcBytes,
        newerContentReleased: false,
      },
    };
  }
  const merged = mergeReplayEvents(
    window.events,
    snapshot.entries,
    snapshot.replay.ipcBytes + window.stats.ipcBytes
  );
  return {
    ...snapshot,
    loadedAt: new Date().toISOString(),
    entries: merged.entries,
    replay: {
      cursor: window.cursor,
      windowStartSequence: window.windowStartSequence,
      // Only the newly loaded page's oldest boundary is needed for the next
      // backward query. Retaining prior headers made metadata grow without
      // bound even after the corresponding event rows had been released.
      turnHeaders: window.turnHeaders,
      totalTurnCount: window.totalTurnCount,
      hasOlder: window.hasOlder,
      ipcBytes: merged.bytes,
      newerContentReleased:
        snapshot.replay.newerContentReleased || merged.released,
    },
  };
}

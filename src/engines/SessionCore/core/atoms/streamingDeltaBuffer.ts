/**
 * Write-buffer for `streamingDeltaContentAtom`.
 *
 * Token deltas arrive far faster than a per-token atom write can be
 * justified: each write cloned the whole per-session Map and re-rendered
 * every subscriber. Chunks are instead recorded synchronously in a
 * module-level holder and flushed into the atom on a trailing ~50ms timer
 * (≤20Hz). Every chunk carries the FULL accumulated content, so a flush
 * always replaces wholesale — buffering never loses text.
 *
 * Synchronous-flush guarantees:
 * - stream completion (`clearStreamingDelta`) flushes accumulated content
 *   first, then removes the entry — the last content write always carries
 *   the complete accumulated text;
 * - a kind change (thinking ↔ message) flushes immediately so the
 *   transition renders without buffer lag;
 * - the first chunk of an idle session flushes immediately (leading edge)
 *   so stream start is not delayed;
 * - clear paths that write the atom directly (session switch, timeline
 *   boundary) MUST call `discardStreamingDeltaBuffer` too, or a queued
 *   trailing flush resurrects the cleared session's content.
 */
import type { SetStateAction } from "react";

import type { StreamingDeltaContent, StreamingDeltaKind } from "./events";

const FLUSH_INTERVAL_MS = 50;

type SetStreamingDeltaContent = (
  update: SetStateAction<Map<string, StreamingDeltaContent>>
) => void;

/**
 * sessionId → newest un-flushed content. Entries are mutated in place only
 * until flushed; an object handed to the atom is never touched again.
 */
const pendingBySession = new Map<string, StreamingDeltaContent>();
/** Kind currently visible to atom consumers, per session. */
const deliveredKindBySession = new Map<string, StreamingDeltaKind>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushSetter: SetStreamingDeltaContent | null = null;

function cancelFlushTimer(): void {
  if (flushTimer === null) return;
  clearTimeout(flushTimer);
  flushTimer = null;
}

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushStreamingDeltas();
  }, FLUSH_INTERVAL_MS);
}

/** Write all buffered content into the atom now (one Map clone total). */
export function flushStreamingDeltas(): void {
  cancelFlushTimer();
  if (pendingBySession.size === 0 || !flushSetter) return;
  const updates = new Map(pendingBySession);
  pendingBySession.clear();
  for (const [sessionId, content] of updates) {
    deliveredKindBySession.set(sessionId, content.kind);
  }
  flushSetter((prev) => {
    const next = new Map(prev);
    for (const [sessionId, content] of updates) {
      next.set(sessionId, content);
    }
    return next;
  });
}

/**
 * Record a streaming chunk. `content.content` must be the full accumulated
 * text for the session (the adapters already stream cumulatively).
 */
export function bufferStreamingDelta(
  sessionId: string,
  content: StreamingDeltaContent,
  setStreamingDeltaContent: SetStreamingDeltaContent
): void {
  flushSetter = setStreamingDeltaContent;
  const pending = pendingBySession.get(sessionId);
  if (pending && pending.kind === content.kind) {
    pending.content = content.content;
    scheduleFlush();
    return;
  }
  pendingBySession.set(sessionId, {
    kind: content.kind,
    content: content.content,
  });
  const visibleKind = pending?.kind ?? deliveredKindBySession.get(sessionId);
  if (visibleKind !== content.kind) {
    // Leading edge (stream start) and kind changes render immediately.
    flushStreamingDeltas();
    return;
  }
  scheduleFlush();
}

/**
 * Stream completion / interruption for a session: flush the complete
 * accumulated content, then remove the session's entry from the atom.
 */
export function clearStreamingDelta(
  sessionId: string,
  setStreamingDeltaContent: SetStreamingDeltaContent
): void {
  flushSetter = setStreamingDeltaContent;
  flushStreamingDeltas();
  deliveredKindBySession.delete(sessionId);
  setStreamingDeltaContent((prev) => {
    if (!prev.has(sessionId)) return prev;
    const next = new Map(prev);
    next.delete(sessionId);
    return next;
  });
}

/**
 * Drop buffered content and cancel the pending flush WITHOUT writing the
 * atom. For callers that clear `streamingDeltaContentAtom` themselves; a
 * later flush must not re-insert the cleared session's content. Omitting
 * `sessionId` discards every session (full reset path).
 */
export function discardStreamingDeltaBuffer(sessionId?: string): void {
  if (sessionId === undefined) {
    pendingBySession.clear();
    deliveredKindBySession.clear();
  } else {
    pendingBySession.delete(sessionId);
    deliveredKindBySession.delete(sessionId);
  }
  if (pendingBySession.size === 0) {
    cancelFlushTimer();
  }
}

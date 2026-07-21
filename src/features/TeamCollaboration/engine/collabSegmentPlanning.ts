/**
 * Segments push planning (design §7.3) + the shared OCC conflict matcher.
 *
 * `computeFrozenEventCount` / `splitFrozenIntoSegments` serve the cloud push
 * engine; `isCollabConflictError` additionally serves the ProjectSyncChannel.
 */
import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import type { SessionEventsSegmentInput } from "../sync/CollabSyncBackend";

/** displayStatus values after which an event no longer mutates in place. */
const TERMINAL_EVENT_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
]);

/**
 * Frozen line (design §7.2): the frozen region is the longest event PREFIX
 * whose every event carries a terminal displayStatus ("completed"/"failed").
 * The first "running" / "pending" / "awaiting_user" event and everything
 * after it belong to the mutable tail. Events with no displayStatus (should
 * not happen — Rust always stamps it) count as terminal: a later in-place
 * mutation is still caught by the per-event hash chain and only costs an
 * epoch rewrite, whereas treating them as non-terminal would pin the frozen
 * line forever.
 */
export function computeFrozenEventCount(events: SessionEvent[]): number {
  for (let index = 0; index < events.length; index += 1) {
    const status = events[index]?.displayStatus;
    if (typeof status === "string" && !TERMINAL_EVENT_STATUSES.has(status)) {
      return index;
    }
  }
  return events.length;
}

/** Per-segment size budget (design §7.3 step 3a), measured pre-gzip. */
const SEGMENT_MAX_BYTES = 256 * 1024;

const segmentBudgetEncoder = new TextEncoder();

/**
 * Greedily pack frozen events into ≤256KB segments (at least one event per
 * segment, so an oversized single event still ships). `startSeq` is the seq
 * of the first produced segment. Budget is measured in canonical UTF-8
 * bytes — `String.length` counts UTF-16 code units and undercounts CJK/emoji
 * payloads by up to 3×, silently blowing the wire budget.
 */
export function splitFrozenIntoSegments(
  events: SessionEvent[],
  startSeq: number
): SessionEventsSegmentInput[] {
  const segments: SessionEventsSegmentInput[] = [];
  let current: SessionEvent[] = [];
  let currentBytes = 0;
  for (const event of events) {
    const eventBytes = segmentBudgetEncoder.encode(
      JSON.stringify(event)
    ).byteLength;
    if (current.length > 0 && currentBytes + eventBytes > SEGMENT_MAX_BYTES) {
      segments.push({ seq: startSeq + segments.length, events: current });
      current = [];
      currentBytes = 0;
    }
    current.push(event);
    currentBytes += eventBytes;
  }
  if (current.length > 0) {
    segments.push({ seq: startSeq + segments.length, events: current });
  }
  return segments;
}

/**
 * True for the server's opaque OCC rejection (append/rewrite anchors, the
 * project channel's whole-row upserts, lock acquisition): the self-hosted
 * plane raises `ORGII_CONFLICT`, the managed cloud raises `ORG2_CONFLICT`
 * (cloud-parity Phase B) — one dispatcher for both backends.
 */
export function isCollabConflictError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("ORGII_CONFLICT") ||
      error.message.includes("ORG2_CONFLICT"))
  );
}

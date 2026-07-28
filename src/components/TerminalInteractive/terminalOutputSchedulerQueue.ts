import { createLogger } from "@src/hooks/logger";

import { scheduleAck } from "./terminalOutputSchedulerAck";
import {
  ansiSequenceLength,
  findAnsiSafeSplit,
} from "./terminalOutputSchedulerAnsi";
import { HIDDEN_BACKLOG_CAP } from "./terminalOutputSchedulerConstants";
import type {
  PaneScheduler,
  SchedulerEntry,
} from "./terminalOutputSchedulerTypes";

const log = createLogger("TerminalOutputScheduler");

const QUEUE_COMPACT_MIN_DEAD = 16;
const DANGLING_SCAN_WINDOW = 4096;

/** Compact the dead queue prefix when its amortized cost is worthwhile. */
export function maybeCompactQueue(pane: PaneScheduler): void {
  const dead = pane.queueHead;
  if (dead >= QUEUE_COMPACT_MIN_DEAD && dead * 2 >= pane.queue.length) {
    pane.queue.splice(0, dead);
    pane.queueHead = 0;
  }
}

export function queueHasItems(pane: PaneScheduler): boolean {
  return pane.queueHead < pane.queue.length;
}

/**
 * Consume up to the pane's adaptive chunk size from the queue while preserving
 * ANSI boundaries and byte-accounting invariants.
 */
export function consumeChunk(pane: PaneScheduler): string | null {
  if (pane.queueHead >= pane.queue.length) return null;

  const entry = pane.queue[pane.queueHead];
  const chunkSize = pane.chunkSize;
  const remaining = entry.data.length - entry.start;

  if (remaining <= chunkSize) {
    const chunk =
      entry.start === 0 ? entry.data : entry.data.slice(entry.start);
    pane.queueHead++;
    maybeCompactQueue(pane);
    pane.queueByteLength -= entry.byteLength;
    pane.pendingAckBytes += entry.byteLength;
    return chunk;
  }

  // Resume from the previous safe boundary so a large entry is scanned O(n)
  // across all chunks instead of re-scanning its prefix each time.
  const targetSplitPos = entry.start + chunkSize;
  const splitAt = findAnsiSafeSplit(
    entry.data,
    targetSplitPos,
    entry.lastSafeSplitEnd
  );

  if (splitAt <= entry.start) {
    // A sequence longer than chunkSize must be emitted whole; splitting it
    // would corrupt terminal state even though this exceeds the byte budget.
    const chunk =
      entry.start === 0 ? entry.data : entry.data.slice(entry.start);
    pane.queueHead++;
    maybeCompactQueue(pane);
    pane.queueByteLength -= entry.byteLength;
    pane.pendingAckBytes += entry.byteLength;
    return chunk;
  }

  const chunk = entry.data.slice(entry.start, splitAt);
  const chunkChars = splitAt - entry.start;

  // The backend treats this proportional byte count as a flow-control hint.
  const totalChars = entry.data.length - entry.start;
  const chunkBytes =
    totalChars > 0
      ? Math.round((chunkChars / totalChars) * entry.byteLength)
      : entry.byteLength;

  entry.start = splitAt;
  entry.lastSafeSplitEnd = splitAt;
  entry.byteLength -= chunkBytes;
  pane.queueByteLength -= chunkBytes;
  pane.pendingAckBytes += chunkBytes;
  return chunk;
}

/** Return an unterminated escape-sequence tail at the end of `s`. */
function danglingTailOf(s: string): string {
  const idx = s.lastIndexOf("\x1b");
  if (idx === -1) return "";
  return ansiSequenceLength(s, idx) === 0 ? s.slice(idx) : "";
}

/**
 * Skip the orphaned remainder of an ANSI sequence after its prefix was
 * dropped by backlog enforcement.
 */
export function repairDanglingTail(pane: PaneScheduler): void {
  const tail = pane.dropDanglingTail;
  if (!tail) return;
  if (pane.queueHead >= pane.queue.length) return;

  pane.dropDanglingTail = null;
  const head = pane.queue[pane.queueHead];
  const window =
    tail + head.data.slice(head.start, head.start + DANGLING_SCAN_WINDOW);
  const seqLen = ansiSequenceLength(window, 0);
  if (seqLen <= tail.length) return;

  const skipChars = Math.min(
    seqLen - tail.length,
    head.data.length - head.start
  );
  const remainingChars = head.data.length - head.start;
  const skippedBytes =
    remainingChars > 0
      ? Math.round((skipChars / remainingChars) * head.byteLength)
      : 0;

  head.start += skipChars;
  head.lastSafeSplitEnd = Math.max(head.lastSafeSplitEnd, head.start);
  head.byteLength -= skippedBytes;
  pane.queueByteLength -= skippedBytes;
  pane.pendingAckBytes += skippedBytes;

  if (head.start >= head.data.length) {
    pane.pendingAckBytes += head.byteLength;
    pane.queueByteLength -= head.byteLength;
    pane.queueHead++;
    maybeCompactQueue(pane);
  }
  scheduleAck(pane);
}

export function enforceBacklogCap(pane: PaneScheduler): void {
  if (pane.queueByteLength <= HIDDEN_BACKLOG_CAP) return;

  let dropped = 0;
  let lastDropped: SchedulerEntry | null = null;
  while (
    pane.queueHead < pane.queue.length &&
    pane.queueByteLength > HIDDEN_BACKLOG_CAP
  ) {
    const entry = pane.queue[pane.queueHead++];
    pane.queueByteLength -= entry.byteLength;
    dropped += entry.byteLength;
    lastDropped = entry;
  }
  maybeCompactQueue(pane);

  // Dropped bytes still consumed backend flow-control capacity.
  pane.pendingAckBytes += dropped;
  scheduleAck(pane);

  if (lastDropped) {
    pane.dropDanglingTail = danglingTailOf(lastDropped.data) || null;
    repairDanglingTail(pane);
  }

  log.warn(
    `[OutputScheduler] Backlog cap exceeded for session ${pane.sessionId}: dropped ${dropped} bytes`
  );

  // Insert the visible marker at the in-stream gap. Synthetic data carries
  // byteLength 0 because it is exempt from backend flow-control ACKs.
  pane.queue.splice(pane.queueHead, 0, {
    data: "\r\n\x1b[0m\x1b[33m[⚠ terminal output dropped: backlog limit reached]\x1b[0m\r\n",
    start: 0,
    byteLength: 0,
    lastSafeSplitEnd: 0,
  });
}

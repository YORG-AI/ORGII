/**
 * Terminal output scheduler compatibility facade and runtime orchestrator.
 *
 * The scheduler preserves four invariants:
 * - queued bytes reach terminal.write() in PTY arrival order;
 * - ANSI/VT sequences are never split across writes;
 * - every accepted byte is ACKed exactly once, including dropped data;
 * - foreground and background panes drain on isolated scheduling loops.
 */
import { flushAck, scheduleAck } from "./terminalOutputSchedulerAck";
import {
  BACKGROUND_DRAIN_INTERVAL_MS,
  BACKGROUND_TIME_BUDGET_MS,
  FOREGROUND_WRITES_PER_TURN,
  INITIAL_CHUNK_SIZE,
  INTERACTIVE_BYPASS_BUDGET,
  INTERACTIVE_BYPASS_SIZE_ANSI,
  INTERACTIVE_BYPASS_SIZE_HARD,
  INTERACTIVE_WINDOW_MS,
} from "./terminalOutputSchedulerConstants";
import {
  consumeChunk,
  enforceBacklogCap,
  maybeCompactQueue,
  queueHasItems,
  repairDanglingTail,
} from "./terminalOutputSchedulerQueue";
import {
  adaptChunkSize,
  getOrCreatePane,
  paneMap,
} from "./terminalOutputSchedulerState";
import type {
  PaneScheduler,
  WriteCallback,
} from "./terminalOutputSchedulerTypes";

// ============================================
// MessageChannel work loop
// ============================================

/**
 * Create a MessageChannel-backed scheduler port for a foreground pane.
 * Posting a macrotask yields to pending user input while avoiding RAF latency.
 */
function createMessageChannelPort(pane: PaneScheduler): MessagePort {
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    pane.mcPending = false;
    drainForegroundTurn(pane);
  };
  channel.port1.start();
  return channel.port2;
}

function postWorkTurn(pane: PaneScheduler): void {
  if (pane.mcPending) return;
  if (!pane.mcPort) {
    pane.mcPort = createMessageChannelPort(pane);
  }
  pane.mcPending = true;
  pane.mcPort.postMessage(null);
}

function writeAndMeasure(pane: PaneScheduler, chunk: string): void {
  const t0 = performance.now();
  pane.write(chunk);
  adaptChunkSize(pane, performance.now() - t0);
}

function drainForegroundTurn(pane: PaneScheduler): void {
  if (pane.suspended || !pane.foreground || !queueHasItems(pane)) return;

  for (let i = 0; i < FOREGROUND_WRITES_PER_TURN && queueHasItems(pane); i++) {
    const chunk = consumeChunk(pane);
    if (chunk !== null) {
      writeAndMeasure(pane, chunk);
    }
  }
  scheduleAck(pane);

  if (queueHasItems(pane)) {
    postWorkTurn(pane);
  }
}

function drainBackground(pane: PaneScheduler): void {
  pane.timerId = null;
  if (pane.suspended || !queueHasItems(pane)) return;

  const deadline = performance.now() + BACKGROUND_TIME_BUDGET_MS;
  while (queueHasItems(pane) && performance.now() < deadline) {
    const chunk = consumeChunk(pane);
    if (chunk !== null) {
      pane.write(chunk);
    }
  }
  scheduleAck(pane);

  if (queueHasItems(pane)) {
    pane.timerId = setTimeout(
      () => drainBackground(pane),
      BACKGROUND_DRAIN_INTERVAL_MS
    );
  }
}

function scheduleDrain(pane: PaneScheduler): void {
  if (pane.suspended) return;
  if (pane.foreground) {
    postWorkTurn(pane);
  } else if (pane.timerId === null && queueHasItems(pane)) {
    pane.timerId = setTimeout(
      () => drainBackground(pane),
      BACKGROUND_DRAIN_INTERVAL_MS
    );
  }
}

// ============================================
// Interactive low-latency path
// ============================================

function checkInteractiveBypass(
  pane: PaneScheduler,
  data: string,
  byteLength: number
): boolean {
  // Never overtake older output, and never write during snapshot restore.
  if (pane.suspended || queueHasItems(pane)) return false;

  const now = performance.now();
  if (now - pane.bypassWindowStart >= INTERACTIVE_WINDOW_MS) {
    pane.bypassWindowStart = now;
    pane.bypassBudgetUsed = 0;
  }

  if (now - pane.lastInputAt >= INTERACTIVE_WINDOW_MS) return false;
  if (pane.bypassBudgetUsed >= INTERACTIVE_BYPASS_BUDGET) return false;

  const sizeLimit = data.includes("\x1b")
    ? INTERACTIVE_BYPASS_SIZE_ANSI
    : INTERACTIVE_BYPASS_SIZE_HARD;
  if (byteLength > sizeLimit) return false;

  pane.bypassBudgetUsed += byteLength;
  pane.pendingAckBytes += byteLength;
  pane.write(data);
  scheduleAck(pane);
  return true;
}

// ============================================
// Public API
// ============================================

/** Register a terminal pane before scheduling output. */
export function registerPane(sessionId: string, write: WriteCallback): void {
  getOrCreatePane(sessionId, write);
}

/** Remove a pane, cancel its drain work, and ACK discarded queued bytes. */
export function unregisterPane(sessionId: string): void {
  const pane = paneMap.get(sessionId);
  if (!pane) return;

  if (pane.mcPort) {
    pane.mcPort.close();
    pane.mcPort = null;
  }
  if (pane.timerId !== null) {
    clearTimeout(pane.timerId);
  }

  for (let i = pane.queueHead; i < pane.queue.length; i++) {
    pane.pendingAckBytes += pane.queue[i].byteLength;
  }
  pane.queue.length = 0;
  pane.queueHead = 0;
  pane.queueByteLength = 0;
  flushAck(pane);

  paneMap.delete(sessionId);
}

/** Switch a pane between MessageChannel and coalesced timer draining. */
export function setPaneForeground(
  sessionId: string,
  foreground: boolean
): void {
  const pane = paneMap.get(sessionId);
  if (!pane || pane.foreground === foreground) return;

  pane.foreground = foreground;
  if (foreground) {
    if (pane.timerId !== null) {
      clearTimeout(pane.timerId);
      pane.timerId = null;
    }
    if (queueHasItems(pane)) {
      postWorkTurn(pane);
    }
  } else {
    if (pane.mcPort) {
      pane.mcPort.close();
      pane.mcPort = null;
    }
    pane.mcPending = false;
    if (queueHasItems(pane) && pane.timerId === null) {
      pane.timerId = setTimeout(
        () => drainBackground(pane),
        BACKGROUND_DRAIN_INTERVAL_MS
      );
    }
  }
}

/** Open the interactive-bypass window for a pane. */
export function notifyUserInput(sessionId: string): void {
  const pane = paneMap.get(sessionId);
  if (!pane) return;
  pane.lastInputAt = performance.now();
}

/** ACK bytes that cannot be rendered, such as an empty decoded chunk. */
export function ackBytesWithoutWrite(
  sessionId: string,
  byteCount: number
): void {
  const pane = paneMap.get(sessionId);
  if (!pane || byteCount <= 0) return;
  pane.pendingAckBytes += byteCount;
  scheduleAck(pane);
}

/** Pause all terminal writes while a reconnect snapshot is restored. */
export function suspendPane(sessionId: string): void {
  const pane = paneMap.get(sessionId);
  if (!pane) return;
  pane.suspended = true;
}

/**
 * Resume a pane and optionally discard queued data already represented by a
 * reconnect snapshot. Those pre-reset bytes are deliberately not ACKed.
 */
export function resumePane(sessionId: string, dropBeforeSeq?: number): void {
  const pane = paneMap.get(sessionId);
  if (!pane) return;
  pane.suspended = false;

  if (dropBeforeSeq !== undefined) {
    while (pane.queueHead < pane.queue.length) {
      const entry = pane.queue[pane.queueHead];
      if (entry.seq === undefined || entry.seq >= dropBeforeSeq) break;
      pane.queueByteLength -= entry.byteLength;
      pane.queueHead++;
    }
    maybeCompactQueue(pane);
  }

  scheduleDrain(pane);
}

/** Enqueue terminal output while preserving ordering and flow-control state. */
export function scheduleWrite(
  sessionId: string,
  data: string,
  byteLength: number,
  write: WriteCallback,
  seq?: number
): void {
  const pane = getOrCreatePane(sessionId, write);

  if (checkInteractiveBypass(pane, data, byteLength)) {
    return;
  }

  pane.queue.push({
    data,
    start: 0,
    byteLength,
    lastSafeSplitEnd: 0,
    seq,
  });
  pane.queueByteLength += byteLength;

  if (pane.dropDanglingTail) {
    repairDanglingTail(pane);
  }

  enforceBacklogCap(pane);
  scheduleDrain(pane);
}

/** Flush up to `maxBytes` immediately when a pane becomes visible. */
export function flushBacklog(sessionId: string, maxBytes: number): number {
  const pane = paneMap.get(sessionId);
  if (!pane || pane.suspended) return 0;

  const bytesBeforeFlush = pane.pendingAckBytes;
  while (queueHasItems(pane)) {
    const written = pane.pendingAckBytes - bytesBeforeFlush;
    if (written >= maxBytes) break;
    const chunk = consumeChunk(pane);
    if (chunk !== null) {
      pane.write(chunk);
    }
  }
  scheduleAck(pane);
  return pane.pendingAckBytes - bytesBeforeFlush;
}

/** Return the current queued byte count for diagnostics. */
export function getBacklogBytes(sessionId: string): number {
  return paneMap.get(sessionId)?.queueByteLength ?? 0;
}

/** Return the current adaptive chunk size for diagnostics and tests. */
export function getChunkSize(sessionId: string): number {
  return paneMap.get(sessionId)?.chunkSize ?? INITIAL_CHUNK_SIZE;
}

/** Return the pane's last measured foreground render time. */
export function getLastRenderMs(sessionId: string): number {
  return paneMap.get(sessionId)?.lastRenderMs ?? 0;
}

/** Apply an adaptive-sizing sample directly for unit tests. */
export function _testApplyRenderMs(sessionId: string, renderMs: number): void {
  const pane = paneMap.get(sessionId);
  if (!pane) return;
  adaptChunkSize(pane, renderMs);
}

// Keep the historical public module surface intact.
export {
  ansiSequenceLength,
  findAnsiSafeSplit,
} from "./terminalOutputSchedulerAnsi";
export {
  ADAPT_GROW_CONSECUTIVE_FRAMES,
  ADAPT_GROW_THRESHOLD_MS,
  ADAPT_SHRINK_THRESHOLD_MS,
  BACKGROUND_DRAIN_INTERVAL_MS,
  BACKGROUND_TIME_BUDGET_MS,
  FOREGROUND_WRITES_PER_TURN,
  HIDDEN_BACKLOG_CAP,
  INITIAL_CHUNK_SIZE,
  INTERACTIVE_BYPASS_BUDGET,
  INTERACTIVE_BYPASS_SIZE_ANSI,
  INTERACTIVE_BYPASS_SIZE_HARD,
  INTERACTIVE_WINDOW_MS,
  MAX_CHUNK_SIZE,
  MIN_CHUNK_SIZE,
} from "./terminalOutputSchedulerConstants";

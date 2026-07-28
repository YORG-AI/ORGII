import {
  ADAPT_GROW_CONSECUTIVE_FRAMES,
  ADAPT_GROW_THRESHOLD_MS,
  ADAPT_SHRINK_THRESHOLD_MS,
  INITIAL_CHUNK_SIZE,
  MAX_CHUNK_SIZE,
  MIN_CHUNK_SIZE,
} from "./terminalOutputSchedulerConstants";
import type {
  PaneScheduler,
  WriteCallback,
} from "./terminalOutputSchedulerTypes";

/** Module-level pane registry: one scheduling state machine per terminal. */
export const paneMap = new Map<string, PaneScheduler>();

export function getOrCreatePane(
  sessionId: string,
  write: WriteCallback
): PaneScheduler {
  let pane = paneMap.get(sessionId);
  if (!pane) {
    pane = {
      sessionId,
      write,
      queue: [],
      queueHead: 0,
      queueByteLength: 0,
      foreground: false,
      mcPort: null,
      mcPending: false,
      timerId: null,
      pendingAckBytes: 0,
      ackScheduled: false,
      lastInputAt: 0,
      bypassBudgetUsed: 0,
      bypassWindowStart: 0,
      chunkSize: INITIAL_CHUNK_SIZE,
      fastFrameStreak: 0,
      lastRenderMs: 0,
      suspended: false,
      dropDanglingTail: null,
    };
    paneMap.set(sessionId, pane);
  } else {
    pane.write = write;
  }
  return pane;
}

export function adaptChunkSize(pane: PaneScheduler, renderMs: number): void {
  pane.lastRenderMs = renderMs;

  if (renderMs > ADAPT_SHRINK_THRESHOLD_MS) {
    pane.chunkSize = Math.max(MIN_CHUNK_SIZE, pane.chunkSize >> 1);
    pane.fastFrameStreak = 0;
  } else if (renderMs < ADAPT_GROW_THRESHOLD_MS) {
    pane.fastFrameStreak++;
    if (pane.fastFrameStreak >= ADAPT_GROW_CONSECUTIVE_FRAMES) {
      pane.chunkSize = Math.min(MAX_CHUNK_SIZE, pane.chunkSize << 1);
      pane.fastFrameStreak = 0;
    }
  } else {
    pane.fastFrameStreak = 0;
  }
}

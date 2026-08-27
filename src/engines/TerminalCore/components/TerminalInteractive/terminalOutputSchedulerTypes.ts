export type WriteCallback = (data: string | Uint8Array) => void;

export interface SchedulerEntry {
  data: string;
  /** Cursor into `data` — bytes before this offset have already been consumed. */
  start: number;
  byteLength: number;
  /** Backend byte offset of this chunk's first byte, when supplied by the PTY. */
  seq?: number;
  /** Last ANSI-safe split boundary found for this entry. */
  lastSafeSplitEnd: number;
}

export interface PaneScheduler {
  sessionId: string;
  write: WriteCallback;
  queue: SchedulerEntry[];
  /** Index of the first unconsumed entry in `queue`. */
  queueHead: number;
  queueByteLength: number;
  foreground: boolean;
  /** MessageChannel port used for foreground work-loop posts. */
  mcPort: MessagePort | null;
  /** Whether a work-loop turn is already posted on the channel. */
  mcPending: boolean;
  /** Timer handle for background drain coalescing. */
  timerId: ReturnType<typeof setTimeout> | null;
  /** Bytes consumed but not yet ACKed. */
  pendingAckBytes: number;
  /** Whether an ACK flush is already scheduled. */
  ackScheduled: boolean;
  /** Timestamp of last user input to this pane. */
  lastInputAt: number;
  /** Bytes flushed via interactive bypass within the current window. */
  bypassBudgetUsed: number;
  /** Start time of the current interactive bypass window. */
  bypassWindowStart: number;
  /** Current adaptive chunk size for this pane. */
  chunkSize: number;
  /** Consecutive frames below the adaptive growth threshold. */
  fastFrameStreak: number;
  /** Last measured render time in milliseconds. */
  lastRenderMs: number;
  /** Whether all terminal writes are paused for snapshot restoration. */
  suspended: boolean;
  /** Unterminated escape-sequence tail left by the most recent backlog drop. */
  dropDanglingTail: string | null;
}

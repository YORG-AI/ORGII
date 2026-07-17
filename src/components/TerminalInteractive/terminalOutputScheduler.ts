/**
 * Terminal Output Scheduler
 *
 * Deep performance architecture:
 *
 * 1. MessageChannel work loop (not RAF/setTimeout) — yields to the browser's
 *    task scheduler between chunks with ~0ms latency instead of RAF's 4ms
 *    clamping floor. User input events preempt the work loop naturally because
 *    the channel posts a new macrotask, which sits in the task queue behind any
 *    pending input tasks.
 *
 * 2. ANSI-aware chunking — the chunk splitter parses escape sequences so chunk
 *    boundaries always fall between complete sequences. A mid-sequence split
 *    corrupts colour/cursor state in xterm (e.g. splitting ESC[33m leaves a
 *    partial CSI open).
 *
 * 3. Adaptive chunk sizing — measures wall-clock render time for each
 *    terminal.write() call and adjusts the per-chunk byte cap:
 *    - renderMs > 8ms  → halve chunk size (down to MIN_CHUNK_SIZE)
 *    - renderMs < 2ms  for 5 consecutive frames → double it (up to MAX_CHUNK_SIZE)
 *    This keeps frame time near 6–8ms regardless of terminal width/content.
 *
 * 4. Telemetry ACK — ack_pty_data carries { sessionId, byteCount, queueDepth,
 *    renderMs } so Rust can adaptively throttle at the PTY-reader level instead
 *    of just using a fixed watermark.
 *
 * 5. Background pane isolation — background panes use a separate MessageChannel
 *    with a 50ms coalescing timer, so their work loop never steals time slices
 *    from the foreground pane.
 *
 * Ordering invariant: bytes reach terminal.write() in exactly the order they
 * arrived from the PTY. Every fast path (interactive bypass) must yield to the
 * queue when older output is still buffered — an out-of-order write corrupts
 * cursor positioning and SGR state on screen.
 *
 * ACK invariant: every byte accepted by scheduleWrite is eventually ACKed to
 * the backend exactly once — written, dropped, or discarded on unregister.
 * Bytes that silently vanish shrink the backend flow-control window forever
 * and eventually stall the PTY reader (a stuck CLI).
 */
import { createLogger } from "@src/hooks/logger";
import { invokeTauri, isTauriReady } from "@src/util/platform/tauri/init";

const log = createLogger("TerminalOutputScheduler");

// ============================================
// Constants
// ============================================

/** Initial chunk size — scheduler adapts from here. */
const INITIAL_CHUNK_SIZE = 16 * 1024; // 16 KB

/** Minimum chunk size under heavy render load. */
const MIN_CHUNK_SIZE = 2 * 1024; // 2 KB

/** Maximum chunk size when renders are very fast. */
const MAX_CHUNK_SIZE = 64 * 1024; // 64 KB

/** Max foreground writes per work-loop turn. */
const FOREGROUND_WRITES_PER_TURN = 2;

/** Background drain interval in ms (coalescing timer). */
const BACKGROUND_DRAIN_INTERVAL_MS = 50;

/** Time budget per background drain tick (ms). */
const BACKGROUND_TIME_BUDGET_MS = 8;

/** Backlog cap for hidden/background panes. Drop oldest data beyond this. */
const HIDDEN_BACKLOG_CAP = 2 * 1024 * 1024; // 2 MB

/** Interactive bypass: write immediately if data arrives within this many ms of last user input. */
const INTERACTIVE_WINDOW_MS = 100;

/** Interactive bypass: max size for immediate write (hard limit). */
const INTERACTIVE_BYPASS_SIZE_HARD = 1024; // 1 KB

/** Interactive bypass: extended size limit when packet contains ESC/ANSI sequences. */
const INTERACTIVE_BYPASS_SIZE_ANSI = 16 * 1024; // 16 KB

/** Interactive bypass budget: max bytes flushed via fast-path per window. */
const INTERACTIVE_BYPASS_BUDGET = 32 * 1024; // 32 KB per 100 ms window

/**
 * Adaptive sizing thresholds.
 * Halve chunk size when a single write exceeds this.
 */
const ADAPT_SHRINK_THRESHOLD_MS = 8;
/** Grow chunk size after this many consecutive fast frames. */
const ADAPT_GROW_THRESHOLD_MS = 2;
const ADAPT_GROW_CONSECUTIVE_FRAMES = 5;

// ============================================
// Types
// ============================================

type WriteCallback = (data: string | Uint8Array) => void;

interface SchedulerEntry {
  data: string;
  /** Cursor into `data` — bytes before this offset have already been consumed. */
  start: number;
  byteLength: number;
  /**
   * Backend byte offset of this chunk's first byte (from the pty-output
   * payload). Used during reconnect to drop chunks already covered by the
   * restored snapshot. Undefined for legacy payloads and synthetic writes.
   */
  seq?: number;
  /**
   * The last position returned by `findAnsiSafeSplit` for this entry.
   *
   * O5 optimisation: since `findAnsiSafeSplit` always returns a position where
   * no ANSI sequence is open, the next call can resume scanning from here
   * instead of re-scanning from byte 0, reducing cumulative split work from
   * O(n²) to O(n) across all chunks of a large entry.
   *
   * Initialised to `entry.start` when the entry is enqueued (no prior split).
   */
  lastSafeSplitEnd: number;
}

interface PaneScheduler {
  sessionId: string;
  write: WriteCallback;
  queue: SchedulerEntry[];
  /**
   * Index of the first unconsumed entry in `queue`.
   *
   * Using a head pointer instead of Array.shift() avoids O(n) copies on
   * every consumed chunk. The array is compacted once it has grown past a
   * threshold relative to the live window.
   */
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
  /** Timestamp of last user input to this pane (for interactive bypass). */
  lastInputAt: number;
  /** Bytes flushed via interactive bypass within current window. */
  bypassBudgetUsed: number;
  /** Start time of the current 100 ms bypass window. */
  bypassWindowStart: number;
  /** Current adaptive chunk size for this pane. */
  chunkSize: number;
  /** Consecutive frames where renderMs was below ADAPT_GROW_THRESHOLD_MS. */
  fastFrameStreak: number;
  /** Last measured render time in ms (for telemetry). */
  lastRenderMs: number;
  /**
   * While true, nothing is written to the terminal (no drain, no bypass,
   * no flushBacklog) — incoming chunks only queue up. Used during reconnect
   * so live output cannot interleave with the snapshot restore.
   */
  suspended: boolean;
  /**
   * Unterminated escape-sequence tail left behind by the most recent
   * backlog drop. The head of the surviving queue starts mid-sequence;
   * the repair pass skips past the dangling remainder so it is never
   * rendered as literal text.
   */
  dropDanglingTail: string | null;
}

// ============================================
// ANSI sequence state machine
// ============================================

/**
 * Returns the length of a complete ANSI/VT escape sequence starting at
 * position `pos` in `s`, or 0 if the character at `pos` is not ESC.
 *
 * Handles:
 *   ESC [ ... final    (CSI — parameter bytes 0x30-0x3F, intermediate 0x20-0x2F, final 0x40-0x7E)
 *   ESC ] ... BEL/ST   (OSC — terminated by BEL \x07 or ESC \)
 *   ESC ( / ) / * / +  (Designate character set — 2-char)
 *   ESC # digit        (DEC private — 3-char)
 *   ESC P ... ST       (DCS — terminated by ST)
 *   ESC _              (APC)
 *   ESC ^              (PM)
 *   ESC X              (SOS)
 *   ESC c / ESC =, etc.(2-char sequences)
 *
 * Returns 0 if `s[pos] !== ESC` or if the sequence is incomplete (not yet
 * terminated) — in which case the caller must not split at this position.
 */
export function ansiSequenceLength(s: string, pos: number): number {
  if (pos >= s.length || s.charCodeAt(pos) !== 0x1b) return 0;

  const next = pos + 1 < s.length ? s.charCodeAt(pos + 1) : -1;
  if (next === -1) return 0; // incomplete — ESC at end of string

  // CSI: ESC [
  if (next === 0x5b) {
    // [
    let i = pos + 2;
    while (i < s.length) {
      const c = s.charCodeAt(i);
      if (c >= 0x40 && c <= 0x7e) return i - pos + 1; // final byte
      i++;
    }
    return 0; // incomplete
  }

  // OSC: ESC ]
  if (next === 0x5d) {
    // ]
    let i = pos + 2;
    while (i < s.length) {
      const c = s.charCodeAt(i);
      if (c === 0x07) return i - pos + 1; // BEL terminator
      if (c === 0x1b && i + 1 < s.length && s.charCodeAt(i + 1) === 0x5c) {
        // ST = ESC \
        return i - pos + 2;
      }
      i++;
    }
    return 0; // incomplete
  }

  // DCS: ESC P / APC: ESC _ / PM: ESC ^ / SOS: ESC X  — all ST-terminated
  if (
    next === 0x50 || // P
    next === 0x5f || // _
    next === 0x5e || // ^
    next === 0x58 // X
  ) {
    let i = pos + 2;
    while (i < s.length) {
      const c = s.charCodeAt(i);
      if (c === 0x1b && i + 1 < s.length && s.charCodeAt(i + 1) === 0x5c) {
        return i - pos + 2;
      }
      i++;
    }
    return 0; // incomplete
  }

  // Designate character set: ESC ( / ) / * / + — followed by one char
  if (
    next === 0x28 || // (
    next === 0x29 || // )
    next === 0x2a || // *
    next === 0x2b // +
  ) {
    return pos + 2 < s.length ? 3 : 0;
  }

  // DEC private: ESC # digit
  if (next === 0x23) {
    // #
    return pos + 2 < s.length ? 3 : 0;
  }

  // Everything else: 2-char sequence (ESC c, ESC =, ESC >, ESC 7/8, …)
  return 2;
}

/**
 * Find a safe chunk boundary in `s` at or before `targetPos` such that no
 * ANSI escape sequence is split.
 *
 * The algorithm scans forward from `fromPos` (default 0), tracking sequence
 * extents. A candidate split point is "safe" when it falls between sequences
 * (or between plain-text characters) and does not land inside a UTF-16
 * surrogate pair.
 *
 * `fromPos` optimisation (O5): if the caller already knows there are no open
 * ANSI sequences before `fromPos` (because a previous call returned that
 * position), scanning can resume from there. This reduces cumulative work from
 * O(n²) to O(n) when a large entry is split into many chunks.
 *
 * Precondition: `fromPos` must be a position where no ANSI sequence is open
 * (i.e., a previously returned safe split boundary). Passing an arbitrary
 * offset is unsafe and may produce incorrect splits.
 *
 * Returns the byte offset of the last safe split ≤ targetPos, or `fromPos`
 * if none found in the scanned window.
 */
export function findAnsiSafeSplit(
  s: string,
  targetPos: number,
  fromPos: number = 0
): number {
  if (targetPos >= s.length) return s.length;
  if (targetPos <= 0) return 0;

  // Fast path: fromPos already covers the entire range we need to check.
  // This happens when the cached boundary is at or beyond targetPos, meaning
  // the range [0, targetPos] is already known to contain no open sequences.
  if (fromPos >= targetPos) return targetPos;

  // Clamp fromPos to a valid start.
  const startPos = Math.max(0, fromPos);
  let i = startPos;
  let lastSafe = startPos;

  while (i < targetPos) {
    const c = s.charCodeAt(i);

    if (c === 0x1b) {
      // ESC — measure sequence
      const seqLen = ansiSequenceLength(s, i);
      if (seqLen === 0) {
        // Incomplete sequence — cannot split anywhere past here safely.
        // Return the last safe position before this ESC.
        return lastSafe;
      }
      const seqEnd = i + seqLen;
      if (seqEnd <= targetPos) {
        i = seqEnd;
        lastSafe = i; // safe to split immediately after a complete sequence
      } else {
        // Sequence crosses targetPos — back up to lastSafe
        return lastSafe;
      }
    } else {
      // Plain character — check for UTF-16 surrogate pairs
      if ((c & 0xfc00) === 0xd800 && i + 1 < s.length) {
        // High surrogate — must include the following low surrogate
        i += 2;
      } else {
        i += 1;
      }
      if (i <= targetPos) {
        lastSafe = i;
      }
    }
  }

  return lastSafe;
}

// ============================================
// Scheduler registry (module-level singleton map)
// ============================================

const paneMap = new Map<string, PaneScheduler>();

// ============================================
// MessageChannel work loop
// ============================================

/**
 * Create a MessageChannel-backed scheduler port for a pane.
 *
 * Why MessageChannel and not requestAnimationFrame?
 *
 * RAF has a 4ms clamping floor in background tabs (Chromium) and fires at most
 * once per vsync (~16ms). Between two RAF callbacks a flood of PTY output can
 * accumulate 30–60 KB that xterm then renders in one synchronous burst, causing
 * a visible hitch.
 *
 * MessageChannel posts a macrotask that the browser schedules cooperatively at
 * ~0ms — it will be preempted by pending user-input events (which sit in the
 * same task queue) so interactive keystrokes are never delayed by a drain turn.
 * We still self-throttle to FOREGROUND_WRITES_PER_TURN writes per turn to
 * avoid starving other JS work.
 */
function createMessageChannelPort(pane: PaneScheduler): MessagePort {
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    pane.mcPending = false;
    drainForegroundTurn(pane);
  };
  channel.port1.start();
  return channel.port2; // caller posts to port2 to trigger port1
}

function postWorkTurn(pane: PaneScheduler) {
  if (pane.mcPending) return;
  if (!pane.mcPort) {
    pane.mcPort = createMessageChannelPort(pane);
  }
  pane.mcPending = true;
  pane.mcPort.postMessage(null);
}

// ============================================
// Adaptive chunk sizing
// ============================================

function adaptChunkSize(pane: PaneScheduler, renderMs: number) {
  pane.lastRenderMs = renderMs;

  if (renderMs > ADAPT_SHRINK_THRESHOLD_MS) {
    // Slow render — halve chunk size immediately
    pane.chunkSize = Math.max(MIN_CHUNK_SIZE, pane.chunkSize >> 1);
    pane.fastFrameStreak = 0;
  } else if (renderMs < ADAPT_GROW_THRESHOLD_MS) {
    pane.fastFrameStreak++;
    if (pane.fastFrameStreak >= ADAPT_GROW_CONSECUTIVE_FRAMES) {
      pane.chunkSize = Math.min(MAX_CHUNK_SIZE, pane.chunkSize << 1);
      pane.fastFrameStreak = 0;
    }
  } else {
    // Medium range — reset streak so we don't grow prematurely
    pane.fastFrameStreak = 0;
  }
}

// ============================================
// Internal helpers
// ============================================

function getOrCreate(sessionId: string, write: WriteCallback): PaneScheduler {
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

function scheduleAck(pane: PaneScheduler) {
  if (pane.ackScheduled || pane.pendingAckBytes === 0) return;
  pane.ackScheduled = true;
  // Schedule ACK as a microtask so it goes out after the current write batch
  // but before the next macrotask (keepin latency low).
  queueMicrotask(() => {
    flushAck(pane);
  });
}

function flushAck(pane: PaneScheduler) {
  if (pane.pendingAckBytes > 0 && isTauriReady()) {
    invokeTauri("ack_pty_data", {
      sessionId: pane.sessionId,
      byteCount: pane.pendingAckBytes,
      queueDepth: pane.queueByteLength,
      renderMs: Math.round(pane.lastRenderMs),
    }).catch(() => undefined);
    pane.pendingAckBytes = 0;
  }
  pane.ackScheduled = false;
}

/**
 * Compact the queue array once the dead head segment grows too large.
 *
 * We only splice when the wasted prefix is ≥ 16 entries AND represents at
 * least half the allocated slots, so the amortised cost is O(1) per push.
 */
const QUEUE_COMPACT_MIN_DEAD = 16;

function maybeCompactQueue(pane: PaneScheduler) {
  const dead = pane.queueHead;
  if (dead >= QUEUE_COMPACT_MIN_DEAD && dead * 2 >= pane.queue.length) {
    pane.queue.splice(0, dead);
    pane.queueHead = 0;
  }
}

/**
 * Consume up to `chunkSize` bytes from the front of the queue,
 * respecting ANSI sequence boundaries.
 *
 * Returns null if queue is empty.
 *
 * Perf notes:
 * - Uses `queueHead` pointer instead of `Array.shift()` to avoid O(n)
 *   element-copy on every consumed entry.
 * - Tracks a `start` cursor inside each entry so partial-chunk draining
 *   never calls `String.slice()` to mutate the stored data; the slice is
 *   only taken once when emitting to xterm.
 */
function consumeChunk(pane: PaneScheduler): string | null {
  if (pane.queueHead >= pane.queue.length) return null;

  const entry = pane.queue[pane.queueHead];
  const chunkSize = pane.chunkSize;
  const remaining = entry.data.length - entry.start;

  if (remaining <= chunkSize) {
    // Whole entry fits — emit the remaining slice and advance head.
    const chunk =
      entry.start === 0 ? entry.data : entry.data.slice(entry.start);
    pane.queueHead++;
    maybeCompactQueue(pane);
    pane.queueByteLength -= entry.byteLength;
    pane.pendingAckBytes += entry.byteLength;
    return chunk;
  }

  // Find a safe split point, resuming from the last known-safe boundary so we
  // don't re-scan bytes that were already processed in earlier splits (O5).
  //
  // `lastSafeSplitEnd` tracks the last position returned by findAnsiSafeSplit
  // for this entry. We pass it as `fromPos` to skip re-scanning the prefix.
  // The invariant holds because findAnsiSafeSplit only returns positions where
  // no ANSI sequence is open.
  //
  // When entry.start has advanced (O1 head-pointer), lastSafeSplitEnd is always
  // ≥ entry.start (we keep it updated after each split), so the fromPos is
  // still valid for the current window.
  const targetSplitPos = entry.start + chunkSize;
  const fromPos = entry.lastSafeSplitEnd;
  const splitAt = findAnsiSafeSplit(entry.data, targetSplitPos, fromPos);

  if (splitAt <= entry.start) {
    // Edge case: the sequence starting at the current cursor is longer than
    // chunkSize — emit the entire remaining entry to avoid a mid-sequence
    // split. Temporarily exceeds chunk budget but is the only correct option.
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

  // Proportional byte accounting (approximate — char count ≠ byte count for
  // non-ASCII, but the scheduler treats byte_count as a flow-control hint).
  const totalChars = entry.data.length - entry.start;
  const chunkBytes =
    totalChars > 0
      ? Math.round((chunkChars / totalChars) * entry.byteLength)
      : entry.byteLength;

  // Advance the cursor — no string mutation, no re-allocation.
  // Also update lastSafeSplitEnd so the next split resumes from here (O5).
  entry.start = splitAt;
  entry.lastSafeSplitEnd = splitAt;
  entry.byteLength -= chunkBytes;
  pane.queueByteLength -= chunkBytes;
  pane.pendingAckBytes += chunkBytes;
  return chunk;
}

/**
 * Write a chunk and measure wall-clock render time to feed adaptive sizing.
 */
function writeAndMeasure(pane: PaneScheduler, chunk: string) {
  const t0 = performance.now();
  pane.write(chunk);
  const renderMs = performance.now() - t0;
  adaptChunkSize(pane, renderMs);
}

function queueHasItems(pane: PaneScheduler): boolean {
  return pane.queueHead < pane.queue.length;
}

function drainForegroundTurn(pane: PaneScheduler) {
  if (pane.suspended || !pane.foreground || !queueHasItems(pane)) return;

  for (let i = 0; i < FOREGROUND_WRITES_PER_TURN && queueHasItems(pane); i++) {
    const chunk = consumeChunk(pane);
    if (chunk !== null) {
      writeAndMeasure(pane, chunk);
    }
  }
  scheduleAck(pane);

  if (queueHasItems(pane)) {
    postWorkTurn(pane); // schedule next turn
  }
}

function drainBackground(pane: PaneScheduler) {
  pane.timerId = null;
  if (pane.suspended || !queueHasItems(pane)) return;

  const deadline = performance.now() + BACKGROUND_TIME_BUDGET_MS;
  while (queueHasItems(pane) && performance.now() < deadline) {
    const chunk = consumeChunk(pane);
    if (chunk !== null) {
      pane.write(chunk); // no measurement for background panes — saves CPU
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

function scheduleDrain(pane: PaneScheduler) {
  if (pane.suspended) return;
  if (pane.foreground) {
    postWorkTurn(pane);
  } else {
    if (pane.timerId === null && queueHasItems(pane)) {
      pane.timerId = setTimeout(
        () => drainBackground(pane),
        BACKGROUND_DRAIN_INTERVAL_MS
      );
    }
  }
}

/**
 * Returns the unterminated escape-sequence tail at the end of `s`, or ""
 * when `s` ends at a sequence boundary. The last ESC in the string is the
 * only candidate: if the sequence starting there is complete, everything
 * after it is plain text.
 */
function danglingTailOf(s: string): string {
  const idx = s.lastIndexOf("\x1b");
  if (idx === -1) return "";
  return ansiSequenceLength(s, idx) === 0 ? s.slice(idx) : "";
}

/** Max chars of the surviving head entry scanned to complete a dangling sequence. */
const DANGLING_SCAN_WINDOW = 4096;

/**
 * After a backlog drop, the first surviving entry may begin with the tail of
 * an escape sequence whose ESC prefix was dropped — xterm would render that
 * tail as literal text (e.g. `[38;2;26;26;26m`). Skip past the remainder,
 * keeping byte accounting and ACKs consistent.
 */
function repairDanglingTail(pane: PaneScheduler) {
  const tail = pane.dropDanglingTail;
  if (!tail) return;
  if (pane.queueHead >= pane.queue.length) return; // wait for the next chunk

  pane.dropDanglingTail = null;
  const head = pane.queue[pane.queueHead];
  const window =
    tail + head.data.slice(head.start, head.start + DANGLING_SCAN_WINDOW);
  const seqLen = ansiSequenceLength(window, 0);
  // seqLen === 0: the sequence still doesn't terminate within the scan
  // window — pathological (multi-KB sequence); give up rather than scan
  // unbounded input.
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
    // Entry fully consumed by the skip — retire it and ACK any residue.
    pane.pendingAckBytes += head.byteLength;
    pane.queueByteLength -= head.byteLength;
    pane.queueHead++;
    maybeCompactQueue(pane);
  }
  scheduleAck(pane);
}

function enforceBacklogCap(pane: PaneScheduler) {
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

  // Dropped bytes still count against the backend flow-control window —
  // ACK them or the window shrinks permanently and the PTY reader stalls.
  pane.pendingAckBytes += dropped;
  scheduleAck(pane);

  // If the last dropped chunk ended mid-escape-sequence, the surviving data
  // starts with an orphaned sequence tail; repair before it renders.
  if (lastDropped) {
    pane.dropDanglingTail = danglingTailOf(lastDropped.data) || null;
    repairDanglingTail(pane);
  }

  log.warn(
    `[OutputScheduler] Backlog cap exceeded for session ${pane.sessionId}: dropped ${dropped} bytes`
  );

  // Visible warning marker, inserted in-stream at the gap the drop created
  // (never written out-of-band — that would break ordering while suspended).
  // Leading SGR reset clears whatever text state the dropped output left
  // behind. byteLength 0: synthetic data is exempt from flow-control ACKs.
  pane.queue.splice(pane.queueHead, 0, {
    data: "\r\n\x1b[0m\x1b[33m[⚠ terminal output dropped: backlog limit reached]\x1b[0m\r\n",
    start: 0,
    byteLength: 0,
    lastSafeSplitEnd: 0,
  });
}

function checkInteractiveBypass(
  pane: PaneScheduler,
  data: string,
  byteLength: number
): boolean {
  // The bypass may only fire when nothing older is buffered: a bypass write
  // with a non-empty queue lands ahead of earlier output and scrambles
  // cursor/SGR state on screen. Suspended panes never write at all.
  if (pane.suspended || queueHasItems(pane)) return false;

  const now = performance.now();

  // Reset bypass window if needed
  if (now - pane.bypassWindowStart >= INTERACTIVE_WINDOW_MS) {
    pane.bypassWindowStart = now;
    pane.bypassBudgetUsed = 0;
  }

  if (now - pane.lastInputAt >= INTERACTIVE_WINDOW_MS) return false;
  if (pane.bypassBudgetUsed >= INTERACTIVE_BYPASS_BUDGET) return false;

  const containsAnsi = data.includes("\x1b");
  const sizeLimit = containsAnsi
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

/**
 * Register a pane with the scheduler.
 * Must be called once per terminal session before `scheduleWrite`.
 */
export function registerPane(sessionId: string, write: WriteCallback): void {
  getOrCreate(sessionId, write);
}

/**
 * Remove a pane from the scheduler and cancel any pending drain.
 */
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

  // The queue is discarded — ACK everything outstanding (consumed-but-unACKed
  // plus queued-but-never-written) so the backend flow-control window is not
  // left holding bytes that will never be acknowledged.
  for (let i = pane.queueHead; i < pane.queue.length; i++) {
    pane.pendingAckBytes += pane.queue[i].byteLength;
  }
  pane.queue.length = 0;
  pane.queueHead = 0;
  pane.queueByteLength = 0;
  flushAck(pane);

  paneMap.delete(sessionId);
}

/**
 * Set whether this pane is in the foreground (active/visible) or background.
 * Foreground panes drain on MessageChannel work loop; background on 50ms timer.
 */
export function setPaneForeground(
  sessionId: string,
  foreground: boolean
): void {
  const pane = paneMap.get(sessionId);
  if (!pane || pane.foreground === foreground) return;

  pane.foreground = foreground;

  if (foreground) {
    // Cancel background timer and switch to work-loop drain
    if (pane.timerId !== null) {
      clearTimeout(pane.timerId);
      pane.timerId = null;
    }
    if (queueHasItems(pane)) {
      postWorkTurn(pane);
    }
  } else {
    // Tear down MessageChannel work loop; switch to timer drain
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

/**
 * Notify the scheduler that the user typed into the given pane.
 * Enables the interactive bypass window for the next 100 ms.
 */
export function notifyUserInput(sessionId: string): void {
  const pane = paneMap.get(sessionId);
  if (!pane) return;
  pane.lastInputAt = performance.now();
}

/**
 * ACK bytes that will never be written (e.g. a chunk that decoded to an
 * empty string because it ended mid-codepoint). Keeps the backend
 * flow-control window in sync with bytes actually delivered.
 */
export function ackBytesWithoutWrite(
  sessionId: string,
  byteCount: number
): void {
  const pane = paneMap.get(sessionId);
  if (!pane || byteCount <= 0) return;
  pane.pendingAckBytes += byteCount;
  scheduleAck(pane);
}

/**
 * Suspend all terminal writes for a pane while a reconnect snapshot is being
 * fetched and applied. Incoming chunks queue in arrival order; nothing is
 * drained, bypassed, or flushed until resumePane.
 */
export function suspendPane(sessionId: string): void {
  const pane = paneMap.get(sessionId);
  if (!pane) return;
  pane.suspended = true;
}

/**
 * Resume draining after a reconnect snapshot has been written.
 *
 * `dropBeforeSeq`: backend byte offset already covered by the snapshot —
 * queued chunks that start below it were captured inside the snapshot and
 * would double-render if drained. They are removed without ACKing: the
 * backend reset its flow-control window when it served the snapshot, so
 * those bytes belong to the pre-reset window.
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

/**
 * Schedule output to be written to the terminal, applying backpressure and
 * priority rules.
 */
export function scheduleWrite(
  sessionId: string,
  data: string,
  byteLength: number,
  write: WriteCallback,
  seq?: number
): void {
  const pane = getOrCreate(sessionId, write);

  // Interactive bypass: go straight to terminal for interactive-feeling
  // output. Only fires when the queue is empty (ordering invariant).
  if (checkInteractiveBypass(pane, data, byteLength)) {
    return;
  }

  // Enqueue — lastSafeSplitEnd starts at 0 (no prior split for this entry).
  pane.queue.push({ data, start: 0, byteLength, lastSafeSplitEnd: 0, seq });
  pane.queueByteLength += byteLength;

  // A previous drop may have left an orphaned escape-sequence tail waiting
  // for the next chunk to complete it.
  if (pane.dropDanglingTail) {
    repairDanglingTail(pane);
  }

  enforceBacklogCap(pane);
  scheduleDrain(pane);
}

/**
 * Flush up to `maxBytes` of backlog immediately (used on tab show).
 * Returns the number of bytes actually written.
 */
export function flushBacklog(sessionId: string, maxBytes: number): number {
  const pane = paneMap.get(sessionId);
  if (!pane || pane.suspended) return 0;

  // Use pendingAckBytes as the byte-written counter — consumeChunk already
  // increments it by the stored byteLength of each entry, avoiding a
  // TextEncoder allocation per chunk.
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

/**
 * Returns the current backlog byte length for a pane (for diagnostics).
 */
export function getBacklogBytes(sessionId: string): number {
  return paneMap.get(sessionId)?.queueByteLength ?? 0;
}

/**
 * Returns the current adaptive chunk size for a pane (for diagnostics/tests).
 */
export function getChunkSize(sessionId: string): number {
  return paneMap.get(sessionId)?.chunkSize ?? INITIAL_CHUNK_SIZE;
}

/**
 * Returns the last measured render time in ms for a pane (for diagnostics/tests).
 */
export function getLastRenderMs(sessionId: string): number {
  return paneMap.get(sessionId)?.lastRenderMs ?? 0;
}

/**
 * Apply a render-time measurement to a pane's adaptive sizing state directly.
 * Only intended for unit tests — allows testing chunk size adaptation without
 * needing to fake `performance.now()` timing through the write path.
 */
export function _testApplyRenderMs(sessionId: string, renderMs: number): void {
  const pane = paneMap.get(sessionId);
  if (!pane) return;
  adaptChunkSize(pane, renderMs);
}

// ============================================
// Exported constants for tests
// ============================================
export {
  INITIAL_CHUNK_SIZE,
  MIN_CHUNK_SIZE,
  MAX_CHUNK_SIZE,
  FOREGROUND_WRITES_PER_TURN,
  BACKGROUND_DRAIN_INTERVAL_MS,
  BACKGROUND_TIME_BUDGET_MS,
  HIDDEN_BACKLOG_CAP,
  INTERACTIVE_WINDOW_MS,
  INTERACTIVE_BYPASS_SIZE_HARD,
  INTERACTIVE_BYPASS_SIZE_ANSI,
  INTERACTIVE_BYPASS_BUDGET,
  ADAPT_SHRINK_THRESHOLD_MS,
  ADAPT_GROW_THRESHOLD_MS,
  ADAPT_GROW_CONSECUTIVE_FRAMES,
};

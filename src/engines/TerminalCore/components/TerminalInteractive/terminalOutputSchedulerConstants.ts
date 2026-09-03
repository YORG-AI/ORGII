/** Initial chunk size — scheduler adapts from here. */
export const INITIAL_CHUNK_SIZE = 16 * 1024; // 16 KB

/** Minimum chunk size under heavy render load. */
export const MIN_CHUNK_SIZE = 2 * 1024; // 2 KB

/** Maximum chunk size when renders are very fast. */
export const MAX_CHUNK_SIZE = 64 * 1024; // 64 KB

/** Max foreground writes per work-loop turn. */
export const FOREGROUND_WRITES_PER_TURN = 2;

/** Background drain interval in ms (coalescing timer). */
export const BACKGROUND_DRAIN_INTERVAL_MS = 50;

/** Time budget per background drain tick (ms). */
export const BACKGROUND_TIME_BUDGET_MS = 8;

/**
 * Backlog cap for a pane whose drain cannot keep up. Oldest data is dropped
 * past this point and the gap is marked on screen.
 *
 * Sits above the backend's own in-flight window (`HIGH_WATERMARK`, 512_000
 * bytes) plus one PTY read (64 KiB). Ordinary backpressure already holds that
 * much output in flight before the reader parks, so a cap at or below it would
 * discard output that flow control was handling correctly rather than guarding
 * against a genuinely starved renderer.
 */
export const HIDDEN_BACKLOG_CAP = 1024 * 1024; // 1 MiB

/** Interactive bypass: write immediately if data arrives soon after user input. */
export const INTERACTIVE_WINDOW_MS = 100;

/** Interactive bypass: max size for immediate write (hard limit). */
export const INTERACTIVE_BYPASS_SIZE_HARD = 1024; // 1 KB

/** Interactive bypass: extended size limit for ESC/ANSI packets. */
export const INTERACTIVE_BYPASS_SIZE_ANSI = 16 * 1024; // 16 KB

/** Interactive bypass budget: max bytes flushed per interactive window. */
export const INTERACTIVE_BYPASS_BUDGET = 32 * 1024; // 32 KB per 100 ms window

/** Halve chunk size when a single write exceeds this render time. */
export const ADAPT_SHRINK_THRESHOLD_MS = 8;

/** Grow chunk size after enough consecutive renders below this threshold. */
export const ADAPT_GROW_THRESHOLD_MS = 2;

export const ADAPT_GROW_CONSECUTIVE_FRAMES = 5;

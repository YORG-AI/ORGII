/**
 * useDebouncedCallback
 *
 * React hooks for debouncing and throttling callbacks. Replaces the hand-rolled
 * `useRef<setTimeout> + clearTimeout + setTimeout` pattern used across 16+ files.
 *
 * Features:
 * - Keeps callback fresh via ref (no stale closures)
 * - Auto-cleanup on unmount
 * - Supports cancel/flush/pending
 * - Leading edge and maxWait options
 * - Type-safe with full generic arg support
 *
 * @example
 * ```typescript
 * // Basic debounce (trailing edge, 150ms)
 * const debouncedSearch = useDebouncedCallback((query: string) => {
 *   performSearch(query);
 * }, 150);
 *
 * // With maxWait (guarantees execution within maxWait ms)
 * const debouncedSave = useDebouncedCallback(
 *   (data: Data) => save(data),
 *   300,
 *   { maxWait: 1000 }
 * );
 *
 * // Control methods
 * debouncedSearch("query");
 * debouncedSearch.cancel();   // Cancel pending execution
 * debouncedSearch.flush();    // Execute pending immediately
 * debouncedSearch.pending();  // Check if execution is pending
 * ```
 */
import { useEffect, useMemo, useRef } from "react";

// ============================================
// Types
// ============================================

export interface DebouncedCallbackOptions {
  /** Execute on the leading edge (first call) instead of only on trailing */
  leading?: boolean;
  /** Maximum time the callback can be delayed before forced execution (ms) */
  maxWait?: number;
}

export interface DebouncedCallback<TArgs extends unknown[]> {
  /** Call the debounced function */
  (...args: TArgs): void;
  /** Cancel any pending invocation */
  cancel: () => void;
  /** Immediately execute the pending invocation (no-op if nothing pending) */
  flush: () => void;
  /** Returns true if there is a pending invocation */
  pending: () => boolean;
}

// ============================================
// useDebouncedCallback
// ============================================

/**
 * Creates a debounced version of a callback that delays execution until
 * after `delay` ms have elapsed since the last invocation.
 *
 * The callback ref is kept fresh automatically — no stale closure issues.
 * Timers are cleaned up on unmount and when delay/options change.
 *
 * @param callback - Function to debounce
 * @param delay - Milliseconds to wait before executing (trailing edge)
 * @param options - Optional leading edge and maxWait configuration
 * @returns Debounced function with cancel/flush/pending methods
 */
export function useDebouncedCallback<TArgs extends unknown[]>(
  callback: (...args: TArgs) => void,
  delay: number,
  options: DebouncedCallbackOptions = {}
): DebouncedCallback<TArgs> {
  const { leading = false, maxWait } = options;

  // Keep callback fresh to avoid stale closures (update in effect per project rules)
  const callbackRef = useRef(callback);
  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  // Debounce state — all managed via refs for stability
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastArgsRef = useRef<TArgs | null>(null);
  const leadingInvokedRef = useRef(false);

  // Cancel pending timers when delay/options change
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (maxTimerRef.current) {
        clearTimeout(maxTimerRef.current);
        maxTimerRef.current = null;
      }
      lastArgsRef.current = null;
      leadingInvokedRef.current = false;
    };
  }, [delay, leading, maxWait]);

  // Build the debounced function and its control methods.
  // Uses useMemo so the returned reference is stable across renders
  // (only recreated when delay/options change).
  // Refs are read/written inside the returned callbacks (event-time), not during render.
  const debounced = useMemo(() => {
    // --- Internal helpers ---

    /** Execute the pending callback and reset state */
    const invokeTrailing = () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (maxTimerRef.current) {
        clearTimeout(maxTimerRef.current);
        maxTimerRef.current = null;
      }
      const args = lastArgsRef.current;
      lastArgsRef.current = null;
      leadingInvokedRef.current = false;

      if (args) {
        callbackRef.current(...args);
      }
    };

    /** Cancel all pending timers and reset state */
    const cancel = () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (maxTimerRef.current) {
        clearTimeout(maxTimerRef.current);
        maxTimerRef.current = null;
      }
      lastArgsRef.current = null;
      leadingInvokedRef.current = false;
    };

    // --- The debounced function ---

    const fn = (...args: TArgs) => {
      const isFirstCall =
        !leadingInvokedRef.current && timerRef.current === null;

      // Always store the latest args for trailing invocation
      lastArgsRef.current = args;

      // Clear existing trailing timer
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }

      // Leading edge: invoke immediately on the first call in a burst
      if (leading && isFirstCall) {
        leadingInvokedRef.current = true;
        // Clear args — if no subsequent calls happen, trailing won't re-fire
        lastArgsRef.current = null;
        callbackRef.current(...args);
      }

      // maxWait: start a ceiling timer if not already running (throttle-like cap)
      if (maxWait !== undefined && maxTimerRef.current === null) {
        maxTimerRef.current = setTimeout(invokeTrailing, maxWait);
      }

      // Trailing edge timer: resets on every call
      timerRef.current = setTimeout(invokeTrailing, delay);
    };

    // Attach control methods
    fn.cancel = cancel;
    fn.flush = invokeTrailing;
    fn.pending = () => timerRef.current !== null;

    return fn as DebouncedCallback<TArgs>;
  }, [delay, leading, maxWait]);

  return debounced;
}

// ============================================
// Preset delay constants
// ============================================

/**
 * Standard debounce delay presets for consistent timing across the app.
 *
 * Use these instead of magic numbers to keep debounce behavior uniform.
 */
export const DEBOUNCE_DELAYS = {
  /** Instant-feel for UI feedback like hover highlights (16ms / 1 frame) */
  FRAME: 16,
  /** Fast response for localStorage writes, stream batching (100ms) */
  STORAGE: 100,
  /** Standard for search inputs, file filtering (150ms — matches VS Code) */
  SEARCH: 150,
  /** Moderate for API calls, file sync, terminal creation (300ms) */
  API: 300,
  /** Relaxed for expensive operations like in-file search, component indexing (500ms) */
  EXPENSIVE: 500,
  /** Slow for auto-save, document persistence (1000ms) */
  AUTOSAVE: 1000,
  /** Very slow for re-indexing, batch operations (2000ms) */
  REINDEX: 2000,
} as const;

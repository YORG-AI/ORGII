/**
 * Debounce Utility
 *
 * Delays function execution until after a specified time has elapsed
 * since the last time it was invoked. Useful for rate-limiting expensive operations.
 *
 * @example
 * ```typescript
 * const debouncedSave = debounce((data) => {
 *   saveToAPI(data);
 * }, 300);
 *
 * // Only the last call within 300ms will execute
 * debouncedSave(data1);
 * debouncedSave(data2);
 * debouncedSave(data3); // Only this one executes
 * ```
 */

// ============================================
// Types
// ============================================

export type DebouncedFunction<T extends (...args: unknown[]) => unknown> = {
  (...args: Parameters<T>): void;
  cancel: () => void;
  flush: () => void;
  pending: () => boolean;
};

// ============================================
// Debounce Implementation
// ============================================

/**
 * Create a debounced version of a function
 *
 * @param func Function to debounce
 * @param wait Milliseconds to wait before executing
 * @param options Options for debouncing behavior
 * @returns Debounced function with cancel/flush/pending methods
 */
export function debounce<T extends (...args: unknown[]) => unknown>(
  func: T,
  wait: number,
  options: {
    /** Execute on leading edge instead of trailing */
    leading?: boolean;
    /** Maximum time func can be delayed before it's invoked */
    maxWait?: number;
  } = {}
): DebouncedFunction<T> {
  let timeoutId: NodeJS.Timeout | null = null;
  let maxTimeoutId: NodeJS.Timeout | null = null;
  let lastArgs: Parameters<T> | null = null;
  let lastThis: unknown = null;
  let lastCallTime: number | null = null;
  let lastInvokeTime = 0;

  const { leading = false, maxWait } = options;

  function invokeFunc(time: number) {
    const args = lastArgs;
    const thisArg = lastThis;

    lastArgs = null;
    lastThis = null;
    lastInvokeTime = time;

    if (args) {
      return func.apply(thisArg, args);
    }
  }

  function leadingEdge(time: number) {
    // Reset any `maxWait` timer
    lastInvokeTime = time;

    // Start the timer for the trailing edge
    timeoutId = setTimeout(timerExpired, wait);

    // Invoke the leading edge
    return leading ? invokeFunc(time) : undefined;
  }

  function remainingWait(time: number): number {
    const timeSinceLastCall = time - (lastCallTime || 0);
    const timeSinceLastInvoke = time - lastInvokeTime;
    const timeWaiting = wait - timeSinceLastCall;

    if (maxWait !== undefined) {
      return Math.min(timeWaiting, maxWait - timeSinceLastInvoke);
    }

    return timeWaiting;
  }

  function shouldInvoke(time: number): boolean {
    const timeSinceLastCall = time - (lastCallTime || 0);
    const timeSinceLastInvoke = time - lastInvokeTime;

    // Either this is the first call, activity has stopped, or we've hit the maxWait
    return (
      lastCallTime === null ||
      timeSinceLastCall >= wait ||
      timeSinceLastCall < 0 ||
      (maxWait !== undefined && timeSinceLastInvoke >= maxWait)
    );
  }

  function timerExpired() {
    const time = Date.now();

    if (shouldInvoke(time)) {
      return trailingEdge(time);
    }

    // Restart the timer
    timeoutId = setTimeout(timerExpired, remainingWait(time));
  }

  function trailingEdge(time: number) {
    timeoutId = null;

    // Only invoke if we have `lastArgs` (i.e., func was called at least once)
    if (lastArgs) {
      return invokeFunc(time);
    }

    lastArgs = null;
    lastThis = null;
  }

  function cancel() {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    if (maxTimeoutId !== null) {
      clearTimeout(maxTimeoutId);
      maxTimeoutId = null;
    }
    lastInvokeTime = 0;
    lastArgs = null;
    lastThis = null;
    lastCallTime = null;
  }

  function flush() {
    if (timeoutId === null && maxTimeoutId === null) {
      return;
    }

    const pendingArgs = lastArgs;
    const pendingThis = lastThis;
    cancel();
    if (pendingArgs) {
      lastArgs = pendingArgs;
      lastThis = pendingThis;
      return invokeFunc(Date.now());
    }
  }

  function pending(): boolean {
    return timeoutId !== null || maxTimeoutId !== null;
  }

  function debounced(this: unknown, ...args: Parameters<T>): void {
    const time = Date.now();
    const isInvoking = shouldInvoke(time);

    lastArgs = args;
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Required to preserve `this` context for deferred invocation
    lastThis = this;
    lastCallTime = time;

    if (isInvoking) {
      if (timeoutId === null) {
        leadingEdge(lastCallTime);
        return;
      }
      if (maxWait !== undefined) {
        timeoutId = setTimeout(timerExpired, wait);
        invokeFunc(lastCallTime);
        return;
      }
    }

    if (timeoutId === null) {
      timeoutId = setTimeout(timerExpired, wait);
    }
  }

  debounced.cancel = cancel;
  debounced.flush = flush;
  debounced.pending = pending;

  return debounced;
}

// ============================================
// React Hook Debounce
// ============================================

// For React components, use the dedicated hooks instead of this utility:
//
//   import { useDebouncedCallback } from "@src/hooks/perf";
//
// These hooks handle cleanup on unmount, keep callbacks fresh (no stale
// closures), and provide cancel/flush/pending methods.
//
// This file's `debounce` / `debounceAsync` are for non-React contexts
// (services, stores, plain utilities).

// ============================================
// Promise-Based Debounce (Async Pattern)
// ============================================

/**
 * Create a debounced version of a function that returns a Promise
 *
 * Unlike the standard debounce, this version returns a Promise that resolves
 * with the function's return value. Useful when you need to await the result.
 *
 * @param func Function to debounce
 * @param delay Milliseconds to wait before executing
 * @param options Options for debouncing behavior
 * @returns Debounced function that returns a Promise
 *
 * @example
 * ```typescript
 * const debouncedSearch = debounceAsync(async (query) => {
 *   return await searchAPI(query);
 * }, 300);
 *
 * // Can await the result
 * const results = await debouncedSearch('query');
 * ```
 */
export function debounceAsync<TArgs extends unknown[], TReturn>(
  func: (...args: TArgs) => TReturn,
  delay: number,
  options: { immediate?: boolean } = {}
): (...args: TArgs) => Promise<Awaited<TReturn>> {
  let timeoutId: NodeJS.Timeout | null = null;
  const isImmediate = options.immediate;

  return (...args: TArgs): Promise<Awaited<TReturn>> => {
    return new Promise((resolve, reject) => {
      const later = () => {
        timeoutId = null;
        if (!isImmediate) {
          try {
            const result = func(...args);
            resolve(result as Awaited<TReturn>);
          } catch (error) {
            reject(error);
          }
        }
      };

      const callNow = isImmediate && !timeoutId;

      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      timeoutId = setTimeout(later, delay);

      if (callNow) {
        try {
          const result = func(...args);
          resolve(result as Awaited<TReturn>);
        } catch (error) {
          reject(error);
        }
      }
    });
  };
}

export default debounce;

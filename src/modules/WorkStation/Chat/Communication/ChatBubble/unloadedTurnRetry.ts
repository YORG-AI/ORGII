/**
 * Pure bounded-retry logic for `UnloadedTurnBubble`'s eviction-aware
 * refetch. Extracted from the component so the decision logic is testable
 * without a React render environment (no @testing-library in this repo's
 * unit-test setup — see `useReplayTurnPrefetch.test.ts` for the same
 * pattern).
 *
 * Context: a placeholder's own lazy-load can resolve successfully and still
 * leave the placeholder on screen — a concurrent sibling placeholder's
 * `pruneLoadedTurnBodies` call can evict the just-loaded body before this
 * placeholder ever gets to render it (see `mountedTurnPlaceholders.ts`).
 * `UnloadedTurnBubble` only renders while the store still holds the
 * placeholder for its turn, so "still mounted a short delay after our own
 * load resolved" is the observable signal that the body never actually
 * landed (evicted, or an empty response). This module decides what happens
 * next: retry a bounded number of times, then hand off to a manual
 * "tap to retry" affordance instead of spinning forever.
 */

export const MAX_UNLOADED_TURN_RETRIES = 2;
export const UNLOADED_TURN_RETRY_DELAY_MS = 2000;

export interface UnloadedTurnRetryDecision {
  /** Whether an automatic refetch should fire. */
  shouldRetry: boolean;
  /** Attempt count to carry into the next decision. */
  nextAttempt: number;
}

/**
 * Given how many automatic retries have already fired (`attempt`, starting
 * at 0 for "none yet"), decide whether another automatic retry is allowed.
 * Once `attempt` reaches `maxRetries`, retries stop and the caller should
 * surface a manual retry affordance instead.
 */
export function decideUnloadedTurnRetry(
  attempt: number,
  maxRetries: number = MAX_UNLOADED_TURN_RETRIES
): UnloadedTurnRetryDecision {
  if (attempt >= maxRetries) {
    return { shouldRetry: false, nextAttempt: attempt };
  }
  return { shouldRetry: true, nextAttempt: attempt + 1 };
}

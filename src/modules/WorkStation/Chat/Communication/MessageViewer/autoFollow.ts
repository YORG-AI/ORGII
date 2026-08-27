/**
 * Auto-follow (stick-to-bottom) decision logic for the streaming message
 * viewport.
 *
 * The message viewer snaps to the bottom whenever new content arrives so the
 * latest streamed output stays visible. That is only desirable while the user
 * is actually reading the tail: once they scroll up to review earlier content,
 * continuing to force the viewport to the bottom drags them back on every
 * delta and makes reading impossible (see the "scroll dragged back to bottom
 * while streaming" bug).
 *
 * These pure helpers own the "should we still follow the bottom?" decision so
 * it can be unit-tested without a DOM/render environment, matching the pure
 * selection-logic tests used elsewhere in this module.
 */

/** Distance (px) from the bottom still treated as "at the bottom". */
export const AUTO_FOLLOW_THRESHOLD_PX = 32;

export interface ViewportMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * Whether the viewport is within `threshold` pixels of the bottom.
 *
 * A container that cannot scroll (content shorter than the viewport) is always
 * considered at the bottom.
 */
export function isViewportAtBottom(
  metrics: ViewportMetrics,
  threshold: number = AUTO_FOLLOW_THRESHOLD_PX
): boolean {
  const distanceFromBottom =
    metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
  return distanceFromBottom <= threshold;
}

/**
 * Resolve the auto-follow state in response to a scroll event.
 *
 * - Returning to the bottom re-arms auto-follow.
 * - An upward scroll away from the bottom suspends auto-follow.
 * - Any other movement (downward, or horizontal-only) preserves the current
 *   state, so a programmatic snap-to-bottom does not accidentally re-arm while
 *   the user is still reading above.
 */
export function resolveAutoFollowOnScroll(params: {
  following: boolean;
  previousScrollTop: number;
  metrics: ViewportMetrics;
  threshold?: number;
}): boolean {
  const {
    following,
    previousScrollTop,
    metrics,
    threshold = AUTO_FOLLOW_THRESHOLD_PX,
  } = params;

  if (isViewportAtBottom(metrics, threshold)) {
    return true;
  }
  if (metrics.scrollTop < previousScrollTop) {
    return false;
  }
  return following;
}

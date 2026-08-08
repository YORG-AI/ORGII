/**
 * Window-focus signal for pollers that throttle while the app is in the
 * background. Same semantics as `useWindowFocusTracking` (which feeds the
 * backend's adaptive git polling): focused means the window has keyboard
 * focus and the document is visible.
 */
export function isWindowFocused(): boolean {
  // Non-DOM contexts (node test env, workers) count as focused so pollers
  // keep their foreground cadence rather than silently throttling.
  if (typeof document === "undefined") return true;
  return document.hasFocus() && !document.hidden;
}

/**
 * Invoke `handler` whenever focus returns to the window (window regains
 * focus, or the document becomes visible again). Returns an unsubscribe
 * function for effect cleanup.
 *
 * One physical regain raises BOTH events (a hidden window refocused fires
 * `focus` and `visibilitychange`); a short per-subscription window collapses
 * them so "one catch-up per edge" holds instead of consumers double-fetching.
 */
const FOCUS_REGAIN_COALESCE_MS = 500;

export function onWindowFocusRegained(handler: () => void): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => {};
  }
  let lastFiredAtMs = 0;
  const fire = () => {
    const now = Date.now();
    if (now - lastFiredAtMs < FOCUS_REGAIN_COALESCE_MS) return;
    lastFiredAtMs = now;
    handler();
  };
  const onFocus = () => fire();
  const onVisibility = () => {
    if (!document.hidden) fire();
  };
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

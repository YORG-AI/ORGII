import { useEffect } from "react";

export interface PositionSyncHandlers {
  readonly addEventListener: (
    type: string,
    listener: EventListener,
    capture?: boolean
  ) => void;
  readonly removeEventListener: (
    type: string,
    listener: EventListener,
    capture?: boolean
  ) => void;
  readonly requestAnimationFrame: (callback: FrameRequestCallback) => number;
  readonly cancelAnimationFrame: (id: number) => void;
  readonly setInterval: (
    callback: () => void,
    ms: number
  ) => ReturnType<typeof setInterval>;
  readonly clearInterval: (id: ReturnType<typeof setInterval>) => void;
}

/**
 * Core position-sync logic, extracted so it can be unit-tested without a
 * browser DOM or React harness. Call this once when the WebView becomes active
 * and invoke the returned cleanup when it closes.
 *
 * @returns cleanup function to call on teardown
 */
export function attachWebviewPositionSync(
  containerRef: { current: HTMLElement | null },
  updatePosition: () => void,
  pollInterval: number,
  env: PositionSyncHandlers
): () => void {
  let rafId: number | null = null;
  let lastRect = { x: 0, y: 0, width: 0, height: 0 };

  const scheduleUpdate = () => {
    if (rafId !== null) return;

    rafId = env.requestAnimationFrame(() => {
      rafId = null;
      if (!containerRef.current) return;

      const rect = containerRef.current.getBoundingClientRect();
      if (
        rect.left !== lastRect.x ||
        rect.top !== lastRect.y ||
        rect.width !== lastRect.width ||
        rect.height !== lastRect.height
      ) {
        lastRect = {
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
        };
        updatePosition();
      }
    });
  };

  env.addEventListener("resize", scheduleUpdate as EventListener);
  env.addEventListener("scroll", scheduleUpdate as EventListener, true);
  scheduleUpdate();

  const intervalId =
    pollInterval > 0 ? env.setInterval(scheduleUpdate, pollInterval) : null;

  return () => {
    env.removeEventListener("resize", scheduleUpdate as EventListener);
    env.removeEventListener("scroll", scheduleUpdate as EventListener, true);
    if (intervalId !== null) env.clearInterval(intervalId);
    if (rafId !== null) env.cancelAnimationFrame(rafId);
  };
}

const windowEnv: PositionSyncHandlers = {
  addEventListener: (type, listener, capture) =>
    window.addEventListener(type, listener, capture),
  removeEventListener: (type, listener, capture) =>
    window.removeEventListener(type, listener, capture),
  requestAnimationFrame: (cb) => requestAnimationFrame(cb),
  cancelAnimationFrame: (id) => cancelAnimationFrame(id),
  setInterval: (cb, ms) => setInterval(cb, ms),
  clearInterval: (id) => clearInterval(id),
};

/**
 * Syncs an overlaid native WebView's position whenever the container element
 * moves or resizes. Uses a RAF-debounced scheduleUpdate that fires on resize,
 * capture-phase scroll, and optionally on a polling interval.
 *
 * @param containerRef   - ref attached to the DOM node that the WebView overlays
 * @param isActive       - when false the effect is a no-op and listeners /
 *                         timers are cleaned up immediately
 * @param updatePosition - callback that pushes the current rect to the native
 *                         WebView layer; may be sync or async (return value ignored)
 * @param pollInterval   - milliseconds between periodic position checks; pass
 *                         0 to disable polling (default: 200)
 */
export function useWebviewPositionSync(
  containerRef: React.RefObject<HTMLElement | null>,
  isActive: boolean,
  updatePosition: () => void,
  pollInterval = 200
): void {
  useEffect(() => {
    if (!isActive) return;
    return attachWebviewPositionSync(
      containerRef,
      updatePosition,
      pollInterval,
      windowEnv
    );
  }, [isActive, updatePosition, containerRef, pollInterval]);
}

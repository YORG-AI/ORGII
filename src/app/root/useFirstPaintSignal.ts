/**
 * useFirstPaintSignal
 *
 * Owns two separate startup moments that used to be one:
 *
 * 1. **Splash dismissal** — as soon as React has committed and painted its
 *    first frame. The splash only exists to cover the gap before the bundle
 *    is alive; keeping it until the first route has content means the mark
 *    outlives its job and the app appears to be "stuck loading" while the
 *    shell is already there behind it.
 * 2. **`signalFirstPaintComplete`** — once `#root` actually has content. This
 *    releases deferred initialization and drops the native startup window
 *    background, both of which must wait for real painted pixels rather than
 *    an empty first commit.
 *
 * Two nested `requestAnimationFrame` calls are intentional:
 * - Frame 1: React has committed the DOM (paint scheduled)
 * - Frame 2: The browser has actually painted pixels to screen
 *
 * `useLayoutEffect` is used (rather than `useEffect`) so the rAF is scheduled
 * synchronously after DOM mutation, before the browser has a chance to run
 * its own paint pass.
 *
 * The refs prevent double-firing on React StrictMode's double-invocation of
 * effects in development.
 *
 * Note that the index.html watchdog is NOT cancelled by splash dismissal — it
 * stays armed until step 2, so an app that mounts but never renders anything
 * still gets the startup-error panel (which re-creates its own overlay when
 * the splash is already gone).
 */
import { useLayoutEffect, useRef } from "react";

import { resetChunkReloadCount } from "@src/util/core/init/chunkReload";
import { signalFirstPaintComplete } from "@src/util/core/init/deferredInit";

function getStartupElapsedMs(): number | null {
  const start = (
    window as unknown as { __ORGII_STARTUP_TIMING_START__?: unknown }
  ).__ORGII_STARTUP_TIMING_START__;
  if (typeof start !== "number") {
    return null;
  }
  return Math.round(performance.now() - start);
}

function isLocalDevOrigin(): boolean {
  return (
    window.location.protocol === "http:" &&
    /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname)
  );
}

function hasRenderableRootContent(): boolean {
  const root = document.getElementById("root");
  if (!root) {
    return false;
  }

  return root.childElementCount > 0;
}

function afterRenderableRootContent(callback: () => void): () => void {
  if (hasRenderableRootContent()) {
    callback();
    return () => undefined;
  }

  const root = document.getElementById("root");
  if (!root) {
    callback();
    return () => undefined;
  }

  let didRun = false;
  const observer = new MutationObserver(() => {
    if (!hasRenderableRootContent()) {
      return;
    }
    didRun = true;
    observer.disconnect();
    callback();
  });

  observer.observe(root, {
    childList: true,
    subtree: true,
  });

  return () => {
    if (!didRun) {
      observer.disconnect();
    }
  };
}

function emitFirstPaintMetric(): void {
  if (!isLocalDevOrigin()) {
    return;
  }

  void import("@tauri-apps/api/event")
    .then(({ emit }) =>
      emit("orgii-startup-first-paint", {
        elapsedMs: getStartupElapsedMs(),
      })
    )
    .catch(() => undefined);
}

export function useFirstPaintSignal(): void {
  const hasSignaledFirstPaint = useRef(false);
  const hasDismissedSplash = useRef(false);

  // React is alive and has painted a frame — the splash has nothing left to
  // cover. It is transparent apart from the mark, so dismissing it here only
  // removes the mark; the app background underneath is already the one the
  // app itself paints.
  useLayoutEffect(() => {
    if (hasDismissedSplash.current) return;

    const frameId = requestAnimationFrame(() => {
      if (hasDismissedSplash.current) return;
      hasDismissedSplash.current = true;

      // Removed outright rather than faded: a cross-fade would keep the mark
      // on screen after the app is already up, which is the delay this split
      // exists to remove.
      document.getElementById("splash")?.remove();
    });

    return () => cancelAnimationFrame(frameId);
  }, []);

  useLayoutEffect(() => {
    if (hasSignaledFirstPaint.current) return;

    return afterRenderableRootContent(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (hasSignaledFirstPaint.current) {
            return;
          }

          hasSignaledFirstPaint.current = true;
          signalFirstPaintComplete();
          emitFirstPaintMetric();

          // Real content is on screen — cancel the pre-bundle splash watchdog
          // (index.html) and clear the chunk-reload retry budget so a later
          // transient chunk failure still gets a fresh set of retries.
          const splashDone = (
            window as unknown as { __ORGII_SPLASH_DONE__?: () => void }
          ).__ORGII_SPLASH_DONE__;
          if (typeof splashDone === "function") {
            splashDone();
          }
          resetChunkReloadCount();
        });
      });
    });
  }, []);
}

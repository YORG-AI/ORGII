/**
 * useFirstPaintSignal
 *
 * Fires `signalFirstPaintComplete` after the browser has had two animation
 * frames to commit the initial render, then removes the HTML splash screen.
 *
 * Two nested `requestAnimationFrame` calls are intentional:
 * - Frame 1: React has committed the DOM (paint scheduled)
 * - Frame 2: The browser has actually painted pixels to screen
 *
 * `useLayoutEffect` is used (rather than `useEffect`) so the rAF is scheduled
 * synchronously after DOM mutation, before the browser has a chance to run
 * its own paint pass — guaranteeing the splash is removed in the same frame
 * as the first real content.
 *
 * `hasSignaledFirstPaint` ref prevents double-firing on React StrictMode's
 * double-invocation of effects in development.
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

  useLayoutEffect(() => {
    if (hasSignaledFirstPaint.current) return;

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (hasSignaledFirstPaint.current) {
          return;
        }

        hasSignaledFirstPaint.current = true;
        signalFirstPaintComplete();
        emitFirstPaintMetric();

        // The app committed its first paint — cancel the pre-bundle splash
        // watchdog (index.html) and clear the chunk-reload retry budget so a
        // later transient chunk failure still gets a fresh set of retries.
        const splashDone = (
          window as unknown as { __ORGII_SPLASH_DONE__?: () => void }
        ).__ORGII_SPLASH_DONE__;
        if (typeof splashDone === "function") {
          splashDone();
        }
        resetChunkReloadCount();

        const splash = document.getElementById("splash");
        if (splash) {
          splash.classList.add("fade-out");
          setTimeout(() => splash.remove(), 200);
        }
      });
    });
  }, []);
}

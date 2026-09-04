import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";

import { isTauriRuntimeHost } from "@src/hooks/logger/useLogger";
import { isWindowFocused } from "@src/util/core/windowFocus";

import {
  isAnyAppWindowFocused,
  subscribeCrossWindowFocus,
} from "./crossWindowFocus";

/**
 * Realtime demand is strictly tied to an interactive desktop window. Local
 * event writes and the durable project outbox use their own event-driven HTTP
 * paths, so a hidden window has no reason to retain a billable socket.
 * Returning focus reacquires immediately; each channel's SUBSCRIBED true-edge
 * performs the compensating recovery read.
 */
export interface Org2CloudRealtimeLeaseController {
  /** Re-evaluate foreground state after focus/blur/visibility changes. */
  refresh(): void;
  /** Release immediately (pagehide / app teardown). */
  releaseImmediately(): void;
  /** Stop publishing state transitions. */
  dispose(): void;
  /** Test/diagnostic snapshot; React consumers use the change callback. */
  isHeld(): boolean;
}

/**
 * A blurred-but-visible window keeps the lease for this long before the
 * release publishes. Routine focus flips (cmd-tab, dialogs, Spotlight) must
 * not pay a socket teardown, four channel re-joins, presence churn, and the
 * SUBSCRIBED-edge recovery listings; only a sustained departure should.
 */
export const REALTIME_LEASE_RELEASE_GRACE_MS = 45_000;

interface CreateOrg2CloudRealtimeLeaseControllerOptions {
  readonly isForeground: () => boolean;
  readonly isHidden: () => boolean;
  readonly onChange: (held: boolean) => void;
  readonly initialHeld?: boolean;
  readonly releaseGraceMs?: number;
}

/**
 * Small explicit state machine for the billable Realtime connection lease:
 * foreground = held; hidden = released immediately; blurred-but-visible =
 * released after one one-shot grace timer (cancelled on refocus). It contains
 * no cadence, polling loop, or keepalive of its own.
 */
export function createOrg2CloudRealtimeLeaseController({
  isForeground,
  isHidden,
  onChange,
  initialHeld = isForeground(),
  releaseGraceMs = REALTIME_LEASE_RELEASE_GRACE_MS,
}: CreateOrg2CloudRealtimeLeaseControllerOptions): Org2CloudRealtimeLeaseController {
  let held = initialHeld;
  let disposed = false;
  let releaseTimer: ReturnType<typeof setTimeout> | null = null;

  const cancelPendingRelease = () => {
    if (releaseTimer !== null) {
      clearTimeout(releaseTimer);
      releaseTimer = null;
    }
  };

  const publish = (nextHeld: boolean) => {
    if (held === nextHeld || disposed) return;
    held = nextHeld;
    onChange(nextHeld);
  };

  return {
    refresh: () => {
      if (isForeground()) {
        cancelPendingRelease();
        publish(true);
        return;
      }
      if (isHidden()) {
        cancelPendingRelease();
        publish(false);
        return;
      }
      if (!held || releaseTimer !== null) return;
      releaseTimer = setTimeout(() => {
        releaseTimer = null;
        if (disposed || isForeground()) return;
        publish(false);
      }, releaseGraceMs);
    },
    releaseImmediately: () => {
      cancelPendingRelease();
      publish(false);
    },
    dispose: () => {
      cancelPendingRelease();
      disposed = true;
    },
    isHeld: () => held,
  };
}

/**
 * Windows/WebView2 keeps `document.visibilityState` at "visible" across a
 * minimize (verified on real hardware 2026-08-07), so the lease's
 * immediate-release branch is unreachable there and a minimized window held
 * its billable socket for the full blur grace. The bridge tracks OS-level
 * minimize through the Tauri window handle instead: a blur re-probes
 * asynchronously, a focus clears synchronously (a focused window is never
 * minimized). The generation counter drops probe results that resolve after
 * a newer probe or an intervening focus — a stale `true` from a rapid
 * minimize→restore must not release a re-focused lease's socket.
 */
export interface Org2CloudLeaseMinimizeBridge {
  /** Current belief; feeds the lease's `isHidden` alongside visibility. */
  isMinimized(): boolean;
  /** Async re-read of the OS minimize state; call on blur (and at setup). */
  probe(): void;
  /** Synchronous reset on focus; invalidates in-flight probes. */
  clearOnFocus(): void;
}

export function createOrg2CloudLeaseMinimizeBridge(
  readIsMinimized: () => Promise<boolean>,
  onChange: () => void
): Org2CloudLeaseMinimizeBridge {
  let minimized = false;
  let probeGeneration = 0;
  return {
    isMinimized: () => minimized,
    probe: () => {
      const generation = ++probeGeneration;
      readIsMinimized().then(
        (next) => {
          if (generation !== probeGeneration || next === minimized) return;
          minimized = next;
          onChange();
        },
        () => undefined
      );
    },
    clearOnFocus: () => {
      probeGeneration += 1;
      if (!minimized) return;
      minimized = false;
      onChange();
    },
  };
}

function readWindowMinimized(): Promise<boolean> {
  if (typeof window === "undefined" || !isTauriRuntimeHost(window)) {
    return Promise.resolve(false);
  }
  return getCurrentWindow().isMinimized();
}

/**
 * The lease's foreground input is APP-wide, not window-wide: the socket is
 * owned by the main window, but the user may be working in a detached
 * session window that keeps main blurred. Own-window focus OR any peer
 * window's fresh focused claim counts (outside Tauri the aggregate collapses
 * to plain own-window focus).
 */
function isAppForeground(): boolean {
  return isWindowFocused() || isAnyAppWindowFocused();
}

/**
 * React binding for the connection lease. This hook owns browser lifecycle
 * listeners only; the caller remains the single owner of the Supabase client
 * and all of its channels.
 */
export function useOrg2CloudRealtimeLease(): boolean {
  const [held, setHeld] = useState(() => isAppForeground());
  const initialHeldRef = useRef(held);

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return undefined;
    }
    // The bridge's change callback closes over `controller` declared below;
    // probe resolutions are always asynchronous, so the reference is live by
    // the time it can run.
    const minimizeBridge = createOrg2CloudLeaseMinimizeBridge(
      readWindowMinimized,
      () => controller.refresh()
    );
    const controller = createOrg2CloudRealtimeLeaseController({
      isForeground: isAppForeground,
      isHidden: () =>
        document.visibilityState === "hidden" || minimizeBridge.isMinimized(),
      // Preserve the render-time truth so a focus transition between render
      // and effect setup is reconciled instead of silently skipped.
      initialHeld: initialHeldRef.current,
      onChange: setHeld,
    });

    const refresh = () => controller.refresh();
    const release = () => controller.releaseImmediately();
    const handleFocus = () => {
      minimizeBridge.clearOnFocus();
      controller.refresh();
    };
    const handleBlur = () => {
      controller.refresh();
      minimizeBridge.probe();
    };
    window.addEventListener("focus", handleFocus);
    window.addEventListener("blur", handleBlur);
    window.addEventListener("pagehide", release);
    window.addEventListener("pageshow", refresh);
    document.addEventListener("visibilitychange", refresh);
    // Peer windows' focus flips must re-evaluate the lease too: a detached
    // window blurring/closing is what finally lets a blurred main release,
    // and a detached window focusing is what keeps it held.
    const unsubscribeCrossWindowFocus = subscribeCrossWindowFocus(refresh);
    minimizeBridge.probe();
    controller.refresh();

    return () => {
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("blur", handleBlur);
      window.removeEventListener("pagehide", release);
      window.removeEventListener("pageshow", refresh);
      document.removeEventListener("visibilitychange", refresh);
      unsubscribeCrossWindowFocus();
      controller.dispose();
    };
  }, []);

  return held;
}

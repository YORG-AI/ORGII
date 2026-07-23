import { type UnlistenFn, listen } from "@tauri-apps/api/event";
import { useAtomValue } from "jotai";
import { useEffect } from "react";

import {
  EXTERNAL_REPLAY_INVALIDATED_EVENT,
  type ExternalReplayInvalidation,
} from "@src/api/tauri/externalHistory/replay";
import { ExternalReplayInvalidationSchema } from "@src/api/tauri/rpc/schemas/externalReplay";
import { createLogger } from "@src/hooks/logger";
import { externalSessionsEnabledAtom } from "@src/store/session/dataSourceConfigAtom";
import { isWindowFocused } from "@src/util/core/windowFocus";
import { getExternalHistorySourceId } from "@src/util/session/sessionDispatch";

import {
  getActiveExternalReplayLease,
  getExternalReplayWatcherAvailable,
  pollExternalReplaySession,
} from "./externalReplayTransport";
import { getAdapterForSession } from "./types";

const logger = createLogger("ExternalHistoryAutoRefresh");
const REPLAY_WATCHER_SAFETY_INTERVAL_MS = 60_000;
const UNFOCUSED_REFRESH_INTERVAL_MS = 60_000;

type RefreshTimer = ReturnType<typeof setTimeout>;

export interface ExternalHistoryRefreshSchedulerEnvironment {
  isHidden(): boolean;
  isFocused(): boolean;
  setTimer(callback: () => void, delayMs: number): RefreshTimer;
  clearTimer(timer: RefreshTimer): void;
  subscribeFocus(callback: () => void): () => void;
  subscribeBlur(callback: () => void): () => void;
  subscribeVisibility(callback: () => void): () => void;
}

export interface ExternalHistoryRefreshScheduler {
  trigger(): void;
  reschedule(): void;
  stop(): void;
}

const browserRefreshSchedulerEnvironment: ExternalHistoryRefreshSchedulerEnvironment =
  {
    isHidden: () => document.visibilityState === "hidden",
    isFocused: isWindowFocused,
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (timer) => clearTimeout(timer),
    subscribeFocus: (callback) => {
      window.addEventListener("focus", callback);
      return () => window.removeEventListener("focus", callback);
    },
    subscribeBlur: (callback) => {
      window.addEventListener("blur", callback);
      return () => window.removeEventListener("blur", callback);
    },
    subscribeVisibility: (callback) => {
      document.addEventListener("visibilitychange", callback);
      return () => document.removeEventListener("visibilitychange", callback);
    },
  };

/**
 * Own one focus-adaptive, single-flight refresh schedule.
 *
 * Hidden sessions own no timer. Unfocused but visible windows use only the
 * one-minute integrity cadence. The foreground interval may change when a
 * source watcher becomes available, so a previously armed fallback timer
 * upgrades without performing an unnecessary poll.
 */
export function startExternalHistoryRefreshScheduler(options: {
  poll: () => Promise<void>;
  foregroundIntervalMs: number | (() => number);
  onHidden?: () => void;
  environment?: ExternalHistoryRefreshSchedulerEnvironment;
}): ExternalHistoryRefreshScheduler {
  const {
    poll,
    foregroundIntervalMs,
    onHidden,
    environment = browserRefreshSchedulerEnvironment,
  } = options;
  let timer: RefreshTimer | undefined;
  let disposed = false;
  let inFlight = false;
  let rerunAfterFlight = false;
  let visibilityCatchupAlreadyFocused = false;

  const clearScheduledTimer = (): void => {
    if (timer === undefined) return;
    environment.clearTimer(timer);
    timer = undefined;
  };

  const requestedForegroundDelay = (): number =>
    typeof foregroundIntervalMs === "function"
      ? foregroundIntervalMs()
      : foregroundIntervalMs;

  const desiredDelay = (): number =>
    environment.isFocused()
      ? requestedForegroundDelay()
      : UNFOCUSED_REFRESH_INTERVAL_MS;

  const schedule = (): void => {
    clearScheduledTimer();
    if (disposed || inFlight || environment.isHidden()) return;
    const delayMs = desiredDelay();
    timer = environment.setTimer(() => {
      timer = undefined;
      if (desiredDelay() > delayMs) {
        schedule();
        return;
      }
      void run();
    }, delayMs);
  };

  const run = async (): Promise<void> => {
    if (disposed || environment.isHidden()) return;
    if (inFlight) {
      rerunAfterFlight = true;
      return;
    }
    clearScheduledTimer();
    inFlight = true;
    try {
      await poll();
    } finally {
      inFlight = false;
      if (rerunAfterFlight && !disposed && !environment.isHidden()) {
        rerunAfterFlight = false;
        void run();
      } else {
        schedule();
      }
    }
  };

  const trigger = (): void => {
    if (disposed || environment.isHidden()) return;
    void run();
  };
  const handleFocus = (): void => {
    if (visibilityCatchupAlreadyFocused) {
      visibilityCatchupAlreadyFocused = false;
      return;
    }
    trigger();
  };
  const handleBlur = (): void => {
    visibilityCatchupAlreadyFocused = false;
    schedule();
  };
  const handleVisibility = (): void => {
    clearScheduledTimer();
    if (environment.isHidden()) {
      rerunAfterFlight = false;
      visibilityCatchupAlreadyFocused = false;
      onHidden?.();
      return;
    }
    // Browsers commonly emit visibilitychange followed by focus for the same
    // foreground transition. The visibility catch-up already covers it.
    visibilityCatchupAlreadyFocused = environment.isFocused();
    trigger();
  };

  const unsubscribeFocus = environment.subscribeFocus(handleFocus);
  const unsubscribeBlur = environment.subscribeBlur(handleBlur);
  const unsubscribeVisibility =
    environment.subscribeVisibility(handleVisibility);
  schedule();

  return {
    trigger,
    reschedule: schedule,
    stop(): void {
      disposed = true;
      rerunAfterFlight = false;
      visibilityCatchupAlreadyFocused = false;
      clearScheduledTimer();
      unsubscribeFocus();
      unsubscribeBlur();
      unsubscribeVisibility();
    },
  };
}

function isReplayForeground(): boolean {
  return document.visibilityState !== "hidden";
}

/** Poll exactly one bounded delta for the currently visible replay episode. */
export async function refreshBoundedReplaySession(
  sessionId: string,
  signal: AbortSignal
): Promise<boolean> {
  const adapter = getAdapterForSession(sessionId);
  if (adapter?.historyMode !== "bounded-replay") return false;
  const lease = getActiveExternalReplayLease(sessionId);
  if (!lease || signal.aborted) return false;

  const delta = await pollExternalReplaySession(lease, signal);
  if (!delta || signal.aborted || delta.stats.notReady) return false;
  return (
    delta.resetRequired ||
    delta.events.length > 0 ||
    delta.removedEventIds.length > 0
  );
}

export function useExternalHistoryAutoRefresh(options: {
  sessionId: string | null;
  intervalMs: number;
}): void {
  const { sessionId, intervalMs } = options;
  const externalSessionsEnabled = useAtomValue(externalSessionsEnabledAtom);

  useEffect(() => {
    if (!sessionId) return;
    const adapter = getAdapterForSession(sessionId);
    if (adapter?.historyMode !== "bounded-replay") return;
    // The preference controls local vendor-history discovery only. ORGII-owned
    // collaboration snapshots remain replayable even when that discovery is
    // disabled, matching their pre-bounded-replay lifecycle.
    if (getExternalHistorySourceId(sessionId) && !externalSessionsEnabled) {
      return;
    }

    let disposed = false;
    let activeController: AbortController | null = null;
    let unlistenInvalidation: UnlistenFn | null = null;

    const refresh = async (): Promise<void> => {
      if (!isReplayForeground()) return;
      // The transport coordinator is the authoritative single-flight gate.
      // This controller only invalidates this hook episode on hide/unmount.
      const controller = new AbortController();
      activeController = controller;
      try {
        await refreshBoundedReplaySession(sessionId, controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) {
          logger.warn(`Failed to refresh ${sessionId}:`, error);
        }
      } finally {
        if (activeController === controller) activeController = null;
      }
    };
    const scheduler = startExternalHistoryRefreshScheduler({
      poll: refresh,
      foregroundIntervalMs: () => {
        const lease = getActiveExternalReplayLease(sessionId);
        return lease && getExternalReplayWatcherAvailable(lease)
          ? REPLAY_WATCHER_SAFETY_INTERVAL_MS
          : Math.max(intervalMs, 1_000);
      },
      onHidden: () => activeController?.abort(),
    });

    void listen<ExternalReplayInvalidation>(
      EXTERNAL_REPLAY_INVALIDATED_EVENT,
      (event) => {
        const parsed = ExternalReplayInvalidationSchema.safeParse(
          event.payload
        );
        if (!parsed.success || parsed.data.sessionId !== sessionId) return;
        scheduler.trigger();
      }
    )
      .then((unlisten) => {
        if (disposed) {
          unlisten();
        } else {
          unlistenInvalidation = unlisten;
        }
      })
      .catch((error) => {
        if (!disposed) {
          logger.warn("Failed to subscribe to replay invalidation:", error);
        }
      });

    return () => {
      disposed = true;
      scheduler.stop();
      activeController?.abort();
      unlistenInvalidation?.();
    };
  }, [externalSessionsEnabled, intervalMs, sessionId]);
}

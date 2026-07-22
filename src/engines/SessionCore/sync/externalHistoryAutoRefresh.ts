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
import {
  isWindowFocused,
  onWindowFocusRegained,
} from "@src/util/core/windowFocus";
import { getExternalHistorySourceId } from "@src/util/session/sessionDispatch";

import {
  getActiveExternalReplayLease,
  getExternalReplayWatcherAvailable,
  pollExternalReplaySession,
} from "./externalReplayTransport";
import { getAdapterForSession } from "./types";

const logger = createLogger("ExternalHistoryAutoRefresh");
const REPLAY_WATCHER_SAFETY_INTERVAL_MS = 60_000;

function isReplayForeground(): boolean {
  return document.visibilityState !== "hidden" && isWindowFocused();
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
    let timerId: number | null = null;
    let activeController: AbortController | null = null;
    let unlistenInvalidation: UnlistenFn | null = null;

    const clearTimer = (): void => {
      if (timerId === null) return;
      window.clearTimeout(timerId);
      timerId = null;
    };

    const schedule = (): void => {
      clearTimer();
      if (disposed || !isReplayForeground()) return;
      const lease = getActiveExternalReplayLease(sessionId);
      const watcherAvailable = lease
        ? getExternalReplayWatcherAvailable(lease)
        : false;
      const delayMs = watcherAvailable
        ? REPLAY_WATCHER_SAFETY_INTERVAL_MS
        : Math.max(intervalMs, 1_000);
      timerId = window.setTimeout(() => {
        timerId = null;
        const currentLease = getActiveExternalReplayLease(sessionId);
        if (
          !watcherAvailable &&
          currentLease &&
          getExternalReplayWatcherAvailable(currentLease)
        ) {
          // `open_window` completed after the fallback timer was armed and
          // confirmed a real backend watcher. Upgrade without doing the
          // otherwise-due short poll.
          schedule();
          return;
        }
        void refresh();
      }, delayMs);
    };

    const refresh = async (): Promise<void> => {
      if (disposed || !isReplayForeground()) {
        schedule();
        return;
      }
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
        schedule();
      }
    };

    const refreshOnForeground = (): void => {
      if (!isReplayForeground()) {
        clearTimer();
        activeController?.abort();
        return;
      }
      clearTimer();
      void refresh();
    };

    const onVisibilityChange = (): void => refreshOnForeground();
    document.addEventListener("visibilitychange", onVisibilityChange);
    const unsubscribeFocus = onWindowFocusRegained(refreshOnForeground);

    void listen<ExternalReplayInvalidation>(
      EXTERNAL_REPLAY_INVALIDATED_EVENT,
      (event) => {
        const parsed = ExternalReplayInvalidationSchema.safeParse(
          event.payload
        );
        if (!parsed.success || parsed.data.sessionId !== sessionId) return;
        refreshOnForeground();
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

    schedule();
    return () => {
      disposed = true;
      clearTimer();
      activeController?.abort();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      unsubscribeFocus();
      unlistenInvalidation?.();
    };
  }, [externalSessionsEnabled, intervalMs, sessionId]);
}

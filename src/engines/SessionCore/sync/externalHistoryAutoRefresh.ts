import { useAtomValue } from "jotai";
import { useEffect } from "react";

import { getImportedHistorySourceBySessionId } from "@src/api/tauri/externalHistory";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { createLogger } from "@src/hooks/logger";
import { externalSessionsEnabledAtom } from "@src/store/session/dataSourceConfigAtom";
import { isWindowFocused } from "@src/util/core/windowFocus";
import { isImportedHistorySession } from "@src/util/session/sessionDispatch";

import {
  getTranscriptSignature,
  rememberTranscriptSignature,
} from "./externalHistoryTranscriptSignatures";
import { type SessionAdapter, getAdapterForSession } from "./types";

const logger = createLogger("ExternalHistoryAutoRefresh");

// Refresh floor while the window is unfocused; the configured 3s-1m cadence
// only applies to a chat someone is looking at.
const UNFOCUSED_REFRESH_INTERVAL_MS = 60_000;
const MIN_TRANSCRIPT_SETTLE_MS = 2_000;

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
 * Own exactly one focus-adaptive refresh timer.
 *
 * Hidden documents own no timer. An unfocused visible window schedules the
 * next wakeup at the actual one-minute cadence instead of waking at the
 * foreground interval merely to decide not to poll.
 */
export function startExternalHistoryRefreshScheduler(options: {
  poll: () => Promise<void>;
  foregroundIntervalMs: number;
  onHidden?: () => void;
  environment?: ExternalHistoryRefreshSchedulerEnvironment;
}): () => void {
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

  const clearScheduledTimer = () => {
    if (timer === undefined) return;
    environment.clearTimer(timer);
    timer = undefined;
  };

  const schedule = () => {
    clearScheduledTimer();
    if (disposed || inFlight || environment.isHidden()) return;
    const delayMs = environment.isFocused()
      ? foregroundIntervalMs
      : UNFOCUSED_REFRESH_INTERVAL_MS;
    timer = environment.setTimer(() => {
      timer = undefined;
      void run();
    }, delayMs);
  };

  const run = async () => {
    if (disposed || inFlight || environment.isHidden()) return;
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

  const handleFocus = () => {
    if (visibilityCatchupAlreadyFocused) {
      visibilityCatchupAlreadyFocused = false;
      return;
    }
    if (environment.isHidden() || inFlight) return;
    clearScheduledTimer();
    void run();
  };
  const handleBlur = () => {
    visibilityCatchupAlreadyFocused = false;
    schedule();
  };
  const handleVisibility = () => {
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
    if (inFlight) {
      rerunAfterFlight = true;
    } else {
      void run();
    }
  };

  const unsubscribeFocus = environment.subscribeFocus(handleFocus);
  const unsubscribeBlur = environment.subscribeBlur(handleBlur);
  const unsubscribeVisibility =
    environment.subscribeVisibility(handleVisibility);
  schedule();

  return () => {
    disposed = true;
    rerunAfterFlight = false;
    visibilityCatchupAlreadyFocused = false;
    clearScheduledTimer();
    unsubscribeFocus();
    unsubscribeBlur();
    unsubscribeVisibility();
  };
}

export type TranscriptSettleState = {
  signature: string | null;
  firstObservedAt: number;
};

export function shouldWaitForStableTranscript(
  state: TranscriptSettleState,
  signature: string | null,
  nowMs: number,
  settleMs: number
): boolean {
  if (!signature) return false;
  if (state.signature !== signature) {
    state.signature = signature;
    state.firstObservedAt = nowMs;
    return true;
  }
  return nowMs - state.firstObservedAt < settleMs;
}

type DispatchSessionLoad = (payload: {
  sessionId: string;
  events: SessionEvent[];
  replace?: boolean;
}) => void;

interface ObservedSignatureHistoryAdapter extends SessionAdapter {
  loadHistoryFromObservedSignature(
    sessionId: string,
    signal: AbortSignal,
    observedSignature: string
  ): Promise<SessionEvent[]>;
}

function supportsObservedSignatureLoad(
  adapter: SessionAdapter
): adapter is ObservedSignatureHistoryAdapter {
  return (
    "loadHistoryFromObservedSignature" in adapter &&
    typeof adapter.loadHistoryFromObservedSignature === "function"
  );
}

/**
 * Incremental guard: probe the transcript's (mtime, size) and report whether
 * a full reload is needed. Errs on the side of reloading (stat unsupported
 * for the source, file missing, probe failed).
 */
async function transcriptChanged(
  sessionId: string,
  signal: AbortSignal
): Promise<{ changed: boolean; signature: string | null }> {
  const source = getImportedHistorySourceBySessionId(sessionId);
  if (!source?.statTranscript) return { changed: true, signature: null };
  try {
    const stat = await source.statTranscript(sessionId);
    if (signal.aborted || !stat) return { changed: true, signature: null };
    const signature = `${stat.mtimeMs}:${stat.sizeBytes}`;
    return {
      changed: getTranscriptSignature(sessionId) !== signature,
      signature,
    };
  } catch {
    return { changed: true, signature: null };
  }
}

/** Re-read one imported transcript without rescanning every provider cache. */
export async function refreshImportedHistorySession(
  sessionId: string,
  signal: AbortSignal,
  dispatchLoadSession: DispatchSessionLoad,
  observedSignature?: string | null
): Promise<boolean> {
  if (!isImportedHistorySession(sessionId)) return false;
  const adapter = getAdapterForSession(sessionId);
  if (!adapter || adapter.category !== "external_history") return false;

  let signature = observedSignature;
  if (signature === undefined) {
    const probe = await transcriptChanged(sessionId, signal);
    if (!probe.changed || signal.aborted) return false;
    signature = probe.signature;
  } else if (signal.aborted) {
    return false;
  }

  let usedObservedSignature = false;
  let events: SessionEvent[];
  if (signature !== null && supportsObservedSignatureLoad(adapter)) {
    usedObservedSignature = true;
    events = await adapter.loadHistoryFromObservedSignature(
      sessionId,
      signal,
      signature
    );
  } else {
    events = await adapter.loadHistory(sessionId, signal);
  }
  if (signal.aborted || events.length === 0) return false;
  const source = getImportedHistorySourceBySessionId(sessionId);
  dispatchLoadSession({
    sessionId,
    events,
    // A source-level window is a complete bounded snapshot, not an append
    // delta. Replacing prevents yesterday's loaded turn bodies from surviving
    // beside today's placeholders as a live external transcript grows.
    replace: source?.supportsWindowedReplay === true,
  });
  // The signature-aware adapter owns the post-load stat check. Remembering
  // the outer signature again here would hide a transcript mutation that
  // happened while the snapshot was being parsed.
  if (signature && !usedObservedSignature) {
    rememberTranscriptSignature(sessionId, signature);
  }
  return true;
}

export function useExternalHistoryAutoRefresh(options: {
  sessionId: string | null;
  intervalMs: number;
  dispatchLoadSession: DispatchSessionLoad;
}): void {
  const { sessionId, intervalMs, dispatchLoadSession } = options;
  const externalSessionsEnabled = useAtomValue(externalSessionsEnabledAtom);

  useEffect(() => {
    if (!externalSessionsEnabled) return;
    if (!sessionId || !isImportedHistorySession(sessionId)) return;

    let activeController: AbortController | null = null;
    const settleState: TranscriptSettleState = {
      signature: null,
      firstObservedAt: 0,
    };
    const settleMs = Math.max(intervalMs, MIN_TRANSCRIPT_SETTLE_MS);
    const refresh = async () => {
      const controller = new AbortController();
      activeController = controller;
      try {
        // A live Codex/Claude transcript can grow several times per second.
        // Replacing the windowed replay on every observed size change keeps
        // the UI in a loading state and retains large transient allocations.
        // Wait until the same new signature survives one configured refresh
        // period; the initial session load is handled by the switch adapter
        // and is therefore never delayed by this auto-refresh guard.
        const probe = await transcriptChanged(sessionId, controller.signal);
        if (!probe.changed || controller.signal.aborted) {
          settleState.signature = null;
          settleState.firstObservedAt = 0;
          return;
        }
        if (
          shouldWaitForStableTranscript(
            settleState,
            probe.signature,
            Date.now(),
            settleMs
          )
        ) {
          return;
        }
        await refreshImportedHistorySession(
          sessionId,
          controller.signal,
          dispatchLoadSession,
          probe.signature
        );
        settleState.signature = null;
        settleState.firstObservedAt = 0;
      } catch (error) {
        if (!controller.signal.aborted) {
          logger.warn(`Failed to refresh ${sessionId}:`, error);
        }
      } finally {
        if (activeController === controller) activeController = null;
      }
    };

    const stopScheduler = startExternalHistoryRefreshScheduler({
      poll: refresh,
      foregroundIntervalMs: intervalMs,
      onHidden: () => activeController?.abort(),
    });
    return () => {
      stopScheduler();
      activeController?.abort();
    };
  }, [dispatchLoadSession, externalSessionsEnabled, intervalMs, sessionId]);
}

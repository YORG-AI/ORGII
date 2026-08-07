import { useAtomValue } from "jotai";
import { useEffect } from "react";

import { getImportedHistorySourceBySessionId } from "@src/api/tauri/externalHistory";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { createLogger } from "@src/hooks/logger";
import { externalSessionsEnabledAtom } from "@src/store/session/dataSourceConfigAtom";
import {
  isWindowFocused,
  onWindowFocusRegained,
} from "@src/util/core/windowFocus";
import { isImportedHistorySession } from "@src/util/session/sessionDispatch";

import { getAdapterForSession } from "./types";

const logger = createLogger("ExternalHistoryAutoRefresh");

// Refresh floor while the window is unfocused; the configured 3s-1m cadence
// only applies to a chat someone is looking at.
const UNFOCUSED_REFRESH_INTERVAL_MS = 60_000;

type DispatchSessionLoad = (payload: {
  sessionId: string;
  events: SessionEvent[];
}) => void;

// Last observed transcript signature (`mtime:size`) per session. Refresh
// ticks compare a cheap backend `stat` against this and skip the full
// read → parse → merge pipeline while the file is unchanged — which is
// every tick for a finished session. Bounded: replays touch few sessions.
const transcriptSignatures = new Map<string, string>();
const MAX_TRANSCRIPT_SIGNATURES = 64;

function rememberTranscriptSignature(sessionId: string, signature: string) {
  if (
    !transcriptSignatures.has(sessionId) &&
    transcriptSignatures.size >= MAX_TRANSCRIPT_SIGNATURES
  ) {
    transcriptSignatures.clear();
  }
  transcriptSignatures.set(sessionId, signature);
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
      changed: transcriptSignatures.get(sessionId) !== signature,
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
  dispatchLoadSession: DispatchSessionLoad
): Promise<boolean> {
  if (!isImportedHistorySession(sessionId)) return false;
  const adapter = getAdapterForSession(sessionId);
  if (!adapter || adapter.category !== "external_history") return false;

  const { changed, signature } = await transcriptChanged(sessionId, signal);
  if (!changed || signal.aborted) return false;

  const events = await adapter.loadHistory(sessionId, signal);
  if (signal.aborted || events.length === 0) return false;
  dispatchLoadSession({ sessionId, events });
  if (signature) rememberTranscriptSignature(sessionId, signature);
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

    let refreshRunning = false;
    let activeController: AbortController | null = null;
    let lastAttemptAt = 0;
    const refresh = async () => {
      if (refreshRunning) return;
      // The configured cadence (3s-1m) is for a chat the user is actually
      // watching. While the window is unfocused, hold refreshes to one per
      // minute (mirrors the backend git poller's focus-adaptive polling);
      // regaining focus refreshes immediately via the listener below.
      if (
        !isWindowFocused() &&
        Date.now() - lastAttemptAt < UNFOCUSED_REFRESH_INTERVAL_MS
      ) {
        return;
      }
      lastAttemptAt = Date.now();
      refreshRunning = true;
      activeController = new AbortController();
      try {
        await refreshImportedHistorySession(
          sessionId,
          activeController.signal,
          dispatchLoadSession
        );
      } catch (error) {
        if (!activeController.signal.aborted) {
          logger.warn(`Failed to refresh ${sessionId}:`, error);
        }
      } finally {
        refreshRunning = false;
        activeController = null;
      }
    };

    const intervalId = window.setInterval(() => void refresh(), intervalMs);
    const unsubscribeFocus = onWindowFocusRegained(() => void refresh());
    return () => {
      window.clearInterval(intervalId);
      unsubscribeFocus();
      activeController?.abort();
    };
  }, [dispatchLoadSession, externalSessionsEnabled, intervalMs, sessionId]);
}

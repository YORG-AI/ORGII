/**
 * useStreamingHud
 *
 * Derives a lightweight streaming heads-up display for the active session:
 * elapsed wall time, an estimated token throughput (tokens/s), and a rough
 * ETA. The HUD is purely a derived view — it owns no canonical state and is
 * safe to mount/unmount freely.
 *
 * The rate/ETA math lives in `streamingHudMath.ts` (pure, dependency-free)
 * so it can be unit-tested without React or the Jotai atom graph.
 *
 * Lifecycle:
 *   - The timer starts when the session is engine-active, even before the
 *     first text delta arrives. Tool-only phases and CLI providers that do
 *     not emit token-level deltas still need visible progress feedback.
 *   - Token throughput appears only after text deltas arrive.
 *   - It stops the moment the session leaves an engine-active status.
 */
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useState } from "react";

import { useStreamingDeltaForSession } from "@src/engines/SessionCore";
import { isSessionEngineActiveAtom } from "@src/store/session/cliSessionStatusAtom";

import {
  IDLE_HUD_STATE,
  type StreamingHudState,
  computeStreamingHud,
} from "./streamingHudMath";

export type { StreamingHudState } from "./streamingHudMath";

/** Tick cadence for the elapsed/rate readout. */
const HUD_TICK_MS = 500;

/**
 * @param sessionId - Active session. When undefined the HUD stays idle.
 */
export function useStreamingHud(
  sessionId: string | undefined
): StreamingHudState {
  const engineActive = useAtomValue(isSessionEngineActiveAtom);
  const liveDelta = useStreamingDeltaForSession(sessionId);
  const deltaContent = liveDelta?.content ?? "";
  const producing = engineActive && !!sessionId;

  // A single state holding the open timing window: `{ startedAt, now }`.
  // Both are written only from inside the interval effect's callbacks
  // (never synchronously in the effect body), so the timing memo can read
  // them during render while staying pure — no `Date.now()` in render.
  const [timingWindow, setTimingWindow] = useState<{
    startedAt: number;
    now: number;
  } | null>(null);

  useEffect(() => {
    if (!producing) {
      // Close the window asynchronously so the reset is not a synchronous
      // setState inside the effect body.
      const closeTimer = setTimeout(() => setTimingWindow(null), 0);
      return () => clearTimeout(closeTimer);
    }

    // Open the window on the next macrotask, then tick on a cadence.
    const startTimer = setTimeout(() => {
      const startedAt = Date.now();
      setTimingWindow({ startedAt, now: startedAt });
    }, 0);

    const interval = setInterval(() => {
      setTimingWindow((prev) =>
        prev ? { startedAt: prev.startedAt, now: Date.now() } : prev
      );
    }, HUD_TICK_MS);

    return () => {
      clearTimeout(startTimer);
      clearInterval(interval);
    };
  }, [producing]);

  return useMemo<StreamingHudState>(() => {
    if (!producing || timingWindow === null) return IDLE_HUD_STATE;
    return computeStreamingHud(
      deltaContent.length,
      timingWindow.now - timingWindow.startedAt
    );
  }, [producing, timingWindow, deltaContent]);
}

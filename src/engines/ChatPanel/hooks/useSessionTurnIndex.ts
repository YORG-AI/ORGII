/**
 * Loads a session's full turn index for the derived per-session views
 * (Timeline, Changes).
 *
 * `loadTurnIndex` returns the whole index in one round-trip, so both views
 * share a single load rather than paging: the index is metadata only (no event
 * bodies), which is what makes a whole-session view affordable at all.
 *
 * Gated on `enabled` so a session that never leaves the GUI view never pays
 * the read, and re-entering a view it already loaded does not re-read.
 */
import { useEffect, useRef, useState } from "react";

import { loadTurnIndex } from "@src/engines/SessionCore/storage/cacheAdapter";
import type { TurnSummary } from "@src/engines/SessionCore/storage/sqliteCache";

export interface SessionTurnIndexState {
  turns: TurnSummary[];
  loading: boolean;
  error: string | null;
}

interface LoadedIndex {
  sessionId: string;
  turns: TurnSummary[];
  error: string | null;
}

const EMPTY_TURNS: TurnSummary[] = [];

export function useSessionTurnIndex(
  sessionId: string | null,
  enabled: boolean
): SessionTurnIndexState {
  const [result, setResult] = useState<LoadedIndex | null>(null);
  // Guards against a slow load for session A resolving after the host has
  // switched to session B and overwriting B's rows.
  const requestIdRef = useRef(0);

  const settled = result?.sessionId === sessionId;

  useEffect(() => {
    if (!enabled || !sessionId || settled) return;
    const requestId = ++requestIdRef.current;
    loadTurnIndex(sessionId)
      .then((turns) => {
        if (requestId !== requestIdRef.current) return;
        setResult({ sessionId, turns, error: null });
      })
      .catch((loadError: unknown) => {
        if (requestId !== requestIdRef.current) return;
        setResult({
          sessionId,
          turns: EMPTY_TURNS,
          error:
            loadError instanceof Error ? loadError.message : String(loadError),
        });
      });
    return () => {
      requestIdRef.current += 1;
    };
  }, [enabled, settled, sessionId]);

  // Loading is derived, not stored: "asked for it and it hasn't settled yet".
  // Keeping it out of state avoids a synchronous setState in the effect body
  // and the extra render that comes with it.
  return {
    turns: settled ? (result?.turns ?? EMPTY_TURNS) : EMPTY_TURNS,
    loading: Boolean(enabled && sessionId) && !settled,
    error: settled ? (result?.error ?? null) : null,
  };
}

import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";

import {
  type CursorIdeTurnSummary,
  cursorIdeInitialWindow,
} from "@src/api/tauri/externalHistory";
import { loadTurnIndex } from "@src/engines/SessionCore/storage/cacheAdapter";
import type { TurnSummary } from "@src/engines/SessionCore/storage/sqliteCache";
import { createLogger } from "@src/hooks/logger";
import { cursorIdeTurnSummariesAtomFamily } from "@src/store/session/cursorIdeTurnSummariesAtom";
import type { ActivityChunk } from "@src/types/session/session";
import { isCursorIdeSession } from "@src/util/session/sessionDispatch";

const log = createLogger("SessionTurnOverview");

const MAX_TURN_OVERVIEW_CACHE_SIZE = 200;

export interface SessionTurnOverview {
  turnCount: number;
  workedDurationMs: number | null;
}

interface SessionTurnOverviewState {
  sessionId: string;
  overview: SessionTurnOverview | null;
}

interface SharedUnloadedTurnResult {
  unloadedTurn?: {
    durationMs?: unknown;
  };
}

const turnOverviewCache = new Map<string, SessionTurnOverview>();
const inFlightOverviewLoads = new Map<
  string,
  Promise<SessionTurnOverview | null>
>();

export function rememberTurnOverview(
  sessionId: string,
  overview: SessionTurnOverview
): void {
  if (turnOverviewCache.size >= MAX_TURN_OVERVIEW_CACHE_SIZE) {
    const oldestKey = turnOverviewCache.keys().next().value;
    if (oldestKey) turnOverviewCache.delete(oldestKey);
  }
  turnOverviewCache.set(sessionId, overview);
}

function getDurationFromChunk(chunk: ActivityChunk): number {
  const result = chunk.result as SharedUnloadedTurnResult;
  const durationMs = result.unloadedTurn?.durationMs;
  return typeof durationMs === "number" && Number.isFinite(durationMs)
    ? Math.max(0, durationMs)
    : 0;
}

function summarizeCursorIdeTurns(
  turns: CursorIdeTurnSummary[]
): SessionTurnOverview | null {
  if (turns.length === 0) return null;
  const workedDurationMs = turns.reduce((total, turn) => {
    const durationMs = turn.durationMs;
    return typeof durationMs === "number" && Number.isFinite(durationMs)
      ? total + Math.max(0, durationMs)
      : total;
  }, 0);
  return {
    turnCount: turns.length,
    workedDurationMs: workedDurationMs > 0 ? workedDurationMs : null,
  };
}

function summarizeIndexedTurns(turns: TurnSummary[]): SessionTurnOverview {
  const workedDurationMs = turns.reduce((total, turn) => {
    const durationMs = turn.durationMs;
    return typeof durationMs === "number" && Number.isFinite(durationMs)
      ? total + Math.max(0, durationMs)
      : total;
  }, 0);

  return {
    turnCount: turns.length,
    workedDurationMs: workedDurationMs > 0 ? workedDurationMs : null,
  };
}

async function loadSessionTurnOverview(
  sessionId: string,
  cursorIdeTurnSummaries: CursorIdeTurnSummary[]
): Promise<SessionTurnOverview | null> {
  const cachedOverview = turnOverviewCache.get(sessionId);
  if (cachedOverview) return cachedOverview;

  if (isCursorIdeSession(sessionId)) {
    const summaryOverview = summarizeCursorIdeTurns(cursorIdeTurnSummaries);
    if (summaryOverview) return summaryOverview;

    const initialWindow = await cursorIdeInitialWindow({
      sessionId,
      recentLimit: 1,
    });
    const initialSummaryOverview = summarizeCursorIdeTurns(initialWindow.turns);
    if (initialSummaryOverview) return initialSummaryOverview;

    const workedDurationMs = initialWindow.chunks.reduce(
      (total, chunk) => total + getDurationFromChunk(chunk),
      0
    );
    return {
      turnCount: initialWindow.userBubbleCount,
      workedDurationMs: workedDurationMs > 0 ? workedDurationMs : null,
    };
  }

  const turns = await loadTurnIndex(sessionId);
  if (turns.length === 0) return null;
  return summarizeIndexedTurns(turns);
}

function loadSessionTurnOverviewCoalesced(
  sessionId: string,
  cursorIdeTurnSummaries: CursorIdeTurnSummary[]
): Promise<SessionTurnOverview | null> {
  const inFlight = inFlightOverviewLoads.get(sessionId);
  if (inFlight) return inFlight;

  const work = loadSessionTurnOverview(
    sessionId,
    cursorIdeTurnSummaries
  ).finally(() => {
    inFlightOverviewLoads.delete(sessionId);
  });
  inFlightOverviewLoads.set(sessionId, work);
  return work;
}

export function useSessionTurnOverview(
  sessionId: string
): SessionTurnOverview | null {
  const cursorIdeTurnSummaries = useAtomValue(
    cursorIdeTurnSummariesAtomFamily(sessionId)
  );
  const [overviewState, setOverviewState] = useState<SessionTurnOverviewState>(
    () => ({
      sessionId,
      overview: turnOverviewCache.get(sessionId) ?? null,
    })
  );

  useEffect(() => {
    let cancelled = false;

    void loadSessionTurnOverviewCoalesced(sessionId, cursorIdeTurnSummaries)
      .then((nextOverview) => {
        if (cancelled) return;
        if (nextOverview) rememberTurnOverview(sessionId, nextOverview);
        setOverviewState({ sessionId, overview: nextOverview });
      })
      .catch((error: unknown) => {
        // A session with no turn index — never replayed, imported from another
        // CLI, or mid-write — rejects here. Consumers render without a turn
        // count; an unhandled rejection would surface as an app-level error in
        // surfaces that mount many of these at once (channel session cards).
        log.debug("session turn overview load failed:", sessionId, error);
        if (cancelled) return;
        setOverviewState({ sessionId, overview: null });
      });

    return () => {
      cancelled = true;
    };
  }, [cursorIdeTurnSummaries, sessionId]);

  if (overviewState.sessionId === sessionId) return overviewState.overview;
  return turnOverviewCache.get(sessionId) ?? null;
}

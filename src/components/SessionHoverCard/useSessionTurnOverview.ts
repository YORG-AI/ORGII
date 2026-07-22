import { type UnlistenFn, listen } from "@tauri-apps/api/event";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";

import type { CursorIdeTurnSummary } from "@src/api/tauri/externalHistory";
import {
  EXTERNAL_REPLAY_INVALIDATED_EVENT,
  type ExternalReplayInvalidation,
  externalReplayQueryWindowForTarget,
  resolveSecondaryReplayTarget,
} from "@src/api/tauri/externalHistory/replay";
import { ExternalReplayInvalidationSchema } from "@src/api/tauri/rpc/schemas/externalReplay";
import { loadTurnIndex } from "@src/engines/SessionCore/storage/cacheAdapter";
import type { TurnSummary } from "@src/engines/SessionCore/storage/sqliteCache";
import { cursorIdeTurnSummariesAtomFamily } from "@src/store/session/cursorIdeTurnSummariesAtom";
import { isCursorIdeSession } from "@src/util/session/sessionDispatch";

const MAX_TURN_OVERVIEW_CACHE_SIZE = 200;

export interface SessionTurnOverview {
  turnCount: number;
  workedDurationMs: number | null;
}

interface SessionTurnOverviewState {
  sessionId: string;
  overview: SessionTurnOverview | null;
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

function summarizeCursorIdeTurns(
  turns: CursorIdeTurnSummary[]
): SessionTurnOverview | null {
  if (turns.length === 0) return null;
  return {
    turnCount: turns.length,
    // Bounded replay deliberately does not materialize every turn header in
    // the renderer. A partial duration sum would look authoritative but be
    // wrong, so wait for a backend aggregate before displaying it.
    workedDurationMs: null,
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

export async function loadSessionTurnOverview(
  sessionId: string,
  cursorIdeTurnSummaries: CursorIdeTurnSummary[]
): Promise<SessionTurnOverview | null> {
  if (isCursorIdeSession(sessionId)) {
    const summaryOverview = summarizeCursorIdeTurns(cursorIdeTurnSummaries);
    if (summaryOverview) return summaryOverview;
  }

  const replayTarget = await resolveSecondaryReplayTarget(sessionId);
  if (replayTarget) {
    // Hover for every external/managed CLI reads only the compact replay
    // count. Verified collaboration forks use the same secondary replay
    // capability so their inherited prefix never rebuilds/returns the full
    // native turn index just to render a card count.
    const window = await externalReplayQueryWindowForTarget({
      target: replayTarget,
      limits: {
        maxTurns: 1,
        maxEvents: 1,
        maxIpcBytes: 128 * 1024,
      },
    });
    return {
      turnCount: window.totalTurnCount,
      workedDurationMs: null,
    };
  }

  const cachedOverview = turnOverviewCache.get(sessionId);
  if (cachedOverview) return cachedOverview;

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
    if (inFlightOverviewLoads.get(sessionId) === work) {
      inFlightOverviewLoads.delete(sessionId);
    }
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
  const [replayInvalidation, setReplayInvalidation] = useState(0);

  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    void (async () => {
      const replayTarget = await resolveSecondaryReplayTarget(sessionId);
      if (disposed || !replayTarget) return;
      const release = await listen<ExternalReplayInvalidation>(
        EXTERNAL_REPLAY_INVALIDATED_EVENT,
        (event) => {
          const parsed = ExternalReplayInvalidationSchema.safeParse(
            event.payload
          );
          if (!parsed.success || parsed.data.sessionId !== sessionId) return;
          turnOverviewCache.delete(sessionId);
          // Do not let an old compact query coalesce the refresh. Its
          // component effect is cancelled below, and its guarded finally
          // cannot delete the replacement request from the map.
          inFlightOverviewLoads.delete(sessionId);
          setReplayInvalidation((value) => value + 1);
        }
      );
      if (disposed) release();
      else unlisten = release;
    })().catch(() => {
      // Query-on-mount still provides fresh compact data when the desktop
      // event bridge is unavailable (for example in web-only tests).
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [sessionId]);

  useEffect(() => {
    let cancelled = false;

    void loadSessionTurnOverviewCoalesced(
      sessionId,
      cursorIdeTurnSummaries
    ).then((nextOverview) => {
      if (cancelled) return;
      if (nextOverview) rememberTurnOverview(sessionId, nextOverview);
      setOverviewState({ sessionId, overview: nextOverview });
    });

    return () => {
      cancelled = true;
    };
  }, [cursorIdeTurnSummaries, replayInvalidation, sessionId]);

  if (overviewState.sessionId === sessionId) return overviewState.overview;
  return turnOverviewCache.get(sessionId) ?? null;
}

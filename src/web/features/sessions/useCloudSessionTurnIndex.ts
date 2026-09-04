import { useCallback, useEffect, useRef, useState } from "react";

import type { TurnSummary } from "@src/engines/SessionCore/storage/sqliteCache";
import { getSessionTurnIndex } from "@src/features/Org2Cloud/org2CloudSyncClient";

import { useFreshWebCloudSession } from "../auth/useFreshWebCloudSession";
import { projectCloudTurnSummaries } from "./cloudTurnSummaryProjection";
import type { WebSessionListItem } from "./useWebSessionRoster";

interface CloudTurnIndexState {
  sessionKey: string | null;
  turns: TurnSummary[];
  loading: boolean;
  error: string | null;
}

const EMPTY_TURNS: TurnSummary[] = [];

export function useCloudSessionTurnIndex(
  session: WebSessionListItem | null,
  enabled: boolean
) {
  const getFreshSession = useFreshWebCloudSession();
  const [state, setState] = useState<CloudTurnIndexState>({
    sessionKey: null,
    turns: EMPTY_TURNS,
    loading: false,
    error: null,
  });
  const requestIdRef = useRef(0);
  const sessionKey = session ? `${session.orgId}:${session.id}` : null;

  const load = useCallback(async () => {
    if (!enabled || !session || !sessionKey) return;
    const requestId = ++requestIdRef.current;
    setState((current) =>
      current.sessionKey === sessionKey
        ? { ...current, loading: true, error: null }
        : {
            sessionKey,
            turns: EMPTY_TURNS,
            loading: true,
            error: null,
          }
    );
    try {
      const fresh = await getFreshSession();
      if (!fresh || requestId !== requestIdRef.current) return;
      const index = await getSessionTurnIndex(
        fresh.accessToken,
        session.orgId,
        session.sourceSessionId
      );
      if (requestId !== requestIdRef.current) return;
      if (
        index.epoch !== null &&
        session.eventsEpoch !== undefined &&
        index.epoch !== session.eventsEpoch
      ) {
        setState({
          sessionKey,
          turns: EMPTY_TURNS,
          loading: false,
          error: null,
        });
        return;
      }
      const turns = index.turns
        ? projectCloudTurnSummaries(session.sourceSessionId, index.turns)
        : EMPTY_TURNS;
      setState({ sessionKey, turns, loading: false, error: null });
    } catch (error) {
      if (requestId !== requestIdRef.current) return;
      setState({
        sessionKey,
        turns: EMPTY_TURNS,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [enabled, getFreshSession, session, sessionKey]);

  useEffect(() => {
    requestIdRef.current += 1;
    if (!enabled || !sessionKey) {
      return;
    }
    queueMicrotask(() => {
      void load();
    });
    return () => {
      requestIdRef.current += 1;
    };
  }, [enabled, load, sessionKey]);

  if (state.sessionKey !== sessionKey) {
    return {
      turns: EMPTY_TURNS,
      loading: Boolean(enabled && sessionKey),
      error: null,
    };
  }
  return {
    turns: state.turns,
    loading: state.loading,
    error: state.error,
  };
}

import { useCallback, useEffect, useRef, useState } from "react";

import type { SessionEvent } from "@src/engines/SessionCore";
import { mergeCloudSessionEventSnapshot } from "@src/features/Org2Cloud/cloudSessionEventSegmentMerge";
import { buildCloudSessionFetchClient } from "@src/features/Org2Cloud/org2CloudBackendAdapter";
import { startVisibilityAwarePoller } from "@src/shared/scheduling/visibilityAwarePoller";

import { useFreshWebCloudSession } from "../auth/useFreshWebCloudSession";
import type { CloudSessionEventSnapshot } from "./cloudSessionSegments";
import type { WebSessionListItem } from "./useWebSessionRoster";
import {
  buildWebCloudSessionCacheKey,
  shouldFetchWebCloudSessionEvents,
} from "./webCloudSessionCachePolicy";
import {
  readWebCloudSessionEventCache,
  writeWebCloudSessionEventCache,
} from "./webCloudSessionEventCache";
import { cloudSessionEventTarget } from "./webSessionLocation";

/** Poll running sessions lightly while the tab is visible. */
const RUNNING_SESSION_POLL_MS = 30_000;

interface CloudSessionEventsState {
  sessionKey: string | null;
  status: "loading" | "loaded" | "error";
  events: SessionEvent[];
  error: string | null;
}

export function useCloudSessionEvents(session: WebSessionListItem | null) {
  const getFreshSession = useFreshWebCloudSession();
  const [state, setState] = useState<CloudSessionEventsState>({
    sessionKey: null,
    status: "loading",
    events: [],
    error: null,
  });
  const snapshotRef = useRef<CloudSessionEventSnapshot | null>(null);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const generationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const sessionKey = session ? `${session.orgId}:${session.id}` : null;

  const refresh = useCallback(
    (forceFull = false): Promise<void> => {
      if (!session) return Promise.resolve();
      if (inFlightRef.current) return inFlightRef.current;
      const generation = generationRef.current;
      const request = (async () => {
        const fresh = await getFreshSession();
        if (!fresh || generation !== generationRef.current) return;

        const cacheKey = buildWebCloudSessionCacheKey(fresh, session);
        const cachedRecord = await readWebCloudSessionEventCache(cacheKey);
        const cachedSnapshot = cachedRecord?.snapshot ?? null;

        if (
          cachedSnapshot &&
          !shouldFetchWebCloudSessionEvents(forceFull, cachedSnapshot, session)
        ) {
          snapshotRef.current = cachedSnapshot;
          setState({
            sessionKey,
            status: "loaded",
            events: cachedSnapshot.events,
            error: null,
          });
          return;
        }

        const previous = forceFull
          ? null
          : (snapshotRef.current ?? cachedSnapshot);
        const fullRead = forceFull || !previous;
        if (!previous) {
          setState({
            sessionKey,
            status: "loading",
            events: [],
            error: null,
          });
        }
        const controller = new AbortController();
        abortRef.current = controller;
        try {
          const client = buildCloudSessionFetchClient(fresh.accessToken);
          const target = cloudSessionEventTarget(session);
          let incoming = await client.getSessionEventSegments({
            ...target,
            ...(fullRead || previous?.frozenSeq == null
              ? {}
              : { afterSeq: previous.frozenSeq }),
            signal: controller.signal,
          });
          if (
            !fullRead &&
            previous &&
            incoming.epoch !== null &&
            incoming.epoch !== previous.epoch
          ) {
            incoming = await client.getSessionEventSegments({
              ...target,
              signal: controller.signal,
            });
          }
          if (generation !== generationRef.current) return;
          const merged = mergeCloudSessionEventSnapshot(
            previous,
            incoming,
            fullRead || previous?.epoch !== incoming.epoch
          );
          if (previous && merged === previous) {
            return;
          }
          snapshotRef.current = merged;
          setState({
            sessionKey,
            status: "loaded",
            events: merged.events,
            error: null,
          });
          void writeWebCloudSessionEventCache(cacheKey, merged);
        } catch (error) {
          if (controller.signal.aborted || generation !== generationRef.current)
            return;
          if (cachedSnapshot) {
            snapshotRef.current = cachedSnapshot;
            setState({
              sessionKey,
              status: "loaded",
              events: cachedSnapshot.events,
              error: null,
            });
            return;
          }
          setState((previousState) => ({
            ...previousState,
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          }));
        } finally {
          if (abortRef.current === controller) abortRef.current = null;
        }
      })().finally(() => {
        if (inFlightRef.current === request) inFlightRef.current = null;
      });
      inFlightRef.current = request;
      return request;
    },
    [getFreshSession, session, sessionKey]
  );

  useEffect(() => {
    generationRef.current += 1;
    abortRef.current?.abort();
    inFlightRef.current = null;
    snapshotRef.current = null;
    if (!sessionKey || !session) {
      setState({ sessionKey, status: "loading", events: [], error: null });
      return;
    }

    void (async () => {
      const generation = generationRef.current;
      const fresh = await getFreshSession();
      if (!fresh || generation !== generationRef.current) return;

      const cacheKey = buildWebCloudSessionCacheKey(fresh, session);
      const cachedRecord = await readWebCloudSessionEventCache(cacheKey);
      const cachedSnapshot = cachedRecord?.snapshot ?? null;
      if (cachedSnapshot) {
        snapshotRef.current = cachedSnapshot;
        setState({
          sessionKey,
          status: "loaded",
          events: cachedSnapshot.events,
          error: null,
        });
      } else {
        setState({ sessionKey, status: "loading", events: [], error: null });
      }

      if (!shouldFetchWebCloudSessionEvents(false, cachedSnapshot, session)) {
        return;
      }

      await refresh(!cachedSnapshot);
    })();

    return () => {
      generationRef.current += 1;
      abortRef.current?.abort();
    };
  }, [getFreshSession, refresh, session, sessionKey]);

  useEffect(() => {
    if (!session || session.status !== "running") return undefined;
    return startVisibilityAwarePoller(
      document,
      () => refresh(false),
      RUNNING_SESSION_POLL_MS
    );
  }, [refresh, session]);

  const refreshFull = useCallback(() => refresh(true), [refresh]);
  if (state.sessionKey !== sessionKey) {
    return {
      status: "loading" as const,
      events: [],
      error: null,
      refresh: refreshFull,
    };
  }
  return { ...state, refresh: refreshFull };
}

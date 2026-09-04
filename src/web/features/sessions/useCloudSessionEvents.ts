import { useAtomValue } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";

import type { SessionEvent } from "@src/engines/SessionCore";
import { mergeCloudSessionEventSnapshot } from "@src/features/Org2Cloud/cloudSessionEventSegmentMerge";
import {
  org2CloudAuthAtom,
  org2CloudAuthIdentityKey,
} from "@src/features/Org2Cloud/org2CloudAuthAtom";
import { buildCloudSessionFetchClient } from "@src/features/Org2Cloud/org2CloudBackendAdapter";
import type {
  SessionEventSegmentsSnapshot,
  SessionEventSegmentsSummary,
} from "@src/features/TeamCollaboration/sync/CollabSyncBackend";
import { startVisibilityAwarePoller } from "@src/shared/scheduling/visibilityAwarePoller";

import { useFreshWebCloudSession } from "../auth/useFreshWebCloudSession";
import type { CloudSessionEventSnapshot } from "./cloudSessionSegments";
import type { WebSessionListItem } from "./useWebSessionRoster";
import {
  buildWebCloudSessionCacheKey,
  buildWebCloudSessionCacheKeyForIdentity,
  canReadWebCloudSessionEvents,
  shouldFetchWebCloudSessionEvents,
} from "./webCloudSessionCachePolicy";
import {
  deleteWebCloudSessionEventCache,
  readWebCloudSessionEventCache,
  writeWebCloudSessionEventCache,
} from "./webCloudSessionEventCache";
import { cloudSessionEventTarget } from "./webSessionLocation";

/** Poll running sessions lightly while the tab is visible. */
const RUNNING_SESSION_POLL_MS = 30_000;
const PROGRESS_UPDATE_INTERVAL_MS = 150;

export interface CloudSessionLoadProgress {
  loadedEvents: number;
  totalEvents: number | null;
}

interface CloudSessionEventsState {
  sessionKey: string | null;
  status: "loading" | "loaded" | "error";
  events: SessionEvent[];
  error: string | null;
  progress: CloudSessionLoadProgress | null;
}

/** Coalesce segment decode ticks before they cross the React boundary. */
function createProgressReporter(
  write: (progress: CloudSessionLoadProgress) => void
): {
  report: (progress: CloudSessionLoadProgress) => void;
  cancel: () => void;
} {
  let lastWriteAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: CloudSessionLoadProgress | null = null;

  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    pending = null;
  };
  const commit = (progress: CloudSessionLoadProgress) => {
    lastWriteAt = Date.now();
    write(progress);
  };
  const flushPending = () => {
    timer = null;
    if (!pending) return;
    const progress = pending;
    pending = null;
    commit(progress);
  };

  return {
    report(progress) {
      const elapsed = Date.now() - lastWriteAt;
      if (elapsed >= PROGRESS_UPDATE_INTERVAL_MS) {
        cancel();
        commit(progress);
        return;
      }
      pending = progress;
      timer ??= setTimeout(flushPending, PROGRESS_UPDATE_INTERVAL_MS - elapsed);
    },
    cancel,
  };
}

function frozenEventCount(snapshot: CloudSessionEventSnapshot | null): number {
  if (!snapshot) return 0;
  return snapshot.segments.reduce(
    (count, segment) =>
      segment.isTail ? count : count + segment.events.length,
    0
  );
}

export function useCloudSessionEvents(session: WebSessionListItem | null) {
  const auth = useAtomValue(org2CloudAuthAtom);
  const getFreshSession = useFreshWebCloudSession();
  const [state, setState] = useState<CloudSessionEventsState>({
    sessionKey: null,
    status: "loading",
    events: [],
    error: null,
    progress: null,
  });
  const snapshotRef = useRef<CloudSessionEventSnapshot | null>(null);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const generationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const sessionKey = session ? `${session.orgId}:${session.id}` : null;
  const cacheIdentityKey = auth ? org2CloudAuthIdentityKey(auth) : null;
  const canReadEvents = session ? canReadWebCloudSessionEvents(session) : false;

  const refresh = useCallback(
    (
      forceFull = false,
      revealProgress = true,
      bypassCache = false
    ): Promise<void> => {
      if (!session || !canReadEvents) return Promise.resolve();
      if (inFlightRef.current) return inFlightRef.current;
      const generation = generationRef.current;
      const request = (async () => {
        const fresh = await getFreshSession();
        if (!fresh || generation !== generationRef.current) return;

        const cacheKey = buildWebCloudSessionCacheKey(fresh, session);
        const cachedRecord = await readWebCloudSessionEventCache(cacheKey);
        if (generation !== generationRef.current) return;
        const cachedSnapshot = cachedRecord?.snapshot ?? null;
        const displayedSnapshot = snapshotRef.current ?? cachedSnapshot;

        if (
          cachedSnapshot &&
          !bypassCache &&
          !shouldFetchWebCloudSessionEvents(forceFull, cachedSnapshot, session)
        ) {
          snapshotRef.current = cachedSnapshot;
          setState({
            sessionKey,
            status: "loaded",
            events: cachedSnapshot.events,
            error: null,
            progress: null,
          });
          return;
        }

        const previous = forceFull
          ? null
          : (snapshotRef.current ?? cachedSnapshot);
        const fullRead = forceFull || !previous;
        if (displayedSnapshot) {
          snapshotRef.current = displayedSnapshot;
          setState({
            sessionKey,
            status: "loaded",
            events: displayedSnapshot.events,
            error: null,
            progress: revealProgress
              ? {
                  loadedEvents: displayedSnapshot.events.length,
                  totalEvents:
                    session.eventsCount ?? displayedSnapshot.count ?? null,
                }
              : null,
          });
        } else {
          setState({
            sessionKey,
            status: "loading",
            events: [],
            error: null,
            progress: revealProgress
              ? {
                  loadedEvents: 0,
                  totalEvents: session.eventsCount ?? null,
                }
              : null,
          });
        }

        const controller = new AbortController();
        abortRef.current = controller;
        try {
          const target = cloudSessionEventTarget(session);
          const fetchAttempt = async (
            base: CloudSessionEventSnapshot | null,
            attemptFullRead: boolean
          ): Promise<{
            snapshot: CloudSessionEventSnapshot;
            epochChanged: boolean;
          }> => {
            let streamedSnapshot: CloudSessionEventSnapshot | null = null;
            let epochChanged = false;
            const streamedSegments = attemptFullRead
              ? []
              : (base?.segments.filter((segment) => !segment.isTail) ?? []);
            const streamedEvents = streamedSegments.flatMap(
              (segment) => segment.events
            );
            const baseEvents = attemptFullRead ? 0 : frozenEventCount(base);
            const writeProgress = (progress: CloudSessionLoadProgress) => {
              if (
                !revealProgress ||
                controller.signal.aborted ||
                generation !== generationRef.current
              ) {
                return;
              }
              setState((current) =>
                current.sessionKey === sessionKey
                  ? { ...current, progress }
                  : current
              );
            };
            const progressReporter = createProgressReporter(writeProgress);
            const client = buildCloudSessionFetchClient(
              fresh.accessToken,
              undefined,
              {
                onTransferProgress: ({ decodedEvents, totalEvents }) => {
                  const loadedEvents = baseEvents + decodedEvents;
                  progressReporter.report({
                    loadedEvents:
                      totalEvents === null
                        ? loadedEvents
                        : Math.min(loadedEvents, totalEvents),
                    totalEvents,
                  });
                },
              }
            );
            const input = {
              ...target,
              ...(attemptFullRead || base?.frozenSeq == null
                ? {}
                : { afterSeq: base.frozenSeq }),
              signal: controller.signal,
            };
            const applyPage = async (page: SessionEventSegmentsSnapshot) => {
              if (
                controller.signal.aborted ||
                generation !== generationRef.current
              ) {
                return;
              }
              if (!attemptFullRead && base && page.epoch !== base.epoch) {
                if (page.epoch !== null) {
                  epochChanged = true;
                  return;
                }
                streamedSegments.length = 0;
                streamedEvents.length = 0;
              }
              if (epochChanged) return;
              for (const segment of page.segments) {
                streamedSegments.push(segment);
                streamedEvents.push(...segment.events);
              }
              streamedSnapshot = {
                ...page,
                segments: [...streamedSegments],
                events: [...streamedEvents],
              };
              const pageSnapshot = streamedSnapshot;
              const progress = {
                loadedEvents: pageSnapshot.events.length,
                totalEvents: page.count ?? session.eventsCount ?? null,
              };
              progressReporter.cancel();
              // Foreground loads intentionally reveal recoverable partial
              // content. A background revalidation with an existing complete
              // snapshot must remain atomic so a failed tail page cannot make
              // recent messages disappear.
              if (revealProgress || displayedSnapshot === null) {
                snapshotRef.current = pageSnapshot;
                setState({
                  sessionKey,
                  status: "loading",
                  events: pageSnapshot.events,
                  error: null,
                  progress: revealProgress ? progress : null,
                });
              }
            };

            try {
              const stream = client.streamSessionEventSegments;
              let summary: SessionEventSegmentsSummary;
              if (stream) {
                summary = await stream(input, applyPage);
              } else {
                const page = await client.getSessionEventSegments(input);
                await applyPage(page);
                const { segments: _segments, ...pageSummary } = page;
                summary = pageSummary;
              }
              const snapshot =
                streamedSnapshot ??
                mergeCloudSessionEventSnapshot(
                  base,
                  { ...summary, segments: [] },
                  attemptFullRead
                );
              return { snapshot, epochChanged };
            } finally {
              progressReporter.cancel();
            }
          };

          let attempt = await fetchAttempt(previous, fullRead);
          if (attempt.epochChanged) {
            if (revealProgress) {
              setState((current) =>
                current.sessionKey === sessionKey
                  ? {
                      ...current,
                      progress: {
                        loadedEvents: 0,
                        totalEvents: session.eventsCount ?? null,
                      },
                    }
                  : current
              );
            }
            attempt = await fetchAttempt(null, true);
          }
          if (
            controller.signal.aborted ||
            generation !== generationRef.current
          ) {
            return;
          }
          const merged = attempt.snapshot;
          if (previous && merged === previous) {
            setState({
              sessionKey,
              status: "loaded",
              events: previous.events,
              error: null,
              progress: null,
            });
            return;
          }
          snapshotRef.current = merged;
          setState({
            sessionKey,
            status: "loaded",
            events: merged.events,
            error: null,
            progress: null,
          });
          void writeWebCloudSessionEventCache(cacheKey, merged);
        } catch (error) {
          if (controller.signal.aborted || generation !== generationRef.current)
            return;
          const fallback = snapshotRef.current ?? cachedSnapshot;
          if (fallback) snapshotRef.current = fallback;
          setState({
            sessionKey,
            status: "error",
            events: fallback?.events ?? [],
            error: error instanceof Error ? error.message : String(error),
            progress: null,
          });
        } finally {
          if (abortRef.current === controller) abortRef.current = null;
        }
      })().finally(() => {
        if (inFlightRef.current === request) inFlightRef.current = null;
      });
      inFlightRef.current = request;
      return request;
    },
    [canReadEvents, getFreshSession, session, sessionKey]
  );

  useEffect(() => {
    generationRef.current += 1;
    abortRef.current?.abort();
    inFlightRef.current = null;
    snapshotRef.current = null;
    if (!sessionKey || !session) {
      setState({
        sessionKey,
        status: "loading",
        events: [],
        error: null,
        progress: null,
      });
      return;
    }
    if (!canReadEvents) {
      setState({
        sessionKey,
        status: "loaded",
        events: [],
        error: null,
        progress: null,
      });
      if (cacheIdentityKey) {
        void deleteWebCloudSessionEventCache(
          buildWebCloudSessionCacheKeyForIdentity(cacheIdentityKey, session)
        );
      }
      return;
    }
    setState({
      sessionKey,
      status: "loading",
      events: [],
      error: null,
      progress: {
        loadedEvents: 0,
        totalEvents: session.eventsCount ?? null,
      },
    });
    void refresh(false, true);

    return () => {
      generationRef.current += 1;
      abortRef.current?.abort();
    };
  }, [cacheIdentityKey, canReadEvents, refresh, session, sessionKey]);

  useEffect(() => {
    if (!session || !canReadEvents || session.status !== "running") {
      return undefined;
    }
    return startVisibilityAwarePoller(
      document,
      () => refresh(false, false, true),
      RUNNING_SESSION_POLL_MS
    );
  }, [canReadEvents, refresh, session]);

  const refreshFull = useCallback(() => refresh(true, true), [refresh]);
  if (session && !canReadEvents) {
    return {
      status: "loaded" as const,
      events: [],
      error: null,
      progress: null,
      refresh: refreshFull,
    };
  }
  if (state.sessionKey !== sessionKey) {
    return {
      status: "loading" as const,
      events: [],
      error: null,
      progress: session
        ? {
            loadedEvents: 0,
            totalEvents: session.eventsCount ?? null,
          }
        : null,
      refresh: refreshFull,
    };
  }
  return { ...state, refresh: refreshFull };
}

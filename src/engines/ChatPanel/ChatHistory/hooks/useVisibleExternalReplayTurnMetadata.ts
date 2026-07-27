import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ExternalReplayTurnSummary } from "@src/api/tauri/externalHistory";
import { resolveExternalReplayTarget } from "@src/api/tauri/externalHistory/replay";
import { loadTurnIndex } from "@src/engines/SessionCore/storage/cacheAdapter";
import {
  externalReplayPlaceholderId,
  externalReplayTurnIndexFromId,
  getExternalReplayTurnGeneration,
} from "@src/engines/SessionCore/sync/externalReplayTurnState";
import { createLogger } from "@src/hooks/logger";

import type { UseChatTurnPaginationReturn } from "./useChatTurnPagination";

const MAX_VISIBLE_REPLAY_SUMMARIES = 64;
const MAX_METADATA_REQUEST_ATTEMPTS = 3;
const METADATA_RETRY_DELAY_MS = 250;
const log = createLogger("useVisibleExternalReplayTurnMetadata");
const EMPTY_REPLAY_SUMMARIES = new Map<number, ExternalReplayTurnSummary>();

interface VisibleReplaySummaryCache {
  generation: string | null;
  sessionId: string | null;
  values: Map<number, ExternalReplayTurnSummary>;
}

interface ReplayMetadataRequestState {
  attempts: number;
  status: "in-flight" | "retry" | "missing";
  token: number;
}

function trimSummaryCache(
  summaries: Map<number, ExternalReplayTurnSummary>,
  retainedIndices: ReadonlySet<number>
): void {
  for (const turnIndex of summaries.keys()) {
    if (summaries.size <= MAX_VISIBLE_REPLAY_SUMMARIES) return;
    if (!retainedIndices.has(turnIndex)) summaries.delete(turnIndex);
  }
  for (const turnIndex of summaries.keys()) {
    if (summaries.size <= MAX_VISIBLE_REPLAY_SUMMARIES) return;
    summaries.delete(turnIndex);
  }
}

/**
 * Load only the compact metadata rows visible in the virtual turn selector.
 *
 * This is deliberately separate from turn-body loading: opening or scrolling
 * the catalog must never hydrate provider history or add events to EventStore.
 */
export function useVisibleExternalReplayTurnMetadata(options: {
  sessionId: string | null;
  pages: UseChatTurnPaginationReturn["pages"];
  visiblePageIndices: readonly number[];
}): ReadonlyMap<number, ExternalReplayTurnSummary> {
  const { sessionId, pages, visiblePageIndices } = options;
  const replayGeneration = sessionId
    ? getExternalReplayTurnGeneration(sessionId)
    : null;
  const target = sessionId ? resolveExternalReplayTarget(sessionId) : null;
  const canPrefetchCompactMetadata = target !== null;
  const [cache, setCache] = useState<VisibleReplaySummaryCache>({
    generation: null,
    sessionId: null,
    values: new Map(),
  });
  const summaries =
    cache.sessionId === sessionId && cache.generation === replayGeneration
      ? cache.values
      : EMPTY_REPLAY_SUMMARIES;
  const requestStatesRef = useRef(
    new Map<string, ReplayMetadataRequestState>()
  );
  const nextRequestTokenRef = useRef(0);
  const retryTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const [retryRevision, setRetryRevision] = useState(0);
  const visiblePageIndicesKey = useMemo(
    () => [...new Set(visiblePageIndices)].sort((a, b) => a - b).join(","),
    [visiblePageIndices]
  );
  const visibleRequestsKey = useMemo(
    () =>
      visiblePageIndicesKey
        .split(",")
        .filter(Boolean)
        .map(Number)
        .filter(Number.isSafeInteger)
        .flatMap((pageIndex) => {
          const summary = pages[pageIndex]?.replayTurnSummary;
          if (!summary || summary.userPreview.trim().length > 0) return [];
          const turnIndex = Number.isSafeInteger(summary.turnIndex)
            ? summary.turnIndex
            : externalReplayTurnIndexFromId(summary.turnId);
          return turnIndex === null ? [] : [turnIndex];
        })
        .join(","),
    [pages, visiblePageIndicesKey]
  );
  const scheduleRetry = useCallback(() => {
    if (retryTimerRef.current !== null) return;
    retryTimerRef.current = window.setTimeout(() => {
      retryTimerRef.current = null;
      if (mountedRef.current) {
        setRetryRevision((revision) => revision + 1);
      }
    }, METADATA_RETRY_DELAY_MS);
  }, []);

  useEffect(() => {
    const visibleRequests = visibleRequestsKey
      .split(",")
      .filter(Boolean)
      .map(Number)
      .filter(Number.isSafeInteger)
      .map((turnIndex) => ({ turnIndex }));
    if (
      !sessionId ||
      !canPrefetchCompactMetadata ||
      visibleRequests.length === 0
    ) {
      return;
    }
    const generationKey = replayGeneration ?? "generation-pending";
    const retainedIndices = new Set(
      visibleRequests.map(({ turnIndex }) => turnIndex)
    );
    const retainedRequestKeys = new Set(
      visibleRequests.map(
        ({ turnIndex }) => `${sessionId}:${generationKey}:${turnIndex}`
      )
    );
    for (const requestKey of requestStatesRef.current.keys()) {
      if (!retainedRequestKeys.has(requestKey)) {
        requestStatesRef.current.delete(requestKey);
      }
    }
    const requested = visibleRequests.filter(({ turnIndex }) => {
      if (summaries.has(turnIndex)) return false;
      const requestKey = `${sessionId}:${generationKey}:${turnIndex}`;
      const state = requestStatesRef.current.get(requestKey);
      return (
        state?.status !== "in-flight" &&
        state?.status !== "missing" &&
        (state?.attempts ?? 0) < MAX_METADATA_REQUEST_ATTEMPTS
      );
    });
    if (requested.length === 0) return;

    const requestToken = ++nextRequestTokenRef.current;
    for (const { turnIndex } of requested) {
      const requestKey = `${sessionId}:${generationKey}:${turnIndex}`;
      const previous = requestStatesRef.current.get(requestKey);
      requestStatesRef.current.set(requestKey, {
        attempts: (previous?.attempts ?? 0) + 1,
        status: "in-flight",
        token: requestToken,
      });
    }

    let cancelled = false;
    void loadTurnIndex(
      sessionId,
      requested.map(({ turnIndex }) => externalReplayPlaceholderId(turnIndex))
    )
      .then((turns) => {
        if (cancelled) return;
        const returned = new Map<number, ExternalReplayTurnSummary>();
        for (const turn of turns) {
          const turnIndex = externalReplayTurnIndexFromId(turn.turnId);
          if (turnIndex === null) continue;
          returned.set(turnIndex, {
            turnId: turn.turnId,
            renderedUserEventId: null,
            nextTurnId: turn.nextTurnId,
            turnIndex,
            startedAt: turn.startedAt,
            endedAt: turn.endedAt,
            durationMs: turn.durationMs,
            userPreview: turn.userPreview,
            eventCount: turn.eventCount,
            bodyEventCount: turn.bodyEventCount,
          });
        }

        if (returned.size > 0) {
          setCache((current) => {
            const next = new Map(
              current.sessionId === sessionId &&
                current.generation === replayGeneration
                ? current.values
                : []
            );
            for (const [turnIndex, summary] of returned) {
              next.delete(turnIndex);
              next.set(turnIndex, summary);
            }
            trimSummaryCache(next, retainedIndices);
            return {
              generation: replayGeneration,
              sessionId,
              values: next,
            };
          });
        }

        let shouldRetry = false;
        for (const { turnIndex } of requested) {
          const requestKey = `${sessionId}:${generationKey}:${turnIndex}`;
          const state = requestStatesRef.current.get(requestKey);
          if (state?.token !== requestToken) continue;
          if (returned.has(turnIndex)) {
            requestStatesRef.current.delete(requestKey);
            continue;
          }
          const canRetry = state.attempts < MAX_METADATA_REQUEST_ATTEMPTS;
          requestStatesRef.current.set(requestKey, {
            ...state,
            status: canRetry ? "retry" : "missing",
          });
          shouldRetry ||= canRetry;
        }
        if (shouldRetry) scheduleRetry();
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          log.warn("Failed to load visible external replay summaries", {
            sessionId,
            requestedIndices: requested.map(({ turnIndex }) => turnIndex),
            error,
          });
        }
        let shouldRetry = false;
        for (const { turnIndex } of requested) {
          const requestKey = `${sessionId}:${generationKey}:${turnIndex}`;
          const state = requestStatesRef.current.get(requestKey);
          if (state?.token !== requestToken) continue;
          const canRetry = state.attempts < MAX_METADATA_REQUEST_ATTEMPTS;
          requestStatesRef.current.set(requestKey, {
            ...state,
            status: canRetry ? "retry" : "missing",
          });
          shouldRetry ||= canRetry;
        }
        if (shouldRetry) scheduleRetry();
      })
      .finally(() => {
        if (cancelled) {
          // Virtual-list scrolling replaces the visible request set before
          // earlier metadata reads necessarily settle. Cancellation is not a
          // failed lookup: release only this request's tokens and let the
          // stable viewport try them again without consuming the three real
          // missing/error attempts.
          let releasedVisibleRequest = false;
          for (const { turnIndex } of requested) {
            const requestKey = `${sessionId}:${generationKey}:${turnIndex}`;
            const state = requestStatesRef.current.get(requestKey);
            if (state?.token !== requestToken) continue;
            requestStatesRef.current.delete(requestKey);
            releasedVisibleRequest = true;
          }
          if (releasedVisibleRequest) scheduleRetry();
          return;
        }
        // If a completed handler left any token in-flight, release only
        // entries owned by this exact request and drive another render.
        let shouldRetry = false;
        for (const { turnIndex } of requested) {
          const requestKey = `${sessionId}:${generationKey}:${turnIndex}`;
          const state = requestStatesRef.current.get(requestKey);
          if (state?.token !== requestToken || state.status !== "in-flight") {
            continue;
          }
          const canRetry = state.attempts < MAX_METADATA_REQUEST_ATTEMPTS;
          requestStatesRef.current.set(requestKey, {
            ...state,
            status: canRetry ? "retry" : "missing",
          });
          shouldRetry ||= canRetry;
        }
        if (shouldRetry) scheduleRetry();
      });

    return () => {
      cancelled = true;
    };
  }, [
    canPrefetchCompactMetadata,
    replayGeneration,
    retryRevision,
    scheduleRetry,
    sessionId,
    summaries,
    visibleRequestsKey,
  ]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current);
      }
    };
  }, []);

  return summaries;
}

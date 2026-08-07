import { useEffect, useMemo, useRef, useState } from "react";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { createLogger } from "@src/hooks/logger";

import { chatProjectionClient } from "./client";
import {
  type ChatHistoryProjectionOptions,
  type ChatHistoryProjectionResult,
  projectChatHistory,
} from "./core";
import { buildProjectionDelta } from "./delta";

const log = createLogger("useChatProjection");
export const CHAT_PROJECTION_WORKER_THRESHOLD = 2_000;
let nextProjectionConsumerId = 0;

export interface UseChatProjectionOptions {
  sessionId: string | null;
  sourceVersion: number;
  events: SessionEvent[];
  options: ChatHistoryProjectionOptions;
  enabled?: boolean;
}

export interface UseChatProjectionResult extends ChatHistoryProjectionResult {
  pending: boolean;
  execution: "main" | "worker";
  workerMetrics?: {
    queueWaitMs: number;
    computeMs: number;
    inputEvents: number;
  };
}

function markProjectionRevision(
  result: ChatHistoryProjectionResult,
  revision: number
): ChatHistoryProjectionResult {
  return { ...result, projectionRevision: revision };
}

export function useChatProjection({
  sessionId,
  sourceVersion,
  events,
  options,
  enabled = true,
}: UseChatProjectionOptions): UseChatProjectionResult {
  const shouldUseWorker =
    enabled &&
    Boolean(sessionId) &&
    events.length >= CHAT_PROJECTION_WORKER_THRESHOLD &&
    chatProjectionClient.isSupported();
  const synchronous = useMemo(
    () => (shouldUseWorker ? null : projectChatHistory(events, options)),
    [events, options, shouldUseWorker]
  );
  const [workerState, setWorkerState] = useState<{
    sessionId: string;
    sourceVersion: number;
    events: SessionEvent[];
    options: ChatHistoryProjectionOptions;
    projection: ChatHistoryProjectionResult;
    execution: "main" | "worker";
    metrics?: UseChatProjectionResult["workerMetrics"];
  } | null>(null);
  const workerProjection =
    workerState?.sessionId === sessionId &&
    workerState.sourceVersion === sourceVersion &&
    workerState.events === events &&
    workerState.options === options
      ? workerState.projection
      : null;
  const retainedProjection =
    shouldUseWorker && workerState?.sessionId === sessionId
      ? workerState.projection
      : null;
  const workerMetrics =
    workerState?.sessionId === sessionId &&
    workerState.sourceVersion === sourceVersion &&
    workerState.events === events &&
    workerState.options === options
      ? workerState.metrics
      : undefined;
  const requestIdentityRef = useRef(0);
  const consumerIdRef = useRef<number | null>(null);
  if (consumerIdRef.current === null) {
    consumerIdRef.current = ++nextProjectionConsumerId;
  }
  const workerSessionKey = sessionId
    ? `${consumerIdRef.current}:${sessionId}`
    : null;
  const previousWorkerInputRef = useRef<{
    sessionId: string;
    sourceVersion: number;
    events: SessionEvent[];
    options: ChatHistoryProjectionOptions;
  } | null>(null);

  useEffect(() => {
    if (!shouldUseWorker || !sessionId || !workerSessionKey) return;
    const requestIdentity = ++requestIdentityRef.current;
    let disposed = false;
    const previous = previousWorkerInputRef.current;
    const hasNewerSourceVersion =
      previous?.sessionId === workerSessionKey &&
      previous.sourceVersion < sourceVersion;
    const hasSameSourceWithNewOptions =
      previous?.sessionId === workerSessionKey &&
      previous.sourceVersion === sourceVersion &&
      previous.options !== options;
    const request = hasNewerSourceVersion
      ? chatProjectionClient.projectDelta({
          sessionId: workerSessionKey,
          ...buildProjectionDelta(
            previous.events,
            events,
            previous.sourceVersion,
            sourceVersion
          ),
          options,
        })
      : hasSameSourceWithNewOptions
        ? chatProjectionClient.updateOptions(
            workerSessionKey,
            sourceVersion,
            options
          )
        : chatProjectionClient.projectSnapshot({
            sessionId: workerSessionKey,
            sourceVersion,
            events,
            options,
          });
    previousWorkerInputRef.current = {
      sessionId: workerSessionKey,
      sourceVersion,
      events,
      options,
    };
    void request
      .then((response) => {
        if (disposed || requestIdentityRef.current !== requestIdentity) return;
        setWorkerState({
          sessionId,
          sourceVersion,
          events,
          options,
          projection: markProjectionRevision(
            response.result,
            response.projectionRevision
          ),
          execution: "worker",
          metrics: response.metrics,
        });
      })
      .catch((error) => {
        if (disposed || requestIdentityRef.current !== requestIdentity) return;
        log.warn(
          "Projection Worker request failed; shared core remains active",
          error
        );
        const fallback = projectChatHistory(events, options);
        setWorkerState({
          sessionId,
          sourceVersion,
          events,
          options,
          projection: fallback,
          execution: "main",
        });
      });
    return () => {
      disposed = true;
    };
  }, [
    events,
    options,
    sessionId,
    shouldUseWorker,
    sourceVersion,
    workerSessionKey,
  ]);

  useEffect(
    () => () => {
      if (workerSessionKey)
        chatProjectionClient.disposeSession(workerSessionKey);
    },
    [workerSessionKey]
  );

  const active = workerProjection ?? retainedProjection ?? synchronous;
  if (!active) {
    return {
      optimizedChatHistory: [],
      sessionInfo: null,
      groups: undefined,
      projectionRevision: 0,
      groupShapeDigest: "pending",
      itemShapeDigest: "pending",
      pending: true,
      execution: "worker",
      workerMetrics,
    };
  }
  return {
    ...active,
    pending: shouldUseWorker && workerProjection === null,
    execution:
      (workerProjection || retainedProjection) && workerState
        ? workerState.execution
        : "main",
    workerMetrics,
  };
}

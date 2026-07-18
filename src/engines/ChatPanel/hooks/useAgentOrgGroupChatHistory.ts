import { useCallback, useEffect, useRef, useState } from "react";

import {
  type AgentOrgGroupChatHistoryRow,
  type AgentOrgInboxPreviewRow,
  getAgentOrgGroupChatHistoryPage,
} from "@src/api/tauri/agent";

const MAX_HISTORY_GAP_FRONTIERS = 32;

interface AgentOrgGroupChatHistoryState {
  rows: AgentOrgGroupChatHistoryRow[];
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  loadOlder: () => Promise<void>;
  retry: () => void;
}

interface HistoryModel {
  scopeKey: string | null;
  generation: number;
  rows: AgentOrgGroupChatHistoryRow[];
  hasMore: boolean;
  nextBeforeId: number | null;
  initialized: boolean;
  refreshing: boolean;
  loadingOlder: boolean;
  error: string | null;
  errorKind: "refresh" | "older" | null;
  continuationFrontiers: HistoryFrontier[];
  scanThroughLoadedRows: boolean;
}

interface HistoryFrontier {
  hasMore: boolean;
  nextBeforeId: number | null;
}

interface HistoryRequestIdentity {
  scopeKey: string;
  generation: number;
}

function createHistoryModel(
  scopeKey: string | null,
  generation: number
): HistoryModel {
  return {
    scopeKey,
    generation,
    rows: [],
    hasMore: false,
    nextBeforeId: null,
    initialized: false,
    refreshing: false,
    loadingOlder: false,
    error: null,
    errorKind: null,
    continuationFrontiers: [],
    scanThroughLoadedRows: false,
  };
}

function requestMatches(
  model: HistoryModel,
  request: HistoryRequestIdentity
): boolean {
  return (
    model.scopeKey === request.scopeKey &&
    model.generation === request.generation
  );
}

function mergeRows(
  current: ReadonlyArray<AgentOrgGroupChatHistoryRow>,
  incoming: ReadonlyArray<AgentOrgGroupChatHistoryRow>
): AgentOrgGroupChatHistoryRow[] {
  const byId = new Map<number, AgentOrgGroupChatHistoryRow>();
  for (const row of current) byId.set(row.inboxId, row);
  for (const row of incoming) {
    const existing = byId.get(row.inboxId);
    byId.set(
      row.inboxId,
      existing
        ? {
            ...existing,
            ...row,
            readAt: row.readAt ?? existing.readAt,
            deliveryResolution:
              row.deliveryResolution ?? existing.deliveryResolution,
          }
        : row
    );
  }
  return Array.from(byId.values()).sort(
    (left, right) => left.inboxId - right.inboxId
  );
}

function beginRefresh(
  model: HistoryModel,
  request: HistoryRequestIdentity
): HistoryModel {
  if (!requestMatches(model, request)) return model;
  return {
    ...model,
    refreshing: true,
    error: null,
    errorKind: null,
  };
}

function applyRefreshPage(
  model: HistoryModel,
  request: HistoryRequestIdentity,
  page: {
    rows: AgentOrgGroupChatHistoryRow[];
    hasMore: boolean;
    nextBeforeId?: number | null;
  }
): HistoryModel {
  if (!requestMatches(model, request)) return model;
  const existingIds = new Set(model.rows.map((row) => row.inboxId));
  const overlapsLoadedRows = page.rows.some((row) =>
    existingIds.has(row.inboxId)
  );
  const opensNewGap =
    model.initialized &&
    model.rows.length > 0 &&
    page.rows.length > 0 &&
    !overlapsLoadedRows &&
    page.hasMore &&
    page.nextBeforeId != null;
  // A refresh can jump ahead by more than one page while the view is hidden.
  // Follow the new page's cursor first, then resume the frontier that existed
  // before the gap once an older request overlaps already-loaded rows.
  const adoptsPageFrontier =
    !model.initialized || model.rows.length === 0 || opensNewGap;
  const frontierLimitReached =
    opensNewGap &&
    !model.scanThroughLoadedRows &&
    model.continuationFrontiers.length >= MAX_HISTORY_GAP_FRONTIERS;
  // Extremely fragmented histories fall back to walking the server cursor to
  // the end. That may refetch bounded pages, but cannot skip rows or grow this
  // client-side continuation stack without limit.
  const continuationFrontiers = frontierLimitReached
    ? []
    : opensNewGap && !model.scanThroughLoadedRows
      ? [
          ...model.continuationFrontiers,
          {
            hasMore: model.hasMore,
            nextBeforeId: model.nextBeforeId,
          },
        ]
      : model.continuationFrontiers;
  return {
    ...model,
    rows: mergeRows(model.rows, page.rows),
    hasMore: adoptsPageFrontier ? page.hasMore : model.hasMore,
    nextBeforeId: adoptsPageFrontier
      ? (page.nextBeforeId ?? null)
      : model.nextBeforeId,
    initialized: true,
    refreshing: false,
    error: model.errorKind === "refresh" ? null : model.error,
    errorKind: model.errorKind === "refresh" ? null : model.errorKind,
    continuationFrontiers,
    scanThroughLoadedRows: model.scanThroughLoadedRows || frontierLimitReached,
  };
}

function beginLoadOlder(
  model: HistoryModel,
  request: HistoryRequestIdentity
): HistoryModel {
  if (!requestMatches(model, request)) return model;
  return {
    ...model,
    loadingOlder: true,
    error: model.errorKind === "older" ? null : model.error,
    errorKind: model.errorKind === "older" ? null : model.errorKind,
  };
}

function applyOlderPage(
  model: HistoryModel,
  request: HistoryRequestIdentity,
  page: {
    rows: AgentOrgGroupChatHistoryRow[];
    hasMore: boolean;
    nextBeforeId?: number | null;
  }
): HistoryModel {
  if (!requestMatches(model, request)) return model;
  const existingIds = new Set(model.rows.map((row) => row.inboxId));
  const overlapsLoadedRows = page.rows.some((row) =>
    existingIds.has(row.inboxId)
  );
  const continuationFrontiers = [...model.continuationFrontiers];
  const resumedFrontier =
    !model.scanThroughLoadedRows &&
    overlapsLoadedRows &&
    continuationFrontiers.length > 0
      ? continuationFrontiers.pop()
      : undefined;
  return {
    ...model,
    rows: mergeRows(model.rows, page.rows),
    hasMore: resumedFrontier?.hasMore ?? page.hasMore,
    nextBeforeId: resumedFrontier
      ? resumedFrontier.nextBeforeId
      : (page.nextBeforeId ?? null),
    initialized: true,
    loadingOlder: false,
    error: model.errorKind === "older" ? null : model.error,
    errorKind: model.errorKind === "older" ? null : model.errorKind,
    continuationFrontiers,
    scanThroughLoadedRows: model.scanThroughLoadedRows && page.hasMore,
  };
}

function applyRequestFailure(
  model: HistoryModel,
  request: HistoryRequestIdentity,
  error: string,
  requestKind: "refresh" | "older" = "refresh"
): HistoryModel {
  if (!requestMatches(model, request)) return model;
  return {
    ...model,
    refreshing: requestKind === "refresh" ? false : model.refreshing,
    loadingOlder: requestKind === "older" ? false : model.loadingOlder,
    error,
    errorKind: requestKind,
  };
}

export function isGroupChatDeliveryResolved(
  inboxId: number,
  historyRows: ReadonlyArray<AgentOrgGroupChatHistoryRow>
): boolean {
  return historyRows.some(
    (row) => row.inboxId === inboxId && Boolean(row.deliveryResolution)
  );
}

export function isGroupChatPendingDeliverySettled(
  inboxId: number,
  previewRow: AgentOrgInboxPreviewRow | undefined,
  historyRows: ReadonlyArray<AgentOrgGroupChatHistoryRow>
): boolean {
  return Boolean(
    (previewRow?.readAt && previewRow.readAt.trim()) ||
    previewRow?.deliveryResolution ||
    isGroupChatDeliveryResolved(inboxId, historyRows)
  );
}

/**
 * Bounded, explicit Group Chat history reader. The frequently-polled Run View
 * only supplies delivery previews; this hook fetches full user text one page
 * at a time and never walks an unbounded Inbox on mount.
 */
export function useAgentOrgGroupChatHistory(
  sessionId: string,
  enabled: boolean,
  refreshToken: string | number | null
): AgentOrgGroupChatHistoryState {
  const scopeKey = enabled && sessionId ? sessionId : null;
  const [model, setModel] = useState<HistoryModel>(() =>
    createHistoryModel(scopeKey, 0)
  );
  const [retryNonce, setRetryNonce] = useState(0);
  const generationRef = useRef(0);
  const activeScopeRef = useRef<string | null>(scopeKey);
  const latestRefreshSequenceRef = useRef(0);
  const loadOlderInFlightRef = useRef(false);

  useEffect(() => {
    generationRef.current += 1;
    activeScopeRef.current = scopeKey;
    latestRefreshSequenceRef.current = 0;
    loadOlderInFlightRef.current = false;
    setModel(createHistoryModel(scopeKey, generationRef.current));
  }, [scopeKey]);

  useEffect(() => {
    if (!scopeKey) return;
    const request = {
      scopeKey,
      generation: generationRef.current,
    } satisfies HistoryRequestIdentity;
    const refreshSequence = ++latestRefreshSequenceRef.current;
    let cancelled = false;
    setModel((current) => beginRefresh(current, request));
    void getAgentOrgGroupChatHistoryPage({ sessionId, limit: 100 })
      .then((page) => {
        if (
          cancelled ||
          activeScopeRef.current !== request.scopeKey ||
          request.generation !== generationRef.current ||
          refreshSequence !== latestRefreshSequenceRef.current
        ) {
          return;
        }
        setModel((current) => applyRefreshPage(current, request, page));
      })
      .catch((caught: unknown) => {
        if (
          cancelled ||
          activeScopeRef.current !== request.scopeKey ||
          request.generation !== generationRef.current ||
          refreshSequence !== latestRefreshSequenceRef.current
        ) {
          return;
        }
        setModel((current) =>
          applyRequestFailure(
            current,
            request,
            caught instanceof Error ? caught.message : String(caught),
            "refresh"
          )
        );
      });
    return () => {
      cancelled = true;
    };
  }, [refreshToken, retryNonce, scopeKey, sessionId]);

  const visibleModel =
    model.scopeKey === scopeKey
      ? model
      : createHistoryModel(scopeKey, generationRef.current);

  const loadOlder = useCallback(async () => {
    if (
      !scopeKey ||
      loadOlderInFlightRef.current ||
      !visibleModel.hasMore ||
      !visibleModel.nextBeforeId
    ) {
      return;
    }
    const request = {
      scopeKey,
      generation: generationRef.current,
    } satisfies HistoryRequestIdentity;
    const beforeId = visibleModel.nextBeforeId;
    loadOlderInFlightRef.current = true;
    setModel((current) => beginLoadOlder(current, request));
    try {
      const page = await getAgentOrgGroupChatHistoryPage({
        sessionId,
        beforeId,
        limit: 100,
      });
      if (
        activeScopeRef.current !== request.scopeKey ||
        request.generation !== generationRef.current
      ) {
        return;
      }
      setModel((current) => applyOlderPage(current, request, page));
    } catch (caught: unknown) {
      if (
        activeScopeRef.current !== request.scopeKey ||
        request.generation !== generationRef.current
      ) {
        return;
      }
      setModel((current) =>
        applyRequestFailure(
          current,
          request,
          caught instanceof Error ? caught.message : String(caught),
          "older"
        )
      );
    } finally {
      if (
        activeScopeRef.current === request.scopeKey &&
        request.generation === generationRef.current
      ) {
        loadOlderInFlightRef.current = false;
      }
    }
  }, [scopeKey, sessionId, visibleModel.hasMore, visibleModel.nextBeforeId]);

  const retry = useCallback(() => {
    setRetryNonce((current) => current + 1);
  }, []);

  return {
    rows: visibleModel.rows,
    hasMore: visibleModel.hasMore,
    loading: visibleModel.refreshing || visibleModel.loadingOlder,
    error: visibleModel.error,
    loadOlder,
    retry,
  };
}

/** Narrow pure seam for pagination, retry and stale-response regressions. */
export const agentOrgGroupChatHistoryTestApi = {
  createHistoryModel,
  beginRefresh,
  applyRefreshPage,
  beginLoadOlder,
  applyOlderPage,
  applyRequestFailure,
  isGroupChatDeliveryResolved,
  isGroupChatPendingDeliverySettled,
};

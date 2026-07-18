import { useCallback, useEffect, useSyncExternalStore } from "react";

import {
  type AgentOrgPlanApproval,
  type AgentOrgPlanApprovalSummary,
  getAgentOrgPlanApprovalDetail,
} from "@src/api/tauri/agent";

const MAX_CACHED_PLAN_REVISIONS = 32;

interface ApprovalDetailSnapshot {
  detail: AgentOrgPlanApproval | null;
  error: string | null;
  loading: boolean;
}

interface ApprovalDetailEntry {
  key: string;
  snapshot: ApprovalDetailSnapshot;
  listeners: Set<() => void>;
  inFlight: Promise<void> | null;
  touchedAt: number;
}

const EMPTY_SNAPSHOT: ApprovalDetailSnapshot = {
  detail: null,
  error: null,
  loading: true,
};
const detailCache = new Map<string, ApprovalDetailEntry>();

function approvalRevisionKey(
  approval: Pick<AgentOrgPlanApprovalSummary, "approvalId" | "planRevisionId">
): string {
  return `${approval.approvalId}:${approval.planRevisionId}`;
}

function trimDetailCache(): void {
  if (detailCache.size <= MAX_CACHED_PLAN_REVISIONS) return;
  const removable = Array.from(detailCache.values())
    .filter((entry) => entry.listeners.size === 0 && !entry.inFlight)
    .sort((left, right) => left.touchedAt - right.touchedAt);
  while (detailCache.size > MAX_CACHED_PLAN_REVISIONS && removable.length > 0) {
    const entry = removable.shift();
    if (entry) detailCache.delete(entry.key);
  }
}

function getOrCreateEntry(key: string): ApprovalDetailEntry {
  const existing = detailCache.get(key);
  if (existing) {
    existing.touchedAt = Date.now();
    return existing;
  }
  const entry: ApprovalDetailEntry = {
    key,
    snapshot: EMPTY_SNAPSHOT,
    listeners: new Set(),
    inFlight: null,
    touchedAt: Date.now(),
  };
  detailCache.set(key, entry);
  trimDetailCache();
  return entry;
}

function publish(
  entry: ApprovalDetailEntry,
  snapshot: ApprovalDetailSnapshot
): void {
  entry.snapshot = snapshot;
  entry.touchedAt = Date.now();
  for (const listener of entry.listeners) listener();
}

async function loadDetail(
  entry: ApprovalDetailEntry,
  sessionId: string,
  approval: AgentOrgPlanApprovalSummary,
  force = false
): Promise<void> {
  if (!force && entry.snapshot.detail) return;
  if (entry.inFlight) return entry.inFlight;

  publish(entry, {
    detail: force ? null : entry.snapshot.detail,
    error: null,
    loading: true,
  });
  const request = (async () => {
    try {
      const detail = await getAgentOrgPlanApprovalDetail({
        sessionId,
        approvalId: approval.approvalId,
        planRevisionId: approval.planRevisionId,
      });
      publish(entry, { detail, error: null, loading: false });
    } catch (error: unknown) {
      publish(entry, {
        detail: null,
        error: error instanceof Error ? error.message : String(error),
        loading: false,
      });
    } finally {
      entry.inFlight = null;
    }
  })();
  entry.inFlight = request;
  return request;
}

export function useAgentOrgPlanApprovalDetail(
  sessionId: string,
  approval: AgentOrgPlanApprovalSummary
) {
  const key = approvalRevisionKey(approval);
  const subscribe = useCallback(
    (listener: () => void) => {
      const entry = getOrCreateEntry(key);
      entry.listeners.add(listener);
      return () => {
        entry.listeners.delete(listener);
      };
    },
    [key]
  );
  const getSnapshot = useCallback(() => getOrCreateEntry(key).snapshot, [key]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    void loadDetail(getOrCreateEntry(key), sessionId, approval);
  }, [approval, key, sessionId]);

  const retry = useCallback(async () => {
    await loadDetail(getOrCreateEntry(key), sessionId, approval, true);
  }, [approval, key, sessionId]);

  return { ...snapshot, retry };
}

/** Narrow test seam for the immutable-revision detail cache. */
export const agentOrgPlanApprovalDetailCacheTestApi = {
  load(
    sessionId: string,
    approval: AgentOrgPlanApprovalSummary,
    force = false
  ): Promise<void> {
    return loadDetail(
      getOrCreateEntry(approvalRevisionKey(approval)),
      sessionId,
      approval,
      force
    );
  },
  getSnapshot(approval: AgentOrgPlanApprovalSummary): ApprovalDetailSnapshot {
    return getOrCreateEntry(approvalRevisionKey(approval)).snapshot;
  },
  reset(): void {
    for (const entry of detailCache.values()) entry.listeners.clear();
    detailCache.clear();
  },
};

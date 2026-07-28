import { useCallback, useEffect, useSyncExternalStore } from "react";

import {
  type AgentOrgPlanApproval,
  type AgentOrgPlanApprovalSummary,
  getAgentOrgPlanApprovalDetail,
} from "@src/api/tauri/agent";

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
  bytes: number;
}

const EMPTY_SNAPSHOT: ApprovalDetailSnapshot = {
  detail: null,
  error: null,
  loading: true,
};
const MAX_DETAIL_CACHE_ENTRIES = 64;
const MAX_DETAIL_CACHE_BYTES = 8 * 1024 * 1024;
const detailCache = new Map<string, ApprovalDetailEntry>();
let detailCacheBytes = 0;

function estimateSnapshotBytes(snapshot: ApprovalDetailSnapshot): number {
  try {
    return JSON.stringify(snapshot).length * 2;
  } catch {
    return MAX_DETAIL_CACHE_BYTES;
  }
}

function touchEntry(entry: ApprovalDetailEntry): void {
  detailCache.delete(entry.key);
  detailCache.set(entry.key, entry);
}

function deleteEntry(entry: ApprovalDetailEntry): void {
  if (!detailCache.delete(entry.key)) return;
  detailCacheBytes = Math.max(0, detailCacheBytes - entry.bytes);
  entry.listeners.clear();
}

function pruneDetailCache(protectedKey?: string): void {
  while (
    detailCache.size > MAX_DETAIL_CACHE_ENTRIES ||
    detailCacheBytes > MAX_DETAIL_CACHE_BYTES
  ) {
    const candidate = [...detailCache.values()].find(
      (entry) =>
        entry.key !== protectedKey &&
        entry.listeners.size === 0 &&
        entry.inFlight === null
    );
    if (!candidate) return;
    deleteEntry(candidate);
  }
}

function approvalRevisionKey(
  approval: Pick<AgentOrgPlanApprovalSummary, "approvalId" | "planRevisionId">
): string {
  return `${approval.approvalId}:${approval.planRevisionId}`;
}

function getOrCreateEntry(key: string): ApprovalDetailEntry {
  const existing = detailCache.get(key);
  if (existing) {
    touchEntry(existing);
    return existing;
  }
  const entry: ApprovalDetailEntry = {
    key,
    snapshot: EMPTY_SNAPSHOT,
    listeners: new Set(),
    inFlight: null,
    bytes: estimateSnapshotBytes(EMPTY_SNAPSHOT),
  };
  detailCache.set(key, entry);
  detailCacheBytes += entry.bytes;
  pruneDetailCache(key);
  return entry;
}

function publish(
  entry: ApprovalDetailEntry,
  snapshot: ApprovalDetailSnapshot
): void {
  detailCacheBytes -= entry.bytes;
  entry.snapshot = snapshot;
  entry.bytes = estimateSnapshotBytes(snapshot);
  detailCacheBytes += entry.bytes;
  touchEntry(entry);
  for (const listener of entry.listeners) listener();
  pruneDetailCache(entry.key);
}

async function loadDetail(
  entry: ApprovalDetailEntry,
  sessionId: string,
  approval: Pick<AgentOrgPlanApprovalSummary, "approvalId" | "planRevisionId">,
  force = false
): Promise<void> {
  if (!force && (entry.snapshot.detail || entry.snapshot.error)) return;
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
  const { approvalId, planRevisionId } = approval;
  const key = approvalRevisionKey({ approvalId, planRevisionId });
  const subscribe = useCallback(
    (listener: () => void) => {
      const entry = getOrCreateEntry(key);
      entry.listeners.add(listener);
      return () => {
        entry.listeners.delete(listener);
        pruneDetailCache();
      };
    },
    [key]
  );
  const getSnapshot = useCallback(() => getOrCreateEntry(key).snapshot, [key]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    void loadDetail(getOrCreateEntry(key), sessionId, {
      approvalId,
      planRevisionId,
    });
  }, [approvalId, key, planRevisionId, sessionId]);

  const retry = useCallback(async () => {
    await loadDetail(
      getOrCreateEntry(key),
      sessionId,
      { approvalId, planRevisionId },
      true
    );
  }, [approvalId, key, planRevisionId, sessionId]);

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
    detailCacheBytes = 0;
  },
  stats(): { entries: number; bytes: number } {
    return { entries: detailCache.size, bytes: detailCacheBytes };
  },
  limits: {
    entries: MAX_DETAIL_CACHE_ENTRIES,
    bytes: MAX_DETAIL_CACHE_BYTES,
  },
};

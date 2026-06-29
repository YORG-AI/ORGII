import { invokeTauri } from "@src/util/platform/tauri/init";

export interface ContextSnapshotWire {
  snapshotId: string;
  targetSessionId: string;
  sourceKind: string;
  sourceId: string;
  namespace: string;
  title?: string | null;
  tokenEstimate: number;
  pinned: boolean;
  createdAt: string;
}

export interface CacheLayoutStatsWire {
  stablePrefixTokens: number;
  volatileContextTokens: number;
  importedContextCount: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  providerCacheHitRate?: number | null;
}

export interface SessionEmbeddingStateWire {
  namespace: string;
  sessionId: string;
  workItemId?: string | null;
  lastEmbeddedSequence: number;
  embeddingModel?: string | null;
  updatedAt: string;
}

export interface ContextCacheSnapshotResult {
  sessionId: string;
  snapshots: ContextSnapshotWire[];
  latestCacheLayout?: CacheLayoutStatsWire | null;
  embeddingState?: SessionEmbeddingStateWire | null;
}

export async function contextCacheSnapshot(
  sessionId: string
): Promise<ContextCacheSnapshotResult> {
  return invokeTauri<ContextCacheSnapshotResult>(
    "debug_session_context_cache_snapshot",
    { sessionId }
  );
}

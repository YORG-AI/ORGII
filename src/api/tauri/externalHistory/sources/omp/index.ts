import { invoke } from "@tauri-apps/api/core";

import type { ActivityChunk } from "@src/types/session/session";

export interface OmpRecentPath {
  path: string;
  name?: string | null;
  lastUsedAt: string;
  sessionCount: number;
}

export async function ompRecentPaths(args?: {
  limit?: number;
}): Promise<OmpRecentPath[]> {
  return invoke<OmpRecentPath[]>("omp_recent_paths", {
    limit: args?.limit,
  });
}

export async function ompHistoryChunks(
  sessionId: string
): Promise<ActivityChunk[]> {
  return invoke<ActivityChunk[]>("omp_history_chunks", { sessionId });
}

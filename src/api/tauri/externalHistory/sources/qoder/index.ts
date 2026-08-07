import { invoke } from "@tauri-apps/api/core";

import type { ActivityChunk } from "@src/types/session/session";

export interface QoderRecentPath {
  path: string;
  name?: string;
  lastUsedAt: string;
  sessionCount: number;
}

export async function qoderRecentPaths(args?: {
  limit?: number;
}): Promise<QoderRecentPath[]> {
  return invoke<QoderRecentPath[]>("qoder_recent_paths", {
    limit: args?.limit,
  });
}

export async function qoderHistoryChunks(
  sessionId: string
): Promise<ActivityChunk[]> {
  return invoke<ActivityChunk[]>("qoder_history_chunks", { sessionId });
}

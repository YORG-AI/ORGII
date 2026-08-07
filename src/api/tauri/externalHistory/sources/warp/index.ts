import { invoke } from "@tauri-apps/api/core";

import type { ActivityChunk } from "@src/types/session/session";

export interface WarpRecentPath {
  path: string;
  name?: string;
  lastUsedAt: string;
  sessionCount: number;
}

export async function warpRecentPaths(args?: {
  limit?: number;
}): Promise<WarpRecentPath[]> {
  return invoke<WarpRecentPath[]>("warp_recent_paths", {
    limit: args?.limit,
  });
}

export async function warpHistoryChunks(
  sessionId: string
): Promise<ActivityChunk[]> {
  return invoke<ActivityChunk[]>("warp_history_chunks", { sessionId });
}

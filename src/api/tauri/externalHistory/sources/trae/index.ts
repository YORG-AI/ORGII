import { invoke } from "@tauri-apps/api/core";

import type { ActivityChunk } from "@src/types/session/session";

export interface TraeRecentPath {
  path: string;
  name?: string;
  lastUsedAt: string;
  sessionCount: number;
}

export async function traeRecentPaths(args?: {
  limit?: number;
}): Promise<TraeRecentPath[]> {
  return invoke<TraeRecentPath[]>("trae_recent_paths", {
    limit: args?.limit,
  });
}

export async function traeHistoryChunks(
  sessionId: string
): Promise<ActivityChunk[]> {
  return invoke<ActivityChunk[]>("trae_history_chunks", { sessionId });
}

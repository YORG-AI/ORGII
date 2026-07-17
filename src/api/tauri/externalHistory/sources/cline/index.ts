import { invoke } from "@tauri-apps/api/core";

import type { ActivityChunk } from "@src/types/session/session";

export interface ClineRecentPath {
  path: string;
  name?: string;
  lastUsedAt: string;
  sessionCount: number;
}

export async function clineRecentPaths(args?: {
  limit?: number;
}): Promise<ClineRecentPath[]> {
  return invoke<ClineRecentPath[]>("cline_recent_paths", {
    limit: args?.limit,
  });
}

export async function clineHistoryChunks(
  sessionId: string
): Promise<ActivityChunk[]> {
  return invoke<ActivityChunk[]>("cline_history_chunks", { sessionId });
}

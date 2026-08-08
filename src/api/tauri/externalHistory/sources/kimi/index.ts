import { invoke } from "@tauri-apps/api/core";

import type { ActivityChunk } from "@src/types/session/session";

export interface KimiRecentPath {
  path: string;
  name?: string | null;
  lastUsedAt: string;
  sessionCount: number;
}

export async function kimiRecentPaths(args?: {
  limit?: number;
}): Promise<KimiRecentPath[]> {
  return invoke<KimiRecentPath[]>("kimi_recent_paths", {
    limit: args?.limit,
  });
}

export async function kimiHistoryChunks(
  sessionId: string
): Promise<ActivityChunk[]> {
  return invoke<ActivityChunk[]>("kimi_history_chunks", { sessionId });
}

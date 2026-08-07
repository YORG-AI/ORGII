import { invoke } from "@tauri-apps/api/core";

import type { ActivityChunk } from "@src/types/session/session";

export interface ZCodeRecentPath {
  path: string;
  name?: string;
  lastUsedAt: string;
  sessionCount: number;
}

export async function zcodeRecentPaths(args?: {
  limit?: number;
}): Promise<ZCodeRecentPath[]> {
  return invoke<ZCodeRecentPath[]>("zcode_recent_paths", {
    limit: args?.limit,
  });
}

export async function zcodeHistoryChunks(
  sessionId: string
): Promise<ActivityChunk[]> {
  return invoke<ActivityChunk[]>("zcode_history_chunks", { sessionId });
}

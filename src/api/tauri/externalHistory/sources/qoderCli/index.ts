import { invoke } from "@tauri-apps/api/core";

import type { ActivityChunk } from "@src/types/session/session";

export interface QoderCliRecentPath {
  path: string;
  name?: string | null;
  lastUsedAt: string;
  sessionCount: number;
}

export async function qoderCliRecentPaths(args?: {
  limit?: number;
}): Promise<QoderCliRecentPath[]> {
  return invoke<QoderCliRecentPath[]>("qoder_cli_recent_paths", {
    limit: args?.limit,
  });
}

export async function qoderCliHistoryChunks(
  sessionId: string
): Promise<ActivityChunk[]> {
  return invoke<ActivityChunk[]>("qoder_cli_history_chunks", { sessionId });
}

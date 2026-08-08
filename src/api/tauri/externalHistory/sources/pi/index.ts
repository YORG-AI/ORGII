import { invoke } from "@tauri-apps/api/core";

import type { ActivityChunk } from "@src/types/session/session";

export interface PiRecentPath {
  path: string;
  name?: string | null;
  lastUsedAt: string;
  sessionCount: number;
}

export async function piRecentPaths(args?: {
  limit?: number;
}): Promise<PiRecentPath[]> {
  return invoke<PiRecentPath[]>("pi_recent_paths", {
    limit: args?.limit,
  });
}

export async function piHistoryChunks(
  sessionId: string
): Promise<ActivityChunk[]> {
  return invoke<ActivityChunk[]>("pi_history_chunks", { sessionId });
}

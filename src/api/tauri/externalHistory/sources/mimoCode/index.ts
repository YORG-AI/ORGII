import { invoke } from "@tauri-apps/api/core";

import type { ActivityChunk } from "@src/types/session/session";

export interface MimoCodeRecentPath {
  path: string;
  name?: string | null;
  lastUsedAt: string;
  sessionCount: number;
}

export async function mimoCodeRecentPaths(args?: {
  limit?: number;
}): Promise<MimoCodeRecentPath[]> {
  return invoke<MimoCodeRecentPath[]>("mimo_code_recent_paths", {
    limit: args?.limit,
  });
}

export async function mimoCodeHistoryChunks(
  sessionId: string
): Promise<ActivityChunk[]> {
  return invoke<ActivityChunk[]>("mimo_code_history_chunks", { sessionId });
}

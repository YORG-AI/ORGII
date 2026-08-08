import { invoke } from "@tauri-apps/api/core";

import type { ActivityChunk } from "@src/types/session/session";

export interface QwenCodeRecentPath {
  path: string;
  name?: string | null;
  lastUsedAt: string;
  sessionCount: number;
}

export async function qwenCodeRecentPaths(args?: {
  limit?: number;
}): Promise<QwenCodeRecentPath[]> {
  return invoke<QwenCodeRecentPath[]>("qwen_code_recent_paths", {
    limit: args?.limit,
  });
}

export async function qwenCodeHistoryChunks(
  sessionId: string
): Promise<ActivityChunk[]> {
  return invoke<ActivityChunk[]>("qwen_code_history_chunks", { sessionId });
}

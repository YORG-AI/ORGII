import { invoke } from "@tauri-apps/api/core";

import type { ActivityChunk } from "@src/types/session/session";

export interface CursorCliRecentPath {
  path: string;
  name?: string;
  lastUsedAt: string;
  sessionCount: number;
}

export async function cursorCliRecentPaths(args?: {
  limit?: number;
}): Promise<CursorCliRecentPath[]> {
  return invoke<CursorCliRecentPath[]>("cursor_cli_recent_paths", {
    limit: args?.limit,
  });
}

export async function cursorCliHistoryChunks(
  sessionId: string
): Promise<ActivityChunk[]> {
  return invoke<ActivityChunk[]>("cursor_cli_history_chunks", { sessionId });
}

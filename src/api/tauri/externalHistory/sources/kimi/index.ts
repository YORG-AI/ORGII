import { invoke } from "@tauri-apps/api/core";

import type { ActivityChunk } from "@src/types/session/session";

export async function kimiHistoryChunks(
  sessionId: string
): Promise<ActivityChunk[]> {
  return invoke<ActivityChunk[]>("kimi_history_chunks", { sessionId });
}

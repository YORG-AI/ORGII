import { invoke } from "@tauri-apps/api/core";

import type { ActivityChunk } from "@src/types/session/session";

export async function workBuddyHistoryChunks(
  sessionId: string
): Promise<ActivityChunk[]> {
  return invoke<ActivityChunk[]>("workbuddy_history_chunks", { sessionId });
}

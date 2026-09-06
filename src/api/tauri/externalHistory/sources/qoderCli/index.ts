import { invoke } from "@tauri-apps/api/core";

import type { ActivityChunk } from "@src/types/session/session";

export async function qoderCliHistoryChunks(
  sessionId: string
): Promise<ActivityChunk[]> {
  return invoke<ActivityChunk[]>("qoder_cli_history_chunks", { sessionId });
}

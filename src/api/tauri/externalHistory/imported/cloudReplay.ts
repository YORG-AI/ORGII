import { invoke } from "@tauri-apps/api/core";

import type { ActivityChunk } from "@src/types/session/session";

export interface ImportedHistoryCloudTurnWindow {
  turnId: string;
  chunks: ActivityChunk[];
}

export async function importedHistoryCloudTurnIds(
  sessionId: string
): Promise<string[]> {
  return invoke<string[]>("imported_history_cloud_turn_ids", { sessionId });
}

export async function importedHistoryCloudTurnWindows(args: {
  sessionId: string;
  turnIds: string[];
  startSequence: number;
}): Promise<ImportedHistoryCloudTurnWindow[]> {
  return invoke<ImportedHistoryCloudTurnWindow[]>(
    "imported_history_cloud_turn_windows",
    args
  );
}

export interface ImportedContinuationStatus {
  sessionId: string;
  /** Elected continuation-family id; absent on pre-lineage cache rows. */
  lineageId?: string;
  /** True when a strictly newer continuation sibling exists in the cache. */
  superseded: boolean;
}

/**
 * Continuation-family status for push-marked session ids. Ids not present
 * in the imported cache are omitted — absence is "unknown" (a rebuilding
 * cache reads empty), never "superseded".
 */
export async function importedHistoryContinuationStatuses(
  sessionIds: string[]
): Promise<ImportedContinuationStatus[]> {
  return invoke<ImportedContinuationStatus[]>(
    "imported_history_continuation_statuses",
    { sessionIds }
  );
}

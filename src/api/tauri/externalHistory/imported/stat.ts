import { invoke } from "@tauri-apps/api/core";

import type { ImportedTranscriptStat } from "../sources/claudeCode";

/**
 * Source-agnostic transcript freshness probe. Resolves the session's source
 * file from the backend imported-history cache and stats it (including the
 * SQLite `-wal` sibling for WAL-mode stores). `null` when the session is
 * uncached or the file is missing — the auto-refresh then falls back to a
 * full reload, which re-syncs the cache.
 */
export async function importedHistoryStat(
  sourceId: string,
  sessionId: string
): Promise<ImportedTranscriptStat | null> {
  return invoke<ImportedTranscriptStat | null>("imported_history_stat", {
    sourceId,
    sessionId,
  });
}

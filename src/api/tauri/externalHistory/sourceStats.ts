import { invoke } from "@tauri-apps/api/core";

import type { ImportedHistorySourceId } from "./imported/descriptors";

export interface ExternalSourceStats {
  /** Top-level sessions ORGII has imported/cached for the source. */
  sessionCount: number;
  /** Cached child/sub-agent sessions, shown separately in Runtime. */
  subagentCount: number;
  /** ISO timestamp of the most recently used cached session. */
  lastUsedAt: string | null;
}

interface ExternalSourceStatsWire extends ExternalSourceStats {
  sourceId: ImportedHistorySourceId;
}

/**
 * Read all requested inventory counters from ORGII's incremental cache in one
 * IPC. No provider database or transcript is opened by this operation.
 */
export async function fetchExternalSourceStatsBatch(
  sources: readonly ImportedHistorySourceId[]
): Promise<Map<ImportedHistorySourceId, ExternalSourceStats>> {
  if (sources.length === 0) return new Map();
  const rows = await invoke<ExternalSourceStatsWire[]>(
    "external_history_source_stats",
    { sources }
  );
  return new Map(
    rows.map(({ sourceId, ...stats }) => [sourceId, stats] as const)
  );
}

/** Single-source convenience for refreshes after one incremental rescan. */
export async function fetchExternalSourceStats(
  source: ImportedHistorySourceId
): Promise<ExternalSourceStats> {
  return (
    (await fetchExternalSourceStatsBatch([source])).get(source) ?? {
      sessionCount: 0,
      subagentCount: 0,
      lastUsedAt: null,
    }
  );
}

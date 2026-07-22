import { invoke } from "@tauri-apps/api/core";

import {
  type ImportedHistorySourceId,
  importedHistoryRecentPaths,
} from "./imported";

export interface ExternalSourceStats {
  /** Top-level sessions ORGII has imported/cached for the source. */
  sessionCount: number;
  /**
   * Hidden sub-agent sessions cached for the source — Cursor's sub-agent
   * composers, folded under a parent in the UI. 0 for every other source today.
   */
  subagentCount: number;
  /** ISO timestamp of the most recently used session, or null if none. */
  lastUsedAt: string | null;
}

/** The session-count half of the stats, before the sub-agent count is merged. */
type SourceCounts = Pick<ExternalSourceStats, "sessionCount" | "lastUsedAt">;

interface RecentPathLike {
  lastUsedAt: string;
  sessionCount: number;
}

function statsFromRecentPaths(rows: RecentPathLike[]): SourceCounts {
  let sessionCount = 0;
  let lastUsedAt: string | null = null;
  for (const row of rows) {
    sessionCount += row.sessionCount;
    if (row.lastUsedAt && (!lastUsedAt || row.lastUsedAt > lastUsedAt)) {
      lastUsedAt = row.lastUsedAt;
    }
  }
  return { sessionCount, lastUsedAt };
}

async function sessionCountsFor(
  source: ImportedHistorySourceId
): Promise<SourceCounts> {
  return statsFromRecentPaths(await importedHistoryRecentPaths(source));
}

/** Hidden sub-agent sessions cached for the source (0 for all but Cursor). */
async function subagentCountFor(
  source: ImportedHistorySourceId
): Promise<number> {
  try {
    return await invoke<number>("imported_history_subagent_count", { source });
  } catch {
    return 0;
  }
}

/**
 * Aggregate the sessions ORGII has cached/imported for a source. This reflects
 * what the app can actually read (what shows in the sidebar) — not whether a
 * CLI binary happens to be on PATH. Top-level sessions and hidden sub-agent
 * sessions are counted separately and fetched in parallel.
 */
export async function fetchExternalSourceStats(
  source: ImportedHistorySourceId
): Promise<ExternalSourceStats> {
  const [counts, subagentCount] = await Promise.all([
    sessionCountsFor(source),
    subagentCountFor(source),
  ]);
  return { ...counts, subagentCount };
}

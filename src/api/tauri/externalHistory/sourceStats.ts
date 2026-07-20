import { getOrgtrackCursorSessions } from "@src/api/tauri/orgtrackHistory";

import type { ImportedHistorySourceId } from "./imported/descriptors";
import { claudeCodeRecentPaths } from "./sources/claudeCode";
import { clineRecentPaths } from "./sources/cline";
import { codexAppRecentPaths } from "./sources/codexApp";
import { opencodeRecentPaths } from "./sources/opencode";
import { qoderRecentPaths } from "./sources/qoder";
import { traeRecentPaths } from "./sources/trae";
import { warpRecentPaths } from "./sources/warp";
import { windsurfRecentPaths } from "./sources/windsurf";
import { workBuddyRecentPaths } from "./sources/workbuddy";

export interface ExternalSourceStats {
  /** Total sessions ORGII has imported/cached for the source. */
  sessionCount: number;
  /** ISO timestamp of the most recently used session, or null if none. */
  lastUsedAt: string | null;
}

interface RecentPathLike {
  lastUsedAt: string;
  sessionCount: number;
}

/**
 * Per-source recent-path fetchers. These aggregate cached sessions grouped by
 * project/workspace path. Cursor App is handled separately (below) because it
 * has no `*_recent_paths` command — its sessions live in `state.vscdb` and are
 * read via the existing `orgtrack_get_cursor_sessions` pipeline.
 */
const RECENT_PATH_FETCHERS: Partial<
  Record<ImportedHistorySourceId, () => Promise<RecentPathLike[]>>
> = {
  claude_code: () => claudeCodeRecentPaths(),
  codex_app: () => codexAppRecentPaths(),
  opencode: () => opencodeRecentPaths(),
  windsurf: () => windsurfRecentPaths(),
  workbuddy: () => workBuddyRecentPaths(),
  trae: () => traeRecentPaths(),
  cline: () => clineRecentPaths(),
  warp: () => warpRecentPaths(),
  qoder: () => qoderRecentPaths(),
};

function statsFromRecentPaths(rows: RecentPathLike[]): ExternalSourceStats {
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

async function cursorStats(): Promise<ExternalSourceStats> {
  // Cursor sessions are date-range queried; span all of time for a total.
  const today = new Date().toISOString().slice(0, 10);
  const sessions = await getOrgtrackCursorSessions("1970-01-01", today);
  let lastActiveMs = 0;
  for (const session of sessions) {
    if (session.lastActiveAt > lastActiveMs)
      lastActiveMs = session.lastActiveAt;
  }
  return {
    sessionCount: sessions.length,
    lastUsedAt: lastActiveMs > 0 ? new Date(lastActiveMs).toISOString() : null,
  };
}

/**
 * Aggregate the sessions ORGII has cached/imported for a source. This reflects
 * what the app can actually read (what shows in the sidebar) — not whether a
 * CLI binary happens to be on PATH.
 */
export async function fetchExternalSourceStats(
  source: ImportedHistorySourceId
): Promise<ExternalSourceStats> {
  if (source === "cursor_ide") {
    return cursorStats();
  }
  const fetcher = RECENT_PATH_FETCHERS[source];
  if (!fetcher) return { sessionCount: 0, lastUsedAt: null };
  return statsFromRecentPaths(await fetcher());
}

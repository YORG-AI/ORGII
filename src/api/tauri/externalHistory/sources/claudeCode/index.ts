import { invoke } from "@tauri-apps/api/core";

import type { ActivityChunk } from "@src/types/session/session";

export interface ClaudeCodeRecentPath {
  path: string;
  name?: string;
  lastUsedAt: string;
  sessionCount: number;
}

export async function claudeCodeRecentPaths(args?: {
  limit?: number;
}): Promise<ClaudeCodeRecentPath[]> {
  return invoke<ClaudeCodeRecentPath[]>("claude_code_recent_paths", {
    limit: args?.limit,
  });
}

export async function claudeCodeHistoryChunks(
  sessionId: string
): Promise<ActivityChunk[]> {
  return invoke<ActivityChunk[]>("claude_code_history_chunks", { sessionId });
}

export interface ImportedTranscriptStat {
  mtimeMs: number;
  sizeBytes: number;
  /**
   * Real on-disk footprint when `sizeBytes` is a change-detection surrogate
   * (session-local SQLite signatures fold row aggregates into it). Use this
   * for size-tiered cooldowns; absent when `sizeBytes` is already real.
   */
  storeSizeBytes?: number;
}

/**
 * Cheap freshness probe (a single `stat` backend-side). Lets the replay
 * auto-refresh skip the full read/parse/merge pipeline when the transcript
 * file hasn't changed. `null` when the source file is missing.
 */
export async function claudeCodeHistoryStat(
  sessionId: string
): Promise<ImportedTranscriptStat | null> {
  return invoke<ImportedTranscriptStat | null>("claude_code_history_stat", {
    sessionId,
  });
}

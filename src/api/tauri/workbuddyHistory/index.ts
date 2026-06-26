import { invoke } from "@tauri-apps/api/core";

import type { ActivityChunk } from "@src/types/session/session";

export interface WorkBuddyHistorySessionRow {
  sessionId: string;
  name: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  category: "external_history";
  readOnly: true;
  model?: string;
  totalTokens: number;
  background: boolean;
  isActive: boolean;
  repoPath?: string;
  repoName?: string;
  branch?: string;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  touchedFiles: string[];
}

export interface WorkBuddyHistorySessionPage {
  sessions: WorkBuddyHistorySessionRow[];
  hasMore: boolean;
}

export interface WorkBuddyRecentPath {
  path: string;
  name?: string;
  lastUsedAt: string;
  sessionCount: number;
}

export async function workBuddyHistoryListSessions(args?: {
  limit?: number;
  offset?: number;
}): Promise<WorkBuddyHistorySessionPage> {
  return invoke<WorkBuddyHistorySessionPage>(
    "workbuddy_history_list_sessions",
    {
      limit: args?.limit,
      offset: args?.offset,
    }
  );
}

export async function workBuddyRecentPaths(args?: {
  limit?: number;
}): Promise<WorkBuddyRecentPath[]> {
  return invoke<WorkBuddyRecentPath[]>("workbuddy_recent_paths", {
    limit: args?.limit,
  });
}

export async function workBuddyHistoryChunks(
  sessionId: string
): Promise<ActivityChunk[]> {
  return invoke<ActivityChunk[]>("workbuddy_history_chunks", { sessionId });
}

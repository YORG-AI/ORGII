import { invoke } from "@tauri-apps/api/core";

export interface WorkBuddyRecentPath {
  path: string;
  name?: string;
  lastUsedAt: string;
  sessionCount: number;
}

export async function workBuddyRecentPaths(args?: {
  limit?: number;
}): Promise<WorkBuddyRecentPath[]> {
  return invoke<WorkBuddyRecentPath[]>("workbuddy_recent_paths", {
    limit: args?.limit,
  });
}

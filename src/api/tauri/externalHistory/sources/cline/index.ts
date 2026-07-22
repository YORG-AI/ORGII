import { invoke } from "@tauri-apps/api/core";

export interface ClineRecentPath {
  path: string;
  name?: string;
  lastUsedAt: string;
  sessionCount: number;
}

export async function clineRecentPaths(args?: {
  limit?: number;
}): Promise<ClineRecentPath[]> {
  return invoke<ClineRecentPath[]>("cline_recent_paths", {
    limit: args?.limit,
  });
}

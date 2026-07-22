import { invoke } from "@tauri-apps/api/core";

export interface WarpRecentPath {
  path: string;
  name?: string;
  lastUsedAt: string;
  sessionCount: number;
}

export async function warpRecentPaths(args?: {
  limit?: number;
}): Promise<WarpRecentPath[]> {
  return invoke<WarpRecentPath[]>("warp_recent_paths", {
    limit: args?.limit,
  });
}

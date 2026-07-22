import { invoke } from "@tauri-apps/api/core";

export interface WindsurfRecentPath {
  path: string;
  name?: string;
  lastUsedAt: string;
  sessionCount: number;
}

export async function windsurfRecentPaths(args?: {
  limit?: number;
}): Promise<WindsurfRecentPath[]> {
  return invoke<WindsurfRecentPath[]>("windsurf_recent_paths", {
    limit: args?.limit,
  });
}

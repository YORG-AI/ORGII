import { invoke } from "@tauri-apps/api/core";

export interface TraeRecentPath {
  path: string;
  name?: string;
  lastUsedAt: string;
  sessionCount: number;
}

export async function traeRecentPaths(args?: {
  limit?: number;
}): Promise<TraeRecentPath[]> {
  return invoke<TraeRecentPath[]>("trae_recent_paths", {
    limit: args?.limit,
  });
}

import { invoke } from "@tauri-apps/api/core";

export interface QoderRecentPath {
  path: string;
  name?: string;
  lastUsedAt: string;
  sessionCount: number;
}

export async function qoderRecentPaths(args?: {
  limit?: number;
}): Promise<QoderRecentPath[]> {
  return invoke<QoderRecentPath[]>("qoder_recent_paths", {
    limit: args?.limit,
  });
}

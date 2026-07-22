import { invoke } from "@tauri-apps/api/core";

export interface QoderCliRecentPath {
  path: string;
  name?: string | null;
  lastUsedAt: string;
  sessionCount: number;
}

export async function qoderCliRecentPaths(args?: {
  limit?: number;
}): Promise<QoderCliRecentPath[]> {
  return invoke<QoderCliRecentPath[]>("qoder_cli_recent_paths", {
    limit: args?.limit,
  });
}

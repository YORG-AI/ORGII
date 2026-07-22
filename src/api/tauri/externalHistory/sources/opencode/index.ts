import { invoke } from "@tauri-apps/api/core";

export interface OpenCodeRecentPath {
  path: string;
  name?: string;
  lastUsedAt: string;
  sessionCount: number;
}

export async function opencodeRecentPaths(args?: {
  limit?: number;
}): Promise<OpenCodeRecentPath[]> {
  return invoke<OpenCodeRecentPath[]>("opencode_recent_paths", {
    limit: args?.limit,
  });
}

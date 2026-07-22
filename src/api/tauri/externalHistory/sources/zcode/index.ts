import { invoke } from "@tauri-apps/api/core";

export interface ZCodeRecentPath {
  path: string;
  name?: string;
  lastUsedAt: string;
  sessionCount: number;
}

export async function zcodeRecentPaths(args?: {
  limit?: number;
}): Promise<ZCodeRecentPath[]> {
  return invoke<ZCodeRecentPath[]>("zcode_recent_paths", {
    limit: args?.limit,
  });
}

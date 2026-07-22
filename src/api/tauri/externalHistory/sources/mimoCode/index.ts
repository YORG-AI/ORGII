import { invoke } from "@tauri-apps/api/core";

export interface MimoCodeRecentPath {
  path: string;
  name?: string | null;
  lastUsedAt: string;
  sessionCount: number;
}

export async function mimoCodeRecentPaths(args?: {
  limit?: number;
}): Promise<MimoCodeRecentPath[]> {
  return invoke<MimoCodeRecentPath[]>("mimo_code_recent_paths", {
    limit: args?.limit,
  });
}

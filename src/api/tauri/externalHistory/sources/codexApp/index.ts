import { invoke } from "@tauri-apps/api/core";

export interface CodexAppRecentPath {
  path: string;
  name?: string;
  lastUsedAt: string;
  sessionCount: number;
}

export async function codexAppRecentPaths(args?: {
  limit?: number;
}): Promise<CodexAppRecentPath[]> {
  return invoke<CodexAppRecentPath[]>("codex_app_recent_paths", {
    limit: args?.limit,
  });
}

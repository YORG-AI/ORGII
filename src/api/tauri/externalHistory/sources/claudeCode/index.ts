import { invoke } from "@tauri-apps/api/core";

export interface ClaudeCodeRecentPath {
  path: string;
  name?: string;
  lastUsedAt: string;
  sessionCount: number;
}

export async function claudeCodeRecentPaths(args?: {
  limit?: number;
}): Promise<ClaudeCodeRecentPath[]> {
  return invoke<ClaudeCodeRecentPath[]>("claude_code_recent_paths", {
    limit: args?.limit,
  });
}

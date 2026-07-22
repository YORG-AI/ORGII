import { invoke } from "@tauri-apps/api/core";

export interface CursorCliRecentPath {
  path: string;
  name?: string;
  lastUsedAt: string;
  sessionCount: number;
}

export async function cursorCliRecentPaths(args?: {
  limit?: number;
}): Promise<CursorCliRecentPath[]> {
  return invoke<CursorCliRecentPath[]>("cursor_cli_recent_paths", {
    limit: args?.limit,
  });
}

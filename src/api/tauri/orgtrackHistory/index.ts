import { invoke } from "@tauri-apps/api/core";

import type { CursorSession } from "./types";

export async function getOrgtrackCursorSessions(
  startDate: string,
  endDate: string
): Promise<CursorSession[]> {
  return invoke<CursorSession[]>("orgtrack_get_cursor_sessions", {
    startDate,
    endDate,
  });
}

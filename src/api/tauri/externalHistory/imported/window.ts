import { invoke } from "@tauri-apps/api/core";

import type { ActivityChunk } from "@src/types/session/session";

export interface ImportedHistoryInitialWindow {
  chunks: ActivityChunk[];
  totalTurnCount: number;
  loadedTurnCount: number;
  hasUnloadedTurns: boolean;
}

export interface ImportedHistoryTurnWindow {
  chunks: ActivityChunk[];
  turnId: string;
  loadedEventCount: number;
}

export async function importedHistoryInitialWindow(args: {
  sessionId: string;
  recentTurnCount?: number;
}): Promise<ImportedHistoryInitialWindow> {
  return invoke<ImportedHistoryInitialWindow>(
    "imported_history_initial_window",
    args
  );
}

export async function importedHistoryTurnWindows(args: {
  sessionId: string;
  turnIds: string[];
}): Promise<ImportedHistoryTurnWindow[]> {
  return invoke<ImportedHistoryTurnWindow[]>(
    "imported_history_turn_windows",
    args
  );
}

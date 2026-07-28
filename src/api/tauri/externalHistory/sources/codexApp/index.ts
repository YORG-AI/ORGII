import { invoke } from "@tauri-apps/api/core";

import type { ActivityChunk } from "@src/types/session/session";

export interface CodexAppRecentPath {
  path: string;
  name?: string;
  lastUsedAt: string;
  sessionCount: number;
}

export interface CodexAppInitialWindow {
  chunks: ActivityChunk[];
  /** Backend-only projection cache; intentionally omitted from the IPC wire. */
  turns?: Array<{
    turnId: string;
    startSequence: number;
    startedAt: string;
    endedAt: string | null;
    status: string;
    userPreview: string;
    eventCount: number;
    bodyEventCount: number;
  }>;
}

export interface CodexAppTurnWindow {
  chunks: ActivityChunk[];
  turnId: string;
  loadedEventCount: number;
}

export async function codexAppRecentPaths(args?: {
  limit?: number;
}): Promise<CodexAppRecentPath[]> {
  return invoke<CodexAppRecentPath[]>("codex_app_recent_paths", {
    limit: args?.limit,
  });
}

export async function codexAppChunks(
  sessionId: string
): Promise<ActivityChunk[]> {
  return invoke<ActivityChunk[]>("codex_app_chunks", { sessionId });
}

export async function codexAppInitialWindow(
  sessionId: string
): Promise<CodexAppInitialWindow> {
  return invoke<CodexAppInitialWindow>("codex_app_initial_window", {
    sessionId,
  });
}

export async function codexAppTurnWindow(args: {
  sessionId: string;
  turnId: string;
}): Promise<CodexAppTurnWindow> {
  return invoke<CodexAppTurnWindow>("codex_app_turn_window", args);
}

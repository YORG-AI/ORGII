/**
 * Managed-session backing for TUI (interactive terminal) CLI launches.
 *
 * A TUI launch creates a real `code_sessions` row (`runner = 'tui'`) so the
 * worktree selection, live-status attribution (`ORGII_SESSION_ID`), and
 * native-transcript replay all work exactly like headless launches — the
 * only difference is that no child process is spawned; the CLI runs in the
 * chat panel's terminal pane.
 */
import { invoke } from "@tauri-apps/api/core";

import type { CliAgentType } from "@src/api/types/keys";

export interface CliTuiSessionCreateParams {
  platform: CliAgentType;
  name: string;
  repoPath?: string;
  /** Create a fresh isolated worktree (`branch` = base ref when set). */
  isolate?: boolean;
  branch?: string;
  /** Reuse an existing worktree checkout (mutually exclusive with isolate). */
  worktreePath?: string;
}

export interface CliTuiSessionInfo {
  sessionId: string;
  worktreePath?: string | null;
  repoPath?: string | null;
}

export async function cliAgentCreateTuiSession(
  params: CliTuiSessionCreateParams
): Promise<CliTuiSessionInfo> {
  return invoke<CliTuiSessionInfo>("cli_agent_create", {
    params: {
      name: params.name,
      platform: params.platform,
      keySource: "own_key",
      runner: "tui",
      ...(params.repoPath ? { repoPath: params.repoPath } : {}),
      ...(params.isolate ? { isolate: true } : {}),
      ...(params.branch ? { branch: params.branch } : {}),
      ...(params.worktreePath ? { worktreePath: params.worktreePath } : {}),
    },
  });
}

/**
 * Park a TUI session when its terminal pane goes away (PTY exit / tab
 * close). Fire-and-forget: a failed release only leaves the row at its last
 * hook-driven status.
 */
export async function cliAgentTuiRelease(sessionId: string): Promise<void> {
  try {
    await invoke("cli_agent_tui_release", { sessionId });
  } catch {
    // Best-effort — the session row simply keeps its last status.
  }
}

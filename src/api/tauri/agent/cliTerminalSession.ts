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

import { rpc } from "@src/api/tauri/rpc";
import type { CliLaunchProfileView } from "@src/api/tauri/rpc/schemas/agentOrgs";
import { CLI_AGENT, type CliAgentType } from "@src/api/types/keys";

export interface CliTuiSessionCreateParams {
  platform: CliAgentType;
  name: string;
  repoPath?: string;
  /** Create a fresh isolated worktree (`branch` = base ref when set). */
  isolate?: boolean;
  branch?: string;
  /** Reuse an existing worktree checkout (mutually exclusive with isolate). */
  worktreePath?: string;
  /** Session ownership scope selected in the sidebar. */
  orgId?: string;
}

export interface CliTuiSessionInfo {
  sessionId: string;
  worktreePath?: string | null;
  repoPath?: string | null;
}

function quotePosixShellArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function formatCliTuiCommand(
  profile: CliLaunchProfileView,
  detectedCommand: string
): string {
  const executable = profile.commandOverridden
    ? profile.command
    : detectedCommand;
  // `codex exec` is the headless runner and requires a prompt. TUI launches
  // must start Codex's interactive CLI instead, while retaining its selected
  // permission-mode flags (which Codex also accepts at the top level).
  const requiredArgs =
    profile.agentName === CLI_AGENT.CODEX ? [] : profile.requiredArgs;
  return [executable, ...requiredArgs, ...profile.args]
    .filter((part) => part.trim().length > 0)
    .map(quotePosixShellArg)
    .join(" ");
}

/** Resolve a terminal-safe command from the managed CLI launch profile. */
export async function resolveCliTuiCommand(
  platform: CliAgentType,
  detectedCommand: string
): Promise<string> {
  try {
    const profile = await rpc.agentOrgs.launchProfiles.get({
      agentName: platform,
    });
    return formatCliTuiCommand(profile, detectedCommand);
  } catch {
    return detectedCommand;
  }
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
      ...(params.orgId ? { orgId: params.orgId } : {}),
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

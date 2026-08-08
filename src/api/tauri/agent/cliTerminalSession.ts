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
import { isWindows } from "@src/util/platform/tauri";

export interface CliTuiSessionCreateParams {
  platform: CliAgentType;
  name: string;
  repoPath?: string;
  /** Create a fresh isolated worktree. */
  isolate?: boolean;
  /** Dedicated base ref for a fresh isolated worktree. */
  worktreeBaseRef?: string;
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

const SAFE_SHELL_ARG_PATTERN = /^[A-Za-z0-9_./:@%+=,-]+$/;

/** POSIX single-quote escaping: wrap in `'…'`, escape embedded `'` as `'\''`. */
function quotePosixShellArg(value: string): string {
  if (SAFE_SHELL_ARG_PATTERN.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * PowerShell single-quote escaping. Unlike POSIX, backslashes inside a
 * PowerShell single-quoted string are literal — no escaping needed — so a
 * Windows path like `C:\Users\me\session.jsonl` passes through unchanged;
 * only an embedded `'` needs doubling.
 */
function quotePowerShellArg(value: string): string {
  if (SAFE_SHELL_ARG_PATTERN.test(value)) return value;
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Quote a single shell argument for the chat-panel PTY's default shell.
 * That default is PowerShell on Windows (`shells.rs`'s Windows branch
 * pushes PowerShell as `is_default: true`) and a POSIX shell everywhere
 * else, so POSIX `'\''`-escaping mis-quotes Windows paths (e.g. omp's
 * `--session <path>`). `windows` is injectable so tests can pin either
 * quoting style regardless of the host OS running the test.
 */
function quoteShellArg(value: string, windows: boolean): string {
  return windows ? quotePowerShellArg(value) : quotePosixShellArg(value);
}

/**
 * Append extra arguments (e.g. a resume flag + session id) to an
 * already-resolved terminal command, quoting each the same way the launch
 * profile formatter does.
 */
export function appendCliCommandArgs(
  command: string,
  args: string[],
  windows: boolean = isWindows()
): string {
  const suffix = args
    .filter((arg) => arg.trim().length > 0)
    .map((arg) => quoteShellArg(arg, windows))
    .join(" ");
  return suffix.length > 0 ? `${command} ${suffix}` : command;
}

export function formatCliTuiCommand(
  profile: CliLaunchProfileView,
  detectedCommand: string,
  windows: boolean = isWindows()
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
    .map((part) => quoteShellArg(part, windows))
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

/**
 * First token of a resolved CLI command line, unquoted — used to match the
 * PTY's live foreground process name (`useTerminalProcessPoller`) against
 * the command actually launched.
 *
 * A plain whitespace split mis-handles a leading quoted binary (a
 * `commandOverridden` launch profile, or an omp `--session <path>` resume
 * whose binary itself contains spaces): `'/Applications/Trae Agent/trae-cli'
 * interactive`.split(/\s+/) would wrongly yield `'/Applications/Trae`. This
 * detects a single leading quoted token — POSIX `'\''`-escaped or
 * PowerShell `''`-doubled, the two styles `quoteShellArg` above produces —
 * and returns it unquoted.
 */
export function deriveExpectedProcess(command: string): string | undefined {
  const trimmed = command.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("'")) {
    const closingIndex = findClosingQuoteIndex(trimmed);
    if (closingIndex > 0) {
      const inner = trimmed.slice(1, closingIndex);
      const unescaped = inner.replace(/'\\''/g, "'").replace(/''/g, "'");
      return unescaped || undefined;
    }
  }
  const [binary] = trimmed.split(/\s+/);
  return binary || undefined;
}

/**
 * Index of the `'` that closes a leading quoted token: the first `'` (after
 * the opening one) followed by whitespace or end-of-string. Embedded quotes
 * in either escaping style are always followed by another quote or
 * backslash, never whitespace, so they're skipped.
 */
function findClosingQuoteIndex(value: string): number {
  for (let index = 1; index < value.length; index += 1) {
    if (value[index] !== "'") continue;
    const next = value[index + 1];
    if (next === undefined || /\s/.test(next)) return index;
  }
  return -1;
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
      ...(params.worktreeBaseRef
        ? { worktreeBaseRef: params.worktreeBaseRef }
        : {}),
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

import { invoke } from "@tauri-apps/api/core";

/**
 * Backend plan for reopening an imported external session in the CLI that
 * owns it (`claude --resume`, `codex resume`, `cursor-agent --resume`).
 * Mirrors `ExternalHistoryCliResumePlanWire` in
 * `src-tauri/src/orgtrack/history_commands.rs` (camelCase JSON).
 */
export interface ExternalHistoryCliResumePlan {
  /** Imported-history source id (`claude_code` / `codex_app` / `cursor_cli`). */
  source: string;
  /** `code_sessions.cli_agent_type` of the owning CLI (launch-profile key). */
  cliAgentType: string;
  /** Bare binary to run when the CLI registry has no detected command. */
  defaultBinary: string;
  /** Arguments appended after the binary to reopen the session. */
  resumeArgs: string[];
  /** The session id the CLI itself accepts. */
  nativeSessionId: string;
  /** Recorded workspace directory of the session, when known. */
  cwd: string | null;
  /** Whether the CLI can only locate the session from its original cwd. */
  requiresCwd: boolean;
  /** Human-readable `binary args…` string for tooltips/copy. */
  displayCommand: string;
  /** Whether `cwd` still exists as a directory on this machine. */
  cwdExists: boolean;
  /** Whether the source transcript/store behind the import is still on disk. */
  sourceAvailable: boolean;
}

/**
 * `null` when the session is unknown to the imported-history cache, is a
 * subagent child, or its source has no CLI resume path (e.g. Cursor IDE
 * composers — no CLI can reopen those).
 */
export async function externalHistoryCliResumePlan(
  sessionId: string
): Promise<ExternalHistoryCliResumePlan | null> {
  return invoke<ExternalHistoryCliResumePlan | null>(
    "external_history_cli_resume_plan",
    { sessionId }
  );
}

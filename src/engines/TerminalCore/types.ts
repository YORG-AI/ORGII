/**
 * TerminalCore Types
 *
 * Core types for terminal sessions and state management.
 */
import type { CliAgentType } from "@src/api/types/keys";
import type { ShellKind } from "@src/types/terminal";

export const TERMINAL_AGENT_STATUS = {
  STARTING: "starting",
  RUNNING: "running",
  WAITING: "waiting",
  DONE: "done",
} as const;

export type TerminalAgentStatus =
  (typeof TERMINAL_AGENT_STATUS)[keyof typeof TERMINAL_AGENT_STATUS];

export interface TerminalSession {
  id: string;
  name: string;
  isActive: boolean;
  pid?: number;
  shell?: string;
  shellKind?: ShellKind;
  cwd?: string;
  /** Read-only agent session terminal (no user input forwarding) */
  readOnly?: boolean;
  /** Agent session ID this terminal is associated with */
  agentSessionId?: string;
  /** Shell profile ID used to create this session */
  profileId?: string;
  /** User-assigned title (highest priority for display) */
  userTitle?: string;
  /** Title from OSC 0/2 escape sequences */
  sequenceTitle?: string;
  /** Name of the foreground process (from polling) */
  processName?: string;
  /** Live CWD (updated by process polling, not just initial cwd) */
  liveCwd?: string;
  /** True for the automatically-created placeholder terminal session. */
  isDefaultSession?: boolean;
  /** True after direct user input has been sent to the PTY. */
  hasUserInput?: boolean;
  /** CLI agent hosted in this terminal, when launched from the chat panel. */
  cliAgentType?: CliAgentType;
  /** Command injected to start the CLI agent. */
  agentCommand?: string;
  /** Environment variables supplied when the PTY is created. */
  envOverride?: Record<string, string>;
  /** Foreground process name expected while the CLI agent is active. */
  expectedProcess?: string;
  /** Derived lifecycle state for chat-panel TUI agent tracking. */
  agentStatus?: TerminalAgentStatus;
}

/** Resolved display title for a terminal session, by priority. */
export function getTerminalDisplayTitle(session: TerminalSession): string {
  return (
    session.userTitle ||
    session.sequenceTitle ||
    session.processName ||
    session.name
  );
}

export interface AddSessionOptions {
  /** Internal setup flows may require a dedicated session immediately after
   * the Terminal tab mounts its default session. User-initiated creation must
   * leave this false so rapid clicks remain throttled. */
  bypassCreationCooldown?: boolean;
  /** Shell profile ID to use (if omitted, uses default profile) */
  profileId?: string;
  /** Shell executable path override */
  shell?: string;
  /** Shell arguments override */
  args?: string[];
  /** Custom environment variables */
  env?: Record<string, string>;
  /** Initial working directory for the terminal session */
  cwd?: string;
  /** User-assigned name for this terminal */
  name?: string;
}

export interface UseTerminalStateReturn {
  /** All terminal sessions */
  sessions: TerminalSession[];
  /** Currently active session ID */
  activeSessionId: string;
  /** Currently active session object */
  activeSession: TerminalSession | undefined;
  /** Initialized sessions (PTY connections ready) */
  initializedSessions: Set<string>;
  /** Add a new session (optionally with a shell profile) */
  addSession: (options?: AddSessionOptions) => string;
  /** Close a session */
  closeSession: (sessionId: string) => void;
  /** Switch to a session */
  setActiveSession: (sessionId: string) => void;
  /** Mark a session as initialized */
  markSessionInitialized: (sessionId: string) => void;
  /** Update session info (PID, shell, cwd, etc.) */
  updateSessionInfo: (
    sessionId: string,
    info: Partial<
      Pick<
        TerminalSession,
        | "pid"
        | "shell"
        | "shellKind"
        | "cwd"
        | "userTitle"
        | "sequenceTitle"
        | "processName"
        | "liveCwd"
        | "isDefaultSession"
        | "hasUserInput"
        | "agentStatus"
      >
    >
  ) => void;
  /** Rename a terminal session */
  renameSession: (sessionId: string, title: string) => void;
}

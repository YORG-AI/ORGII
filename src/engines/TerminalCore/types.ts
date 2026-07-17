/**
 * TerminalCore Types
 *
 * Core types for terminal sessions and state management.
 */
import type { CliAgentType } from "@src/api/types/keys";
import type { ShellKind } from "@src/types/terminal";
import type { TerminalAgentStatus } from "@src/types/terminalAgentStatus";

export {
  TERMINAL_AGENT_STATUS,
  TERMINAL_AGENT_STATUS_VALUES,
  isTerminalAgentStatus,
  type TerminalAgentStatus,
} from "@src/types/terminalAgentStatus";

export type TerminalAgentStatusSource = "process" | "hook";

/** Privacy-safe activity metadata emitted by a CLI agent hook. */
export interface TerminalAgentActivity {
  hookEventName?: string;
  toolName?: string;
  toolInputPreview?: string;
  model?: string;
  cwd?: string;
  durationMs?: number;
  updatedAt: number;
}

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
  /** Foreground process name expected while the CLI agent is active. */
  expectedProcess?: string;
  /** Derived lifecycle state for chat-panel TUI agent tracking. */
  agentStatus?: TerminalAgentStatus;
  /** Authoritative source for the current lifecycle state. */
  agentStatusSource?: TerminalAgentStatusSource;
  /** Latest privacy-safe hook activity for status affordances. */
  agentActivity?: TerminalAgentActivity;
  /** Environment inherited by the PTY shell for this session. */
  env?: Record<string, string>;
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
        | "agentStatusSource"
        | "agentActivity"
        | "env"
      >
    >
  ) => void;
  /** Rename a terminal session */
  renameSession: (sessionId: string, title: string) => void;
}

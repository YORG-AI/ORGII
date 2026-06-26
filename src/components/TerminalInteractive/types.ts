/**
 * Terminal View Types
 */

export interface TerminalSelectionInfo {
  text: string;
  position: { x: number; y: number };
}

/** Methods exposed via ref for terminal search */
export interface TerminalViewHandle {
  /** Search for text in terminal buffer */
  findNext: (
    query: string,
    options?: { caseSensitive?: boolean; regex?: boolean; wholeWord?: boolean }
  ) => boolean;
  /** Search backwards for text in terminal buffer */
  findPrevious: (
    query: string,
    options?: { caseSensitive?: boolean; regex?: boolean; wholeWord?: boolean }
  ) => boolean;
  /** Clear search decorations */
  clearSearch: () => void;
  /** Focus the terminal */
  focus: () => void;
  /** Select all text in the terminal buffer */
  selectAll: () => void;
  /**
   * Redraw the terminal after it becomes visible again.
   *
   * When sessions are toggled via `display: none`, the WebGL glyph texture
   * atlas can become stale relative to the container's current dimensions or
   * device pixel ratio, producing a half-step "double render" of the prompt
   * line on the first paint after re-show. This drops the cached atlas,
   * re-fits to the current container, and forces a full refresh so the next
   * frame is drawn cleanly.
   */
  redrawAfterShow: () => void;
}

export interface ShellIntegrationEvents {
  onPromptStart?: () => void;
  onCommandExecuted?: (commandLine: string | undefined) => void;
  onCommandFinished?: (exitCode: number) => void;
  onCwdChanged?: (cwd: string) => void;
}

export interface TerminalFileLinkTarget {
  path: string;
  line?: number;
}

export interface TerminalViewProps {
  sessionKey: string;
  /** Callback when text is selected in the terminal */
  onSelectionChange?: (selection: TerminalSelectionInfo | null) => void;
  /** Callback when terminal receives output */
  onOutput?: () => void;
  /** Callback when the user sends input into the PTY. */
  onUserInput?: () => void;
  /** Repository path for terminal working directory */
  repoPath?: string;
  /** Current working directory used to resolve relative file links */
  workingDirectory?: string;
  /** Opens a file reference detected in terminal output */
  onOpenFileLink?: (target: TerminalFileLinkTarget) => void;
  /** Callback when session info is ready (PID, shell, cwd) */
  onSessionInfoReady?: (info: {
    sessionKey: string;
    pid?: number;
    shell?: string;
    cwd?: string;
  }) => void;
  /** Callback when the terminal title changes (OSC 0/2 sequences) */
  onTitleChange?: (title: string) => void;
  /** Override shell executable (from session profile) */
  shellOverride?: string;
  /** Override shell arguments (from session profile) */
  argsOverride?: string[];
  /** Custom environment variables (from session profile) */
  envOverride?: Record<string, string>;
  /** User-assigned display name for this terminal */
  nameOverride?: string;
  /** Shell integration event callbacks (OSC 633) */
  shellIntegration?: ShellIntegrationEvents;
}

import type { TerminalSession } from "./types";

/**
 * Keep the heavyweight xterm/WebGL surface scoped to the one terminal the
 * user can currently see. The PTY process is owned by Tauri and survives this
 * UI unmount; TerminalView's cleanup detaches the stream and its next mount
 * reconnects from the bounded backend snapshot.
 */
export function selectMountedTerminalSession(
  sessions: readonly TerminalSession[],
  activeSessionId: string,
  visible: boolean
): TerminalSession | undefined {
  if (!visible) return undefined;
  return sessions.find((session) => session.id === activeSessionId);
}

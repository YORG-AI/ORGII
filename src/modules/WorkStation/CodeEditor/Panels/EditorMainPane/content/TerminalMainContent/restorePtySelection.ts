import type { TerminalSession } from "@src/engines/TerminalCore/types";
import type { TerminalTarget } from "@src/store/workstation/codeEditor/terminalTargetAtom";

/**
 * Resolve the PTY that a WorkStation workspace previously selected.
 *
 * PTY processes are global, while the selected terminal is workspace-scoped.
 * Returning a value here lets the view restore that selection after a Session
 * switch without restarting or duplicating the underlying PTY.
 */
export function resolveRestoredPtySessionId(
  target: TerminalTarget | null,
  sessions: readonly TerminalSession[],
  activeSessionId: string
): string | null {
  if (target?.kind !== "pty" || target.ptySessionId === activeSessionId) {
    return null;
  }

  return sessions.some((session) => session.id === target.ptySessionId)
    ? target.ptySessionId
    : null;
}

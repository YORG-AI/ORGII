import { useTerminalState } from "@/src/engines/TerminalCore/hooks/useTerminalState";
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback } from "react";

import { selectedRepoPathAtom } from "@src/store/repo";
// Deep import; the @src/store/workstation/codeEditor barrel re-exports
// sourceControlFilterModeAtom which transitively pulls SidebarModules back
// here, creating a circular dependency.
import {
  type TerminalTarget,
  codeEditorTerminalTargetAtom,
} from "@src/store/workstation/codeEditor/terminalTargetAtom";

import { type TabSidebarComponent, registerTabSidebar } from "../registry";
import TerminalSidebarContent from "./TerminalSidebarContent";

const TerminalTabSidebar: TabSidebarComponent = () => {
  const terminalState = useTerminalState();
  const terminalTarget = useAtomValue(codeEditorTerminalTargetAtom);
  const selectedRepoPath = useAtomValue(selectedRepoPathAtom);
  const setTerminalTarget = useSetAtom(codeEditorTerminalTargetAtom);
  const activeTerminalTarget =
    terminalTarget?.kind === "agent"
      ? terminalTarget
      : terminalState.activeSessionId
        ? { kind: "pty" as const, ptySessionId: terminalState.activeSessionId }
        : null;

  const handleOpenTerminal = useCallback(
    (target: TerminalTarget) => {
      if (target.kind === "pty") {
        const exists = terminalState.sessions.some(
          (session) => session.id === target.ptySessionId
        );
        if (exists) {
          terminalState.setActiveSession(target.ptySessionId);
        }
      }
      setTerminalTarget(target);
    },
    [terminalState, setTerminalTarget]
  );

  const handleNewPtySession = useCallback(
    (options?: {
      shell?: string;
      args?: string[];
      name?: string;
      profileId?: string;
    }) => {
      const sessionId = terminalState.addSession({
        ...options,
        cwd: selectedRepoPath || undefined,
      });
      terminalState.setActiveSession(sessionId);
      setTerminalTarget({ kind: "pty", ptySessionId: sessionId });
    },
    [terminalState, selectedRepoPath, setTerminalTarget]
  );

  const handleClosePtySession = useCallback(
    (sessionId: string) => {
      terminalState.closeSession(sessionId);
      if (
        terminalTarget?.kind === "pty" &&
        terminalTarget.ptySessionId === sessionId
      ) {
        setTerminalTarget(null);
      }
    },
    [terminalState, terminalTarget, setTerminalTarget]
  );

  return (
    <TerminalSidebarContent
      activeTerminalTarget={activeTerminalTarget}
      onOpenTerminal={handleOpenTerminal}
      onClosePtySession={handleClosePtySession}
      onNewPtySession={handleNewPtySession}
    />
  );
};

TerminalTabSidebar.displayName = "TerminalTabSidebar";

registerTabSidebar("terminal", TerminalTabSidebar);

export { TerminalTabSidebar };

import { useAtomValue } from "jotai";
import React, { memo, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import Message from "@src/components/Message";
import {
  PrimarySidebarLayoutWithSections,
  type PrimarySidebarTab,
} from "@src/modules/WorkStation/shared/PrimarySidebarLayout";
import {
  type NewTerminalSessionOptions,
  TerminalNewSessionSplitButton,
} from "@src/modules/WorkStation/shared/TerminalNewSessionSplitButton";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import { killAgentShellProcess } from "@src/services/terminal";
import { shellProcessMapAtom } from "@src/store/session/shellProcessAtom";
import { terminalSessionsAtom } from "@src/store/workstation/codeEditor/terminal";
// Deep import; the @src/store/workstation/codeEditor barrel re-exports
// sourceControlFilterModeAtom which transitively pulls SidebarModules back
// here, creating a circular dependency.
import type { TerminalTarget } from "@src/store/workstation/codeEditor/terminalTargetAtom";

import {
  AgentSessionRow,
  PtySessionRow,
  useActiveAgentSessions,
} from "./TerminalSidebarRows";

interface TerminalSidebarContentProps {
  activeTerminalTarget: TerminalTarget | null;
  onOpenTerminal: (target: TerminalTarget) => void;
  onClosePtySession: (sessionId: string) => void;
  onNewPtySession: (options?: NewTerminalSessionOptions) => void;
}

const TerminalSidebarContent: React.FC<TerminalSidebarContentProps> = memo(
  ({
    activeTerminalTarget,
    onOpenTerminal,
    onClosePtySession,
    onNewPtySession,
  }) => {
    const { t } = useTranslation("common");

    const shellProcessMap = useAtomValue(shellProcessMapAtom);
    const allTerminalSessions = useAtomValue(terminalSessionsAtom);
    const activeAgentSessions = useActiveAgentSessions();
    const untitledLabel = t("controlTower.sidebar.untitled", "Untitled");

    const ptySessions = useMemo(
      () => allTerminalSessions.filter((session) => !session.readOnly),
      [allTerminalSessions]
    );

    const runningPidsBySession = useMemo(() => {
      const map = new Map<string, Array<{ pid: number; callId: string }>>();
      for (const [sessionId, processMap] of shellProcessMap.entries()) {
        const pids = [...processMap.values()]
          .filter(
            (process) =>
              process.status === "running" || process.status === "background"
          )
          .map((process) => ({
            pid: process.pid,
            callId: process.callId,
          }));
        if (pids.length > 0) map.set(sessionId, pids);
      }
      return map;
    }, [shellProcessMap]);

    const handleKillAgentSession = useCallback(
      async (sessionId: string) => {
        const processes = runningPidsBySession.get(sessionId) ?? [];
        try {
          await Promise.all(
            processes.map(({ pid, callId }) =>
              killAgentShellProcess({ pid, sessionId, callId })
            )
          );
        } catch (error: unknown) {
          const message =
            error instanceof Error ? error.message : String(error);
          Message.error(message || t("errors.generic"));
        }
      },
      [runningPidsBySession, t]
    );

    const newTerminalSplitButton = useMemo(
      () => (
        <TerminalNewSessionSplitButton
          density="sidebar"
          onNewTerminal={onNewPtySession}
        />
      ),
      [onNewPtySession]
    );

    const ptySectionContent = useMemo(
      () => (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {ptySessions.length === 0 ? (
            <Placeholder variant="empty" placement="sidebar" fillParentHeight />
          ) : (
            <div className="flex flex-col py-1">
              {ptySessions.map((session) => (
                <PtySessionRow
                  key={session.id}
                  session={session}
                  isActive={
                    activeTerminalTarget?.kind === "pty" &&
                    activeTerminalTarget.ptySessionId === session.id
                  }
                  onOpen={() =>
                    onOpenTerminal({ kind: "pty", ptySessionId: session.id })
                  }
                  onClose={(event) => {
                    event.stopPropagation();
                    onClosePtySession(session.id);
                  }}
                />
              ))}
            </div>
          )}
        </div>
      ),
      [activeTerminalTarget, onClosePtySession, onOpenTerminal, ptySessions]
    );

    const agentSectionContent = useMemo(
      () => (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {activeAgentSessions.length === 0 ? (
            <Placeholder variant="empty" placement="sidebar" fillParentHeight />
          ) : (
            <div className="flex flex-col py-1">
              {activeAgentSessions.map(({ sessionId, command }) => {
                const title = command || untitledLabel;
                return (
                  <AgentSessionRow
                    key={sessionId}
                    title={title}
                    isActive={
                      activeTerminalTarget?.kind === "agent" &&
                      activeTerminalTarget.sessionId === sessionId
                    }
                    onOpen={() => onOpenTerminal({ kind: "agent", sessionId })}
                    onClose={(event) => {
                      event.stopPropagation();
                      void handleKillAgentSession(sessionId);
                    }}
                  />
                );
              })}
            </div>
          )}
        </div>
      ),
      [
        activeAgentSessions,
        activeTerminalTarget,
        handleKillAgentSession,
        onOpenTerminal,
        untitledLabel,
      ]
    );

    const tabs = useMemo<PrimarySidebarTab[]>(
      () => [
        {
          key: "terminal-sessions",
          label: t("terminology.myTerminal"),
          sections: [
            {
              key: "terminal-sessions",
              title: t("terminology.myTerminal"),
              content: ptySectionContent,
              resizable: false,
              hideSeparator: activeAgentSessions.length > 0,
              actions: [
                {
                  key: "new-terminal-session",
                  customRender: newTerminalSplitButton,
                  forceVisible: true,
                },
              ],
            },
            ...(activeAgentSessions.length > 0
              ? [
                  {
                    key: "agent-terminal-sessions",
                    title: t("terminology.agentTerminal"),
                    content: agentSectionContent,
                    resizable: false,
                  },
                ]
              : []),
          ],
        },
      ],
      [
        activeAgentSessions.length,
        agentSectionContent,
        newTerminalSplitButton,
        ptySectionContent,
        t,
      ]
    );

    const handleTabChange = useCallback(() => {}, []);

    return (
      <PrimarySidebarLayoutWithSections
        tabs={tabs}
        activeTab="terminal-sessions"
        onTabChange={handleTabChange}
        hideTabs
      />
    );
  }
);

TerminalSidebarContent.displayName = "TerminalSidebarContent";

export default TerminalSidebarContent;

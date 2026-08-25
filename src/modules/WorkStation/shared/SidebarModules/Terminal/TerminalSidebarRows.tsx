import { useAtomValue } from "jotai";
import { Infinity, Terminal, X } from "lucide-react";
import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import {
  TreeRowAction,
  TreeRowBase,
  type TreeRowNode,
} from "@src/components/TreeRow";
// `types`, not the `exports` barrel — the barrel re-exports the TerminalCore
// component and would drag xterm into the sidebar-modules chunk.
import {
  type TerminalSession,
  getTerminalDisplayTitle,
} from "@src/engines/TerminalCore/types";
import { shellProcessMapAtom } from "@src/store/session/shellProcessAtom";

interface AgentSessionRowProps {
  title: string;
  isActive: boolean;
  onOpen: () => void;
  onClose: (event: React.MouseEvent) => void;
}

export const AgentSessionRow: React.FC<AgentSessionRowProps> = memo(
  ({ title, isActive, onOpen, onClose }) => {
    const { t } = useTranslation("sessions");
    const node: TreeRowNode = {
      id: title,
      name: title,
      path: title,
      type: "file",
      icon: <Terminal size={14} strokeWidth={1.75} />,
    };

    return (
      <TreeRowBase node={node} depth={0} isSelected={isActive} onClick={onOpen}>
        <Infinity
          size={14}
          strokeWidth={1.75}
          className="shrink-0 text-primary-6 group-hover/item:hidden"
        />
        <TreeRowAction
          icon={X}
          onClick={onClose}
          title={t("controlTower.sidebar.stopAgentProcess")}
          variant="danger"
        />
      </TreeRowBase>
    );
  }
);
AgentSessionRow.displayName = "TerminalSidebarAgentSessionRow";

interface PtySessionRowProps {
  session: TerminalSession;
  isActive: boolean;
  onOpen: () => void;
  onClose: (event: React.MouseEvent) => void;
}

export const PtySessionRow: React.FC<PtySessionRowProps> = memo(
  ({ session, isActive, onOpen, onClose }) => {
    const { t } = useTranslation("sessions");
    const title = getTerminalDisplayTitle(session);
    const node: TreeRowNode = {
      id: session.id,
      name: title,
      path: session.id,
      type: "file",
      icon: <Terminal size={14} strokeWidth={1.75} />,
    };

    return (
      <TreeRowBase node={node} depth={0} isSelected={isActive} onClick={onOpen}>
        <TreeRowAction
          icon={X}
          onClick={onClose}
          title={t("controlTower.sidebar.closeSession")}
          variant="danger"
        />
      </TreeRowBase>
    );
  }
);
PtySessionRow.displayName = "TerminalSidebarPtySessionRow";

export function useActiveAgentSessions() {
  const shellProcessMap = useAtomValue(shellProcessMapAtom);

  return [...shellProcessMap.entries()]
    .filter(([, processMap]) =>
      [...processMap.values()].some(
        (process) =>
          process.status === "running" || process.status === "background"
      )
    )
    .map(([sessionId, processMap]) => {
      const runningProcess = [...processMap.values()].find(
        (process) =>
          process.status === "running" || process.status === "background"
      );
      return { sessionId, command: runningProcess?.command ?? null };
    });
}

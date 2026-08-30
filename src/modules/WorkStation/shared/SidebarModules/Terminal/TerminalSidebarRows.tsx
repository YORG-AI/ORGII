import { useAtomValue } from "jotai";
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
import {
  Infinity01Icon,
  Cancel01Icon,
  ComputerTerminal01Icon,
  HugeiconsIcon,
} from "@src/icons";
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
      icon: (
        <HugeiconsIcon
          icon={ComputerTerminal01Icon}
          data-icon="terminal"
          size={14}
          strokeWidth={1.75}
        />
      ),
    };

    return (
      <TreeRowBase node={node} depth={0} isSelected={isActive} onClick={onOpen}>
        <HugeiconsIcon
          icon={Infinity01Icon}
          data-icon="infinity"
          size={14}
          strokeWidth={1.75}
          className="shrink-0 text-primary-6 group-hover/item:hidden"
        />
        <TreeRowAction
          icon={Cancel01Icon}
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
      icon: (
        <HugeiconsIcon
          icon={ComputerTerminal01Icon}
          data-icon="terminal"
          size={14}
          strokeWidth={1.75}
        />
      ),
    };

    return (
      <TreeRowBase node={node} depth={0} isSelected={isActive} onClick={onOpen}>
        <TreeRowAction
          icon={Cancel01Icon}
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

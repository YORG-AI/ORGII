/**
 * ShellSidebar Component
 *
 * Simple shell command list.
 * Note: The standalone component is no longer rendered directly.
 * Shell commands are now shown as a tab in FileSidebar.
 * This file is kept for the exported getShellStatusBadge helper.
 */
import React, { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { Placeholder } from "@src/components/Placeholder";
import { SURFACE_TOKENS } from "@src/config/surfaceTokens";
import { AGENT_DOT_TOKENS } from "@src/engines/Simulator/config";

import type { ShellOperationEntry } from "./types";

interface ShellSidebarProps {
  shellOperations: ShellOperationEntry[];
  selectedShellEventId: string | null;
  onSelectShellOperation: (eventId: string) => void;
  currentEventId: string;
}

/** Get status badge for a shell operation (exported for use by FileSidebar) */
export function getShellStatusBadge(
  operation: ShellOperationEntry
): { text: string; className: string } | null {
  if (operation.isLoading) {
    return { text: "...", className: "text-primary-6" };
  }
  if (operation.exitCode === undefined) return null;
  if (operation.exitCode === 0) {
    return { text: "✓", className: "text-success-6" };
  }
  return { text: String(operation.exitCode), className: "text-danger-6" };
}

const ShellSidebarComponent: React.FC<ShellSidebarProps> = ({
  shellOperations,
  selectedShellEventId,
  onSelectShellOperation,
  currentEventId,
}) => {
  const { t } = useTranslation("sessions");
  // Stable key: only rebuild when the actual set of operations changes
  const shellItemsKey = useMemo(
    () =>
      JSON.stringify(
        shellOperations.map((op) => ({
          eventId: op.eventId,
          commandKeywords: op.commandKeywords,
          shortCommand: op.shortCommand,
          isLoading: op.isLoading,
          exitCode: op.exitCode,
        }))
      ),
    [shellOperations]
  );

  const shellItems = useMemo(() => {
    return shellOperations.map((op) => {
      const badge = getShellStatusBadge(op);
      return {
        id: op.eventId,
        name: op.commandKeywords || op.shortCommand,
        statusBadge: badge?.text,
        statusBadgeClass: badge?.className,
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- shellItemsKey encodes every operation field rendered by this projection, preserving item identity for equivalent event arrays
  }, [shellItemsKey]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto p-2">
      {shellItems.length === 0 ? (
        <div className="flex min-h-0 min-h-full w-full flex-1 flex-col">
          <Placeholder
            variant="empty"
            placement="detail-panel"
            fillParentHeight
            title={t("simulator.replay.ide.shell.emptyNoCommands")}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-0.5">
          {shellItems.map((item) => {
            const isSelected = selectedShellEventId === item.id;
            const isAgentSelected = item.id === currentEventId;
            return (
              <div
                key={item.id}
                onClick={() => onSelectShellOperation(item.id)}
                className={`flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 transition-colors ${
                  isSelected
                    ? `${SURFACE_TOKENS.selected} text-primary-6 ${SURFACE_TOKENS.selectedHover}`
                    : `text-text-1 ${SURFACE_TOKENS.hover}`
                }`}
              >
                <div className="min-w-0 flex-1 truncate text-[13px]">
                  {item.name}
                </div>
                {item.statusBadge && (
                  <span className={`text-[12px] ${item.statusBadgeClass}`}>
                    {item.statusBadge}
                  </span>
                )}
                {isAgentSelected && (
                  <div className={AGENT_DOT_TOKENS.container}>
                    <div className={AGENT_DOT_TOKENS.dot} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export const ShellSidebar = memo(ShellSidebarComponent);
ShellSidebar.displayName = "ShellSidebar";

export default ShellSidebar;

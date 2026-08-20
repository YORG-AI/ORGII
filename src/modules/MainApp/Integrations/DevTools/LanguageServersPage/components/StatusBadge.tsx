/**
 * LspActionsCell Component
 *
 * Unified actions cell: enable/disable switch + icon-only install/uninstall.
 * Shows loading state on buttons while action is in progress;
 * detailed output is in the Settings bottom panel terminal.
 *
 * Language-server-specific status badge.
 */
import Button from "@/src/components/Button";
import Switch from "@/src/components/Switch";
import { Download, Trash2 } from "lucide-react";
import React, { memo } from "react";

import type { ActionState } from "../types";

interface LspActionsCellProps {
  installed: boolean;
  onInstall?: () => void;
  onUninstall?: () => void;
  uninstallDisabled?: boolean;
  actionState?: ActionState;
  /** Workspace enable/disable — omit to hide the switch */
  workspaceEnabled?: boolean;
  onWorkspaceToggle?: (enabled: boolean) => void;
}

export const LspActionsCell: React.FC<LspActionsCellProps> = memo(
  ({
    installed,
    onInstall,
    onUninstall,
    uninstallDisabled,
    actionState,
    workspaceEnabled,
    onWorkspaceToggle,
  }) => {
    const isBusy =
      actionState?.status === "installing" ||
      actionState?.status === "uninstalling";

    return (
      <>
        {installed && onWorkspaceToggle !== undefined && (
          <Switch
            size="small"
            checked={workspaceEnabled ?? true}
            onChange={onWorkspaceToggle}
            disabled={isBusy}
          />
        )}
        {installed ? (
          <Button
            onClick={uninstallDisabled || isBusy ? undefined : onUninstall}
            icon={<Trash2 size={14} className="text-danger-6" />}
            iconOnly
            disabled={uninstallDisabled || isBusy}
            loading={actionState?.action === "uninstall" && isBusy}
            title="Uninstall"
          />
        ) : onInstall ? (
          <Button
            onClick={isBusy ? undefined : onInstall}
            icon={<Download size={14} />}
            iconOnly
            disabled={isBusy}
            loading={actionState?.action === "install" && isBusy}
            title="Install"
          />
        ) : null}
      </>
    );
  }
);

LspActionsCell.displayName = "LspActionsCell";

/**
 * useBottomPanelActions Hook
 *
 * Returns action configurations for each tab in the bottom panel.
 */
import {
  BrushCleaning,
  CopyPlus,
  ListChevronsDownUp,
  Loader2,
  Plus,
  ScanSearch,
  Trash2,
} from "lucide-react";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { useActionSystem } from "@src/ActionSystem";
import { SPINNER_TOKENS } from "@src/config/spinnerTokens";
import { HEADER_ICON_SIZE } from "@src/modules/WorkStation/shared/tokens";
import type { BottomPanelTab } from "@src/store/ui/workStationAtom";

import type { TabAction } from "../types";

const BOTTOM_PANEL_ACTION_ICON_SIZE = HEADER_ICON_SIZE.md;

interface UseBottomPanelActionsOptions {
  activeTab: BottomPanelTab;
  // Output
  activeChannelId: string | null;
  onClearChannel: (id: string) => void;
  // Problems
  onToggleExpandAll?: () => void;
  allCollapsed?: boolean;
  /** When 0, expand/collapse toggle is hidden */
  problemsFileGroupCount?: number;
  onClearAllDiagnostics?: () => void;
  onScanWorkspace?: () => void;
  isScanning?: boolean;
}

export function useBottomPanelActions({
  activeChannelId,
  onClearChannel,
  onToggleExpandAll,
  allCollapsed,
  problemsFileGroupCount = 0,
  onClearAllDiagnostics,
  onScanWorkspace,
  isScanning,
}: UseBottomPanelActionsOptions) {
  const { t } = useTranslation();
  const { dispatch } = useActionSystem();

  // Terminal actions
  const handleNewTerminal = useCallback(() => {
    dispatch("terminal.new", {}, "user");
  }, [dispatch]);

  const handleKillTerminal = useCallback(() => {
    dispatch("terminal.close", {}, "user");
  }, [dispatch]);

  const terminalActions: TabAction[] = useMemo(
    () => [
      {
        key: "new-terminal",
        icon: <Plus size={BOTTOM_PANEL_ACTION_ICON_SIZE} />,
        tooltip: "New Terminal",
        onClick: handleNewTerminal,
      },
      {
        key: "kill-terminal",
        icon: <Trash2 size={BOTTOM_PANEL_ACTION_ICON_SIZE} />,
        tooltip: "Kill Terminal",
        onClick: handleKillTerminal,
      },
    ],
    [handleNewTerminal, handleKillTerminal]
  );

  // Output actions
  const handleClearOutput = useCallback(() => {
    if (activeChannelId) {
      onClearChannel(activeChannelId);
    }
  }, [activeChannelId, onClearChannel]);

  const outputActions: TabAction[] = useMemo(
    () => [
      {
        key: "clear-output",
        icon: <BrushCleaning size={BOTTOM_PANEL_ACTION_ICON_SIZE} />,
        tooltip: "Clear Output",
        onClick: handleClearOutput,
      },
    ],
    [handleClearOutput]
  );

  // Problems actions: toggle expand/collapse (left of scan), scan, clear
  const problemsActions: TabAction[] = useMemo(
    () => [
      ...(onToggleExpandAll && problemsFileGroupCount > 0
        ? [
            {
              key: "toggle-expand-problems",
              icon:
                allCollapsed === true ? (
                  <CopyPlus size={BOTTOM_PANEL_ACTION_ICON_SIZE} />
                ) : (
                  <ListChevronsDownUp size={BOTTOM_PANEL_ACTION_ICON_SIZE} />
                ),
              tooltip:
                allCollapsed === true
                  ? t("common:actions.expandAll")
                  : t("common:actions.collapseAll"),
              onClick: onToggleExpandAll,
            },
          ]
        : []),
      ...(onScanWorkspace
        ? [
            {
              key: "scan-workspace",
              icon: isScanning ? (
                <Loader2
                  size={SPINNER_TOKENS.default}
                  className="animate-spin"
                />
              ) : (
                <ScanSearch size={BOTTOM_PANEL_ACTION_ICON_SIZE} />
              ),
              tooltip: isScanning
                ? t("common:actions.stop")
                : t("common:status.startScan"),
              onClick: onScanWorkspace,
            },
          ]
        : []),
      ...(onClearAllDiagnostics
        ? [
            {
              key: "clear-all-diagnostics",
              icon: <BrushCleaning size={BOTTOM_PANEL_ACTION_ICON_SIZE} />,
              tooltip: "Clear All",
              onClick: onClearAllDiagnostics,
            },
          ]
        : []),
    ],
    [
      t,
      onToggleExpandAll,
      allCollapsed,
      problemsFileGroupCount,
      onScanWorkspace,
      isScanning,
      onClearAllDiagnostics,
    ]
  );

  // Test results actions (currently empty)
  const testResultsActions: TabAction[] = useMemo(() => [], []);

  return {
    terminalActions,
    outputActions,
    problemsActions,
    testResultsActions,
  };
}

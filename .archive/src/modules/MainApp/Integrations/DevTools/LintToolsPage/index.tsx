/**
 * Lint Tools Page
 *
 * Embedded list of lint & format tools. Selecting a row toggles the
 * table's inline expanded card; install / uninstall / workspace-enable
 * actions live inside that card.
 */
import { useAtomValue } from "jotai";
import React, { useMemo } from "react";

import { useLintTools } from "@src/modules/MainApp/Integrations/hooks/lsp";
import { TerminalService } from "@src/services/terminal/TerminalService";
import { activeWorkspaceRootPathAtom } from "@src/store/workspace";

import type { LintHandlers } from "./Table/LintToolInlineExpandedCard";
import LintToolsTable from "./Table/LintToolsTable";

const LintToolsPage: React.FC = () => {
  const workspacePath = useAtomValue(activeWorkspaceRootPathAtom) || null;
  const executeInTerminal = TerminalService.execute;

  const {
    lintTools,
    isLoading,
    getActionState,
    handleInstall,
    handleUninstall,
    handleWorkspaceToggle,
    isToolEnabled,
  } = useLintTools({ workspacePath, executeInTerminal });

  const lintHandlers: LintHandlers = useMemo(
    () => ({
      handleInstall,
      handleUninstall,
      handleWorkspaceToggle,
      getActionState,
      isToolEnabled,
    }),
    [
      getActionState,
      handleInstall,
      handleUninstall,
      handleWorkspaceToggle,
      isToolEnabled,
    ]
  );

  return (
    <LintToolsTable
      lintTools={lintTools}
      loading={isLoading}
      workspacePath={workspacePath}
      lintHandlers={lintHandlers}
    />
  );
};

export default LintToolsPage;

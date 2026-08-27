/**
 * Hook for managing lint tools.
 * Thin adapter over useDevToolManager — binds linter-specific Tauri invoke names.
 *
 * State keys are prefixed with "lint_" to avoid potential collisions with LSP
 * language IDs if both hooks ever appear in the same component tree.
 */
import type {
  ActionState,
  LintToolInfo,
  WorkspaceLintConfig,
} from "@src/modules/MainApp/Integrations/DevTools/LanguageServersPage/types";

import { useDevToolManager } from "./useDevToolManager";

export interface UseLintToolsOptions {
  workspacePath: string | null;
  executeInTerminal?: (command: string) => Promise<void>;
}

const LINT_INVOKES = {
  getCached: "lint_get_cached",
  checkInstalled: "lint_check_installed",
  getWorkspaceConfig: "lint_get_workspace_config",
  setItemEnabled: "lint_set_tool_enabled",
  getInstallCommand: "lint_get_install_command",
  getUninstallCommand: "lint_get_uninstall_command",
} as const;

export function useLintTools(options: UseLintToolsOptions) {
  const {
    items: lintTools,
    isLoading,
    isRefreshing,
    workspaceConfig,
    getActionState: getRawActionState,
    handleInstall,
    handleUninstall,
    handleWorkspaceToggle,
    isItemEnabled,
    clearActionState: clearRawActionState,
    refresh,
  } = useDevToolManager<LintToolInfo>({
    workspacePath: options.workspacePath,
    executeInTerminal: options.executeInTerminal,
    invokeNames: LINT_INVOKES,
    itemParamName: "toolId",
    stateKeyPrefix: "lint_",
  });

  return {
    lintTools,
    isLoading,
    isRefreshing,
    workspaceConfig: workspaceConfig as WorkspaceLintConfig | null,
    getActionState: (toolId: string): ActionState => getRawActionState(toolId),
    handleInstall,
    handleUninstall,
    handleWorkspaceToggle,
    isToolEnabled: isItemEnabled,
    clearActionState: (toolId: string) => clearRawActionState(toolId),
    refresh,
  };
}

/**
 * Hook for managing language servers.
 * Thin adapter over useDevToolManager — binds LSP-specific Tauri invoke names.
 */
import type {
  ActionState,
  LanguageServerInfo,
  WorkspaceLspConfig,
} from "@src/modules/MainApp/Integrations/DevTools/LanguageServersPage/types";

import { useDevToolManager } from "./useDevToolManager";

export interface UseLanguageServersOptions {
  workspacePath: string | null;
  executeInTerminal?: (command: string) => Promise<void>;
}

const LSP_INVOKES = {
  getCached: "lsp_get_cached",
  checkInstalled: "lsp_check_installed",
  getWorkspaceConfig: "lsp_get_workspace_config",
  setItemEnabled: "lsp_set_server_enabled",
  getInstallCommand: "lsp_get_install_command",
  getUninstallCommand: "lsp_get_uninstall_command",
} as const;

export function useLanguageServers(options: UseLanguageServersOptions) {
  const {
    items: servers,
    isLoading,
    isRefreshing,
    workspaceConfig,
    getActionState,
    handleInstall,
    handleUninstall,
    handleWorkspaceToggle,
    isItemEnabled,
    clearActionState,
    refresh,
  } = useDevToolManager<LanguageServerInfo>({
    workspacePath: options.workspacePath,
    executeInTerminal: options.executeInTerminal,
    invokeNames: LSP_INVOKES,
    itemParamName: "language",
  });

  return {
    servers,
    isLoading,
    isRefreshing,
    workspaceConfig: workspaceConfig as WorkspaceLspConfig | null,
    getActionState: (language: string): ActionState => getActionState(language),
    handleInstall,
    handleUninstall,
    handleWorkspaceToggle,
    isServerEnabled: isItemEnabled,
    clearActionState,
    refresh,
  };
}

/**
 * useLspGlobalConfig
 *
 * Reads the global LSP configuration on mount and exposes the auto-install
 * toggle setter. The Rust commands `lsp_set_global_config`,
 * `lsp_set_server_enabled_global`, and `lsp_reload_global_config` are still
 * registered for future use but are not surfaced here yet — wire them when
 * the corresponding UI lands.
 */
import { invoke } from "@tauri-apps/api/core";
import { useCallback } from "react";

import { useAsyncResource } from "@src/hooks/async";
import { createLogger } from "@src/hooks/logger";

const log = createLogger("useLspGlobalConfig");

interface ServerOverrideWire {
  enabled: boolean;
  binaryPath?: string;
  args?: string[];
  env: Record<string, string>;
  initOptions?: unknown;
}

interface CustomServerDefWire {
  id: string;
  displayName: string;
  extensions: string[];
  languageIds: string[];
  binary: string;
  args: string[];
  env: Record<string, string>;
  rootMarkers: string[];
  initOptions?: unknown;
}

interface GlobalLspConfig {
  autoInstall: boolean;
  servers: Record<string, ServerOverrideWire>;
  customServers: CustomServerDefWire[];
}

const DEFAULT_CONFIG: GlobalLspConfig = {
  autoInstall: true,
  servers: {},
  customServers: [],
};

export function useLspGlobalConfig() {
  const loadConfig = useCallback(async () => {
    try {
      return await invoke<GlobalLspConfig>("lsp_get_global_config");
    } catch (err) {
      log.error("[useLspGlobalConfig] Failed to load config:", err);
      throw err;
    }
  }, []);
  const configResource = useAsyncResource({
    fetcher: loadConfig,
    initialData: DEFAULT_CONFIG,
    scopeKey: "lsp-global-config",
  });
  const setConfig = configResource.setData;

  const setAutoInstall = useCallback(
    async (enabled: boolean) => {
      try {
        await invoke("lsp_set_auto_install", { enabled });
        setConfig((prev) => ({ ...prev, autoInstall: enabled }));
      } catch (err) {
        log.error("[useLspGlobalConfig] Failed to set auto-install:", err);
        throw err;
      }
    },
    [setConfig]
  );

  return {
    config: configResource.data,
    isLoading: configResource.loading,
    error: configResource.error,
    setAutoInstall,
  };
}

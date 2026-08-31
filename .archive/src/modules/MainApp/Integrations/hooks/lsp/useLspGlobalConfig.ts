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
import { useCallback, useEffect, useState } from "react";

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
  const [config, setConfig] = useState<GlobalLspConfig>(DEFAULT_CONFIG);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadConfig = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await invoke<GlobalLspConfig>("lsp_get_global_config");
      setConfig(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      log.error("[useLspGlobalConfig] Failed to load config:", err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  const setAutoInstall = useCallback(async (enabled: boolean) => {
    try {
      await invoke("lsp_set_auto_install", { enabled });
      setConfig((prev) => ({ ...prev, autoInstall: enabled }));
    } catch (err) {
      log.error("[useLspGlobalConfig] Failed to set auto-install:", err);
      throw err;
    }
  }, []);

  return {
    config,
    isLoading,
    error,
    setAutoInstall,
  };
}

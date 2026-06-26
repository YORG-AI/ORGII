/**
 * Provider Config Hook
 *
 * Fetches provider configuration from Rust backend (single source of truth).
 * Caches configs in memory for the session duration.
 */
import { useEffect, useState } from "react";

import { rpc } from "@src/api/tauri/rpc";
import type {
  ProviderConfig,
  ProviderProtocol,
} from "@src/api/tauri/rpc/schemas/validation";
import type { ModelType } from "@src/api/types/keys";

// ============================================
// Cache
// ============================================

let configCache: Record<string, ProviderConfig> | null = null;
let loadingPromise: Promise<Record<string, ProviderConfig>> | null = null;

async function loadAllConfigs(): Promise<Record<string, ProviderConfig>> {
  if (configCache) return configCache;
  if (loadingPromise) return loadingPromise;

  loadingPromise = rpc.validation.getAllProviderConfigs().then((result) => {
    configCache = result;
    loadingPromise = null;
    return result;
  });

  return loadingPromise;
}

// ============================================
// Types
// ============================================

export interface ProviderEnvConfig {
  /** Env var name for API key */
  apiKeyEnvVar: string;
  /** Env var name for base URL */
  baseUrlEnvVar: string | null;
  /** Whether this provider supports custom base URL */
  supportsBaseUrl: boolean;
  /** Default base URL for API calls */
  defaultBaseUrl: string | null;
  supportedProtocols: ProviderProtocol[];
  defaultProtocol: ProviderProtocol;
}

// ============================================
// Hook
// ============================================

export function useProviderConfig(modelType: ModelType | undefined): {
  config: ProviderEnvConfig | null;
  loading: boolean;
  error: string | null;
} {
  const [allConfigs, setAllConfigs] = useState<Record<
    string,
    ProviderConfig
  > | null>(configCache);
  const [loading, setLoading] = useState(!configCache);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Already have cached data - no need to fetch
    if (configCache) return;

    let cancelled = false;
    loadAllConfigs()
      .then((result) => {
        if (!cancelled) {
          setAllConfigs(result);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (!modelType || loading) {
    return { config: null, loading, error };
  }

  if (!allConfigs) {
    return {
      config: null,
      loading: false,
      error: error || "Config not loaded",
    };
  }

  const rustConfig = allConfigs[modelType];
  if (!rustConfig) {
    // Fallback for unknown providers
    return {
      config: {
        apiKeyEnvVar: "API_KEY",
        baseUrlEnvVar: null,
        supportsBaseUrl: false,
        defaultBaseUrl: null,
        supportedProtocols: ["openai"],
        defaultProtocol: "openai",
      },
      loading: false,
      error: null,
    };
  }

  return {
    config: {
      apiKeyEnvVar: rustConfig.api_key_env_var,
      baseUrlEnvVar: rustConfig.base_url_env_var,
      supportsBaseUrl: rustConfig.supports_base_url,
      defaultBaseUrl: rustConfig.default_base_url,
      supportedProtocols: rustConfig.supported_protocols,
      defaultProtocol: rustConfig.default_protocol,
    },
    loading: false,
    error: null,
  };
}

// ============================================
// Preload Helper
// ============================================

/** Preload all provider configs into cache. Call early in app startup. */
export function preloadProviderConfigs(): Promise<void> {
  return loadAllConfigs().then(() => undefined);
}

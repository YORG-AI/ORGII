/**
 * useSessionDiscovery Hook
 *
 * Provides provider and agent discovery data for session creation.
 * Sources data from `get_available_api_providers`, `get_available_agents`,
 * and `list_keys` (for per-key model lists), then maps to the ProviderInfo /
 * AgentInfo shapes consumed by the rest of the frontend.
 *
 * Also populates `agentRegistryAtom` as a side-effect so that
 * useAgentCompatibility() stays in sync.
 */
import { useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AgentInfo, ProviderInfo } from "@src/api/http/config";
import { loadAvailableAgents } from "@src/api/services/availableAgents";
import { rpc } from "@src/api/tauri/rpc";
import type {
  AvailableAgent,
  AvailableApiProvider,
  KeyInfo,
} from "@src/api/tauri/rpc/schemas/validation";
import { loadSharedLocalKeys } from "@src/hooks/keyVault/sharedLocalKeyStore";
import { createLogger } from "@src/hooks/logger";
import { agentRegistryAtom } from "@src/store/session/agentRegistryAtom";

const log = createLogger("useSessionDiscovery");

// ============================================
// Type Definitions
// ============================================

export interface UseSessionDiscoveryOptions {
  /** Whether to load data automatically on mount */
  autoLoad?: boolean;
  /** Callback function called on successful data load */
  onSuccess?: (data: {
    providers: ProviderInfo[];
    agents: AgentInfo[];
  }) => void;
  /** Callback function called on error */
  onError?: (error: Error) => void;
}

export interface UseSessionDiscoveryReturn {
  /** Available providers with their models */
  providers: ProviderInfo[];
  /** Available agents */
  agents: AgentInfo[];
  /** Available agents only (filtered) */
  availableAgents: AgentInfo[];
  /** Loading state indicator */
  loading: boolean;
  /** Error message if any */
  error: string | null;
  /** Refresh data manually */
  refresh: () => Promise<void>;
  /** Get models for a specific provider */
  getModelsForProvider: (providerName: string) => ProviderInfo["models"];
  /** Check if a provider is available */
  isProviderAvailable: (providerName: string) => boolean;
  /** Check if an agent is available */
  isAgentAvailable: (agentName: string) => boolean;
}

// ============================================
// Mapping helpers
// ============================================

/**
 * Build ProviderInfo[] by merging API provider metadata with per-key model
 * lists from the key store.  This replicates the old `get_available_providers`
 * Rust command entirely on the frontend.
 */
function buildProviderInfoList(
  apiProviders: AvailableApiProvider[],
  allKeys: KeyInfo[]
): ProviderInfo[] {
  // Group models by agent_type from keys (same logic as old Rust endpoint)
  const modelsByType = new Map<string, string[]>();
  for (const key of allKeys) {
    const models = key.available_models ?? [];
    if (models.length === 0) continue;
    const existing = modelsByType.get(key.agent_type) ?? [];
    for (const model of models) {
      if (!existing.includes(model)) {
        existing.push(model);
      }
    }
    modelsByType.set(key.agent_type, existing);
  }

  // Build per-key providers (covers CLI agents with their own keys)
  const providerMap = new Map<string, ProviderInfo>();

  for (const key of allKeys) {
    if (providerMap.has(key.agent_type)) continue;
    const models = modelsByType.get(key.agent_type) ?? [];
    providerMap.set(key.agent_type, {
      provider_name: key.agent_type,
      display_name: key.name ?? key.agent_type,
      is_custom: false,
      has_api_key: key.has_api_key ?? false,
      models: models.map((modelId) => ({
        id: modelId,
        display_name: modelId,
        max_context_tokens: 128000,
      })),
      default_model: models[0] ?? "",
    });
  }

  // Merge API provider metadata for providers that don't have keys yet
  for (const provider of apiProviders) {
    if (providerMap.has(provider.name)) {
      // Provider already in map from keys — update display_name and has_api_key
      const existing = providerMap.get(provider.name)!;
      existing.display_name = provider.displayName;
      existing.has_api_key = existing.has_api_key || provider.hasKeys;
      continue;
    }
    if (!provider.hasKeys) continue;
    providerMap.set(provider.name, {
      provider_name: provider.name,
      display_name: provider.displayName,
      is_custom: false,
      has_api_key: provider.hasKeys,
      models: [],
      default_model: "",
    });
  }

  return Array.from(providerMap.values());
}

function mapAgents(agents: AvailableAgent[]): AgentInfo[] {
  return agents.map((agent) => ({
    name: agent.name,
    display_name: agent.displayName,
    description: agent.description,
    available: agent.installed && agent.hasKeys,
    status: agent.installed ? "available" : "not_installed",
  }));
}

// ============================================
// Hook Implementation
// ============================================

export function useSessionDiscovery(
  options: UseSessionDiscoveryOptions = {}
): UseSessionDiscoveryReturn {
  const { autoLoad = true, onSuccess, onError } = options;

  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasLoadedRef = useRef(false);
  const mountedRef = useRef(true);

  const setAgentRegistry = useSetAtom(agentRegistryAtom);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const availableAgents = useMemo(
    () => agents.filter((agent) => agent.available),
    [agents]
  );

  // ============================================
  // Helper Functions
  // ============================================

  const getModelsForProvider = useCallback(
    (providerName: string) => {
      const provider = providers.find((p) => p.provider_name === providerName);
      return provider?.models ?? [];
    },
    [providers]
  );

  const isProviderAvailable = useCallback(
    (providerName: string) => {
      const provider = providers.find((p) => p.provider_name === providerName);
      return provider?.has_api_key ?? false;
    },
    [providers]
  );

  const isAgentAvailable = useCallback(
    (agentName: string) => {
      const agent = agents.find((a) => a.name === agentName);
      return agent?.available ?? false;
    },
    [agents]
  );

  // ============================================
  // Refresh
  // ============================================

  const refresh = useCallback(async () => {
    if (!mountedRef.current) return;
    setLoading(true);
    setError(null);

    try {
      const [apiProviders, rawAgents, allKeys] = await Promise.all([
        rpc.validation.getAvailableApiProviders(),
        loadAvailableAgents(),
        loadSharedLocalKeys(),
      ]);

      if (!mountedRef.current) return;

      // Populate agentRegistryAtom so useAgentCompatibility stays current
      setAgentRegistry({ agents: rawAgents, apiProviders });

      const mappedProviders = buildProviderInfoList(apiProviders, allKeys);
      const mappedAgents = mapAgents(rawAgents);

      setProviders(mappedProviders);
      setAgents(mappedAgents);

      onSuccess?.({ providers: mappedProviders, agents: mappedAgents });
    } catch (err) {
      if (!mountedRef.current) return;
      const errorMessage =
        err instanceof Error ? err.message : "Failed to load session data";
      log.error("[useSessionDiscovery] Refresh failed:", err);
      setError(errorMessage);
      onError?.(err as Error);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [onSuccess, onError, setAgentRegistry]);

  // ============================================
  // Effects
  // ============================================

  useEffect(() => {
    if (autoLoad && !hasLoadedRef.current) {
      hasLoadedRef.current = true;
      refresh();
    }
  }, [autoLoad, refresh]);

  // ============================================
  // Return
  // ============================================

  return {
    providers,
    agents,
    availableAgents,
    loading,
    error,
    refresh,
    getModelsForProvider,
    isProviderAvailable,
    isAgentAvailable,
  };
}

export default useSessionDiscovery;

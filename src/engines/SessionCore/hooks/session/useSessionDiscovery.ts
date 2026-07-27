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
import { useCallback, useEffect, useMemo, useRef } from "react";

import type { AgentInfo, ProviderInfo } from "@src/api/http/config";
import { rpc } from "@src/api/tauri/rpc";
import type {
  AvailableAgent,
  AvailableApiProvider,
  KeyInfo,
} from "@src/api/tauri/rpc/schemas/validation";
import {
  type AsyncResourceFetchContext,
  useAsyncResource,
} from "@src/hooks/async";
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

interface SessionDiscoveryData {
  apiProviders: AvailableApiProvider[];
  mappedAgents: AgentInfo[];
  providers: ProviderInfo[];
  rawAgents: AvailableAgent[];
}

const EMPTY_SESSION_DISCOVERY: SessionDiscoveryData = {
  apiProviders: [],
  mappedAgents: [],
  providers: [],
  rawAgents: [],
};

let discoveryInFlight: Promise<SessionDiscoveryData> | null = null;

function loadSessionDiscovery(force: boolean): Promise<SessionDiscoveryData> {
  if (!force && discoveryInFlight) return discoveryInFlight;

  const promise = Promise.all([
    rpc.validation.getAvailableApiProviders(),
    rpc.validation.getAvailableAgents(),
    loadSharedLocalKeys(force),
  ]).then(([apiProviders, rawAgents, allKeys]) => ({
    apiProviders,
    mappedAgents: mapAgents(rawAgents),
    providers: buildProviderInfoList(apiProviders, allKeys),
    rawAgents,
  }));
  discoveryInFlight = promise;
  void promise.then(
    () => {
      if (discoveryInFlight === promise) discoveryInFlight = null;
    },
    () => {
      if (discoveryInFlight === promise) discoveryInFlight = null;
    }
  );
  return promise;
}

// ============================================
// Hook Implementation
// ============================================

export function useSessionDiscovery(
  options: UseSessionDiscoveryOptions = {}
): UseSessionDiscoveryReturn {
  const { autoLoad = true, onSuccess, onError } = options;
  const setAgentRegistry = useSetAtom(agentRegistryAtom);
  const callbacksRef = useRef({ onError, onSuccess });
  useEffect(() => {
    callbacksRef.current = { onError, onSuccess };
  }, [onError, onSuccess]);

  const fetchDiscovery = useCallback(
    async (
      _scopeKey: string,
      context: AsyncResourceFetchContext<SessionDiscoveryData>
    ) => {
      try {
        const data = await loadSessionDiscovery(context.cause === "refresh");
        callbacksRef.current.onSuccess?.({
          agents: data.mappedAgents,
          providers: data.providers,
        });
        return data;
      } catch (error) {
        const normalizedError =
          error instanceof Error
            ? error
            : new Error("Failed to load session data");
        log.error("[useSessionDiscovery] Refresh failed:", error);
        callbacksRef.current.onError?.(normalizedError);
        throw normalizedError;
      }
    },
    []
  );
  const resource = useAsyncResource({
    autoLoad,
    fetcher: fetchDiscovery,
    initialData: EMPTY_SESSION_DISCOVERY,
    scopeKey: "session-discovery",
  });
  const providers = resource.data.providers;
  const agents = resource.data.mappedAgents;

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

  useEffect(() => {
    if (resource.status === "ready") {
      setAgentRegistry({
        agents: resource.data.rawAgents,
        apiProviders: resource.data.apiProviders,
      });
    }
  }, [resource.data, resource.status, setAgentRegistry]);

  // ============================================
  // Return
  // ============================================

  return {
    providers,
    agents,
    availableAgents,
    loading: resource.loading,
    error: resource.error,
    refresh: resource.refresh,
    getModelsForProvider,
    isProviderAvailable,
    isAgentAvailable,
  };
}

export default useSessionDiscovery;

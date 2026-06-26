/**
 * Provider Registry Hook
 *
 * Fetches CLI agents and API providers from Rust backend (single source of truth).
 * Combines them into a unified provider grid for KeyVault wizard.
 */
import { useSetAtom } from "jotai";
import { useEffect, useMemo, useState } from "react";

import { rpc } from "@src/api/tauri/rpc";
import type {
  AvailableAgent,
  AvailableApiProvider,
  ProviderProtocol,
} from "@src/api/tauri/rpc/schemas/validation";
import { agentRegistryAtom } from "@src/store/session/agentRegistryAtom";

// ============================================
// Primary Providers (region-restricted, major platforms)
// ============================================

/**
 * Primary providers are major AI platforms with documented region restrictions.
 * Used to filter the provider grid in the Add Account wizard.
 *
 * Includes:
 * - Cursor (cursor_cli)
 * - OpenAI (openai_api + codex, single brand tile)
 * - Anthropic (anthropic_api, claude_code)
 * - Google (gemini_api, gemini_cli)
 * - OpenRouter (openrouter_api) — gateway supporting many models
 * - DeepSeek (deepseek_api) — popular alternative
 * - Groq (groq_api) — fast inference
 * - xAI Grok (xai_api) — Grok API
 */
const PRIMARY_PROVIDER_KEYS = new Set([
  // CLI agents
  "cursor_cli",
  "claude_code",
  "codex", // OpenAI brand variant
  "gemini_cli",
  "copilot",
  "kiro",
  "kimi_cli",
  // API providers
  "openai_api",
  "anthropic_api",
  "gemini_api",
  "openrouter_api",
  "zenmux_api",
  "vllm_api",
  "deepseek_api",
  "groq_api",
  "xai_api",
  "moonshot_api",
  "minimax_api",
]);

/**
 * Check if a provider/agent is a primary provider.
 */
export function isPrimaryProvider(providerKey: string): boolean {
  return PRIMARY_PROVIDER_KEYS.has(providerKey);
}

// ============================================
// Cache
// ============================================

interface RegistryCache {
  agents: AvailableAgent[];
  apiProviders: AvailableApiProvider[];
}

let registryCache: RegistryCache | null = null;
let loadingPromise: Promise<RegistryCache> | null = null;

async function loadRegistry(): Promise<RegistryCache> {
  if (registryCache) return registryCache;
  if (loadingPromise) return loadingPromise;

  loadingPromise = Promise.all([
    rpc.validation.getAvailableAgents(),
    rpc.validation.getAvailableApiProviders(),
  ]).then(([agents, apiProviders]) => {
    registryCache = { agents, apiProviders };
    loadingPromise = null;
    return registryCache;
  });

  return loadingPromise;
}

// ============================================
// Unified Provider Types
// ============================================

export interface UnifiedProviderVariant {
  /** Model type identifier (e.g., "openai_api", "codex") — matches `ModelType` */
  modelType: string;
  /** Display label (e.g., "API Key", "Codex Plan") */
  label: string;
  /** "api_key" for direct API providers, "cli" for CLI agents */
  mode: "api_key" | "cli";
  /** Environment variable for API key */
  apiKeyEnvVar: string;
  /** Whether this variant supports custom base URL */
  supportsBaseUrl: boolean;
  /** Default base URL (if any) */
  defaultBaseUrl?: string;
  supportedProtocols: ProviderProtocol[];
  defaultProtocol: ProviderProtocol;
}

export interface UnifiedProvider {
  /** Unique key for this brand (e.g., "openai", "anthropic") */
  key: string;
  /** Brand display name (e.g., "OpenAI", "Anthropic") */
  label: string;
  /** Icon provider key for ModelIcon lookup */
  iconProvider: string;
  /** Brand color (hex) */
  brandColor: string;
  /** Available variants (API + CLI if paired) */
  variants: UnifiedProviderVariant[];
  /** Whether this is a popular/featured provider */
  popular: boolean;
  /** Short description */
  description: string;
  /** Documentation URL */
  docsUrl?: string;
}

// ============================================
// Hook
// ============================================

export interface UseProviderRegistryOptions {
  /** Only include primary providers (Cursor, OpenAI, Anthropic, Google, OpenRouter, etc.) */
  primaryOnly?: boolean;
}

export interface UseProviderRegistryResult {
  /** All available CLI agents (raw from Rust) */
  agents: AvailableAgent[];
  /** All available API providers (raw from Rust) */
  apiProviders: AvailableApiProvider[];
  /** Unified provider grid (CLI + API combined by brand) */
  unifiedProviders: UnifiedProvider[];
  /** Lookup: modelType → unified provider key */
  modelTypeToProviderKey: Record<string, string>;
  loading: boolean;
  error: string | null;
  /** Reload the registry (clears cache) */
  reload: () => Promise<void>;
}

function buildUnifiedProviders(
  agents: AvailableAgent[],
  apiProviders: AvailableApiProvider[]
): UnifiedProvider[] {
  const providers: UnifiedProvider[] = [];
  const usedAgents = new Set<string>();
  const usedApiProviders = new Set<string>();

  // First pass: Build paired providers (API + CLI share same brand)
  for (const api of apiProviders) {
    if (api.pairedCliAgent) {
      const cli = agents.find((agent) => agent.name === api.pairedCliAgent);
      if (cli) {
        usedAgents.add(cli.name);
        usedApiProviders.add(api.name);

        const isOpenAiBrand = api.name === "openai_api";
        const variants: UnifiedProviderVariant[] = [
          {
            modelType: api.name,
            label: "API Key",
            mode: "api_key",
            apiKeyEnvVar: api.apiKeyEnvVar,
            supportsBaseUrl: api.supportsBaseUrl,
            defaultBaseUrl: api.defaultBaseUrl,
            supportedProtocols: api.supportedProtocols,
            defaultProtocol: api.defaultProtocol,
          },
          {
            modelType: cli.name,
            label: isOpenAiBrand ? "Codex" : `${cli.displayName} Plan`,
            mode: "cli",
            apiKeyEnvVar: cli.envConfig?.apiKeyEnvVar ?? "",
            supportsBaseUrl: cli.envConfig?.supportsBaseUrl ?? false,
            defaultBaseUrl: undefined,
            supportedProtocols: ["openai"],
            defaultProtocol: "openai",
          },
        ];

        // Use API provider's brand info (it's the canonical brand)
        providers.push({
          key: api.name.replace(/_api$/, ""),
          label: api.displayName,
          iconProvider: api.iconProvider,
          brandColor: api.brandColor,
          variants,
          popular: api.popular || cli.popular,
          description: api.description,
          docsUrl: api.docsUrl,
        });
      }
    }
  }

  // Second pass: Add standalone API providers
  for (const api of apiProviders) {
    if (usedApiProviders.has(api.name)) continue;

    providers.push({
      key: api.name,
      label: api.displayName,
      iconProvider: api.iconProvider,
      brandColor: api.brandColor,
      variants: [
        {
          modelType: api.name,
          label: "API Key",
          mode: "api_key",
          apiKeyEnvVar: api.apiKeyEnvVar,
          supportsBaseUrl: api.supportsBaseUrl,
          defaultBaseUrl: api.defaultBaseUrl,
          supportedProtocols: api.supportedProtocols,
          defaultProtocol: api.defaultProtocol,
        },
      ],
      popular: api.popular,
      description: api.description,
      docsUrl: api.docsUrl,
    });
  }

  // Third pass: Add standalone CLI agents
  for (const cli of agents) {
    if (usedAgents.has(cli.name)) continue;

    providers.push({
      key: cli.name,
      label: cli.displayName,
      iconProvider: cli.iconProvider,
      brandColor: cli.brandColor,
      variants: [
        {
          modelType: cli.name,
          label: `${cli.displayName} Subscription`,
          mode: "cli",
          apiKeyEnvVar: cli.envConfig?.apiKeyEnvVar ?? "",
          supportsBaseUrl: cli.envConfig?.supportsBaseUrl ?? false,
          supportedProtocols: ["openai"],
          defaultProtocol: "openai",
        },
      ],
      popular: cli.popular,
      description: cli.description,
      docsUrl: cli.docsUrl,
    });
  }

  // Sort: popular first, then alphabetically
  return providers.sort((a, b) => {
    if (a.popular !== b.popular) return a.popular ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
}

function buildModelTypeToProviderKey(
  providers: UnifiedProvider[]
): Record<string, string> {
  const lookup: Record<string, string> = {};
  for (const provider of providers) {
    for (const variant of provider.variants) {
      lookup[variant.modelType] = provider.key;
    }
  }
  return lookup;
}

/**
 * Filter unified providers to only include primary providers.
 * A provider is primary if any of its variants are in the PRIMARY_PROVIDER_KEYS set.
 */
function filterPrimaryProviders(
  providers: UnifiedProvider[]
): UnifiedProvider[] {
  return providers.filter((provider) =>
    provider.variants.some((variant) => isPrimaryProvider(variant.modelType))
  );
}

export function useProviderRegistry(
  options: UseProviderRegistryOptions = {}
): UseProviderRegistryResult {
  const { primaryOnly = false } = options;
  const [data, setData] = useState<RegistryCache | null>(registryCache);
  const [loading, setLoading] = useState(!registryCache);
  const [error, setError] = useState<string | null>(null);
  const setAgentRegistry = useSetAtom(agentRegistryAtom);

  useEffect(() => {
    if (registryCache) {
      setAgentRegistry(registryCache);
      return;
    }

    let cancelled = false;
    loadRegistry()
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setAgentRegistry(result);
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
  }, [setAgentRegistry]);

  const reload = async () => {
    registryCache = null;
    loadingPromise = null;
    setLoading(true);
    setError(null);
    try {
      const result = await loadRegistry();
      setData(result);
      setAgentRegistry(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const unifiedProviders = useMemo(() => {
    if (!data) return [];
    const all = buildUnifiedProviders(data.agents, data.apiProviders);
    return primaryOnly ? filterPrimaryProviders(all) : all;
  }, [data, primaryOnly]);

  const modelTypeToProviderKey = useMemo(
    () => buildModelTypeToProviderKey(unifiedProviders),
    [unifiedProviders]
  );

  if (!data) {
    return {
      agents: [],
      apiProviders: [],
      unifiedProviders: [],
      modelTypeToProviderKey: {},
      loading,
      error,
      reload,
    };
  }

  return {
    agents: data.agents,
    apiProviders: data.apiProviders,
    unifiedProviders,
    modelTypeToProviderKey,
    loading,
    error,
    reload,
  };
}

// ============================================
// Preload Helper
// ============================================

/** Preload provider registry into cache. Call early in app startup. */
export function preloadProviderRegistry(): Promise<void> {
  return loadRegistry().then(() => undefined);
}

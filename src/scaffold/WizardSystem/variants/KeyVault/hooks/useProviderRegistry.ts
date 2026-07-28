/**
 * Provider Registry Hook
 *
 * Fetches CLI agents and API providers from Rust backend (single source of truth).
 * Combines them into a unified provider grid for KeyVault wizard.
 */
import type { TFunction } from "i18next";
import { useSetAtom } from "jotai";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { loadAvailableAgents } from "@src/api/services/availableAgents";
import { rpc } from "@src/api/tauri/rpc";
import type {
  AvailableAgent,
  AvailableApiProvider,
  ProviderProtocol,
} from "@src/api/tauri/rpc/schemas/validation";
import { LOCAL_MODEL_PROVIDER } from "@src/api/types/keys";
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
 * - Google (gemini_api)
 * - OpenRouter (openrouter_api) — gateway supporting many models
 * - DeepSeek (deepseek_api) — popular alternative
 * - Groq (groq_api) — fast inference
 * - xAI Grok (xai_api) — Grok API
 */
const LOCAL_PROVIDER_GROUP = "local" as const;
const CLOUD_PROVIDER_GROUP = "cloud" as const;

export type ProviderGroup =
  | typeof CLOUD_PROVIDER_GROUP
  | typeof LOCAL_PROVIDER_GROUP;

export type LocalRuntimePreset =
  | "ollama"
  | "lm_studio"
  | "vllm"
  | "llamacpp"
  | "custom";

const LOCAL_PROVIDER_KEYS = {
  OLLAMA: "local_ollama",
  LM_STUDIO: "local_lm_studio",
  VLLM: "local_vllm",
  LLAMACPP: "local_llamacpp",
  CUSTOM: "local_custom",
} as const;

/**
 * The cloud counterpart of the local "Custom" tile: it has no brand, so it
 * borrows that tile's cog glyph and label, and sorts after the named brands.
 */
const CUSTOM_GATEWAY_PROVIDER_KEY = "custom_api";

/** Both Custom tiles — cloud gateway and local endpoint — share one label. */
const CUSTOM_PROVIDER_LABEL_KEY = "wizard.providerCustom";

const LOCAL_RUNTIME_LABELS: Record<LocalRuntimePreset, string> = {
  ollama: "Ollama",
  lm_studio: "LM Studio",
  vllm: "vLLM",
  llamacpp: "llama.cpp",
  custom: "Custom",
};

const LOCAL_PROVIDER_DEFINITIONS: Array<{
  key: string;
  label: string;
  /** i18n key for brand-less names. Brand names are left untranslated. */
  labelKey?: string;
  runtime: LocalRuntimePreset;
  iconProvider: string;
  iconElement?: "cog";
  description: string;
}> = [
  {
    key: LOCAL_PROVIDER_KEYS.OLLAMA,
    label: LOCAL_RUNTIME_LABELS.ollama,
    runtime: "ollama",
    iconProvider: "ollama",
    description: "Default local Ollama endpoint",
  },
  {
    key: LOCAL_PROVIDER_KEYS.LM_STUDIO,
    label: LOCAL_RUNTIME_LABELS.lm_studio,
    runtime: "lm_studio",
    iconProvider: "lm_studio",
    description: "Local LM Studio OpenAI-compatible server",
  },
  {
    key: LOCAL_PROVIDER_KEYS.VLLM,
    label: LOCAL_RUNTIME_LABELS.vllm,
    runtime: "vllm",
    iconProvider: "vllm",
    description: "Self-hosted vLLM inference server",
  },
  {
    key: LOCAL_PROVIDER_KEYS.LLAMACPP,
    label: LOCAL_RUNTIME_LABELS.llamacpp,
    runtime: "llamacpp",
    iconProvider: "llamacpp",
    description: "Local llama.cpp GGUF server endpoint",
  },
  {
    key: LOCAL_PROVIDER_KEYS.CUSTOM,
    label: LOCAL_RUNTIME_LABELS.custom,
    labelKey: CUSTOM_PROVIDER_LABEL_KEY,
    runtime: "custom",
    iconProvider: "vllm",
    iconElement: "cog",
    description: "Custom OpenAI-compatible local endpoint",
  },
];

export function getLocalRuntimeForProviderKey(
  providerKey: string
): LocalRuntimePreset | undefined {
  return LOCAL_PROVIDER_DEFINITIONS.find(
    (provider) => provider.key === providerKey
  )?.runtime;
}

export function getLocalProviderKeyForRuntime(
  runtime: string | undefined
): string | undefined {
  return LOCAL_PROVIDER_DEFINITIONS.find(
    (provider) => provider.runtime === runtime
  )?.key;
}

const PRIMARY_PROVIDER_KEYS = new Set([
  // CLI agents
  "cursor_cli",
  "claude_code",
  "codex", // OpenAI brand variant
  "copilot",
  "kiro",
  "kimi_cli",
  "opencode",
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
  "longcat_api",
  "dashscope_api",
  "zhipu_api",
  "siliconflow_api",
  "modelscope_api",
  "aihubmix_api",
  "cherryin_api",
  "bedrock_api",
  "custom_api",
  "azure_openai_api",
  "azure_anthropic_api",
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
    loadAvailableAgents(),
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
  /** Provider group for sectioned picker rendering. */
  group: ProviderGroup;
  /** Brand display name (e.g., "OpenAI", "Anthropic") */
  label: string;
  /** Icon provider key for ModelIcon lookup */
  iconProvider: string;
  /** Optional non-ModelIcon glyph for virtual providers. */
  iconElement?: "cog";
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

/**
 * Display name for an API provider.
 *
 * Brand names come from the Rust registry untranslated; the brand-less Custom
 * tile is named in the user's language, exactly like its local counterpart.
 */
function apiProviderLabel(api: AvailableApiProvider, t: TFunction): string {
  if (api.name === CUSTOM_GATEWAY_PROVIDER_KEY) {
    return t(CUSTOM_PROVIDER_LABEL_KEY, LOCAL_RUNTIME_LABELS.custom);
  }
  return api.displayName;
}

function buildUnifiedProviders(
  agents: AvailableAgent[],
  apiProviders: AvailableApiProvider[],
  t: TFunction
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
          group: CLOUD_PROVIDER_GROUP,
          label: apiProviderLabel(api, t),
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
      group: CLOUD_PROVIDER_GROUP,
      label: apiProviderLabel(api, t),
      iconProvider: api.iconProvider,
      iconElement: api.name === CUSTOM_GATEWAY_PROVIDER_KEY ? "cog" : undefined,
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

  // Third pass: Add standalone CLI agents that have something to configure
  // (subscription plan OR an API key env var). Agents with neither have no
  // credentials to store in the key vault and should not appear here.
  for (const cli of agents) {
    if (usedAgents.has(cli.name)) continue;
    if (!cli.hasSubscriptionPlan && !cli.envConfig?.apiKeyEnvVar) continue;

    providers.push({
      key: cli.name,
      group: CLOUD_PROVIDER_GROUP,
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

  return expandLocalProviders(providers, t).sort(sortProvidersByGroup);
}

function expandLocalProviders(
  providers: UnifiedProvider[],
  t: TFunction
): UnifiedProvider[] {
  const localProvider = providers.find((provider) =>
    provider.variants.some(
      (variant) => variant.modelType === LOCAL_MODEL_PROVIDER
    )
  );
  const cloudProviders = providers.filter(
    (provider) =>
      !provider.variants.some(
        (variant) => variant.modelType === LOCAL_MODEL_PROVIDER
      )
  );

  if (!localProvider) return cloudProviders;

  const localVariant = localProvider.variants.find(
    (variant) => variant.modelType === LOCAL_MODEL_PROVIDER
  );
  if (!localVariant) return cloudProviders;

  const virtualLocalProviders = LOCAL_PROVIDER_DEFINITIONS.map((definition) => {
    const label = definition.labelKey
      ? t(definition.labelKey, definition.label)
      : definition.label;
    return {
      key: definition.key,
      group: LOCAL_PROVIDER_GROUP,
      label,
      iconProvider: definition.iconProvider,
      iconElement: definition.iconElement,
      brandColor: localProvider.brandColor,
      variants: [
        {
          ...localVariant,
          label,
        },
      ],
      popular: true,
      description: definition.description,
      docsUrl: localProvider.docsUrl,
    };
  });

  return [...cloudProviders, ...virtualLocalProviders];
}

/** The Custom tile is the escape hatch, so it trails the named cloud brands. */
function cloudProviderRank(provider: UnifiedProvider): number {
  return provider.key === CUSTOM_GATEWAY_PROVIDER_KEY ? 1 : 0;
}

function sortProvidersByGroup(
  providerA: UnifiedProvider,
  providerB: UnifiedProvider
): number {
  if (providerA.group !== providerB.group) {
    return providerA.group === CLOUD_PROVIDER_GROUP ? -1 : 1;
  }
  if (providerA.group === LOCAL_PROVIDER_GROUP) {
    const indexA = LOCAL_PROVIDER_DEFINITIONS.findIndex(
      (provider) => provider.key === providerA.key
    );
    const indexB = LOCAL_PROVIDER_DEFINITIONS.findIndex(
      (provider) => provider.key === providerB.key
    );
    return indexA - indexB;
  }
  const rankDelta = cloudProviderRank(providerA) - cloudProviderRank(providerB);
  if (rankDelta !== 0) return rankDelta;
  return providerA.label.localeCompare(providerB.label);
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
  const { t } = useTranslation("integrations");
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
    const all = buildUnifiedProviders(data.agents, data.apiProviders, t);
    return primaryOnly ? filterPrimaryProviders(all) : all;
  }, [data, primaryOnly, t]);

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

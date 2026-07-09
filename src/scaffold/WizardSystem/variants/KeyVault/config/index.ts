/**
 * KeyVaultWizard Configuration
 *
 * Provider data (CLI agents, API providers, env config) is loaded from Rust backend.
 * Use `useProviderRegistry` hook to get unified provider grid.
 * Use `useProviderConfig` hook to get env config for a specific provider.
 */
import type { ModelType } from "@src/api/types/keys";

import type { WizardData } from "../types";

// Re-export hooks for convenience
export {
  useProviderConfig,
  preloadProviderConfigs,
  type ProviderEnvConfig,
} from "../hooks/useProviderConfig";

export {
  useProviderRegistry,
  preloadProviderRegistry,
  isPrimaryProvider,
  getLocalRuntimeForProviderKey,
  getLocalProviderKeyForRuntime,
  type LocalRuntimePreset,
  type ProviderGroup,
  type UnifiedProvider,
  type UnifiedProviderVariant,
  type UseProviderRegistryOptions,
  type UseProviderRegistryResult,
} from "../hooks/useProviderRegistry";

export {
  GENERIC_SETUP_METHOD,
  GENERIC_SETUP_METHODS_DEFAULT,
  resolveActiveSetupMethod,
  resolveGenericSetupMethods,
  type GenericSetupMethod,
} from "./genericSetupMethods";

export {
  findEndpointByBaseUrl,
  getOfficialBaseUrl,
  hasEndpointChoice,
  resolveSelectedEndpoint,
} from "./providerEndpoints";

// ============================================
// Default Wizard Data
// ============================================

export const DEFAULT_WIZARD_DATA: WizardData = {
  name: "",
  description: "",
  agent_type: "" as ModelType,
  raw_key_input: "",
  env_vars: [],
  account_metadata: {},
  validated: false,
  available_models: [],
  model_context_lengths: {},
  enabled_models: [],
  custom_models: [],
  model_aliases: [],
  model_variants: [],
  default_variants: [],
};

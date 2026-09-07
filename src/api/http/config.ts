/**
 * Configuration API Types
 *
 * Types for provider/agent discovery. Actual data fetched via Tauri commands
 * (get_available_providers, get_available_agents) in useSessionDiscovery.
 *
 * Types are kept here because many components import them.
 */

// ============================================
// Type Definitions
// ============================================

/** Model information */
export interface ModelInfo {
  id: string;
  display_name: string;
  max_context_tokens: number;
}

/** Provider information with available models */
export interface ProviderInfo {
  provider_name: string;
  display_name: string;
  is_custom: boolean;
  has_api_key: boolean;
  models: ModelInfo[];
  default_model: string;
}

/** Agent information */
export interface AgentInfo {
  name: string;
  display_name: string;
  description: string;
  available: boolean;
  status: string;
  install_url?: string | null;
}

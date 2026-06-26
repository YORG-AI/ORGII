/**
 * KeyVaultWizard Types — BYOK only.
 *
 * Listing / pricing / pool / publish-flow types are not part of the OSS
 * KeyVault wizard.
 */
import type {
  ProviderProtocol,
  SaveKeyRequest,
} from "@src/api/tauri/rpc/schemas/validation";
import type { ModelType } from "@src/api/types/keys";

// ============================================
// Shared Types
// ============================================

/** A `name=value` environment variable row in the wizard UI. The on-disk
 *  shape (and `SaveKeyRequest`) uses `Record<string, string>` instead. */
export interface EnvVar {
  name: string;
  value: string;
}

/** A user-added model entry. `alias` is the model id used when calling the
 *  LLM; `displayName` is the optional label shown in agent selectors and
 *  other UI surfaces (falls back to `alias` when empty). */
export interface ModelAlias {
  /** Display label shown in UI; empty string means "use alias". */
  displayName: string;
  /** Model id used to call the LLM */
  alias: string;
  /** User-chosen icon provider key (e.g., "openai", "claude") */
  icon?: string;
}

export interface ModelVariant {
  model: string;
  baseModel: string;
  reasoning?: string;
  fast: boolean;
}

// ============================================
// Wizard State
// ============================================

export interface WizardData {
  name: string;
  description: string;
  agent_type: ModelType;

  // Credentials & validation
  raw_key_input: string;
  cursor_session_token?: string;
  oauth_session_token?: string;
  env_vars: EnvVar[];
  validated: boolean;
  /** Auto-detected models returned by the validator (e.g. /v1/models). */
  available_models: string[];
  /** Models the user has enabled (checked) from the detected list */
  enabled_models: string[];
  /** Models the user has explicitly added on top of auto-detection.
   *  Kept separate so the custom-model table only shows user-added rows.
   *  Merged into the wire `available_models` on submit. */
  custom_models: string[];
  /** Manual model alias mappings (for proxies that don't support model detection) */
  model_aliases: ModelAlias[];
  /** Optional parsed variant metadata for GPT/Claude model suffixes. */
  model_variants: ModelVariant[];
  /** Per-base-model preferred variant selections (e.g. claude-opus-4-6 →
   *  claude-opus-4-6-high). Empty until the user opens the variant picker
   *  in the wizard's model table. */
  default_variants: Array<{ base_model: string; model: string }>;
  /** Authentication method: "api_key" (default) or "oauth" */
  auth_method?: "api_key" | "oauth";
  protocol?: ProviderProtocol;
  // Extracted values from LLM extraction (Auto-Extract mode)
  extracted_api_key?: string;
  extracted_base_url?: string;
  quota_info?: {
    remaining_percentage?: number;
    is_unlimited?: boolean;
    limit?: number;
    used?: number;
    remaining?: number;
    reset_at?: string;
    reset_time?: string;
    billing_start?: string;
    plan_type?: string;
    limit_type?: string;
    quota_source?: string;
    // Plan breakdown (Cursor-specific)
    auto_percent_used?: number;
    api_percent_used?: number;
    total_percent_used?: number;
    // On-demand quota (Cursor-specific)
    on_demand_enabled?: boolean;
    on_demand_used?: number;
    on_demand_limit?: number;
    on_demand_remaining?: number;
    // Team on-demand (enterprise)
    team_on_demand_enabled?: boolean;
    team_on_demand_used?: number;
    // Provider messages
    auto_message?: string;
    named_message?: string;
  };

  /** Setup method chosen for complex CLI agents (e.g. "guided", "autodetect", "enter_token", "signin") */
  setup_method?: string;
}

// ============================================
// Component Props
// ============================================

export interface KeyVaultWizardProps {
  /** Submit handler — receives the BYOK save-key payload. */
  onSubmit: (data: SaveKeyRequest) => void;
  /** Cancel handler */
  onCancel: () => void;
  /** Loading state */
  loading?: boolean;
  /** Initial agent type (pre-selects the provider, used by setup walkthroughs) */
  initialAgentType?: ModelType;
  /** Custom title (default: "Add Agent" for CLI, "Add Account" for API keys) */
  title?: string;
  /** Initial data to pre-fill the wizard */
  initialData?: Partial<WizardData>;
  /** Limit displayed providers to primary ones with region restrictions (Cursor, OpenAI, Anthropic, Google, OpenRouter) */
  primaryProvidersOnly?: boolean;
  /** Existing account names — used to generate default names and reject duplicate custom names. */
  existingAccountNames?: string[];
}

export interface ApiSetupProps {
  data: WizardData;
  onChange: (updates: Partial<WizardData>) => void;
  onNext: () => void;
  /** Cancel/exit handler */
  onCancel: () => void;
  /** Primary button label (e.g. "Done") */
  submitLabel: string;
  /** Show loading spinner on the primary button */
  loading?: boolean;
  /** Limit displayed providers to primary ones with region restrictions */
  primaryProvidersOnly?: boolean;
  /** Existing account names — used to generate default names and reject duplicate custom names. */
  existingAccountNames?: string[];
  browserCloseSignal?: number;
  onBrowserStateChange?: (isOpen: boolean) => void;
}

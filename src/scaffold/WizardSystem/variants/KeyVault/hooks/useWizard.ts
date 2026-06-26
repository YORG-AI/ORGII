/**
 * useWizard Hook — KeyVault Wizard (BYOK)
 *
 * Manages wizard state and step navigation. Submits a `SaveKeyRequest`
 * derived from `WizardData`. The OAuth-token-from-env-var unwrapping
 * was preserved verbatim from the legacy listing wizard so existing
 * Codex / Kiro / Copilot sign-in flows keep working unchanged.
 */
import { useCallback } from "react";

import {
  CLI_AGENT,
  type SaveKeyRequest,
} from "@src/api/tauri/rpc/schemas/validation";
import type { ModelType } from "@src/api/types/keys";
import { isPlaceholderModelName } from "@src/components/ModelTable/unifiedCustomFlatExtras";
import { useUndoableState } from "@src/hooks/ui";
import { parseModelVariants } from "@src/util/modelVariants";

import { DEFAULT_WIZARD_DATA } from "../config";
import type { WizardData } from "../types";

// Per-agent env-var names that hold OAuth tokens after a successful sign-in.
// Adding a new OAuth-capable provider requires only a row here.
function cleanInput(value?: string): string | undefined {
  const cleaned = value?.trim();
  return cleaned ? cleaned : undefined;
}

const OAUTH_ENV_VARS_BY_AGENT: Record<
  string,
  { refresh?: string; idToken?: string; accessToken?: string }
> = {
  [CLI_AGENT.CODEX]: {
    refresh: "OPENAI_REFRESH_TOKEN",
    idToken: "OPENAI_ID_TOKEN",
  },
  [CLI_AGENT.KIRO]: {
    refresh: "KIRO_REFRESH_TOKEN",
    accessToken: "KIRO_ACCESS_TOKEN",
  },
  [CLI_AGENT.CLAUDE_CODE]: {
    refresh: "CLAUDE_CODE_REFRESH_TOKEN",
  },
  [CLI_AGENT.COPILOT]: {
    accessToken: "GITHUB_TOKEN",
  },
};

// ============================================
// Hook Options
// ============================================

export interface UseWizardOptions {
  onSubmit: (data: SaveKeyRequest) => void;
  /** Initial data to pre-populate */
  initialData?: Partial<WizardData>;
  existingAccountNames?: string[];
  getDefaultNameBase?: (modelType: ModelType) => string | undefined;
}

// ============================================
// Hook Return Type
// ============================================

export interface UseWizardReturn {
  /** Wizard data */
  data: WizardData;
  /** Update wizard data */
  updateData: (updates: Partial<WizardData>) => void;
  /** Submit wizard */
  submit: () => void;
  /** Reset wizard */
  reset: () => void;
}

// ============================================
// Hook Implementation
// ============================================

function nextDefaultName(baseName: string, existingNames: string[]): string {
  const normalizedExistingNames = new Set(
    existingNames.map((name) => name.trim().toLowerCase())
  );
  if (!normalizedExistingNames.has(baseName.toLowerCase())) return baseName;

  let suffix = 1;
  while (normalizedExistingNames.has(`${baseName}-${suffix}`.toLowerCase())) {
    suffix += 1;
  }
  return `${baseName}-${suffix}`;
}

export function useWizard(options: UseWizardOptions): UseWizardReturn {
  const {
    onSubmit,
    initialData,
    existingAccountNames = [],
    getDefaultNameBase,
  } = options;

  const {
    state: data,
    setState: setData,
    reset: resetData,
  } = useUndoableState<WizardData>(
    { ...DEFAULT_WIZARD_DATA, ...initialData },
    { keyboardShortcut: true }
  );

  const updateData = useCallback(
    (updates: Partial<WizardData>) => {
      setData((prev) => ({ ...prev, ...updates }));
    },
    [setData]
  );

  const submit = useCallback(() => {
    // Extract OAuth tokens from env_vars if present
    const getEnvVar = (name: string) =>
      data.env_vars?.find((envVar) => envVar.name === name)?.value;
    const oauthSpec = OAUTH_ENV_VARS_BY_AGENT[data.agent_type];
    const oauthRefreshToken = oauthSpec?.refresh
      ? getEnvVar(oauthSpec.refresh)
      : undefined;
    const oauthIdToken = oauthSpec?.idToken
      ? getEnvVar(oauthSpec.idToken)
      : undefined;
    const oauthAccessTokenFromEnv = oauthSpec?.accessToken
      ? getEnvVar(oauthSpec.accessToken)
      : undefined;

    // Determine if this is OAuth: either explicitly set OR has OAuth env vars
    const isOAuth =
      data.auth_method === "oauth" ||
      Boolean(oauthRefreshToken || oauthIdToken || oauthAccessTokenFromEnv);

    const isCursorCli = data.agent_type === CLI_AGENT.CURSOR;
    const rawApiKeyForRequest = cleanInput(
      data.extracted_api_key || data.raw_key_input
    );
    const apiKeyForRequest =
      (isCursorCli || !isOAuth) && rawApiKeyForRequest
        ? rawApiKeyForRequest
        : undefined;

    const sessionTokenForRequest = isOAuth
      ? cleanInput(
          oauthAccessTokenFromEnv ||
            data.oauth_session_token ||
            data.cursor_session_token
        )
      : cleanInput(data.cursor_session_token);

    if (isCursorCli && !sessionTokenForRequest?.trim()) {
      throw new Error("Cursor requires a session token before saving.");
    }

    if (data.agent_type === CLI_AGENT.CLAUDE_CODE && !isOAuth) {
      throw new Error("Claude Code requires OAuth sign-in before saving.");
    }

    if (
      data.agent_type === CLI_AGENT.CLAUDE_CODE &&
      !sessionTokenForRequest?.trim() &&
      !oauthRefreshToken?.trim()
    ) {
      throw new Error("Claude Code requires OAuth sign-in before saving.");
    }

    const envVarRecord = data.env_vars.reduce(
      (acc, ev) => {
        if (ev.name.trim() !== "") acc[ev.name] = ev.value;
        return acc;
      },
      {} as Record<string, string>
    );

    const resolvedName = data.name.trim()
      ? data.name.trim()
      : nextDefaultName(
          getDefaultNameBase?.(data.agent_type as ModelType) || data.agent_type,
          existingAccountNames
        );

    // Models the backend should use for this account. Auto-detected models:
    // enabled_models directly. Manual rows: derive from non-empty `alias`
    // (the actual proxy model id used to call the LLM).
    const allowedModels = (() => {
      const enabledModels = (data.enabled_models || []).filter(
        (model) => !isPlaceholderModelName(model)
      );
      if (enabledModels.length > 0) return enabledModels;
      return data.model_aliases
        .filter(
          (alias) =>
            alias.alias.trim() !== "" && !isPlaceholderModelName(alias.alias)
        )
        .map((alias) => alias.alias);
    })();

    // Wire `available_models` is the union of validator-detected models and
    // user-added custom rows. Wizard state keeps `available_models` vs
    // `custom_models` split; the unified `ModelTable` owns edits for custom rows.
    const allAvailableModels = (() => {
      const detected = data.available_models || [];
      const custom = (data.custom_models || []).filter(
        (model) => !isPlaceholderModelName(model)
      );
      const merged = detected.filter((model) => !isPlaceholderModelName(model));
      for (const model of custom) {
        if (!merged.includes(model)) merged.push(model);
      }
      if (merged.length > 0) return merged;
      return data.model_aliases
        .filter(
          (alias) =>
            alias.alias.trim() !== "" && !isPlaceholderModelName(alias.alias)
        )
        .map((alias) => alias.alias);
    })();

    const variantMetadata = parseModelVariants(allAvailableModels);

    const request: SaveKeyRequest = {
      name: resolvedName,
      description: data.description || undefined,
      agent_type: data.agent_type as ModelType,
      api_key: apiKeyForRequest,
      session_token: sessionTokenForRequest,
      base_url: cleanInput(data.extracted_base_url),
      protocol: data.protocol,
      env_vars: Object.keys(envVarRecord).length > 0 ? envVarRecord : undefined,
      available_models:
        allAvailableModels.length > 0 ? allAvailableModels : allowedModels,
      enabled_models: allowedModels,
      model_aliases:
        data.model_aliases.length > 0
          ? data.model_aliases
              .filter(
                (alias) =>
                  alias.alias.trim() !== "" &&
                  !isPlaceholderModelName(alias.alias)
              )
              .map((alias) => ({
                display_name: alias.displayName,
                alias: alias.alias,
                icon: alias.icon,
              }))
          : undefined,
      model_variants:
        variantMetadata.length > 0
          ? variantMetadata.map((variant) => ({
              model: variant.model,
              base_model: variant.baseModel,
              reasoning: variant.reasoning,
              fast: variant.fast,
            }))
          : undefined,
      default_variants:
        data.default_variants.length > 0 ? data.default_variants : undefined,
      quota_info: data.quota_info as SaveKeyRequest["quota_info"],
      auth_method: isOAuth ? "oauth" : data.auth_method || "api_key",
      has_local_key: true,
      is_listed: false,
    };

    onSubmit(request);
  }, [data, existingAccountNames, getDefaultNameBase, onSubmit]);

  const reset = useCallback(() => {
    resetData(DEFAULT_WIZARD_DATA);
  }, [resetData]);

  return {
    data,
    updateData,
    submit,
    reset,
  };
}

export default useWizard;

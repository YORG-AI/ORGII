import { type MutableRefObject, useEffect, useRef } from "react";

import { useKeyValidation } from "@src/hooks/keyVault/useKeyValidation";
import { getDefaultEnabledModels } from "@src/util/modelGrouping";

import type { WizardData } from "../types";
import { getEffectiveValidationModels } from "./apiSetupDerived";

interface UseApiSetupValidationOptions {
  data: WizardData;
  onChange: (updates: Partial<WizardData>) => void;
  isCursor: boolean;
  isCodex: boolean;
  isClaudeCode: boolean;
  inputMode: "direct" | "natural";
  resolvedCursorSessionToken: string | undefined;
  agentModelsRef: MutableRefObject<string[]>;
}

export function useApiSetupValidation({
  data,
  onChange,
  isCursor,
  isCodex,
  isClaudeCode,
  inputMode,
  resolvedCursorSessionToken,
  agentModelsRef,
}: UseApiSetupValidationOptions) {
  const latestData = useRef(data);
  useEffect(() => {
    latestData.current = data;
  }, [data]);
  const validation = useKeyValidation({
    agentType: data.agent_type,
    rawKeyInput: data.raw_key_input,
    cursorSessionToken: isCodex
      ? data.oauth_session_token ||
        (data.raw_key_input.trim().startsWith("eyJ")
          ? data.raw_key_input.trim()
          : undefined)
      : resolvedCursorSessionToken,
    baseUrl: data.extracted_base_url,
    protocol: data.protocol,
    inputMode: inputMode,
    onValidationSuccess: ({
      models,
      modelContextLengths,
      envVars,
      extractedConfig: config,
      oauthCatalog,
    }) => {
      const current = latestData.current;
      if (
        current.agent_type !== data.agent_type ||
        current.raw_key_input !== data.raw_key_input ||
        current.extracted_base_url !== data.extracted_base_url ||
        current.protocol !== data.protocol
      )
        return;
      const effectiveModels = getEffectiveValidationModels(
        models,
        data.agent_type,
        agentModelsRef.current
      );
      const catalogDefaults = oauthCatalog?.defaultEnabledModels.filter(
        (model) => effectiveModels.includes(model)
      );
      const oauthEnabledModels =
        catalogDefaults && catalogDefaults.length > 0
          ? catalogDefaults
          : effectiveModels.slice(0, 1);
      onChange({
        available_models: effectiveModels,
        model_context_lengths:
          oauthCatalog?.modelContextLengths ?? modelContextLengths,
        model_variants:
          oauthCatalog?.modelVariants.map((variant) => ({
            model: variant.model,
            baseModel: variant.base_model,
            reasoning: variant.reasoning ?? undefined,
            fast: variant.fast,
            contextWindow: variant.context_window ?? undefined,
          })) ?? data.model_variants,
        default_variants:
          oauthCatalog?.defaultVariants ?? data.default_variants,
        enabled_models:
          isClaudeCode || isCodex
            ? oauthEnabledModels
            : current.available_models.length > 0 ||
                current.custom_models.length > 0
              ? current.enabled_models
              : getDefaultEnabledModels(effectiveModels),
        model_aliases:
          data.auth_method !== "oauth" ? current.model_aliases : [],
        custom_models:
          data.auth_method !== "oauth" ? current.custom_models : [],
        env_vars: envVars,
        validated: true,
        quota_info: config?.quotaInfo as WizardData["quota_info"],
        extracted_api_key: config?.actualApiKey ?? data.extracted_api_key,
        extracted_base_url: config?.baseUrl ?? data.extracted_base_url,
      });
    },
  });

  useEffect(() => {
    if (
      !isCursor ||
      !validation.fetchedModels ||
      validation.fetchedModels.length === 0
    )
      return;
    if ((data.available_models?.length ?? 0) > 0) return;
    onChange({
      available_models: validation.fetchedModels,
      model_context_lengths: validation.fetchedModelContextLengths,
      enabled_models: getDefaultEnabledModels(validation.fetchedModels),
      validated: true,
    });
  }, [
    isCursor,
    validation.fetchedModels,
    validation.fetchedModelContextLengths,
    data.available_models?.length,
    onChange,
  ]);

  return validation;
}

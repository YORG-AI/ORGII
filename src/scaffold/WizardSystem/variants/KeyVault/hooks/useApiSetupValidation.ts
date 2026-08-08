import { type MutableRefObject, useEffect } from "react";

import { LOCAL_MODEL_PROVIDER } from "@src/api/types/keys";
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
      const effectiveModels = (() => {
        const validationModels = getEffectiveValidationModels(
          models,
          data.agent_type,
          agentModelsRef.current
        );
        if (data.agent_type !== LOCAL_MODEL_PROVIDER) return validationModels;
        const mergedModels = [...validationModels];
        for (const model of data.custom_models ?? []) {
          if (!mergedModels.includes(model)) mergedModels.push(model);
        }
        return mergedModels;
      })();
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
            : getDefaultEnabledModels(effectiveModels),
        model_aliases:
          data.agent_type === LOCAL_MODEL_PROVIDER ? data.model_aliases : [],
        custom_models:
          data.agent_type === LOCAL_MODEL_PROVIDER ? data.custom_models : [],
        env_vars: envVars,
        validated: true,
        quota_info: config?.quotaInfo as WizardData["quota_info"],
        extracted_api_key: config?.actualApiKey,
        extracted_base_url: config?.baseUrl,
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

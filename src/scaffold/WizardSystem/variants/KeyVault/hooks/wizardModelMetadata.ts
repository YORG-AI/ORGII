import type { SaveKeyRequest } from "@src/api/tauri/rpc/schemas/validation";
import { parseModelVariants } from "@src/util/modelVariants";

import type { WizardData } from "../types";

export function buildModelVariantsForSave(
  data: WizardData,
  allAvailableModels: string[]
): NonNullable<SaveKeyRequest["model_variants"]> {
  const modelVariantsById = new Map(
    data.model_variants
      .filter(
        (variant) =>
          allAvailableModels.includes(variant.baseModel) ||
          allAvailableModels.includes(variant.model)
      )
      .map((variant) => [
        variant.model,
        {
          model: variant.model,
          base_model: variant.baseModel,
          reasoning: variant.reasoning,
          fast: variant.fast,
          context_window:
            variant.contextWindow ??
            data.model_context_lengths?.[variant.model] ??
            data.model_context_lengths?.[variant.baseModel],
        },
      ])
  );

  for (const variant of parseModelVariants(allAvailableModels)) {
    if (modelVariantsById.has(variant.model)) continue;
    modelVariantsById.set(variant.model, {
      model: variant.model,
      base_model: variant.baseModel,
      reasoning: variant.reasoning,
      fast: variant.fast,
      context_window: data.model_context_lengths?.[variant.model],
    });
  }

  for (const model of allAvailableModels) {
    const contextWindow = data.model_context_lengths?.[model];
    if (!contextWindow || modelVariantsById.has(model)) continue;
    modelVariantsById.set(model, {
      model,
      base_model: model,
      reasoning: undefined,
      fast: false,
      context_window: contextWindow,
    });
  }

  return [...modelVariantsById.values()];
}

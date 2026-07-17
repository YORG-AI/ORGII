import type { KeyInfo } from "@src/api/types/keys";
import { isOrgiiTierModel } from "@src/config/orgiiCategories";

export interface ForkModelResolution {
  model: string | undefined;
  fellBack: boolean;
}

function keyIsUsable(key: KeyInfo): boolean {
  return (
    key.has_local_key &&
    key.enabled &&
    key.health_status !== "invalid" &&
    (key.has_api_key || key.has_session_token)
  );
}

export function isModelRunnableWithAccount(
  accountId: string,
  model: string,
  keys: readonly KeyInfo[]
): boolean {
  const key = keys.find((candidate) => candidate.id === accountId);
  if (!key || !keyIsUsable(key)) return false;
  const enabled = new Set(key.enabled_models ?? []);
  if (enabled.has(model)) return true;
  return (key.model_variants ?? []).some(
    (variant) => variant.model === model && enabled.has(variant.base_model)
  );
}

export function isModelRunnableLocally(
  model: string,
  keys: readonly KeyInfo[]
): boolean {
  if (isOrgiiTierModel(model)) return true;
  return keys.some((key) => {
    if (!keyIsUsable(key)) return false;
    const enabled = new Set(key.enabled_models ?? []);
    if (enabled.has(model)) return true;
    return (key.model_variants ?? []).some(
      (variant) => variant.model === model && enabled.has(variant.base_model)
    );
  });
}

export function resolveForkModel(
  inheritedModel: string | undefined,
  keys: readonly KeyInfo[] | null,
  defaultModel: string | undefined
): ForkModelResolution {
  if (!inheritedModel) return { model: undefined, fellBack: false };
  if (keys === null) return { model: defaultModel, fellBack: true };
  if (isModelRunnableLocally(inheritedModel, keys)) {
    return { model: inheritedModel, fellBack: false };
  }
  const fallback =
    defaultModel && isModelRunnableLocally(defaultModel, keys)
      ? defaultModel
      : undefined;
  return { model: fallback, fellBack: true };
}

/**
 * Model Info — Shared Types
 *
 * `PricingTier` and `ModelInfo` describe a single model's static metadata;
 * `ModelInfoEntry` is the pattern → info shape used by the per-provider
 * registries in the sibling `info.<provider>.ts` modules (e.g.
 * `info.anthropic.ts`, `info.openai.ts`).
 *
 * Extracted verbatim from `info.ts` during modularization; `PricingTier`
 * and `ModelInfo` are re-exported from `@src/types/model/info` so the
 * public import path is unchanged.
 */

export type PricingTier =
  | "free"
  | "budget"
  | "moderate"
  | "expensive"
  | "premium";

export interface ModelInfo {
  /** Provider company name (not translated — brand name) */
  provider: string;
  /** i18n key suffix for provider description */
  providerKey: string;
  /** Context window in thousands of tokens (e.g. 200 = 200K) */
  contextWindow: number;
  /** Max output tokens in thousands (optional) */
  maxOutput?: number;
  /** Whether the model supports vision/image input */
  vision: boolean;
  /** Whether the model supports extended thinking / chain-of-thought */
  reasoning?: boolean;
  /** i18n key suffixes for model strengths (under market.modelInfo.strengths.*) */
  strengthKeys: string[];
  /** Approximate pricing tier */
  pricingTier: PricingTier;
}

/** One `pattern` → `info` mapping in a provider's model registry. */
export interface ModelInfoEntry {
  pattern: string;
  info: ModelInfo;
}

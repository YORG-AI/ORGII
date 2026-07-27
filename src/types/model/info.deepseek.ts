/**
 * Model Info — DeepSeek
 *
 * Pattern-matched registry entries for the DeepSeek V3/V4/R1 family.
 *
 * Extracted verbatim from `info.ts` during modularization; consumed by
 * `getModelInfo` in `@src/types/model/info`. See that file for the
 * pattern-matching semantics (first substring hit wins).
 */
import type { ModelInfoEntry } from "@src/types/model/info.types";

export const DEEPSEEK_MODEL_INFO_ENTRIES: ModelInfoEntry[] = [
  // ─── DeepSeek ─────────────────────────────────────────────
  {
    pattern: "deepseek-v4",
    info: {
      provider: "DeepSeek",
      providerKey: "deepseek",
      contextWindow: 1000,
      maxOutput: 384,
      vision: false,
      reasoning: true,
      strengthKeys: ["longContext", "reasoning", "costEffective"],
      pricingTier: "budget",
    },
  },
  {
    pattern: "deepseek-r1",
    info: {
      provider: "DeepSeek",
      providerKey: "deepseek",
      contextWindow: 128,
      maxOutput: 64,
      vision: false,
      reasoning: true,
      strengthKeys: ["reasoning", "math", "costEffective"],
      pricingTier: "budget",
    },
  },
  {
    pattern: "deepseek-v3",
    info: {
      provider: "DeepSeek",
      providerKey: "deepseek",
      contextWindow: 128,
      maxOutput: 8,
      vision: false,
      strengthKeys: ["coding", "costEffective", "highVolume"],
      pricingTier: "budget",
    },
  },
  {
    pattern: "deepseek-chat",
    info: {
      provider: "DeepSeek",
      providerKey: "deepseek",
      contextWindow: 1000,
      maxOutput: 384,
      vision: false,
      strengthKeys: ["coding", "costEffective", "longContext"],
      pricingTier: "budget",
    },
  },
  {
    pattern: "deepseek-reasoner",
    info: {
      provider: "DeepSeek",
      providerKey: "deepseek",
      contextWindow: 1000,
      maxOutput: 384,
      vision: false,
      reasoning: true,
      strengthKeys: ["reasoning", "costEffective", "longContext"],
      pricingTier: "budget",
    },
  },
  // Generic DeepSeek fallback
  {
    pattern: "deepseek",
    info: {
      provider: "DeepSeek",
      providerKey: "deepseek",
      contextWindow: 128,
      vision: false,
      strengthKeys: ["costEffective", "coding"],
      pricingTier: "budget",
    },
  },
];

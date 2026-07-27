/**
 * Model Info — Meta (Llama)
 *
 * Pattern-matched registry entries for the Llama 3/4 family.
 *
 * Extracted verbatim from `info.ts` during modularization; consumed by
 * `getModelInfo` in `@src/types/model/info`. See that file for the
 * pattern-matching semantics (first substring hit wins).
 */
import type { ModelInfoEntry } from "@src/types/model/info.types";

export const META_MODEL_INFO_ENTRIES: ModelInfoEntry[] = [
  // ─── Meta (Llama) ─────────────────────────────────────────
  {
    pattern: "llama-4-scout",
    info: {
      provider: "Meta",
      providerKey: "meta",
      contextWindow: 10000,
      vision: true,
      strengthKeys: ["openWeight", "multimodal", "longContext"],
      pricingTier: "free",
    },
  },
  {
    pattern: "llama-4-maverick",
    info: {
      provider: "Meta",
      providerKey: "meta",
      contextWindow: 1000,
      vision: true,
      strengthKeys: ["openWeight", "multimodal", "longContext"],
      pricingTier: "free",
    },
  },
  {
    pattern: "llama-4",
    info: {
      provider: "Meta",
      providerKey: "meta",
      contextWindow: 1000,
      vision: true,
      strengthKeys: ["openWeight", "multimodal", "longContext"],
      pricingTier: "free",
    },
  },
  {
    pattern: "llama-3",
    info: {
      provider: "Meta",
      providerKey: "meta",
      contextWindow: 128,
      vision: false,
      strengthKeys: ["openWeight", "balanced", "costEffective"],
      pricingTier: "free",
    },
  },
  // Generic Llama fallback
  {
    pattern: "llama",
    info: {
      provider: "Meta",
      providerKey: "meta",
      contextWindow: 128,
      vision: false,
      strengthKeys: ["openWeight", "costEffective"],
      pricingTier: "free",
    },
  },
];

/**
 * Model Info — Mistral
 *
 * Pattern-matched registry entries for Mistral AI's Codestral and general models.
 *
 * Extracted verbatim from `info.ts` during modularization; consumed by
 * `getModelInfo` in `@src/types/model/info`. See that file for the
 * pattern-matching semantics (first substring hit wins).
 */
import type { ModelInfoEntry } from "@src/types/model/info.types";

export const MISTRAL_MODEL_INFO_ENTRIES: ModelInfoEntry[] = [
  // ─── Mistral ──────────────────────────────────────────────
  {
    pattern: "codestral",
    info: {
      provider: "Mistral AI",
      providerKey: "mistral",
      contextWindow: 256,
      vision: false,
      strengthKeys: ["coding", "longContext"],
      pricingTier: "budget",
    },
  },
  {
    pattern: "mistral",
    info: {
      provider: "Mistral AI",
      providerKey: "mistral",
      contextWindow: 128,
      vision: false,
      strengthKeys: ["coding", "costEffective", "speed"],
      pricingTier: "budget",
    },
  },
];

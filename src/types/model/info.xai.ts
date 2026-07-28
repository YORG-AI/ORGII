/**
 * Model Info — xAI (Grok)
 *
 * Pattern-matched registry entries for the Grok family.
 *
 * Extracted verbatim from `info.ts` during modularization; consumed by
 * `getModelInfo` in `@src/types/model/info`. See that file for the
 * pattern-matching semantics (first substring hit wins).
 */
import type { ModelInfoEntry } from "@src/types/model/info.types";

export const XAI_MODEL_INFO_ENTRIES: ModelInfoEntry[] = [
  // ─── xAI (Grok) ──────────────────────────────────────────
  {
    pattern: "grok-build",
    info: {
      provider: "xAI",
      providerKey: "xai",
      contextWindow: 256,
      vision: false,
      reasoning: true,
      strengthKeys: ["coding", "agentic", "speed"],
      pricingTier: "moderate",
    },
  },
  {
    pattern: "grok-4.3",
    info: {
      provider: "xAI",
      providerKey: "xai",
      contextWindow: 1000,
      vision: true,
      reasoning: true,
      strengthKeys: ["coding", "balanced", "reasoning"],
      pricingTier: "premium",
    },
  },
  {
    pattern: "grok-4",
    info: {
      provider: "xAI",
      providerKey: "xai",
      contextWindow: 256,
      vision: true,
      reasoning: true,
      strengthKeys: ["coding", "balanced", "reasoning"],
      pricingTier: "premium",
    },
  },
  {
    pattern: "grok",
    info: {
      provider: "xAI",
      providerKey: "xai",
      contextWindow: 128,
      vision: true,
      reasoning: true,
      strengthKeys: ["coding", "balanced"],
      pricingTier: "moderate",
    },
  },
];

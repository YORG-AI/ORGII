/**
 * Model Info — Z.AI (GLM)
 *
 * Pattern-matched registry entries for the GLM family.
 *
 * Extracted verbatim from `info.ts` during modularization; consumed by
 * `getModelInfo` in `@src/types/model/info`. See that file for the
 * pattern-matching semantics (first substring hit wins).
 */
import type { ModelInfoEntry } from "@src/types/model/info.types";

export const ZAI_MODEL_INFO_ENTRIES: ModelInfoEntry[] = [
  // ─── Z.AI (GLM) ───────────────────────────────────────────
  {
    pattern: "glm-5.2",
    info: {
      provider: "Z.AI",
      providerKey: "zai",
      contextWindow: 1000,
      vision: false,
      reasoning: true,
      strengthKeys: ["coding", "reasoning", "agentic"],
      pricingTier: "budget",
    },
  },
  {
    pattern: "glm-5",
    info: {
      provider: "Z.AI",
      providerKey: "zai",
      contextWindow: 200,
      vision: false,
      reasoning: true,
      strengthKeys: ["coding", "reasoning", "agentic"],
      pricingTier: "budget",
    },
  },
  {
    pattern: "glm-4.6",
    info: {
      provider: "Z.AI",
      providerKey: "zai",
      contextWindow: 200,
      vision: false,
      reasoning: true,
      strengthKeys: ["coding", "reasoning", "agentic"],
      pricingTier: "budget",
    },
  },
  {
    pattern: "glm-4.5",
    info: {
      provider: "Z.AI",
      providerKey: "zai",
      contextWindow: 128,
      vision: false,
      reasoning: true,
      strengthKeys: ["coding", "reasoning", "agentic"],
      pricingTier: "budget",
    },
  },
  {
    pattern: "glm",
    info: {
      provider: "Z.AI",
      providerKey: "zai",
      contextWindow: 128,
      vision: false,
      strengthKeys: ["coding", "costEffective"],
      pricingTier: "budget",
    },
  },
];

/**
 * Model Info — Qwen (Alibaba)
 *
 * Pattern-matched registry entries for the Qwen3 family.
 *
 * Extracted verbatim from `info.ts` during modularization; consumed by
 * `getModelInfo` in `@src/types/model/info`. See that file for the
 * pattern-matching semantics (first substring hit wins).
 */
import type { ModelInfoEntry } from "@src/types/model/info.types";

export const QWEN_MODEL_INFO_ENTRIES: ModelInfoEntry[] = [
  // ─── Qwen (Alibaba) ──────────────────────────────────────
  {
    pattern: "qwen3-coder",
    info: {
      provider: "Alibaba",
      providerKey: "alibaba",
      contextWindow: 256,
      vision: false,
      reasoning: true,
      strengthKeys: ["coding", "longContext", "agentic"],
      pricingTier: "budget",
    },
  },
  {
    pattern: "qwen3",
    info: {
      provider: "Alibaba",
      providerKey: "alibaba",
      contextWindow: 128,
      vision: true,
      reasoning: true,
      strengthKeys: ["multilingual", "reasoning", "costEffective"],
      pricingTier: "budget",
    },
  },
  {
    pattern: "qwen",
    info: {
      provider: "Alibaba",
      providerKey: "alibaba",
      contextWindow: 128,
      vision: true,
      strengthKeys: ["multilingual", "costEffective"],
      pricingTier: "budget",
    },
  },
];

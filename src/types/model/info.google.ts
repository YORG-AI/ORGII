/**
 * Model Info — Google (Gemini)
 *
 * Pattern-matched registry entries for the Gemini 2.x family.
 *
 * Extracted verbatim from `info.ts` during modularization; consumed by
 * `getModelInfo` in `@src/types/model/info`. See that file for the
 * pattern-matching semantics (first substring hit wins).
 */
import type { ModelInfoEntry } from "@src/types/model/info.types";

export const GOOGLE_MODEL_INFO_ENTRIES: ModelInfoEntry[] = [
  // ─── Google (Gemini) ──────────────────────────────────────
  {
    pattern: "gemini-2.5-pro",
    info: {
      provider: "Google",
      providerKey: "google",
      contextWindow: 1000,
      maxOutput: 64,
      vision: true,
      reasoning: true,
      strengthKeys: ["coding", "longContext", "multimodal"],
      pricingTier: "moderate",
    },
  },
  {
    pattern: "gemini-2.5-flash",
    info: {
      provider: "Google",
      providerKey: "google",
      contextWindow: 1000,
      maxOutput: 64,
      vision: true,
      reasoning: true,
      strengthKeys: ["speed", "costEffective", "multimodal"],
      pricingTier: "budget",
    },
  },
  {
    pattern: "gemini-2.0-flash",
    info: {
      provider: "Google",
      providerKey: "google",
      contextWindow: 1000,
      maxOutput: 8,
      vision: true,
      strengthKeys: ["speed", "costEffective", "multimodal"],
      pricingTier: "budget",
    },
  },
  // Generic Gemini fallback
  {
    pattern: "gemini",
    info: {
      provider: "Google",
      providerKey: "google",
      contextWindow: 1000,
      vision: true,
      strengthKeys: ["multimodal", "longContext"],
      pricingTier: "moderate",
    },
  },
];

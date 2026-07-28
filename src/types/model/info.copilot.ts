/**
 * Model Info — GitHub Copilot
 *
 * Pattern-matched registry entry for GitHub Copilot.
 *
 * Extracted verbatim from `info.ts` during modularization; consumed by
 * `getModelInfo` in `@src/types/model/info`. See that file for the
 * pattern-matching semantics (first substring hit wins).
 */
import type { ModelInfoEntry } from "@src/types/model/info.types";

export const COPILOT_MODEL_INFO_ENTRIES: ModelInfoEntry[] = [
  // ─── GitHub Copilot ───────────────────────────────────────
  {
    pattern: "copilot",
    info: {
      provider: "GitHub",
      providerKey: "github",
      contextWindow: 128,
      vision: false,
      strengthKeys: ["coding", "autocomplete"],
      pricingTier: "moderate",
    },
  },
];

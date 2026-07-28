/**
 * Model Info — Cursor
 *
 * Pattern-matched registry entries for Cursor's own composer/auto/small models.
 *
 * Extracted verbatim from `info.ts` during modularization; consumed by
 * `getModelInfo` in `@src/types/model/info`. See that file for the
 * pattern-matching semantics (first substring hit wins).
 */
import type { ModelInfoEntry } from "@src/types/model/info.types";

export const CURSOR_MODEL_INFO_ENTRIES: ModelInfoEntry[] = [
  // ─── Cursor ───────────────────────────────────────────────
  {
    pattern: "cursor-small",
    info: {
      provider: "Cursor",
      providerKey: "cursor",
      contextWindow: 128,
      vision: false,
      strengthKeys: ["speed", "costEffective", "autocomplete"],
      pricingTier: "free",
    },
  },
  {
    pattern: "composer",
    info: {
      provider: "Cursor",
      providerKey: "cursor",
      contextWindow: 128,
      vision: false,
      strengthKeys: ["coding", "agentic"],
      pricingTier: "moderate",
    },
  },
  {
    pattern: "auto",
    info: {
      provider: "Cursor",
      providerKey: "cursor",
      contextWindow: 128,
      vision: false,
      strengthKeys: ["autoSelect", "balanced"],
      pricingTier: "moderate",
    },
  },
];

/**
 * Model Info — Anthropic (Claude)
 *
 * Pattern-matched registry entries for the Claude Opus / Sonnet / Haiku families.
 *
 * Extracted verbatim from `info.ts` during modularization; consumed by
 * `getModelInfo` in `@src/types/model/info`. See that file for the
 * pattern-matching semantics (first substring hit wins).
 */
import type { ModelInfoEntry } from "@src/types/model/info.types";

export const ANTHROPIC_MODEL_INFO_ENTRIES: ModelInfoEntry[] = [
  // ─── Anthropic (Claude) ───────────────────────────────────
  // Known claude-opus-4.6/4.7/4.8 releases upgraded to 1M; 4 / 4.1 /
  // 4.5 stayed at 200K. Mirror the Rust FAMILY_RULES split.
  {
    pattern: "claude-opus-4.6",
    info: {
      provider: "Anthropic",
      providerKey: "anthropic",
      contextWindow: 1000,
      maxOutput: 32,
      vision: true,
      reasoning: true,
      strengthKeys: ["coding", "agentic", "reasoning", "planning"],
      pricingTier: "expensive",
    },
  },
  {
    pattern: "claude-opus-4.7",
    info: {
      provider: "Anthropic",
      providerKey: "anthropic",
      contextWindow: 1000,
      maxOutput: 32,
      vision: true,
      reasoning: true,
      strengthKeys: ["coding", "agentic", "reasoning", "planning"],
      pricingTier: "expensive",
    },
  },
  {
    pattern: "claude-opus-4.8",
    info: {
      provider: "Anthropic",
      providerKey: "anthropic",
      contextWindow: 1000,
      maxOutput: 32,
      vision: true,
      reasoning: true,
      strengthKeys: ["coding", "agentic", "reasoning", "planning"],
      pricingTier: "expensive",
    },
  },
  {
    pattern: "claude-opus-4",
    info: {
      provider: "Anthropic",
      providerKey: "anthropic",
      contextWindow: 200,
      maxOutput: 32,
      vision: true,
      reasoning: true,
      strengthKeys: ["coding", "agentic", "reasoning", "planning"],
      pricingTier: "expensive",
    },
  },
  {
    pattern: "claude-sonnet-4.5",
    info: {
      provider: "Anthropic",
      providerKey: "anthropic",
      contextWindow: 200,
      maxOutput: 16,
      vision: true,
      reasoning: true,
      strengthKeys: ["coding", "balanced", "agentic", "speed"],
      pricingTier: "moderate",
    },
  },
  {
    pattern: "claude-sonnet-4-5",
    info: {
      provider: "Anthropic",
      providerKey: "anthropic",
      contextWindow: 200,
      maxOutput: 16,
      vision: true,
      reasoning: true,
      strengthKeys: ["coding", "balanced", "agentic", "speed"],
      pricingTier: "moderate",
    },
  },
  {
    pattern: "claude-sonnet-4.6",
    info: {
      provider: "Anthropic",
      providerKey: "anthropic",
      contextWindow: 1000,
      maxOutput: 16,
      vision: true,
      reasoning: true,
      strengthKeys: ["coding", "balanced", "agentic", "speed"],
      pricingTier: "moderate",
    },
  },
  {
    pattern: "claude-sonnet-4-6",
    info: {
      provider: "Anthropic",
      providerKey: "anthropic",
      contextWindow: 1000,
      maxOutput: 16,
      vision: true,
      reasoning: true,
      strengthKeys: ["coding", "balanced", "agentic", "speed"],
      pricingTier: "moderate",
    },
  },
  {
    pattern: "claude-sonnet-4",
    info: {
      provider: "Anthropic",
      providerKey: "anthropic",
      contextWindow: 200,
      maxOutput: 16,
      vision: true,
      reasoning: true,
      strengthKeys: ["coding", "balanced", "agentic", "speed"],
      pricingTier: "moderate",
    },
  },
  {
    pattern: "claude-haiku-4-5",
    info: {
      provider: "Anthropic",
      providerKey: "anthropic",
      contextWindow: 200,
      maxOutput: 64,
      vision: true,
      reasoning: true,
      strengthKeys: ["speed", "costEffective", "highVolume"],
      pricingTier: "budget",
    },
  },
  {
    pattern: "claude-3.5-sonnet",
    info: {
      provider: "Anthropic",
      providerKey: "anthropic",
      contextWindow: 200,
      maxOutput: 8,
      vision: true,
      strengthKeys: ["coding", "balanced", "reliable"],
      pricingTier: "moderate",
    },
  },
  {
    pattern: "claude-3-5-sonnet",
    info: {
      provider: "Anthropic",
      providerKey: "anthropic",
      contextWindow: 200,
      maxOutput: 8,
      vision: true,
      strengthKeys: ["coding", "balanced", "reliable"],
      pricingTier: "moderate",
    },
  },
  {
    pattern: "claude-3.5-haiku",
    info: {
      provider: "Anthropic",
      providerKey: "anthropic",
      contextWindow: 200,
      maxOutput: 8,
      vision: true,
      strengthKeys: ["speed", "costEffective"],
      pricingTier: "budget",
    },
  },
  {
    pattern: "claude-3-5-haiku",
    info: {
      provider: "Anthropic",
      providerKey: "anthropic",
      contextWindow: 200,
      maxOutput: 8,
      vision: true,
      strengthKeys: ["speed", "costEffective"],
      pricingTier: "budget",
    },
  },
  // claude-fable-5 / claude-mythos: 1M context window (Anthropic).
  {
    pattern: "claude-fable",
    info: {
      provider: "Anthropic",
      providerKey: "anthropic",
      contextWindow: 1000,
      maxOutput: 32,
      vision: true,
      reasoning: true,
      strengthKeys: ["coding", "agentic", "reasoning", "planning"],
      pricingTier: "expensive",
    },
  },
  {
    pattern: "claude-mythos",
    info: {
      provider: "Anthropic",
      providerKey: "anthropic",
      contextWindow: 1000,
      maxOutput: 32,
      vision: true,
      reasoning: true,
      strengthKeys: ["coding", "agentic", "reasoning", "planning"],
      pricingTier: "expensive",
    },
  },
  // Generic Claude fallback — all current/new Anthropic models ship with a
  // 1M window, so the catch-all matches the backend FAMILY_RULES default.
  {
    pattern: "claude",
    info: {
      provider: "Anthropic",
      providerKey: "anthropic",
      contextWindow: 1000,
      vision: true,
      strengthKeys: ["coding", "reasoning"],
      pricingTier: "moderate",
    },
  },
];
